/**
 * watch tests with a fake Runtime: no filesystem, no chokidar, no network.
 *
 * The interesting behaviour here is the shutdown. Ctrl+C has to close the door
 * and still finish what is already inside, which is the difference between a
 * clean stop and a file that Google received but the ledger never recorded.
 *
 * Since M1 there are three more shutdowns to get right, because the tray drives
 * this command as a child process and, on Windows, cannot send it a signal at
 * all: stop() in process, a stop line on stdin, and the lock that stops a second
 * copy from starting in the first place.
 *
 * Every run here passes logFile: false. The fake config points at a folder that
 * does not exist and must not be created: tests write to temp directories they
 * clean up, never to a path that looks like somebody's home.
 */

import path from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { AppConfig, FileCandidate, GPhotosClient, Ledger, LedgerEntry } from '../contracts.js';
import { releaseBackoffNaps } from '../gphotos/http.js';
import type { LockLoss, LockOptions, LockRecord, LockResult } from '../state/lock.js';
import { EXIT } from './errors.js';
import type { Logger } from './log.js';
import type { Runtime } from './runtime.js';
import {
  STDIN_WORDS,
  STORAGE_HONESTY,
  applyWatchFlags,
  runWatch,
  type WatchEvent,
} from './watch.js';

// The queue borrows the transport's backoff nap, so releasing it is where the
// second ctrl+c stops being a sentence and becomes something the process can
// actually do. The real module is kept and only the release is watched: a
// promise no test can see kept is exactly the bug this guards.
vi.mock('../gphotos/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gphotos/http.js')>();
  return { ...actual, releaseBackoffNaps: vi.fn(actual.releaseBackoffNaps) };
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    watchDirs: ['/photos'],
    credentialsPath: '/home/.photo-pigeon/credentials.json',
    tokenPath: '/home/.photo-pigeon/token.json',
    ledgerPath: '/home/.photo-pigeon/ledger.json',
    extensions: ['.jpg'],
    ...overrides,
  };
}

function candidate(name: string): FileCandidate {
  return { path: `/photos/${name}`, size: 2048, mtimeMs: 1_700_000_000_000 };
}

function recordingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (message: string): void => {
    lines.push(message);
  };
  return {
    lines,
    log: {
      info: push,
      ok: push,
      warn: push,
      error: push,
      muted: push,
      plain: (message = '') => {
        lines.push(message);
      },
    },
  };
}

const holder = (pid: number): LockRecord => ({
  pid,
  startedAt: 1_700_000_000_000,
  takenAt: '2026-07-28T09:00:00.000Z',
  host: 'somewhere',
  holder: 'watch',
});

interface Harness {
  runtime: Runtime;
  entries: Map<string, LedgerEntry>;
  uploads: string[];
  closed: () => boolean;
  clientBuilt: () => boolean;
  lockReleased: () => boolean;
  sideIndexOpened: () => boolean;
  sideIndexClosed: () => boolean;
  albumsAsked: string[];
  /**
   * Fires the run's own onLost, which is what a heartbeat does when it re-reads
   * the lock file and finds somebody else's record in it.
   */
  lose: (loss: LockLoss, heldBy: LockRecord | null) => void;
  /** Hands the run a file the way the live watcher would, after the startup scan. */
  feed: (candidate: FileCandidate) => void;
  /** How many on-demand reconciliation walks the run has asked for. */
  rescans: () => number;
}

/**
 * A runtime whose watcher interrupts the process as soon as it has handed over
 * the files it found, which is the worst case for the drain: every file is
 * still in flight when the stop arrives.
 *
 * Pass interrupt: false for the --once path and for the stop() tests, which
 * have to come back on their own. A test that hangs there is the test doing its
 * job: it means the run sat waiting for a Ctrl+C nobody was going to send.
 */
function harness(
  config: AppConfig,
  found: FileCandidate[],
  options: {
    interrupt?: boolean;
    secondInterrupt?: boolean;
    stallUploads?: boolean;
    lockHeldBy?: number;
    failAuth?: string;
    /**
     * Milliseconds each upload takes. Anything above zero means there is really
     * work in flight when a stop or a detach arrives, which is the only state
     * where the difference between them can be seen.
     */
    uploadDelayMs?: number;
    /** Basenames Google refuses outright, so the pass ends with failures. */
    refuse?: string[];
    /** The upload call number on which the day's request budget runs out. */
    quotaOnCall?: number;
    /** What an on-demand reconciliation walk finds, per call. */
    rescanFinds?: FileCandidate[][];
    /** How long an on-demand walk takes, so a second one can arrive during it. */
    rescanDelayMs?: number;
  } = {},
): Harness {
  const interrupt = options.interrupt !== false;
  const entries = new Map<string, LedgerEntry>();
  const uploads: string[] = [];
  const albumsAsked: string[] = [];
  const refuse = new Set(options.refuse ?? []);
  let closed = false;
  let clientBuilt = false;
  let lockReleased = false;
  let sideIndexOpened = false;
  let sideIndexClosed = false;
  let held: LockOptions | undefined;
  let offer: ((candidate: FileCandidate) => void) | undefined;
  let rescans = 0;
  let uploadCalls = 0;

  const ledger: Ledger = {
    has: (hash) => entries.has(hash),
    get: (hash) => entries.get(hash),
    add: async (entry) => {
      entries.set(entry.hash, entry);
    },
    stats: () => ({
      count: entries.size,
      totalBytes: [...entries.values()].reduce((total, entry) => total + entry.bytes, 0),
    }),
  };

  const client: GPhotosClient = {
    ensureAuth: async () => {
      if (options.failAuth) throw new Error(options.failAuth);
    },
    uploadFile: async (filePath) => {
      uploadCalls += 1;
      if (options.quotaOnCall === uploadCalls) {
        const spent = new Error(
          'photo-pigeon has used 9000 of its 9000 metered Google Photos calls for today (2026-07-29).',
        );
        spent.name = 'DailyQuotaError';
        throw spent;
      }
      uploads.push(filePath);
      // A stalled upload parks the drain that the first ctrl+c started, which
      // is the state the second ctrl+c has to be able to walk away from.
      if (options.stallUploads) await new Promise<void>(() => undefined);
      if (options.uploadDelayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.uploadDelayMs));
      }
      if (refuse.has(path.basename(filePath))) {
        // 400 reads as permanent, so the queue calls it failed without sitting
        // out four real backoffs first.
        throw new Error(`Google will not take ${path.basename(filePath)} (400)`);
      }
      return `token-${path.basename(filePath)}`;
    },
    batchCreate: async (items) =>
      items.map((item) => ({
        uploadToken: item.uploadToken,
        fileName: item.fileName,
        ok: true,
        mediaItemId: `id-${item.fileName}`,
      })),
    ensureAlbum: async (name) => {
      albumsAsked.push(name);
      return `album-${name}`;
    },
  };

  const runtime: Runtime = {
    loadConfig: async () => config,
    openLedger: async () => ledger,
    createClient: async () => {
      clientBuilt = true;
      return client;
    },
    acquireLock: async (_ledgerPath: string, lockOptions?: LockOptions): Promise<LockResult> => {
      held = lockOptions;
      if (options.lockHeldBy !== undefined) {
        return { ok: false, reason: 'held', heldBy: holder(options.lockHeldBy) };
      }
      return {
        ok: true,
        lock: {
          path: '/home/.photo-pigeon/watch.lock',
          record: holder(process.pid),
          stolen: false,
          release: async () => {
            lockReleased = true;
          },
        },
      };
    },
    openSideIndex: async () => {
      sideIndexOpened = true;
      return {
        lookup: () => undefined,
        remember: () => {},
        flush: async () => {},
        close: async () => {
          sideIndexClosed = true;
        },
        stats: { entries: 0, hits: 0, misses: 0, bytesNotRead: 0 },
      };
    },
    reconcile: async (_config, onCandidate) => {
      const call = rescans;
      rescans += 1;
      if (options.rescanDelayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.rescanDelayMs));
      }
      const finds = options.rescanFinds?.[call] ?? [];
      for (const item of finds) onCandidate(item);
      return finds;
    },
    start: async (_config, onCandidate) => {
      offer = onCandidate;
      for (const item of found) onCandidate(item);
      // Interrupt as soon as the files are in, before any of them can finish.
      if (interrupt) {
        setTimeout(() => {
          process.emit('SIGINT', 'SIGINT');
        }, 5);
        if (options.secondInterrupt === true) {
          setTimeout(() => {
            process.emit('SIGINT', 'SIGINT');
          }, 25);
        }
      }
      return {
        handle: {
          close: async () => {
            closed = true;
          },
        },
        reconciled: found,
      };
    },
    usage: async () => undefined,
    runWizard: async () => config,
    runDoctor: async () => ({ ok: true, text: '' }),
    hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
  };

  return {
    runtime,
    entries,
    uploads,
    closed: () => closed,
    clientBuilt: () => clientBuilt,
    lockReleased: () => lockReleased,
    sideIndexOpened: () => sideIndexOpened,
    sideIndexClosed: () => sideIndexClosed,
    albumsAsked,
    lose: (loss, heldBy) => held?.onLost?.(loss, heldBy),
    feed: (item) => offer?.(item),
    rescans: () => rescans,
  };
}

/** Every run in this file keeps its hands off the real filesystem. */
const base = { logFile: false, stdinControl: false } as const;

/** Waits for something the run does on its own, or gives up loudly. */
async function until(check: () => boolean, within = 3_000): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('runWatch', () => {
  it('says what uploads cost in storage, every run', async () => {
    const config = testConfig();
    const { runtime } = harness(config, []);
    const { log, lines } = recordingLogger();

    await runWatch({ ...base, version: '9.9.9' }, runtime, log);

    expect(lines).toContain(STORAGE_HONESTY);
    expect(lines.some((line) => line.includes('photo-pigeon') && line.includes('9.9.9'))).toBe(true);
  });

  it('finishes the files already in the queue after ctrl+c, then stops', async () => {
    const config = testConfig({ albumName: 'Trip' });
    const found = [candidate('a.jpg'), candidate('b.jpg'), candidate('c.jpg')];
    const test = harness(config, found);
    const { log } = recordingLogger();

    const code = await runWatch({ ...base }, test.runtime, log);

    expect(code).toBe(0);
    expect(test.uploads).toHaveLength(3);
    expect(test.entries.size).toBe(3);
    expect(test.closed()).toBe(true);
    expect(test.albumsAsked).toEqual(['Trip']);
    expect(test.lockReleased()).toBe(true);
  });

  it('leaves for real on a second ctrl+c, instead of promising to and staying', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], {
      secondInterrupt: true,
      stallUploads: true,
    });
    const { log, lines } = recordingLogger();

    const code = await runWatch({ ...base }, test.runtime, log);

    expect(code).toBe(EXIT.INTERRUPTED);
    expect(lines.some((line) => line.includes('leaving now'))).toBe(true);
    // Saying it was never the hard part. A retry nap is a pending timer, and
    // Node stays up for a pending timer no matter what this function returns.
    expect(vi.mocked(releaseBackoffNaps)).toHaveBeenCalled();
    expect(test.lockReleased()).toBe(true);
  });

  it('with --once, delivers the scan and leaves on its own, exit 0', async () => {
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg')];
    // No SIGINT anywhere in this test: --once has to come back by itself.
    const test = harness(config, found, { interrupt: false });
    const { log, lines } = recordingLogger();

    const code = await runWatch({ ...base, once: true }, test.runtime, log);

    expect(code).toBe(0);
    expect(test.uploads).toHaveLength(2);
    expect(test.entries.size).toBe(2);
    expect(test.closed()).toBe(true);
    // The live path's invitation to Ctrl+C would be a lie in a one pass run.
    expect(lines.some((line) => line.includes('ctrl+c'))).toBe(false);
    expect(lines).toContain(STORAGE_HONESTY);
    expect(lines.some((line) => line.includes('2 files delivered'))).toBe(true);
  });

  it('never signs in or uploads in a dry run', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')]);
    const { log, lines } = recordingLogger();

    const code = await runWatch({ ...base, dryRun: true }, test.runtime, log);

    expect(code).toBe(0);
    expect(test.clientBuilt()).toBe(false);
    expect(test.uploads).toHaveLength(0);
    expect(test.entries.size).toBe(0);
    expect(lines.some((line) => line.includes('would upload a.jpg'))).toBe(true);
  });
});

describe('the hash cache', () => {
  it('is opened for a real run and shut again on the way out', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')]);
    const { log } = recordingLogger();

    await runWatch({ ...base }, test.runtime, log);

    expect(test.sideIndexOpened()).toBe(true);
    expect(test.sideIndexClosed()).toBe(true);
  });

  it('is opened for a dry run too, so previewing a big library is not a full re-hash', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')]);
    const { log } = recordingLogger();

    await runWatch({ ...base, dryRun: true }, test.runtime, log);

    // The cache says what a file's bytes hash to. It cannot say whether that
    // file was delivered, so it cannot make a dry run send anything.
    expect(test.sideIndexOpened()).toBe(true);
    expect(test.sideIndexClosed()).toBe(true);
  });
});

describe('the single instance lock', () => {
  it('refuses to start when somebody already holds it, and names the pid', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], { lockHeldBy: 4242 });
    const { log } = recordingLogger();

    await expect(runWatch({ ...base }, test.runtime, log)).rejects.toThrow(/pid 4242/);
  });

  it('says it once: execute() prints the CommandError, so the run must not log it too', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], { lockHeldBy: 4242 });
    const { log, lines } = recordingLogger();

    await runWatch({ ...base }, test.runtime, log).catch(() => undefined);

    expect(lines.filter((line) => /already watching this folder set/.test(line))).toHaveLength(0);
  });

  it('does not sign in or start watching when it cannot have the lock', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], { lockHeldBy: 4242 });
    const { log } = recordingLogger();

    await runWatch({ ...base }, test.runtime, log).catch(() => undefined);

    expect(test.clientBuilt()).toBe(false);
    expect(test.uploads).toHaveLength(0);
  });

  it('stands down when another process takes the lock over mid run', async () => {
    // The half of the guard that used to be missing. Taking the lock is
    // decided once, at a moment that is over; being robbed of it happens
    // later, and a run that keeps delivering afterwards is two watchers
    // against one ledger, which is the duplicate the lock exists to prevent.
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], { interrupt: false });
    const machine: string[] = [];
    const { log, lines } = recordingLogger();

    const run = runWatch(
      { ...base, events: 'ndjson', emit: (line) => machine.push(line), humanLog: log },
      test.runtime,
      log,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    test.lose('stolen', holder(424242));
    const code = await run;

    const events = machine.map((line) => JSON.parse(line) as WatchEvent);
    expect(code).toBe(EXIT.OK);
    expect(events.find((event) => event.type === 'lock-lost')).toMatchObject({
      reason: 'stolen',
      heldBy: 424242,
      stopping: true,
    });
    // Named as its own stop reason, so a tray can tell it from a user quitting.
    expect(events.find((event) => event.type === 'stopping')).toMatchObject({ reason: 'lock-lost' });
    expect(events.at(-1)?.type).toBe('stopped');
    expect(test.closed()).toBe(true);
    expect(test.lockReleased()).toBe(true);
    expect(lines.some((line) => line.includes('taken over the lock'))).toBe(true);
  });

  it('says a heartbeat it cannot write, and keeps working', async () => {
    // Nobody has taken anything here. The lock file cannot be refreshed, so a
    // start elsewhere may read this run as abandoned, which is a state to show
    // and not a reason to stop delivering.
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], { interrupt: false });
    const machine: string[] = [];
    const { log } = recordingLogger();

    const run = runWatch(
      { ...base, events: 'ndjson', emit: (line) => machine.push(line), humanLog: log },
      test.runtime,
      log,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    test.lose('unverifiable', null);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const beforeStop = machine.map((line) => JSON.parse(line) as WatchEvent);
    expect(beforeStop.find((event) => event.type === 'lock-lost')).toMatchObject({
      reason: 'unverifiable',
      stopping: false,
    });
    expect(beforeStop.some((event) => event.type === 'stopping')).toBe(false);

    const code = await run.stop();
    expect(code).toBe(EXIT.OK);
    expect(test.entries.size).toBe(1);
  });

  it('hands the lock back when the run fails part way', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false, failAuth: 'the token expired' });
    const { log } = recordingLogger();

    await runWatch({ ...base }, test.runtime, log).catch(() => undefined);

    expect(test.lockReleased()).toBe(true);
  });
});

describe('stop()', () => {
  it('drains what is in the queue and resolves with the exit code', async () => {
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg'), candidate('c.jpg')];
    // Nothing sends a signal here. Without stop() this test would hang, which
    // is the point: a parent process on Windows has no other way to ask.
    const test = harness(config, found, { interrupt: false });
    const { log } = recordingLogger();

    const run = runWatch({ ...base }, test.runtime, log);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const code = await run.stop();

    expect(code).toBe(EXIT.OK);
    expect(test.uploads).toHaveLength(3);
    expect(test.entries.size).toBe(3);
    expect(test.closed()).toBe(true);
    expect(test.lockReleased()).toBe(true);
  });

  it('remembers a stop asked for before the run was listening', async () => {
    const config = testConfig();
    const found = [candidate('a.jpg')];
    const test = harness(config, found, { interrupt: false });
    const { log } = recordingLogger();

    const run = runWatch({ ...base }, test.runtime, log);
    // Not even one tick: the run is still loading its config.
    const code = await run.stop();

    expect(code).toBe(EXIT.OK);
    expect(test.entries.size).toBe(1);
    expect(test.closed()).toBe(true);
  });

  it('leaves without draining when it is asked twice', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], {
      interrupt: false,
      stallUploads: true,
    });
    const { log, lines } = recordingLogger();

    const run = runWatch({ ...base }, test.runtime, log);
    await new Promise((resolve) => setTimeout(resolve, 10));
    void run.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const code = await run.stop();

    expect(code).toBe(EXIT.INTERRUPTED);
    expect(lines.some((line) => line.includes('leaving now'))).toBe(true);
  });

  it('is still the promise it always was', async () => {
    const config = testConfig();
    const test = harness(config, []);
    const { log } = recordingLogger();

    // Every existing caller awaits the return value and gets an exit code.
    await expect(runWatch({ ...base }, test.runtime, log)).resolves.toBe(0);
  });
});

describe('--events ndjson', () => {
  async function eventRun(
    options: Parameters<typeof runWatch>[0] = {},
    found: FileCandidate[] = [candidate('a.jpg')],
    harnessOptions: Parameters<typeof harness>[2] = {},
  ): Promise<{
    events: WatchEvent[];
    machine: string[];
    human: string[];
    passedIn: string[];
    test: Harness;
    code: number;
  }> {
    const config = testConfig({ albumName: 'Trip' });
    const test = harness(config, found, harnessOptions);
    const machine: string[] = [];
    const humanSink = recordingLogger();
    const passedIn = recordingLogger();

    const code = await runWatch(
      {
        ...base,
        events: 'ndjson',
        emit: (line) => machine.push(line),
        humanLog: humanSink.log,
        ...options,
      },
      test.runtime,
      passedIn.log,
    );

    return {
      events: machine.map((line) => JSON.parse(line) as WatchEvent),
      machine,
      human: humanSink.lines,
      passedIn: passedIn.lines,
      test,
      code,
    };
  }

  it('writes one parseable JSON line per event', async () => {
    const { machine, events } = await eventRun();

    expect(machine.length).toBeGreaterThan(0);
    for (const line of machine) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    for (const event of events) {
      expect(typeof event.type).toBe('string');
      expect(Date.parse(event.at)).not.toBeNaN();
    }
  });

  it('covers a delivery from start to finish', async () => {
    const { events } = await eventRun();
    const types = events.map((event) => event.type);

    expect(types[0]).toBe('started');
    expect(types).toContain('scanning');
    expect(types).toContain('delivering');
    expect(types).toContain('delivered');
    expect(types).toContain('stopping');
    expect(types.at(-1)).toBe('stopped');

    const started = events.find((event) => event.type === 'started');
    expect(started).toMatchObject({
      pid: process.pid,
      watchDirs: ['/photos'],
      album: 'Trip',
      dryRun: false,
      once: false,
      ledgerPath: '/home/.photo-pigeon/ledger.json',
    });

    const delivered = events.find((event) => event.type === 'delivered');
    expect(delivered).toMatchObject({
      path: '/photos/a.jpg',
      hash: 'hash-a.jpg',
      bytes: 2048,
      mediaItemId: 'id-a.jpg',
    });

    const stopped = events.at(-1);
    expect(stopped).toMatchObject({ type: 'stopped', exitCode: 0 });
    expect(stopped?.type === 'stopped' && stopped.totals?.delivered).toBe(1);
  });

  it('keeps the human lines off the machine channel', async () => {
    const { human, machine, passedIn } = await eventRun();

    expect(human).toContain(STORAGE_HONESTY);
    expect(machine.some((line) => line.includes(STORAGE_HONESTY))).toBe(false);
    // The logger the caller handed in belongs to stdout, which is now the
    // machine's. Nothing human is allowed near it.
    expect(passedIn).toHaveLength(0);
  });

  it('reports a run that could not sign in as auth-needed, then stopped', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false, failAuth: 'invalid_grant' });
    const machine: string[] = [];
    const { log } = recordingLogger();

    await runWatch(
      { ...base, events: 'ndjson', emit: (line) => machine.push(line), humanLog: log },
      test.runtime,
      log,
    ).catch(() => undefined);

    const events = machine.map((line) => JSON.parse(line) as WatchEvent);
    const types = events.map((event) => event.type);
    expect(types).toContain('auth-needed');
    expect(types.at(-1)).toBe('stopped');
    expect(events.at(-1)).toMatchObject({ exitCode: EXIT.FAILED });
  });

  it('ends with stopped even when the lock refused the run', async () => {
    const config = testConfig();
    const test = harness(config, [], { lockHeldBy: 4242 });
    const machine: string[] = [];
    const { log } = recordingLogger();

    await runWatch(
      { ...base, events: 'ndjson', emit: (line) => machine.push(line), humanLog: log },
      test.runtime,
      log,
    ).catch(() => undefined);

    const events = machine.map((line) => JSON.parse(line) as WatchEvent);
    expect(events.map((event) => event.type)).toEqual(['failed', 'stopped']);
    expect(events[0]).toMatchObject({ error: expect.stringContaining('pid 4242') as unknown as string });
  });

  it('refuses a format it does not know rather than guessing', async () => {
    const config = testConfig();
    const test = harness(config, []);
    const { log } = recordingLogger();

    const refusal = runWatch({ ...base, events: 'yaml' as 'ndjson' }, test.runtime, log);
    await expect(refusal).rejects.toThrow(/not a format/);
    // The sentence says what went wrong, the hint says what to type instead.
    await expect(refusal).rejects.toMatchObject({ hint: expect.stringContaining('ndjson') as unknown as string });
  });

  it('feeds onEvent whether or not the ndjson channel is on', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')]);
    const { log } = recordingLogger();
    const seen: WatchEvent[] = [];

    await runWatch({ ...base, onEvent: (event) => seen.push(event) }, test.runtime, log);

    expect(seen.map((event) => event.type)).toContain('delivered');
    expect(seen.at(-1)?.type).toBe('stopped');
  });

  it('survives a sink that throws, because a narrator is not the work', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')]);
    const { log } = recordingLogger();

    const code = await runWatch(
      {
        ...base,
        onEvent: () => {
          throw new Error('the tray went away');
        },
      },
      test.runtime,
      log,
    );

    expect(code).toBe(0);
    expect(test.entries.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The stdin vocabulary, M3
// ---------------------------------------------------------------------------

/**
 * A run driven the way the tray drives it: control lines in, events out.
 *
 * The stream is a seam and not a fake protocol. listenOnStdin reads whatever it
 * is handed exactly as it reads process.stdin, so `pipe.write('detach\n')` here
 * is byte for byte what the shell writes down the pipe, and `pipe.end()` is the
 * end of file the shell's own death produces.
 */
function driven(
  test: Harness,
  options: Parameters<typeof runWatch>[0] = {},
): {
  run: ReturnType<typeof runWatch>;
  say: (word: string) => void;
  eof: () => void;
  events: WatchEvent[];
  lines: string[];
  typesOf: (type: WatchEvent['type']) => WatchEvent[];
} {
  const pipe = new PassThrough();
  const events: WatchEvent[] = [];
  const sink = recordingLogger();

  const run = runWatch(
    {
      logFile: false,
      stdinControl: true,
      stdin: pipe,
      // The real ten second wait for a part full batch would make every test
      // here a ten second test. Nothing in these tests is about the length of
      // the quiet spell, only about what happens after it.
      quietMs: 25,
      onEvent: (event) => events.push(event),
      humanLog: sink.log,
      ...options,
    },
    test.runtime,
    sink.log,
  );

  return {
    run,
    say: (word: string) => void pipe.write(`${word}\n`),
    eof: () => void pipe.end(),
    events,
    lines: sink.lines,
    typesOf: (type) => events.filter((event) => event.type === type),
  };
}

describe('detach', () => {
  it('finishes the drain after the parent leaves, instead of calling the goodbye a second stop', async () => {
    // The M2 review's second critical, as a test. The tray's quit menu is two
    // presses: the first asks for the drain, the second lets the shell go. The
    // shell going is an end of file here, and before detach existed that end of
    // file arrived at a core which was already stopping, which is the impatient
    // path: exit 130 with the batch abandoned. Against the old code this test
    // ends with one file delivered and code 130.
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg'), candidate('c.jpg')];
    const test = harness(config, found, { interrupt: false, uploadDelayMs: 40 });
    const driver = driven(test);

    await until(() => test.uploads.length > 0);
    driver.say('stop');
    await until(() => driver.typesOf('stopping').length > 0);
    driver.say('detach');
    await until(() => driver.typesOf('detached').length > 0);
    // Exactly what the shell process exiting does to this end of the pipe.
    driver.eof();

    const code = await driver.run;

    expect(code).toBe(EXIT.OK);
    expect(test.uploads).toHaveLength(3);
    expect(test.entries.size).toBe(3);
    expect(driver.typesOf('stopping')).toHaveLength(1);
    expect(driver.typesOf('stopping')[0]).toMatchObject({ reason: 'stdin' });
    expect(driver.lines.some((line) => line.includes('leaving now'))).toBe(false);
    expect(test.lockReleased()).toBe(true);
  });

  it('drains on its own when detach is the first thing it hears', async () => {
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg')];
    // Slow enough that the end of file below lands squarely inside the drain,
    // which is where a build without the detach flag turns it into a second
    // stop and abandons the batch.
    const test = harness(config, found, { interrupt: false, uploadDelayMs: 60 });
    const driver = driven(test);

    await until(() => test.uploads.length > 0);
    driver.say('detach');
    await until(() => driver.typesOf('detached').length > 0);
    driver.eof();

    const code = await driver.run;

    expect(code).toBe(EXIT.OK);
    expect(test.entries.size).toBe(2);
    // Named as its own reason, so the log file can tell a core that was let go
    // from a core whose parent died.
    expect(driver.typesOf('stopping')[0]).toMatchObject({ reason: 'detach' });
    expect(driver.typesOf('stopping')).toHaveLength(1);
  });

  it('answers the word before it starts draining, so the parent never waits', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], { interrupt: false, uploadDelayMs: 20 });
    const driver = driven(test);

    await until(() => test.uploads.length > 0);
    driver.say('detach');
    await until(() => driver.typesOf('detached').length > 0);

    const order = driver.events.map((event) => event.type);
    expect(order.indexOf('detached')).toBeLessThan(order.indexOf('stopping'));

    driver.eof();
    await driver.run;
  });

  it('keeps delivering when the pipe it narrates to is dead', async () => {
    // The other half of leaving: once the shell has gone, every event is a
    // write to a broken pipe. A narrator that throws must not be able to take
    // down a run that is holding bytes Google has accepted but the ledger has
    // not recorded.
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg')];
    const test = harness(config, found, { interrupt: false, uploadDelayMs: 20 });
    const pipe = new PassThrough();
    const sink = recordingLogger();
    let broken = false;

    const run = runWatch(
      {
        logFile: false,
        stdinControl: true,
        stdin: pipe,
        events: 'ndjson',
        humanLog: sink.log,
        emit: () => {
          if (broken) throw new Error('EPIPE: the shell has gone');
        },
      },
      test.runtime,
      sink.log,
    );

    await until(() => test.uploads.length > 0);
    pipe.write('detach\n');
    broken = true;
    pipe.end();

    const code = await run;

    expect(code).toBe(EXIT.OK);
    expect(test.entries.size).toBe(2);
    expect(test.lockReleased()).toBe(true);
  });

  it('still leaves without draining when the parent dies without saying detach', async () => {
    // The other side of the same coin, kept honest: an end of file nobody
    // agreed to is still a stop, and a second one is still the impatient path.
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], {
      interrupt: false,
      stallUploads: true,
    });
    const driver = driven(test);

    await until(() => test.uploads.length > 0);
    driver.say('stop');
    await until(() => driver.typesOf('stopping').length > 0);
    driver.eof();

    const code = await driver.run;

    expect(code).toBe(EXIT.INTERRUPTED);
    expect(driver.typesOf('stopping').at(-1)).toMatchObject({ reason: 'impatient' });
  });
});

describe('pause and resume', () => {
  it('holds everything offered while paused, and delivers it on resume', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const driver = driven(test);

    await until(() => driver.typesOf('delivering').length > 0);
    driver.say('pause');
    await until(() => driver.typesOf('paused').length > 0);

    // The watcher never stops seeing files. That is the difference between a
    // real pause and the stop-and-respawn it replaces: nothing is missed, and
    // resuming costs no re-walk and no re-hash.
    test.feed(candidate('a.jpg'));
    test.feed(candidate('b.jpg'));
    await settle();

    expect(test.uploads).toHaveLength(0);
    expect(driver.typesOf('paused')[0]).toMatchObject({ reason: 'user' });
    expect(driver.typesOf('paused')[0]).not.toHaveProperty('resumesAt');

    driver.say('resume');
    await until(() => test.entries.size === 2);

    expect(test.uploads).toHaveLength(2);
    const resumed = driver.typesOf('resumed')[0];
    expect(resumed).toMatchObject({ reason: 'user', waiting: 2 });
    // And the old way of saying it, so a shell that only knows delivering still
    // clears its paused state.
    expect(driver.typesOf('delivering').at(-1)).toMatchObject({ reason: 'resumed', found: 2 });

    driver.say('stop');
    await expect(driver.run).resolves.toBe(EXIT.OK);
  });

  it('reports a quota hold as the same paused event, with the moment it lifts', async () => {
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg')];
    const test = harness(config, found, { interrupt: false, quotaOnCall: 2 });
    const driver = driven(test);

    await until(() => driver.typesOf('paused').length > 0);

    const held = driver.typesOf('paused')[0];
    expect(held).toMatchObject({ reason: 'quota' });
    expect(held?.type === 'paused' && Date.parse(held.resumesAt ?? '')).toBeGreaterThan(Date.now());
    // The transport's own sentence, counts and all, is what a toast wants.
    expect(held?.type === 'paused' && held.detail).toContain('9000');

    driver.say('stop');
    await expect(driver.run).resolves.toBe(EXIT.OK);
  });

  it('says paused-quota no more, because a compatibility layer on each side of a seam is a duplicate', async () => {
    // The M4 replacement for "still says paused-quota as well, for one
    // milestone". That test was the reminder and this is the receipt.
    //
    // The legacy line existed so an M2-era shell would not go blind to a quota
    // hold while the two sides of the seam were changed by different hands. Its
    // cost was the M3 integration finding: the core said it and the shell also
    // parsed it, and each decision was right alone, so one budget being spent
    // arrived as two identical toasts. The rule that came out of that is the
    // reason this line is gone rather than merely deprecated: a compatibility
    // layer on each side of a seam is not two safety nets, it is a duplicate.
    //
    // Three things die together or not at all, and the third is why this test
    // was rewritten rather than deleted: leaving the assertion behind would go
    // red on the commit that removes the emit, and the tempting fix for a red
    // test is to put the emit back.
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg')];
    const test = harness(config, found, { interrupt: false, quotaOnCall: 2 });
    const driver = driven(test);

    await until(() => driver.typesOf('paused').length > 0);

    expect(driver.events.map((event) => event.type)).not.toContain('paused-quota');
    // The one shape still says everything the two used to, reason and all.
    const held = driver.typesOf('paused')[0];
    expect(held).toMatchObject({ reason: 'quota' });
    expect(held?.type === 'paused' && held.detail).toContain('9000');

    driver.say('pause');
    await until(() => driver.typesOf('paused').length > 1);
    expect(driver.events.map((event) => event.type)).not.toContain('paused-quota');

    driver.say('stop');
    await driver.run;
  });

  it('says so and does nothing when resume arrives with nothing paused', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const driver = driven(test);

    await until(() => driver.typesOf('delivering').length > 0);
    const deliveringBefore = driver.typesOf('delivering').length;
    driver.say('resume');
    await settle();

    expect(driver.lines.some((line) => line.includes('nothing was paused'))).toBe(true);
    // Nothing was lifted, and the word is answered on the machine channel all
    // the same. The M3 review's first critical: a shell reads silence as "the
    // core does not know this word", and acts on that reading, so the one click
    // a person makes when they do not believe the menu has to be able to put
    // the picture right. It says the state it found, which is a queue holding
    // nothing on their behalf.
    expect(driver.typesOf('resumed')).toEqual([
      expect.objectContaining({ reason: 'user', waiting: 0 }),
    ]);
    // And it claims no work, because none started.
    expect(driver.typesOf('delivering')).toHaveLength(deliveringBefore);

    driver.say('stop');
    await driver.run;
  });

  it('answers a pause sent at a run that is already paused, instead of leaving it to silence', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const driver = driven(test);

    await until(() => driver.typesOf('delivering').length > 0);
    driver.say('pause');
    await until(() => driver.typesOf('paused').length > 0);
    driver.say('pause');
    await until(() => driver.typesOf('paused').length > 1);

    expect(driver.typesOf('paused')).toEqual([
      expect.objectContaining({ reason: 'user' }),
      expect.objectContaining({ reason: 'user' }),
    ]);
    expect(driver.lines.some((line) => line.includes('already paused'))).toBe(true);
    // The queue is held once however often it is asked: the second line is an
    // answer, not a second hold.
    expect(driver.typesOf('paused-quota')).toHaveLength(0);

    driver.say('stop');
    await driver.run;
  });

  it('answers a resume that cannot lift the day budget, and never claims work it did not start', async () => {
    // The exact two clicks the M3 review found: a person pauses while a batch
    // is in flight, the batch takes a quota error, and they change their mind.
    // The user's hold really lifts and nothing moves, so the run has to say
    // both halves: resumed for the hold that went, and no delivering at all,
    // because a delivering is what a shell clears its amber "Google limit
    // reached" on.
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg')];
    const test = harness(config, found, { interrupt: false, quotaOnCall: 2 });
    const driver = driven(test);

    await until(() => driver.typesOf('paused').length > 0);
    expect(driver.typesOf('paused')[0]).toMatchObject({ reason: 'quota' });

    driver.say('pause');
    await until(() => driver.typesOf('paused').length > 1);
    const deliveringBefore = driver.typesOf('delivering').length;

    driver.say('resume');
    await until(() => driver.typesOf('resumed').length > 0);
    await settle();

    expect(driver.typesOf('resumed')).toEqual([
      expect.objectContaining({ reason: 'user', waiting: 0 }),
    ]);
    expect(driver.typesOf('delivering')).toHaveLength(deliveringBefore);
    expect(
      driver.lines.some((line) => line.includes("day's request budget is still spent")),
    ).toBe(true);

    driver.say('stop');
    await driver.run;
  });

  it('pauses without stopping intake, so a stop after a pause still drains what was held', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const driver = driven(test);

    await until(() => driver.typesOf('delivering').length > 0);
    driver.say('pause');
    await until(() => driver.typesOf('paused').length > 0);
    test.feed(candidate('a.jpg'));
    await settle();

    driver.say('stop');
    const code = await driver.run;

    // Held files are still on disk and still absent from the ledger. Quitting
    // while paused delivers nothing and loses nothing: the next start finds it.
    expect(code).toBe(EXIT.OK);
    expect(test.uploads).toHaveLength(0);
    expect(test.entries.size).toBe(0);
  });
});

describe('rescan', () => {
  it('runs one pass, and refuses a second while the first is still walking', async () => {
    const config = testConfig();
    const test = harness(config, [], {
      interrupt: false,
      rescanDelayMs: 60,
      rescanFinds: [[candidate('a.jpg')], [candidate('b.jpg')]],
    });
    const driver = driven(test);

    await until(() => driver.typesOf('delivering').length > 0);
    const scansBefore = driver.typesOf('scanning').length;

    driver.say('rescan');
    await settle(10);
    driver.say('rescan');

    await until(() => test.entries.size === 1);

    expect(test.rescans()).toBe(1);
    expect(driver.typesOf('scanning')).toHaveLength(scansBefore + 1);
    expect(driver.typesOf('delivering').at(-1)).toMatchObject({ reason: 'rescan', found: 1 });
    expect(driver.lines.some((line) => line.includes('already being checked'))).toBe(true);

    // And once it has finished, asking again really does run a second pass.
    driver.say('rescan');
    await until(() => test.entries.size === 2);
    expect(test.rescans()).toBe(2);

    driver.say('stop');
    await expect(driver.run).resolves.toBe(EXIT.OK);
  });

  it('says the scan is over even when the walk failed, so no icon is left spinning', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const broken: Runtime = {
      ...test.runtime,
      reconcile: async () => {
        throw new Error('the drive is not there');
      },
    };
    const pipe = new PassThrough();
    const events: WatchEvent[] = [];
    const sink = recordingLogger();

    const run = runWatch(
      { logFile: false, stdinControl: true, stdin: pipe, onEvent: (e) => events.push(e), humanLog: sink.log },
      broken,
      sink.log,
    );

    await until(() => events.some((event) => event.type === 'delivering'));
    pipe.write('rescan\n');
    await until(() =>
      events.some((event) => event.type === 'delivering' && event.reason === 'rescan'),
    );

    expect(sink.lines.some((line) => line.includes('could not check the folders'))).toBe(true);
    pipe.write('stop\n');
    await expect(run).resolves.toBe(EXIT.OK);
  });

  it('refuses to walk once the run is stopping', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], {
      interrupt: false,
      uploadDelayMs: 40,
    });
    const driver = driven(test);

    await until(() => test.uploads.length > 0);
    driver.say('stop');
    await until(() => driver.typesOf('stopping').length > 0);
    driver.say('rescan');

    await driver.run;

    expect(test.rescans()).toBe(0);
    expect(driver.lines.some((line) => line.includes('this run is stopping'))).toBe(true);
  });
});

describe('the stdin vocabulary', () => {
  it('names every word it knows when it hears one it does not', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const driver = driven(test);

    await until(() => driver.typesOf('delivering').length > 0);
    driver.say('{"cmd":"pause"}');
    await until(() =>
      driver.lines.some((line) => line.includes('not a command this build understands')),
    );

    const said = driver.lines.find((line) => line.includes('not a command this build understands'));
    for (const word of STDIN_WORDS) expect(said).toContain(word);
    expect(driver.typesOf('stopping')).toHaveLength(0);

    driver.say('stop');
    await expect(driver.run).resolves.toBe(EXIT.OK);
  });

  it('takes the words in any case, one to a line', async () => {
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const driver = driven(test);

    await until(() => driver.typesOf('delivering').length > 0);
    driver.say('  PAUSE  ');
    await until(() => driver.typesOf('paused').length > 0);
    driver.say('Resume');
    await until(() => driver.typesOf('resumed').length > 0);

    driver.say('QUIT');
    await expect(driver.run).resolves.toBe(EXIT.OK);
  });
});

describe('exit codes', () => {
  it('refuses a second copy with ALREADY_RUNNING rather than the generic failure', async () => {
    // A shell reading 1 cannot tell "somebody else is already delivering these
    // folders", which is fine and needs no repair, from "this install is
    // broken". They are the same code no longer.
    const config = testConfig();
    const test = harness(config, [], { lockHeldBy: 4242 });
    const machine: string[] = [];
    const { log } = recordingLogger();

    const refusal = runWatch(
      { ...base, events: 'ndjson', emit: (line) => machine.push(line), humanLog: log },
      test.runtime,
      log,
    );

    await expect(refusal).rejects.toMatchObject({ code: EXIT.ALREADY_RUNNING });
    expect(EXIT.ALREADY_RUNNING).toBe(5);
    const events = machine.map((line) => JSON.parse(line) as WatchEvent);
    expect(events.at(-1)).toMatchObject({ type: 'stopped', exitCode: EXIT.ALREADY_RUNNING });
  });

  it('with --once, exits PROBLEMS when a file did not make it', async () => {
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg')];
    const test = harness(config, found, { interrupt: false, refuse: ['b.jpg'] });
    const { log, lines } = recordingLogger();

    const code = await runWatch({ ...base, once: true }, test.runtime, log);

    // The pass ran and did its job, so this is not FAILED. One file did not
    // arrive, so it is not OK either: a nightly task whose photos stopped
    // arriving three weeks ago should not be reporting success.
    expect(code).toBe(EXIT.PROBLEMS);
    expect(test.entries.size).toBe(1);
    expect(lines.some((line) => line.includes('did not make it'))).toBe(true);
  });

  it('with --once, still exits OK when everything arrived', async () => {
    const config = testConfig();
    const test = harness(config, [candidate('a.jpg')], { interrupt: false });
    const { log } = recordingLogger();

    await expect(runWatch({ ...base, once: true }, test.runtime, log)).resolves.toBe(EXIT.OK);
  });

  it('with --once, a file left for the next run is not a failure', async () => {
    // dropped and deferred mean "still on disk, still not in the ledger, the
    // next pass finds it". Only failed means something went wrong.
    const config = testConfig();
    const test = harness(config, [], { interrupt: false });
    const { log } = recordingLogger();

    await expect(runWatch({ ...base, once: true }, test.runtime, log)).resolves.toBe(EXIT.OK);
  });
});

describe('applyWatchFlags', () => {
  it('lets the flags win over the config file', () => {
    const config = testConfig({ albumName: 'From config', pollFallback: false });
    const effective = applyWatchFlags(config, {
      dir: ['/other/photos'],
      album: 'From the flag',
      dryRun: true,
      poll: true,
    });

    expect(effective.watchDirs).toEqual([path.resolve('/other/photos')]);
    expect(effective.albumName).toBe('From the flag');
    expect(effective.dryRun).toBe(true);
    expect(effective.pollFallback).toBe(true);
  });

  it('leaves the config alone when no flag was given', () => {
    const config = testConfig({ albumName: 'From config' });
    const effective = applyWatchFlags(config, {});

    expect(effective).toEqual(config);
  });
});

describe('the delivered event and the first photo ever', () => {
  it('carries firstEver on the delivery that found an empty ledger, and on no other', async () => {
    // The ndjson contract change that verdict (b) needs. The shell cannot work
    // this out for itself: by the time a delivered event exists the ledger
    // already holds the line, so a shell that recomputed the answer would get
    // false on the very first photo of a virgin install and false forever
    // after. The truth is sampled before the write and travels on the wire.
    const config = testConfig();
    const found = [candidate('a.jpg'), candidate('b.jpg'), candidate('c.jpg')];
    const test = harness(config, found, { interrupt: false });
    const driver = driven(test);

    await until(() => driver.typesOf('delivered').length === 3);

    const delivered = driver.typesOf('delivered');
    const flagged = delivered.filter(
      (event) => event.type === 'delivered' && event.firstEver === true,
    );
    expect(flagged).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ firstEver: true });

    driver.say('stop');
    await driver.run;
  });

  it('leaves firstEver off entirely for a ledger that already had a line', async () => {
    // A veteran CLI user installing the tray. Absent, not false: the field is
    // omitted when it is not true, which is what makes an added
    // `#[serde(default)]` bool on the Rust side deserialize an old core as
    // "not the first" rather than as "unknown".
    const config = testConfig();
    const test = harness(config, [candidate('new.jpg')], { interrupt: false });
    // One line already in the ledger before the run opens it.
    test.entries.set('hash-old', {
      hash: 'hash-old',
      size: 10,
      bytes: 10,
      firstPath: '/photos/old.jpg',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    });
    const driver = driven(test);

    await until(() => driver.typesOf('delivered').length === 1);

    expect(driver.typesOf('delivered')[0]).not.toHaveProperty('firstEver');

    driver.say('stop');
    await driver.run;
  });
});
