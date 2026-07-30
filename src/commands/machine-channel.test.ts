/**
 * The machine channel, tested at the process boundary.
 *
 * Everything else about --events is tested against runWatch with a fake
 * runtime, which is the right place for what runWatch decides and the wrong
 * place for what the CLI guarantees. The guarantee is about a file descriptor:
 * under --events ndjson, stdout carries one JSON line per event and nothing
 * else, so a Rust shell reading it may be strict and fail loudly rather than
 * guess. A module test cannot see that, because the prose that broke it came
 * from the layer above runWatch, on the error path, where the caller's own
 * logger is the one talking. It was found by running the binary and it is kept
 * honest by running the binary.
 *
 * Nothing here goes anywhere near the real config: every run is pointed at a
 * temp folder with -c, which gives it a temp ledger and therefore a lock of its
 * own, so no test can contend with the production watch on this machine.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { STORAGE_HONESTY, type WatchEvent } from './watch.js';

/** The child runs from the repo root, which is where node finds tsx. */
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let work: string | undefined;

interface Child {
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  /** Everything stdout has said so far. */
  out: () => string;
  /** Everything stderr has said so far. */
  err: () => string;
  /** One WatchEvent per parsed stdout line. Throws when a line is not JSON. */
  events: () => WatchEvent[];
  say: (line: string) => void;
  exited: Promise<number | null>;
}

function startCli(args: string[]): Child {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PHOTO_PIGEON_DEBUG: '' },
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));

  return {
    process: child,
    out: () => out,
    err: () => err,
    events: () =>
      out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as WatchEvent),
    say: (line: string) => void child.stdin.write(`${line}\n`),
    exited: new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    }),
  };
}

/** Every non-empty stdout line, so a failure can print the line that broke it. */
const stdoutLines = (child: Child): string[] =>
  child
    .out()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const waitFor = async (condition: () => boolean, within = 30_000): Promise<void> => {
  const deadline = Date.now() + within;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * A temp config folder, and the folder it watches.
 *
 * The ledger, the lock and the log are all named relative to the config file,
 * so every file this test can cause to exist is inside the temp folder.
 */
async function makeConfig(): Promise<{ dir: string; configPath: string; watchDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pigeon-channel-'));
  work = dir;
  const watchDir = join(dir, 'photos');
  await mkdir(watchDir, { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ watchDirs: [watchDir], extensions: ['.jpg'] }, null, 2),
    'utf8',
  );
  return { dir, configPath: join(dir, 'config.json'), watchDir };
}

afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = undefined;
});

describe('--events ndjson at the process boundary', () => {
  it(
    'keeps a refused start off stdout, hint and all',
    async () => {
      // The double start is the failure a tray hits most, and it used to put an
      // English sentence on stdout: the hint, printed by the outer catch in
      // index.ts through a logger whose warn goes to stdout. One non-JSON line
      // is enough to take a strict parser down.
      const { dir, configPath } = await makeConfig();
      // A lock naming a pid that is demonstrably alive: this test process. The
      // child cannot identify it, and the mtime is fresh, so it reads as held.
      await writeFile(
        join(dir, 'watch.lock'),
        JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          takenAt: new Date().toISOString(),
          host: 'test-host',
          holder: 'watch',
        }),
        'utf8',
      );

      const child = startCli(['watch', '--events', 'ndjson', '-c', configPath]);
      const code = await child.exited;

      // ALREADY_RUNNING since M3, so a script can tell "somebody else is
      // already delivering these folders" from "this install is broken".
      expect(code).toBe(5);
      for (const line of stdoutLines(child)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      expect(child.events().map((event) => event.type)).toEqual(['failed', 'stopped']);
      // The sentence and its next step are still said, on the human channel.
      expect(child.err()).toContain('already watching this folder set');
      expect(child.err()).toContain('Stop that one first');
    },
    60_000,
  );

  it(
    'keeps the banner and the storage line off stdout on a run that works',
    async () => {
      const { configPath } = await makeConfig();

      const child = startCli([
        'watch',
        '--once',
        '--dry-run',
        '--events',
        'ndjson',
        '-c',
        configPath,
      ]);
      const code = await child.exited;

      expect(code).toBe(0);
      for (const line of stdoutLines(child)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      const types = child.events().map((event) => event.type);
      expect(types[0]).toBe('started');
      expect(types.at(-1)).toBe('stopped');
      expect(child.out()).not.toContain(STORAGE_HONESTY);
      expect(child.err()).toContain(STORAGE_HONESTY);
    },
    60_000,
  );

  it(
    'answers a command it does not understand instead of swallowing it',
    async () => {
      // The stop protocol is a bare line. A shell that sends a JSON envelope
      // used to get silence, and silence is what makes a parent give up and
      // reach for child.kill, which abandons a half filed batch. So the
      // unknown command is answered on stderr and the run carries on, and the
      // bare line still stops it cleanly.
      const { dir, configPath } = await makeConfig();
      const child = startCli(['watch', '--dry-run', '--events', 'ndjson', '-c', configPath]);

      await waitFor(() => child.events().some((event) => event.type === 'delivering'));

      child.say('{"cmd":"stop"}');
      await waitFor(() => child.err().includes('not a command this build understands'));
      expect(child.events().some((event) => event.type === 'stopping')).toBe(false);

      child.say('stop');
      const code = await child.exited;

      expect(code).toBe(0);
      const events = child.events();
      expect(events.find((event) => event.type === 'stopping')).toMatchObject({ reason: 'stdin' });
      expect(events.at(-1)?.type).toBe('stopped');
      for (const line of stdoutLines(child)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      // And the lock it took is handed back on the way out.
      await expect(stat(join(dir, 'watch.lock'))).rejects.toThrow();
    },
    60_000,
  );

  it(
    'treats the end of file after a detach as the goodbye it agreed to',
    async () => {
      // The rule in section 2 says write `stop` and then leave stdin open,
      // because being tidy makes the core stop twice and the second stop is the
      // impatient path. A shell that is exiting cannot leave stdin open: the
      // handle dies with the process. `detach` is the word that makes the
      // difference, and this is the only place it can be proved, because the
      // end of file being tested is a real pipe closing and not a stream event
      // a module test arranged.
      const { dir, configPath } = await makeConfig();
      const child = startCli(['watch', '--dry-run', '--events', 'ndjson', '-c', configPath]);

      await waitFor(() => child.events().some((event) => event.type === 'delivering'));

      child.say('detach');
      await waitFor(() => child.events().some((event) => event.type === 'detached'));
      // Exactly what the tray process exiting does to this end of the pipe.
      child.process.stdin.end();

      const code = await child.exited;

      expect(code).toBe(0);
      const events = child.events();
      const stopping = events.filter((event) => event.type === 'stopping');
      expect(stopping).toHaveLength(1);
      expect(stopping[0]).toMatchObject({ reason: 'detach' });
      expect(events.at(-1)?.type).toBe('stopped');
      for (const line of stdoutLines(child)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      await expect(stat(join(dir, 'watch.lock'))).rejects.toThrow();
    },
    60_000,
  );

  it(
    'answers pause, resume and rescan, and says so on the human channel',
    async () => {
      const { configPath } = await makeConfig();
      const child = startCli(['watch', '--dry-run', '--events', 'ndjson', '-c', configPath]);

      await waitFor(() => child.events().some((event) => event.type === 'delivering'));

      child.say('pause');
      await waitFor(() => child.events().some((event) => event.type === 'paused'));
      child.say('resume');
      await waitFor(() => child.events().some((event) => event.type === 'resumed'));
      child.say('rescan');
      await waitFor(() =>
        child
          .events()
          .some((event) => event.type === 'delivering' && event.reason === 'rescan'),
      );

      child.say('stop');
      const code = await child.exited;

      expect(code).toBe(0);
      const events = child.events();
      expect(events.find((event) => event.type === 'paused')).toMatchObject({ reason: 'user' });
      expect(events.find((event) => event.type === 'resumed')).toMatchObject({ reason: 'user' });
      // Three more words, and stdout is still nothing but JSON.
      for (const line of stdoutLines(child)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
    },
    60_000,
  );
});
