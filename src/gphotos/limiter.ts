/**
 * The daily call budget, and the pace that keeps 429s away.
 *
 * These are two different things. They used to be one number, which was wrong.
 *
 *  1. The budget. Google gives each Cloud project 10,000 Library API calls a
 *     day and there is no way to ask for more. The live probe of 28-Jul-2026
 *     (run 439e3afb) settled which calls are actually charged: that run issued
 *     54 HTTP requests, 51 of them uploads and resumable chunks, and the
 *     console metrics page counted 3. The three were the batchCreate calls.
 *     Sending bytes is not metered, filing them is. So this file counts metered
 *     calls only, and since one batchCreate files up to 50 photos, a
 *     self-imposed 9,000 a day is roughly 450,000 photos rather than 9,000.
 *
 *  2. The pace. Nothing to do with quota, entirely empirical: the API starts
 *     answering "concurrent write request" 429s after a few minutes of
 *     sustained uploading, and a 429 costs thirty seconds minimum. So every
 *     outgoing request, metered or not, passes through a small token bucket.
 *
 * The counter also tallies bytes sent, which is the number the status command
 * shows: API uploads are original quality and eat the user's own Google
 * storage, so the tool owes them an honest running total.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { API_LIMITS } from '../contracts.js';
import { type Logger, silentLogger } from './log.js';

/**
 * Metered calls the tool allows itself per day, comfortably under Google's
 * 10,000. One metered call files up to 50 photos, so this is a ceiling of
 * roughly 450,000 photos a day, not 9,000.
 */
export const SELF_IMPOSED_DAILY_REQUESTS = 9_000;

/** Fraction of the self-imposed budget that triggers a heads-up. */
const WARN_AT = 0.9;

/**
 * Burst size for the concurrent-write guard.
 *
 * Not a quota device. It exists because sustained parallel writes are what earn
 * the "concurrent write request" 429, so a handful of requests may go out back
 * to back and then the pacing takes over.
 */
const DEFAULT_BURST_CAPACITY = 5;

/** Steady pace for the concurrent-write guard, in requests per second. */
const DEFAULT_REQUESTS_PER_SECOND = 2;

/**
 * Unmetered requests to let by before the counter file is rewritten.
 *
 * The metered count is written the moment it changes, because it governs
 * whether the tool is allowed to keep working and it has to survive a crash.
 * The unmetered count is a readout and nothing else, and a 20 GB video is
 * thousands of chunk requests, so it reaches disk in batches instead.
 */
const UNMETERED_PERSIST_EVERY = 50;

/** What the status and doctor commands print. */
export interface UsageSnapshot {
  /** Local calendar day the counters belong to, as YYYY-MM-DD. */
  day: string;
  /**
   * Metered calls today: the ones the daily budget counts, which means
   * batchCreate and album creation. Same number as meteredCalls, kept under the
   * old name so existing readers stay correct.
   */
  requests: number;
  /** Metered calls today, under the honest name. */
  meteredCalls: number;
  /** Upload and chunk requests today. Real HTTP, real bytes, but not charged against the budget. */
  unmeteredRequests: number;
  /** Everything sent today, metered and unmetered together. */
  totalRequests: number;
  /** Metered calls left in the self-imposed budget today. */
  remaining: number;
  /** The self-imposed budget itself, in metered calls. */
  ceiling: number;
  /** Bytes this tool has sent since the counter file was created. */
  bytesUploaded: number;
  /** Bytes sent today. */
  bytesToday: number;
}

/** How one request should be booked. */
export interface AcquireOptions {
  /**
   * True when this request counts against the project's daily budget. Defaults
   * to true, so a call that forgets to say is counted rather than hidden.
   *
   * Only batchCreate and album creation are metered. Uploads and resumable
   * chunks pass through the pacing but leave the budget alone, which the probe
   * of 28-Jul-2026 confirmed against the console metrics page.
   */
  metered?: boolean;
}

/** Paces outgoing requests and keeps the durable daily count. */
export interface RateLimiter {
  /**
   * Waits for a pacing slot, books the request, and throws once the day's
   * metered budget is gone.
   *
   * The refusal covers unmetered requests too, on purpose. With no budget left
   * to file anything, more uploaded bytes would only become tokens that expire
   * unused in 24 hours.
   */
  acquire(options?: AcquireOptions): Promise<void>;
  /** Records bytes actually put on the wire for one file. */
  recordBytes(bytes: number): Promise<void>;
  /** Current counters, for status and doctor. */
  usage(): UsageSnapshot;
  /** Where the counters live on disk. */
  readonly counterPath: string;
}

/** Thrown instead of spending the last of the day's budget. */
export class DailyQuotaError extends Error {
  readonly usage: UsageSnapshot;

  constructor(usage: UsageSnapshot) {
    super(
      [
        `photo-pigeon has used ${usage.requests} of its ${usage.ceiling} metered Google Photos calls for today (${usage.day}).`,
        'Sending the bytes is free. Only filing them into your library is counted, in batches of up to fifty at a time.',
        'Your Google Cloud project allows 10,000 of those a day and the tool stops short of that on purpose,',
        'so filing does not start failing halfway through a batch.',
        'Everything still waiting is safe on disk and in the queue. Try again after midnight, local time.',
      ].join('\n'),
    );
    this.name = 'DailyQuotaError';
    this.usage = usage;
  }
}

/** Shape of the counter file. Small on purpose: it is rewritten constantly. */
interface CounterFile {
  day: string;
  /** Metered calls today. A file written by an older build counted everything here, which only ever over-counts. */
  requests: number;
  /** Upload and chunk requests today. */
  unmetered: number;
  bytesToday: number;
  bytesTotal: number;
}

/** Knobs, all optional. Tests inject clocks and sleeps, real runs take the defaults. */
export interface LimiterOptions {
  /** Where to keep the counters. Defaults to a file beside the token. */
  counterPath: string;
  /** Self-imposed daily budget, in metered calls. */
  ceiling?: number;
  /** Burst size for the concurrent-write guard. */
  capacity?: number;
  /** Steady pace for the concurrent-write guard, in requests per second. */
  refillPerSecond?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/** The counter file sits next to the token, so wiping one account wipes both. */
export function counterPathFor(tokenPath: string): string {
  return join(dirname(tokenPath), 'quota.json');
}

/** Local calendar day as YYYY-MM-DD. Google resets quota on Pacific time, we reset on the user's. */
export function dayKey(at: number): string {
  const d = new Date(at);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function emptyCounters(day: string, bytesTotal = 0): CounterFile {
  return { day, requests: 0, unmetered: 0, bytesToday: 0, bytesTotal };
}

async function loadCounters(counterPath: string, day: string): Promise<CounterFile> {
  try {
    const raw = await readFile(counterPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CounterFile>;
    const bytesTotal = Number(parsed.bytesTotal) || 0;
    if (parsed.day !== day) return emptyCounters(day, bytesTotal);
    return {
      day,
      requests: Number(parsed.requests) || 0,
      unmetered: Number(parsed.unmetered) || 0,
      bytesToday: Number(parsed.bytesToday) || 0,
      bytesTotal,
    };
  } catch {
    // No file, unreadable file, or corrupt JSON. Starting from zero is the safe
    // reading: it can only make the tool more cautious than it needs to be.
    return emptyCounters(day);
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Opens the counter file and returns a limiter that keeps it current. */
export async function createRateLimiter(options: LimiterOptions): Promise<RateLimiter> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger ?? silentLogger;
  const ceiling = Math.min(
    options.ceiling ?? SELF_IMPOSED_DAILY_REQUESTS,
    API_LIMITS.DAILY_REQUEST_CEILING,
  );
  const capacity = options.capacity ?? DEFAULT_BURST_CAPACITY;
  const refillPerSecond = options.refillPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
  const counterPath = options.counterPath;

  let counters = await loadCounters(counterPath, dayKey(now()));
  let tokens = capacity;
  let lastRefill = now();
  let warned = false;
  let unpersistedUnmetered = 0;
  let writeChain: Promise<void> = Promise.resolve();

  function snapshot(): UsageSnapshot {
    return {
      day: counters.day,
      requests: counters.requests,
      meteredCalls: counters.requests,
      unmeteredRequests: counters.unmetered,
      totalRequests: counters.requests + counters.unmetered,
      remaining: Math.max(0, ceiling - counters.requests),
      ceiling,
      bytesUploaded: counters.bytesTotal,
      bytesToday: counters.bytesToday,
    };
  }

  function persist(): Promise<void> {
    unpersistedUnmetered = 0;
    const payload = JSON.stringify(counters);
    writeChain = writeChain.then(async () => {
      try {
        await mkdir(dirname(counterPath), { recursive: true });
        await writeFile(counterPath, payload, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        // A missing counter file is a nuisance, not a reason to lose an upload.
        logger.warn(`photo-pigeon could not write its request counter: ${String(error)}`);
      }
    });
    return writeChain;
  }

  function rollDayIfNeeded(): void {
    const today = dayKey(now());
    if (counters.day === today) return;
    counters = {
      day: today,
      requests: 0,
      unmetered: 0,
      bytesToday: 0,
      bytesTotal: counters.bytesTotal,
    };
    warned = false;
    unpersistedUnmetered = 0;
  }

  function refill(): void {
    const at = now();
    const elapsed = Math.max(0, at - lastRefill);
    lastRefill = at;
    tokens = Math.min(capacity, tokens + (elapsed * refillPerSecond) / 1000);
  }

  return {
    counterPath,

    async acquire(booking: AcquireOptions = {}): Promise<void> {
      const metered = booking.metered !== false;
      rollDayIfNeeded();

      // The budget is spent in metered calls, but it gates everything. Bytes
      // uploaded with no way to file them are bytes thrown away.
      if (counters.requests >= ceiling) {
        throw new DailyQuotaError(snapshot());
      }

      // Pace. The bucket smooths bursts; sustained work settles at
      // refillPerSecond. This is the 429 guard, not the quota guard.
      for (;;) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          break;
        }
        const deficit = 1 - tokens;
        await sleep(Math.ceil((deficit / refillPerSecond) * 1000));
      }

      if (!metered) {
        counters.unmetered += 1;
        unpersistedUnmetered += 1;
        if (unpersistedUnmetered >= UNMETERED_PERSIST_EVERY) await persist();
        return;
      }

      counters.requests += 1;

      if (!warned && counters.requests >= Math.floor(ceiling * WARN_AT)) {
        warned = true;
        logger.warn(
          [
            `Heads up: ${counters.requests} of today's ${ceiling} Google Photos calls are spent.`,
            'Uploading will pause when the budget runs out and pick up again tomorrow.',
          ].join('\n'),
        );
      }

      await persist();
    },

    async recordBytes(bytes: number): Promise<void> {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      rollDayIfNeeded();
      counters.bytesToday += bytes;
      counters.bytesTotal += bytes;
      await persist();
    },

    usage(): UsageSnapshot {
      rollDayIfNeeded();
      return snapshot();
    },
  };
}
