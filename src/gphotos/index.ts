/**
 * Google Photos transport: append only, loopback OAuth, bring your own client.
 *
 * This is the assembled client the rest of the app talks to. It owns the
 * authorizer, the self imposed rate limiter, the byte pusher and the serial
 * batchCreate gate, and it exposes exactly the surface in contracts.ts plus a
 * few read only extras the CLI needs for honest reporting.
 *
 * What it cannot do is as important as what it can. There is no method here,
 * and no endpoint reachable from here, that deletes, moves, renames or edits
 * anything in the user's library. The scope makes it impossible and the
 * transport refuses any verb but POST.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  AppConfig,
  BatchCreateItem,
  BatchCreateOutcome,
  GPhotosClient,
} from '../contracts.js';
import { createAuthorizer, type Authorizer, type AuthOptions } from './auth.js';
import { createBatchCreator } from './batch.js';
import {
  ALBUMS_ENDPOINT,
  photosPost,
  withRequestCounter,
  type CountedTransport,
  type TransportDeps,
} from './http.js';
import {
  counterPathFor,
  createRateLimiter,
  type RateLimiter,
  type UsageSnapshot,
} from './limiter.js';
import { type Logger, consoleLogger } from './log.js';
import { isUploadTokenExpired, uploadFile, type UploadDeps } from './uploads.js';

export {
  AuthError,
  YOUNG_TOKEN_WINDOW_MS,
  audienceConsoleUrl,
  clientIdChangeWarning,
  createAuthorizer,
  headlessAdvice,
  invalidGrantAdvice,
  loadClientSecret,
  readStoredToken,
  type Authorizer,
  type ClientSecret,
  type StoredToken,
} from './auth.js';
export { DailyQuotaError, counterPathFor, type UsageSnapshot } from './limiter.js';
export { FileTooLargeError, formatBytes } from './uploads.js';
export { mediaTypeFor, knownExtensions } from './mime.js';
export { PhotosHttpError } from './http.js';
export type { Logger } from './log.js';

/** The contract surface plus the read only extras the CLI reports with. */
export interface PigeonPhotosClient extends GPhotosClient {
  /**
   * Sends one file's bytes and hands back its upload token.
   *
   * The contract takes the path alone. This takes the file's sha256 as well,
   * because the caller has already computed it and a resumable upload needs it
   * to name the session: without it this client reads the whole file a second
   * time before a single byte goes up, on exactly the large files where that
   * hurts most. It stays optional, so a caller holding the plain contract type
   * still works and simply pays for the second read.
   */
  uploadFile(path: string, contentHash?: string): Promise<string>;
  /** Resolves an app created album by name, creating it the first time. */
  ensureAlbum(name: string): Promise<string>;
  /** Bytes sent for a token, so the queue can fill LedgerEntry.bytes honestly. */
  bytesFor(uploadToken: string): number | undefined;
  /** The name Google Photos will show for a token, if the queue wants it back. */
  fileNameFor(uploadToken: string): string | undefined;
  /** Requests and bytes spent, for the status and doctor commands. */
  usage(): Promise<UsageSnapshot>;
  /**
   * HTTP requests this client has issued, retries and resumable chunks
   * included. Read either side of a call, it gives the queue the real cost of
   * that call instead of assuming one request per call.
   */
  requestsIssued(): number;
}

/** Seams for tests and for the wizard, which drives auth with its own logger. */
export interface GPhotosClientOverrides {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  logger?: Logger;
  /** Replaces the whole authorizer. Tests use this to stay off the network. */
  authorizer?: Authorizer;
  /** Extra authorizer options, for example a non interactive headless run. */
  auth?: Partial<AuthOptions>;
  /** Self imposed daily request budget, normally left alone. */
  dailyCeiling?: number;
  /** Overrides for the resumable threshold and chunk size, used in tests. */
  resumableThresholdBytes?: number;
  chunkSizeBytes?: number;
}

interface AlbumCache {
  [clientIdAndTitle: string]: string;
}

/** Album ids live beside the token: they are only meaningful for that client id. */
export function albumCachePathFor(tokenPath: string): string {
  return join(dirname(tokenPath), 'albums.json');
}

async function readAlbumCache(path: string): Promise<AlbumCache> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AlbumCache;
  } catch {
    return {};
  }
}

async function writeAlbumCache(path: string, cache: AlbumCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

interface Core {
  authorizer: Authorizer;
  limiter: RateLimiter;
  transport: TransportDeps;
  /** The same transport, wrapped so every issued request is tallied. */
  counted: CountedTransport;
  batch: (items: BatchCreateItem[], albumId?: string) => Promise<BatchCreateOutcome[]>;
}

/** Builds the Photos client for this config. Nothing happens until it is used. */
export function createGPhotosClient(
  config: AppConfig,
  overrides: GPhotosClientOverrides = {},
): PigeonPhotosClient {
  const logger = overrides.logger ?? consoleLogger;
  const now = overrides.now ?? Date.now;

  /** token to bytes and file name, so the queue can write an honest ledger entry. */
  const sent = new Map<string, { bytes: number; issuedAt: number; fileName: string }>();

  let corePromise: Promise<Core> | undefined;

  /**
   * The live request tally, once the core exists.
   *
   * Kept out here because requestsIssued has to answer synchronously: the queue
   * reads it either side of an await to book what a call really cost. Before the
   * first call there is nothing to count, so zero is the honest answer.
   */
  let tally: CountedTransport | undefined;

  async function buildCore(): Promise<Core> {
    const authorizer =
      overrides.authorizer ??
      createAuthorizer({
        credentialsPath: config.credentialsPath,
        tokenPath: config.tokenPath,
        logger,
        now,
        ...overrides.auth,
      });

    const limiter = await createRateLimiter({
      counterPath: counterPathFor(config.tokenPath),
      ceiling: overrides.dailyCeiling,
      now,
      sleep: overrides.sleep,
      logger,
    });

    const transport: TransportDeps = {
      getAccessToken: (force?: boolean) => authorizer.getAccessToken(force),
      limiter,
      fetchImpl: overrides.fetchImpl,
      sleep: overrides.sleep,
      random: overrides.random,
      maxAttempts: overrides.maxAttempts,
      logger,
    };

    // One tally for the whole client, so the queue can book the real number of
    // requests a call cost. A 4 GB video is one uploadFile and hundreds of
    // chunks, and reporting that as one request would be a lie in the status
    // line. Retries are counted too, because they were really sent.
    const counted = withRequestCounter(transport);
    tally = counted;

    const batch = createBatchCreator({
      ...counted.deps,
      isExpired: (uploadToken: string) => {
        const record = sent.get(uploadToken);
        // Tokens this process never issued get the benefit of the doubt: the
        // caller may be resuming a queue from an earlier run.
        return record ? isUploadTokenExpired(record.issuedAt, now()) : false;
      },
    });

    return { authorizer, limiter, transport, counted, batch };
  }

  function core(): Promise<Core> {
    corePromise ??= buildCore().catch((error: unknown) => {
      corePromise = undefined;
      throw error;
    });
    return corePromise;
  }

  function refuseInDryRun(what: string): void {
    if (!config.dryRun) return;
    throw new Error(
      `photo-pigeon is in dry run, so ${what} must not be called. Dry run scans and hashes, it never sends. This is a wiring bug, not a user error.`,
    );
  }

  return {
    async ensureAuth(): Promise<void> {
      const { authorizer } = await core();
      await authorizer.ensureAuth();
    },

    async uploadFile(path: string, contentHash?: string): Promise<string> {
      refuseInDryRun('uploadFile');
      const { counted } = await core();
      const hash = typeof contentHash === 'string' ? contentHash.trim() : '';
      const deps: UploadDeps = {
        ...counted.deps,
        now,
        // Half finished resumable sessions are remembered beside the ledger, so
        // a crash partway up a large video costs the remainder and not the
        // whole file. Without this path the store is never opened.
        ledgerPath: config.ledgerPath,
        // The hash the queue already has. Passing it is the difference between
        // naming the session for free and streaming the whole file again to
        // work out a number somebody upstairs is holding.
        ...(hash === '' ? {} : { contentHash: hash }),
        ...(overrides.resumableThresholdBytes !== undefined
          ? { resumableThresholdBytes: overrides.resumableThresholdBytes }
          : {}),
        ...(overrides.chunkSizeBytes !== undefined ? { chunkSizeBytes: overrides.chunkSizeBytes } : {}),
      };
      const result = await uploadFile(path, deps);
      sent.set(result.uploadToken, {
        bytes: result.bytes,
        issuedAt: result.issuedAt,
        fileName: result.fileName,
      });
      return result.uploadToken;
    },

    async batchCreate(items: BatchCreateItem[], albumId?: string): Promise<BatchCreateOutcome[]> {
      refuseInDryRun('batchCreate');
      const { batch } = await core();
      const outcomes = await batch(items, albumId);
      // Tokens are single use. Once they have been through batchCreate the
      // bookkeeping for them is done, so the map stays bounded on long runs.
      for (const item of items) sent.delete(item.uploadToken);
      return outcomes;
    },

    async ensureAlbum(name: string): Promise<string> {
      refuseInDryRun('ensureAlbum');
      const { authorizer, counted } = await core();
      const clientId = await authorizer.clientId();
      const cachePath = albumCachePathFor(config.tokenPath);
      const cache = await readAlbumCache(cachePath);
      const key = `${clientId}::${name}`;

      const known = cache[key];
      if (known) return known;

      // The appendonly scope can create albums but cannot list them, so this
      // local cache is the only thing standing between the user and a new album
      // of the same name on every run.
      const response = await photosPost(
        ALBUMS_ENDPOINT,
        {
          label: `create album "${name}"`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ album: { title: name } }),
        },
        counted.deps,
      );

      const album = (await response.json()) as { id?: string };
      if (!album.id) throw new Error(`Google created the album "${name}" but returned no id for it.`);

      cache[key] = album.id;
      await writeAlbumCache(cachePath, cache);
      logger.info(`Album "${name}" is ready and new uploads will be filed into it.`);
      return album.id;
    },

    bytesFor(uploadToken: string): number | undefined {
      return sent.get(uploadToken)?.bytes;
    },

    fileNameFor(uploadToken: string): string | undefined {
      return sent.get(uploadToken)?.fileName;
    },

    requestsIssued(): number {
      return tally?.issued() ?? 0;
    },

    async usage(): Promise<UsageSnapshot> {
      const { limiter } = await core();
      return limiter.usage();
    },
  };
}
