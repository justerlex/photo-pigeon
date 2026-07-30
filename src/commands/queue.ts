/**
 * The upload queue: hash, skip or upload, batch, file, record.
 *
 * Everything here runs on one serial chain. That is not laziness, it is the
 * constraint table: batchCreate must be serial per account, and sustained
 * parallel writes are what earns the 429 in the first place.
 *
 * The pipeline for one file:
 *   sha256  ->  ledger.has ? skip  :  uploadFile  ->  hold the token
 *   tokens  ->  batchCreate in groups of 50, or after a quiet spell
 *   filed   ->  ledger.add, which is the durable record
 *
 * There is no delete path and no mutate path. By law there never will be.
 */

import path from 'node:path';

import { API_LIMITS } from '../contracts.js';
import type {
  BatchCreateItem,
  BatchCreateOutcome,
  FileCandidate,
  GPhotosClient,
  LedgerEntry,
  Ledger,
  UploadOutcome,
} from '../contracts.js';
// mime.ts is a pure lookup table with no side effects and nothing to start up,
// so it is imported directly rather than through the runtime. It is the single
// source of truth for which extensions exist and which of them are video.
import { mediaKindFor } from '../gphotos/mime.js';
// http.ts owns the backoff nap for the same reason it owns the retry law: a nap
// is a timer, and a pending timer decides whether this process is allowed to
// exit. The queue borrows that one instead of growing a second, so letting the
// naps go on the way out lets all of them go, here and in the transport below.
import { backoffNap, releaseBackoffNaps } from '../gphotos/http.js';
import { messageOf } from './errors.js';
import { formatBytes, formatSeconds, plural } from './format.js';
import type { Logger } from './log.js';

/**
 * Only the calls the queue is allowed to make. Narrow on purpose: there is no
 * method here that could delete or change anything at Google.
 */
export type UploadClient = Pick<GPhotosClient, 'batchCreate'> & {
  /**
   * Sends one file's bytes and hands back its upload token.
   *
   * The contract signature takes the path alone. This one takes the content
   * hash too, because the queue computed it two lines earlier and a transport
   * left to work it out again reads the whole file a second time to name a
   * resumable session, on exactly the large files where that is expensive.
   * Optional, so any plain GPhotosClient still fits here and simply pays for
   * the second read.
   */
  uploadFile(path: string, contentHash?: string): Promise<string>;
  /** Bytes actually put on the wire for a token, when the transport counted them. */
  bytesFor?: (uploadToken: string) => number | undefined;
  /**
   * HTTP requests the transport has issued since it was built, retries and
   * resumable chunks included.
   *
   * One uploadFile of a large video is one call and dozens of requests. Without
   * this the queue would have to guess one request per call, which is wrong by
   * an order of magnitude on exactly the files people care most about.
   */
  requestsIssued?: () => number;
};

/**
 * The rehash cache, narrowed to the two calls the queue is allowed to make plus
 * the one it has to make on the way out.
 *
 * Narrow on purpose, and the shape of the narrowing is the safety argument.
 * This thing can hand back a hash and it can be told one. It cannot answer
 * "has this been delivered", it is never asked, and there is no method here it
 * could be asked through. The ledger decides, on a hash, every time. All the
 * cache ever does is spare the read that produced the hash.
 *
 * src/state/sideindex.ts satisfies this structurally. Anything else that
 * satisfies it works too, and a queue built without one behaves exactly as it
 * did before this existed.
 */
export interface HashCache {
  /** The remembered hash when path, size and mtime all still match. undefined means read it. */
  lookup(candidate: FileCandidate): string | undefined;
  /** Remember a hash that was really computed from this file's bytes. Returns immediately. */
  remember(candidate: FileCandidate, hash: string): void;
  /** Put anything still pending on disk. Must never reject: it is a cache. */
  flush(): Promise<void>;
}

/** Cancels a scheduled callback. */
export type CancelTimer = () => void;

/** Options a scheduled callback can ask for. */
export interface ScheduleOptions {
  /** True when this timer must not, on its own, keep the process alive. */
  unref?: boolean;
}

/** setTimeout, injectable so the quiet flush can be driven by hand in tests. */
export type Schedule = (
  callback: () => void,
  ms: number,
  options?: ScheduleOptions,
) => CancelTimer;

/**
 * How a failed call should be treated.
 *
 * 'quota' is the day's self imposed request budget running out, which the
 * transport tracks in a durable counter file. It is not a failure of this file
 * and no amount of retrying helps: the answer is to stop until tomorrow.
 */
export type FailureKind = 'rate-limit' | 'transient' | 'permanent' | 'quota';

/**
 * Why the queue is holding everything instead of uploading it.
 *
 * They are independent and they can overlap, which is the whole reason this is
 * a set of reasons rather than a boolean. A person who pressed Pause on the
 * morning the day's budget also ran out is held for two reasons, and pressing
 * Resume lifts exactly one of them: nobody can un-spend a spent budget by
 * clicking a menu.
 */
export type PauseReason = 'user' | 'quota';

/** What resume() found when it was asked. */
export type ResumeResult =
  /** The last hold lifted and whatever piled up is going now. */
  | 'resumed'
  /** The user's hold lifted, and the day's budget is still holding everything. */
  | 'still-held'
  /** Nothing to lift: the queue was already running. */
  | 'not-paused';

/** Flush the pending tokens after this much quiet, even when the batch is not full. */
export const DEFAULT_QUIET_MS = 10_000;

/** Attempts per upload, the first attempt included. */
export const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Attempts per batchCreate call, the first included.
 *
 * Deliberately tiny. The transport runs its own ladder underneath this one,
 * five attempts from a thirty second floor, so every attempt counted here is
 * really about five requests and up to fifteen minutes of waiting. Two is the
 * whole budget: one call, and one more in case the first was unlucky.
 */
export const DEFAULT_MAX_BATCH_ATTEMPTS = 2;

/**
 * Fresh uploads for a file batchCreate refused, on top of the first one.
 *
 * A refused token has been spent, so the only retry that can work is sending
 * the bytes again for a new one. That costs an upload, so it happens once and
 * then the file waits for the next run.
 */
export const DEFAULT_MAX_REFILES = 1;

/** Files held back while the day's budget is spent. Beyond this the startup scan is the safety net. */
export const MAX_DEFERRED_FILES = 100_000;

/** Treat a token as dead this long before its real 24 hour expiry. */
export const TOKEN_SAFETY_MARGIN_MS = 5 * 60_000;

/** First wait for an ordinary transient failure. Rate limits use the 30 second floor instead. */
export const TRANSIENT_BASE_MS = 2_000;

const RATE_LIMIT_CEILING_MS = 15 * 60_000;
const TRANSIENT_CEILING_MS = 60_000;

/** Running counters for the session summary. */
export interface QueueTotals {
  /** Files offered to the queue. */
  seen: number;
  /** Files the ledger already knew, or that were already queued under another name. */
  skipped: number;
  /** Media items Google confirmed. */
  delivered: number;
  /** Files that would have been uploaded, dry run only. */
  wouldUpload: number;
  /** Files that failed after every retry. */
  failed: number;
  /** Bytes sent for delivered files, which is what this tool took from the user's storage. */
  bytes: number;
  /**
   * HTTP requests this session actually put on the wire, chunks and retries
   * included, as counted by the transport. A client that does not count them
   * falls back to one per call, which is a floor and says so.
   */
  requests: number;
  /** Files not taken in, because intake was closed. */
  dropped: number;
  /**
   * Files held back while the queue is paused, and let in again when it is not.
   *
   * Two things pause a queue: the day's request budget running out, and the
   * user asking for it. Either way these files are on disk and absent from the
   * ledger, so nothing is lost by holding them.
   */
  deferred: number;
}

/** Everything the queue needs. Only ledger, client, hashFile and log are required. */
export interface QueueOptions {
  /** The durable record. */
  ledger: Ledger;
  /** The transport. May be null in a dry run, and only in a dry run. */
  client: UploadClient | null;
  /** sha256 of a file's contents. */
  hashFile(filePath: string): Promise<string>;
  /**
   * Optional path+size+mtime cache, so an unchanged file skips its sha256 read.
   *
   * This is what makes start-at-login survivable: without it every logon reads
   * the entire library again, which for a 100 GB shelf is 100 GB off the disk
   * to be told nothing changed. Leave it out and the queue hashes everything it
   * is offered, exactly as it always did.
   */
  sideIndex?: HashCache | null;
  /** Where the queue narrates itself. */
  log: Logger;
  /** Log what would happen, upload nothing, write nothing to the ledger. */
  dryRun?: boolean;
  /** Album new items are filed into, when the user asked for one. */
  albumId?: string;
  /** Tokens per batchCreate. Never above the API maximum of 50. */
  batchSize?: number;
  /** Quiet period before a part-full batch is flushed anyway. */
  quietMs?: number;
  /** Attempts per upload. */
  maxAttempts?: number;
  /** Attempts per batchCreate call. Kept small because the transport retries underneath. */
  maxBatchAttempts?: number;
  /** Extra uploads for a file batchCreate refused, since a refused token cannot be reused. */
  maxRefiles?: number;
  /** Timer, injectable. */
  schedule?: Schedule;
  /**
   * Told the moment the queue starts holding everything, and why.
   *
   * Explicit because the alternative was inference. Until M3 the watch command
   * worked out that a quota pause had happened by watching the shape of the
   * timer the queue asked for, an unref'd one of at least a minute, which is
   * true of exactly one caller today and would have gone quietly wrong the
   * first time a second long timer was added anywhere in this file.
   *
   * `resumesAt` is an ISO moment, and only the quota pause has one: a pause the
   * user asked for lifts when the user says so and not before. `detail` is the
   * transport's own sentence, counts and all, which is worth more in a toast
   * than anything a caller could compose from the reason alone.
   */
  onPaused?: (reason: PauseReason, resumesAt?: string, detail?: string) => void;
  /**
   * Told when a hold lifts, with how many files that lift released.
   *
   * **Once per hold, not once per return to running**, which is the M3 review's
   * first critical. The first shape of this callback fired only on the
   * transition back to running, and that silenced the two lifts most worth
   * hearing: a person resuming into a day whose budget is spent, and a budget
   * coming back under a pause somebody else asked for. Both leave the queue
   * held, so neither announced anything, and a listener whose only reading of
   * silence is "it did not understand me" was left showing the opposite of what
   * this queue was doing, with nothing that could ever put it right.
   *
   * So `waiting` is 0 for a lift that released nothing because another hold is
   * still on. A caller that needs to know whether files are moving reads
   * `waiting` or asks [`UploadQueue.isPaused`]; a caller that keeps one piece of
   * state per reason, which is what a tray does, needs exactly this.
   */
  onResumed?: (reason: PauseReason, waiting: number) => void;
  /** Sleep, injectable so retries are instant in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch milliseconds, injectable. */
  now?: () => number;
  /** Jitter source, injectable. */
  random?: () => number;
}

interface PendingItem {
  candidate: FileCandidate;
  hash: string;
  fileName: string;
  uploadToken: string;
  issuedAt: number;
  /** Bytes the transport says went on the wire, falling back to the size on disk. */
  bytes: number;
}

/** What one upload attempt came to. */
type UploadResult =
  | { kind: 'token'; token: string }
  | { kind: 'failed' }
  | { kind: 'deferred' };

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code']) {
    const value = record[key];
    if (typeof value === 'number' && value >= 100 && value < 600) return value;
  }
  return undefined;
}

/**
 * Decides whether a failure is worth another try.
 *
 * Storage that is actually full comes back as a quota error too, and no amount
 * of backoff fixes it, so that one is checked first and called permanent.
 */
export function classifyFailure(error: unknown): FailureKind {
  const text = messageOf(error).toLowerCase();

  // The transport's own daily budget, kept in a counter file that survives a
  // restart. Retrying it is pointless by construction. The wording is matched
  // as well as the name, because an error that crossed a process boundary
  // arrives as plain text: 'calls for today' is the current phrasing and
  // 'requests for today' is what builds before the re-metering used to say.
  if (
    (error instanceof Error && error.name === 'DailyQuotaError') ||
    /\b(calls|requests) for today\b/.test(text)
  ) {
    return 'quota';
  }

  if (
    text.includes('storage') &&
    (text.includes('full') || text.includes('exceed') || text.includes('out of'))
  ) {
    return 'permanent';
  }

  const status = statusOf(error);
  if (status === 429) return 'rate-limit';
  if (status !== undefined && status >= 500) return 'transient';
  if (status !== undefined && status >= 400) return 'permanent';

  if (
    text.includes('429') ||
    text.includes('resource_exhausted') ||
    text.includes('ratelimit') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('concurrent write')
  ) {
    return 'rate-limit';
  }

  if (
    text.includes('invalid_grant') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('permission') ||
    text.includes('not found') ||
    text.includes('too large') ||
    /\b(400|401|403|404|413)\b/.test(text)
  ) {
    return 'permanent';
  }

  return 'transient';
}

/** Wait before the next attempt. Rate limits start at the 30 second floor, never at one second. */
export function backoffMs(
  kind: FailureKind,
  attempt: number,
  random: () => number = Math.random,
): number {
  const slow = kind === 'rate-limit' || kind === 'quota';
  const base = slow ? API_LIMITS.MIN_BACKOFF_MS : TRANSIENT_BASE_MS;
  const ceiling = slow ? RATE_LIMIT_CEILING_MS : TRANSIENT_CEILING_MS;
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, ceiling);
  return Math.round(capped + capped * 0.2 * random());
}

/**
 * The size ceiling that applies to this file.
 *
 * The classification comes from mime.ts, which is the only place that knows
 * what counts as a video. A user who adds .tod or .3g2 to their config gets the
 * 20 GB ceiling those files deserve, not a 200 MB refusal from a list that
 * happened to be shorter over here.
 *
 * An extension nobody recognises gets the generous ceiling too, which is what
 * the uploader does with it as well. Google is the authority on what it will
 * take, and guessing small here would refuse a legitimate file locally.
 */
export function sizeLimitFor(filePath: string): number {
  return mediaKindFor(filePath) === 'photo'
    ? API_LIMITS.MAX_PHOTO_BYTES
    : API_LIMITS.MAX_VIDEO_BYTES;
}

/**
 * The queue.
 *
 * Offer files to it from anywhere, in any order, as often as you like. It does
 * one thing at a time, in the order the offers arrived, and it never lets two
 * batchCreate calls overlap.
 */
export class UploadQueue {
  readonly totals: QueueTotals = {
    seen: 0,
    skipped: 0,
    delivered: 0,
    wouldUpload: 0,
    failed: 0,
    bytes: 0,
    requests: 0,
    dropped: 0,
    deferred: 0,
  };

  private readonly ledger: Ledger;
  private readonly client: UploadClient | null;
  private readonly hashFile: (filePath: string) => Promise<string>;
  private readonly sideIndex: HashCache | null;
  private readonly log: Logger;
  private readonly dryRun: boolean;
  private readonly albumId: string | undefined;
  private readonly batchSize: number;
  private readonly quietMs: number;
  private readonly maxAttempts: number;
  private readonly maxBatchAttempts: number;
  private readonly maxRefiles: number;
  private readonly schedule: Schedule;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onOutcome: ((outcome: UploadOutcome) => void) | undefined;
  private readonly onPaused:
    | ((reason: PauseReason, resumesAt?: string, detail?: string) => void)
    | undefined;
  private readonly onResumed: ((reason: PauseReason, waiting: number) => void) | undefined;

  /** Tokens waiting to become media items. */
  private pending: PendingItem[] = [];
  /** Content hashes already claimed this session, so the same bytes never fly twice. */
  private readonly claimed = new Set<string>();
  /** Paths currently somewhere in the chain, so a repeated event is not a repeated read. */
  private readonly inFlightPaths = new Set<string>();
  /** Fresh uploads spent on content batchCreate refused, so a bad file cannot loop. */
  private readonly refiles = new Map<string, number>();
  /** The single serial lane every unit of work runs in. */
  private chain: Promise<void> = Promise.resolve();
  /** Tasks queued or running on the chain. */
  private busy = 0;
  private cancelQuiet: CancelTimer | null = null;
  /** The timer waiting for midnight while the day's budget is spent. */
  private cancelResume: CancelTimer | null = null;
  private accepting = true;
  /**
   * Every reason this queue is currently holding everything. Empty means running.
   *
   * A set rather than a flag because the two reasons overlap: the day's budget
   * can run out while a user pause is on, and lifting one of them must not lift
   * the other.
   */
  private readonly holds = new Set<PauseReason>();
  /** When the quota hold is expected to lift, ISO, for whoever is asked to wait. */
  private quotaResumesAt: string | undefined;
  /** True once the user has said they are leaving and the queue stopped waiting. */
  private leaving = false;
  /** Files that arrived while paused. They go in as soon as the holds are gone. */
  private deferred: FileCandidate[] = [];

  constructor(options: QueueOptions & { onOutcome?: (outcome: UploadOutcome) => void }) {
    this.ledger = options.ledger;
    this.client = options.client;
    this.hashFile = options.hashFile;
    this.sideIndex = options.sideIndex ?? null;
    this.log = options.log;
    this.dryRun = options.dryRun === true;
    this.albumId = options.albumId;
    this.batchSize = Math.max(
      1,
      Math.min(options.batchSize ?? API_LIMITS.BATCH_CREATE_MAX_ITEMS, API_LIMITS.BATCH_CREATE_MAX_ITEMS),
    );
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.maxBatchAttempts = Math.max(1, options.maxBatchAttempts ?? DEFAULT_MAX_BATCH_ATTEMPTS);
    this.maxRefiles = Math.max(0, options.maxRefiles ?? DEFAULT_MAX_REFILES);
    this.schedule =
      options.schedule ??
      ((callback, ms, scheduleOptions) => {
        const timer = setTimeout(callback, ms);
        // An unref'd timer cannot hold the process open by itself. The wait for
        // midnight is hours long, and once the queue has drained there is
        // nothing left worth staying up for.
        if (scheduleOptions?.unref) timer.unref?.();
        return () => clearTimeout(timer);
      });
    // The transport's nap, so one call releases every backoff in the process.
    this.sleep = options.sleep ?? backoffNap;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onOutcome = options.onOutcome;
    this.onPaused = options.onPaused;
    this.onResumed = options.onResumed;

    if (!this.dryRun && this.client === null) {
      throw new Error('UploadQueue needs a client unless it is running in dry run mode.');
    }
  }

  /** True while new files are still being taken in. */
  get isAccepting(): boolean {
    return this.accepting;
  }

  /** Tokens uploaded but not yet filed as media items. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Files held back until the queue is running again. */
  get deferredCount(): number {
    return this.deferred.length;
  }

  /** True while nothing at all is being uploaded or filed. */
  get isPaused(): boolean {
    return this.holds.size > 0;
  }

  /** Every reason the queue is holding right now. Empty while it is running. */
  get pausedFor(): readonly PauseReason[] {
    return [...this.holds];
  }

  /** Hand a settled file to the queue. Returns immediately: the work happens on the chain. */
  offer(candidate: FileCandidate): void {
    if (!this.accepting) {
      this.totals.dropped += 1;
      return;
    }
    if (this.isPaused) {
      this.defer(candidate);
      return;
    }
    this.enqueue(candidate);
  }

  /** Stop taking new files. Work already accepted still finishes. */
  stopIntake(): void {
    this.accepting = false;
  }

  /**
   * Hold everything because the user asked, and keep taking files in.
   *
   * This is the pause a menu means, and it is deliberately not stopIntake: the
   * watcher stays live, every file that lands is remembered, and resuming
   * delivers the lot. That is the whole reason it exists. The first version of
   * Pause in the tray stopped the core and started a new one, and a fresh start
   * re-walks and re-hashes every folder, so pausing a 100 GB library and
   * resuming it read 100 GB to learn nothing. This costs one boolean.
   *
   * Anything already on the wire when this lands finishes: a request in flight
   * cannot be un-sent, and abandoning it would leave bytes at Google with no
   * ledger entry. Nothing new starts.
   *
   * Idempotent, and independent of a quota hold: pausing while the day's budget
   * is spent adds the user's own hold on top, and both have to lift.
   */
  pause(): void {
    this.hold('user');
  }

  /**
   * Lift the user's hold.
   *
   * Says which of the three things happened rather than answering yes or no,
   * because the caller has a different sentence for each and cannot work them
   * out from a boolean: 'still-held' is the honest answer when the day's
   * request budget is spent, and no menu click can change that.
   *
   * The user's hold going while the budget's stays is still a lift, and it is
   * announced as one. It releases no files, and it is the whole difference
   * between a caller that knows this queue is no longer holding anything on its
   * behalf and a caller left guessing from silence.
   */
  resume(): ResumeResult {
    if (!this.holds.delete('user')) {
      return this.holds.size > 0 ? 'still-held' : 'not-paused';
    }
    if (this.holds.size > 0) {
      // Not letGo: nothing is released and nothing may start, because the
      // budget is still spent. Announced all the same, and with a 0 that says
      // exactly that. Anyone tempted to move this line into letGo should read
      // what letGo does to `deferred` first.
      this.onResumed?.('user', 0);
      return 'still-held';
    }
    this.letGo('user');
    return 'resumed';
  }

  /**
   * Resolves once every file offered so far has been hashed and uploaded.
   * Tokens may still be waiting for their batch: use drain for that.
   */
  async whenIdle(): Promise<void> {
    for (;;) {
      await this.chain;
      if (this.busy === 0) return;
    }
  }

  /**
   * Finish everything: the files still on the chain, then the tokens still held.
   * Resolves when there is nothing left to do.
   */
  async drain(): Promise<void> {
    for (;;) {
      await this.whenIdle();
      if (this.pending.length === 0) break;
      await this.flush();
    }
    // The rehash cache is written here rather than per file, which is the whole
    // point of it: an fsync per photo is the cost it exists to avoid. It never
    // rejects, so this cannot turn a finished run into a failed one.
    await this.sideIndex?.flush();
  }

  /** File the tokens held right now, without waiting for the quiet timer. */
  async flush(): Promise<void> {
    await this.run(() => this.flushNow());
  }

  /**
   * Drops every timer this queue owns.
   *
   * Call it when the queue is finished with, after drain. Nothing in flight is
   * cancelled and nothing is lost: files still held back are on disk, and the
   * next startup scan finds them. Without this, a run that paused for the day
   * leaves a timer sitting on the event loop with hours to go.
   */
  dispose(): void {
    this.clearQuietTimer();
    this.clearResumeTimer();
  }

  /**
   * Stops waiting for Google, so the process can actually leave.
   *
   * The second ctrl+c tells the user we are going now, and until this existed
   * that promise could not be kept: a retry nap is a timer, Node will not exit
   * while a timer is pending, and a rate limit storm is the ordinary weather
   * under sustained uploading. So every nap in flight is released, here and in
   * the transport underneath, and the retry ladders stop climbing. Work already
   * on the wire is left to finish on its own. Nothing is lost by going: what
   * did not arrive is still on disk and still absent from the ledger, so the
   * next startup scan finds it.
   */
  leaveNow(): void {
    this.leaving = true;
    this.dispose();
    releaseBackoffNaps();
    // Best effort, and deliberately not awaited: the user asked to go now, and
    // the point of this method is that nothing gets to hold them. The cache is
    // the one thing here that is safe to lose, because losing it costs a re-read
    // and never a photo. flush does not reject, so a dropped promise cannot
    // become an unhandled rejection on the way out.
    void this.sideIndex?.flush();
  }

  // -------------------------------------------------------------------------
  // The serial lane
  // -------------------------------------------------------------------------

  private run(task: () => Promise<void>): Promise<void> {
    this.busy += 1;
    const next = this.chain.then(task, task).catch((error: unknown) => {
      // A task should handle its own failures. Reaching here means a real bug,
      // and losing the whole watcher over it would be worse than saying so.
      this.log.error(`internal queue error: ${messageOf(error)}`);
    });
    this.chain = next.finally(() => {
      this.busy -= 1;
    });
    return this.chain;
  }

  private enqueue(candidate: FileCandidate): void {
    if (this.inFlightPaths.has(candidate.path)) return;
    this.inFlightPaths.add(candidate.path);
    void this.run(() => this.processCandidate(candidate));
  }

  // -------------------------------------------------------------------------
  // One file
  // -------------------------------------------------------------------------

  private async processCandidate(candidate: FileCandidate): Promise<void> {
    const name = path.basename(candidate.path);
    try {
      // Checked before the file is touched, not only before it is uploaded. A
      // paused queue that still hashes everything offered to it is reading the
      // disk on behalf of work it has promised not to do, which on a folder
      // full of video is exactly the cost pause exists to avoid.
      if (this.isPaused) {
        this.defer(candidate);
        return;
      }

      this.totals.seen += 1;

      const limit = sizeLimitFor(candidate.path);
      if (candidate.size > limit) {
        this.totals.failed += 1;
        this.log.warn(
          `${name} is ${formatBytes(candidate.size)}, over the Google limit of ${formatBytes(limit)}, skipping it`,
        );
        return;
      }

      // The hash, and the one shortcut that is allowed to produce it.
      //
      // A candidate whose path, size and mtime all match what the cache last
      // saw gets the recorded hash without the file being opened. Anything else
      // is streamed for real and the answer is written down for next time.
      //
      // Note what does not change below: whichever way the hash arrived, every
      // decision after this point is made on the hash. The cache shortens the
      // road to the identity, it never stands in for the ledger's answer about
      // that identity. There is no branch here that skips an upload because the
      // cache recognised a path.
      let hash: string;
      const remembered = this.sideIndex?.lookup(candidate);
      if (remembered !== undefined) {
        hash = remembered;
      } else {
        try {
          hash = await this.hashFile(candidate.path);
        } catch (error) {
          this.totals.failed += 1;
          this.log.warn(`could not read ${name}: ${messageOf(error)}`);
          return;
        }
        // Only ever a hash this process just computed from the file's own bytes.
        this.sideIndex?.remember(candidate, hash);
      }

      if (this.ledger.has(hash)) {
        this.totals.skipped += 1;
        this.log.muted(`skip ${name}, already delivered`);
        // 'skipped-duplicate' is in UploadStatus and watch.ts maps it to a
        // WatchEvent, but nothing emitted it, so the event was unreachable and a
        // tray could only ever show the run-end count. This is the one branch
        // where the reason is exactly 'already delivered': the ledger says so.
        this.emit({ path: candidate.path, hash, status: 'skipped-duplicate' });
        return;
      }

      if (this.claimed.has(hash)) {
        this.totals.skipped += 1;
        this.log.muted(`skip ${name}, the same content is already on its way`);
        return;
      }

      if (this.dryRun) {
        // Nothing is emitted here on purpose: an UploadOutcome describes what
        // happened, and in a dry run nothing happened.
        this.totals.wouldUpload += 1;
        this.log.info(`would upload ${name} · ${formatBytes(candidate.size)}`);
        return;
      }

      // Again, because hashing a large file is not instant and a pause can land
      // in the middle of it.
      if (this.isPaused) {
        this.defer(candidate);
        return;
      }

      this.claimed.add(hash);
      const result = await this.uploadWithRetry(candidate, name, hash);
      if (result.kind !== 'token') {
        this.claimed.delete(hash);
        if (result.kind === 'deferred') {
          this.defer(candidate);
        } else {
          this.totals.failed += 1;
          this.emit({ path: candidate.path, hash, status: 'failed', error: 'upload failed' });
        }
        return;
      }

      this.pending.push({
        candidate,
        hash,
        fileName: name,
        uploadToken: result.token,
        issuedAt: this.now(),
        bytes: this.client?.bytesFor?.(result.token) ?? candidate.size,
      });

      if (this.pending.length >= this.batchSize) {
        await this.flushNow();
      } else {
        this.armQuietTimer();
      }
    } finally {
      this.inFlightPaths.delete(candidate.path);
    }
  }

  private async uploadWithRetry(
    candidate: FileCandidate,
    name: string,
    hash: string,
  ): Promise<UploadResult> {
    const client = this.client;
    if (client === null) return { kind: 'failed' };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return {
          kind: 'token',
          // The hash goes with the path. It is the same sha256 the ledger keys
          // on, and handing it over is what keeps a resumable upload from
          // reading the whole file again just to name its session.
          token: await this.tracked(() => client.uploadFile(candidate.path, hash)),
        };
      } catch (error) {
        const kind = classifyFailure(error);
        if (kind === 'quota') {
          this.pauseUntilTomorrow(messageOf(error));
          return { kind: 'deferred' };
        }
        const lastAttempt = attempt >= this.maxAttempts;
        if (kind === 'permanent' || lastAttempt) {
          this.log.error(`could not upload ${name}: ${messageOf(error)}`);
          return { kind: 'failed' };
        }
        if (this.leaving) {
          // Sitting out a backoff after saying we are leaving would be waiting
          // for nothing. The file is on disk and not in the ledger, so the next
          // startup scan finds it.
          this.log.muted(`${name} is left for the next run`);
          return { kind: 'deferred' };
        }
        const wait = backoffMs(kind, attempt, this.random);
        this.log.warn(
          `${name} did not go through (${messageOf(error)}), trying again in ${formatSeconds(wait)}`,
        );
        await this.sleep(wait);
      }
    }
    return { kind: 'failed' };
  }

  // -------------------------------------------------------------------------
  // Batches
  // -------------------------------------------------------------------------

  private armQuietTimer(): void {
    this.clearQuietTimer();
    this.cancelQuiet = this.schedule(() => {
      this.cancelQuiet = null;
      void this.flush();
    }, this.quietMs);
  }

  private clearQuietTimer(): void {
    if (this.cancelQuiet) {
      this.cancelQuiet();
      this.cancelQuiet = null;
    }
  }

  private clearResumeTimer(): void {
    if (this.cancelResume) {
      this.cancelResume();
      this.cancelResume = null;
    }
  }

  /** Runs inside the chain already. Never call this from outside a chained task. */
  private async flushNow(): Promise<void> {
    this.clearQuietTimer();
    while (this.pending.length > 0) {
      const batch = this.takeBatch();
      if (batch.length === 0) continue;
      await this.createBatch(batch);
    }
  }

  /**
   * Up to batchSize live tokens.
   *
   * An upload token dies after 24 hours. One that got that old is worthless, so
   * the file goes back to the front of the queue for a fresh upload rather than
   * being filed into a silent failure.
   */
  private takeBatch(): PendingItem[] {
    const batch: PendingItem[] = [];
    const deadline = API_LIMITS.UPLOAD_TOKEN_TTL_MS - TOKEN_SAFETY_MARGIN_MS;
    while (this.pending.length > 0 && batch.length < this.batchSize) {
      const item = this.pending.shift();
      if (!item) break;
      if (this.now() - item.issuedAt >= deadline) {
        this.log.warn(`the upload token for ${item.fileName} expired, uploading it again`);
        this.claimed.delete(item.hash);
        this.requeue(item.candidate);
        continue;
      }
      batch.push(item);
    }
    return batch;
  }

  /**
   * One batchCreate, and the two very different things a failure can mean.
   *
   * The call itself failing, a 429 or a dead socket, never reaches the tokens.
   * They are untouched, so the same ones go again, at most maxBatchAttempts
   * times. That number is deliberately small: the transport has its own ladder
   * underneath, five attempts from a thirty second floor, and stacking a second
   * ladder on top of it turns one batch into forty requests against a budget
   * that has to last all day.
   *
   * Individual items coming back not ok is the other case, and it is not a
   * retry at all. Google looked at those tokens, which spends them, so sending
   * the same token again buys nothing but a request. The file goes back for a
   * fresh upload instead, once, and the successful items are never resent.
   */
  private async createBatch(batch: PendingItem[]): Promise<void> {
    const remaining = batch;

    for (let attempt = 1; attempt <= this.maxBatchAttempts; attempt += 1) {
      const items: BatchCreateItem[] = remaining.map((item) => ({
        uploadToken: item.uploadToken,
        fileName: item.fileName,
      }));

      let outcomes: BatchCreateOutcome[];
      try {
        outcomes = await this.tracked(() =>
          this.albumId
            ? this.clientOrThrow().batchCreate(items, this.albumId)
            : this.clientOrThrow().batchCreate(items),
        );
      } catch (error) {
        const kind = classifyFailure(error);
        if (kind === 'quota') {
          // Filing is the only thing that spends the day's budget, so this is
          // the wall itself and no nap moves it. These files are held for the
          // next run rather than called failures: their bytes are sitting at
          // Google unfiled, which costs one more upload tomorrow and nothing
          // else, and the ledger never heard about them.
          this.pauseUntilTomorrow(messageOf(error));
          this.deferAll(remaining);
          return;
        }
        if (kind === 'permanent' || attempt >= this.maxBatchAttempts) {
          this.failAll(remaining, messageOf(error));
          return;
        }
        if (this.leaving) {
          // We said we were leaving. Waiting out a rate limit now would keep
          // the user here for nothing, and these files cost one upload each on
          // the next run.
          this.deferAll(remaining);
          return;
        }
        const wait = backoffMs(kind, attempt, this.random);
        this.log.warn(
          `filing ${plural(remaining.length, 'file')} failed (${messageOf(error)}), trying again in ${formatSeconds(wait)}`,
        );
        await this.sleep(wait);
        continue;
      }

      const byToken = new Map(outcomes.map((outcome) => [outcome.uploadToken, outcome]));
      const refused: PendingItem[] = [];
      let reason = 'Google did not report on this item';

      for (const item of remaining) {
        const outcome = byToken.get(item.uploadToken);
        if (outcome?.ok) {
          await this.record(item, outcome);
        } else {
          if (outcome?.error) reason = outcome.error;
          refused.push(item);
        }
      }

      if (refused.length > 0) this.refile(refused, reason);
      return;
    }
  }

  /**
   * Sends a refused file's bytes again for a fresh token, once.
   *
   * The token that came back not ok has been spent. Uploading again is the only
   * move left, and it costs real bandwidth, so each piece of content gets
   * maxRefiles of them and then waits for the next run. Nothing is lost either
   * way: the file is on disk and it is not in the ledger.
   */
  private refile(items: PendingItem[], reason: string): void {
    for (const item of items) {
      this.claimed.delete(item.hash);
      const used = this.refiles.get(item.hash) ?? 0;

      if (used >= this.maxRefiles) {
        this.refiles.delete(item.hash);
        this.totals.failed += 1;
        this.log.error(`could not file ${item.fileName}: ${reason}`);
        this.emit({
          path: item.candidate.path,
          hash: item.hash,
          status: 'failed',
          error: reason,
        });
        continue;
      }

      this.refiles.set(item.hash, used + 1);
      this.log.warn(
        `${item.fileName} was not filed (${reason}), sending it again for a fresh upload token`,
      );
      this.requeue(item.candidate);
    }
  }

  /**
   * Puts a file back on the chain from inside the chain.
   *
   * The in flight guard is held by whatever task is running right now, and that
   * task may well be the one that just decided this file needs another go, so
   * the guard is released first or the offer would be swallowed as a duplicate.
   */
  private requeue(candidate: FileCandidate): void {
    this.inFlightPaths.delete(candidate.path);
    this.enqueue(candidate);
  }

  private clientOrThrow(): UploadClient {
    if (this.client === null) throw new Error('no Google Photos client in this queue');
    return this.client;
  }

  private async record(item: PendingItem, outcome: BatchCreateOutcome): Promise<void> {
    const entry: LedgerEntry = {
      hash: item.hash,
      size: item.candidate.size,
      bytes: item.bytes,
      firstPath: item.candidate.path,
      uploadedAt: new Date(this.now()).toISOString(),
    };
    if (outcome.mediaItemId) entry.mediaItemId = outcome.mediaItemId;

    /**
     * "The very first photo ever", read at the only moment it is true.
     *
     * This line has to stay above the write and the reason is not stylistic:
     * `add` puts entry one in, so a reader anywhere below this point sees a
     * count of one on the very first delivery of a virgin install, and one is
     * not zero. A condition written downstream is therefore false on the first
     * photo and false forever after, which is a happy toast no user can ever
     * see. `first-ever.test.ts` holds the ordering with a ledger that records
     * what the count was at the moment `add` was called.
     *
     * Per delivery rather than per run, deliberately. The alternative reading,
     * snapshotting emptiness when the ledger is opened and stamping every
     * delivery of that run, gives somebody who drops twelve photos as their
     * first action twelve identical toasts: the same duplicate the M3 review
     * fixed, reached from the other side.
     */
    const firstEver = this.ledger.stats().count === 0;

    try {
      await this.ledger.add(entry);
    } catch (error) {
      // The bytes are at Google and the local record did not survive. Say so
      // loudly: the next run will upload this file a second time.
      this.log.error(
        `${item.fileName} arrived, but the ledger write failed (${messageOf(error)}), so it may be uploaded again`,
      );
    }

    this.claimed.delete(item.hash);
    this.refiles.delete(item.hash);
    this.totals.delivered += 1;
    this.totals.bytes += item.bytes;
    this.log.ok(`delivered ${item.fileName} · ${formatBytes(item.bytes)}`);
    const result: UploadOutcome = { path: item.candidate.path, hash: item.hash, status: 'uploaded' };
    if (outcome.mediaItemId) result.mediaItemId = outcome.mediaItemId;
    // Present only when true, so an absent field reads as "not the first"
    // rather than as "this build did not say".
    if (firstEver) result.firstEver = true;
    this.emit(result);
  }

  /**
   * Hands a whole batch to the next run instead of calling it a failure.
   *
   * The tokens go unused, and Google forgets unfiled bytes on its own. Nothing
   * is lost: the files are still on disk and still absent from the ledger, so
   * the startup scan finds them and they cost one more upload each, not a
   * memory. Saying "failed" here would be the lie the summary used to tell.
   */
  private deferAll(items: PendingItem[]): void {
    for (const item of items) {
      this.claimed.delete(item.hash);
      this.refiles.delete(item.hash);
      this.defer(item.candidate);
    }
  }

  private failAll(items: PendingItem[], reason: string): void {
    for (const item of items) {
      this.claimed.delete(item.hash);
      this.totals.failed += 1;
      this.log.error(`could not file ${item.fileName}: ${reason}`);
      this.emit({
        path: item.candidate.path,
        hash: item.hash,
        status: 'failed',
        error: reason,
      });
    }
  }

  private emit(outcome: UploadOutcome): void {
    this.onOutcome?.(outcome);
  }

  // -------------------------------------------------------------------------
  // The day's request budget
  // -------------------------------------------------------------------------

  private spend(requests: number): void {
    this.totals.requests += requests;
  }

  /**
   * Runs one transport call and books what it actually cost in requests.
   *
   * The transport counts every request it issues, so a 25 MB video that went up
   * as a start plus twenty-five chunks is booked as twenty-six, not as one. A
   * client that does not count falls back to one, which is the old behaviour and
   * an honest floor rather than a guess dressed up as a number.
   *
   * The booking happens whether the call worked or not: a call that failed after
   * four attempts still spent four requests, and pretending otherwise would hide
   * exactly the runs worth looking at.
   */
  private async tracked<T>(work: () => Promise<T>): Promise<T> {
    const client = this.client;
    const before = client?.requestsIssued?.();
    try {
      return await work();
    } finally {
      const after = client?.requestsIssued?.();
      this.spend(
        before !== undefined && after !== undefined ? Math.max(0, after - before) : 1,
      );
    }
  }

  /**
   * The transport keeps the real budget, in a counter file that survives a
   * restart, and refuses rather than spending the last of it mid batch. When
   * that happens the queue holds everything until the day rolls over. Nothing
   * is lost either way: what is not held is still on disk, and the startup scan
   * finds it next time.
   */
  private pauseUntilTomorrow(reason: string): void {
    if (this.holds.has('quota')) return;
    for (const line of reason.split('\n')) this.log.warn(line);
    this.log.warn('holding everything else until tomorrow. nothing is lost, it is all still on disk.');

    const now = new Date(this.now());
    const tomorrow = new Date(now);
    tomorrow.setHours(24, 0, 30, 0);
    const wait = Math.max(60_000, tomorrow.getTime() - now.getTime());
    this.quotaResumesAt = new Date(now.getTime() + wait).toISOString();

    // Held on to, and unref'd. The wait can be most of a day, so a user who
    // presses ctrl+c after this must not be kept waiting for a timer that has
    // nothing left to do.
    this.clearResumeTimer();
    this.cancelResume = this.schedule(
      () => {
        this.cancelResume = null;
        this.liftQuotaHold();
      },
      wait,
      { unref: true },
    );

    // The transport's own sentence goes with it: it names the budget and the
    // day, and a caller composing "you are out of requests" from the reason
    // alone would be throwing away the only numbers in the message.
    this.hold('quota', this.quotaResumesAt, reason);
  }

  /** The day rolled over. Lifts only the budget's own hold. */
  private liftQuotaHold(): void {
    this.clearResumeTimer();
    if (!this.holds.delete('quota')) return;
    this.quotaResumesAt = undefined;
    if (this.holds.size > 0) {
      // A new day, and the user's pause is still on. Saying "taking files
      // again" here would be a lie, and it is the lie that would send somebody
      // looking for a bug in the watcher.
      this.log.info('a new day, and the budget is back. still paused, so nothing moves yet.');
      // The budget's hold is off even though the queue is not running, and a
      // listener that shows one state per reason has to hear it: the amber
      // "Google limit reached, back at 00:00" has no other clearing condition,
      // and midnight is exactly when it stops being true.
      this.onResumed?.('quota', 0);
      return;
    }
    this.letGo('quota');
  }

  /**
   * Starts holding for one reason, once.
   *
   * The quiet timer goes with it: a part full batch waiting to be filed is a
   * call to Google that has not happened yet, and a paused queue makes no calls.
   * Whatever is already uploaded stays held and is filed when the hold lifts,
   * or by the drain on the way out, whichever comes first.
   */
  private hold(reason: PauseReason, resumesAt?: string, detail?: string): void {
    if (this.holds.has(reason)) return;
    this.holds.add(reason);
    this.clearQuietTimer();
    this.onPaused?.(reason, resumesAt, detail);
  }

  /** The last hold has gone. Announce it, then let everything that piled up in. */
  private letGo(lifted: PauseReason): void {
    const waiting = this.deferred.splice(0);
    this.totals.deferred = Math.max(0, this.totals.deferred - waiting.length);
    const opening = lifted === 'quota' ? 'a new day' : 'carrying on';
    this.log.info(
      waiting.length === 0
        ? `${opening}, taking files again`
        : `${opening}, picking up the ${plural(waiting.length, 'file')} that were waiting`,
    );
    // Before the work starts, so a listener hears "running again" and then the
    // deliveries, rather than deliveries from a queue it still believes is held.
    this.onResumed?.(lifted, waiting.length);
    for (const candidate of waiting) this.enqueue(candidate);
    // Tokens that were uploaded before the pause are still waiting for a batch,
    // and the timer that would have filed them was dropped when the hold went on.
    if (this.pending.length > 0) this.armQuietTimer();
  }

  private defer(candidate: FileCandidate): void {
    if (this.deferred.length >= MAX_DEFERRED_FILES) {
      this.totals.dropped += 1;
      return;
    }
    this.deferred.push(candidate);
    this.totals.deferred += 1;
  }
}
