#!/usr/bin/env node
/**
 * Proves the staged sidecar actually runs on a machine that has no Node, and
 * demonstrates the exact spawn contract the Rust shell has to reproduce.
 *
 * Run it after scripts/build-sidecar.mjs. It never reads or writes anything
 * outside a fresh directory under the OS temp dir, and it refuses to start if
 * any path it is about to use lands inside ~/.photo-pigeon. A production watch
 * runs against that directory and must never be contended with. The temp config
 * gets a temp ledger, and src/state/lock.ts keys the lock on the ledger path, so
 * this cannot collide with a real run even by accident.
 *
 * What it checks:
 *   1. the sidecar binary runs the bundle at all
 *   2. --version reports the version inlined at build time
 *   3. --help and setup --help work from a directory with no node_modules
 *      anywhere above it, so @inquirer/prompts really is in the box
 *   4. status runs, which is a second lazy import chain: almost everything in
 *      src/commands/runtime.ts is reached through await import()
 *   5. a live watch writes nothing but JSON on stdout, and every event has an at
 *   6. the bundled chokidar sees a png dropped into the watched folder
 *   7. stop travels as a bare line on stdin, the core answers with
 *      stopping reason stdin, then stopped, and releases its lock. No signal is
 *      ever sent, because the M1 bench proved a signal delivers nothing on
 *      Windows anyway.
 *
 * The watch runs with --dry-run, and that is not a shortcut. Without credentials
 * a real watch is dead in a few hundred milliseconds, so every stop assertion
 * would pass without a stop ever having happened. A dry run holds a real watcher
 * open with no credentials and no network.
 *
 * One thing to know if you use --dry-run to test the tray by hand: it emits no
 * per file events. The dropped file only shows up in the totals on the stopped
 * event, so a dry run looks exactly like an idle watch from the icon's point of
 * view. Do not test the delivering state that way.
 *
 * Usage: node scripts/smoke-sidecar.mjs [--keep]
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..');
const SRC_TAURI = path.join(APP, 'src-tauri');

const layout = JSON.parse(fs.readFileSync(path.join(HERE, 'sidecar-layout.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

const DRAIN_TIMEOUT_MS = 45_000;
/** Three times WRITE_SETTLE_MS in src/contracts.ts, which is 2s. */
const SETTLE_MS = 6_000;
/** A real 1x1 PNG, so the watcher is judging an image and not just an extension. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const keep = process.argv.includes('--keep');

let failures = 0;
// Detail is printed on failure only. A passing line that carries the thing it
// was checking against reads like a finding, and this output gets skimmed.
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? `  ${detail}` : ''}\n`);
};

const forbidden = path.join(os.homedir(), '.photo-pigeon');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-pigeon-smoke-'));
if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()))) {
  throw new Error(`refusing to run: ${temp} is not under ${os.tmpdir()}`);
}
if (path.resolve(temp).startsWith(path.resolve(forbidden))) {
  throw new Error(`refusing to run: ${temp} is inside ${forbidden}`);
}

const triple = layout.defaultTargetTriple;
const sidecar = path.join(
  SRC_TAURI,
  'binaries',
  `${path.basename(layout.externalBin[0])}-${triple}${process.platform === 'win32' ? '.exe' : ''}`,
);
const coreBundle = path.join(SRC_TAURI, ...layout.coreBundle.split('/'));

try {
  await run();
} finally {
  if (keep) process.stdout.write(`\n  kept ${temp}\n`);
  else fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? '\nsidecar smoke passed\n' : `\nsidecar smoke FAILED: ${failures}\n`);
process.exitCode = failures === 0 ? 0 : 1;

async function run() {
  process.stdout.write(`sidecar  ${sidecar}\nbundle   ${coreBundle}\ntemp     ${temp}\n\n`);
  check('sidecar binary staged', fs.existsSync(sidecar));
  check('core bundle staged', fs.existsSync(coreBundle));
  check('node licence staged', fs.existsSync(path.join(SRC_TAURI, ...layout.nodeLicense.split('/'))));
  if (failures > 0) return;

  const version = spawnSync(sidecar, [coreBundle, '--version'], { cwd: temp, encoding: 'utf8' });
  check('--version runs from a temp cwd', version.status === 0, `exit ${version.status}`);
  check(
    `--version reports the root package.json version, ${rootPkg.version}`,
    version.stdout.trim() === rootPkg.version,
    `it said ${JSON.stringify(version.stdout.trim())}`,
  );

  const help = spawnSync(sidecar, [coreBundle, '--help'], { cwd: temp, encoding: 'utf8' });
  check('--help runs from a temp cwd', help.status === 0, `exit ${help.status}`);
  check('--help mentions the ndjson channel', help.stdout.includes('--events ndjson'));

  const setup = spawnSync(sidecar, [coreBundle, 'setup', '--help'], { cwd: temp, encoding: 'utf8' });
  check('setup loads, so @inquirer/prompts is in the bundle', setup.status === 0, `exit ${setup.status}`);

  writeTempConfig();
  statusSmoke();
  await watchSmoke();
}

/**
 * One config, entirely inside the temp directory. The ledger path is what
 * src/state/lock.ts keys the lock on, so a temp ledger means a temp lock and
 * nothing here can contend with a real watch.
 */
function writeTempConfig() {
  fs.mkdirSync(path.join(temp, 'watched'), { recursive: true });
  fs.writeFileSync(
    path.join(temp, 'config.json'),
    JSON.stringify(
      {
        watchDirs: [path.join(temp, 'watched')],
        credentialsPath: path.join(temp, 'credentials.json'),
        tokenPath: path.join(temp, 'token.json'),
        ledgerPath: path.join(temp, 'ledger.jsonl'),
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * A second lazy import chain. src/commands/runtime.ts reaches almost everything
 * through await import(), so one command exercising one chain is not enough
 * evidence that esbuild inlined them all.
 *
 * status takes -c, so it stays inside the temp directory. doctor deliberately
 * does not take -c and would read the real config, so it is not run here.
 */
function statusSmoke() {
  const configPath = path.join(temp, 'config.json');
  const status = spawnSync(sidecar, [coreBundle, 'status', '-c', configPath], {
    cwd: temp,
    encoding: 'utf8',
  });
  const output = `${status.stdout}${status.stderr}`;
  const clean = !/Cannot find|is not supported/.test(output);
  check('status runs against the temp config', status.status === 0, `exit ${status.status}`);
  check('status did not blow up on a missing lazy import', clean, output.slice(0, 160));
  check('status never named the real config dir', !output.includes(forbidden), `it named ${forbidden}`);
}

/**
 * The whole spawn contract in one place. A Rust shell doing anything different
 * from this is doing it wrong.
 */
async function watchSmoke() {
  const configPath = path.join(temp, 'config.json');
  // --dry-run is what makes the stop protocol testable at all here. Without
  // credentials a real watch goes started, auth-needed, failed, stopped in a few
  // hundred milliseconds, and every stop assertion passes for the wrong reason: the
  // core was already gone. A dry run holds a live watcher open with no credentials
  // and no network, so the stop below is the real thing.
  const args = layout.spawn.watchArgs
    .map((a) => a.replace('{coreBundleAbsPath}', coreBundle).replace('{configPath}', configPath))
    .flatMap((a) => (a === 'ndjson' ? [a, '--dry-run'] : [a]));
  const child = spawn(sidecar, args, { cwd: temp, stdio: ['pipe', 'pipe', 'pipe'] });

  const events = [];
  const badLines = [];
  let stdoutTail = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutTail += chunk;
    const lines = stdoutTail.split('\n');
    stdoutTail = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        badLines.push(line);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  // A core that failed to start is already gone by the time the stop is written,
  // and writing to its stdin raises EPIPE. Worth knowing on the Rust side too:
  // the stop write has to tolerate a pipe that is already closed rather than
  // treating it as a failure to stop.
  let closed = false;
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) =>
    child.on('close', (code) => {
      closed = true;
      resolve(code);
    }),
  );

  const stopSent = new Promise((resolve) => {
    const timer = setInterval(() => {
      const seen = (type) => events.some((e) => e.type === type);
      if (seen(layout.spawn.stoppedEventType) || closed) {
        clearInterval(timer);
        resolve('the core stopped on its own');
      } else if (seen('started')) {
        clearInterval(timer);
        // Drop one real image and let it settle, so the check below is evidence
        // that the bundled chokidar is watching and not just that a process
        // started. WRITE_SETTLE_MS in src/contracts.ts is 2s, so wait 3 times
        // that before asking for the count.
        fs.writeFileSync(path.join(temp, 'watched', 'drop.png'), ONE_PIXEL_PNG);
        setTimeout(() => {
          // The whole stop protocol. A bare line, not a JSON envelope.
          child.stdin.write(layout.spawn.stopLine);
          resolve('stdin');
        }, SETTLE_MS);
      }
    }, 25);
    setTimeout(() => {
      clearInterval(timer);
      resolve('timed out');
    }, DRAIN_TIMEOUT_MS);
  });

  const timeout = setTimeout(() => child.kill(), DRAIN_TIMEOUT_MS);
  const [code, stopRoute] = await Promise.all([exited, stopSent]);
  clearTimeout(timeout);
  if (stdoutTail.trim() !== '') badLines.push(stdoutTail);

  const types = events.map((e) => e.type);
  const started = events.find((e) => e.type === 'started');
  const stopping = events.find((e) => e.type === 'stopping');
  const stopped = events.find((e) => e.type === layout.spawn.stoppedEventType);

  check('watch emitted at least one event', events.length > 0, types.join(' '));
  check('every stdout line parsed as JSON', badLines.length === 0, badLines.slice(0, 2).join(' | '));
  check('every event carries an ISO at', events.every((e) => typeof e.at === 'string'));
  check('the run started, so the bundle got past every lazy import', Boolean(started), types.join(' '));
  check(
    'started named the temp lock and ledger',
    started?.lockPath?.startsWith(temp) && started?.ledgerPath?.startsWith(temp),
    `${started?.ledgerPath}`,
  );
  check('the bundled watcher saw the dropped png', (stopped?.totals?.seen ?? 0) >= 1, JSON.stringify(stopped?.totals));
  check('stop travelled on stdin, with no signal sent', stopRoute === 'stdin', `route: ${stopRoute}`);
  check('the core said it was stopping because of stdin', stopping?.reason === 'stdin', `reason: ${stopping?.reason}`);
  check(
    'the last line is a stopped event',
    types.at(-1) === layout.spawn.stoppedEventType,
    `last was ${types.at(-1)}`,
  );
  check('the core chose its own exit code, and it was clean', code === 0, `exit ${code}`);
  check('nothing named the real config dir', !stderr.includes(forbidden) && !JSON.stringify(events).includes(forbidden));
  check('the lock file was released', !fs.existsSync(path.join(temp, 'watch.lock')));

  process.stdout.write(
    `\n  events: ${types.join(' ') || '(none)'}\n  totals: ${JSON.stringify(stopped?.totals ?? {})}\n`,
  );
}
