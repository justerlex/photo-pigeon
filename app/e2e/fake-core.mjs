#!/usr/bin/env node
/**
 * The rig's fake core: a stand-in the tray can spawn instead of the real one.
 *
 * WHY THIS EXISTS
 *
 * The M4 exit criterion ends in a delivery: "a machine with no config reaches a
 * first delivery, and the only text the user typed was their Google password".
 * A rig cannot type a Google password and must never try, so the last step of
 * that sentence is the one step no script can take honestly.
 *
 * The honest substitute is to split the sentence. Everything up to the delivery
 * runs against the REAL core: the setup channel, the scripted answers, the
 * written config, doctor's report on it. Only the delivery itself is faked,
 * and it is faked in the one place the shell cannot tell the difference:
 * PHOTO_PIGEON_CORE_JS, which paths.rs uses verbatim when it is set. The shell
 * spawns this file exactly as it would spawn the bundle, over the same pipe,
 * speaking the same NDJSON.
 *
 * So what the delivery scenario really proves is the SHELL's half: that a photo
 * appearing in a watched folder becomes a delivered event on the machine
 * channel, that the shell reads it, and that the first-ever truth arrives on
 * the event rather than being counted by the shell. It proves nothing about
 * Google, and it says so in its own output.
 *
 * WHAT IT IS NOT
 *
 * Not a second implementation of the core. It does not upload, it does not sign
 * in, it reaches no network at all, and it has no opinion about anything the
 * real core decides. It is a mouth: it speaks the vocabulary and writes the one
 * file the vocabulary claims to have written.
 *
 * THE LAWS IT IS STILL SUBJECT TO
 *
 *  - UPLOAD ONLY. There is no delete and no mutate path in this file. It
 *    creates a lock, appends to a ledger and appends to a log. It removes
 *    exactly one file, its own lock, and only when the file still names its own
 *    pid, which is the real core's rule too.
 *  - NO TIMER MAY EVER SEND RESCAN. Nothing here is on an interval. New files
 *    are found by fs.watch, which is a watcher, plus one walk at startup, which
 *    is what starting means. `rescan` happens when the word arrives on stdin
 *    and never otherwise.
 *  - The six bare words are the vocabulary. This file answers an unknown line
 *    on stderr BY NAME, the same way the real core does, because a swallowed
 *    command is how a shell ends up waiting for a drain nobody started.
 *  - Prose goes to stderr and one JSON line per event goes to stdout. They
 *    never share a descriptor.
 *
 * SAFETY
 *
 * It refuses to run at all unless it is given a config with -c, and it refuses
 * a config or a ledger inside ~/.photo-pigeon. The rig is careful about that
 * from the outside; this file is careful about it from the inside, because a
 * fake core pointed at the production ledger would write lines about photos
 * that were never uploaded, and nothing downstream could ever tell.
 *
 * Usage, the way the shell spawns it:
 *   node fake-core.mjs watch --events ndjson -c <config.json>
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const subcommand = argv.find((a) => !a.startsWith('-')) ?? 'watch';

function flagValue(...names) {
  for (const name of names) {
    const at = argv.indexOf(name);
    if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  }
  return undefined;
}

const configPath = flagValue('-c', '--config');
const eventsFormat = flagValue('--events');
const machine = eventsFormat === 'ndjson';

/** Prose. Never stdout: stdout is the machine channel and only ever carries JSON. */
function human(line) {
  process.stderr.write(`${line}\n`);
}

function die(message, code = 1) {
  human(`fake-core: ${message}`);
  process.exit(code);
}

if (subcommand === 'setup') {
  // Deliberate. The setup channel is the thing M4 is actually testing, and a
  // fake one would let a green run mean nothing. run-m4.ps1 drives the REAL
  // core for setup and only ever uses this file for the delivery.
  die(
    'this is the rig fake core and it does not implement setup. The setup channel is what M4 is testing, so it is driven against the real core. Unset PHOTO_PIGEON_CORE_JS, or point it at dist/cli.js.',
    64,
  );
}

if (!configPath || configPath.trim() === '') {
  die('refusing to run with no -c <config>. A core with no config opens the default one, which is the real one.', 78);
}

const resolvedConfig = path.resolve(configPath);
const realConfigDir = path.join(os.homedir(), '.photo-pigeon');

function insideRealConfig(candidate) {
  const full = path.resolve(candidate);
  const real = path.resolve(realConfigDir);
  return full === real || full.startsWith(real + path.sep);
}

if (insideRealConfig(resolvedConfig)) {
  die(`refusing: ${resolvedConfig} is inside the production config directory. Nothing in this rig may write there.`, 78);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One event. Every one carries `at`, exactly as the real stream does, and every
 * one is a whole line of JSON on stdout and nothing else.
 *
 * When --events was not asked for, the run is a human one and the events become
 * prose on stderr, so this file is still readable when a person runs it by hand.
 */
function emit(body) {
  const event = { ...body, at: new Date().toISOString() };
  if (machine) process.stdout.write(`${JSON.stringify(event)}\n`);
  else human(`  ${event.type}${event.path ? ` ${path.basename(event.path)}` : ''}`);
}

// ---------------------------------------------------------------------------
// The config, and the files that live beside it
// ---------------------------------------------------------------------------

let config;
try {
  config = JSON.parse(fs.readFileSync(resolvedConfig, 'utf8'));
} catch (error) {
  emit({ type: 'failed', error: `the config at ${resolvedConfig} could not be read: ${error.message}` });
  emit({ type: 'stopped', exitCode: 1 });
  process.exit(1);
}

const watchDirs = (Array.isArray(config.watchDirs) ? config.watchDirs : []).map((d) => path.resolve(d));
if (watchDirs.length === 0) {
  emit({ type: 'failed', error: 'the config has no watchDirs, so there is nothing to watch' });
  emit({ type: 'stopped', exitCode: 1 });
  process.exit(1);
}

const configDir = path.dirname(resolvedConfig);
const ledgerPath = path.resolve(config.ledgerPath ?? path.join(configDir, 'ledger.jsonl'));
if (insideRealConfig(ledgerPath)) {
  die(`refusing: the ledger at ${ledgerPath} is inside the production config directory.`, 78);
}

const dryRun = config.dryRun === true;
const lockPath = path.join(path.dirname(ledgerPath), 'watch.lock');
const logPath = path.join(path.dirname(ledgerPath), 'watch.log');
const sideIndexPath = path.join(path.dirname(ledgerPath), 'sideindex.jsonl');
const extensions = (Array.isArray(config.extensions) && config.extensions.length > 0
  ? config.extensions
  : ['.png', '.jpg', '.jpeg']
).map((e) => e.toLowerCase());

function log(line) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A log that will not open is not a reason to stop delivering.
  }
}

// ---------------------------------------------------------------------------
// The lock. The same shape src/state/lock.ts writes, because the rig and the
// shell both look for it as proof of which config a sidecar really opened.
// ---------------------------------------------------------------------------

let holdsLock = false;

function takeLock() {
  try {
    const handle = fs.openSync(lockPath, 'wx');
    fs.writeSync(
      handle,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        takenAt: new Date().toISOString(),
        host: os.hostname(),
        holder: 'watch',
      }),
    );
    fs.closeSync(handle);
    holdsLock = true;
    return true;
  } catch {
    return false;
  }
}

/** Unlink, and only when the file on disk still names our pid. The real core's rule. */
function releaseLock() {
  if (!holdsLock) return;
  try {
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (record.pid !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Gone already, or never readable. Either way there is nothing to release.
  }
  holdsLock = false;
}

// ---------------------------------------------------------------------------
// The ledger, and the one truth M4 added to it
// ---------------------------------------------------------------------------

/** Every hash already in the ledger. Read once at open, appended to in memory after. */
const delivered = new Set();

function loadLedger() {
  let raw = '';
  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry.hash === 'string') delivered.add(entry.hash);
    } catch {
      // A half written line is one the next append fixes. Not this file's problem.
    }
  }
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Record one delivery, and answer the only interesting question about it.
 *
 * `firstEver` is sampled IMMEDIATELY BEFORE the append, which is the whole
 * point of the rule: the ledger being empty before this line is what
 * "first ever" means, it is the core's fact rather than the shell's, and a
 * count taken after the write says one on a virgin install's very first photo
 * and never says zero again.
 */
function record(file) {
  const hash = sha256(file);
  if (delivered.has(hash)) {
    emit({ type: 'skipped', path: file, hash, reason: 'already-delivered' });
    return;
  }
  const size = fs.statSync(file).size;

  const firstEver = delivered.size === 0;

  if (dryRun) {
    // A dry run writes no ledger by design, and the side index is what records
    // that these bytes were really read. The rig's Test-HashLanded knows this.
    fs.appendFileSync(
      sideIndexPath,
      `${JSON.stringify({ hash, path: file, size, seenAt: new Date().toISOString() })}\n`,
    );
  } else {
    fs.appendFileSync(
      ledgerPath,
      `${JSON.stringify({
        hash,
        size,
        bytes: size,
        firstPath: file,
        mediaItemId: `fake-core-${hash.slice(0, 16)}`,
        uploadedAt: new Date().toISOString(),
      })}\n`,
    );
  }
  delivered.add(hash);
  log(`delivered ${file} firstEver=${firstEver}`);

  emit({
    type: 'delivered',
    path: file,
    hash,
    bytes: size,
    mediaItemId: `fake-core-${hash.slice(0, 16)}`,
    firstEver,
  });
}

// ---------------------------------------------------------------------------
// Finding files. A walk at startup and a watcher after it, and nothing on a
// timer, ever.
// ---------------------------------------------------------------------------

const seenPaths = new Set();

function wanted(file) {
  return extensions.includes(path.extname(file).toLowerCase());
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && wanted(full)) out.push(full);
  }
}

/**
 * Take one file, once it has stopped changing.
 *
 * The settle wait is not politeness: a file still being copied hashes to
 * something that will never be seen again, and the rig's whole proof is that
 * the hash in the ledger is the sha256 of the bytes it made. The real core
 * solves this with the watcher's own settle window; this does it by looking
 * twice.
 */
async function offer(file) {
  if (seenPaths.has(file)) return;
  seenPaths.add(file);
  try {
    const first = await fsp.stat(file);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await fsp.stat(file);
    if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) {
      // Still moving. Let the next watcher event bring it back.
      seenPaths.delete(file);
      return;
    }
    record(file);
  } catch (error) {
    seenPaths.delete(file);
    emit({ type: 'failed', path: file, error: error.message });
  }
}

let paused = false;
/** Files that arrived while paused. Held, never dropped: a pause is a hold. */
const held = [];

async function consider(file) {
  if (!wanted(file)) return;
  if (paused) {
    if (!held.includes(file)) held.push(file);
    return;
  }
  await offer(file);
}

async function scan(reason) {
  emit({ type: 'scanning', dirs: watchDirs });
  const found = [];
  for (const dir of watchDirs) await walk(dir, found);
  const fresh = found.filter((f) => !seenPaths.has(f));
  emit({ type: 'delivering', found: fresh.length, reason });
  for (const file of fresh) await consider(file);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const watchers = [];

function armWatchers() {
  for (const dir of watchDirs) {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, name) => {
        if (!name) return;
        void consider(path.join(dir, name.toString()));
      });
      watchers.push(watcher);
    } catch (error) {
      human(`fake-core: could not watch ${dir}: ${error.message}`);
    }
  }
}

function closeWatchers() {
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
  }
  watchers.length = 0;
}

let stopping = false;
let detached = false;

function finish(exitCode) {
  if (stopping) return;
  stopping = true;
  closeWatchers();
  releaseLock();
  emit({ type: 'stopped', exitCode });
  // A short beat so the parent reads the last line before the pipe closes.
  setTimeout(() => process.exit(exitCode), 60);
}

function onWord(word) {
  switch (word) {
    case 'stop':
    case 'quit':
      emit({ type: 'stopping', reason: 'stop' });
      finish(0);
      return;
    case 'detach':
      detached = true;
      emit({ type: 'detached' });
      return;
    case 'pause':
      paused = true;
      emit({ type: 'paused', reason: 'user' });
      return;
    case 'resume': {
      const waiting = held.length;
      paused = false;
      emit({ type: 'resumed', reason: 'user', waiting });
      if (waiting > 0) {
        emit({ type: 'delivering', found: waiting, reason: 'resumed' });
        const queued = held.splice(0, held.length);
        void (async () => {
          for (const file of queued) await offer(file);
        })();
      }
      return;
    }
    case 'rescan':
      // Only ever from the word. Never from a clock.
      void scan('rescan');
      return;
    default:
      // By name, on stderr, exactly as the real core answers. A front end has
      // one reading of silence and it is the wrong one.
      human(`fake-core: "${word}" is not a command this build understands on stdin`);
  }
}

function armStdin() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== '') onWord(line.split(/\s+/)[0]);
      at = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    // End of file is the shell having gone. After a detach that is not a stop
    // request at all, which is the whole point of the word; the run finishes
    // what it is doing and exits on its own.
    if (detached) {
      finish(0);
      return;
    }
    emit({ type: 'stopping', reason: 'stdin' });
    finish(0);
  });
  process.stdin.resume();
}

async function main() {
  if (!takeLock()) {
    emit({
      type: 'failed',
      error: `another watch already holds ${lockPath}`,
    });
    emit({ type: 'stopped', exitCode: 5 });
    process.exit(5);
  }

  loadLedger();
  log(`fake core up, pid ${process.pid}, config ${resolvedConfig}`);

  emit({
    type: 'started',
    pid: process.pid,
    version: 'fake-core',
    watchDirs,
    ...(config.albumName ? { album: config.albumName } : {}),
    dryRun,
    once: false,
    ledgerPath,
    lockPath,
    logPath,
  });

  armStdin();
  // Watcher first, walk second: the watcher module's own rule, and the other
  // order leaves a window where a file that lands mid walk is seen by neither.
  armWatchers();
  await scan('scan');
}

process.on('exit', () => releaseLock());

main().catch((error) => {
  emit({ type: 'failed', error: error.message });
  finish(1);
});
