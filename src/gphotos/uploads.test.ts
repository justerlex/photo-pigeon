import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_LIMITS } from '../contracts.js';
import { UPLOAD_ENDPOINT } from './http.js';
import type { RateLimiter, UsageSnapshot } from './limiter.js';
import { silentLogger } from './log.js';
import { mediaTypeFor } from './mime.js';
import {
  FileTooLargeError,
  alignChunkSize,
  formatBytes,
  isSessionExpired,
  isUploadSessionUrl,
  isUploadTokenExpired,
  parseSession,
  sessionsPathFor,
  sizeLimitFor,
  uploadFile,
  type ResumableSession,
  type UploadDeps,
} from './uploads.js';

/** The first argument this runtime's fetch takes, named without DOM globals. */
type FetchInput = Parameters<typeof fetch>[0];


/**
 * Files named "oversize-*" report 300 MB to stat without occupying 300 MB of
 * anyone's disk. Everything else reads through to the real filesystem.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    stat: async (path: Parameters<typeof actual.stat>[0]) => {
      const real = await actual.stat(path);
      if (String(path).includes('oversize-')) {
        return Object.assign(real, { size: 300 * 1024 * 1024 });
      }
      return real;
    },
  };
});

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

/** The clock every test shares, so a persisted startedAt can be reasoned about. */
const NOW = Date.parse('2026-07-28T10:00:00');

/** A session URL shaped like the ones Google hands back. */
const SESSION_URL = 'https://photoslibrary.googleapis.com/v1/uploads/session-live';

/** A stand in content hash: the queue passes the real one in through deps. */
const HASH = 'a'.repeat(64);

let dir: string;
let recordedBytes: number[];

function fakeLimiter(): RateLimiter {
  return {
    counterPath: join(dir, 'quota.json'),
    acquire: async () => undefined,
    recordBytes: async (bytes: number) => {
      recordedBytes.push(bytes);
    },
    usage: () => usage,
  };
}

function deps(extra: Partial<UploadDeps> = {}): UploadDeps {
  return {
    getAccessToken: async () => 'access-token',
    limiter: fakeLimiter(),
    logger: silentLogger,
    sleep: async () => undefined,
    random: () => 0,
    now: () => NOW,
    ...extra,
  };
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyLength: number;
}

function seenFrom(input: FetchInput, init?: RequestInit): Seen {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    headers[key.toLowerCase()] = value;
  }
  const body = init?.body;
  const bodyLength =
    body instanceof Uint8Array ? body.byteLength : typeof body === 'string' ? body.length : 0;
  return { url: String(input), method: String(init?.method), headers, bodyLength };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pigeon-uploads-'));
  recordedBytes = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('mediaTypeFor', () => {
  it('knows photos, videos and neither', () => {
    expect(mediaTypeFor('C:/pics/IMG_0001.JPG')).toEqual({ mime: 'image/jpeg', kind: 'photo' });
    expect(mediaTypeFor('/home/casey/clip.MOV')).toEqual({ mime: 'video/quicktime', kind: 'video' });
    expect(mediaTypeFor('notes.txt')).toEqual({
      mime: 'application/octet-stream',
      kind: 'unknown',
    });
    expect(mediaTypeFor('noextension')).toEqual({
      mime: 'application/octet-stream',
      kind: 'unknown',
    });
  });

  it('carries raw formats, which is half the point of original quality', () => {
    expect(mediaTypeFor('a.dng').kind).toBe('photo');
    expect(mediaTypeFor('a.cr3').kind).toBe('photo');
    expect(mediaTypeFor('a.heic').mime).toBe('image/heic');
  });
});

describe('size ceilings', () => {
  it('applies the right one per kind', () => {
    expect(sizeLimitFor('photo')).toBe(API_LIMITS.MAX_PHOTO_BYTES);
    expect(sizeLimitFor('video')).toBe(API_LIMITS.MAX_VIDEO_BYTES);
    expect(sizeLimitFor('unknown')).toBe(API_LIMITS.MAX_VIDEO_BYTES);
  });

  it('refuses an oversized photo before spending any quota on it', async () => {
    const file = join(dir, 'oversize-photo.jpg');
    await writeFile(file, Buffer.alloc(8));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadFile(file, deps())).rejects.toBeInstanceOf(FileTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordedBytes).toEqual([]);
  });

  it('lets a large video through, because videos get the 20 GB ceiling', async () => {
    const file = join(dir, 'oversize-photo.mp4');
    await writeFile(file, Buffer.alloc(8));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('token-for-video')));

    // Same faked 300 MB size as the photo above, and this one is fine.
    const result = await uploadFile(file, deps({ resumableThresholdBytes: 1024 ** 4 }));
    expect(result.uploadToken).toBe('token-for-video');
  });
});

describe('formatBytes', () => {
  it('reads like a person wrote it', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
    expect(formatBytes(21_474_836_480)).toBe('20 GB');
  });
});

describe('the raw upload', () => {
  it('posts the whole file with the append only headers and returns the token', async () => {
    const file = join(dir, 'holiday.jpg');
    await writeFile(file, Buffer.alloc(1024, 7));

    const seen: Seen[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        seen.push(seenFrom(input, init));
        return new Response('upload-token-abc', { status: 200 });
      }),
    );

    const result = await uploadFile(file, deps());

    expect(result.uploadToken).toBe('upload-token-abc');
    expect(result.bytes).toBe(1024);
    expect(result.fileName).toBe('holiday.jpg');
    expect(recordedBytes).toEqual([1024]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(UPLOAD_ENDPOINT);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers['x-goog-upload-protocol']).toBe('raw');
    expect(seen[0]?.headers['x-goog-upload-content-type']).toBe('image/jpeg');
    expect(seen[0]?.headers['content-type']).toBe('application/octet-stream');
    expect(seen[0]?.headers.authorization).toBe('Bearer access-token');
    expect(seen[0]?.bodyLength).toBe(1024);
  });

  it('trims the token, because the endpoint answers in plain text', async () => {
    const file = join(dir, 'a.png');
    await writeFile(file, Buffer.alloc(8));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('  token-with-space \n')));

    const result = await uploadFile(file, deps());
    expect(result.uploadToken).toBe('token-with-space');
  });

  it('complains rather than inventing a token when Google answers empty', async () => {
    const file = join(dir, 'a.png');
    await writeFile(file, Buffer.alloc(8));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('   ')));

    await expect(uploadFile(file, deps())).rejects.toThrow(/empty upload token/);
  });

  it('refuses an empty file instead of sending zero bytes', async () => {
    const file = join(dir, 'empty.jpg');
    await writeFile(file, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadFile(file, deps())).rejects.toThrow(/nothing to deliver/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the resumable upload', () => {
  it('starts a session, sends aligned chunks, and finalizes on the last one', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    const seen: Seen[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const entry = seenFrom(input, init);
        seen.push(entry);

        if (entry.headers['x-goog-upload-command'] === 'start') {
          return new Response('', {
            status: 200,
            headers: {
              'x-goog-upload-url': 'https://photoslibrary.googleapis.com/v1/uploads/session-1',
              'x-goog-upload-chunk-granularity': '5',
            },
          });
        }
        if (entry.headers['x-goog-upload-command'] === 'upload, finalize') {
          return new Response('resumable-token', { status: 200 });
        }
        return new Response('', { status: 200 });
      }),
    );

    const result = await uploadFile(
      file,
      deps({ resumableThresholdBytes: 10, chunkSizeBytes: 12 }),
    );

    expect(result.uploadToken).toBe('resumable-token');
    expect(result.bytes).toBe(25);
    expect(recordedBytes).toEqual([25]);

    const start = seen[0];
    expect(start?.url).toBe(UPLOAD_ENDPOINT);
    expect(start?.headers['x-goog-upload-protocol']).toBe('resumable');
    expect(start?.headers['x-goog-upload-raw-size']).toBe('25');
    expect(start?.headers['x-goog-upload-content-type']).toBe('video/mp4');

    // Granularity 5 turns a requested 12 into 10, so 25 bytes is 10 + 10 + 5.
    const chunks = seen.slice(1);
    expect(chunks.map((c) => c.bodyLength)).toEqual([10, 10, 5]);
    expect(chunks.map((c) => c.headers['x-goog-upload-offset'])).toEqual(['0', '10', '20']);
    expect(chunks.map((c) => c.headers['x-goog-upload-command'])).toEqual([
      'upload',
      'upload',
      'upload, finalize',
    ]);
    for (const c of chunks) {
      expect(c.method).toBe('POST');
      expect(c.url).toBe('https://photoslibrary.googleapis.com/v1/uploads/session-1');
    }
  });

  it('sends one finalize chunk when the file fits in a single chunk', async () => {
    const file = join(dir, 'small.mp4');
    await writeFile(file, Buffer.alloc(20, 2));

    const commands: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const entry = seenFrom(input, init);
        const command = entry.headers['x-goog-upload-command'] ?? '';
        commands.push(command);
        if (command === 'start') {
          return new Response('', {
            status: 200,
            headers: { 'x-goog-upload-url': 'https://photoslibrary.googleapis.com/v1/uploads/s2' },
          });
        }
        return new Response('one-shot-token', { status: 200 });
      }),
    );

    const result = await uploadFile(
      file,
      deps({ resumableThresholdBytes: 10, chunkSizeBytes: 1_000 }),
    );

    expect(commands).toEqual(['start', 'upload, finalize']);
    expect(result.uploadToken).toBe('one-shot-token');
  });

  it('stops when Google gives no session url instead of guessing one', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    await expect(
      uploadFile(file, deps({ resumableThresholdBytes: 10 })),
    ).rejects.toThrow(/did not hand back an upload session/);
  });
});

describe('alignChunkSize', () => {
  it('rounds down to a whole number of granules', () => {
    expect(alignChunkSize(12, 5)).toBe(10);
    expect(alignChunkSize(4, 5)).toBe(5);
    expect(alignChunkSize(1024, 0)).toBe(1024);
    expect(alignChunkSize(1024, 256)).toBe(1024);
  });
});

describe('the 24 hour upload token', () => {
  it('is fresh under a day and stale at a day', () => {
    const issued = Date.parse('2026-07-28T10:00:00');
    expect(isUploadTokenExpired(issued, issued + 60_000)).toBe(false);
    expect(isUploadTokenExpired(issued, issued + API_LIMITS.UPLOAD_TOKEN_TTL_MS - 1)).toBe(false);
    expect(isUploadTokenExpired(issued, issued + API_LIMITS.UPLOAD_TOKEN_TTL_MS)).toBe(true);
  });
});

describe('FileTooLargeError', () => {
  it('explains itself in sizes a person recognises', () => {
    const error = new FileTooLargeError('C:/pics/pano.jpg', 300 * 1024 * 1024, 200 * 1024 * 1024, 'photo');
    expect(error.message).toContain('pano.jpg');
    expect(error.message).toContain('300 MB');
    expect(error.message).toContain('200 MB');
  });
});

// ---------------------------------------------------------------------------
// Sessions that survive a restart
// ---------------------------------------------------------------------------

const ledgerPath = (): string => join(dir, 'ledger.jsonl');
const sessionsFile = (): string => sessionsPathFor(ledgerPath());

type StoredSessions = Record<string, Partial<ResumableSession>>;

async function seedSessions(sessions: StoredSessions): Promise<void> {
  await writeFile(sessionsFile(), JSON.stringify({ version: 1, sessions }, null, 2), 'utf8');
}

async function readSessions(): Promise<StoredSessions> {
  let text: string;
  try {
    text = await readFile(sessionsFile(), 'utf8');
  } catch {
    return {};
  }
  const parsed = JSON.parse(text) as { sessions?: StoredSessions };
  return parsed.sessions ?? {};
}

/** A record shaped like the one an interrupted run would have left behind. */
function storedSession(over: Partial<ResumableSession> = {}): ResumableSession {
  return {
    hash: HASH,
    sessionUrl: SESSION_URL,
    size: 25,
    offset: 10,
    startedAt: NOW - 60 * 60 * 1000,
    chunkSize: 10,
    fileName: 'movie.mp4',
    ...over,
  };
}

/** An upload that takes the resumable path and keeps its notes beside the ledger. */
function resumableDeps(extra: Partial<UploadDeps> = {}): UploadDeps {
  return deps({
    resumableThresholdBytes: 10,
    chunkSizeBytes: 10,
    ledgerPath: ledgerPath(),
    contentHash: HASH,
    ...extra,
  });
}

interface FakeReply {
  status?: number;
  body?: string;
  /**
   * Values may be undefined so a script can branch between replies that set a
   * header and replies that leave it off, without TypeScript widening the two
   * branches into something Response will not take.
   */
  headers?: Record<string, string | undefined>;
}

/** Drops the keys a script left unset, so Response only sees real headers. */
function definedHeaders(headers: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

/** Records every request and answers with whatever the test's script returns. */
function scriptFetch(reply: (seen: Seen) => Promise<FakeReply> | FakeReply): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const entry = seenFrom(input, init);
      seen.push(entry);
      const answer = await reply(entry);
      return new Response(answer.body ?? '', {
        status: answer.status ?? 200,
        headers: definedHeaders(answer.headers),
      });
    }),
  );
  return seen;
}

const commandOf = (entry: Seen): string => entry.headers['x-goog-upload-command'] ?? '';
const offsetOf = (entry: Seen): string => entry.headers['x-goog-upload-offset'] ?? '';

describe('sessionsPathFor', () => {
  it('keeps the session notes beside the ledger', () => {
    expect(sessionsPathFor(ledgerPath())).toBe(join(dir, 'sessions.json'));
  });
});

describe('isUploadSessionUrl', () => {
  it('only trusts an https Google host', () => {
    expect(isUploadSessionUrl(SESSION_URL)).toBe(true);
    expect(isUploadSessionUrl('https://photoslibrary.googleapis.com/v1/uploads/x')).toBe(true);
    expect(isUploadSessionUrl('http://photoslibrary.googleapis.com/v1/uploads/x')).toBe(false);
    expect(isUploadSessionUrl('https://example.com/v1/uploads/x')).toBe(false);
    expect(isUploadSessionUrl('https://photoslibrary.googleapis.com.example.com/x')).toBe(false);
    expect(isUploadSessionUrl('not a url at all')).toBe(false);
    expect(isUploadSessionUrl('')).toBe(false);
  });
});

describe('parseSession', () => {
  it('keeps a whole record and drops a damaged one', () => {
    expect(parseSession(storedSession())).toEqual(storedSession());
    expect(parseSession(null)).toBeNull();
    expect(parseSession({ ...storedSession(), hash: '' })).toBeNull();
    expect(parseSession({ ...storedSession(), sessionUrl: 'https://example.com/x' })).toBeNull();
    expect(parseSession({ ...storedSession(), offset: 99 })).toBeNull();
    expect(parseSession({ ...storedSession(), size: 0 })).toBeNull();
    expect(parseSession({ ...storedSession(), startedAt: 'yesterday' })).toBeNull();
  });
});

describe('the seven day session life', () => {
  it('is measured from the moment the session was opened', () => {
    expect(isSessionExpired(NOW - API_LIMITS.RESUMABLE_SESSION_TTL_MS + 1, NOW)).toBe(false);
    expect(isSessionExpired(NOW - API_LIMITS.RESUMABLE_SESSION_TTL_MS, NOW)).toBe(true);
  });
});

describe('resuming after a restart', () => {
  it('picks a video up where the last run stopped instead of sending it again', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));
    await seedSessions({ [HASH]: storedSession() });

    const seen = scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'query') {
        return {
          headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '10' },
        };
      }
      if (command === 'upload, finalize') return { body: 'resumed-token' };
      return {};
    });

    const result = await uploadFile(file, resumableDeps());

    expect(result.uploadToken).toBe('resumed-token');
    // No start: the session Google already has is the one that gets used.
    expect(seen.map(commandOf)).toEqual(['query', 'upload', 'upload, finalize']);
    expect(seen.every((entry) => entry.url === SESSION_URL)).toBe(true);
    // Only the fifteen bytes Google was missing went back on the wire.
    expect(seen.slice(1).map((entry) => entry.bodyLength)).toEqual([10, 5]);
    expect(seen.slice(1).map(offsetOf)).toEqual(['10', '20']);
    expect(await readSessions()).toEqual({});
  });

  it('throws away a session older than seven days and starts fresh', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));
    const stale = 'https://photoslibrary.googleapis.com/v1/uploads/session-stale';
    await seedSessions({
      [HASH]: storedSession({
        sessionUrl: stale,
        startedAt: NOW - API_LIMITS.RESUMABLE_SESSION_TTL_MS - 1,
      }),
    });

    const seen = scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'upload, finalize') return { body: 'fresh-token' };
      return {};
    });

    const result = await uploadFile(file, resumableDeps());

    expect(result.uploadToken).toBe('fresh-token');
    // The dead session is not even asked about: its life is over by the clock.
    expect(seen.some((entry) => entry.url === stale)).toBe(false);
    expect(seen.map(commandOf)).toEqual(['start', 'upload', 'upload', 'upload, finalize']);
    expect(seen[0]?.url).toBe(UPLOAD_ENDPOINT);
    expect(seen.slice(1).map(offsetOf)).toEqual(['0', '10', '20']);
    expect(await readSessions()).toEqual({});
  });

  it('starts over when Google has already closed the session', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));
    await seedSessions({ [HASH]: storedSession() });
    const fresh = 'https://photoslibrary.googleapis.com/v1/uploads/session-fresh';

    const seen = scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'query') {
        return {
          headers: { 'x-goog-upload-status': 'final', 'x-goog-upload-size-received': '25' },
        };
      }
      if (command === 'start') return { headers: { 'x-goog-upload-url': fresh } };
      if (command === 'upload, finalize') return { body: 'second-try-token' };
      return {};
    });

    const result = await uploadFile(file, resumableDeps());

    expect(result.uploadToken).toBe('second-try-token');
    expect(seen.map(commandOf)).toEqual([
      'query',
      'start',
      'upload',
      'upload',
      'upload, finalize',
    ]);
    expect(seen.slice(2).every((entry) => entry.url === fresh)).toBe(true);
  });

  it('refuses a session url that is not a Google host, however it got there', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));
    const elsewhere = 'https://example.com/v1/uploads/collect';
    await seedSessions({ [HASH]: storedSession({ sessionUrl: elsewhere }) });

    const seen = scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'upload, finalize') return { body: 'safe-token' };
      return {};
    });

    const result = await uploadFile(file, resumableDeps());

    expect(result.uploadToken).toBe('safe-token');
    expect(seen.some((entry) => entry.url.includes('example.com'))).toBe(false);
    expect(commandOf(seen[0] as Seen)).toBe('start');
  });

  it('treats a damaged sessions.json as no sessions at all, and repairs it', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));
    await writeFile(sessionsFile(), '{ this was cut off mid wri', 'utf8');

    const seen = scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'upload, finalize') return { body: 'after-corruption-token' };
      return {};
    });

    const result = await uploadFile(file, resumableDeps());

    expect(result.uploadToken).toBe('after-corruption-token');
    expect(commandOf(seen[0] as Seen)).toBe('start');
    // The first write past the damage leaves readable JSON behind.
    expect(await readSessions()).toEqual({});
  });

  it('writes the session down as it goes and clears it on finalize', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    const snapshots: (Partial<ResumableSession> | undefined)[] = [];
    scriptFetch(async (entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      snapshots.push((await readSessions())[HASH]);
      if (command === 'upload, finalize') return { body: 'done-token' };
      return {};
    });

    const result = await uploadFile(file, resumableDeps());

    expect(result.uploadToken).toBe('done-token');
    expect(snapshots.map((snapshot) => snapshot?.offset)).toEqual([0, 10, 20]);
    expect(snapshots[1]).toEqual({
      hash: HASH,
      sessionUrl: SESSION_URL,
      size: 25,
      offset: 10,
      startedAt: NOW,
      chunkSize: 10,
      fileName: 'movie.mp4',
    });
    // Finalized means spent: leaving the note behind would resume a dead session.
    expect(await readSessions()).toEqual({});
  });

  it('keeps no session file at all when nobody asked for resume', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'upload, finalize') return { body: 'plain-token' };
      return {};
    });

    const result = await uploadFile(
      file,
      deps({ resumableThresholdBytes: 10, chunkSizeBytes: 10 }),
    );

    expect(result.uploadToken).toBe('plain-token');
    await expect(readFile(sessionsFile(), 'utf8')).rejects.toThrow();
  });
});

describe('a chunk that fails', () => {
  it('asks Google where the bytes really stopped, and never replays blindly', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    const snapshots: (number | undefined)[] = [];
    const waits: number[] = [];
    let firstChunk = true;

    const seen = scriptFetch(async (entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'query') {
        // Google took four of the ten bytes before the connection went away.
        return {
          headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '4' },
        };
      }
      snapshots.push((await readSessions())[HASH]?.offset);
      if (firstChunk) {
        firstChunk = false;
        return { status: 500, body: 'backend hiccup' };
      }
      if (command === 'upload, finalize') return { body: 'recovered-token' };
      return {};
    });

    const result = await uploadFile(
      file,
      resumableDeps({
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      }),
    );

    expect(result.uploadToken).toBe('recovered-token');
    expect(seen.map(commandOf)).toEqual([
      'start',
      'upload',
      'query',
      'upload',
      'upload',
      'upload, finalize',
    ]);
    // The retry goes out at the offset Google confirmed, not at the one we sent.
    expect(seen.slice(1).filter((entry) => commandOf(entry) !== 'query').map(offsetOf)).toEqual([
      '0',
      '4',
      '14',
      '24',
    ]);
    // Exactly one request ever carried offset zero: nothing was replayed.
    expect(seen.filter((entry) => offsetOf(entry) === '0')).toHaveLength(1);
    // The corrected offset is on disk before the next chunk goes out.
    expect(snapshots).toEqual([0, 4, 14, 24]);
    expect(waits).toEqual([2_000]);
    expect(await readSessions()).toEqual({});
  });

  it('waits the full thirty seconds when Google answers 429', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    const waits: number[] = [];
    let firstChunk = true;

    scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'query') {
        return {
          headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '0' },
        };
      }
      if (firstChunk) {
        firstChunk = false;
        return { status: 429, body: 'concurrent write request' };
      }
      if (command === 'upload, finalize') return { body: 'after-429-token' };
      return {};
    });

    const result = await uploadFile(
      file,
      resumableDeps({
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      }),
    );

    expect(result.uploadToken).toBe('after-429-token');
    expect(waits).toEqual([API_LIMITS.MIN_BACKOFF_MS]);
  });

  it('gives up rather than guessing when the query cannot be answered either', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    const seen = scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'query') return { status: 400, body: 'no such session' };
      return { status: 500, body: 'backend hiccup' };
    });

    await expect(uploadFile(file, resumableDeps())).rejects.toThrow(/HTTP 500/);
    expect(seen.map(commandOf)).toEqual(['start', 'upload', 'query']);
    // Nothing was sent after the question went unanswered.
    expect(seen.filter((entry) => commandOf(entry) === 'upload')).toHaveLength(1);
    // The note survives, because the next run asks again before trusting it.
    expect((await readSessions())[HASH]?.sessionUrl).toBe(SESSION_URL);
  });

  it('keeps the note when Google cannot be asked, and drops it when Google says cancelled', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'query') {
        return { headers: { 'x-goog-upload-status': 'cancelled' } };
      }
      return { status: 503, body: 'gone away' };
    });

    await expect(uploadFile(file, resumableDeps())).rejects.toThrow(/HTTP 503/);
    // A cancelled session is dead for good, so the note goes with it.
    expect(await readSessions()).toEqual({});
  });

  it('says so honestly when every byte lands but the token never comes back', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'query') {
        return {
          headers: { 'x-goog-upload-status': 'final', 'x-goog-upload-size-received': '25' },
        };
      }
      if (command === 'upload, finalize') return { status: 503, body: 'gone away' };
      return {};
    });

    await expect(uploadFile(file, resumableDeps())).rejects.toThrow(
      /reply carrying its upload token was lost/,
    );
    // A finalized session is spent, so the note about it goes away.
    expect(await readSessions()).toEqual({});
  });

  it('stops after the attempt budget instead of hammering one chunk forever', async () => {
    const file = join(dir, 'movie.mp4');
    await writeFile(file, Buffer.alloc(25, 1));

    const seen = scriptFetch((entry) => {
      const command = commandOf(entry);
      if (command === 'start') return { headers: { 'x-goog-upload-url': SESSION_URL } };
      if (command === 'query') {
        return {
          headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '0' },
        };
      }
      return { status: 503, body: 'still down' };
    });

    await expect(uploadFile(file, resumableDeps({ maxAttempts: 3 }))).rejects.toThrow(/HTTP 503/);

    // Three tries at the same offset, each one preceded by a fresh question.
    expect(seen.filter((entry) => commandOf(entry) === 'upload')).toHaveLength(3);
    expect(seen.filter((entry) => commandOf(entry) === 'query')).toHaveLength(3);
    expect(seen.every((entry) => offsetOf(entry) === '0' || commandOf(entry) !== 'upload')).toBe(
      true,
    );
  });
});
