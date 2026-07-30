#!/usr/bin/env node
/**
 * A setup channel that answers nothing but the protocol.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 *
 * run-m4.ps1's setup scenario drives the REAL core, and it must: a fake wizard
 * tested against a fake rig proves that two things one person wrote agree with
 * each other, which is worth nothing. app\e2e\fake-core.mjs refuses `setup`
 * outright for exactly that reason.
 *
 * This file exists for the other half of the problem. The rig's own driver, the
 * loop in Invoke-SetupChannel that reads asks and writes answers, is code, and
 * on a branch cut before M4 there is no core in existence that can exercise it.
 * Shipping a rig whose most intricate function first runs on the night the
 * milestone lands is the pattern every review from M0 to M3 has named.
 *
 * So: ONLY rig-selftest.ps1 runs this, and it runs it to test THE RIG. Nothing
 * it says is evidence about the core. If you find run-m4.ps1 pointed at this
 * file, that is a bug and the scenario it produced is meaningless.
 *
 * IT SPEAKS THE REAL GRAMMAR, not a convenient one
 *
 * Checked against src/commands/setup-channel.ts, which is the authority, and
 * re-checked at integration, because two M4 ask seams were written in parallel
 * and this file had been aimed at the one that did not ship. The shipped
 * grammar is:
 *
 *   - the answer form is `answer {"id":"<id>","value":<json>}`: the word, one
 *     space, one JSON object. The core splits on the first space
 *   - the question's prose is on `message`, and an ask carries no stable name,
 *     so a driver matches on the prose
 *   - every answer line gets an `answered` receipt carrying `accepted`, and a
 *     refused one ALSO re-asks: same id, a fresh `ask`, and an `error` on it
 *     carrying the sentence. A driver that reads a receipt as a refusal
 *     answers a question that is already closed, and spirals
 *
 * The awkward parts are constructed on purpose, because the easy path is the
 * one that would have worked anyway:
 *
 *   - one answer refused, with the question left live, which is the deadlock
 *   - an answer for a dead id refused by name
 *   - a validated folder path, so the rig's substitution tokens are proved to
 *     arrive as real strings rather than as the literal "{watchDir}"
 *   - a Windows path, so the JSON escaping of backslashes is proved
 *
 * It writes exactly one config, at the -c path, and refuses any path inside
 * ~/.photo-pigeon.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const subcommand = argv.find((a) => !a.startsWith('-')) ?? 'setup';

function flagValue(...names) {
  for (const name of names) {
    const at = argv.indexOf(name);
    if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  }
  return undefined;
}

function human(line) {
  process.stderr.write(`${line}\n`);
}

if (subcommand !== 'setup') {
  human('fake-setup: this file implements setup and nothing else.');
  process.exit(64);
}

const configPath = flagValue('-c', '--config');
if (!configPath) {
  human('fake-setup: refusing to run with no -c <config>.');
  process.exit(78);
}

const resolvedConfig = path.resolve(configPath);
const realConfigDir = path.join(os.homedir(), '.photo-pigeon');
if (resolvedConfig === realConfigDir || resolvedConfig.startsWith(realConfigDir + path.sep)) {
  human(`fake-setup: refusing: ${resolvedConfig} is inside the production config directory.`);
  process.exit(78);
}

function emit(body) {
  process.stdout.write(`${JSON.stringify({ ...body, at: new Date().toISOString() })}\n`);
}

// ---------------------------------------------------------------------------
// The ask queue. One question open at a time, ids counting from "1", never
// reused. A question stays live until it is answered acceptably.
// ---------------------------------------------------------------------------

let nextId = 1;
let open = null;

/**
 * Ask one question and resolve with the first answer that passes `check`.
 *
 * `check` returns true, or a sentence. A sentence becomes an `answer-refused`
 * and the question is NOT re-asked: it is still open, still the same id, and
 * the front end is expected to answer again. That is the shape the real channel
 * has, and it is the one that deadlocks a driver which does not know it.
 */
function ask(kind, name, message, extra = {}, check = () => true) {
  const id = String(nextId++);
  return new Promise((resolve) => {
    open = { id, kind, name, message, extra, check, resolve };
    emit({ type: 'ask', id, kind, message, ...extra });
  });
}

/** Ask the open question again, carrying the sentence that refused the answer. */
function reask(error) {
  if (!open) return;
  emit({ type: 'ask', id: open.id, kind: open.kind, message: open.message, ...open.extra, error });
}

function onAnswer(id, payload) {
  // An answer for a question that is not open is refused BY NAME, and the live
  // question stays live: nothing was consumed.
  if (!open || id !== open.id) {
    emit({
      type: 'answered',
      id: id || null,
      accepted: false,
      error: `That is not the question that is open. The open one is ${open ? open.id : 'none'}.`,
      open: open ? open.id : null,
    });
    return;
  }

  let value;
  try {
    value = JSON.parse(payload);
  } catch {
    emit({ type: 'answered', id, accepted: false, error: 'That answer was not JSON.', open: id });
    reask('That answer was not JSON.');
    return;
  }

  const verdict = open.check(value);
  if (verdict !== true) {
    // Refused, and the same question goes out again carrying the sentence.
    emit({ type: 'answered', id, accepted: false, error: String(verdict), open: id });
    reask(String(verdict));
    return;
  }

  const entry = open;
  open = null;
  emit({ type: 'answered', id, accepted: true });
  entry.resolve(value);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf('\n');
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf('\n');
    if (line === '') continue;

    // The real grammar: `answer`, one space, one JSON object carrying the id
    // and the value. The core splits on the first space and parses the rest.
    const match = /^answer[ \t]+([\s\S]*)$/i.exec(line);
    if (match) {
      let envelope;
      try {
        envelope = JSON.parse((match[1] ?? '').trim());
      } catch {
        emit({
          type: 'answered',
          id: null,
          accepted: false,
          error: 'answer takes one JSON object, {"id":"<the ask id>","value":<the answer>}',
          open: open ? open.id : null,
        });
        continue;
      }
      onAnswer(String(envelope?.id ?? ''), JSON.stringify(envelope?.value ?? null));
      continue;
    }

    const word = line.split(/\s+/)[0];
    if (word === 'stop' || word === 'quit') {
      if (open) emit({ type: 'cancelled', id: open.id });
      emit({ type: 'stopping', reason: 'stdin' });
      emit({ type: 'stopped', exitCode: 0 });
      process.exit(0);
    }
    else {
      emit({
        type: 'answered',
        id: null,
        accepted: false,
        error: `"${word}" is not a command setup understands on stdin. Setup takes stop, quit, and answer {"id":"...","value":...}, one to a line.`,
        open: open ? open.id : null,
      });
    }
  }
});
process.stdin.on('end', () => {
  if (open) emit({ type: 'cancelled', id: open.id });
  emit({ type: 'stopping', reason: 'stdin' });
  emit({ type: 'stopped', exitCode: 0 });
  process.exit(0);
});
process.stdin.resume();

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

async function main() {
  emit({
    type: 'setup-started',
    pid: process.pid,
    version: 'fake-setup',
    configPath: resolvedConfig,
    steps: 5,
  });
  emit({ type: 'heading', index: 1, total: 5, title: 'Make a Google project' });
  emit({
    type: 'say',
    level: 'plain',
    text: 'Everything expensive about this tool is said before anyone spends time on it.',
  });
  emit({ type: 'link', url: 'https://console.cloud.google.com/projectcreate', opened: false });

  await ask('confirm', 'project-created', 'Project created?', { default: true });

  // The refusal, and the question staying live. This is the one deadlock the
  // driver can fall into, so it is constructed rather than hoped for: the
  // FIRST answer is always pushed back, whatever it says.
  let seenOnce = false;
  const projectId = await ask('input', 'project-id', 'Paste the project id (or press Enter to skip):', {}, () => {
    if (!seenOnce) {
      seenOnce = true;
      return 'That project id has a space in it, which Google does not allow.';
    }
    return true;
  });
  emit({ type: 'say', level: 'note', text: `project ${projectId}` });

  emit({ type: 'heading', index: 2, total: 5, title: 'Turn the API on' });
  await ask('confirm', 'api-enabled', 'Photos Library API enabled?', { default: true });
  emit({ type: 'heading', index: 3, total: 5, title: 'The sign-in screen' });
  await ask('confirm', 'consent-saved', 'Sign-in screen saved?', { default: true });
  emit({ type: 'heading', index: 4, total: 5, title: 'Publish the app' });
  await ask('confirm', 'published', 'Publishing status now says In production?', { default: false });

  emit({ type: 'heading', index: 5, total: 5, title: 'Create your sign-in client' });
  const credentials = await ask(
    'input',
    'credentials-path',
    'Waiting for the download. Or paste the full path to the JSON:',
    {},
    (value) => (typeof value === 'string' && value !== '' && fs.existsSync(value) ? true : `Nothing at ${value}`),
  );

  // Validated against the real file system, exactly as the wizard validates the
  // folder a terminal user types. This is what proves the rig's {watchDir}
  // token arrived as a real Windows path, backslashes and all, rather than as
  // the literal text or as a mangled JSON string.
  const watchDir = await ask(
    'input',
    'watch-dir',
    'Which folder should the pigeon watch?',
    {},
    (value) =>
      typeof value === 'string' && value !== '' && fs.existsSync(value) && fs.statSync(value).isDirectory()
        ? true
        : `No folder at ${value}`,
  );

  await ask('confirm', 'another-folder', 'Add another folder?', { default: false });
  const wantsAlbum = await ask('confirm', 'wants-album', 'Put everything into one album in Google Photos?', {
    default: false,
  });
  let albumName;
  if (wantsAlbum === true) {
    albumName = await ask('input', 'album-name', 'Album name:', { default: 'photo-pigeon' }, (value) =>
      typeof value === 'string' && value.trim() !== '' ? true : 'An album needs a name.',
    );
  }

  const dir = path.dirname(resolvedConfig);
  const config = {
    watchDirs: [path.resolve(watchDir)],
    credentialsPath: path.join(dir, 'credentials.json'),
    tokenPath: path.join(dir, 'token.json'),
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    extensions: ['.png', '.jpg', '.jpeg'],
    ...(albumName ? { albumName } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(String(credentials), config.credentialsPath);
  fs.writeFileSync(resolvedConfig, `${JSON.stringify(config, null, 2)}\n`);

  emit({
    type: 'setup-written',
    configPath: resolvedConfig,
    watchDirs: config.watchDirs,
    ...(albumName ? { album: albumName } : {}),
    written: true,
  });
  // Deliberately carries no URL. Consent opens the system browser, from the
  // core, always, and there is nothing here for a window to render by accident.
  emit({ type: 'signing-in' });
}

main().catch((error) => {
  emit({ type: 'failed', error: error.message });
  emit({ type: 'stopped', exitCode: 1 });
  process.exit(1);
});
