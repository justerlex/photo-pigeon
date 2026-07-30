/**
 * The only door to Google that this package has.
 *
 * Two laws live in this file and are enforced here rather than trusted:
 *
 *  1. Upload only, one direction, forever. Every request goes out as POST to a
 *     known append-only endpoint. The verb is checked on the object that is
 *     handed to fetch, in sendRequest, which is the single place bytes leave
 *     this process. Checking a literal at the top of a function would prove
 *     nothing.
 *  2. A 429 means wait at least thirty seconds. Not one second. The Photos API
 *     hands out "concurrent write request" 429s after a few minutes of
 *     sustained uploading, and hammering it just extends the punishment.
 *
 * This file also decides which requests are metered. The probe of 28-Jul-2026
 * (run 439e3afb) compared 54 issued requests against the console metrics page,
 * which counted 3: the batchCreate calls. Uploads and resumable chunks are free
 * of the daily budget, so they are booked as unmetered and only the pacing
 * applies to them.
 */

import { API_LIMITS } from '../contracts.js';
import { type Logger, silentLogger } from './log.js';
import type { RateLimiter } from './limiter.js';

/** Origin for every Photos Library call. Nothing outside it is ever contacted. */
export const PHOTOS_ORIGIN = 'https://photoslibrary.googleapis.com';

/** Raw and resumable byte uploads both start here. */
export const UPLOAD_ENDPOINT = `${PHOTOS_ORIGIN}/v1/uploads`;

/** Turns upload tokens into media items. Max 50 per call, serial per account. */
export const BATCH_CREATE_ENDPOINT = `${PHOTOS_ORIGIN}/v1/mediaItems:batchCreate`;

/** Creates an album owned by this app. Listing albums is not possible on appendonly. */
export const ALBUMS_ENDPOINT = `${PHOTOS_ORIGIN}/v1/albums`;

/** Ceiling on a single backoff nap, so a bad afternoon does not become a bad night. */
export const MAX_BACKOFF_MS = 8 * 60_000;

/** Floor for everything that is not a 429. Server hiccups deserve a shorter wait. */
export const TRANSIENT_BACKOFF_MS = 2_000;

/** Default attempts per request, the 429 law's "about five". */
export const DEFAULT_MAX_ATTEMPTS = 5;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** The init type this runtime's fetch accepts, named without leaning on DOM globals. */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** The body type this runtime's fetch accepts, named without leaning on DOM globals. */
type FetchBody = FetchInit['body'];

/** The only verb this package has. */
const POST = 'POST';

/**
 * Header prefix the upload protocol stamps on every one of its requests.
 *
 * Raw uploads, resumable starts and resumable chunks all carry at least one
 * X-Goog-Upload-* header, so the classification below holds even if Google ever
 * hands back a session URL on a host we did not expect.
 */
const UPLOAD_HEADER_PREFIX = 'x-goog-upload-';

/** A response Google was not happy with, carried with enough context to explain itself. */
export class PhotosHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly label: string;

  constructor(label: string, status: number, body: string) {
    super(`${label} failed: HTTP ${status} ${body.slice(0, 400)}`.trim());
    this.name = 'PhotosHttpError';
    this.status = status;
    this.body = body;
    this.label = label;
  }

  /** True when waiting and trying again is the right move. */
  get retryable(): boolean {
    return RETRYABLE_STATUSES.has(this.status);
  }
}

/** The request shapes this module allows. POST only, by law. */
export interface PhotosRequest {
  /** Extra headers. Authorization is added by the transport, never by callers. */
  headers?: Record<string, string>;
  /** Bytes or JSON text. Reusable across retries on purpose. */
  body?: string | Uint8Array;
  /** Human name for logs and errors, for example "upload" or "batchCreate". */
  label: string;
  /**
   * Whether this call is charged against the project's daily budget. Left out,
   * it is worked out from the URL and the headers, which is right for every
   * caller in this package. Set it when the call site wants to be explicit.
   */
  metered?: boolean;
}

/** One HTTP request that the transport actually put on the wire. */
export interface RequestEvent {
  /** Where it went. */
  url: string;
  /** The human name of the call it belongs to. */
  label: string;
  /** Whether it was charged against the daily budget. */
  metered: boolean;
  /** Attempt number within that call, starting at one. */
  attempt: number;
}

/** Everything the transport needs that is not the request itself. */
export interface TransportDeps {
  /** Bearer token supplier. Passing true forces a refresh after a 401. */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
  /** Books the request against the daily budget and paces it. */
  limiter: RateLimiter;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  logger?: Logger;
  /**
   * Called once per request the transport issues, retries and chunks included.
   *
   * This is how anything upstream can report an honest request count: one
   * uploadFile of a big video is one call and dozens of requests, and a caller
   * that assumes one request per call is off by an order of magnitude.
   */
  onRequest?: (event: RequestEvent) => void;
}

/** A transport that keeps a tally of what it has issued. */
export interface CountedTransport {
  /** The deps to hand to photosPost, identical apart from the tally. */
  deps: TransportDeps;
  /** HTTP requests issued so far, retries and chunks included. */
  issued(): number;
  /** Of those, the ones charged against the daily budget. */
  metered(): number;
}

/**
 * Wraps transport deps so the requests they issue can be counted.
 *
 * Any onRequest already on the deps still fires: the counter chains onto it
 * rather than replacing it.
 */
export function withRequestCounter(deps: TransportDeps): CountedTransport {
  let issued = 0;
  let metered = 0;
  const inner = deps.onRequest;

  return {
    deps: {
      ...deps,
      onRequest: (event: RequestEvent) => {
        issued += 1;
        if (event.metered) metered += 1;
        inner?.(event);
      },
    },
    issued: () => issued,
    metered: () => metered,
  };
}

/**
 * True when a request counts against the project's 10,000 a day.
 *
 * Everything is metered except the upload protocol, which the probe of
 * 28-Jul-2026 showed Google does not charge for: 51 upload and chunk requests
 * in that run, zero of them on the console's meter. Uploads are recognised both
 * by their endpoint and by their headers, and anything unrecognised counts,
 * because over-counting only makes the tool more careful than it needs to be.
 */
export function isMeteredRequest(url: string, headers: Record<string, string> = {}): boolean {
  if (url.startsWith(UPLOAD_ENDPOINT)) return false;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith(UPLOAD_HEADER_PREFIX)) return false;
  }
  return true;
}

/**
 * Backoff naps that are holding this process open right now.
 *
 * A pending timer keeps Node alive until it fires, which is exactly right while
 * the tool is working and exactly wrong once the user has said they are
 * leaving: these naps run to eight minutes, and a process that sits out the
 * rest of one after promising to go has broken that promise.
 */
const napsInFlight = new Set<ReturnType<typeof setTimeout>>();

/** True once something has said this process is on its way out. */
let releasing = false;

/**
 * A backoff nap that cannot hold a leaving process open.
 *
 * It is an ordinary timer until releaseBackoffNaps is called. After that the
 * timer is unref'd rather than resolved early, and the difference matters both
 * ways: an unref'd timer still fires when the process has other work keeping it
 * alive, so a healthy run rides out its own backoff and finishes, while a run
 * whose only remaining business is the nap can finally exit. Resolving early
 * instead would push the retry ladders on and put more requests on the wire on
 * the way out, which is not what leaving means.
 */
export function backoffNap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      napsInFlight.delete(timer);
      resolve();
    }, ms);
    napsInFlight.add(timer);
    if (releasing) timer.unref?.();
  });
}

/**
 * Lets every backoff nap go, now and for the rest of this process.
 *
 * One way on purpose. It is called when the user has pressed ctrl+c twice and
 * been told we are leaving now, and there is nothing to come back to.
 */
export function releaseBackoffNaps(): void {
  releasing = true;
  for (const timer of napsInFlight) timer.unref?.();
}

/**
 * How long to wait before attempt number `attempt` + 1.
 *
 * Exponential from a floor, with jitter added on top rather than subtracted
 * from it, so the 30 second minimum for a 429 is a real minimum and not an
 * average. A Retry-After header always wins if it asks for longer.
 */
export function computeBackoffMs(
  attempt: number,
  options: { status?: number; retryAfterMs?: number; random?: () => number } = {},
): number {
  const random = options.random ?? Math.random;
  const floor =
    options.status === 429 || options.status === undefined
      ? API_LIMITS.MIN_BACKOFF_MS
      : TRANSIENT_BACKOFF_MS;

  const base = Math.min(floor * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  const jittered = base + random() * base * 0.5;
  const serverAsked = options.retryAfterMs ?? 0;
  return Math.round(Math.max(jittered, serverAsked));
}

/** Reads Retry-After in both of its legal forms: seconds, or an HTTP date. */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(header);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - nowMs);
}

/**
 * A verb other than POST tried to leave this process.
 *
 * Its own class so the retry ladder can tell it apart from a dropped socket. A
 * law violation is a bug in this repo, not bad luck, and retrying it four more
 * times would only bury it.
 */
export class AppendOnlyViolationError extends Error {
  constructor(method: string) {
    super(
      `photo-pigeon refuses to send ${method || '(no verb)'}. This tool only ever appends, so POST is the only verb it has.`,
    );
    this.name = 'AppendOnlyViolationError';
  }
}

/** Guard rail for law 1: anything but POST is a bug, and bugs here delete people's memories. */
export function assertPostOnly(method: string): void {
  if (method !== POST) throw new AppendOnlyViolationError(method);
}

/**
 * The single point where a request leaves this process.
 *
 * The verb is read off the init object that fetch is about to receive, so the
 * guard is checking what actually goes out. Every path in this package, now and
 * later, has to come through here.
 */
export async function sendRequest(
  doFetch: typeof fetch,
  url: string,
  init: FetchInit,
): Promise<Response> {
  assertPostOnly(String(init.method ?? ''));
  return doFetch(url, init);
}

/**
 * POSTs to a Photos endpoint with the daily budget booked, the bearer token
 * attached, one forced token refresh on a 401, and the backoff law applied to
 * 429s and server errors.
 */
export async function photosPost(
  url: string,
  request: PhotosRequest,
  deps: TransportDeps,
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? backoffNap;
  const random = deps.random ?? Math.random;
  const logger = deps.logger ?? silentLogger;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const metered = request.metered ?? isMeteredRequest(url, request.headers ?? {});

  let refreshed = false;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;

    // Every attempt is a real request, so every attempt is paced and booked,
    // retries included. Only the metered ones come out of the daily budget.
    await deps.limiter.acquire({ metered });

    const token = await deps.getAccessToken(false);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...request.headers,
    };

    let response: Response;
    try {
      deps.onRequest?.({ url, label: request.label, metered, attempt });
      response = await sendRequest(doFetch, url, {
        method: POST,
        headers,
        body: request.body as FetchBody,
      });
    } catch (error) {
      // A broken law is not a network hiccup. Out it goes, unretried.
      if (error instanceof AppendOnlyViolationError) throw error;
      // Network level failure: no status, treat it as transient.
      lastError = error;
      if (attempt >= maxAttempts) break;
      const waitMs = computeBackoffMs(attempt, { status: 503, random });
      logger.warn(
        `${request.label}: network error (${String(error)}). Waiting ${Math.round(waitMs / 1000)}s, then attempt ${attempt + 1} of ${maxAttempts}.`,
      );
      await sleep(waitMs);
      continue;
    }

    if (response.ok) return response;

    if (response.status === 401 && !refreshed) {
      // Access token went stale mid run. Refresh once, then try again without
      // burning a retry on backoff.
      refreshed = true;
      await deps.getAccessToken(true);
      attempt -= 1;
      continue;
    }

    const body = await response.text().catch(() => '');
    const error = new PhotosHttpError(request.label, response.status, body);
    lastError = error;

    if (!error.retryable || attempt >= maxAttempts) throw error;

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
    const waitMs = computeBackoffMs(attempt, { status: response.status, retryAfterMs, random });
    logger.warn(
      `${request.label}: Google answered ${response.status}. Waiting ${Math.round(waitMs / 1000)}s, then attempt ${attempt + 1} of ${maxAttempts}.`,
    );
    await sleep(waitMs);
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`${request.label} failed after ${maxAttempts} attempts.`);
}
