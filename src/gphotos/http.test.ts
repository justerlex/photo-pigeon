import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_LIMITS } from '../contracts.js';
import {
  ALBUMS_ENDPOINT,
  AppendOnlyViolationError,
  BATCH_CREATE_ENDPOINT,
  MAX_BACKOFF_MS,
  PhotosHttpError,
  UPLOAD_ENDPOINT,
  assertPostOnly,
  computeBackoffMs,
  isMeteredRequest,
  parseRetryAfter,
  photosPost,
  sendRequest,
  withRequestCounter,
  type TransportDeps,
} from './http.js';
import type { AcquireOptions, RateLimiter, UsageSnapshot } from './limiter.js';
import { silentLogger } from './log.js';

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

function fakeLimiter(onAcquire?: (options?: AcquireOptions) => void): RateLimiter {
  return {
    counterPath: 'C:/nowhere/quota.json',
    acquire: async (options?: AcquireOptions) => {
      onAcquire?.(options);
    },
    recordBytes: async () => undefined,
    usage: () => usage,
  };
}

/** Records how each request was booked, which is the whole point of the metering. */
function bookings(): { seen: Array<boolean | undefined>; limiter: RateLimiter } {
  const seen: Array<boolean | undefined> = [];
  return {
    seen,
    limiter: fakeLimiter((options) => {
      seen.push(options?.metered);
    }),
  };
}

function deps(extra: Partial<TransportDeps> = {}): TransportDeps {
  return {
    getAccessToken: async () => 'access-token',
    limiter: fakeLimiter(),
    logger: silentLogger,
    sleep: async () => undefined,
    random: () => 0,
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('computeBackoffMs', () => {
  it('never goes below thirty seconds for a 429, whatever the jitter rolls', () => {
    for (let roll = 0; roll <= 1; roll += 0.05) {
      const wait = computeBackoffMs(1, { status: 429, random: () => roll });
      expect(wait).toBeGreaterThanOrEqual(API_LIMITS.MIN_BACKOFF_MS);
    }
  });

  it('doubles from the floor', () => {
    const at = (attempt: number): number =>
      computeBackoffMs(attempt, { status: 429, random: () => 0 });
    expect(at(1)).toBe(30_000);
    expect(at(2)).toBe(60_000);
    expect(at(3)).toBe(120_000);
    expect(at(4)).toBe(240_000);
  });

  it('adds jitter on top rather than shaving the floor', () => {
    const low = computeBackoffMs(1, { status: 429, random: () => 0 });
    const high = computeBackoffMs(1, { status: 429, random: () => 1 });
    expect(low).toBe(30_000);
    expect(high).toBe(45_000);
  });

  it('caps a single nap', () => {
    expect(computeBackoffMs(20, { status: 429, random: () => 0 })).toBe(MAX_BACKOFF_MS);
  });

  it('honours a Retry-After that asks for longer', () => {
    expect(computeBackoffMs(1, { status: 429, retryAfterMs: 90_000, random: () => 0 })).toBe(90_000);
    expect(computeBackoffMs(1, { status: 429, retryAfterMs: 5_000, random: () => 0 })).toBe(30_000);
  });

  it('is gentler on plain server errors than on rate limits', () => {
    expect(computeBackoffMs(1, { status: 503, random: () => 0 })).toBe(2_000);
    expect(computeBackoffMs(1, { status: 429, random: () => 0 })).toBe(30_000);
  });

  it('assumes the strict floor when the status is unknown', () => {
    expect(computeBackoffMs(1, { random: () => 0 })).toBe(API_LIMITS.MIN_BACKOFF_MS);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-07-28T10:00:00Z');

  it('reads seconds', () => {
    expect(parseRetryAfter('45', now)).toBe(45_000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  it('reads an http date', () => {
    expect(parseRetryAfter('Tue, 28 Jul 2026 10:01:00 GMT', now)).toBe(60_000);
  });

  it('shrugs at anything else', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });
});

describe('assertPostOnly', () => {
  it('lets POST through and refuses every other verb by name', () => {
    expect(() => assertPostOnly('POST')).not.toThrow();
    for (const verb of ['GET', 'DELETE', 'PATCH', 'PUT']) {
      expect(() => assertPostOnly(verb)).toThrow(/only ever appends/);
      expect(() => assertPostOnly(verb)).toThrow(AppendOnlyViolationError);
    }
  });

  it('refuses a request with no verb at all rather than letting the default decide', () => {
    expect(() => assertPostOnly('')).toThrow(/refuses to send \(no verb\)/);
  });
});

// ---------------------------------------------------------------------------
// Law 1, enforced where it counts
//
// The guard used to be called on a hardcoded 'POST' literal, which proved
// nothing. It now reads the verb off the object fetch is about to receive.
// ---------------------------------------------------------------------------

describe('sendRequest, the one exit point', () => {
  it('throws on a non-POST init and never reaches the network', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

    await expect(
      sendRequest(fetchMock as unknown as typeof fetch, BATCH_CREATE_ENDPOINT, {
        method: 'DELETE',
        headers: {},
      }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the init forgot to say, because fetch would have defaulted to GET', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

    await expect(
      sendRequest(fetchMock as unknown as typeof fetch, BATCH_CREATE_ENDPOINT, { headers: {} }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a POST through untouched', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

    const response = await sendRequest(
      fetchMock as unknown as typeof fetch,
      BATCH_CREATE_ENDPOINT,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is what photosPost goes through, so the verb on the wire is the one checked', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await photosPost(BATCH_CREATE_ENDPOINT, { label: 'probe', body: '{}' }, deps());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries a broken law', async () => {
    // A transport that somehow produced another verb is a bug in this repo.
    // Four more attempts would only bury it.
    const fetchMock = vi.fn(async () => {
      throw new AppendOnlyViolationError('DELETE');
    });

    await expect(
      photosPost(
        BATCH_CREATE_ENDPOINT,
        { label: 'probe', body: '{}' },
        deps({ fetchImpl: fetchMock as unknown as typeof fetch }),
      ),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Metering: only batchCreate is charged
// ---------------------------------------------------------------------------

describe('isMeteredRequest', () => {
  it('reads batchCreate and album creation as metered', () => {
    expect(isMeteredRequest(BATCH_CREATE_ENDPOINT)).toBe(true);
    expect(isMeteredRequest(ALBUMS_ENDPOINT)).toBe(true);
  });

  it('reads uploads and resumable chunks as free', () => {
    expect(isMeteredRequest(UPLOAD_ENDPOINT)).toBe(false);
    expect(isMeteredRequest(`${UPLOAD_ENDPOINT}?upload_id=abc&upload_protocol=resumable`)).toBe(
      false,
    );
  });

  it('recognises an upload by its headers even on a session URL we did not expect', () => {
    expect(
      isMeteredRequest('https://some-other-host.googleapis.com/resumable/xyz', {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
      }),
    ).toBe(false);
  });

  it('counts anything it does not recognise, because over-counting is the safe way to be wrong', () => {
    expect(isMeteredRequest('https://photoslibrary.googleapis.com/v1/something:new')).toBe(true);
  });
});

describe('photosPost and the daily budget', () => {
  it('books batchCreate as metered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const booked = bookings();

    await photosPost(
      BATCH_CREATE_ENDPOINT,
      { label: 'batchCreate of 50 item(s)', body: '{}' },
      deps({ limiter: booked.limiter }),
    );

    expect(booked.seen).toEqual([true]);
  });

  it('books an upload as unmetered, retries included', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? new Response('slow down', { status: 429 })
          : new Response('token', { status: 200 });
      }),
    );
    const booked = bookings();

    await photosPost(
      UPLOAD_ENDPOINT,
      {
        label: 'upload holiday.jpg',
        headers: { 'X-Goog-Upload-Protocol': 'raw' },
        body: 'bytes',
      },
      deps({ limiter: booked.limiter }),
    );

    expect(booked.seen).toEqual([false, false]);
  });

  it('lets a call say for itself, whatever the URL looks like', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const booked = bookings();

    await photosPost(
      UPLOAD_ENDPOINT,
      { label: 'odd one out', body: '{}', metered: true },
      deps({ limiter: booked.limiter }),
    );

    expect(booked.seen).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// Counting what actually went out
// ---------------------------------------------------------------------------

describe('withRequestCounter', () => {
  it('counts every request the transport issues, retries included', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call < 3
          ? new Response('slow down', { status: 429 })
          : new Response('ok', { status: 200 });
      }),
    );

    const counted = withRequestCounter(deps());
    await photosPost(BATCH_CREATE_ENDPOINT, { label: 'probe', body: '{}' }, counted.deps);

    expect(counted.issued()).toBe(3);
    expect(counted.metered()).toBe(3);
  });

  it('separates the free requests from the charged ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    const counted = withRequestCounter(deps());
    // One start, three chunks, one batchCreate: the shape of a big video.
    for (const label of ['start', 'chunk 1', 'chunk 2', 'chunk 3']) {
      await photosPost(
        `${UPLOAD_ENDPOINT}?upload_id=abc`,
        { label, headers: { 'X-Goog-Upload-Command': 'upload' } },
        counted.deps,
      );
    }
    await photosPost(BATCH_CREATE_ENDPOINT, { label: 'batchCreate', body: '{}' }, counted.deps);

    expect(counted.issued()).toBe(5);
    expect(counted.metered()).toBe(1);
  });

  it('counts a request that died on the socket, because it still went out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    const counted = withRequestCounter(deps({ maxAttempts: 2 }));
    await expect(
      photosPost(BATCH_CREATE_ENDPOINT, { label: 'probe', body: '{}' }, counted.deps),
    ).rejects.toThrow(/socket hang up/);

    expect(counted.issued()).toBe(2);
  });

  it('leaves a hook that was already there in place', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const labels: string[] = [];

    const counted = withRequestCounter(
      deps({
        onRequest: (event) => {
          labels.push(event.label);
        },
      }),
    );
    await photosPost(BATCH_CREATE_ENDPOINT, { label: 'probe', body: '{}' }, counted.deps);

    expect(labels).toEqual(['probe']);
    expect(counted.issued()).toBe(1);
  });
});

describe('photosPost', () => {
  it('books every attempt against the daily budget, retries included', async () => {
    let acquisitions = 0;
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? new Response('slow down', { status: 429 })
          : new Response('ok', { status: 200 });
      }),
    );

    await photosPost(
      BATCH_CREATE_ENDPOINT,
      { label: 'probe', body: '{}' },
      deps({
        limiter: fakeLimiter(() => {
          acquisitions += 1;
        }),
      }),
    );

    expect(acquisitions).toBe(2);
  });

  it('refreshes the token once on a 401 and does not burn a retry doing it', async () => {
    const forced: boolean[] = [];
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('unauthorized', { status: 401 })
        : new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await photosPost(
      BATCH_CREATE_ENDPOINT,
      { label: 'probe', body: '{}' },
      deps({
        maxAttempts: 1,
        getAccessToken: async (force?: boolean) => {
          forced.push(Boolean(force));
          return 'access-token';
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(forced).toContain(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a second 401 rather than looping', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      photosPost(BATCH_CREATE_ENDPOINT, { label: 'probe', body: '{}' }, deps()),
    ).rejects.toBeInstanceOf(PhotosHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a plain refusal', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      photosPost(BATCH_CREATE_ENDPOINT, { label: 'probe', body: '{}' }, deps()),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection and then succeeds', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('socket hang up');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await photosPost(
      BATCH_CREATE_ENDPOINT,
      { label: 'probe', body: '{}' },
      deps(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('carries the failing status and body on the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exhausted', { status: 403 })));

    const error: unknown = await photosPost(
      BATCH_CREATE_ENDPOINT,
      { label: 'probe', body: '{}' },
      deps(),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PhotosHttpError);
    const http = error as PhotosHttpError;
    expect(http.status).toBe(403);
    expect(http.body).toBe('quota exhausted');
    expect(http.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Naps, and being able to leave
// ---------------------------------------------------------------------------

/** A fresh copy of the module: releasing the naps is a one way switch. */
async function freshHttp(): Promise<typeof import('./http.js')> {
  vi.resetModules();
  return import('./http.js');
}

describe('backoffNap', () => {
  it('is an ordinary nap while the tool is working', async () => {
    const { backoffNap } = await freshHttp();
    await expect(backoffNap(1)).resolves.toBeUndefined();
  });

  it('lets go of the naps in flight when the process is leaving, without cutting them short', async () => {
    const { backoffNap, releaseBackoffNaps } = await freshHttp();
    const unref = vi.fn();
    const pending: Array<() => void> = [];
    vi.stubGlobal('setTimeout', ((callback: () => void) => {
      pending.push(callback);
      return { unref };
    }) as unknown as typeof setTimeout);

    let woke = false;
    const nap = backoffNap(MAX_BACKOFF_MS).then(() => {
      woke = true;
    });

    expect(unref).not.toHaveBeenCalled();
    releaseBackoffNaps();

    // Released, not resolved. An unref'd timer still fires when the process has
    // other reasons to be awake, so a busy run rides its own backoff out. What
    // it can no longer be is the one thing keeping the process here.
    expect(unref).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(woke).toBe(false);

    pending[0]?.();
    await nap;
    expect(woke).toBe(true);
  });

  it('starts every later nap released too, because there is no coming back', async () => {
    const { backoffNap, releaseBackoffNaps } = await freshHttp();
    releaseBackoffNaps();

    const unref = vi.fn();
    vi.stubGlobal('setTimeout', (() => ({ unref })) as unknown as typeof setTimeout);
    void backoffNap(MAX_BACKOFF_MS);

    expect(unref).toHaveBeenCalledTimes(1);
  });
});
