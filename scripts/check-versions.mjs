#!/usr/bin/env node
/**
 * The version lockstep, in one place, for every road that needs it.
 *
 * Lockstep versioning: one version, one tag, one number, written by hand in
 * the repo root `package.json` and nowhere else. TRAY-DESIGN section 5.
 *
 * Half of it already had a home before M5 and keeps it: `app/src-tauri/build.rs`
 * fails the Rust build when `Cargo.toml` disagrees with the root manifest, which
 * is the better place for that one comparison because it fires on the machine
 * that caused the drift rather than on a runner afterwards. This script does not
 * replace it. It covers the rest of the family, which nothing was watching:
 *
 *   package.json                    the source of truth. Everything else is compared to it.
 *   app/package.json                must NOT carry a version. It did at M0, it said 9.9.9,
 *                                   and the bundler correctly ignored it, which is exactly
 *                                   how a number able to lie behaves. M2 deleted the field.
 *   app/src-tauri/tauri.conf.json   carries the POINTER "../../package.json", Tauri's own
 *                                   supported form. One wrong character makes it
 *                                   "../package.json", which is app/package.json, which has
 *                                   no version at all, and the installer's name silently
 *                                   changes source of truth.
 *   app/src-tauri/Cargo.toml        checked here too, so a contributor with no Rust
 *                                   toolchain still gets the message.
 *   app/src-tauri/Cargo.lock        keeps its own copy of the crate version. Nothing was
 *                                   watching it, and a build with --locked refuses a stale
 *                                   one, which on a tag reads as a mysterious Rust failure.
 *   the tag                         what M5 adds. A v0.1.0 tag against a 0.1.1 manifest is a
 *                                   release whose installer, npm package and Release page
 *                                   all disagree with the git history. Checked only when a
 *                                   tag is passed, so ci.yml and release.yml run the same
 *                                   script with the same meaning.
 *
 * Plain Node, no dependencies, so it runs before `npm ci` and from a git hook.
 * `scripts/check-versions.test.ts` runs the identical function under `npm test`,
 * because drift that fails in CI has already cost a push and a wait.
 *
 * Usage:
 *   node scripts/check-versions.mjs [options]
 *
 *   --tag <tag>          also compare a tag. Takes v0.1.0 or refs/tags/v0.1.0.
 *                        An empty value is a failure and not a skip: on the release
 *                        road it means the ref went missing.
 *   --root <dir>         repo root, default the parent of this script
 *   --github-output      append version= and tag= to $GITHUB_OUTPUT, so the workflow
 *                        never re-reads the manifest with a second parser
 *   --json               print the report as JSON instead of a table
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_FILE = 'package.json';

/**
 * @typedef {{ file: string, found?: string, note?: string }} Place
 * @typedef {{ source?: string, places: Place[], problems: string[] }} Report
 */

/**
 * Reads every place a version lives and reports the disagreements.
 *
 * Collects all of them rather than stopping at the first: a version bump that
 * missed two files should cost one run, not two.
 *
 * @param {{ repoRoot?: string, tag?: string }} options
 * @returns {Report}
 */
export function checkVersions({ repoRoot = defaultRoot(), tag } = {}) {
  /** @type {Place[]} */
  const places = [];
  /** @type {string[]} */
  const problems = [];

  const rootManifest = readJsonAt(repoRoot, SOURCE_FILE, problems);
  const source = typeof rootManifest?.version === 'string' ? rootManifest.version : undefined;

  if (source === undefined) {
    if (rootManifest !== undefined) {
      problems.push(
        `${SOURCE_FILE} has no string "version" field, and it is the source of truth for ` +
          'this whole product: the npm package, the installer name, the NSIS product ' +
          "version and the updater's comparison all read it.",
      );
    }
    return { source: undefined, places, problems };
  }

  places.push({ file: SOURCE_FILE, found: source, note: 'the source of truth' });

  checkAppManifest(repoRoot, source, places, problems);
  checkTauriConf(repoRoot, source, places, problems);
  const crateName = checkCargoToml(repoRoot, source, places, problems);
  checkCargoLock(repoRoot, source, crateName, places, problems);
  if (tag !== undefined) checkTag(tag, source, places, problems);

  return { source, places, problems };
}

/**
 * `app/package.json` is private, is never published, and deliberately has no
 * version field. Absent is the right answer, so absent is not reported as drift.
 */
function checkAppManifest(repoRoot, source, places, problems) {
  const file = 'app/package.json';
  const manifest = readJsonAt(repoRoot, file, problems);
  if (manifest === undefined) return;

  const found = typeof manifest.version === 'string' ? manifest.version : undefined;

  if (found === undefined) {
    places.push({ file, note: 'no version field, which is the decided state since M2' });
    return;
  }

  places.push({ file, found, note: 'a version field grew back here' });

  if (found !== source) {
    problems.push(
      `${file} carries version ${found}, but ${SOURCE_FILE} says ${source}. That field was ` +
        'deleted at M2 on purpose: it is private, it is never published, and the one time it ' +
        'held a number the number was wrong. Delete it rather than correcting it.',
    );
    return;
  }

  problems.push(
    `${file} has a version field again. It agrees with ${SOURCE_FILE} today, which is ` +
      'exactly how it looked at M0 before it started lying. Delete the field.',
  );
}

/**
 * The pointer form is the decided one. A literal that agrees is not drift today,
 * so it is reported rather than failed, but it is named out loud because it is a
 * fourth number able to lie tomorrow.
 */
function checkTauriConf(repoRoot, source, places, problems) {
  const file = 'app/src-tauri/tauri.conf.json';
  const conf = readJsonAt(repoRoot, file, problems);
  if (conf === undefined) return;

  const value = conf.version;

  if (typeof value !== 'string') {
    places.push({ file });
    problems.push(
      `${file} has no string "version". It should point at the root manifest with ` +
        `"version": "../../${SOURCE_FILE}".`,
    );
    return;
  }

  if (/^\d+\.\d+\.\d+/.test(value)) {
    places.push({ file, found: value, note: 'a literal, where the decided form is the pointer' });
    if (value !== source) {
      problems.push(
        `${file} says ${value}, but ${SOURCE_FILE} says ${source}. The decided form is the ` +
          `pointer "version": "../../${SOURCE_FILE}", which cannot disagree with anything.`,
      );
    }
    return;
  }

  // Anything that is not a version is a path, and Tauri resolves it relative to
  // the directory holding tauri.conf.json.
  const aimedAt = path.resolve(repoRoot, 'app', 'src-tauri', value);
  const shouldBe = path.resolve(repoRoot, SOURCE_FILE);

  if (aimedAt !== shouldBe) {
    places.push({ file, note: `points at ${value}` });
    problems.push(
      `${file} points its version at ${value}, which resolves to ${aimedAt}. The source of ` +
        `truth is ${shouldBe}. One wrong character here moves the version the installer, the ` +
        'NSIS product version and the updater all read.',
    );
    return;
  }

  places.push({ file, found: source, note: `reads ${value}` });
}

/**
 * Returns the crate name, because `Cargo.lock` is looked up by it and a rename
 * would otherwise turn into a silent pass.
 */
function checkCargoToml(repoRoot, source, places, problems) {
  const file = 'app/src-tauri/Cargo.toml';
  const text = readTextAt(repoRoot, file, problems);
  if (text === undefined) return undefined;

  const pkg = tomlPackageSection(text);
  places.push({ file, found: pkg.version });

  if (pkg.version === undefined) {
    problems.push(`${file} has no version in its [package] section.`);
  } else if (pkg.version !== source) {
    problems.push(
      `${file} says ${pkg.version}, but ${SOURCE_FILE} says ${source}. Fix Cargo.toml, not ` +
        `${SOURCE_FILE}, unless you also meant to change what npm publishes. ` +
        'app/src-tauri/build.rs fails the Rust build on this same mismatch.',
    );
  }

  return pkg.name;
}

function checkCargoLock(repoRoot, source, crateName, places, problems) {
  const file = 'app/src-tauri/Cargo.lock';
  const text = readTextAt(repoRoot, file, problems);
  if (text === undefined || crateName === undefined) return;

  const found = lockedVersionOf(text, crateName);

  if (found === undefined) {
    places.push({ file, note: `no entry for ${crateName}` });
    problems.push(
      `${file} has no [[package]] entry named ${crateName}, which is the crate name in ` +
        'Cargo.toml. Either the crate was renamed and the lock was not regenerated, or the ' +
        'lock is stale. Run cargo check in app/src-tauri and commit the result.',
    );
    return;
  }

  places.push({ file, found, note: `the [[package]] entry for ${crateName}` });

  if (found !== source) {
    problems.push(
      `${file} says ${found} for ${crateName}, but ${SOURCE_FILE} says ${source}. A lock left ` +
        'behind by a version bump is not cosmetic: a build with --locked refuses it, and on a ' +
        'tag that reads as a mysterious Rust failure. Run cargo check in app/src-tauri.',
    );
  }
}

function checkTag(tag, source, places, problems) {
  const expected = `v${source}`;
  const given = String(tag).replace(/^refs\/tags\//, '');

  places.push({ file: 'the tag', found: given || '(empty)' });

  if (given === '') {
    problems.push(
      'the tag is empty. On the release road that means the ref went missing rather than ' +
        `that there is nothing to check: the tag should be ${expected}.`,
    );
    return;
  }

  if (given !== expected) {
    problems.push(
      `the tag ${given} does not match ${SOURCE_FILE}, which says ${source}, so the tag ` +
        `should be ${expected}. One tag, one number: a release whose installer, npm package ` +
        'and Release page disagree with the git history is worse than no release.',
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * The `[package]` name and version out of a Cargo manifest.
 *
 * Section aware and comment aware on purpose. `Cargo.toml` in this repo opens
 * with a long comment block, and it carries `[dependencies.tauri]` with a version
 * of its own further down, so anything that takes the first `version =` in the
 * file reads the wrong number and passes.
 */
function tomlPackageSection(text) {
  let inPackage = false;
  let name;
  let version;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (line.startsWith('#')) continue;

    const header = line.match(/^\[([^\]]+)\]/);
    if (header) {
      inPackage = header[1].trim() === 'package';
      continue;
    }
    if (!inPackage) continue;

    const pair = line.match(/^(name|version)\s*=\s*"([^"]*)"/);
    if (!pair) continue;
    if (pair[1] === 'name') name ??= pair[2];
    else version ??= pair[2];
  }

  return { name, version };
}

/**
 * The version of one crate in a `Cargo.lock`, found by walking `[[package]]`
 * blocks rather than by matching a name and hoping the next version line belongs
 * to it.
 */
function lockedVersionOf(text, crateName) {
  let name;
  let version;

  for (const raw of [...text.split(/\r?\n/), '[[package]]']) {
    const line = raw.replace(/^\s+/, '');
    if (line.startsWith('[[package]]') || line.startsWith('[')) {
      if (name === crateName && version !== undefined) return version;
      name = undefined;
      version = undefined;
      continue;
    }
    const pair = line.match(/^(name|version)\s*=\s*"([^"]*)"/);
    if (!pair) continue;
    if (pair[1] === 'name') name = pair[2];
    else version = pair[2];
  }

  return undefined;
}

function defaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function readTextAt(repoRoot, relative, problems) {
  try {
    return fs.readFileSync(path.join(repoRoot, ...relative.split('/')), 'utf8');
  } catch (error) {
    problems.push(`${relative} could not be read: ${error?.message ?? error}`);
    return undefined;
  }
}

function readJsonAt(repoRoot, relative, problems) {
  const text = readTextAt(repoRoot, relative, problems);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`${relative} is not valid JSON: ${error?.message ?? error}`);
    return undefined;
  }
}

/**
 * What a workflow reads back out of this script. The number is handed forward
 * rather than parsed again downstream, so there is one reader of the manifest per
 * run and not three.
 */
export function githubOutputLines(source) {
  return [`version=${source}`, `tag=v${source}`];
}

// ---------------------------------------------------------------------------

function main(argv) {
  const options = { root: undefined, tag: undefined, githubOutput: false, json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tag') options.tag = argv[(i += 1)] ?? '';
    else if (arg === '--root') options.root = argv[(i += 1)];
    else if (arg === '--github-output') options.githubOutput = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') return usage();
    else {
      process.stderr.write(`unknown option ${arg}. See the header of this file.\n`);
      return 2;
    }
  }

  const repoRoot = options.root ? path.resolve(options.root) : defaultRoot();
  const report = checkVersions({
    repoRoot,
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(render(report));
  }

  if (report.problems.length > 0) return 1;

  if (options.githubOutput) {
    const target = process.env.GITHUB_OUTPUT;
    if (!target) {
      process.stderr.write('--github-output was passed but GITHUB_OUTPUT is not set.\n');
      return 2;
    }
    fs.appendFileSync(target, `${githubOutputLines(report.source).join('\n')}\n`, 'utf8');
  }

  return 0;
}

function render(report) {
  const lines = [];

  if (report.source === undefined) {
    lines.push('', 'version lockstep could not be checked: there is no source of truth.', '');
  } else {
    lines.push('', `version lockstep, from ${SOURCE_FILE}`, '');
    const numberWidth = Math.max(...report.places.map((place) => (place.found ?? '').length));
    const fileWidth = Math.max(...report.places.map((place) => place.file.length));
    for (const place of report.places) {
      const found = (place.found ?? '').padStart(numberWidth);
      const file = place.note ? place.file.padEnd(fileWidth) : place.file;
      const note = place.note ? `   ${place.note}` : '';
      lines.push(`  ${found}  ${file}${note}`);
    }
    lines.push('');
  }

  if (report.problems.length === 0) {
    lines.push('all in step.', '');
    return lines.join('\n');
  }

  lines.push(
    report.problems.length === 1
      ? 'version lockstep is broken.'
      : `version lockstep is broken in ${report.problems.length} places.`,
    '',
  );
  for (const problem of report.problems) lines.push(`  ${problem}`, '');
  lines.push(
    'Lockstep versioning: one version number, written by hand in ' +
      `${SOURCE_FILE} only. Everything else is generated from it or checked against it.`,
    '',
  );

  return lines.join('\n');
}

function usage() {
  process.stdout.write(
    [
      'node scripts/check-versions.mjs [options]',
      '',
      '  --tag <tag>       also compare a tag (v0.1.0 or refs/tags/v0.1.0)',
      '  --root <dir>      repo root, default the parent of this script',
      '  --github-output   append version= and tag= to $GITHUB_OUTPUT',
      '  --json            print the report as JSON',
      '',
    ].join('\n'),
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
