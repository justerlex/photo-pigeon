/**
 * Getting bytes to Google.
 *
 * Uploading is two steps, and only the second one creates anything. This file
 * does the first: it posts the bytes and gets back an upload token, which is an
 * opaque string that means "your file is on our disk somewhere, unattached".
 * The token is good for 24 hours and for one batchCreate call. If the process
 * dies before batchCreate runs, the bytes are simply forgotten by Google and the
 * ledger never learns about them, which is the right failure: nothing is
 * half-delivered.
 *
 * Small files go in one POST. Anything big goes through the resumable protocol,
 * because a dropped connection 4 GB into a video should cost a chunk, not an
 * evening. Two rules make that promise real rather than decorative:
 *
 *  1. A live session is written down. sessions.json sits beside the ledger and
 *     holds the session URL, the content hash, how far Google got, and when the
 *     session was opened. A machine that reboots mid video picks the video back
 *     up instead of starting it again, and the seven day session life is
 *     measured from the moment the session was really opened, not from the
 *     moment this process happened to start.
 *  2. A chunk that fails is never replayed blindly. The protocol has a "query"
 *     command that answers "here is how much of it I actually have", and this
 *     module asks it every single time before sending another byte. Guessing an
 *     offset is how a video ends up corrupted or duplicated, so it does not
 *     guess.
 *
 * sessions.json is a convenience, not a record. Losing it costs bandwidth and
 * nothing else: the ledger is still the durable truth about what was delivered.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open as openFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { API_LIMITS } from '../contracts.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  PHOTOS_ORIGIN,
  PhotosHttpError,
  UPLOAD_ENDPOINT,
  backoffNap,
  computeBackoffMs,
  photosPost,
  type TransportDeps,
} from './http.js';
import { mediaTypeFor, type MediaKind } from './mime.js';
import { type Logger, silentLogger } from './log.js';

/** Above this, use the resumable protocol. Google's own guidance and plain sense agree. */
export const RESUMABLE_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** Chunk size for resumable uploads, rounded up to Google's granularity when it says one. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Name of the file that remembers half finished uploads, kept beside the ledger. */
export const SESSIONS_FILE_NAME = 'sessions.json';

/** Shape marker for sessions.json, so a future change can migrate rather than misread. */
export const SESSIONS_FILE_VERSION = 1;

/** Host Google hands its upload sessions out on, derived so no second literal can drift. */
const PHOTOS_HOST = new URL(PHOTOS_ORIGIN).hostname;

/** Everything after the first label, for example the api suffix of the Photos host. */
const GOOGLE_API_SUFFIX = PHOTOS_HOST.slice(PHOTOS_HOST.indexOf('.'));

/** One file's worth of bytes delivered, waiting to become a media item. */
export interface UploadedBytes {
  /** Opaque token for batchCreate. Single use, valid for 24 hours. */
  uploadToken: string;
  /** Bytes actually put on the wire. This is what the storage readout sums. */
  bytes: number;
  /** Epoch milliseconds the token was issued, so the 24 hour window can be respected. */
  issuedAt: number;
  /** Name to show in Google Photos: the basename of the source file. */
  fileName: string;
}

/**
 * A resumable upload that is open on Google's side and not finished on ours.
 *
 * Keyed by content hash, because content is this tool's idea of identity: the
 * same video moved to another folder is the same upload, and two different
 * files can never collide on one session.
 */
export interface ResumableSession {
  /** sha256 of the file contents, lowercase hex. The key this record is filed under. */
  hash: string;
  /** The session URL Google handed back. Bytes are POSTed here, nowhere else. */
  sessionUrl: string;
  /** Size of the file the session was opened for. A different size means different content. */
  size: number;
  /** Bytes Google had confirmed as committed last time we looked. */
  offset: number;
  /** Epoch milliseconds the session was opened. The seven day life is measured from here. */
  startedAt: number;
  /** Chunk size agreed with Google, kept so a resumed upload stays on the same granularity. */
  chunkSize: number;
  /** Basename of the source file, for messages. */
  fileName: string;
}

/** Where half finished sessions are remembered. The file backed one lives beside the ledger. */
export interface SessionStore {
  /** The stored session for this content hash, whatever its age. Age is the caller's call. */
  get(hash: string): Promise<ResumableSession | undefined>;
  /** Write one session down, replacing any earlier record for the same content. */
  save(session: ResumableSession): Promise<void>;
  /** Forget one session: it finished, expired, or Google no longer has it. */
  remove(hash: string): Promise<void>;
}

/** Wiring for an upload. Sizes are injectable so tests do not need 100 MB fixtures. */
export interface UploadDeps extends TransportDeps {
  resumableThresholdBytes?: number;
  chunkSizeBytes?: number;
  now?: () => number;
  logger?: Logger;
  /**
   * sha256 of this file's contents, the key its half finished session is filed
   * under. The queue already knows it, so pass it: without it this module has
   * to read the whole file a second time just to name the session.
   */
  contentHash?: string;
  /**
   * Path to the ledger. sessions.json is kept next to it. Leave this out and
   * resumable uploads work exactly as before, they just start over after a
   * crash instead of picking up.
   */
  ledgerPath?: string;
  /** A store to use instead of the file beside the ledger. Tests inject one. */
  sessions?: SessionStore;
}

/** A file the API will refuse. Caught before any quota is spent on it. */
export class FileTooLargeError extends Error {
  readonly path: string;
  readonly size: number;
  readonly limit: number;

  constructor(path: string, size: number, limit: number, kind: MediaKind) {
    const noun = kind === 'video' ? 'Videos' : 'Photos';
    super(
      `${basename(path)} is ${formatBytes(size)}, over the Google Photos limit of ${formatBytes(limit)}. ${noun} above that are refused by the API, so photo-pigeon skips it rather than pretending.`,
    );
    this.name = 'FileTooLargeError';
    this.path = path;
    this.size = size;
    this.limit = limit;
  }
}

/** Human readable byte sizes, used in messages only. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** The ceiling that applies to this kind of file. Unknown kinds get the generous one. */
export function sizeLimitFor(kind: MediaKind): number {
  return kind === 'photo' ? API_LIMITS.MAX_PHOTO_BYTES : API_LIMITS.MAX_VIDEO_BYTES;
}

/** True when an upload token is past its 24 hour life and must not be sent to batchCreate. */
export function isUploadTokenExpired(issuedAt: number, at: number): boolean {
  return at - issuedAt >= API_LIMITS.UPLOAD_TOKEN_TTL_MS;
}

/** True when a session is past the seven day life Google gives it. */
export function isSessionExpired(startedAt: number, at: number): boolean {
  return at - startedAt >= API_LIMITS.RESUMABLE_SESSION_TTL_MS;
}

/** sessions.json lives beside the ledger, because they describe the same run. */
export function sessionsPathFor(ledgerPath: string): string {
  return join(dirname(ledgerPath), SESSIONS_FILE_NAME);
}

/**
 * True when this URL is somewhere Google would actually answer.
 *
 * sessions.json is an ordinary file in the user's config directory, and the
 * thing stored in it is a URL this module will happily POST photos and a bearer
 * token to. So the URL is checked before it is trusted: https, and a Google API
 * host. A rejected URL only costs a restarted upload, which is the cheap side of
 * this trade by a wide margin.
 */
export function isUploadSessionUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === PHOTOS_HOST || url.hostname.endsWith(GOOGLE_API_SUFFIX);
}

/**
 * Uploads one file and returns its token.
 *
 * Nothing is created in the library by this call. That is deliberate: batchCreate
 * is the only place media items appear, so the queue keeps full control of what
 * gets committed and in what order.
 */
export async function uploadFile(filePath: string, deps: UploadDeps): Promise<UploadedBytes> {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? silentLogger;
  const threshold = deps.resumableThresholdBytes ?? RESUMABLE_THRESHOLD_BYTES;

  const info = await stat(filePath);
  const size = info.size;
  const media = mediaTypeFor(filePath);
  const fileName = basename(filePath);

  const limit = sizeLimitFor(media.kind);
  if (size > limit) throw new FileTooLargeError(filePath, size, limit, media.kind);

  if (size === 0) {
    throw new Error(`${fileName} is empty, so there is nothing to deliver.`);
  }

  const uploadToken =
    size <= threshold
      ? await uploadRaw(filePath, media.mime, deps)
      : await uploadResumable(filePath, media.mime, size, deps, logger);

  await deps.limiter.recordBytes(size);

  return { uploadToken, bytes: size, issuedAt: now(), fileName };
}

/** One POST, whole file in the body. */
async function uploadRaw(filePath: string, mime: string, deps: UploadDeps): Promise<string> {
  const handle = await openFile(filePath, 'r');
  let body: Buffer;
  try {
    body = await handle.readFile();
  } finally {
    await handle.close();
  }

  const response = await photosPost(
    UPLOAD_ENDPOINT,
    {
      label: `upload ${basename(filePath)}`,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': mime,
        'X-Goog-Upload-Protocol': 'raw',
      },
      body,
    },
    deps,
  );

  return readToken(response, filePath);
}

/**
 * Start, chunks, finalize, with the session written down along the way.
 *
 * Two things keep this honest. The seven day life of a session is measured from
 * the moment Google opened it, which is a number read back from disk on a
 * resumed upload rather than a fresh timestamp. And a chunk that fails is
 * followed by a query for the real committed offset, never by a hopeful resend
 * at the offset we last assumed.
 */
async function uploadResumable(
  filePath: string,
  mime: string,
  size: number,
  deps: UploadDeps,
  logger: Logger,
): Promise<string> {
  const now = deps.now ?? Date.now;
  // The transport's nap, not a private one: a chunk backoff is a timer like any
  // other, and a process on its way out has to be able to let go of all of them.
  const sleep = deps.sleep ?? backoffNap;
  const random = deps.random ?? Math.random;
  const name = basename(filePath);

  const store = resolveSessionStore(deps);
  const hash = store === null ? '' : await resolveContentHash(filePath, deps, logger);

  const persist = async (session: ResumableSession): Promise<void> => {
    if (store === null || hash === '') return;
    await store.save(session);
  };
  const forget = async (): Promise<void> => {
    if (store === null || hash === '') return;
    await store.remove(hash);
  };

  let session =
    store === null || hash === ''
      ? null
      : await reusableSession(store, hash, size, name, deps, logger);

  if (session === null) {
    session = await startSession(mime, size, name, hash, deps, logger);
    await persist(session);
  }

  const handle = await openFile(filePath, 'r');
  try {
    let offset = session.offset;
    let token = '';
    let failures = 0;
    // One chunk gets the same number of tries a plain request would, except
    // every try after the first is aimed at an offset Google confirmed.
    const attemptBudget = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

    while (offset < size) {
      if (isSessionExpired(session.startedAt, now())) {
        await forget();
        throw new Error(
          `The upload session for ${name} passed its seven day life before finishing. Nothing was created in your library. Run the upload again.`,
        );
      }

      const length = Math.min(session.chunkSize, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) {
        await forget();
        throw new Error(
          `${name} ran out of bytes at ${formatBytes(offset)} of ${formatBytes(size)}, so it changed on disk while it was being sent. Nothing was created in your library.`,
        );
      }
      const chunk = buffer.subarray(0, bytesRead);
      const last = offset + bytesRead >= size;

      let response: Response;
      try {
        response = await photosPost(
          session.sessionUrl,
          {
            label: `upload chunk at ${formatBytes(offset)} of ${name}`,
            headers: {
              // Content-Length is set by hand instead of left to the runtime.
              // Node's fetch usually owns this header, and undici honours the
              // value passed here: verified live against the real API on
              // 28-Jul-2026, a 25 MB video in 26 requests that became a real
              // media item. Do not tidy this away without repeating that test.
              'Content-Length': String(bytesRead),
              'X-Goog-Upload-Command': last ? 'upload, finalize' : 'upload',
              'X-Goog-Upload-Offset': String(offset),
            },
            body: chunk,
          },
          // One try per call. Retrying a chunk is this loop's job, because only
          // this loop asks Google where the bytes really stopped first. The
          // transport would resend at the offset we assumed, which is the bug
          // this replaces.
          { ...deps, maxAttempts: 1 },
        );
      } catch (error) {
        const probe = await probeSession(session.sessionUrl, name, deps);

        if (probe === null || probe.received === null || probe.status === 'cancelled') {
          // No trustworthy offset means no safe next byte, so this file stops
          // here. The note stays behind unless Google said the session is gone:
          // the next run asks again before it trusts anything written in it, so
          // keeping it is a free chance to resume instead of resending
          // everything.
          if (probe !== null && probe.status === 'cancelled') await forget();
          throw error;
        }

        if (probe.status === 'final' || probe.received >= size) {
          // Every byte landed, and the answer carrying the upload token did not
          // come back. The token cannot be recovered and no media item was
          // created, so the file goes out again on the next run.
          await forget();
          throw new Error(
            `${name} reached Google in full but the reply carrying its upload token was lost. Nothing was created in your library, so it is sent again on the next run.`,
          );
        }

        // A failure that still moved the offset forward is progress, not a
        // reason to give up on the file.
        failures = probe.received > offset ? 0 : failures + 1;
        offset = probe.received;
        session = { ...session, offset };
        await persist(session);

        const retryable = !(error instanceof PhotosHttpError) || error.retryable;
        if (!retryable || failures >= attemptBudget) throw error;

        const status = error instanceof PhotosHttpError ? error.status : 503;
        const waitMs = computeBackoffMs(failures, { status, random });
        logger.warn(
          `${name}: that chunk did not land. Google has ${formatBytes(offset)} of it, so the rest goes out again in ${Math.round(waitMs / 1000)}s.`,
        );
        await sleep(waitMs);
        continue;
      }

      offset += bytesRead;
      failures = 0;

      if (last) {
        token = await readToken(response, filePath);
      } else {
        await response.text().catch(() => '');
        session = { ...session, offset };
        await persist(session);
      }
    }

    if (!token) {
      await forget();
      throw new Error(`Finished sending ${name} but Google returned no upload token.`);
    }

    // The bytes are Google's now and the session is spent, so the note about it
    // goes away. Anything left behind would be resumed into a dead session.
    await forget();
    return token;
  } finally {
    await handle.close();
  }
}

/** Opens a fresh session and returns the record that describes it. */
async function startSession(
  mime: string,
  size: number,
  name: string,
  hash: string,
  deps: UploadDeps,
  logger: Logger,
): Promise<ResumableSession> {
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const start = await photosPost(
    UPLOAD_ENDPOINT,
    {
      label: `upload start ${name}`,
      headers: {
        // Hand set for the same live verified reason as the chunk requests.
        'Content-Length': '0',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Content-Type': mime,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Raw-Size': String(size),
      },
    },
    deps,
  );

  const sessionUrl = start.headers.get('x-goog-upload-url');
  if (!sessionUrl) {
    throw new Error(`Google did not hand back an upload session for ${name}.`);
  }

  const granularity = Number(start.headers.get('x-goog-upload-chunk-granularity')) || 0;
  const chunkSize = alignChunkSize(deps.chunkSizeBytes ?? DEFAULT_CHUNK_BYTES, granularity);

  logger.info(
    `${name} is ${formatBytes(size)}, sending it in ${formatBytes(chunkSize)} chunks so a dropped connection costs one chunk.`,
  );

  return { hash, sessionUrl, size, offset: 0, startedAt, chunkSize, fileName: name };
}

/**
 * The session to carry on with, or null when this file starts from the top.
 *
 * The stored offset is a hint, never an instruction. Google is asked where the
 * bytes actually stopped, because a process can die between Google committing a
 * chunk and this tool writing that down, and resuming behind the real offset is
 * the same blind replay the query exists to prevent.
 */
async function reusableSession(
  store: SessionStore,
  hash: string,
  size: number,
  name: string,
  deps: UploadDeps,
  logger: Logger,
): Promise<ResumableSession | null> {
  const now = deps.now ?? Date.now;

  let stored: ResumableSession | undefined;
  try {
    stored = await store.get(hash);
  } catch {
    return null;
  }
  if (!stored) return null;

  if (stored.size !== size) {
    // Same hash, different length: the record is not describing this file.
    await store.remove(hash);
    return null;
  }

  if (isSessionExpired(stored.startedAt, now())) {
    await store.remove(hash);
    logger.info(
      `The half finished upload of ${name} is older than the seven days Google keeps a session, so it starts again from the top.`,
    );
    return null;
  }

  const probe = await probeSession(stored.sessionUrl, name, deps);

  if (probe === null || probe.received === null) {
    // Google could not be asked, so the offset in the note stays unproven and
    // unused. The note itself is kept: asking again later costs one request,
    // and being able to resume saves the whole file.
    logger.info(
      `Could not ask Google how much of ${name} it already has, so this run sends it from the top.`,
    );
    return null;
  }

  if (probe.status === 'cancelled' || probe.status === 'final' || probe.received >= size) {
    await store.remove(hash);
    logger.info(
      `Google no longer has the half finished upload of ${name}, so it starts again from the top. Nothing was created in your library.`,
    );
    return null;
  }

  logger.info(
    `Picking ${name} up where the last run stopped: Google already has ${formatBytes(probe.received)} of ${formatBytes(size)}.`,
  );
  return { ...stored, offset: probe.received };
}

/** What Google says about a session when asked. */
interface SessionProbe {
  /** Google's word for it: active, final or cancelled. Empty when it did not say. */
  status: string;
  /** Bytes Google has committed, or null when it did not say a usable number. */
  received: number | null;
}

/**
 * The query command: "how much of this do you actually have?"
 *
 * Safe to retry, since it carries no body and changes nothing, so the transport
 * keeps its normal attempts here. Returns null when even that fails, which the
 * callers treat as "we do not know, so we do not send".
 */
async function probeSession(
  sessionUrl: string,
  name: string,
  deps: UploadDeps,
): Promise<SessionProbe | null> {
  let response: Response;
  try {
    response = await photosPost(
      sessionUrl,
      {
        label: `upload query ${name}`,
        headers: {
          'Content-Length': '0',
          'X-Goog-Upload-Command': 'query',
        },
      },
      deps,
    );
  } catch {
    return null;
  }

  await response.text().catch(() => '');

  const status = (response.headers.get('x-goog-upload-status') ?? '').trim().toLowerCase();
  const raw = response.headers.get('x-goog-upload-size-received');
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw.trim());
  const received = Number.isSafeInteger(value) && value >= 0 ? value : null;

  return { status, received };
}

/** Chunks must be whole multiples of the granularity Google asks for. */
export function alignChunkSize(desired: number, granularity: number): number {
  if (!granularity || granularity <= 0) return desired;
  const multiples = Math.max(1, Math.floor(desired / granularity));
  return multiples * granularity;
}

async function readToken(response: Response, filePath: string): Promise<string> {
  const token = (await response.text()).trim();
  if (!token) {
    throw new Error(`Google accepted ${basename(filePath)} but returned an empty upload token.`);
  }
  return token;
}

/** The store this call should use, or null when nobody asked for session resume. */
function resolveSessionStore(deps: UploadDeps): SessionStore | null {
  if (deps.sessions) return deps.sessions;
  if (typeof deps.ledgerPath === 'string' && deps.ledgerPath !== '') {
    return createSessionStore(sessionsPathFor(deps.ledgerPath), {
      now: deps.now,
      logger: deps.logger,
    });
  }
  return null;
}

/** The content hash to file this session under, read from the file only as a last resort. */
async function resolveContentHash(
  filePath: string,
  deps: UploadDeps,
  logger: Logger,
): Promise<string> {
  const given = typeof deps.contentHash === 'string' ? deps.contentHash.trim().toLowerCase() : '';
  if (given !== '') return given;

  logger.info(
    `Hashing ${basename(filePath)} so a half finished upload of it can be picked up later.`,
  );
  try {
    return await sha256OfFile(filePath);
  } catch {
    // Without a key there is nothing to file the session under. The upload still
    // runs, it just cannot be resumed after a crash.
    return '';
  }
}

/**
 * sha256 of a file's bytes, streamed.
 *
 * The same digest the ledger keys on, computed here only when the caller did
 * not hand one in. It is deliberately a local copy rather than a reach into the
 * state layer: this module talks to Google, and the only thing it should have
 * to agree with anyone about is the shared contract file.
 */
async function sha256OfFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

/**
 * Windows refuses to replace a file while someone else has it open, usually an
 * antivirus scanner for a few milliseconds. Those handles are worth waiting out
 * rather than failing a write over. Roughly 1.4 seconds of patience in total.
 */
const RENAME_RETRY_DELAYS_MS = [5, 15, 40, 90, 180, 350, 700];

/** Transient lock errors, as opposed to a real permission problem. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

/**
 * Write a file so it is never seen half written: temp file in the same
 * directory, flushed, then renamed over the target. Rename is atomic on NTFS
 * and on POSIX alike, so a reader sees the whole old file or the whole new one.
 */
async function writeFileAtomic(targetPath: string, data: string): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const unique = `${process.pid.toString(36)}${randomBytes(4).toString('hex')}`;
  const tmpPath = join(dir, `.${basename(targetPath)}.${unique}.tmp`);

  try {
    const handle = await openFile(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmpPath, targetPath);
        break;
      } catch (error) {
        const code = errorCode(error);
        if (
          attempt >= RENAME_RETRY_DELAYS_MS.length ||
          code === undefined ||
          !RETRYABLE_RENAME_CODES.has(code)
        ) {
          throw error;
        }
        // Jitter keeps two processes from retrying in lockstep forever.
        const base = RENAME_RETRY_DELAYS_MS[attempt] ?? 700;
        await backoffNap(base + Math.random() * base * 0.5);
      }
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wholeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Read one stored session back, or refuse it.
 *
 * Everything is checked, because this file is plain text on the user's disk and
 * a damaged or edited line must never send bytes somewhere unexpected. Anything
 * that does not add up is dropped, and dropping it costs one restarted upload.
 */
export function parseSession(raw: unknown): ResumableSession | null {
  if (!isRecord(raw)) return null;

  const hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : '';
  const sessionUrl = typeof raw.sessionUrl === 'string' ? raw.sessionUrl.trim() : '';
  if (hash === '' || !isUploadSessionUrl(sessionUrl)) return null;

  const size = wholeNumber(raw.size);
  const offset = wholeNumber(raw.offset);
  const startedAt = wholeNumber(raw.startedAt);
  const chunkSize = wholeNumber(raw.chunkSize);
  if (size === null || offset === null || startedAt === null || chunkSize === null) return null;
  if (size === 0 || chunkSize === 0 || offset > size) return null;

  const fileName = typeof raw.fileName === 'string' ? raw.fileName : '';
  return { hash, sessionUrl, size, offset, startedAt, chunkSize, fileName };
}

/** Knobs for the file backed store. Tests inject a clock, the CLI passes its printer. */
export interface SessionStoreOptions {
  now?: () => number;
  logger?: Logger;
}

/**
 * The store that keeps sessions in one small JSON file.
 *
 * Written atomically, so a power cut leaves the old file rather than a torn one.
 * Read defensively, so a corrupt file means "no sessions" instead of a tool that
 * refuses to start: the worst case is bandwidth, and the ledger, which is the
 * record that matters, is untouched by any of this.
 *
 * Expired sessions are dropped on write rather than on read, which keeps the
 * file from growing forever while leaving the seven day judgement in one place,
 * at the call site that has to explain itself to the user.
 */
export function createSessionStore(
  sessionsPath: string,
  options: SessionStoreOptions = {},
): SessionStore {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? silentLogger;
  let warned = false;

  const complainOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    logger.warn(message);
  };

  async function readAll(): Promise<Map<string, ResumableSession>> {
    const live = new Map<string, ResumableSession>();

    let text: string;
    try {
      text = await readFile(sessionsPath, 'utf8');
    } catch {
      // No file yet, or one we cannot read. Either way there is nothing to resume.
      return live;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      complainOnce(
        `${sessionsPath} is not readable JSON, so any half finished upload starts over. Nothing was lost: the ledger is the record that matters.`,
      );
      return live;
    }

    const bag = isRecord(raw) && isRecord(raw.sessions) ? raw.sessions : null;
    if (bag === null) return live;

    for (const [key, value] of Object.entries(bag)) {
      const session = parseSession(value);
      if (session === null || session.hash !== key) continue;
      live.set(key, session);
    }
    return live;
  }

  async function writeAll(live: Map<string, ResumableSession>): Promise<void> {
    const at = now();
    const sessions: Record<string, ResumableSession> = {};
    for (const [key, value] of live) {
      if (isSessionExpired(value.startedAt, at)) continue;
      sessions[key] = value;
    }
    const body = `${JSON.stringify({ version: SESSIONS_FILE_VERSION, sessions }, null, 2)}\n`;
    await writeFileAtomic(sessionsPath, body);
  }

  return {
    async get(hash: string): Promise<ResumableSession | undefined> {
      return (await readAll()).get(hash.trim().toLowerCase());
    },

    async save(session: ResumableSession): Promise<void> {
      // The store refuses to write down anything it would refuse to read back,
      // so a record on disk is always a record that can be used.
      if (parseSession(session) === null) return;
      try {
        const live = await readAll();
        live.set(session.hash, session);
        await writeAll(live);
      } catch (error) {
        // Not being able to write this down slows a future crash recovery. It is
        // not a reason to fail an upload that is going fine.
        complainOnce(
          `Could not write ${sessionsPath} (${String(error)}). Uploads still work, they just start over instead of picking up after a crash.`,
        );
      }
    },

    async remove(hash: string): Promise<void> {
      const key = hash.trim().toLowerCase();
      try {
        const live = await readAll();
        if (!live.delete(key)) return;
        await writeAll(live);
      } catch (error) {
        complainOnce(
          `Could not tidy ${sessionsPath} (${String(error)}). A stale line there is harmless: it is checked against Google before it is ever used.`,
        );
      }
    },
  };
}
