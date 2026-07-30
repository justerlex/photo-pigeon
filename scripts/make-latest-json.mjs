#!/usr/bin/env node
/**
 * Assembles the updater manifest and stages exactly what a Release carries.
 *
 * TRAY-DESIGN section 5, the update rule: updates are on by default, the mechanism is
 * `tauri-plugin-updater`, and the endpoint is a static file on GitHub Releases at
 * https://github.com/justerlex/photo-pigeon/releases/latest/download/latest.json.
 * So this file is the thing that decides whether every installed copy can find
 * the next version, and it is written by hand here rather than delegated to
 * `tauri-action`'s `includeUpdaterJson` for one reason: it can be tested at the
 * desk. `scripts/make-latest-json.test.ts` is that test.
 *
 * The trap it exists for, in full, because nothing in a build goes red for it:
 * `productName` is "Photo Pigeon", so the bundler writes
 * `Photo Pigeon_0.1.0_x64-setup.exe`, and GitHub replaces whitespace with dots
 * when it takes a release asset, so the file a user actually downloads is
 * `Photo.Pigeon_0.1.0_x64-setup.exe`. A manifest carrying the bundler's spelling
 * is a manifest pointing at a 404: the installer is fine, the release looks fine,
 * and every installed copy silently fails its update check forever.
 *
 * Three refusals, all of them cheaper here than on a publish day:
 *
 *   more than one installer   Row 13 of the M5 plan, in its own words: two
 *                             near-identical installers side by side is how the
 *                             wrong file ships. A hosted runner starts empty, so
 *                             this fires on a local build off a dirty target dir.
 *   no signature file         The installer would upload happily and the update
 *                             payload would be unverifiable, which the plugin
 *                             treats as no update at all. Names the config flag.
 *   a version in the filename
 *   that is not the one being
 *   released                  The lockstep check covers the manifests and the
 *                             tag. This covers the artefact.
 *
 * There is deliberately no `notes` field. The plugin exposes it to the app, the
 * app never shows it (updates are quiet by default, never a modal), and a field
 * nobody reads is a field that can lie. The prose lives on the Release page.
 *
 * Usage:
 *   node scripts/make-latest-json.mjs --version 0.1.0 --tag v0.1.0 --repo justerlex/photo-pigeon
 *
 *   --bundle <dir>     where the bundler left the installer.
 *                      Default app/src-tauri/target/release/bundle/nsis
 *   --out <dir>        staging directory, emptied first. Default release-assets
 *   --pub-date <iso>   override the timestamp. For tests and reproducible runs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The plugin's own name for this target. One platform today, and adding a second
 * is a milestone (M6, macOS) rather than a line here.
 */
export const UPDATER_TARGET = 'windows-x86_64';

const DEFAULT_BUNDLE = path.join('app', 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const DEFAULT_OUT = 'release-assets';
const MANIFEST_NAME = 'latest.json';

/**
 * The name GitHub serves a release asset under, given the name on disk.
 *
 * Whitespace becomes a dot, and a run of it becomes one dot. This is GitHub's
 * behaviour, not a preference, and the updater URL has to agree with it.
 */
export function assetNameFor(name) {
  return name.replace(/\s+/g, '.');
}

/**
 * @param {string} bundleDir
 * @param {string} version
 * @returns {{ dir: string, installerName: string, installerPath: string, signaturePath: string, signature: string, bytes: number }}
 */
export function findArtifacts(bundleDir, version) {
  const dir = path.resolve(bundleDir);

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    throw new Error(`cannot read the bundle directory ${dir}: ${error?.message ?? error}`);
  }

  const installers = entries.filter((name) => /-setup\.exe$/i.test(name)).sort();

  if (installers.length === 0) {
    const listing = entries.length > 0 ? entries.sort().join(', ') : 'nothing at all';
    throw new Error(
      `no installer in ${dir}. It holds ${listing}. Either the Rust build did not run or ` +
        'bundle.targets in tauri.conf.json no longer says nsis.',
    );
  }

  if (installers.length > 1) {
    throw new Error(
      `${installers.length} installers in ${dir}:\n  ${installers.join('\n  ')}\n` +
        'Exactly one is allowed. Two near-identical installers side by side is how the wrong ' +
        'file gets attached to a Release, so clear the directory and build once. On a hosted ' +
        'runner this cannot happen, which makes it a bug in a local release build.',
    );
  }

  const installerName = installers[0];

  if (!installerName.includes(`_${version}_`)) {
    throw new Error(
      `${installerName} does not carry version ${version}, which is the version being ` +
        'released. The bundler names the installer productName_version_arch-setup.exe, so ' +
        'this is a stale build in the directory or a manifest that changed after the build.',
    );
  }

  const installerPath = path.join(dir, installerName);
  const signaturePath = `${installerPath}.sig`;

  if (!fs.existsSync(signaturePath)) {
    throw new Error(
      `${installerName} has no .sig beside it, so there is nothing to put in ${MANIFEST_NAME} ` +
        'and no installed copy could verify an update.\nTwo things produce one, and both have ' +
        'to be true: bundle.createUpdaterArtifacts must be true in tauri.conf.json, and ' +
        'TAURI_SIGNING_PRIVATE_KEY plus TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set for the ' +
        'build. This signature is minisign and has nothing to do with Authenticode: it says an ' +
        'update came from us and it does nothing at all for SmartScreen.',
    );
  }

  const signature = fs.readFileSync(signaturePath, 'utf8').trim();
  if (signature === '') {
    throw new Error(`${path.basename(signaturePath)} is empty. Do not publish an update nobody can verify.`);
  }

  return {
    dir,
    installerName,
    installerPath,
    signaturePath,
    signature,
    bytes: fs.statSync(installerPath).size,
  };
}

/**
 * @param {{ version: string, tag: string, repo: string, installerName: string, signature: string, pubDate?: string }} parts
 */
export function buildLatestJson({ version, tag, repo, installerName, signature, pubDate }) {
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(
      `the tag ${tag} is not ${expectedTag}, and the download URL in ${MANIFEST_NAME} is built ` +
        'from the tag. One version, one tag, one number.',
    );
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`--repo must be owner/name, got ${repo}. GITHUB_REPOSITORY is that shape already.`);
  }

  const url = `https://github.com/${repo}/releases/download/${tag}/${assetNameFor(installerName)}`;

  return {
    version,
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      [UPDATER_TARGET]: { signature, url },
    },
  };
}

/**
 * Empties the staging directory, copies the installer and its signature into it
 * under their real names, and writes the manifest beside them.
 *
 * The staging directory exists so the workflow can attach a glob instead of a
 * path with a space in it, and so a second run in the same workspace cannot
 * upload the first run's installer.
 *
 * @param {{ bundleDir: string, version: string, tag: string, repo: string, out: string, pubDate?: string }} options
 */
export function stageRelease({ bundleDir, version, tag, repo, out, pubDate }) {
  const found = findArtifacts(bundleDir, version);
  const manifest = buildLatestJson({
    version,
    tag,
    repo,
    installerName: found.installerName,
    signature: found.signature,
    ...(pubDate === undefined ? {} : { pubDate }),
  });

  const staging = path.resolve(out);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const installer = path.join(staging, found.installerName);
  const signature = path.join(staging, path.basename(found.signaturePath));
  const written = path.join(staging, MANIFEST_NAME);

  fs.copyFileSync(found.installerPath, installer);
  fs.copyFileSync(found.signaturePath, signature);
  fs.writeFileSync(written, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    manifest,
    staging,
    installerName: found.installerName,
    assetName: assetNameFor(found.installerName),
    url: manifest.platforms[UPDATER_TARGET].url,
    bytes: found.bytes,
    assets: [installer, signature, written],
  };
}

// ---------------------------------------------------------------------------

function main(argv) {
  const options = {
    bundle: DEFAULT_BUNDLE,
    out: DEFAULT_OUT,
    version: undefined,
    tag: undefined,
    repo: undefined,
    pubDate: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bundle') options.bundle = argv[(i += 1)];
    else if (arg === '--out') options.out = argv[(i += 1)];
    else if (arg === '--version') options.version = argv[(i += 1)];
    else if (arg === '--tag') options.tag = argv[(i += 1)];
    else if (arg === '--repo') options.repo = argv[(i += 1)];
    else if (arg === '--pub-date') options.pubDate = argv[(i += 1)];
    else if (arg === '--help' || arg === '-h') return usage();
    else {
      process.stderr.write(`unknown option ${arg}. See the header of this file.\n`);
      return 2;
    }
  }

  for (const required of ['version', 'tag', 'repo']) {
    if (!options[required]) {
      process.stderr.write(`--${required} is required. See the header of this file.\n`);
      return 2;
    }
  }

  const staged = stageRelease({
    bundleDir: options.bundle,
    version: options.version,
    tag: options.tag,
    repo: options.repo,
    out: options.out,
    ...(options.pubDate === undefined ? {} : { pubDate: options.pubDate }),
  });

  process.stdout.write(
    [
      '',
      `staged for ${options.tag} in ${staged.staging}`,
      '',
      `  ${staged.installerName}  ${(staged.bytes / 1024 / 1024).toFixed(2)} MB`,
      `  served as ${staged.assetName}`,
      `  ${MANIFEST_NAME} points at ${staged.url}`,
      `  pub_date ${staged.manifest.pub_date}`,
      '',
    ].join('\n'),
  );

  return 0;
}

function usage() {
  process.stdout.write(
    [
      'node scripts/make-latest-json.mjs --version <v> --tag <tag> --repo <owner/name> [options]',
      '',
      `  --bundle <dir>    default ${DEFAULT_BUNDLE}`,
      `  --out <dir>       default ${DEFAULT_OUT}, emptied first`,
      '  --pub-date <iso>  override the timestamp',
      '',
    ].join('\n'),
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`\n${error?.message ?? error}\n\n`);
    process.exitCode = 1;
  }
}
