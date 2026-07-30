/**
 * The updater manifest, and the one thing about it that only breaks in public.
 *
 * `latest.json` is what an installed copy reads to learn there is a newer one.
 * TRAY-DESIGN section 5 pins the endpoint at
 * https://github.com/justerlex/photo-pigeon/releases/latest/download/latest.json,
 * which means the URL inside the manifest has to be the URL GitHub actually
 * serves the installer from, and GitHub does not serve it under the name the
 * bundler wrote.
 *
 * `productName` is "Photo Pigeon", with a space, so `tauri build` emits
 * `Photo Pigeon_0.1.0_x64-setup.exe` (verified on disk, 30 July 2026). GitHub
 * replaces whitespace with dots when it takes a release asset, so the file a user
 * downloads is `Photo.Pigeon_0.1.0_x64-setup.exe`. A manifest that names the
 * bundler's spelling points at a 404, every installed copy fails its update
 * check quietly, and nothing in the build goes red. That is the case this file
 * exists for.
 *
 * The rest is the release script refusing to guess: exactly one installer, its
 * signature beside it, and a filename that carries the version being tagged.
 * TRAY-DESIGN's row 13 is the reason for the first of those, in its own words:
 * two near-identical installers side by side is how the wrong file ships.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  UPDATER_TARGET,
  assetNameFor,
  buildLatestJson,
  findArtifacts,
  stageRelease,
} from './make-latest-json.mjs';

const scratches: string[] = [];

afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** The name this project's own bundler really produces. */
const INSTALLER = 'Photo Pigeon_0.1.0_x64-setup.exe';
/** What GitHub serves it as. */
const ASSET = 'Photo.Pigeon_0.1.0_x64-setup.exe';
const SIGNATURE = 'dW50cnVzdGVkIGNvbW1lbnQ6IGEgdGhyb3dhd2F5LCBub3QgdGhlIHJlYWwga2V5';

function bundleDir(files: Record<string, string> = { [INSTALLER]: 'MZ', [`${INSTALLER}.sig`]: `${SIGNATURE}\n` }): string {
  const dir = mkdtempSync(join(tmpdir(), 'pigeon-bundle-'));
  scratches.push(dir);
  mkdirSync(join(dir, 'nsis'), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, 'nsis', name), contents);
  }
  return join(dir, 'nsis');
}

describe('the name GitHub serves an asset under', () => {
  it('turns the space in Photo Pigeon into a dot, which the download URL depends on', () => {
    expect(assetNameFor(INSTALLER)).toBe(ASSET);
  });

  it('leaves a name with no whitespace alone', () => {
    expect(assetNameFor('latest.json')).toBe('latest.json');
    expect(assetNameFor('photo-pigeon_0.1.0_x64-setup.exe')).toBe('photo-pigeon_0.1.0_x64-setup.exe');
  });

  it('collapses a run of whitespace rather than emitting a run of dots', () => {
    expect(assetNameFor('Photo  Pigeon\tsetup.exe')).toBe('Photo.Pigeon.setup.exe');
  });
});

describe('finding what the bundler left behind', () => {
  it('takes the installer and the signature beside it', () => {
    const dir = bundleDir();
    const found = findArtifacts(dir, '0.1.0');

    expect(found.installerName).toBe(INSTALLER);
    expect(found.signature).toBe(SIGNATURE);
  });

  it('refuses two installers, which is how the wrong file gets attached to a release', () => {
    // Row 13 of the M5 plan, made mechanical. A hosted runner starts empty, so
    // this fires for a local release build off a dirty target directory, which
    // is exactly where the two were found on 29 July 2026.
    const dir = bundleDir({
      [INSTALLER]: 'MZ',
      [`${INSTALLER}.sig`]: SIGNATURE,
      'photo-pigeon_0.1.0_x64-setup.exe': 'MZ',
      'photo-pigeon_0.1.0_x64-setup.exe.sig': SIGNATURE,
    });

    expect(() => findArtifacts(dir, '0.1.0')).toThrow(/Photo Pigeon_0\.1\.0_x64-setup\.exe/);
    expect(() => findArtifacts(dir, '0.1.0')).toThrow(/photo-pigeon_0\.1\.0_x64-setup\.exe/);
  });

  it('refuses an empty bundle directory and says where it looked', () => {
    const dir = bundleDir({});

    expect(() => findArtifacts(dir, '0.1.0')).toThrow(/nsis/);
  });

  it('refuses an installer with no signature, and names the config flag that produces one', () => {
    // The failure mode this catches is a release that ships a perfectly good
    // installer and an updater manifest nobody can verify, so every installed
    // copy refuses the update it just downloaded.
    const dir = bundleDir({ [INSTALLER]: 'MZ' });

    expect(() => findArtifacts(dir, '0.1.0')).toThrow(/createUpdaterArtifacts/);
    expect(() => findArtifacts(dir, '0.1.0')).toThrow(/TAURI_SIGNING_PRIVATE_KEY/);
  });

  it('refuses an empty signature file', () => {
    const dir = bundleDir({ [INSTALLER]: 'MZ', [`${INSTALLER}.sig`]: '   \n' });

    expect(() => findArtifacts(dir, '0.1.0')).toThrow(/empty/i);
  });

  it('refuses an installer whose name is not the version being released', () => {
    // The lockstep check covers the manifests and the tag. This covers the
    // artefact: a stale build of 0.1.0 sitting in the directory during a 0.1.1
    // release would otherwise be uploaded under the new tag.
    const dir = bundleDir();

    expect(() => findArtifacts(dir, '0.1.1')).toThrow(/0\.1\.1/);
  });
});

describe('the manifest itself', () => {
  const manifest = () =>
    buildLatestJson({
      version: '0.1.0',
      tag: 'v0.1.0',
      repo: 'justerlex/photo-pigeon',
      installerName: INSTALLER,
      signature: SIGNATURE,
      pubDate: '2026-08-10T09:00:00.000Z',
    });

  it('carries the four things the plugin reads and nothing it does not', () => {
    expect(manifest()).toEqual({
      version: '0.1.0',
      pub_date: '2026-08-10T09:00:00.000Z',
      platforms: {
        'windows-x86_64': {
          signature: SIGNATURE,
          url: `https://github.com/justerlex/photo-pigeon/releases/download/v0.1.0/${ASSET}`,
        },
      },
    });
  });

  it('names the one target this product has, and names it the way the plugin does', () => {
    expect(UPDATER_TARGET).toBe('windows-x86_64');
    expect(Object.keys(manifest().platforms)).toEqual([UPDATER_TARGET]);
  });

  it('builds a URL with no whitespace in it', () => {
    expect(manifest().platforms[UPDATER_TARGET].url).not.toMatch(/\s/);
  });

  it('stamps pub_date as an instant, in UTC, when it is not given one', () => {
    const stamped = buildLatestJson({
      version: '0.1.0',
      tag: 'v0.1.0',
      repo: 'justerlex/photo-pigeon',
      installerName: INSTALLER,
      signature: SIGNATURE,
    });

    expect(stamped.pub_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(stamped.pub_date))).toBe(false);
  });

  it('refuses a tag that is not v plus the version, rather than writing a URL to nowhere', () => {
    expect(() =>
      buildLatestJson({
        version: '0.1.0',
        tag: 'v0.1.1',
        repo: 'justerlex/photo-pigeon',
        installerName: INSTALLER,
        signature: SIGNATURE,
      }),
    ).toThrow(/v0\.1\.0/);
  });

  it('refuses a repo that is not owner/name, because the URL is the whole point', () => {
    expect(() =>
      buildLatestJson({
        version: '0.1.0',
        tag: 'v0.1.0',
        repo: 'photo-pigeon',
        installerName: INSTALLER,
        signature: SIGNATURE,
      }),
    ).toThrow(/owner\/name/);
  });
});

describe('staging what the release carries', () => {
  it('leaves exactly the installer, its signature and the manifest, under their real names', () => {
    const bundle = bundleDir();
    const out = mkdtempSync(join(tmpdir(), 'pigeon-staged-'));
    scratches.push(out);

    const staged = stageRelease({
      bundleDir: bundle,
      version: '0.1.0',
      tag: 'v0.1.0',
      repo: 'justerlex/photo-pigeon',
      out,
      pubDate: '2026-08-10T09:00:00.000Z',
    });

    expect(readdirSync(out).sort()).toEqual([INSTALLER, `${INSTALLER}.sig`, 'latest.json']);
    expect(staged.assets).toHaveLength(3);

    const written = readFileSync(join(out, 'latest.json'), 'utf8');
    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written).platforms[UPDATER_TARGET].url).toContain(ASSET);
  });

  it('empties the staging directory first, so a second run cannot upload a first run', () => {
    const out = mkdtempSync(join(tmpdir(), 'pigeon-staged-'));
    scratches.push(out);
    writeFileSync(join(out, 'Photo Pigeon_0.0.9_x64-setup.exe'), 'MZ');

    stageRelease({
      bundleDir: bundleDir(),
      version: '0.1.0',
      tag: 'v0.1.0',
      repo: 'justerlex/photo-pigeon',
      out,
    });

    expect(readdirSync(out).sort()).toEqual([INSTALLER, `${INSTALLER}.sig`, 'latest.json']);
  });
});
