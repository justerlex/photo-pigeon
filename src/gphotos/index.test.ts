import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../contracts.js';
import type { Authorizer } from './auth.js';
import { ALBUMS_ENDPOINT } from './http.js';
import { albumCachePathFor, createGPhotosClient } from './index.js';
import { silentLogger } from './log.js';

/** The first argument this runtime's fetch takes, named without DOM globals. */
type FetchInput = Parameters<typeof fetch>[0];


let dir: string;

const authorizer: Authorizer = {
  ensureAuth: async () => undefined,
  getAccessToken: async () => 'access-token',
  clientId: async () => 'client-abc',
  projectId: async () => 'pigeon-loft-42',
  tokenAgeMs: () => 1_000,
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    watchDirs: [join(dir, 'watch')],
    credentialsPath: join(dir, 'client_secret.json'),
    tokenPath: join(dir, 'state', 'token.json'),
    ledgerPath: join(dir, 'state', 'ledger.json'),
    extensions: ['.jpg'],
    ...overrides,
  };
}

function client(overrides: Partial<AppConfig> = {}) {
  return createGPhotosClient(config(overrides), {
    authorizer,
    logger: silentLogger,
    sleep: async () => undefined,
    random: () => 0,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pigeon-client-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the assembled client', () => {
  it('remembers how many bytes each token cost, then forgets once it is spent', async () => {
    const file = join(dir, 'a.jpg');
    await writeFile(file, Buffer.alloc(4096, 3));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers['X-Goog-Upload-Protocol'] === 'raw') return new Response('tok-1');
        return new Response(
          JSON.stringify({
            newMediaItemResults: [
              { uploadToken: 'tok-1', status: { message: 'Success' }, mediaItem: { id: 'm-1' } },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const photos = client();
    const token = await photos.uploadFile(file);

    expect(token).toBe('tok-1');
    expect(photos.bytesFor(token)).toBe(4096);
    expect(photos.fileNameFor(token)).toBe('a.jpg');

    const outcomes = await photos.batchCreate([{ uploadToken: token, fileName: 'a.jpg' }]);

    expect(outcomes[0]?.mediaItemId).toBe('m-1');
    expect(photos.bytesFor(token)).toBeUndefined();
  });

  it('counts its own footprint for the storage honesty readout', async () => {
    const file = join(dir, 'a.jpg');
    await writeFile(file, Buffer.alloc(2048, 1));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('tok-1')));

    const photos = client();
    await photos.uploadFile(file);

    const usage = await photos.usage();
    expect(usage.bytesUploaded).toBe(2048);
    // Sending bytes is not charged against the daily budget: the 28-Jul-2026
    // probe put 51 upload requests on the wire and the console meter counted
    // none of them. So an upload shows up as traffic, not as spend.
    expect(usage.requests).toBe(0);
    expect(usage.meteredCalls).toBe(0);
    expect(usage.unmeteredRequests).toBe(1);
    expect(usage.totalRequests).toBe(1);
    expect(usage.ceiling).toBe(9_000);
    // And the client reports the same one request to whoever books the totals.
    expect(photos.requestsIssued()).toBe(1);
  });

  it('books what a call really cost, not one request per call', async () => {
    const file = join(dir, 'a.jpg');
    await writeFile(file, Buffer.alloc(2048, 1));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('tok-1')));

    const photos = client();
    // Nothing has been built yet, so there is nothing to count.
    expect(photos.requestsIssued()).toBe(0);

    const before = photos.requestsIssued();
    await photos.uploadFile(file);
    expect(photos.requestsIssued() - before).toBe(1);
  });

  it('hands the ledger path down, so a half finished upload is written beside the ledger', async () => {
    const file = join(dir, 'big.jpg');
    await writeFile(file, Buffer.alloc(25, 7));
    const sessionsPath = join(dir, 'state', 'sessions.json');

    // The whole session resume feature hangs on this one argument reaching the
    // upload module. Without it nothing is ever written down and a crash on a
    // large video costs the whole video again, silently.
    let noteWasThereMidFlight = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const command = headers['X-Goog-Upload-Command'] ?? '';
        if (command === 'start') {
          return new Response('', {
            headers: {
              'x-goog-upload-url': 'https://photoslibrary.googleapis.com/v1/uploads/session-1',
            },
          });
        }
        if (headers['X-Goog-Upload-Offset'] === '10') {
          noteWasThereMidFlight = existsSync(sessionsPath);
        }
        return command.includes('finalize') ? new Response('tok-big') : new Response('');
      }),
    );

    const photos = createGPhotosClient(config(), {
      authorizer,
      logger: silentLogger,
      sleep: async () => undefined,
      random: () => 0,
      resumableThresholdBytes: 10,
      chunkSizeBytes: 10,
    });

    expect(await photos.uploadFile(file)).toBe('tok-big');
    expect(noteWasThereMidFlight).toBe(true);
    // And a finished upload leaves no live session behind to trip over next time.
    const notes = JSON.parse(await readFile(sessionsPath, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(notes.sessions)).toEqual([]);
  });

  /**
   * A resumable session is filed under the file's content hash, and the queue
   * is holding that hash already. The pair of tests below is the difference
   * between handing it over and making this module stream the whole file again
   * to work out a number somebody upstairs has in their pocket, which on a 4 GB
   * video is 4 GB of reading per attempt.
   */
  function bigFileClient(): ReturnType<typeof createGPhotosClient> {
    return createGPhotosClient(config(), {
      authorizer,
      logger: silentLogger,
      sleep: async () => undefined,
      random: () => 0,
      resumableThresholdBytes: 10,
      chunkSizeBytes: 10,
    });
  }

  /** Answers a resumable upload and reports the session keys written midflight. */
  function watchSessionKeys(sessionsPath: string): { keys: () => string[] } {
    let written: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: FetchInput, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const command = headers['X-Goog-Upload-Command'] ?? '';
        if (command === 'start') {
          return new Response('', {
            headers: {
              'x-goog-upload-url': 'https://photoslibrary.googleapis.com/v1/uploads/session-1',
            },
          });
        }
        if (headers['X-Goog-Upload-Offset'] === '10') {
          const notes = JSON.parse(await readFile(sessionsPath, 'utf8')) as {
            sessions: Record<string, unknown>;
          };
          written = Object.keys(notes.sessions);
        }
        return command.includes('finalize') ? new Response('tok-big') : new Response('');
      }),
    );
    return { keys: () => written };
  }

  it('files a half finished upload under the hash it was handed, instead of reading the file again', async () => {
    const file = join(dir, 'big.jpg');
    await writeFile(file, Buffer.alloc(25, 7));
    // Deliberately not the digest of those bytes. If this client ever works the
    // hash out for itself, this is not the key that reaches the disk.
    const handed = 'b'.repeat(64);
    const session = watchSessionKeys(join(dir, 'state', 'sessions.json'));

    expect(await bigFileClient().uploadFile(file, handed)).toBe('tok-big');
    expect(session.keys()).toEqual([handed]);
  });

  it('works the hash out itself when nobody hands one over, which is the second read', async () => {
    const file = join(dir, 'big.jpg');
    const bytes = Buffer.alloc(25, 7);
    await writeFile(file, bytes);
    const session = watchSessionKeys(join(dir, 'state', 'sessions.json'));

    expect(await bigFileClient().uploadFile(file)).toBe('tok-big');
    expect(session.keys()).toEqual([createHash('sha256').update(bytes).digest('hex')]);
  });
});

describe('albums', () => {
  it('creates the album once and remembers its id for next time', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'album-1', title: 'Pigeon' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const photos = client();
    expect(await photos.ensureAlbum('Pigeon')).toBe('album-1');
    expect(await photos.ensureAlbum('Pigeon')).toBe('album-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])?.[0])).toBe(ALBUMS_ENDPOINT);

    // A fresh process must not create a second album with the same name: the
    // appendonly scope cannot list albums, so this cache is the only guard.
    const second = client();
    expect(await second.ensureAlbum('Pigeon')).toBe('album-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cache = JSON.parse(
      await readFile(albumCachePathFor(config().tokenPath), 'utf8'),
    ) as Record<string, string>;
    expect(cache['client-abc::Pigeon']).toBe('album-1');
  });

  it('keys the cache by client id, because album ids do not survive a new client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'album-2' }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const other = createGPhotosClient(config(), {
      authorizer: { ...authorizer, clientId: async () => 'client-xyz' },
      logger: silentLogger,
    });

    await other.ensureAlbum('Pigeon');

    const cache = JSON.parse(
      await readFile(albumCachePathFor(config().tokenPath), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(cache)).toEqual(['client-xyz::Pigeon']);
  });

  it('complains when Google returns an album with no id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ title: 'Pigeon' }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(client().ensureAlbum('Pigeon')).rejects.toThrow(/returned no id/);
  });
});

describe('dry run', () => {
  it('sends nothing, and says loudly that the caller should not have asked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const photos = client({ dryRun: true });

    await expect(photos.uploadFile(join(dir, 'a.jpg'))).rejects.toThrow(/dry run/);
    await expect(photos.batchCreate([{ uploadToken: 't', fileName: 'a.jpg' }])).rejects.toThrow(
      /dry run/,
    );
    await expect(photos.ensureAlbum('Pigeon')).rejects.toThrow(/dry run/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
