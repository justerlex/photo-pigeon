#!/usr/bin/env node
/**
 * Stage everything the tray needs to run the core without a Node on the machine.
 *
 * Produces, from nothing, every time:
 *
 *   app/src-tauri/binaries/pigeon-core-<triple>.exe   the pinned node.exe, renamed
 *   app/src-tauri/resources/core.mjs                  one file, the whole CLI
 *   app/src-tauri/resources/NODE-LICENSE.txt          Node's licence, verbatim
 *   app/src-tauri/resources/core-manifest.json        what is actually in the box
 *
 * Both directories are deleted before they are written. A build that finds a stale
 * bundle is a build that ships yesterday's core.
 *
 * Names and paths are not written here. They live in scripts/sidecar-layout.json,
 * which the Rust shell reads too, so the two sides cannot drift.
 *
 * Three things about this pipeline are not obvious and are enforced below rather
 * than remembered:
 *
 * 1. The bundle is ESM, not CommonJS, and it is called core.mjs and not core.cjs.
 *    src/cli.ts ends in a top level await. esbuild refuses that outright with the
 *    cjs output format ("Top-level await is currently not supported"), so cjs is
 *    not a preference that was weighed, it is a build error. See the return notes
 *    for the two other shims cjs would have needed.
 *
 * 2. esbuild leaves every require() that came from a bundled CommonJS dependency
 *    as __require("..."), and in ESM output its __require shim throws
 *    'Dynamic require of "x" is not supported'. There are 62 of those calls in
 *    this bundle, including require("tty") and require("util") at the top of
 *    debug/src/node.js, which google-auth-library pulls in through
 *    https-proxy-agent. esbuild does not warn about any of them. The banner below
 *    defines a real require via createRequire, which turns the shim back into the
 *    real thing, and assertDynamicRequires() fails the build if a specifier ever
 *    appears that is neither a Node builtin nor on the explained list.
 *
 * 3. The core reads its own version with createRequire(import.meta.url) plus
 *    require('../package.json'), which resolves to nothing once the file has moved
 *    into resources/. inlineCoreVersion() replaces that read with the literal from
 *    the repo root package.json at build time, which is also what the
 *    lockstep rule wants: one file holds the version and everything else is
 *    generated from it. The replacement is asserted, so if src/cli.ts ever changes
 *    shape the build stops instead of shipping a bundle that dies on startup.
 *
 * @inquirer/prompts still rides along at M4, and the reason has changed, so the
 * note has been rewritten rather than deleted.
 *
 * The old reason was the ordering: M3 kept a temporary console setup path
 * alive, that path needed the prompts, and marking them external before the
 * first run window existed would have produced a bundle that passed every test
 * and died on the one path a brand new user hits first. That precondition is
 * met now. The shell never spawns a console at all: the tray's Setup item opens
 * a real window, which runs `setup --events ndjson` as a sidecar, and that path
 * never loads the prompt stack, because `src/wizard/ask.ts` imports it lazily
 * and only the terminal front end reaches the import.
 *
 * The new reason is a measurement rather than an ordering. The whole bundle is
 * 1.14 MB inside an 85.94 MB installed footprint, so the prompts are a fraction
 * of a percent of what ships, while marking them external means
 * `pigeon-core.exe core.mjs setup` crashes for anybody who runs the installed
 * core from a terminal, and there is no node_modules beside it to resolve from.
 * A saving of nothing against a crash on a real path is not a trade worth
 * taking, so the flag stays bundled and this line records that the decision was
 * made rather than forgotten.
 *
 * Usage:
 *   node scripts/build-sidecar.mjs [options]
 *
 *   --skip-core-build   do not run tsc in the repo root, use dist/ as it stands
 *   --node <path>       stage this node.exe instead of the one running this script.
 *                       A flag and not an env var on purpose: PHOTO_PIGEON_NODE is the
 *                       shell's runtime override and the two must never be confused.
 *   --target <triple>   target triple for the sidecar name, default from this host
 *   --allow-unignored   build even if git would track the generated directories
 *   --quiet             only print the summary
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..');
const SRC_TAURI = path.join(APP, 'src-tauri');

const layout = readJson(path.join(HERE, 'sidecar-layout.json'));
const rootPkg = readJson(path.join(REPO, 'package.json'));

/**
 * Specifiers that are allowed to survive as a dynamic require in the bundle,
 * with the reason. Anything not here and not a Node builtin fails the build.
 */
const EXPLAINED_DYNAMIC_REQUIRES = new Map([
  [
    'supports-color',
    'debug/src/node.js requires it inside a try/catch. It is an optional peer of ' +
      'debug and is deliberately not installed, so the require throws and debug ' +
      'falls back to no colour. Nothing in the core reads debug output anyway.',
  ],
]);

/**
 * Turns esbuild's __require shim back into a real require.
 *
 * The shim is `typeof require !== "undefined" ? require : <thing that throws>`,
 * and it is evaluated after this banner, so declaring require here wins.
 */
const BANNER = [
  '// Generated by app/scripts/build-sidecar.mjs. Do not edit, do not commit.',
  '// The line below is load bearing: without it every require() that survived',
  '// bundling, including require("tty") in debug/src/node.js, throws at startup.',
  'import { createRequire as __ppCreateRequire } from "node:module";',
  'var require = __ppCreateRequire(import.meta.url);',
].join('\n');

main().catch((error) => {
  process.stderr.write(`\nsidecar build failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const say = options.quiet ? () => {} : (line) => process.stdout.write(`${line}\n`);

  const triple = options.target ?? hostTriple();
  const exeSuffix = triple.includes('windows') ? '.exe' : '';

  const binariesDir = path.join(SRC_TAURI, 'binaries');
  const resourcesDir = path.join(SRC_TAURI, 'resources');
  const coreBundlePath = path.join(SRC_TAURI, ...layout.coreBundle.split('/'));
  const licensePath = path.join(SRC_TAURI, ...layout.nodeLicense.split('/'));
  const manifestPath = path.join(SRC_TAURI, ...layout.manifest.split('/'));
  const sidecarPath = path.join(binariesDir, `${path.basename(layout.externalBin[0])}-${triple}${exeSuffix}`);

  assertIgnored([binariesDir, resourcesDir], options.allowUnignored, say);

  if (!options.skipCoreBuild) {
    say('tsc  building the core');
    buildCore();
  } else {
    say('tsc  skipped, using dist/ as it stands');
  }

  const entry = path.join(REPO, 'dist', 'cli.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      `${entry} is missing. Run npm run build in ${REPO} first, or drop --skip-core-build.`,
    );
  }

  // Delete before writing. Both directories are generated in full.
  fs.rmSync(binariesDir, { recursive: true, force: true });
  fs.rmSync(resourcesDir, { recursive: true, force: true });
  fs.mkdirSync(binariesDir, { recursive: true });
  fs.mkdirSync(path.dirname(coreBundlePath), { recursive: true });

  say(`esbuild  ${path.relative(REPO, entry)} to ${layout.coreBundle}`);
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile: coreBundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: `node${layout.nodeVersion.replace(/^v/, '').split('.').slice(0, 2).join('.')}`,
    plugins: [inlineCoreVersion(entry)],
    banner: { js: BANNER },
    // Third party MIT notices have to survive into the shipped file.
    legalComments: 'eof',
    charset: 'utf8',
    metafile: true,
    logLevel: 'silent',
  });

  for (const warning of result.warnings) {
    process.stderr.write(`esbuild warning: ${warning.text}\n`);
  }
  if (result.warnings.length > 0) {
    throw new Error(
      `${result.warnings.length} esbuild warning(s). Every warning has to be explained in ` +
        'this script before it is allowed to ship. None are expected today.',
    );
  }

  const bundle = fs.readFileSync(coreBundlePath, 'utf8');
  assertBanner(bundle);
  assertVersionInlined(bundle);
  const dynamicRequires = assertDynamicRequires(bundle, say);
  assertDependenciesBundled(result.metafile);

  say(`node  staging ${layout.nodeVersion} as ${path.relative(SRC_TAURI, sidecarPath)}`);
  const node = stageNode(sidecarPath, options.nodeExe);

  fs.copyFileSync(vendorLicensePath(), licensePath);

  const manifest = {
    $comment:
      'Generated by app/scripts/build-sidecar.mjs. Records what is actually in the ' +
      'installed package. No timestamps, so two builds of one commit are identical.',
    coreVersion: rootPkg.version,
    targetTriple: triple,
    node: {
      version: node.version,
      bytes: node.bytes,
      sha256: node.sha256,
      authenticode: node.authenticode,
      licence: layout.nodeLicense,
    },
    coreBundle: {
      path: layout.coreBundle,
      bytes: Buffer.byteLength(bundle),
      sha256: sha256Of(coreBundlePath),
      format: 'esm',
      inputFiles: Object.keys(result.metafile.inputs).length,
      inquirerBundled: Object.keys(result.metafile.inputs).some((f) => f.includes('@inquirer')),
      dynamicRequires,
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const licenceBytes = fs.statSync(licensePath).size;
  const total = manifest.coreBundle.bytes + node.bytes + licenceBytes + fs.statSync(manifestPath).size;

  say('');
  say(`  core.mjs          ${mb(manifest.coreBundle.bytes)}  (${manifest.coreBundle.inputFiles} input files, @inquirer/prompts ${manifest.coreBundle.inquirerBundled ? 'bundled' : 'external'})`);
  say(`  pigeon-core.exe   ${mb(node.bytes)}  node ${node.version}, Authenticode ${node.authenticode}`);
  say(`  NODE-LICENSE.txt  ${mb(licenceBytes)}`);
  say(`  staged total      ${mb(total)} uncompressed`);
  say('');
  say(`  version ${rootPkg.version} inlined from ${path.relative(REPO, path.join(REPO, 'package.json'))}`);
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    skipCoreBuild: false,
    allowUnignored: false,
    quiet: false,
    nodeExe: undefined,
    target: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-core-build') options.skipCoreBuild = true;
    else if (arg === '--allow-unignored') options.allowUnignored = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--node') options.nodeExe = argv[(i += 1)];
    else if (arg === '--target') options.target = argv[(i += 1)];
    else throw new Error(`unknown option ${arg}. See the header of this file.`);
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hostTriple() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  throw new Error(
    `no target triple mapped for ${process.platform}/${process.arch}. Pass --target explicitly.`,
  );
}

/**
 * Refuses to stage an 85 MB binary into a directory git would track.
 */
function assertIgnored(dirs, allow, say) {
  const missing = [];
  for (const dir of dirs) {
    const probe = path.join(dir, 'probe');
    const check = spawnSync('git', ['check-ignore', '-q', probe], { cwd: APP });
    if (check.error) {
      say('git  not available, skipping the gitignore check');
      return;
    }
    if (check.status !== 0) missing.push(path.relative(APP, dir).replace(/\\/g, '/'));
  }
  if (missing.length === 0) return;
  const lines = missing.map((d) => `${d}/`).join('\n');
  const message =
    `git does not ignore ${missing.join(' or ')}. This build is about to put a ` +
    `${mb(85202416)} node.exe there.\nAdd to app/.gitignore:\n\n${lines}\n\n` +
    'Then run again. Pass --allow-unignored only if you know why.';
  if (!allow) throw new Error(message);
  say(`WARNING  ${message}`);
}

function buildCore() {
  const tsc = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    throw new Error(`${tsc} is missing. Run npm ci in ${REPO} first.`);
  }
  const run = spawnSync(process.execPath, [tsc], { cwd: REPO, stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`tsc exited ${run.status}`);
}

/**
 * Replaces the entry's own version lookup with the literal from the repo root
 * package.json. Only the entry file is touched, and only if the shape is exactly
 * the one this was written against. Anything else stops the build.
 *
 * dist/cli.js today:
 *   const requireFromHere = createRequire(import.meta.url);
 *   const pkg = requireFromHere('../package.json');
 */
function inlineCoreVersion(entryPath) {
  const pattern =
    /const\s+requireFromHere\s*=\s*createRequire\(\s*import\.meta\.url\s*\)\s*;\s*const\s+pkg\s*=\s*requireFromHere\(\s*['"]\.\.\/package\.json['"]\s*\)\s*;/;
  return {
    name: 'photo-pigeon-inline-core-version',
    setup(build) {
      let fired = false;
      build.onLoad({ filter: /cli\.js$/ }, (args) => {
        if (path.resolve(args.path) !== path.resolve(entryPath)) return null;
        const source = fs.readFileSync(args.path, 'utf8');
        const matches = source.match(new RegExp(pattern, 'g')) ?? [];
        if (matches.length !== 1) {
          throw new Error(
            `expected exactly one '../package.json' version read in ${args.path}, found ` +
              `${matches.length}. src/cli.ts changed shape, so inlineCoreVersion in ` +
              'app/scripts/build-sidecar.mjs needs updating before the tray can ship.',
          );
        }
        fired = true;
        const literal = JSON.stringify({ name: rootPkg.name, version: rootPkg.version });
        return { contents: source.replace(pattern, `const pkg = ${literal};`), loader: 'js' };
      });
      build.onEnd(() => {
        if (!fired) throw new Error('inlineCoreVersion never saw the entry point.');
      });
    },
  };
}

function assertBanner(bundle) {
  if (!bundle.includes('__ppCreateRequire(import.meta.url)')) {
    throw new Error('the createRequire banner is not in the output. Every dynamic require would throw.');
  }
}

/**
 * The core reads its version through require('../package.json'), which does not
 * exist once the bundle has moved. esbuild cannot see that require, so this is a
 * source level replacement, and it has to be asserted or it fails silently at
 * the user's first launch rather than here.
 */
function assertVersionInlined(bundle) {
  if (bundle.includes("'../package.json'") || bundle.includes('"../package.json"')) {
    throw new Error(
      "the bundle still requires '../package.json'. inlineCoreVersion did not fire, so the " +
        'sidecar would die on startup with MODULE_NOT_FOUND. src/cli.ts probably changed shape.',
    );
  }
}

function assertDynamicRequires(bundle, say) {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const found = new Map();
  for (const match of bundle.matchAll(/__require\(\s*["']([^"']+)["']\s*\)/g)) {
    found.set(match[1], (found.get(match[1]) ?? 0) + 1);
  }
  const unexplained = [...found.keys()].filter(
    (spec) => !builtins.has(spec) && !EXPLAINED_DYNAMIC_REQUIRES.has(spec),
  );
  if (unexplained.length > 0) {
    throw new Error(
      `dynamic require of ${unexplained.join(', ')} survived bundling and is not a Node ` +
        'builtin. It will not resolve on a machine with no node_modules. Either bundle it, ' +
        'or add it to EXPLAINED_DYNAMIC_REQUIRES in this script with the reason it is safe.',
    );
  }
  const nonBuiltin = [...found.keys()].filter((spec) => !builtins.has(spec)).sort();
  for (const spec of nonBuiltin) {
    say(`         explained dynamic require: ${spec}  ${EXPLAINED_DYNAMIC_REQUIRES.get(spec)}`);
  }
  return { builtins: [...found.keys()].filter((s) => builtins.has(s)).sort(), explained: nonBuiltin };
}

/**
 * Every production dependency has to be inside the bundle, because there is no
 * node_modules on the target machine.
 *
 * This is not paranoia about esbuild. src/commands/runtime.ts reaches most of the
 * core through lazy await import(), and src/gphotos/auth.ts reaches `open` that
 * way too, on the OAuth path only. A dependency that quietly stopped being
 * reachable would leave a bundle that passes every smoke test and dies the first
 * time a real user signs in.
 */
function assertDependenciesBundled(metafile) {
  const inputs = Object.keys(metafile.inputs);
  const missing = Object.keys(rootPkg.dependencies ?? {}).filter(
    (dep) => !inputs.some((file) => file.includes(`node_modules/${dep}/`)),
  );
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} is a production dependency but nothing from it reached the ` +
        'bundle. There is no node_modules where this runs, so whatever needs it would fail ' +
        'at the user. Check for a lazy import that stopped being reachable.',
    );
  }
}

function vendorLicensePath() {
  const file = path.join(HERE, 'vendor', `node-${layout.nodeVersion}-LICENSE.txt`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${file} is missing. The pinned Node is ${layout.nodeVersion}, so its licence has to ` +
        'ship beside it. Fetch it verbatim from ' +
        `https://raw.githubusercontent.com/nodejs/node/${layout.nodeVersion}/LICENSE`,
    );
  }
  return file;
}

/**
 * Copies node.exe under the sidecar name. Never modifies it: renaming leaves the
 * OpenJS Foundation Authenticode signature intact, and it is the only valid
 * signature in the package while photo-pigeon itself is unsigned.
 */
function stageNode(destination, override) {
  const source = override ?? process.execPath;
  if (!fs.existsSync(source)) throw new Error(`${source} does not exist`);

  const probe = spawnSync(source, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`${source} --version exited ${probe.status}`);
  const version = probe.stdout.trim();
  if (version !== layout.nodeVersion) {
    throw new Error(
      `${source} is ${version} but sidecar-layout.json pins ${layout.nodeVersion}. The core's ` +
        'durability guarantees were tested on the pinned build, so this is a decision, not a ' +
        'mismatch to paper over. Pass --node <path> to the pinned runtime, or change the pin ' +
        'and the vendored licence together.',
    );
  }

  fs.copyFileSync(source, destination);
  return {
    version,
    bytes: fs.statSync(destination).size,
    sha256: sha256Of(destination),
    authenticode: authenticodeStatus(destination),
  };
}

/**
 * Best effort, and reported rather than enforced: a failure here is worth knowing
 * about but is not a reason to block a build on a machine without PowerShell.
 */
function authenticodeStatus(file) {
  if (process.platform !== 'win32') return 'not checked';
  const command = `(Get-AuthenticodeSignature -LiteralPath '${file}').Status`;
  // pwsh first on purpose. Windows PowerShell 5.1 on this machine cannot autoload
  // Microsoft.PowerShell.Security from a child process, so it is the fallback.
  for (const host of ['pwsh.exe', 'powershell.exe']) {
    const run = spawnSync(host, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
    });
    if (!run.error && run.status === 0 && run.stdout.trim()) return run.stdout.trim();
  }
  return 'not checked';
}

function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
