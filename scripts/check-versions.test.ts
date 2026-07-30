/**
 * The version lockstep, held at the desk instead of at the tag.
 *
 * Lockstep versioning: one version, one tag, one number. TRAY-DESIGN
 * section 5 already gave half of it a home: `app/src-tauri/build.rs` fails the
 * Rust build when `Cargo.toml` and the repo root `package.json` disagree, which
 * is the right place for that one because it fires on the machine that caused
 * it. What that cannot see is the rest of the family: the pointer in
 * `tauri.conf.json`, the copy `Cargo.lock` keeps, a `version` field growing back
 * in `app/package.json`, and the number the release road cares about most, the
 * tag itself.
 *
 * So this suite exists twice over: `scripts/check-versions.mjs` runs in both
 * workflows, and this file runs the identical function under `npm test`, because
 * drift that fails in CI has already cost a push and a wait.
 *
 * Every case below seeds the drift in a scratch tree under TEMP. The real tree
 * is asserted consistent at the bottom and is never written to.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkVersions, githubOutputLines } from './check-versions.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

const scratches: string[] = [];

afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

type Seed = {
  root?: string;
  app?: string | null;
  tauriConf?: string;
  cargo?: string;
  cargoLock?: string;
  crateName?: string;
};

/**
 * A plausible repo, five files deep, consistent unless a case says otherwise.
 *
 * The fixtures are not minimal on purpose. `Cargo.toml` carries a commented out
 * version and a `[dependencies.tauri]` section with a version of its own, and
 * `Cargo.lock` carries a decoy package, because a reader that finds the first
 * `version =` in the file passes a minimal fixture and ships drift.
 */
function seed(seedValues: Seed = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pigeon-lockstep-'));
  scratches.push(dir);

  const source = seedValues.root ?? '0.4.2';
  const crateName = seedValues.crateName ?? 'photo-pigeon-tray';

  mkdirSync(join(dir, 'app', 'src-tauri'), { recursive: true });

  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'photo-pigeon', version: source }, null, 2)}\n`,
  );

  const appPkg: Record<string, unknown> = { name: 'photo-pigeon-app', private: true };
  if (seedValues.app != null) appPkg.version = seedValues.app;
  writeFileSync(join(dir, 'app', 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);

  writeFileSync(
    join(dir, 'app', 'src-tauri', 'tauri.conf.json'),
    `${JSON.stringify(
      {
        productName: 'Photo Pigeon',
        version: seedValues.tauriConf ?? '../../package.json',
        identifier: 'io.github.justerlex.photopigeon',
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(dir, 'app', 'src-tauri', 'Cargo.toml'),
    [
      '# Conf notes live here on purpose.',
      '# An old note that once said version = "9.9.9". It is a comment and must stay one.',
      '',
      '[package]',
      `name = "${crateName}"`,
      'edition = "2021"',
      `version = "${seedValues.cargo ?? source}"`,
      '',
      '[dependencies.tauri]',
      'version = "2.9.0"',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'app', 'src-tauri', 'Cargo.lock'),
    [
      'version = 4',
      '',
      '[[package]]',
      'name = "a-decoy-dependency"',
      'version = "9.9.9"',
      '',
      '[[package]]',
      `name = "${crateName}"`,
      `version = "${seedValues.cargoLock ?? source}"`,
      'dependencies = [',
      ' "tauri",',
      ']',
      '',
    ].join('\n'),
  );

  return dir;
}

describe('a consistent tree', () => {
  it('passes, and names every place it looked', () => {
    const report = checkVersions({ repoRoot: seed() });

    expect(report.problems).toEqual([]);
    expect(report.source).toBe('0.4.2');
    expect(report.places.map((place) => place.file)).toEqual([
      'package.json',
      'app/package.json',
      'app/src-tauri/tauri.conf.json',
      'app/src-tauri/Cargo.toml',
      'app/src-tauri/Cargo.lock',
    ]);
  });

  it('reads the version out of the [package] section and not out of a comment or a dependency', () => {
    const report = checkVersions({ repoRoot: seed() });
    const cargo = report.places.find((place) => place.file === 'app/src-tauri/Cargo.toml');

    expect(cargo?.found).toBe('0.4.2');
  });

  it('treats a missing version in app/package.json as the decided state, not as drift', () => {
    const report = checkVersions({ repoRoot: seed({ app: null }) });
    const appPkg = report.places.find((place) => place.file === 'app/package.json');

    expect(report.problems).toEqual([]);
    expect(appPkg?.found).toBeUndefined();
    expect(appPkg?.note).toMatch(/no version/i);
  });
});

describe('seeded drift', () => {
  it('catches Cargo.toml, which is the one M5 was told to join up', () => {
    const report = checkVersions({ repoRoot: seed({ cargo: '0.4.1' }) });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('app/src-tauri/Cargo.toml');
    expect(report.problems[0]).toContain('0.4.1');
    expect(report.problems[0]).toContain('0.4.2');
  });

  it('catches Cargo.lock, which is the copy nothing was watching', () => {
    // A lock left behind by a version bump is not cosmetic: a build with
    // --locked refuses it, so the first tag would fail at the Rust step for a
    // reason nobody would look for in a release script.
    const report = checkVersions({ repoRoot: seed({ cargoLock: '0.4.1' }) });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('Cargo.lock');
  });

  it('catches a version field growing back in app/package.json', () => {
    const report = checkVersions({ repoRoot: seed({ app: '9.9.9' }) });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('app/package.json');
    expect(report.problems[0]).toContain('9.9.9');
  });

  it('catches a literal version in tauri.conf.json that disagrees', () => {
    const report = checkVersions({ repoRoot: seed({ tauriConf: '0.4.1' }) });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('tauri.conf.json');
    expect(report.problems[0]).toContain('0.4.1');
  });

  it('accepts a literal version in tauri.conf.json that agrees, and says it is a literal', () => {
    // Not drift, but worth naming: the decided form is the pointer, and a
    // literal that happens to match today is a number able to lie tomorrow.
    const report = checkVersions({ repoRoot: seed({ tauriConf: '0.4.2' }) });
    const conf = report.places.find((place) => place.file === 'app/src-tauri/tauri.conf.json');

    expect(report.problems).toEqual([]);
    expect(conf?.note).toMatch(/literal/i);
  });

  it('catches a pointer aimed at the wrong manifest', () => {
    // "../package.json" is app/package.json, which has no version at all. The
    // typo is one character and it silently moves the source of truth.
    const report = checkVersions({ repoRoot: seed({ tauriConf: '../package.json' }) });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('tauri.conf.json');
    expect(report.problems[0]).toContain('../package.json');
  });

  it('catches a crate renamed out from under Cargo.lock', () => {
    // paths.rs and the bundle name are frozen, but the crate name is not one of
    // the frozen four, so it can move. If it does, the lock lookup has to fail
    // loudly rather than quietly find nothing and pass.
    const dir = seed();
    const cargo = join(dir, 'app', 'src-tauri', 'Cargo.toml');
    writeFileSync(
      cargo,
      readFileSync(cargo, 'utf8').replace('name = "photo-pigeon-tray"', 'name = "pigeon-shell"'),
    );

    const report = checkVersions({ repoRoot: dir });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('Cargo.lock');
    expect(report.problems[0]).toContain('pigeon-shell');
  });

  it('reports every disagreement in one run rather than stopping at the first', () => {
    const report = checkVersions({ repoRoot: seed({ cargo: '0.4.1', cargoLock: '0.4.0' }) });

    expect(report.problems).toHaveLength(2);
  });
});

describe('a missing or unusable source of truth', () => {
  it('fails when the root package.json has no version', () => {
    const dir = seed();
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'photo-pigeon' })}\n`);

    const report = checkVersions({ repoRoot: dir });

    expect(report.source).toBeUndefined();
    expect(report.problems.join('\n')).toContain('package.json');
  });

  it('fails when a file it must read is not there', () => {
    const dir = seed();
    rmSync(join(dir, 'app', 'src-tauri', 'Cargo.toml'));

    const report = checkVersions({ repoRoot: dir });

    expect(report.problems.join('\n')).toContain('Cargo.toml');
  });

  it('fails when a file it must read is not valid', () => {
    const dir = seed();
    writeFileSync(join(dir, 'app', 'src-tauri', 'tauri.conf.json'), '{ not json');

    const report = checkVersions({ repoRoot: dir });

    expect(report.problems.join('\n')).toContain('tauri.conf.json');
  });
});

describe('the tag, which is what M5 added to the family', () => {
  it('passes when the tag is v plus the version', () => {
    const report = checkVersions({ repoRoot: seed(), tag: 'v0.4.2' });

    expect(report.problems).toEqual([]);
    expect(report.places.at(-1)?.file).toBe('the tag');
  });

  it('takes refs/tags/v0.4.2, because that is what GITHUB_REF hands over', () => {
    const report = checkVersions({ repoRoot: seed(), tag: 'refs/tags/v0.4.2' });

    expect(report.problems).toEqual([]);
  });

  it('fails a tag that disagrees, which is three quarters of a release lying', () => {
    const report = checkVersions({ repoRoot: seed(), tag: 'v0.4.1' });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('v0.4.1');
    expect(report.problems[0]).toContain('v0.4.2');
  });

  it('fails a tag with no v, rather than being generous about it', () => {
    // The endpoint, the release URL in latest.json and the git history all
    // spell it one way. Being lenient here means being wrong in latest.json.
    const report = checkVersions({ repoRoot: seed(), tag: '0.4.2' });

    expect(report.problems).toHaveLength(1);
  });

  it('fails an empty tag, because on the release road that means the ref went missing', () => {
    const report = checkVersions({ repoRoot: seed(), tag: '' });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/empty/i);
  });

  it('does not look at the tag at all when none is given, so ci.yml can use the same script', () => {
    const report = checkVersions({ repoRoot: seed() });

    expect(report.places.map((place) => place.file)).not.toContain('the tag');
  });
});

describe('what the workflows read back out of it', () => {
  it('hands the version and the tag to GITHUB_OUTPUT, so nothing downstream re-reads the manifest', () => {
    expect(githubOutputLines('0.4.2')).toEqual(['version=0.4.2', 'tag=v0.4.2']);
  });
});

describe('this repository, right now', () => {
  it('is consistent', () => {
    const report = checkVersions({ repoRoot: REPO_ROOT });

    expect(report.problems).toEqual([]);
  });

  it('agrees with the version the root manifest actually carries', () => {
    const onDisk = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
    const report = checkVersions({ repoRoot: REPO_ROOT, tag: `v${onDisk}` });

    expect(report.source).toBe(onDisk);
    expect(report.problems).toEqual([]);
    expect(report.places).toHaveLength(6);
  });
});
