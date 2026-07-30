/**
 * The rehash side index: a cache that lets an unchanged file skip its sha256.
 *
 * The problem it exists for is start-at-login. Every start reconciles, the walk
 * enumerates everything on disk, and the queue hashes every candidate it is
 * offered. That is correct and it is also 100 GB of reading per logon for
 * somebody with a 100 GB library. Once a day it is a nuisance. On a laptop that
 * is opened and closed six times a day it is a fan, a hot lap and a dead
 * battery, and the answer every single time is "yes, still the same file".
 *
 * So this file remembers the answer. It maps an absolute path to the size, the
 * mtime and the sha256 that were true last time we really read the bytes. When
 * a candidate arrives with the same path, the same size and the same mtime, the
 * recorded hash is handed back and the file is never opened.
 *
 * Three rules keep this from becoming a second source of truth:
 *
 *  1. The content hash stays the authority. This index produces a hash and
 *     nothing else. The has/skip/upload decision is still made against the
 *     ledger, on a hash, every time. There is no path in this codebase where
 *     the index alone decides that a file has been delivered.
 *  2. It is a cache, so it is allowed to be wrong by being absent. Missing,
 *     truncated, corrupt, written by a future version: every one of those means
 *     "no shortcut today", the file is read, and the index rebuilds itself. It
 *     can cost bandwidth. It can never cost a photo.
 *  3. Only a hash this process computed from the file's own bytes is ever
 *     written down. Nothing here invents a hash or copies one from the ledger.
 *
 * The honest limitation
 * ---------------------
 * A byte edit that preserves both the size and the mtime defeats the shortcut:
 * we would hand back the old hash for new bytes, and if the old hash is in the
 * ledger the new bytes are never uploaded. That is a real hole and it is worth
 * being precise about how it gets opened, because on a photo shelf it does not.
 *
 * Writing to a file moves its mtime. Every tool does this, because the
 * filesystem does it, not the tool. To land in this hole a program has to edit
 * the bytes in place, keep the length identical to the byte, and then explicitly
 * restore the old mtime with utimes. Cameras do not do that: a camera writes a
 * new file. Card copies, Explorer copies, phone imports, AirDrop, WhatsApp
 * saves, screenshots, exports out of Lightroom or Photoshop: all of them write a
 * new file with a fresh mtime, and most of them a different size too. Editors
 * that do rewrite in place, which is already rare for photos and video, still
 * let the mtime move.
 *
 * So the shortcut is wrong only for a file somebody deliberately backdated after
 * editing. Against that we are trading a certainty: without this index, a person
 * who starts photo-pigeon with Windows re-reads their whole library every time
 * they log in, forever. The trade is worth taking, and this paragraph is here so
 * nobody has to rediscover which way it was taken. If it ever needs closing, the
 * closing move is a config switch that turns the index off, not a cleverer
 * heuristic: there is no heuristic short of reading the bytes.
 *
 * Nothing in this file talks to the network, and nothing in it can delete or
 * change anything at Google. It is a local cache of local facts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileCandidate } from '../contracts.js';
import { writeFileAtomic } from '../wizard/atomic.js';

/** Name of the cache, kept beside the ledger, because they describe the same library. */
export const SIDE_INDEX_FILE_NAME = 'sideindex.jsonl';

/** Shape marker. A file with any other version is treated as absent and rebuilt. */
export const SIDE_INDEX_VERSION = 1;

/** How long a burst of new hashes is allowed to gather before it is written down. */
export const DEFAULT_DEBOUNCE_MS = 2_000;

/**
 * Entries kept at most. A quarter million photos is far past any shelf this
 * tool is aimed at, and the cap is what stops a cache from becoming a leak on a
 * machine that churns through temp folders for years.
 */
export const DEFAULT_MAX_ENTRIES = 250_000;

/** Rewrite the file when it holds this many times more lines than live entries. */
const COMPACT_RATIO = 2;

/** Never compact a file smaller than this, however lopsided the ratio looks. */
const COMPACT_FLOOR_LINES = 1_000;

/** A lowercase hex sha256 and nothing else. A malformed hash is not a shortcut. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Where a note about the cache goes. Silent by default: a cache miss is not news. */
export type WarnFn = (message: string) => void;

/** One remembered answer: these stat fields went with this hash last time we read the bytes. */
export interface SideIndexEntry {
  /** Absolute path as it was seen, kept readable for a human opening the file. */
  path: string;
  /** Size in bytes at the moment the hash was computed. */
  size: number;
  /** Last modified time, epoch milliseconds, at the moment the hash was computed. */
  mtimeMs: number;
  /** sha256 of the contents, lowercase hex. Computed from the real bytes, never inferred. */
  hash: string;
}

/** What the shortcut has been worth this session. Reported, not acted on. */
export interface SideIndexStats {
  /** Live entries held in memory. */
  entries: number;
  /** Candidates that took the shortcut: files that were never opened. */
  hits: number;
  /** Candidates that had to be read for real. */
  misses: number;
  /** Bytes not read because of the shortcut. This is the number the feature exists for. */
  bytesNotRead: number;
}

/**
 * The cache the queue talks to.
 *
 * lookup is synchronous and touches no disk on purpose: it sits in the hot path
 * of every candidate, and a cache that costs a syscall to consult would have
 * given back a good part of what it saves.
 */
export interface SideIndex {
  /**
   * The recorded hash when the path, the size and the mtime all still match.
   * undefined for anything new, changed or unknown, which means "read it".
   */
  lookup(candidate: FileCandidate): string | undefined;
  /**
   * Write down a hash that was genuinely computed from this file's bytes.
   *
   * Pass the candidate the hash was computed for, with the size and mtime it
   * carried when it was discovered. Those are deliberately the numbers from
   * *before* the read, not a fresh stat taken after it, and the difference is a
   * safety property rather than a saved syscall. If the file is rewritten while
   * we are hashing it, the discovery mtime no longer matches what is on disk,
   * so the next run sees a mismatch and reads the file again. A stat taken
   * after the read would instead record the new file's numbers against the old
   * file's hash, and that pairing is exactly the wrong answer this index must
   * never be able to give.
   *
   * Returns immediately. The disk write is debounced, so a folder of ten
   * thousand photos costs a handful of appends rather than ten thousand fsyncs.
   */
  remember(candidate: FileCandidate, hash: string): void;
  /** Put everything still pending on disk. Never rejects: this is a cache. */
  flush(): Promise<void>;
  /** Flush, then drop the timer. Call it when the run is over. Never rejects. */
  close(): Promise<void>;
  /** Counters for the summary. */
  readonly stats: SideIndexStats;
}

/**
 * The three file operations the index needs, injectable so a test can watch
 * them. Real runs get the node ones and the atomic rename from wizard/atomic.
 */
export interface SideIndexIo {
  /** Read the whole file, rejecting with an ENOENT-coded error when it is not there. */
  readFile(filePath: string): Promise<string>;
  /** Append text. Deliberately not flushed: see the debounce note in flush. */
  appendFile(filePath: string, data: string): Promise<void>;
  /** Replace the whole file so a reader never sees it half written. */
  writeFileAtomic(filePath: string, data: string): Promise<void>;
}

/** Cancels a scheduled callback. */
export type CancelTimer = () => void;

/** setTimeout, injectable so the debounce can be driven by hand in tests. */
export type SideIndexSchedule = (callback: () => void, ms: number) => CancelTimer;

/** Knobs. Everything optional: openSideIndex(path) is the whole API for a real run. */
export interface SideIndexOptions {
  /** Told when the cache had to throw itself away or could not be written. Silent by default. */
  onWarning?: WarnFn;
  /** How long a burst gathers before it is written. */
  debounceMs?: number;
  /** Entries kept before the oldest are dropped. */
  maxEntries?: number;
  /** Timer, injectable. */
  schedule?: SideIndexSchedule;
  /** File operations, injectable. */
  io?: SideIndexIo;
}

/** The cache lives beside the ledger, the way sessions.json does. */
export function sideIndexPathFor(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), SIDE_INDEX_FILE_NAME);
}

/**
 * The key one file is filed under.
 *
 * Case folded on Windows, where two spellings of one path are one file. This is
 * the same rule the startup walk uses to dedupe, and it has to stay the same
 * rule: a walk that hands over C:\Photos\a.jpg and an index filed under
 * c:\photos\a.jpg would miss every time and quietly do nothing at all.
 */
function keyFor(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite, non negative number, or null. Sizes and mtimes are both. */
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Read one line back into an entry, refusing anything that is not obviously
 * sound.
 *
 * Strict on purpose, and the strictness about the hash is the load bearing
 * part. Everything this file hands back becomes a ledger lookup, so a line that
 * is not a real sha256 must never leave here. A malformed line is dropped and
 * the file gets read for real, which is the failure this whole module is built
 * to fall back to.
 */
function parseEntry(text: string): SideIndexEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const filePath = typeof raw.path === 'string' ? raw.path : '';
  const hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : '';
  const size = numberOrNull(raw.size);
  const mtimeMs = numberOrNull(raw.mtimeMs);

  if (filePath === '' || size === null || mtimeMs === null) return null;
  if (!SHA256_HEX.test(hash)) return null;

  return { path: filePath, size, mtimeMs, hash };
}

/** Explicit key order so the file stays pleasant to read by hand. */
function serializeEntry(entry: SideIndexEntry): string {
  return JSON.stringify({
    path: entry.path,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    hash: entry.hash,
  });
}

function headerLine(): string {
  return JSON.stringify({ index: 'photo-pigeon-sideindex', version: SIDE_INDEX_VERSION });
}

/** True when this line is a header this build knows how to append to. */
function isOurHeader(text: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  return (
    isRecord(raw) && raw.index === 'photo-pigeon-sideindex' && raw.version === SIDE_INDEX_VERSION
  );
}

/** The default file operations: plain node, plus the atomic rename for rewrites. */
export function nodeSideIndexIo(): SideIndexIo {
  return {
    readFile: (filePath: string) => fs.readFile(filePath, 'utf8'),
    appendFile: (filePath: string, data: string) => fs.appendFile(filePath, data, { mode: 0o600 }),
    writeFileAtomic: (filePath: string, data: string) => writeFileAtomic(filePath, data),
  };
}

/** What reading the file produced, before any of it is trusted. */
interface LoadResult {
  entries: SideIndexEntry[];
  /**
   * True when the file on disk cannot be appended to as it stands: absent,
   * headerless, a version we do not know, or torn. The next write replaces it
   * wholesale instead of gluing new lines onto something we do not understand.
   */
  needsRewrite: boolean;
  /** Entry lines the file actually holds, so compaction knows how lopsided it has become. */
  linesOnDisk: number;
}

async function loadFile(indexPath: string, io: SideIndexIo, warn: WarnFn): Promise<LoadResult> {
  let text: string;
  try {
    text = await io.readFile(indexPath);
  } catch {
    // No file yet, or one we cannot read. Either way there is nothing to reuse
    // and nothing to say: an empty cache is the ordinary first run.
    return { entries: [], needsRewrite: true, linesOnDisk: 0 };
  }

  const lines = text.split('\n');
  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor += 1;

  if (cursor >= lines.length || !isOurHeader(lines[cursor]!.trim())) {
    warn(
      `${indexPath} is not a cache this build understands, so it is being rebuilt. ` +
        'Nothing is lost: files get read and hashed the way they always were.',
    );
    return { entries: [], needsRewrite: true, linesOnDisk: 0 };
  }
  cursor += 1;

  const entries: SideIndexEntry[] = [];
  let dropped = 0;
  let linesOnDisk = 0;

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!.trim();
    if (line === '') continue;
    linesOnDisk += 1;
    const entry = parseEntry(line);
    if (entry === null) {
      dropped += 1;
      continue;
    }
    entries.push(entry);
  }

  if (dropped > 0) {
    // Almost always the tail of a file the process was appending to when it was
    // killed. It costs one re-read per dropped line and nothing else, so the
    // file is rewritten cleanly rather than appended to.
    warn(
      `${indexPath}: ${dropped} line${dropped === 1 ? '' : 's'} could not be read, so those files ` +
        'get hashed again. Nothing is lost: the ledger is the record that matters.',
    );
  }

  return { entries, needsRewrite: dropped > 0, linesOnDisk };
}

/**
 * Open the cache at this path.
 *
 * Never throws. A file that cannot be read, cannot be parsed or was written by
 * some other version is treated exactly like a file that is not there: the
 * index starts empty and rebuilds as files are hashed.
 */
export async function openSideIndex(
  indexPath: string,
  options: SideIndexOptions = {},
): Promise<SideIndex> {
  const io = options.io ?? nodeSideIndexIo();
  const warn = options.onWarning ?? ((): void => undefined);
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number): CancelTimer => {
      const timer = setTimeout(callback, ms);
      // A cache write must never be the reason a process stays alive. Whatever
      // has not been written by the time everything else is done is a re-read
      // next time, which is the cost this module was already designed around.
      timer.unref?.();
      return () => clearTimeout(timer);
    });

  const resolved = path.resolve(indexPath);
  const loaded = await loadFile(resolved, io, warn);

  /** Live entries, in insertion order, so the oldest is the one that gets evicted. */
  const live = new Map<string, SideIndexEntry>();
  for (const entry of loaded.entries) {
    const key = keyFor(entry.path);
    // Last line wins: a later line is the more recent reading of that file.
    live.delete(key);
    live.set(key, entry);
  }
  while (live.size > maxEntries) {
    const oldest = live.keys().next();
    if (oldest.done === true) break;
    live.delete(oldest.value);
  }

  const stats: SideIndexStats = {
    entries: live.size,
    hits: 0,
    misses: 0,
    bytesNotRead: 0,
  };

  let needsRewrite = loaded.needsRewrite;
  let linesOnDisk = loaded.linesOnDisk;
  /** Keys whose current entry has not reached the disk yet. */
  let dirty = new Set<string>();
  let cancelTimer: CancelTimer | null = null;
  /** Writes run one at a time, so two appends can never interleave a line. */
  let writeChain: Promise<void> = Promise.resolve();
  let complained = false;

  const complainOnce = (message: string): void => {
    if (complained) return;
    complained = true;
    warn(message);
  };

  const clearTimer = (): void => {
    if (cancelTimer === null) return;
    cancelTimer();
    cancelTimer = null;
  };

  const armTimer = (): void => {
    if (cancelTimer !== null) return;
    cancelTimer = schedule(() => {
      cancelTimer = null;
      void flush();
    }, debounceMs);
  };

  /** Every live entry, header included: what a rewrite puts on disk. */
  const wholeFile = (): string => {
    const parts = [headerLine()];
    for (const entry of live.values()) parts.push(serializeEntry(entry));
    return `${parts.join('\n')}\n`;
  };

  /**
   * One write, whatever kind it needs to be.
   *
   * Appends are not flushed to disk, and that is the point of the debounce: an
   * fsync per photo is the cost this module exists to avoid, and the worst a
   * lost page cache can do is make some files get hashed again. The ledger,
   * which is the record that matters, still fsyncs every single entry.
   */
  const writeNow = async (): Promise<void> => {
    const pending = dirty;
    if (!needsRewrite && pending.size === 0) return;
    dirty = new Set<string>();

    // A rewrite carries the pending entries with it, because it writes the
    // whole live map and they are already in it.
    const bloated = linesOnDisk > Math.max(COMPACT_FLOOR_LINES, live.size * COMPACT_RATIO);
    const rewriting = needsRewrite || bloated;

    try {
      if (rewriting) {
        await io.writeFileAtomic(resolved, wholeFile());
        needsRewrite = false;
        linesOnDisk = live.size;
        return;
      }

      const lines: string[] = [];
      for (const key of pending) {
        const entry = live.get(key);
        if (entry !== undefined) lines.push(serializeEntry(entry));
      }
      if (lines.length === 0) return;
      await io.appendFile(resolved, `${lines.join('\n')}\n`);
      linesOnDisk += lines.length;
    } catch (error) {
      // The cache could not be written. Nothing about this run is in danger:
      // hashing still works, the ledger still decides, and the only cost is
      // that the next start reads the files again.
      for (const key of pending) dirty.add(key);
      complainOnce(
        `Could not write ${resolved} (${String(error)}). photo-pigeon works exactly as before, ` +
          'it just re-reads unchanged files on the next start instead of remembering them.',
      );
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();
    const run = writeChain.then(writeNow, writeNow);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return writeChain;
  };

  return {
    stats,

    lookup(candidate: FileCandidate): string | undefined {
      // Size and mtime are compared exactly, fractions included. NTFS keeps
      // sub-millisecond ticks, so a real mtimeMs is often something like
      // 1785260816566.7217, and JSON.stringify writes the shortest text that
      // parses back to the identical double, so the fraction survives a round
      // trip through the file untouched. Exact comparison is therefore not
      // fragile, and it fails in the safe direction anyway: any disagreement at
      // all, from any cause, means the file gets read.
      const entry = live.get(keyFor(candidate.path));
      if (
        entry === undefined ||
        entry.size !== candidate.size ||
        entry.mtimeMs !== candidate.mtimeMs
      ) {
        stats.misses += 1;
        return undefined;
      }
      stats.hits += 1;
      stats.bytesNotRead += entry.size;
      return entry.hash;
    },

    remember(candidate: FileCandidate, hash: string): void {
      const clean = hash.trim().toLowerCase();
      // Only a real sha256 is worth remembering. Anything else would come back
      // out of lookup one day and be handed to the ledger as an identity.
      if (!SHA256_HEX.test(clean)) return;

      const key = keyFor(candidate.path);
      const entry: SideIndexEntry = {
        path: candidate.path,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        hash: clean,
      };
      // Delete first so a refreshed entry moves to the young end of the Map and
      // the file somebody keeps touching is not the one that gets evicted.
      live.delete(key);
      live.set(key, entry);
      while (live.size > maxEntries) {
        const oldest = live.keys().next();
        if (oldest.done === true) break;
        live.delete(oldest.value);
        dirty.delete(oldest.value);
      }
      stats.entries = live.size;
      dirty.add(key);
      armTimer();
    },

    flush,

    async close(): Promise<void> {
      // Anything remembered while the last write was still in flight deserves
      // to land too, so this drains rather than writing once. Bounded, because
      // a caller still handing over files during close must not be able to keep
      // the process here forever: what does not fit is a re-read, nothing more.
      for (let round = 0; round < 3; round += 1) {
        await flush();
        if (dirty.size === 0) break;
      }
      clearTimer();
    },
  };
}
