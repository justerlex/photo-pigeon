import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DailyQuotaError,
  SELF_IMPOSED_DAILY_REQUESTS,
  counterPathFor,
  createRateLimiter,
  dayKey,
} from './limiter.js';
import { silentLogger } from './log.js';

let dir: string;
let counterPath: string;
let clock: number;

const START = Date.parse('2026-07-28T10:00:00');

/** A clock the test drives, and a sleep that moves it. */
function wiring(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    slept,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pigeon-limiter-'));
  counterPath = join(dir, 'quota.json');
  clock = START;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('counterPathFor', () => {
  it('puts the counter beside the token, so wiping an account wipes both', () => {
    expect(counterPathFor(join('C:', 'users', 'casey', '.photo-pigeon', 'token.json'))).toBe(
      join('C:', 'users', 'casey', '.photo-pigeon', 'quota.json'),
    );
  });
});

describe('dayKey', () => {
  it('uses the local calendar day', () => {
    expect(dayKey(Date.parse('2026-07-28T23:30:00'))).toBe('2026-07-28');
    expect(dayKey(Date.parse('2026-01-05T00:00:01'))).toBe('2026-01-05');
  });
});

describe('the daily counter', () => {
  it('counts metered calls and persists them across restarts', async () => {
    const first = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    await first.acquire();
    await first.acquire();
    expect(first.usage().requests).toBe(2);

    const second = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    expect(second.usage().requests).toBe(2);
    expect(second.usage().remaining).toBe(SELF_IMPOSED_DAILY_REQUESTS - 2);
  });

  it('tallies bytes for the storage honesty readout', async () => {
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    await limiter.recordBytes(1_500_000);
    await limiter.recordBytes(2_500_000);

    expect(limiter.usage().bytesUploaded).toBe(4_000_000);

    const written = JSON.parse(await readFile(counterPath, 'utf8')) as { bytesTotal: number };
    expect(written.bytesTotal).toBe(4_000_000);
  });

  it('ignores nonsense byte counts', async () => {
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    await limiter.recordBytes(-5);
    await limiter.recordBytes(Number.NaN);
    expect(limiter.usage().bytesUploaded).toBe(0);
  });

  it('resets the request count at midnight but keeps the lifetime byte total', async () => {
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    await limiter.acquire();
    await limiter.recordBytes(1_000);
    expect(limiter.usage().day).toBe('2026-07-28');

    clock = Date.parse('2026-07-29T00:05:00');

    const usage = limiter.usage();
    expect(usage.day).toBe('2026-07-29');
    expect(usage.requests).toBe(0);
    expect(usage.bytesToday).toBe(0);
    expect(usage.bytesUploaded).toBe(1_000);
  });

  it('starts clean when the counter file is corrupt rather than refusing to run', async () => {
    await writeFile(counterPath, '{ not json', 'utf8');
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    expect(limiter.usage().requests).toBe(0);
  });

  it('drops a stale day found on disk', async () => {
    await writeFile(
      counterPath,
      JSON.stringify({ day: '2026-07-01', requests: 8_999, bytesToday: 5, bytesTotal: 99 }),
      'utf8',
    );
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    expect(limiter.usage().requests).toBe(0);
    expect(limiter.usage().bytesUploaded).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// What the budget is actually spent on
//
// The probe of 28-Jul-2026 issued 54 requests, 51 of them uploads and resumable
// chunks, and Google's console counted 3. Only batchCreate is metered, so the
// counter has to be able to tell the two apart.
// ---------------------------------------------------------------------------

describe('metering', () => {
  it('charges the budget for metered calls only', async () => {
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });

    // One batchCreate, and the twenty-six requests it took to get one video up.
    await limiter.acquire({ metered: true });
    for (let i = 0; i < 26; i += 1) await limiter.acquire({ metered: false });

    const usage = limiter.usage();
    expect(usage.meteredCalls).toBe(1);
    expect(usage.requests).toBe(1);
    expect(usage.unmeteredRequests).toBe(26);
    expect(usage.totalRequests).toBe(27);
    expect(usage.remaining).toBe(SELF_IMPOSED_DAILY_REQUESTS - 1);
  });

  it('counts a call that does not say as metered, so nothing hides', async () => {
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });
    await limiter.acquire();
    await limiter.acquire({});

    expect(limiter.usage().meteredCalls).toBe(2);
    expect(limiter.usage().unmeteredRequests).toBe(0);
  });

  it('lets a day of uploading through on a budget that would have died at fifty', async () => {
    const limiter = await createRateLimiter({
      counterPath,
      ceiling: 50,
      ...wiring(),
      logger: silentLogger,
    });

    // 3,000 chunk requests, the shape of a few big videos. Under the old
    // reading this was sixty times over the ceiling.
    for (let i = 0; i < 3_000; i += 1) await limiter.acquire({ metered: false });

    expect(limiter.usage().unmeteredRequests).toBe(3_000);
    expect(limiter.usage().remaining).toBe(50);
    await expect(limiter.acquire({ metered: true })).resolves.toBeUndefined();
  });

  it('refuses uploads too once the metered budget is gone', async () => {
    const limiter = await createRateLimiter({
      counterPath,
      ceiling: 1,
      ...wiring(),
      logger: silentLogger,
    });

    await limiter.acquire({ metered: true });

    // Bytes with no call left to file them become tokens that expire unused.
    await expect(limiter.acquire({ metered: false })).rejects.toBeInstanceOf(DailyQuotaError);
  });

  it('paces unmetered requests as well, because the 429 guard is not about quota', async () => {
    const wired = wiring();
    const limiter = await createRateLimiter({
      counterPath,
      capacity: 1,
      refillPerSecond: 1,
      ...wired,
      logger: silentLogger,
    });

    await limiter.acquire({ metered: false });
    await limiter.acquire({ metered: false });

    expect(wired.slept).toEqual([1_000]);
  });

  it('writes a metered call straight to disk and batches the unmetered ones', async () => {
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });

    await limiter.acquire({ metered: true });
    const afterMetered = JSON.parse(await readFile(counterPath, 'utf8')) as {
      requests: number;
      unmetered: number;
    };
    expect(afterMetered.requests).toBe(1);

    // Thousands of chunk requests must not mean thousands of file writes. The
    // count is exact in memory either way.
    for (let i = 0; i < 10; i += 1) await limiter.acquire({ metered: false });
    expect(limiter.usage().unmeteredRequests).toBe(10);
    const stillBatched = JSON.parse(await readFile(counterPath, 'utf8')) as { unmetered: number };
    expect(stillBatched.unmetered).toBe(0);

    for (let i = 0; i < 40; i += 1) await limiter.acquire({ metered: false });
    const flushed = JSON.parse(await readFile(counterPath, 'utf8')) as { unmetered: number };
    expect(flushed.unmetered).toBe(50);
  });

  it('reads an older counter file without losing the day', async () => {
    // Builds before the re-metering counted everything in `requests`, which can
    // only ever over-count. It has to load, not crash, and it rolls at midnight.
    await writeFile(
      counterPath,
      JSON.stringify({ day: '2026-07-28', requests: 40, bytesToday: 5, bytesTotal: 99 }),
      'utf8',
    );
    const limiter = await createRateLimiter({ counterPath, ...wiring(), logger: silentLogger });

    expect(limiter.usage().meteredCalls).toBe(40);
    expect(limiter.usage().unmeteredRequests).toBe(0);
    expect(limiter.usage().bytesUploaded).toBe(99);
  });
});

describe('refusing near the ceiling', () => {
  it('stops before spending the last of the budget, and says why', async () => {
    const limiter = await createRateLimiter({
      counterPath,
      ceiling: 2,
      ...wiring(),
      logger: silentLogger,
    });

    await limiter.acquire();
    await limiter.acquire();

    await expect(limiter.acquire()).rejects.toBeInstanceOf(DailyQuotaError);
    await expect(limiter.acquire()).rejects.toThrow(/calls for today/);
    await expect(limiter.acquire()).rejects.toThrow(/Sending the bytes is free/);
    expect(limiter.usage().remaining).toBe(0);
  });

  it('stays under Google’s hard ceiling even if asked for more', async () => {
    const limiter = await createRateLimiter({
      counterPath,
      ceiling: 50_000,
      ...wiring(),
      logger: silentLogger,
    });
    expect(limiter.usage().ceiling).toBe(10_000);
  });

  it('lets the next day through', async () => {
    const wired = wiring();
    const limiter = await createRateLimiter({
      counterPath,
      ceiling: 1,
      ...wired,
      logger: silentLogger,
    });

    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(DailyQuotaError);

    clock = Date.parse('2026-07-29T09:00:00');
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('warns once as the budget runs low', async () => {
    const warnings: string[] = [];
    const limiter = await createRateLimiter({
      counterPath,
      ceiling: 10,
      ...wiring(),
      logger: { info: () => undefined, warn: (m) => warnings.push(m) },
    });

    for (let i = 0; i < 10; i += 1) await limiter.acquire();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('9 of');
  });
});

describe('pacing', () => {
  it('lets a burst through and then settles into the steady rate', async () => {
    const wired = wiring();
    const limiter = await createRateLimiter({
      counterPath,
      capacity: 2,
      refillPerSecond: 1,
      ...wired,
      logger: silentLogger,
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(wired.slept).toEqual([]);

    await limiter.acquire();
    expect(wired.slept).toEqual([1_000]);

    await limiter.acquire();
    expect(wired.slept).toEqual([1_000, 1_000]);
  });

  it('does not pace when enough time has passed on its own', async () => {
    const wired = wiring();
    const limiter = await createRateLimiter({
      counterPath,
      capacity: 1,
      refillPerSecond: 1,
      ...wired,
      logger: silentLogger,
    });

    await limiter.acquire();
    clock += 5_000;
    await limiter.acquire();

    expect(wired.slept).toEqual([]);
  });
});
