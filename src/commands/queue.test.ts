/**
 * Queue tests: the batching and flush logic, and the dry run path.
 *
 * Everything is fake here: no filesystem, no network, no timers. The clock, the
 * sleep and the flush timer are all injected, so a 30 second backoff costs
 * nothing and a 24 hour token expiry is one line.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API_LIMITS } from '../contracts.js';
import type {
  BatchCreateItem,
  BatchCreateOutcome,
  FileCandidate,
  Ledger,
  LedgerEntry,
  UploadOutcome,
} from '../contracts.js';
import { SIDE_INDEX_FILE_NAME, openSideIndex, type SideIndex } from '../state/sideindex.js';
import type { Logger } from './log.js';
import {
  UploadQueue,
  backoffMs,
  classifyFailure,
  sizeLimitFor,
  type HashCache,
  type PauseReason,
  type Schedule,
  type ScheduleOptions,
} from './queue.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeLedger(seed: LedgerEntry[] = []): { ledger: Ledger; entries: Map<string, LedgerEntry> } {
  const entries = new Map<string, LedgerEntry>(seed.map((entry) => [entry.hash, entry]));
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
  return { ledger, entries };
}

interface FakeClient {
  client: { uploadFile(filePath: string): Promise<string>; batchCreate(items: BatchCreateItem[], albumId?: string): Promise<BatchCreateOutcome[]> };
  uploads: string[];
  batches: BatchCreateItem[][];
  albums: Array<string | undefined>;
  everOverlapped(): boolean;
}

function fakeClient(
  respond?: (items: BatchCreateItem[], call: number) => BatchCreateOutcome[],
): FakeClient {
  const uploads: string[] = [];
  const batches: BatchCreateItem[][] = [];
  const albums: Array<string | undefined> = [];
  let inBatch = false;
  let overlapped = false;
  let call = 0;

  return {
    uploads,
    batches,
    albums,
    everOverlapped: () => overlapped,
    client: {
      async uploadFile(filePath: string): Promise<string> {
        uploads.push(filePath);
        return `token-${path.basename(filePath)}`;
      },
      async batchCreate(items: BatchCreateItem[], albumId?: string): Promise<BatchCreateOutcome[]> {
        if (inBatch) overlapped = true;
        inBatch = true;
        batches.push(items);
        albums.push(albumId);
        await Promise.resolve();
        const outcomes = respond
          ? respond(items, call)
          : items.map((item) => ({
              uploadToken: item.uploadToken,
              fileName: item.fileName,
              ok: true,
              mediaItemId: `id-${item.fileName}`,
            }));
        call += 1;
        inBatch = false;
        return outcomes;
      },
    },
  };
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

interface ManualTimer {
  callback: () => void;
  ms: number;
  options: ScheduleOptions | undefined;
  cancelled: boolean;
}

function manualSchedule(): {
  schedule: Schedule;
  fireAll(): void;
  armedCount(): number;
  armed(): ManualTimer[];
} {
  const timers: ManualTimer[] = [];
  return {
    schedule: (callback, ms, options) => {
      const timer: ManualTimer = { callback, ms, options, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fireAll: () => {
      for (const timer of timers.splice(0)) {
        if (!timer.cancelled) timer.callback();
      }
    },
    armedCount: () => timers.filter((timer) => !timer.cancelled).length,
    armed: () => timers.filter((timer) => !timer.cancelled),
  };
}

function candidate(name: string, size = 1024): FileCandidate {
  return { path: `/photos/${name}`, size, mtimeMs: 1_700_000_000_000 };
}

const noSleep = async (): Promise<void> => {};

// ---------------------------------------------------------------------------
// Batching and flush
// ---------------------------------------------------------------------------

describe('UploadQueue batching', () => {
  it('flushes at the API maximum of 50 and never overlaps two batchCreate calls', async () => {
    const { ledger, entries } = fakeLedger();
    const remote = fakeClient();
    const timers = manualSchedule();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: noSleep,
    });

    for (let index = 0; index < 60; index += 1) queue.offer(candidate(`photo-${index}.jpg`));
    await queue.drain();

    expect(remote.batches.map((batch) => batch.length)).toEqual([
      API_LIMITS.BATCH_CREATE_MAX_ITEMS,
      10,
    ]);
    expect(remote.everOverlapped()).toBe(false);
    expect(remote.uploads).toHaveLength(60);
    expect(entries.size).toBe(60);
    expect(queue.totals.delivered).toBe(60);
    expect(queue.totals.bytes).toBe(60 * 1024);
  });

  it('holds a part full batch until the quiet spell ends', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const timers = manualSchedule();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: noSleep,
      quietMs: 10_000,
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    queue.offer(candidate('c.jpg'));
    await queue.whenIdle();

    expect(remote.batches).toHaveLength(0);
    expect(queue.pendingCount).toBe(3);
    expect(timers.armedCount()).toBe(1);

    timers.fireAll();
    await queue.whenIdle();

    expect(remote.batches.map((batch) => batch.length)).toEqual([3]);
    expect(queue.pendingCount).toBe(0);
  });

  it('passes the album id through to batchCreate when one is set', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
      albumId: 'album-42',
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(remote.albums).toEqual(['album-42']);
  });
});

// ---------------------------------------------------------------------------
// The ledger is the durable record
// ---------------------------------------------------------------------------

describe('UploadQueue deduplication', () => {
  it('skips a file the ledger already knows', async () => {
    const { ledger } = fakeLedger([
      {
        hash: 'hash-a.jpg',
        size: 1024,
        bytes: 1024,
        firstPath: '/photos/a.jpg',
        uploadedAt: '2026-07-28T00:00:00.000Z',
      },
    ]);
    const remote = fakeClient();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(remote.uploads).toHaveLength(0);
    expect(remote.batches).toHaveLength(0);
    expect(queue.totals.skipped).toBe(1);
  });

  it('reports the skip through onOutcome, so a watcher hears it per file', async () => {
    const { ledger } = fakeLedger([
      {
        hash: 'hash-a.jpg',
        size: 1024,
        bytes: 1024,
        firstPath: '/photos/a.jpg',
        uploadedAt: '2026-07-28T00:00:00.000Z',
      },
    ]);
    const remote = fakeClient();
    const seen: UploadOutcome[] = [];
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
      onOutcome: (outcome) => seen.push(outcome),
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(seen).toEqual([
      { path: '/photos/a.jpg', hash: 'hash-a.jpg', status: 'skipped-duplicate' },
    ]);
  });

  it('does not upload the same content again after a rename', async () => {
    const { ledger, entries } = fakeLedger();
    const remote = fakeClient();
    const sameContent: Record<string, string> = {
      'holiday.jpg': 'content-hash',
      'holiday-2.jpg': 'content-hash',
    };
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => sameContent[path.basename(filePath)] ?? 'other',
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('holiday.jpg'));
    await queue.drain();
    queue.offer(candidate('holiday-2.jpg'));
    await queue.drain();

    expect(remote.uploads).toEqual(['/photos/holiday.jpg']);
    expect(entries.size).toBe(1);
    expect(queue.totals.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('UploadQueue retries', () => {
  it('sends the refused files again for fresh tokens, and only those files', async () => {
    const { ledger, entries } = fakeLedger();
    const remote = fakeClient((items, call) =>
      items.map((item, index) => ({
        uploadToken: item.uploadToken,
        fileName: item.fileName,
        // First call: only the first item lands. Second call: everything lands.
        ok: call > 0 || index === 0,
        ...(call > 0 || index === 0 ? { mediaItemId: `id-${item.fileName}` } : { error: 'try again' }),
      })),
    );
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    queue.offer(candidate('c.jpg'));
    await queue.drain();

    expect(remote.batches).toHaveLength(2);
    expect(remote.batches[1]?.map((item) => item.fileName)).toEqual(['b.jpg', 'c.jpg']);
    expect(entries.size).toBe(3);
    expect(queue.totals.failed).toBe(0);
    // a.jpg landed and is never touched again. b and c had their tokens spent
    // by the refusal, so the only retry that can work is a fresh upload.
    expect(remote.uploads).toEqual([
      '/photos/a.jpg',
      '/photos/b.jpg',
      '/photos/c.jpg',
      '/photos/b.jpg',
      '/photos/c.jpg',
    ]);
  });

  it('stops after one fresh upload instead of grinding on a file Google keeps refusing', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient((items) =>
      items.map((item) => ({
        uploadToken: item.uploadToken,
        fileName: item.fileName,
        ok: false,
        error: 'Invalid upload token',
      })),
    );
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('cursed.jpg'));
    await queue.drain();

    // One upload, one batchCreate, one more of each, then it waits for the
    // next run rather than spending the day on one file.
    expect(remote.uploads).toHaveLength(2);
    expect(remote.batches).toHaveLength(2);
    expect(queue.totals.failed).toBe(1);
    expect(queue.totals.requests).toBe(4);
  });

  it('resends the same tokens when the call itself failed, but not many times', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    let calls = 0;
    const client = {
      uploadFile: remote.client.uploadFile,
      async batchCreate(): Promise<BatchCreateOutcome[]> {
        calls += 1;
        throw Object.assign(new Error('service unavailable'), { status: 503 });
      },
    };
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    // The call never reached the token, so the same one goes again. Twice, not
    // four times: the transport already ran its own ladder inside each call.
    expect(calls).toBe(2);
    expect(remote.uploads).toHaveLength(1);
    expect(queue.totals.failed).toBe(1);
  });

  it('uploads again when an upload token has outlived its 24 hours', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const { log, lines } = recordingLogger();
    let clock = 1_700_000_000_000;
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
      now: () => clock,
    });

    queue.offer(candidate('slow.jpg'));
    await queue.whenIdle();
    expect(queue.pendingCount).toBe(1);

    clock += API_LIMITS.UPLOAD_TOKEN_TTL_MS;
    await queue.drain();

    expect(remote.uploads).toEqual(['/photos/slow.jpg', '/photos/slow.jpg']);
    expect(lines.some((line) => line.includes('expired'))).toBe(true);
    expect(queue.totals.delivered).toBe(1);
  });

  it('gives up on a permanent upload failure without retrying', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    let attempts = 0;
    const client = {
      async uploadFile(): Promise<string> {
        attempts += 1;
        throw new Error('403 forbidden');
      },
      batchCreate: remote.client.batchCreate,
    };
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('nope.jpg'));
    await queue.drain();

    expect(attempts).toBe(1);
    expect(queue.totals.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('UploadQueue dry run', () => {
  it('says what it would send and touches nothing', async () => {
    const { ledger, entries } = fakeLedger();
    const remote = fakeClient();
    const { log, lines } = recordingLogger();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
      dryRun: true,
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    await queue.drain();

    expect(remote.uploads).toHaveLength(0);
    expect(remote.batches).toHaveLength(0);
    expect(entries.size).toBe(0);
    expect(queue.totals.wouldUpload).toBe(2);
    expect(queue.totals.requests).toBe(0);
    expect(lines.filter((line) => line.includes('would upload'))).toHaveLength(2);
  });

  it('still skips what the ledger already has in a dry run', async () => {
    const { ledger } = fakeLedger([
      {
        hash: 'hash-a.jpg',
        size: 10,
        bytes: 10,
        firstPath: '/photos/a.jpg',
        uploadedAt: '2026-07-28T00:00:00.000Z',
      },
    ]);
    const queue = new UploadQueue({
      ledger,
      client: null,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
      dryRun: true,
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    await queue.drain();

    expect(queue.totals.skipped).toBe(1);
    expect(queue.totals.wouldUpload).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Intake and limits
// ---------------------------------------------------------------------------

describe('UploadQueue intake', () => {
  it('stops taking new files but finishes the ones it accepted', async () => {
    const { ledger, entries } = fakeLedger();
    const remote = fakeClient();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    queue.stopIntake();
    queue.offer(candidate('b.jpg'));
    await queue.drain();

    expect(entries.size).toBe(1);
    expect(queue.totals.dropped).toBe(1);
    expect(remote.uploads).toEqual(['/photos/a.jpg']);
  });

  it('refuses a file that is over the Google size ceiling', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const { log, lines } = recordingLogger();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('huge.jpg', API_LIMITS.MAX_PHOTO_BYTES + 1));
    await queue.drain();

    expect(remote.uploads).toHaveLength(0);
    expect(queue.totals.failed).toBe(1);
    expect(lines.some((line) => line.includes('over the Google limit'))).toBe(true);
  });

  it('holds files back until tomorrow when the day request budget runs out', async () => {
    const { ledger } = fakeLedger();
    const base = fakeClient();
    const uploads: string[] = [];
    const quotaError = new Error(
      'photo-pigeon has used 8000 of its 8000 requests for today (2026-07-28).',
    );
    quotaError.name = 'DailyQuotaError';
    let calls = 0;
    const client = {
      async uploadFile(filePath: string): Promise<string> {
        calls += 1;
        // The second call is the one that finds the budget gone.
        if (calls === 2) throw quotaError;
        uploads.push(filePath);
        return `token-${path.basename(filePath)}`;
      },
      batchCreate: base.client.batchCreate,
    };
    const timers = manualSchedule();
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    queue.offer(candidate('c.jpg'));
    await queue.drain();

    // The one that hit the wall and the one behind it are both waiting, not failed.
    expect(uploads).toEqual(['/photos/a.jpg']);
    expect(queue.totals.deferred).toBe(2);
    expect(queue.totals.failed).toBe(0);
    expect(queue.deferredCount).toBe(2);

    // The day rolls over and the queue picks up where it left off.
    timers.fireAll();
    await queue.drain();

    expect(uploads).toEqual(['/photos/a.jpg', '/photos/b.jpg', '/photos/c.jpg']);
    expect(queue.totals.delivered).toBe(3);
    expect(queue.totals.deferred).toBe(0);
  });

  it('never retries a daily budget refusal', () => {
    const quotaError = new Error('used 8000 of its 8000 requests for today');
    quotaError.name = 'DailyQuotaError';
    expect(classifyFailure(quotaError)).toBe('quota');
  });
});

// ---------------------------------------------------------------------------
// Pausing, for both reasons there are
// ---------------------------------------------------------------------------

interface PauseSeen {
  reason: PauseReason;
  resumesAt: string | undefined;
  detail: string | undefined;
}

/** A queue whose pauses and resumes are recorded rather than inferred. */
function watchedQueue(
  options: {
    schedule?: Schedule;
    onUpload?: (filePath: string, call: number) => void;
    now?: () => number;
  } = {},
): {
  queue: UploadQueue;
  uploads: string[];
  entries: Map<string, LedgerEntry>;
  paused: PauseSeen[];
  resumed: Array<{ reason: PauseReason; waiting: number }>;
  lines: string[];
} {
  const { ledger, entries } = fakeLedger();
  const base = fakeClient();
  const uploads: string[] = [];
  const paused: PauseSeen[] = [];
  const resumed: Array<{ reason: PauseReason; waiting: number }> = [];
  const sink = recordingLogger();
  let calls = 0;

  const client = {
    async uploadFile(filePath: string): Promise<string> {
      calls += 1;
      options.onUpload?.(filePath, calls);
      uploads.push(filePath);
      return base.client.uploadFile(filePath);
    },
    batchCreate: base.client.batchCreate,
  };

  const queue = new UploadQueue({
    ledger,
    client,
    hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
    log: sink.log,
    sleep: noSleep,
    onPaused: (reason, resumesAt, detail) => paused.push({ reason, resumesAt, detail }),
    onResumed: (reason, waiting) => resumed.push({ reason, waiting }),
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return { queue, uploads, entries, paused, resumed, lines: sink.lines };
}

describe('UploadQueue pause', () => {
  it('holds everything offered while paused, and sends it on resume', async () => {
    const test = watchedQueue();

    test.queue.pause();
    test.queue.offer(candidate('a.jpg'));
    test.queue.offer(candidate('b.jpg'));
    await test.queue.drain();

    // Nothing read, nothing hashed, nothing sent: a paused queue is not a queue
    // that works quietly, it is a queue that does not work.
    expect(test.uploads).toHaveLength(0);
    expect(test.queue.deferredCount).toBe(2);
    expect(test.queue.isPaused).toBe(true);
    expect(test.queue.totals.seen).toBe(0);

    expect(test.queue.resume()).toBe('resumed');
    await test.queue.drain();

    expect(test.uploads).toHaveLength(2);
    expect(test.entries.size).toBe(2);
    expect(test.queue.deferredCount).toBe(0);
  });

  it('says which hold went on, explicitly, instead of leaving it to be inferred', () => {
    const test = watchedQueue();

    test.queue.pause();

    expect(test.paused).toEqual([{ reason: 'user', resumesAt: undefined, detail: undefined }]);
  });

  it('announces a quota hold with the moment it lifts and the sentence that explains it', async () => {
    const timers = manualSchedule();
    const quotaError = new Error(
      'photo-pigeon has used 9000 of its 9000 metered Google Photos calls for today (2026-07-28).',
    );
    quotaError.name = 'DailyQuotaError';
    const at = Date.parse('2026-07-28T09:00:00.000Z');
    const test = watchedQueue({
      schedule: timers.schedule,
      now: () => at,
      onUpload: (_path, call) => {
        if (call === 2) throw quotaError;
      },
    });

    test.queue.offer(candidate('a.jpg'));
    test.queue.offer(candidate('b.jpg'));
    await test.queue.drain();

    expect(test.paused).toHaveLength(1);
    const hold = test.paused[0];
    expect(hold?.reason).toBe('quota');
    // A real moment, not a shape a caller had to guess from a timer's length.
    expect(Date.parse(hold?.resumesAt ?? '')).toBeGreaterThan(at);
    expect(hold?.detail).toContain('9000');

    timers.fireAll();
    await test.queue.drain();

    expect(test.resumed).toEqual([{ reason: 'quota', waiting: 1 }]);
  });

  it('will not let a menu click un-spend the day request budget', async () => {
    const timers = manualSchedule();
    const quotaError = new Error('photo-pigeon has used 9000 of its 9000 calls for today.');
    quotaError.name = 'DailyQuotaError';
    const test = watchedQueue({
      schedule: timers.schedule,
      onUpload: (_path, call) => {
        if (call === 2) throw quotaError;
      },
    });

    test.queue.offer(candidate('a.jpg'));
    test.queue.offer(candidate('b.jpg'));
    await test.queue.drain();
    // The user pauses on top of the budget being spent, then changes their mind.
    test.queue.pause();
    expect(test.queue.pausedFor).toEqual(['quota', 'user']);

    expect(test.queue.resume()).toBe('still-held');
    await test.queue.drain();

    // Nothing moved, which is the whole point: a menu click cannot un-spend a
    // spent budget.
    expect(test.uploads).toEqual(['/photos/a.jpg']);
    expect(test.queue.pausedFor).toEqual(['quota']);
    // And it was said out loud, which is the M3 review's first critical. The
    // user's hold really did lift, it released nothing, and a listener that
    // hears nothing here has no way back: silence is how a tray decides the
    // core never understood the word, and it then shows a paused menu over an
    // engine that is only waiting for midnight.
    expect(test.resumed).toEqual([{ reason: 'user', waiting: 0 }]);

    // The day rolls over and now it really does run again.
    timers.fireAll();
    await test.queue.drain();

    expect(test.uploads).toEqual(['/photos/a.jpg', '/photos/b.jpg']);
    expect(test.resumed).toEqual([
      { reason: 'user', waiting: 0 },
      { reason: 'quota', waiting: 1 },
    ]);
  });

  it('says the budget came back even when a pause somebody asked for outlives it', async () => {
    // The mirror of the test above, and the other half of the same critical.
    // Two holds, and the one that lifts at midnight is not the one the user
    // owns, so the queue stays held and nothing flows. It is still a state
    // change worth exactly one sentence: "Google limit reached, back at 00:00"
    // has no other clearing condition, and midnight is when it stops being
    // true. A queue that only spoke on the way back to running would leave that
    // line up until something else happened to knock it off.
    const timers = manualSchedule();
    const quotaError = new Error('photo-pigeon has used 9000 of its 9000 calls for today.');
    quotaError.name = 'DailyQuotaError';
    const test = watchedQueue({
      schedule: timers.schedule,
      onUpload: (_path, call) => {
        if (call === 2) throw quotaError;
      },
    });

    test.queue.offer(candidate('a.jpg'));
    test.queue.offer(candidate('b.jpg'));
    await test.queue.drain();
    test.queue.pause();
    expect(test.queue.pausedFor).toEqual(['quota', 'user']);

    timers.fireAll();
    await test.queue.drain();

    expect(test.resumed).toEqual([{ reason: 'quota', waiting: 0 }]);
    expect(test.queue.pausedFor).toEqual(['user']);
    expect(test.uploads).toEqual(['/photos/a.jpg']);

    // And the user's own resume is the one that moves the files.
    expect(test.queue.resume()).toBe('resumed');
    await test.queue.drain();
    expect(test.uploads).toEqual(['/photos/a.jpg', '/photos/b.jpg']);
    expect(test.resumed).toEqual([
      { reason: 'quota', waiting: 0 },
      { reason: 'user', waiting: 1 },
    ]);
  });

  it('lifts nothing on a resume nobody asked for', () => {
    const test = watchedQueue();

    expect(test.queue.resume()).toBe('not-paused');
    expect(test.resumed).toHaveLength(0);
  });

  it('pauses once however many times it is asked', () => {
    const test = watchedQueue();

    test.queue.pause();
    test.queue.pause();
    test.queue.pause();

    expect(test.paused).toHaveLength(1);
  });

  it('keeps taking files in while paused, which is the whole point of it', async () => {
    // The tray's first Pause stopped the core and its Resume started a new one,
    // and a new one re-walks and re-hashes every watched folder. On a large
    // library that is the entire library read to learn nothing. Pausing here
    // costs one set entry, and every file that landed meanwhile is already in
    // hand when it lifts.
    const test = watchedQueue();

    test.queue.pause();
    test.queue.offer(candidate('a.jpg'));
    expect(test.queue.isAccepting).toBe(true);

    test.queue.resume();
    await test.queue.drain();

    expect(test.uploads).toEqual(['/photos/a.jpg']);
  });
});

// ---------------------------------------------------------------------------
// Size ceilings, decided by mime.ts and nowhere else
// ---------------------------------------------------------------------------

describe('sizeLimitFor', () => {
  it('gives photos the 200 MB ceiling', () => {
    for (const name of ['a.jpg', 'a.HEIC', 'a.dng', 'a.png']) {
      expect(sizeLimitFor(`/photos/${name}`)).toBe(API_LIMITS.MAX_PHOTO_BYTES);
    }
  });

  it('gives every video mime.ts knows the 20 GB ceiling, not just the popular ones', () => {
    // .tod, .asf and .3g2 are camcorder formats that the queue used to miss,
    // because it kept its own shorter list. A 4 GB .tod was refused locally as
    // if it were a photo.
    for (const name of ['a.mp4', 'a.mov', 'a.tod', 'a.asf', 'a.3g2', 'a.m2t', 'a.mmv']) {
      expect(sizeLimitFor(`/photos/${name}`)).toBe(API_LIMITS.MAX_VIDEO_BYTES);
    }
  });

  it('is generous with an extension nobody recognises and lets Google decide', () => {
    expect(sizeLimitFor('/photos/mystery.xyz')).toBe(API_LIMITS.MAX_VIDEO_BYTES);
  });

  it('takes a big video that used to be refused before it was ever sent', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('holiday.tod', 4 * 1024 * 1024 * 1024));
    await queue.drain();

    expect(remote.uploads).toEqual(['/photos/holiday.tod']);
    expect(queue.totals.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Honest request counts
// ---------------------------------------------------------------------------

describe('UploadQueue request counting', () => {
  /** A client that reports what its transport really issued, the way the real one does. */
  function countingClient(perUpload: number, perBatch: number): {
    client: FakeClient['client'] & { requestsIssued: () => number };
    issued: () => number;
  } {
    const base = fakeClient();
    let issued = 0;
    return {
      issued: () => issued,
      client: {
        async uploadFile(filePath: string): Promise<string> {
          issued += perUpload;
          return base.client.uploadFile(filePath);
        },
        async batchCreate(
          items: BatchCreateItem[],
          albumId?: string,
        ): Promise<BatchCreateOutcome[]> {
          issued += perBatch;
          return base.client.batchCreate(items, albumId);
        },
        requestsIssued: () => issued,
      },
    };
  }

  it('counts the chunks a big file really took, not one per call', async () => {
    const { ledger } = fakeLedger();
    // One start plus twenty-five chunks is what the probe measured for 25 MB.
    const remote = countingClient(26, 1);
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('big.mp4', 26 * 1024 * 1024));
    await queue.drain();

    expect(queue.totals.requests).toBe(27);
    expect(queue.totals.requests).toBe(remote.issued());
  });

  it('books the requests a failed call burned instead of pretending it cost one', async () => {
    const { ledger } = fakeLedger();
    let issued = 0;
    const client = {
      async uploadFile(): Promise<string> {
        // Three attempts inside the transport, then it gives up.
        issued += 3;
        throw new Error('socket hang up');
      },
      batchCreate: fakeClient().client.batchCreate,
      requestsIssued: () => issued,
    };
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
      maxAttempts: 2,
    });

    queue.offer(candidate('unlucky.jpg'));
    await queue.drain();

    expect(queue.totals.failed).toBe(1);
    expect(queue.totals.requests).toBe(6);
  });

  it('falls back to one per call when the client does not count, and says so by staying low', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(queue.totals.requests).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Timers, and being able to leave
// ---------------------------------------------------------------------------

describe('UploadQueue timers', () => {
  /** Fills the queue, hits the day's budget on the second file, and pauses. */
  async function pausedQueue(timers: ReturnType<typeof manualSchedule>): Promise<UploadQueue> {
    const { ledger } = fakeLedger();
    const base = fakeClient();
    const quotaError = new Error(
      'photo-pigeon has used 9000 of its 9000 metered Google Photos calls for today (2026-07-28).',
    );
    quotaError.name = 'DailyQuotaError';
    let calls = 0;
    const client = {
      async uploadFile(filePath: string): Promise<string> {
        calls += 1;
        if (calls === 2) throw quotaError;
        return base.client.uploadFile(filePath);
      },
      batchCreate: base.client.batchCreate,
    };
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    await queue.drain();
    return queue;
  }

  it('does not let the wait for midnight hold the process open', async () => {
    const timers = manualSchedule();
    await pausedQueue(timers);

    // One timer left after the drain: the one waiting for the day to roll over.
    // Hours away, and nothing in the process should be kept awake for it.
    const armed = timers.armed();
    expect(armed).toHaveLength(1);
    expect(armed[0]?.options?.unref).toBe(true);
    expect(armed[0]?.ms).toBeGreaterThan(60_000);
  });

  it('drops the midnight timer when the queue is disposed', async () => {
    const timers = manualSchedule();
    const queue = await pausedQueue(timers);

    expect(timers.armedCount()).toBe(1);
    queue.dispose();
    expect(timers.armedCount()).toBe(0);

    // And firing what is left changes nothing: the deferred file stays deferred
    // and is picked up by the next startup scan, which is the promise made.
    timers.fireAll();
    expect(queue.deferredCount).toBe(1);
  });

  it('can be disposed twice, and disposing an idle queue is a no-op', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const timers = manualSchedule();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(() => {
      queue.dispose();
      queue.dispose();
    }).not.toThrow();
    expect(timers.armedCount()).toBe(0);
  });

  it('leaves nothing armed once the day has rolled over on its own', async () => {
    const timers = manualSchedule();
    const queue = await pausedQueue(timers);

    timers.fireAll();
    await queue.drain();

    expect(timers.armedCount()).toBe(0);
    expect(queue.deferredCount).toBe(0);
  });

  it('holds a part full batch on a timer that is allowed to keep the process awake', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const timers = manualSchedule();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.whenIdle();

    // Ten seconds, and there are uploaded tokens waiting on it. Leaving early
    // would throw away bytes that are already at Google.
    const armed = timers.armed();
    expect(armed).toHaveLength(1);
    expect(armed[0]?.options?.unref).toBeUndefined();

    await queue.drain();
    expect(timers.armedCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Backoff policy
// ---------------------------------------------------------------------------

describe('failure classification and backoff', () => {
  it('never waits less than 30 seconds after a rate limit', () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(backoffMs('rate-limit', attempt, () => 0)).toBeGreaterThanOrEqual(
        API_LIMITS.MIN_BACKOFF_MS,
      );
    }
    expect(backoffMs('rate-limit', 1, () => 0)).toBe(API_LIMITS.MIN_BACKOFF_MS);
    expect(backoffMs('rate-limit', 2, () => 0)).toBe(API_LIMITS.MIN_BACKOFF_MS * 2);
    expect(backoffMs('rate-limit', 3, () => 1)).toBeGreaterThan(API_LIMITS.MIN_BACKOFF_MS * 4);
  });

  it('reads 429 and the concurrent write error as rate limits', () => {
    expect(classifyFailure({ status: 429 })).toBe('rate-limit');
    expect(classifyFailure(new Error('RESOURCE_EXHAUSTED'))).toBe('rate-limit');
    expect(classifyFailure(new Error('concurrent write request'))).toBe('rate-limit');
  });

  it('treats a full Google account as permanent, not as something to retry', () => {
    expect(classifyFailure(new Error('The user storage quota is full'))).toBe('permanent');
  });

  it('retries server errors and gives up on client errors', () => {
    expect(classifyFailure({ status: 503 })).toBe('transient');
    expect(classifyFailure({ status: 400 })).toBe('permanent');
    expect(classifyFailure(new Error('socket hang up'))).toBe('transient');
  });
});

// ---------------------------------------------------------------------------
// The hash the queue already has
// ---------------------------------------------------------------------------

describe('UploadQueue and the content hash', () => {
  it('hands the uploader the hash it just computed, so the file is not read twice', async () => {
    const { ledger } = fakeLedger();
    const base = fakeClient();
    const handed: Array<string | undefined> = [];
    const client = {
      async uploadFile(filePath: string, contentHash?: string): Promise<string> {
        handed.push(contentHash);
        return base.client.uploadFile(filePath);
      },
      batchCreate: base.client.batchCreate,
    };
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    // The same digest the ledger keys on. A transport that has to work this out
    // for itself streams the whole file again before a byte goes up, on every
    // attempt, on exactly the large files where that is expensive.
    expect(handed).toEqual(['hash-a.jpg']);
  });
});

// ---------------------------------------------------------------------------
// The day's budget runs out while filing
// ---------------------------------------------------------------------------

describe('UploadQueue when filing hits the daily budget', () => {
  /** The refusal the limiter raises once the day's metered calls are gone. */
  function quotaError(): Error {
    const error = new Error(
      'photo-pigeon has used 9000 of its 9000 metered Google Photos calls for today (2026-07-28).',
    );
    error.name = 'DailyQuotaError';
    return error;
  }

  it('holds the batch for the next run instead of failing it, and does not nap at the wall', async () => {
    const { ledger, entries } = fakeLedger();
    const base = fakeClient();
    const sleeps: number[] = [];
    let batchCalls = 0;
    const client = {
      uploadFile: base.client.uploadFile,
      async batchCreate(): Promise<BatchCreateOutcome[]> {
        batchCalls += 1;
        throw quotaError();
      },
    };
    const timers = manualSchedule();
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    await queue.drain();

    // Filing is the only thing that spends the budget, so a second attempt is a
    // thirty second nap against a wall that cannot move before midnight.
    expect(batchCalls).toBe(1);
    expect(sleeps).toEqual([]);
    // Held, not failed: the summary owes the user "left for the next run".
    expect(queue.totals.failed).toBe(0);
    expect(queue.totals.deferred).toBe(2);
    expect(queue.deferredCount).toBe(2);
    expect(entries.size).toBe(0);

    // And the queue is paused, waiting for the day to roll over on a timer that
    // is not allowed to hold the process open.
    const armed = timers.armed();
    expect(armed).toHaveLength(1);
    expect(armed[0]?.options?.unref).toBe(true);
  });

  it('sends the held files again once the day has rolled over', async () => {
    const { ledger, entries } = fakeLedger();
    const base = fakeClient();
    let spent = true;
    const client = {
      uploadFile: base.client.uploadFile,
      async batchCreate(
        items: BatchCreateItem[],
        albumId?: string,
      ): Promise<BatchCreateOutcome[]> {
        if (spent) {
          spent = false;
          throw quotaError();
        }
        return base.client.batchCreate(items, albumId);
      },
    };
    const timers = manualSchedule();
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: timers.schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();
    expect(queue.deferredCount).toBe(1);

    timers.fireAll();
    await queue.drain();

    // A fresh upload and a fresh token: the one from yesterday was never filed.
    expect(base.uploads).toEqual(['/photos/a.jpg', '/photos/a.jpg']);
    expect(entries.size).toBe(1);
    expect(queue.totals.delivered).toBe(1);
    expect(queue.totals.deferred).toBe(0);
    expect(queue.totals.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Leaving now, and meaning it
// ---------------------------------------------------------------------------

describe('UploadQueue leaveNow', () => {
  it('stops climbing the upload ladder, so no nap is left holding the process', async () => {
    const { ledger } = fakeLedger();
    const base = fakeClient();
    const sleeps: number[] = [];
    let attempts = 0;
    const client = {
      async uploadFile(): Promise<string> {
        attempts += 1;
        throw new Error('socket hang up');
      },
      batchCreate: base.client.batchCreate,
    };
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    queue.leaveNow();
    queue.offer(candidate('a.jpg'));
    await queue.drain();

    // One attempt and no nap. Four attempts with three waits is the ordinary
    // ladder, and every one of those waits is a timer Node will not exit on.
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(queue.totals.failed).toBe(0);
    expect(queue.totals.deferred).toBe(1);
  });

  it('hands a rate limited batch to the next run rather than waiting it out', async () => {
    const { ledger } = fakeLedger();
    const base = fakeClient();
    const sleeps: number[] = [];
    let batchCalls = 0;
    const client = {
      uploadFile: base.client.uploadFile,
      async batchCreate(): Promise<BatchCreateOutcome[]> {
        batchCalls += 1;
        throw new Error('429 too many requests');
      },
    };
    const queue = new UploadQueue({
      ledger,
      client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    queue.offer(candidate('a.jpg'));
    await queue.whenIdle();
    queue.leaveNow();
    await queue.drain();

    expect(batchCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(queue.totals.failed).toBe(0);
    expect(queue.totals.deferred).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The rehash side index
//
// The problem these cover is start-at-login: every start reconciles, and
// without a cache every start reads the whole library to be told nothing
// changed. A 100 GB shelf opened six times a day is 600 GB of reading.
//
// These use real files in a temp directory on purpose. "The file was never
// opened" is a claim about a disk, so the hasher here counts the bytes it
// actually pulls off one. Nothing touches the real config or the real Desktop.
// ---------------------------------------------------------------------------

interface CountingHasher {
  hashFile(filePath: string): Promise<string>;
  bytesRead(): number;
  calls(): string[];
  reset(): void;
}

/**
 * The real streaming sha256, with a tape measure on it.
 *
 * Byte for byte what src/state/hash.ts does, so the digests agree and the
 * ledger cannot tell the two apart. The only addition is the counter, which is
 * what turns "it used the cache" from a claim into a measurement.
 */
function countingHasher(): CountingHasher {
  let bytes = 0;
  let seen: string[] = [];
  return {
    bytesRead: () => bytes,
    calls: () => seen,
    reset: () => {
      bytes = 0;
      seen = [];
    },
    hashFile: async (filePath: string): Promise<string> => {
      seen.push(path.basename(filePath));
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(filePath)) {
        bytes += (chunk as Buffer).length;
        digest.update(chunk as Buffer);
      }
      return digest.digest('hex');
    },
  };
}

describe('UploadQueue with a rehash side index', () => {
  let dir: string;
  let indexPath: string;
  let hasher: CountingHasher;
  let ledger: Ledger;
  let entries: Map<string, LedgerEntry>;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(tmpdir(), 'pigeon-rehash-'));
    indexPath = path.join(dir, SIDE_INDEX_FILE_NAME);
    hasher = countingHasher();
    ({ ledger, entries } = fakeLedger());
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const statCandidate = async (filePath: string): Promise<FileCandidate> => {
    const info = await fsp.stat(filePath);
    return { path: filePath, size: info.size, mtimeMs: info.mtimeMs };
  };

  /** A real file on a real disk, and the candidate the walk would hand over for it. */
  const writePhoto = async (name: string, body: string): Promise<FileCandidate> => {
    const filePath = path.join(dir, name);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, body);
    return statCandidate(filePath);
  };

  /** Everything the startup walk would find, the cache file itself excluded. */
  const walk = async (root: string = dir): Promise<FileCandidate[]> => {
    const found: FileCandidate[] = [];
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        found.push(...(await walk(full)));
        continue;
      }
      if (entry.name === SIDE_INDEX_FILE_NAME) continue;
      found.push(await statCandidate(full));
    }
    return found.sort((a, b) => (a.path < b.path ? -1 : 1));
  };

  /** One whole run of photo-pigeon: open the cache, offer everything, drain, close. */
  const session = async (
    candidates: FileCandidate[],
  ): Promise<{ queue: UploadQueue; remote: FakeClient; index: SideIndex }> => {
    const index = await openSideIndex(indexPath, {});
    const remote = fakeClient();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: (filePath) => hasher.hashFile(filePath),
      sideIndex: index,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });
    for (const item of candidates) queue.offer(item);
    await queue.drain();
    await index.close();
    return { queue, remote, index };
  };

  it('reads nothing at all on a second pass over an unchanged tree', async () => {
    await writePhoto('a.jpg', 'a'.repeat(2048));
    await writePhoto('b.jpg', 'b'.repeat(4096));
    await writePhoto('c.jpg', 'c'.repeat(1024));

    const first = await session(await walk());
    expect(first.queue.totals.delivered).toBe(3);
    expect(hasher.bytesRead()).toBe(2048 + 4096 + 1024);

    hasher.reset();
    const second = await session(await walk());

    // The whole point of the feature, in two lines.
    expect(hasher.calls()).toEqual([]);
    expect(hasher.bytesRead()).toBe(0);

    // And the answer is still right: the ledger recognised all three.
    expect(second.queue.totals.skipped).toBe(3);
    expect(second.remote.uploads).toEqual([]);
    expect(second.index.stats.hits).toBe(3);
    expect(second.index.stats.bytesNotRead).toBe(2048 + 4096 + 1024);
  });

  it('really rehashes a file whose mtime moved', async () => {
    const photo = await writePhoto('a.jpg', 'a'.repeat(2048));
    await writePhoto('b.jpg', 'b'.repeat(4096));
    await session(await walk());

    // Same bytes, same size, later clock. The cache must not trust its old
    // answer just because the length happens to match.
    const later = photo.mtimeMs + 10_000;
    await fsp.utimes(photo.path, new Date(later), new Date(later));

    hasher.reset();
    const second = await session(await walk());

    expect(hasher.calls()).toEqual(['a.jpg']);
    expect(hasher.bytesRead()).toBe(2048);
    // The bytes did not actually change, so the hash matches and the ledger
    // still refuses to send it twice. A rehash costs a read, never a duplicate.
    expect(second.queue.totals.skipped).toBe(2);
    expect(second.remote.uploads).toEqual([]);
  });

  it('really rehashes a file whose size changed even when the mtime did not', async () => {
    const photo = await writePhoto('a.jpg', 'a'.repeat(2048));
    await writePhoto('b.jpg', 'b'.repeat(4096));

    // Pin the mtime to a whole millisecond before the first run. NTFS keeps
    // sub-millisecond ticks and utimes cannot set them, so a fresh file's mtime
    // cannot be restored exactly afterwards. Starting from a value utimes can
    // reproduce is what lets this test hold mtime still and move size alone.
    const pinned = 1_700_000_000_000;
    await fsp.utimes(photo.path, new Date(pinned), new Date(pinned));

    await session(await walk());
    expect(entries.size).toBe(2);

    // Grow the file, then put the old mtime back, so size is the only signal
    // left. Anything that checked mtime alone would sail straight past this.
    await fsp.appendFile(photo.path, 'a'.repeat(512));
    await fsp.utimes(photo.path, new Date(pinned), new Date(pinned));
    const changed = await statCandidate(photo.path);
    expect(changed.size).toBe(2560);
    expect(changed.mtimeMs).toBe(pinned);

    hasher.reset();
    const second = await session(await walk());

    expect(hasher.calls()).toEqual(['a.jpg']);
    expect(hasher.bytesRead()).toBe(2560);
    // Different bytes, so a genuinely new hash and a real delivery.
    expect(second.queue.totals.delivered).toBe(1);
    expect(entries.size).toBe(3);
  });

  it('rebuilds silently when the cache file is corrupt, and costs only a re-read', async () => {
    await writePhoto('a.jpg', 'a'.repeat(2048));
    await writePhoto('b.jpg', 'b'.repeat(4096));
    await session(await walk());

    await fsp.writeFile(indexPath, 'not json, not even close\n binary spew\n');

    hasher.reset();
    const second = await session(await walk());

    // Everything was read again, nothing was lost, nothing was uploaded twice.
    expect(hasher.calls()).toEqual(['a.jpg', 'b.jpg']);
    expect(hasher.bytesRead()).toBe(2048 + 4096);
    expect(second.queue.totals.skipped).toBe(2);
    expect(second.remote.uploads).toEqual([]);
    expect(entries.size).toBe(2);

    // And it healed itself on the way out: the next start is fast again.
    hasher.reset();
    await session(await walk());
    expect(hasher.bytesRead()).toBe(0);
  });

  it('rehashes a moved file, and the ledger still refuses to send it twice', async () => {
    const photo = await writePhoto('a.jpg', 'a'.repeat(2048));
    await writePhoto('b.jpg', 'b'.repeat(4096));
    const first = await session(await walk());
    expect(first.queue.totals.delivered).toBe(2);

    // Same bytes, new path. This is the case the content ledger exists for, and
    // the cache must not get in its way: a new path has no cache entry, so the
    // file is read, and the hash it produces is the one the ledger already has.
    const moved = path.join(dir, 'sorted', 'a.jpg');
    await fsp.mkdir(path.dirname(moved), { recursive: true });
    await fsp.rename(photo.path, moved);

    hasher.reset();
    const second = await session(await walk());

    expect(hasher.calls()).toEqual(['a.jpg']);
    expect(hasher.bytesRead()).toBe(2048);
    expect(second.queue.totals.skipped).toBe(2);
    expect(second.remote.uploads).toEqual([]);
    expect(entries.size).toBe(2);

    // The new path is remembered too, so the move is paid for exactly once.
    hasher.reset();
    await session(await walk());
    expect(hasher.bytesRead()).toBe(0);
  });

  it('writes the cache once for a whole run, not once per file', async () => {
    for (let n = 0; n < 40; n += 1) await writePhoto(`photo-${n}.jpg`, 'x'.repeat(64));

    await session(await walk());

    const text = await fsp.readFile(indexPath, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(41);
  });
});

// ---------------------------------------------------------------------------
// The cache shortens the road to the hash. It never stands in for the ledger.
// ---------------------------------------------------------------------------

describe('UploadQueue side index safety', () => {
  /** A cache that answers whatever it is told to, so the queue can be cornered. */
  function fakeCache(seed: Record<string, string> = {}): {
    cache: HashCache;
    remembered: Array<{ path: string; hash: string }>;
    flushes(): number;
  } {
    const known = new Map(Object.entries(seed));
    const remembered: Array<{ path: string; hash: string }> = [];
    let flushed = 0;
    return {
      remembered,
      flushes: () => flushed,
      cache: {
        lookup: (item) => known.get(path.basename(item.path)),
        remember: (item, hash) => {
          remembered.push({ path: item.path, hash });
          known.set(path.basename(item.path), hash);
        },
        flush: async () => {
          flushed += 1;
        },
      },
    };
  }

  const mustNotRead = async (): Promise<string> => {
    throw new Error('the file must not be read when the cache already knows it');
  };

  it('uploads a cached file the ledger has never heard of', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const { cache } = fakeCache({ 'a.jpg': 'hash-a.jpg' });
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: mustNotRead,
      sideIndex: cache,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    // Recognised by the cache, unknown to the ledger, therefore delivered. A
    // cache hit is an identity, never a receipt.
    expect(remote.uploads).toEqual(['/photos/a.jpg']);
    expect(queue.totals.delivered).toBe(1);
  });

  it('still lets the ledger skip a cached file it has already delivered', async () => {
    const { ledger } = fakeLedger([
      {
        hash: 'hash-a.jpg',
        size: 1024,
        bytes: 1024,
        firstPath: '/photos/a.jpg',
        uploadedAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
    const remote = fakeClient();
    const { cache } = fakeCache({ 'a.jpg': 'hash-a.jpg' });
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: mustNotRead,
      sideIndex: cache,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(remote.uploads).toEqual([]);
    expect(queue.totals.skipped).toBe(1);
  });

  it('only ever remembers a hash it computed from the bytes', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const { cache, remembered } = fakeCache({ 'a.jpg': 'hash-a.jpg' });
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      sideIndex: cache,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    // a.jpg is already known to the cache, b.jpg is not.
    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    await queue.drain();

    expect(remembered).toEqual([{ path: '/photos/b.jpg', hash: 'hash-b.jpg' }]);
  });

  it('does not remember anything when the file could not be read', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const { cache, remembered } = fakeCache();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async () => {
        throw new Error('EACCES: permission denied');
      },
      sideIndex: cache,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(remembered).toEqual([]);
    expect(queue.totals.failed).toBe(1);
  });

  it('writes the cache down when the run drains', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const { cache, flushes } = fakeCache();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      sideIndex: cache,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    await queue.drain();

    expect(flushes()).toBe(1);
  });

  it('tries to write the cache even when the user says leave now', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const { cache, flushes } = fakeCache();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      sideIndex: cache,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.leaveNow();

    expect(flushes()).toBe(1);
  });

  it('behaves exactly as before when there is no cache at all', async () => {
    const { ledger } = fakeLedger();
    const remote = fakeClient();
    const queue = new UploadQueue({
      ledger,
      client: remote.client,
      hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
      log: recordingLogger().log,
      schedule: manualSchedule().schedule,
      sleep: noSleep,
    });

    queue.offer(candidate('a.jpg'));
    queue.offer(candidate('b.jpg'));
    await queue.drain();

    expect(remote.uploads).toEqual(['/photos/a.jpg', '/photos/b.jpg']);
    expect(queue.totals.delivered).toBe(2);
  });
});
