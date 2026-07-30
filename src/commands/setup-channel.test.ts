/**
 * `setup --events ndjson`, tested at the process boundary.
 *
 * This is the seam the tray's first-run window stands on, and every one of the
 * failures below was found by running the binary rather than by reading it:
 *
 *   * the flag did not exist at all, so the very first IPC call in the exit
 *     criterion spawned a process that died on `unknown option '--events'`
 *     before it created a single file;
 *   * `requireInteractive()` refused a non-TTY, which is exactly what a spawned
 *     sidecar is, so even with the flag accepted the run would have thrown on
 *     the first question;
 *   * the stdin vocabulary had no way to carry a payload, so an answer had
 *     nowhere to travel.
 *
 * Nothing here goes near `~/.photo-pigeon`. Every run is pointed at a temp
 * folder with `-c`, and `--no-open` keeps the console links off this machine's
 * browser. The wizard is never allowed to finish: finishing means OAuth, and
 * OAuth means a browser and a real Google account.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { SetupEvent } from './setup-channel.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let work: string | undefined;
let running: ChildProcessByStdio<Writable, Readable, Readable> | undefined;

interface Child {
  out: () => string;
  err: () => string;
  events: () => SetupEvent[];
  typesOf: (type: string) => SetupEvent[];
  say: (line: string) => void;
  answer: (payload: unknown) => void;
  exited: Promise<number | null>;
}

function startSetup(args: string[]): Child {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'setup', ...args], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PHOTO_PIGEON_DEBUG: '' },
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  running = child;

  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));

  const events = (): SetupEvent[] =>
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as SetupEvent);

  return {
    out: () => out,
    err: () => err,
    events,
    typesOf: (type) => events().filter((event) => event.type === type),
    say: (line) => void child.stdin.write(`${line}\n`),
    answer: (payload) => void child.stdin.write(`answer ${JSON.stringify(payload)}\n`),
    exited: new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    }),
  };
}

const waitFor = async (condition: () => boolean, within = 30_000): Promise<void> => {
  const deadline = Date.now() + within;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The open question, or undefined while the core is between questions. */
function openAsk(child: Child): (SetupEvent & { type: 'ask' }) | undefined {
  const asks = child.typesOf('ask') as (SetupEvent & { type: 'ask' })[];
  const answered = new Set(
    (child.typesOf('answered') as (SetupEvent & { type: 'answered' })[])
      .filter((event) => event.accepted)
      .map((event) => event.id),
  );
  return [...asks].reverse().find((ask) => !answered.has(ask.id));
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pigeon-setup-'));
  work = dir;
  return dir;
}

afterEach(async () => {
  if (running && running.exitCode === null) {
    running.stdin.end();
    running.kill();
  }
  running = undefined;
  if (work) await rm(work, { recursive: true, force: true });
  work = undefined;
});

describe('setup --events ndjson', () => {
  it(
    'accepts the flag, asks its first question on stdout, and never demands a TTY',
    async () => {
      const dir = await scratch();
      const child = startSetup(['--events', 'ndjson', '--no-open', '-c', join(dir, 'config.json')]);

      await waitFor(() => child.typesOf('ask').length > 0);

      // The refusal that used to be unconditional. A sidecar is never a TTY.
      expect(child.err()).not.toContain('needs a terminal it can ask questions in');
      expect(child.out()).not.toContain('unknown option');

      // Every stdout line is one event, parseable, with a type and a moment.
      for (const event of child.events()) {
        expect(typeof event.type).toBe('string');
        expect(typeof event.at).toBe('string');
      }
      expect(child.typesOf('setup-started')).toHaveLength(1);

      const ask = openAsk(child);
      expect(ask?.kind).toBe('confirm');
      expect(typeof ask?.id).toBe('string');
      expect(ask?.message).toMatch(/Project created/);
    },
    60_000,
  );

  it(
    'takes an answer on stdin and says whose it was, then asks the next question',
    async () => {
      const dir = await scratch();
      const child = startSetup(['--events', 'ndjson', '--no-open', '-c', join(dir, 'config.json')]);

      await waitFor(() => openAsk(child) !== undefined);
      const first = openAsk(child)!;
      child.answer({ id: first.id, value: true });

      await waitFor(() => child.typesOf('answered').length > 0);
      const receipt = child.typesOf('answered')[0] as SetupEvent & { type: 'answered' };
      expect(receipt.id).toBe(first.id);
      expect(receipt.accepted).toBe(true);

      // The project id question is the next one, and it is a typed answer.
      await waitFor(() => openAsk(child) !== undefined && openAsk(child)!.id !== first.id);
      expect(openAsk(child)?.kind).toBe('input');
    },
    60_000,
  );

  it(
    'answers a dead ask id instead of swallowing it, and keeps the real question open',
    async () => {
      // The M3 rule about the machine channel, applied to the one new form: a
      // shell has exactly one reading of silence, that the core did not
      // understand, and it acts on that reading. A window that closed mid-ask
      // and reopened is the ordinary way to hold a dead id.
      const dir = await scratch();
      const child = startSetup(['--events', 'ndjson', '--no-open', '-c', join(dir, 'config.json')]);

      await waitFor(() => openAsk(child) !== undefined);
      const live = openAsk(child)!;

      child.answer({ id: 'no-such-ask', value: true });
      await waitFor(() => child.typesOf('answered').length > 0);

      const receipt = child.typesOf('answered')[0] as SetupEvent & { type: 'answered' };
      expect(receipt.id).toBe('no-such-ask');
      expect(receipt.accepted).toBe(false);
      expect(receipt.open).toBe(live.id);
      expect(receipt.error).toMatch(/not the question/i);
      // And the live question is still live: nothing was consumed.
      expect(openAsk(child)?.id).toBe(live.id);
    },
    60_000,
  );

  it(
    'refuses an answer that fails the core validation and asks the same question again',
    async () => {
      // The rule the window depends on: validation lives on the side holding
      // the state machine. A window never re-implements a rule, it renders the
      // sentence the core sent back.
      const dir = await scratch();
      const child = startSetup(['--events', 'ndjson', '--no-open', '-c', join(dir, 'config.json')]);

      await waitFor(() => openAsk(child) !== undefined);
      const created = openAsk(child)!;
      child.answer({ id: created.id, value: true });

      await waitFor(() => openAsk(child) !== undefined && openAsk(child)!.id !== created.id);
      const projectId = openAsk(child)!;
      // The console rejects a project id with "google" in it, and only tells
      // you at the last screen. The wizard knows that rule already.
      child.answer({ id: projectId.id, value: 'my-google-project' });

      await waitFor(
        () => (child.typesOf('answered') as { accepted: boolean }[]).some((r) => !r.accepted),
      );
      const refusal = (child.typesOf('answered') as (SetupEvent & { type: 'answered' })[]).find(
        (receipt) => !receipt.accepted,
      )!;
      expect(refusal.id).toBe(projectId.id);
      expect(refusal.error).toMatch(/Google/);
      // Asked again, same id, carrying the sentence so the page can show it.
      await waitFor(() =>
        (child.typesOf('ask') as (SetupEvent & { type: 'ask'; error?: string })[]).some(
          (ask) => ask.id === projectId.id && typeof ask.error === 'string',
        ),
      );
    },
    60_000,
  );

  it(
    'stops on the word stop, writing nothing, and says so on the machine channel',
    async () => {
      const dir = await scratch();
      const child = startSetup(['--events', 'ndjson', '--no-open', '-c', join(dir, 'config.json')]);

      await waitFor(() => openAsk(child) !== undefined);
      child.say('stop');

      const code = await child.exited;
      expect(code).toBe(0);
      // `stopped` is the last line of a run here exactly as it is for a watch.
      const types = child.events().map((event) => event.type);
      expect(types[types.length - 1]).toBe('stopped');
      // A cancelled setup leaves no config behind.
      expect(await readdir(dir)).not.toContain('config.json');
    },
    60_000,
  );

  it(
    'never puts a Google sign-in URL on the wire, so no window can render consent',
    async () => {
      // TRAY-DESIGN section 3 and law 3: consent opens in the system browser,
      // opened by the core, and never in a WebviewWindow. The strongest form of
      // that is that the shell is never handed an auth URL at all. Console deep
      // links are a different thing and are allowed, so this asserts the host
      // rather than the absence of links.
      const dir = await scratch();
      const child = startSetup(['--events', 'ndjson', '--no-open', '-c', join(dir, 'config.json')]);

      await waitFor(() => child.typesOf('link').length > 0);
      for (const event of child.typesOf('link') as (SetupEvent & { type: 'link' })[]) {
        expect(new URL(event.url).host).toBe('console.cloud.google.com');
      }
      expect(child.out()).not.toContain('accounts.google.com');
    },
    60_000,
  );
});
