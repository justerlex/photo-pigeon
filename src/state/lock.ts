/**
 * The single instance guard.
 *
 * Two photo-pigeons watching the same folders against the same ledger is not a
 * cosmetic problem. Both hash the same file, both find it absent from the
 * ledger, both upload it, and Google ends up with the photo twice while the
 * ledger records it once. The content hash makes a second *run* free; it does
 * nothing about a second run happening at the same moment.
 *
 * So the ledger's folder carries a lock file, and `watch` refuses to start when
 * somebody already holds it, naming the pid so the user can go and look.
 *
 * The hard part is not taking the lock, it is deciding that an existing one is
 * rubbish. A lock file outlives its owner every time the process is killed
 * rather than asked to stop, and on Windows that is the normal way a process
 * dies: the tray bench in watch.ts shows that every signal a parent can send is
 * a TerminateProcess, so there is no exit hook, no drain, and no cleanup. A lock
 * that could not be judged stale would therefore wedge the tool permanently
 * after the first hard stop, which is worse than no lock at all.
 *
 * Three tests decide it, cheapest first:
 *
 *  1. Is the pid still there? `process.kill(pid, 0)` answers without touching
 *     the process: ESRCH means gone, EPERM means alive and owned by somebody
 *     else. Both verified on this machine, win32, node 22.
 *  2. Is it the same process? A pid is a small recycled number, so a live pid
 *     alone proves nothing. When the lock names our own pid we settle it
 *     exactly, by comparing start times. For anybody else's pid the platform
 *     has to be asked, which node cannot do out of the box, so `startedAtOf`
 *     is a seam: supply it and pid reuse is caught exactly, leave it out and
 *     the answer is "unknown" and we fall through to the next test.
 *  3. Is it still breathing? The holder touches the lock file's mtime every
 *     half minute. Nothing touched for five minutes, with a pid that is alive
 *     but unverifiable, is an abandoned lock whose number got recycled.
 *
 * Test 3 is the one that decides every real run, because `startedAtOf` is a
 * seam nothing in production supplies, and it is a piece of evidence rather
 * than a proof: a wall clock that jumps forward, an event loop that stalls, or
 * an `utimes` a filter driver refuses all make a healthy holder look abandoned.
 * So a cold heartbeat is answered with two more things rather than a steal.
 *
 *  4. Before the steal, one second look. A lock whose pid is alive and whose
 *     identity cannot be proved is watched for slightly longer than a
 *     heartbeat. A holder that is really there touches the file in that window
 *     and keeps its lock; a lock that stays cold for the whole window really
 *     is abandoned. This costs one pause at start, only in the ambiguous case.
 *  5. The holder defends itself. Every heartbeat re-reads the file first: a
 *     record that is no longer ours means we were judged stale and robbed, and
 *     the only safe answer is to stand down, which `onLost` says out loud so
 *     the run can stop rather than deliver against a ledger somebody else is
 *     now writing. A file that has vanished under us is taken back with an
 *     exclusive create, because a thief that exits deletes the lock and would
 *     otherwise leave this ledger guarded by nothing at all.
 *
 * Stealing is deliberately once-only. Several processes can decide the same
 * lock is stale in the same millisecond, and if they all just wrote their own
 * pid into it they would all believe they won. So the steal goes through an
 * exclusive create of a claim file, which exactly one of them can win; the
 * others are told the lock is contended and stay out.
 *
 * Nothing in this file reads or writes anything to do with Google. It deals in
 * one small JSON file next to the ledger.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The lock file's name. Derived from the ledger's folder, never configured. */
export const LOCK_FILE_NAME = 'watch.lock';

/** A live holder touches the lock this often, so an abandoned one can be told apart. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** No heartbeat for this long, with a pid we cannot verify, and the lock is abandoned. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

/** A steal claim nobody finished is itself abandoned after this long. */
export const CLAIM_GRACE_MS = 15_000;

/**
 * How long a steal watches a cold lock before taking it.
 *
 * Longer than one heartbeat on purpose: a holder that is really alive touches
 * the file inside this window, so the window is what turns "the mtime is old"
 * from the sole verdict into the first half of one. Only paid when the pid is
 * alive and cannot be identified, which is the case that would otherwise rob a
 * live watcher over a clock jump, a resumed laptop, or a stalled event loop.
 */
export const DEFAULT_OBSERVE_MS = DEFAULT_HEARTBEAT_MS + 5_000;

/**
 * Slack when comparing two start times for the same pid.
 *
 * One side is measured from inside the process (`Date.now() - uptime`) and the
 * other may come from the operating system, so they agree to within a scheduling
 * hiccup rather than to the millisecond.
 */
export const START_TIME_TOLERANCE_MS = 2_000;

/** Who holds the lock, written as one line of JSON. Nothing secret is ever in here. */
export interface LockRecord {
  /** Process id of the holder. */
  pid: number;
  /** Epoch milliseconds the holding process started, so a recycled pid is not mistaken for it. */
  startedAt: number;
  /** ISO 8601 moment the lock was taken, for the human reading the file. */
  takenAt: string;
  /** Machine name, so a lock file synced to another machine is obviously not local. */
  host: string;
  /** What took it, currently always 'watch'. */
  holder: string;
}

/** A lock this process holds. Release it when the work is done. */
export interface Lock {
  /** Absolute path of the lock file. */
  readonly path: string;
  /** What we wrote into it. */
  readonly record: LockRecord;
  /** True when this lock was taken over from a holder judged stale. */
  readonly stolen: boolean;
  /** Stop the heartbeat and remove the file, but only while it still names us. */
  release(): Promise<void>;
}

/** Why a process that was holding the lock is not safely holding it any more. */
export type LockLoss =
  /**
   * The file names somebody else now. We were judged stale and taken over, so
   * two processes are pointed at one ledger and this one has to stand down.
   */
  | 'stolen'
  /**
   * We still hold it, and we can no longer say so: the heartbeat has failed
   * for longer than the stale window, so anybody starting up will read this
   * lock as abandoned. Not a reason to stop, and very much a reason to say so.
   */
  | 'unverifiable';

/** Why an acquire came back empty handed. */
export type LockRefusal =
  /** Somebody is genuinely running. */
  | 'held'
  /** The lock is stale, and another process is in the middle of taking it over. */
  | 'contended';

/** What an acquire came to. */
export type LockResult =
  | { ok: true; lock: Lock }
  | { ok: false; reason: LockRefusal; heldBy: LockRecord };

/** Knobs. Everything optional: the ordinary call is `acquireLock(config.ledgerPath)`. */
export interface LockOptions {
  /** What to record as the holder. Defaults to 'watch'. */
  holder?: string;
  /** Clock in epoch milliseconds, injectable. */
  now?: () => number;
  /** True when a process with this pid exists. Defaults to a `kill(pid, 0)` probe. */
  probe?: (pid: number) => boolean;
  /**
   * When the platform can say when a pid started, this answers it and pid reuse
   * is caught exactly. Returning undefined means "cannot tell", which is what
   * node alone can say about somebody else's process.
   */
  startedAtOf?: (pid: number) => number | undefined;
  /** How long a lock may go untouched before it counts as abandoned. */
  staleAfterMs?: number;
  /**
   * How long to watch a cold lock whose pid is alive before taking it over.
   *
   * Zero looks once and takes it, which is the old behaviour and is what the
   * tests want. In a real run this is longer than a heartbeat, so a holder
   * that is alive gets the chance to prove it.
   */
  observeMs?: number;
  /** How often to touch our own lock. Zero turns the heartbeat off, for tests. */
  heartbeatMs?: number;
  /**
   * Told when this process stops being the safe holder of the lock it took.
   *
   * Called at most once for 'stolen' and at most once for 'unverifiable'. The
   * caller is the one that knows what standing down means: this module only
   * knows that carrying on would put two writers on one ledger.
   */
  onLost?: (loss: LockLoss, heldBy: LockRecord | null) => void;
  /** Also try to remove the lock from a process exit hook. Best effort, and never enough on its own. */
  releaseOnExit?: boolean;
}

/** The lock file that guards this ledger. Same folder as the ledger, fixed name. */
export function lockPathFor(ledgerPath: string): string {
  return path.join(path.dirname(path.resolve(ledgerPath)), LOCK_FILE_NAME);
}

const claimPathFor = (lockPath: string): string => `${lockPath}.claim`;

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

/**
 * When this process started, epoch milliseconds.
 *
 * Computed once and remembered. `process.uptime()` keeps moving, so working it
 * out twice gives two slightly different answers, and this number is compared
 * for equality with itself across the life of the lock.
 */
let selfStart: number | undefined;
export function selfStartedAt(): number {
  if (selfStart === undefined) selfStart = Math.round(Date.now() - process.uptime() * 1000);
  return selfStart;
}

/**
 * True when some process is using this pid right now.
 *
 * Signal 0 sends nothing; it only asks the kernel whether the pid resolves.
 * ESRCH is the only answer that means gone. EPERM means the pid exists and
 * belongs to somebody else, which for our purposes is very much alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

/** One sentence naming the holder, for a refusal a human has to act on. */
export function describeHolder(record: LockRecord): string {
  const where = record.host && record.host !== os.hostname() ? ` on ${record.host}` : '';
  const since = record.takenAt ? `, running since ${record.takenAt}` : '';
  return `pid ${record.pid}${where}${since}`;
}

function parseRecord(text: string): LockRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const pid = typeof value.pid === 'number' && Number.isInteger(value.pid) ? value.pid : 0;
  if (pid <= 0) return null;
  return {
    pid,
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    takenAt: typeof value.takenAt === 'string' ? value.takenAt : '',
    host: typeof value.host === 'string' ? value.host : '',
    holder: typeof value.holder === 'string' ? value.holder : 'watch',
  };
}

/** A lock file with a torn or hand mangled body is not a record of anything, so it reads as stale. */
const UNREADABLE: LockRecord = { pid: 0, startedAt: 0, takenAt: '', host: '', holder: 'unknown' };

type FoundLock = { record: LockRecord; mtimeMs: number } | 'gone';

async function readLockFile(lockPath: string): Promise<FoundLock> {
  let text: string;
  let mtimeMs: number;
  try {
    const handle = await fs.open(lockPath, 'r');
    try {
      const stat = await handle.stat();
      mtimeMs = stat.mtimeMs;
      text = (await handle.readFile()).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return 'gone';
    throw error;
  }
  return { record: parseRecord(text) ?? UNREADABLE, mtimeMs };
}

/** Reads whoever currently holds this ledger's lock, or null when nobody does. */
export async function readLock(ledgerPath: string): Promise<LockRecord | null> {
  const found = await readLockFile(lockPathFor(ledgerPath));
  return found === 'gone' ? null : found.record;
}

const sameProcess = (a: LockRecord, b: LockRecord): boolean =>
  a.pid === b.pid && a.startedAt === b.startedAt;

interface Judgement {
  now: number;
  probe: (pid: number) => boolean;
  startedAtOf: (pid: number) => number | undefined;
  staleAfterMs: number;
}

/**
 * What one reading of the lock file amounts to.
 *
 * Held and stale are verdicts. Unproven is not: it is the honest name for the
 * case where the only evidence of death is an mtime, which is a thing a clock
 * jump or a refused `utimes` can fake. It is answered by watching the file for
 * a moment rather than by acting, and only `acquireLock` can do that.
 */
export type LockVerdict = 'held' | 'stale' | 'unproven';

/** Held means somebody is really running. Stale means the file outlived its owner. */
export function judgeLock(record: LockRecord, mtimeMs: number, ctx: Judgement): LockVerdict {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return 'stale';

  // Our own pid is the one case we can always settle exactly, and it is not
  // academic: a lock left by an earlier process whose number we inherited would
  // otherwise be judged held, by us, because we are demonstrably alive.
  if (record.pid === process.pid) {
    return Math.abs(record.startedAt - selfStartedAt()) <= START_TIME_TOLERANCE_MS ? 'held' : 'stale';
  }

  if (!ctx.probe(record.pid)) return 'stale';

  const actualStart = ctx.startedAtOf(record.pid);
  if (actualStart !== undefined && Math.abs(actualStart - record.startedAt) > START_TIME_TOLERANCE_MS) {
    return 'stale';
  }

  // Alive, and we cannot prove it is the same process. The heartbeat is the
  // only thing left, and one cold reading of it is not enough to rob somebody:
  // the caller watches the file for a moment before it acts.
  if (ctx.now - mtimeMs > ctx.staleAfterMs) return 'unproven';

  return 'held';
}

/** What the second look at a cold lock came to. */
type SecondLook =
  /** Nothing touched it for the whole window. Abandoned, as far as anything can tell. */
  | { verdict: 'cold' }
  /** It moved. Somebody is in there, whatever the first reading said. */
  | { verdict: 'breathing'; record: LockRecord }
  /** Gone, or somebody else's now. Not ours to judge any more: start the pass again. */
  | { verdict: 'changed' };

/**
 * Watches one cold lock for slightly longer than a heartbeat.
 *
 * This is the whole defence against robbing a live watcher, and it is cheap
 * because it is never reached by the ordinary stale lock: a holder that was
 * killed leaves a pid that answers ESRCH, and that is settled two tests
 * earlier without waiting for anything.
 */
async function watchForABeat(
  lockPath: string,
  before: { record: LockRecord; mtimeMs: number },
  observeMs: number,
): Promise<SecondLook> {
  if (observeMs > 0) {
    // Deliberately not unref'd: this wait is the decision, so the process has
    // to stay up for it.
    await new Promise<void>((resolve) => setTimeout(resolve, observeMs));
  }
  const again = await readLockFile(lockPath).catch(() => 'gone' as const);
  if (again === 'gone') return { verdict: 'changed' };
  if (!sameProcess(again.record, before.record)) return { verdict: 'changed' };
  if (again.mtimeMs > before.mtimeMs) return { verdict: 'breathing', record: again.record };
  return { verdict: 'cold' };
}

function serialize(record: LockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Takes the lock when the file does not exist yet. False means somebody beat us to it. */
async function writeFresh(lockPath: string, record: LockRecord): Promise<boolean> {
  try {
    const handle = await fs.open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialize(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Replaces a stale lock's contents in one step.
 *
 * Written to a temp file in the same folder and renamed over, so a reader never
 * sees a half written record and mistakes it for garbage. Windows refuses a
 * rename while somebody has the target open, and those handles live for
 * milliseconds, so it is worth waiting out rather than failing the start.
 */
async function writeOver(lockPath: string, record: LockRecord): Promise<void> {
  const tmp = `${lockPath}.${process.pid.toString(36)}${randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(serialize(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const delays = [5, 20, 60, 150, 350];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, lockPath);
      return;
    } catch (error) {
      const code = codeOf(error);
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!retryable || attempt >= delays.length) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/**
 * Wins, or loses, the right to take over one stale lock.
 *
 * Exclusive create is the whole mechanism: the filesystem picks a single winner
 * among any number of simultaneous callers. A claim whose owner died before it
 * finished would otherwise wedge the lock forever, so a claim older than the
 * grace period is swept and the attempt is made once more.
 */
async function claimSteal(lockPath: string, record: LockRecord, nowMs: number): Promise<boolean> {
  const claim = claimPathFor(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(claim, 'wx', 0o600);
      try {
        await handle.writeFile(serialize(record));
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
      const stat = await fs.stat(claim).catch(() => null);
      if (stat === null) continue;
      if (nowMs - stat.mtimeMs > CLAIM_GRACE_MS) {
        await fs.rm(claim, { force: true }).catch(() => undefined);
        continue;
      }
      return false;
    }
  }
  return false;
}

function makeLock(
  lockPath: string,
  record: LockRecord,
  stolen: boolean,
  options: LockOptions,
): Lock {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now;
  let released = false;
  let lost = false;
  let beating = false;
  let missedBeats = 0;
  let saidUnverifiable = false;

  let beat: ReturnType<typeof setInterval> | null = null;

  const announce = (loss: LockLoss, heldBy: LockRecord | null): void => {
    try {
      options.onLost?.(loss, heldBy);
    } catch {
      // A listener that falls over does not get to decide we still hold this.
    }
  };

  /** We are not the holder any more. Said once, and the beating stops with it. */
  const standDown = (heldBy: LockRecord | null): void => {
    if (lost) return;
    lost = true;
    if (beat) clearInterval(beat);
    announce('stolen', heldBy);
  };

  /**
   * One heartbeat: check the lock is still ours, then say we are alive.
   *
   * The check comes first and it is the point. Nothing else in this module
   * looks at the lock again once it has been taken, so a holder that was
   * judged stale and taken over would otherwise carry on delivering against a
   * ledger a second process is now writing, which is the exact duplicate this
   * file exists to prevent. Reading a small JSON file every half minute is a
   * cheap price for noticing.
   */
  const beatOnce = async (): Promise<void> => {
    if (released || lost || beating) return;
    beating = true;
    try {
      const found = await readLockFile(lockPath).catch(() => null);

      if (found === 'gone') {
        // A thief that judged us stale removes the lock when it exits, which
        // leaves this ledger guarded by nothing while we are still watching.
        // Exclusive create is the safe way to take it back: if somebody has
        // it, the create fails and we really are out.
        if (released || lost) return;
        if (await writeFresh(lockPath, record).catch(() => false)) {
          missedBeats = 0;
          // A release that landed while that was in flight would have found
          // nothing to remove, so the file we just wrote would outlive the run
          // and be somebody else's problem to judge. Take it back out.
          if (released) await fs.rm(lockPath, { force: true }).catch(() => undefined);
          return;
        }
        const after = await readLockFile(lockPath).catch(() => null);
        standDown(after !== null && after !== 'gone' ? after.record : null);
        return;
      }

      if (found !== null && !sameProcess(found.record, record)) {
        standDown(found.record);
        return;
      }

      if (released || lost) return;
      const at = new Date(now());
      try {
        await fs.utimes(lockPath, at, at);
      } catch {
        if (released || lost) return;
        // utimes is the cheap way to say "still here", not the only way. A
        // filter driver or a network share that refuses it would otherwise
        // leave a healthy holder looking abandoned forever, and looking
        // abandoned is how a live watcher gets robbed. Rewriting the record
        // moves the mtime too, so it says the same thing more expensively.
        await writeOver(lockPath, record);
      }
      missedBeats = 0;
    } catch {
      // Neither way of saying "still here" worked. Nobody has taken the lock
      // yet, so this is not a stand down; it is the warning that one is now
      // possible, said once, when we have been silent long enough to look dead.
      missedBeats += 1;
      if (!saidUnverifiable && missedBeats * heartbeatMs >= staleAfterMs) {
        saidUnverifiable = true;
        announce('unverifiable', null);
      }
    } finally {
      beating = false;
    }
  };

  // Unref'd on purpose. The heartbeat exists so somebody else can tell we are
  // still here; it must never be the reason this process refuses to exit.
  if (heartbeatMs > 0) {
    beat = setInterval(() => void beatOnce(), heartbeatMs);
    beat.unref?.();
  }

  /**
   * Best effort cleanup on a normal exit. It cannot run when the process is
   * terminated rather than asked to leave, which on Windows is every signal a
   * parent can send, so the stale detection above is the real answer and this
   * is only here to keep an ordinary `photo-pigeon watch` tidy.
   */
  const onExit = (): void => {
    if (released) return;
    try {
      const found = parseRecord(readFileSync(lockPath, 'utf8'));
      if (found !== null && sameProcess(found, record)) rmSync(lockPath, { force: true });
    } catch {
      // Exiting. Nothing here is worth a noise on the way out.
    }
  };
  if (options.releaseOnExit) process.on('exit', onExit);

  return {
    path: lockPath,
    record,
    stolen,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (beat) clearInterval(beat);
      if (options.releaseOnExit) process.off('exit', onExit);
      // Only ever remove a lock that still names us. If somebody judged us
      // stale and took it over, that file is theirs now and deleting it would
      // hand the folder to a third process.
      const found = await readLockFile(lockPath).catch(() => 'gone' as const);
      if (found === 'gone' || !sameProcess(found.record, record)) return;
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    },
  };
}

/**
 * Takes the ledger folder's lock, or explains who has it.
 *
 * Never throws for the ordinary "somebody else is running" case: that is a
 * result, not an error, because the caller has a sentence to print and an exit
 * code to choose.
 */
export async function acquireLock(ledgerPath: string, options: LockOptions = {}): Promise<LockResult> {
  const lockPath = lockPathFor(ledgerPath);
  const now = options.now ?? Date.now;
  const ctx: Judgement = {
    now: now(),
    probe: options.probe ?? isProcessAlive,
    startedAtOf: options.startedAtOf ?? ((): number | undefined => undefined),
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  };
  const observeMs = options.observeMs ?? DEFAULT_OBSERVE_MS;
  // One second look per acquire. A lock that was watched for a full heartbeat
  // and never moved has been given its chance, and two windows in one start
  // would only make a slow start slower.
  let watched = false;

  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const mine: LockRecord = {
    pid: process.pid,
    startedAt: selfStartedAt(),
    takenAt: new Date(now()).toISOString(),
    host: os.hostname(),
    holder: options.holder ?? 'watch',
  };

  // Two passes at most. The second exists for the one honest race: the holder
  // released between our exclusive create failing and our read of the file.
  for (let pass = 0; pass < 2; pass += 1) {
    if (await writeFresh(lockPath, mine)) {
      return { ok: true, lock: makeLock(lockPath, mine, false, options) };
    }

    const found = await readLockFile(lockPath);
    if (found === 'gone') continue;

    const verdict = judgeLock(found.record, found.mtimeMs, ctx);
    if (verdict === 'held') {
      return { ok: false, reason: 'held', heldBy: found.record };
    }

    // Alive, unidentifiable, and cold. That is the reading a clock jump, a
    // resumed laptop or a refused utimes can produce for a holder that is
    // perfectly healthy, so it is watched rather than believed.
    if (verdict === 'unproven' && !watched) {
      watched = true;
      const second = await watchForABeat(lockPath, found, observeMs);
      // The clock moved while we waited, and the claim grace below is measured
      // against it.
      ctx.now = now();
      if (second.verdict === 'breathing') {
        return { ok: false, reason: 'held', heldBy: second.record };
      }
      // Gone, or somebody else's. Whatever we judged is not on disk any more,
      // so the next pass reads it fresh instead of acting on a stale reading.
      if (second.verdict === 'changed') continue;
    }

    if (!(await claimSteal(lockPath, mine, ctx.now))) {
      // Somebody else is taking this one over. If they have already finished,
      // say who won rather than reporting the ghost we happened to read first.
      const again = await readLockFile(lockPath);
      if (again !== 'gone' && !sameProcess(again.record, found.record)) {
        return { ok: false, reason: 'held', heldBy: again.record };
      }
      return { ok: false, reason: 'contended', heldBy: found.record };
    }

    try {
      // Compare and swap, and the reason the steal is once only rather than
      // nearly once only. Winning the claim is not enough on its own: a claim
      // is released the moment its winner has finished writing, so a slower
      // racer that decided this lock was stale several milliseconds ago could
      // pick the claim straight back up and overwrite a lock that is now live.
      // So the stale record we judged has to still be the record on disk.
      const confirm = await readLockFile(lockPath);
      if (confirm !== 'gone' && !sameProcess(confirm.record, found.record)) {
        const verdict = judgeLock(confirm.record, confirm.mtimeMs, ctx);
        return {
          ok: false,
          reason: verdict === 'held' ? 'held' : 'contended',
          heldBy: confirm.record,
        };
      }
      await writeOver(lockPath, mine);
    } finally {
      await fs.rm(claimPathFor(lockPath), { force: true }).catch(() => undefined);
    }
    return { ok: true, lock: makeLock(lockPath, mine, true, options) };
  }

  // Both passes lost the same race, which means somebody took it in between.
  const last = await readLockFile(lockPath);
  return {
    ok: false,
    reason: 'contended',
    heldBy: last === 'gone' ? UNREADABLE : last.record,
  };
}
