/**
 * Turning upload tokens into media items.
 *
 * batchCreate is the only call in this package that changes anything in the
 * user's library, and it can only ever add. Three hard rules from the API,
 * all load bearing:
 *
 *  - At most 50 items per call.
 *  - Strictly serial per account. Two batchCreate calls in flight for the same
 *    user is how you earn 429s that last for minutes.
 *  - No partial success at the call level. The HTTP request can come back 200
 *    with individual items having failed, so every token is tracked on its own
 *    and the failures are reported one by one.
 *
 * This is also the one call in the package that costs quota. The probe of
 * 28-Jul-2026 found that Google charges batchCreate against the project's
 * 10,000 a day and does not charge the uploads at all, so the call below says
 * metered outright rather than leaving it to be worked out.
 *
 * There is deliberately no retry in this file. Retrying is two different jobs
 * and neither of them belongs here:
 *
 *  - The call failed as a whole, a 429 or a 500 or a dead socket. photosPost
 *    has already run the backoff ladder for that, five attempts from a thirty
 *    second floor. Another pass on top would just double a wait that is
 *    already measured in minutes, so the error goes up to the caller instead.
 *  - The call came back 200 and Google refused individual items. An upload
 *    token is single use and those ones have now been used, so sending them
 *    again cannot work by construction: it spends one of the day's metered
 *    calls to be told no. The
 *    file has to be uploaded again for a fresh token, and only the queue,
 *    which still has the file, can do that.
 */

import { API_LIMITS, type BatchCreateItem, type BatchCreateOutcome } from '../contracts.js';
import { AuthError } from './auth.js';
import { BATCH_CREATE_ENDPOINT, photosPost, type TransportDeps } from './http.js';
import { DailyQuotaError } from './limiter.js';
import { type Logger, silentLogger } from './log.js';

/** Wiring for batchCreate. */
export interface BatchDeps extends TransportDeps {
  /** Lets the caller veto tokens past their 24 hour life before they are sent. */
  isExpired?: (uploadToken: string) => boolean;
  logger?: Logger;
}

/** Splits a list into runs of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface Indexed {
  index: number;
  item: BatchCreateItem;
}

interface RawResult {
  uploadToken?: string;
  status?: { code?: number; message?: string };
  mediaItem?: { id?: string; filename?: string };
}

/** Reads one entry of newMediaItemResults into the shape the queue expects. */
export function readResult(item: BatchCreateItem, raw: RawResult | undefined): BatchCreateOutcome {
  const code = raw?.status?.code;
  const id = raw?.mediaItem?.id;
  const ok = (code === undefined || code === 0) && Boolean(id);

  if (ok) {
    return {
      uploadToken: item.uploadToken,
      fileName: item.fileName,
      ok: true,
      mediaItemId: id as string,
    };
  }

  return {
    uploadToken: item.uploadToken,
    fileName: item.fileName,
    ok: false,
    error: raw?.status?.message ?? 'Google did not say why this item was not created.',
  };
}

/** Errors that make continuing pointless rather than merely unlucky. */
function isFatal(error: unknown): boolean {
  return error instanceof DailyQuotaError || error instanceof AuthError;
}

/**
 * Creates a batchCreate runner with its own serial gate.
 *
 * The gate is per client instance, which matches the API's per account rule.
 * Callers can fire as many calls as they like; they queue up behind each other
 * instead of racing.
 */
export function createBatchCreator(
  deps: BatchDeps,
): (items: BatchCreateItem[], albumId?: string) => Promise<BatchCreateOutcome[]> {
  const logger = deps.logger ?? silentLogger;
  let gate: Promise<unknown> = Promise.resolve();

  /**
   * One call, one result per item. Throws when the call itself failed, which
   * is the caller's signal that these tokens were never looked at and are
   * still good.
   */
  async function sendChunk(
    entries: Indexed[],
    albumId: string | undefined,
    results: Map<number, BatchCreateOutcome>,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      newMediaItems: entries.map(({ item }) => ({
        ...(item.description ? { description: item.description } : {}),
        simpleMediaItem: {
          uploadToken: item.uploadToken,
          fileName: item.fileName,
        },
      })),
    };
    if (albumId) body.albumId = albumId;

    const response = await photosPost(
      BATCH_CREATE_ENDPOINT,
      {
        label: `batchCreate of ${entries.length} item(s)`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // The one metered call in the package. Said out loud here so a future
        // reader does not have to trust a URL match to know it.
        metered: true,
      },
      deps,
    );
    const parsed = (await response.json()) as { newMediaItemResults?: RawResult[] };

    const raws = parsed.newMediaItemResults ?? [];
    entries.forEach((entry, position) => {
      // Google returns results in submission order and echoes the token. Trust
      // the token when it is there, fall back to position when it is not.
      const byToken = raws.find((r) => r.uploadToken === entry.item.uploadToken);
      results.set(entry.index, readResult(entry.item, byToken ?? raws[position]));
    });
  }

  /** True once at least one media item exists, which makes throwing lossy. */
  function anyCreated(results: Map<number, BatchCreateOutcome>): boolean {
    for (const outcome of results.values()) if (outcome.ok) return true;
    return false;
  }

  async function run(
    items: BatchCreateItem[],
    albumId: string | undefined,
  ): Promise<BatchCreateOutcome[]> {
    const results = new Map<number, BatchCreateOutcome>();
    const pending: Indexed[] = [];

    items.forEach((item, index) => {
      if (deps.isExpired?.(item.uploadToken)) {
        // Sending a stale token spends quota to be told no. Report it honestly
        // and let the queue upload the bytes again.
        results.set(index, {
          uploadToken: item.uploadToken,
          fileName: item.fileName,
          ok: false,
          error:
            'The upload token expired before it could be used. Google keeps them for 24 hours. The file will be sent again.',
        });
        return;
      }
      pending.push({ index, item });
    });

    for (const group of chunk(pending, API_LIMITS.BATCH_CREATE_MAX_ITEMS)) {
      try {
        await sendChunk(group, albumId, results);
      } catch (error) {
        if (isFatal(error)) throw error;
        // Nothing has been created yet, so this is the whole call failing and
        // every token in it is still unspent. The caller gets the real error
        // and can send these same tokens again.
        if (!anyCreated(results)) throw error;
        // An earlier chunk did create media items. Throwing now would lose
        // their ids and the caller would send those bytes a second time, so
        // the rest of this call is reported as failed instead.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`${group.length} item(s) were not created: ${message}`);
        for (const entry of group) {
          results.set(entry.index, {
            uploadToken: entry.item.uploadToken,
            fileName: entry.item.fileName,
            ok: false,
            error: message,
          });
        }
      }
    }

    return items.map(
      (item, index) =>
        results.get(index) ?? {
          uploadToken: item.uploadToken,
          fileName: item.fileName,
          ok: false,
          error: 'No result came back for this item.',
        },
    );
  }

  return function batchCreate(
    items: BatchCreateItem[],
    albumId?: string,
  ): Promise<BatchCreateOutcome[]> {
    if (items.length === 0) return Promise.resolve([]);
    // Serial per account, always. Each call waits for the one before it, and a
    // failure in one does not poison the queue for the next.
    const next = gate.then(
      () => run(items, albumId),
      () => run(items, albumId),
    );
    gate = next.catch(() => undefined);
    return next;
  };
}
