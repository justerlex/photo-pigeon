import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BatchCreateItem } from '../contracts.js';
import { chunk, createBatchCreator, readResult, type BatchDeps } from './batch.js';
import { BATCH_CREATE_ENDPOINT, PHOTOS_ORIGIN, photosPost } from './http.js';
import { DailyQuotaError, type RateLimiter, type UsageSnapshot } from './limiter.js';
import { silentLogger } from './log.js';

/** The first argument this runtime's fetch takes, named without DOM globals. */
type FetchInput = Parameters<typeof fetch>[0];


// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const usage: UsageSnapshot = {
  day: '2026-07-28',
  requests: 0,
  meteredCalls: 0,
  unmeteredRequests: 0,
  totalRequests: 0,
  remaining: 9000,
  ceiling: 9000,
  bytesUploaded: 0,
  bytesToday: 0,
};

function fakeLimiter(overrides: Partial<RateLimiter> = {}): RateLimiter {
  return {
    counterPath: 'C:/nowhere/quota.json',
    acquire: async () => undefined,
    recordBytes: async () => undefined,
    usage: () => usage,
    ...overrides,
  };
}

function deps(extra: Partial<BatchDeps> = {}): BatchDeps {
  return {
    getAccessToken: async () => 'access-token',
    limiter: fakeLimiter(),
    logger: silentLogger,
    sleep: async () => undefined,
    random: () => 0,
    ...extra,
  };
}

function items(count: number, prefix = 't'): BatchCreateItem[] {
  return Array.from({ length: count }, (_, i) => ({
    uploadToken: `${prefix}${i}`,
    fileName: `photo-${i}.jpg`,
  }));
}

function successBody(tokens: string[]): string {
  return JSON.stringify({
    newMediaItemResults: tokens.map((uploadToken, i) => ({
      uploadToken,
      status: { message: 'Success' },
      mediaItem: { id: `media-${uploadToken}-${i}` },
    })),
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

interface Seen {
  url: string;
  method: string;
  tokens: string[];
  albumId?: string;
}

function recordCalls(): { seen: Seen[]; read: (input: FetchInput, init?: RequestInit) => Seen } {
  const seen: Seen[] = [];
  return {
    seen,
    read(input, init) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        newMediaItems?: { simpleMediaItem: { uploadToken: string } }[];
        albumId?: string;
      };
      const entry: Seen = {
        url: String(input),
        method: String(init?.method),
        tokens: (body.newMediaItems ?? []).map((n) => n.simpleMediaItem.uploadToken),
        albumId: body.albumId,
      };
      seen.push(entry);
      return entry;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('chunk', () => {
  it('splits into runs of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
  });
});

describe('readResult', () => {
  const item: BatchCreateItem = { uploadToken: 'tok', fileName: 'a.jpg' };

  it('accepts a result with an id and no error code', () => {
    expect(readResult(item, { status: { message: 'Success' }, mediaItem: { id: 'm1' } })).toEqual({
      uploadToken: 'tok',
      fileName: 'a.jpg',
      ok: true,
      mediaItemId: 'm1',
    });
  });

  it('treats a missing media item as a failure even when the status looks fine', () => {
    const outcome = readResult(item, { status: { message: 'Success' } });
    expect(outcome.ok).toBe(false);
    expect(outcome.mediaItemId).toBeUndefined();
  });

  it('carries Google\u2019s reason through', () => {
    const outcome = readResult(item, { status: { code: 3, message: 'Invalid upload token' } });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('Invalid upload token');
  });
});

describe('batchCreate chunking', () => {
  it('never sends more than 50 items in one call', async () => {
    const calls = recordCalls();
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const entry = calls.read(input, init);
      return jsonResponse(successBody(entry.tokens));
    });
    vi.stubGlobal('fetch', fetchMock);

    const batchCreate = createBatchCreator(deps());
    const outcomes = await batchCreate(items(120));

    expect(calls.seen.map((c) => c.tokens.length)).toEqual([50, 50, 20]);
    expect(outcomes).toHaveLength(120);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it('returns outcomes in the order the items were given', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          newMediaItems: { simpleMediaItem: { uploadToken: string } }[];
        };
        const tokens = body.newMediaItems.map((n) => n.simpleMediaItem.uploadToken);
        // Answer in reversed order to prove the caller does not rely on position.
        return jsonResponse(
          JSON.stringify({
            newMediaItemResults: [...tokens].reverse().map((uploadToken) => ({
              uploadToken,
              status: { message: 'Success' },
              mediaItem: { id: `media-${uploadToken}` },
            })),
          }),
        );
      }),
    );

    const batchCreate = createBatchCreator(deps());
    const outcomes = await batchCreate(items(4));

    expect(outcomes.map((o) => o.uploadToken)).toEqual(['t0', 't1', 't2', 't3']);
    expect(outcomes.map((o) => o.mediaItemId)).toEqual([
      'media-t0',
      'media-t1',
      'media-t2',
      'media-t3',
    ]);
  });

  it('passes the album id through when one is given', async () => {
    const calls = recordCalls();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) =>
        jsonResponse(successBody(calls.read(input, init).tokens)),
      ),
    );

    const batchCreate = createBatchCreator(deps());
    await batchCreate(items(2), 'album-123');

    expect(calls.seen[0]?.albumId).toBe('album-123');
  });

  it('does not call Google at all for an empty list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await createBatchCreator(deps())([]);

    expect(outcomes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('batchCreate and the daily budget', () => {
  it('books every call as metered, which is the only thing Google charges for', async () => {
    const calls = recordCalls();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) =>
        jsonResponse(successBody(calls.read(input, init).tokens)),
      ),
    );

    const booked: Array<boolean | undefined> = [];
    const limiter = fakeLimiter({
      acquire: async (options?: { metered?: boolean }) => {
        booked.push(options?.metered);
      },
    });

    // 120 items is three calls, so three metered bookings and nothing else.
    await createBatchCreator(deps({ limiter }))(items(120));

    expect(booked).toEqual([true, true, true]);
  });
});

describe('batchCreate serial ordering', () => {
  it('never has two calls in flight for one account', async () => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          newMediaItems: { simpleMediaItem: { uploadToken: string } }[];
        };
        const tokens = body.newMediaItems.map((n) => n.simpleMediaItem.uploadToken);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        order.push(`start:${tokens[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${tokens[0]}`);
        inFlight -= 1;
        return jsonResponse(successBody(tokens));
      }),
    );

    const batchCreate = createBatchCreator(deps());
    // Two concurrent callers, and one of them is big enough to be chunked.
    await Promise.all([batchCreate(items(60, 'a')), batchCreate(items(2, 'b'))]);

    expect(peak).toBe(1);
    expect(order).toEqual([
      'start:a0',
      'end:a0',
      'start:a50',
      'end:a50',
      'start:b0',
      'end:b0',
    ]);
  });

  it('keeps the gate usable after a call throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          newMediaItems: { simpleMediaItem: { uploadToken: string } }[];
        };
        return jsonResponse(
          successBody(body.newMediaItems.map((n) => n.simpleMediaItem.uploadToken)),
        );
      }),
    );

    // The budget runs out for the first caller and is topped up for the second,
    // which is the shape of a day rolling over mid run.
    let acquisitions = 0;
    const limiter = fakeLimiter({
      acquire: async () => {
        acquisitions += 1;
        if (acquisitions === 1) throw new DailyQuotaError(usage);
      },
    });

    const batchCreate = createBatchCreator(deps({ limiter }));
    const first = batchCreate(items(1, 'x'));
    const second = batchCreate(items(1, 'y'));

    await expect(first).rejects.toBeInstanceOf(DailyQuotaError);
    await expect(second).resolves.toHaveLength(1);
  });
});

describe('batchCreate and the failed subset', () => {
  it('reports a refused item and never sends its spent token again', async () => {
    const calls = recordCalls();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const entry = calls.read(input, init);
        return jsonResponse(
          JSON.stringify({
            newMediaItemResults: entry.tokens.map((uploadToken) =>
              uploadToken === 't1'
                ? { uploadToken, status: { code: 13, message: 'Internal error' } }
                : {
                    uploadToken,
                    status: { message: 'Success' },
                    mediaItem: { id: `media-${uploadToken}` },
                  },
            ),
          }),
        );
      }),
    );

    const outcomes = await createBatchCreator(deps())(items(3));

    // Google looked at t1, which spends it. A second send could only ever be
    // told no, so the failure is reported and the queue uploads that file again.
    expect(calls.seen).toHaveLength(1);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(outcomes[1]?.error).toBe('Internal error');
  });

  it('lets a failed call through to the caller, whose tokens are still unspent', async () => {
    const calls = recordCalls();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        calls.read(input, init);
        return new Response('nope', { status: 400 });
      }),
    );

    await expect(createBatchCreator(deps())(items(3))).rejects.toThrow(/400/);

    expect(calls.seen).toHaveLength(1);
  });

  it('keeps the ids of a chunk that landed when a later chunk fails', async () => {
    const calls = recordCalls();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const entry = calls.read(input, init);
        call += 1;
        if (call === 1) return jsonResponse(successBody(entry.tokens));
        return new Response('nope', { status: 400 });
      }),
    );

    const outcomes = await createBatchCreator(deps())(items(60));

    // Throwing here would throw away fifty confirmed media item ids and the
    // caller would send those bytes a second time.
    expect(calls.seen.map((c) => c.tokens.length)).toEqual([50, 10]);
    expect(outcomes.slice(0, 50).every((o) => o.ok)).toBe(true);
    expect(outcomes.slice(50).every((o) => !o.ok)).toBe(true);
  });

  it('stops the whole run when the daily budget is gone', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const limiter = fakeLimiter({
      acquire: async () => {
        throw new DailyQuotaError(usage);
      },
    });

    await expect(createBatchCreator(deps({ limiter }))(items(3))).rejects.toBeInstanceOf(
      DailyQuotaError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('batchCreate and the 24 hour token life', () => {
  it('refuses expired tokens without spending a request on them', async () => {
    const calls = recordCalls();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) =>
        jsonResponse(successBody(calls.read(input, init).tokens)),
      ),
    );

    const outcomes = await createBatchCreator(
      deps({ isExpired: (token) => token === 't1' }),
    )(items(3));

    expect(calls.seen).toHaveLength(1);
    expect(calls.seen[0]?.tokens).toEqual(['t0', 't2']);
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[1]?.error).toContain('24 hours');
  });
});

describe('the 429 law', () => {
  it('waits at least thirty seconds before trying again', async () => {
    vi.useFakeTimers();

    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        call += 1;
        if (call === 1) return new Response('slow down', { status: 429 });
        const body = JSON.parse(String(init?.body)) as {
          newMediaItems: { simpleMediaItem: { uploadToken: string } }[];
        };
        return jsonResponse(
          successBody(body.newMediaItems.map((n) => n.simpleMediaItem.uploadToken)),
        );
      }),
    );

    // sleep is left at the real implementation on purpose: the fake clock is
    // what proves the wait, an injected spy would only prove arithmetic.
    const batchCreate = createBatchCreator({
      getAccessToken: async () => 'access-token',
      limiter: fakeLimiter(),
      logger: silentLogger,
      random: () => 0,
    });

    let settled = false;
    const promise = batchCreate(items(1)).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(call).toBe(1);

    await vi.advanceTimersByTimeAsync(2);
    await promise;
    expect(settled).toBe(true);
    expect(call).toBe(2);
  });

  it('gives up after about five attempts instead of hammering', async () => {
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createBatchCreator(deps({ maxAttempts: 3 }))(items(1))).rejects.toThrow(/429/);

    // One ladder, the transport's own. Nothing stacks a second one on top of
    // it: the whole point of the 429 law is fewer requests, not more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('the append only law', () => {
  it('only ever POSTs, and only to the batchCreate endpoint', async () => {
    const calls = recordCalls();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) =>
        jsonResponse(successBody(calls.read(input, init).tokens)),
      ),
    );

    await createBatchCreator(deps())(items(60));

    expect(calls.seen.length).toBeGreaterThan(1);
    for (const call of calls.seen) {
      expect(call.method).toBe('POST');
      expect(call.url).toBe(BATCH_CREATE_ENDPOINT);
      expect(call.url.startsWith(PHOTOS_ORIGIN)).toBe(true);
    }
  });

  it('refuses to send anything that is not a POST', async () => {
    // photosPost hard codes POST, so the only way to reach another verb would be
    // a future edit. This asserts the guard that would catch it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        expect(init?.method).toBe('POST');
        return new Response('ok', { status: 200 });
      }),
    );

    await photosPost(
      BATCH_CREATE_ENDPOINT,
      { label: 'probe', body: '{}' },
      {
        getAccessToken: async () => 'access-token',
        limiter: fakeLimiter(),
        logger: silentLogger,
      },
    );
  });
});
