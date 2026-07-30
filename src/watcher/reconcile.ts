/**
 * Startup reconciliation: one recursive walk of the watched folders.
 *
 * The watcher only sees what happens while the process is running. Anything
 * that landed while photo-pigeon was closed is invisible to it, so every start
 * does exactly one pass over the folders and hands the pipeline everything it
 * finds. This is not polling: it runs once, at startup, and then the process
 * lives on file system events alone.
 *
 * This walk does not consult the ledger and does not hash anything. It
 * enumerates. The pipeline hashes each candidate and the sha256 ledger decides
 * what is genuinely new, which is what makes moves and renames free.
 *
 * What it does do before handing anything over is wait for the bytes to stop
 * moving. The live watcher gets that for free from chokidar's awaitWriteFinish;
 * the walk has to do it itself, and it is not optional. A camera import or an
 * Explorer copy writes straight to the final name, so a file that is half
 * written looks exactly like a finished one. Enumerating it, hashing the
 * truncated bytes and uploading them would put a broken photo in the library
 * forever: nothing in this tool can ever delete it, and the finished file
 * hashes differently, so the user ends up with the corpse and the copy.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { type AppConfig, type FileCandidate, WRITE_SETTLE_MS } from '../contracts.js';
import { isJunkName, normalizeExtensions, hasAllowedExtensionNormalized } from './junk.js';

/** How long the walk keeps waiting on a file that is still growing before leaving it to the watcher. */
export const MAX_SETTLE_WAIT_MS = 60_000;

/** Knobs for the settle gate. The defaults are the law, tests use the rest. */
export interface ReconcileOptions {
  /** Milliseconds a file must stop changing before it counts as settled. Defaults to WRITE_SETTLE_MS. */
  stabilityThreshold?: number;
  /** How long to keep re-checking a file that is still growing. Defaults to MAX_SETTLE_WAIT_MS. */
  maxSettleWaitMs?: number;
  /** Sleep, injectable so tests do not wait out real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Called for each file that was still being written when the walk gave up on it. */
  onUnsettled?: (candidate: FileCandidate) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Case folded on Windows, where two spellings of one path are one file. */
function dedupeKey(absolutePath: string): string {
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

/** Errors that mean "this branch is not readable right now", not "the run is broken". */
function isSkippableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ELOOP' ||
    code === 'ENOTDIR' ||
    code === 'EBUSY' ||
    code === 'EIO' ||
    code === 'EUNKNOWN' ||
    code === 'ENAMETOOLONG'
  );
}

interface WalkState {
  normalized: string[];
  seenFiles: Set<string>;
  seenDirs: Set<string>;
  out: FileCandidate[];
}

async function pushFile(absolutePath: string, state: WalkState): Promise<void> {
  const key = dedupeKey(absolutePath);
  if (state.seenFiles.has(key)) return;

  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) return;
    state.seenFiles.add(key);
    state.out.push({
      path: absolutePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  } catch (error) {
    if (isSkippableError(error)) return;
    throw error;
  }
}

async function walkDir(dir: string, state: WalkState): Promise<void> {
  const key = dedupeKey(dir);
  if (state.seenDirs.has(key)) return;
  state.seenDirs.add(key);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isSkippableError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (isJunkName(entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDir(full, state);
      continue;
    }

    if (entry.isFile()) {
      if (!hasAllowedExtensionNormalized(entry.name, state.normalized)) continue;
      await pushFile(full, state);
      continue;
    }

    if (entry.isSymbolicLink()) {
      // Follow links to files, never to folders: a linked folder can point at
      // its own ancestor and the walk would never end.
      let stats;
      try {
        stats = await fs.stat(full);
      } catch (error) {
        if (isSkippableError(error)) continue;
        throw error;
      }
      if (!stats.isFile()) continue;
      if (!hasAllowedExtensionNormalized(entry.name, state.normalized)) continue;
      await pushFile(full, state);
    }
  }
}

/**
 * The write-settle gate for the walk, the counterpart of chokidar's
 * awaitWriteFinish on the live path.
 *
 * Every file found is stat'ed again after the stability window and only the
 * ones whose size and mtime did not move are handed on. One sleep covers the
 * whole list, so a folder of ten thousand settled photos costs one window, not
 * ten thousand.
 *
 * A file that is still growing gets another window, up to the time budget. Past
 * that the walk lets it go rather than blocking the whole startup on one long
 * camera import: the file is still being written, which means the live watcher
 * is already seeing change events for it and will offer it the moment it stops.
 * The next startup scan is the backstop behind that.
 */
async function settleAll(
  found: FileCandidate[],
  options: ReconcileOptions,
): Promise<FileCandidate[]> {
  if (found.length === 0) return found;

  const threshold = Math.max(0, options.stabilityThreshold ?? WRITE_SETTLE_MS);
  const budget = Math.max(0, options.maxSettleWaitMs ?? MAX_SETTLE_WAIT_MS);
  const sleep = options.sleep ?? defaultSleep;
  const rounds = Math.max(1, Math.ceil(budget / Math.max(1, threshold)));

  const settled: FileCandidate[] = [];
  let moving = found;

  for (let round = 0; round < rounds && moving.length > 0; round += 1) {
    await sleep(threshold);

    const stillMoving: FileCandidate[] = [];
    for (const candidate of moving) {
      let stats;
      try {
        stats = await fs.stat(candidate.path);
      } catch (error) {
        // Gone between the walk and the check. Nothing to upload.
        if (isSkippableError(error)) continue;
        throw error;
      }
      if (!stats.isFile()) continue;

      if (stats.size === candidate.size && stats.mtimeMs === candidate.mtimeMs) {
        settled.push(candidate);
        continue;
      }

      // Still being written. Take the newer numbers and give it another window.
      stillMoving.push({ path: candidate.path, size: stats.size, mtimeMs: stats.mtimeMs });
    }

    moving = stillMoving;
  }

  for (const candidate of moving) options.onUnsettled?.(candidate);

  return settled;
}

/**
 * Walks the watched folders and returns every file that matches the accepted
 * extensions, junk excluded, sorted by path so runs are comparable.
 *
 * Every file returned has been seen to stop changing first. Files still being
 * written when the walk gives up on them are left out, not half uploaded.
 *
 * Overlapping watch folders yield each file once. Folders that are missing or
 * unreadable, an unplugged drive for instance, are skipped rather than fatal:
 * one absent folder must not stop the other folders from syncing.
 */
export async function reconcile(
  config: AppConfig,
  options?: ReconcileOptions,
): Promise<FileCandidate[]>;
export async function reconcile(
  watchDirs: readonly string[],
  extensions: readonly string[],
  options?: ReconcileOptions,
): Promise<FileCandidate[]>;
export async function reconcile(
  first: AppConfig | readonly string[],
  second?: readonly string[] | ReconcileOptions,
  third?: ReconcileOptions,
): Promise<FileCandidate[]> {
  const byDirs = Array.isArray(first);
  const watchDirs = byDirs ? (first as readonly string[]) : (first as AppConfig).watchDirs;
  const extensions = byDirs
    ? ((second as readonly string[] | undefined) ?? [])
    : ((first as AppConfig).extensions ?? []);
  const options = (byDirs ? third : (second as ReconcileOptions | undefined)) ?? {};

  const state: WalkState = {
    normalized: normalizeExtensions(extensions),
    seenFiles: new Set<string>(),
    seenDirs: new Set<string>(),
    out: [],
  };

  for (const dir of watchDirs ?? []) {
    const root = path.resolve(dir);

    let stats;
    try {
      stats = await fs.stat(root);
    } catch (error) {
      if (isSkippableError(error)) continue;
      throw error;
    }

    if (stats.isDirectory()) {
      await walkDir(root, state);
      continue;
    }

    // A watch entry pointing straight at a single file is still honoured.
    if (stats.isFile() && hasAllowedExtensionNormalized(root, state.normalized)) {
      await pushFile(root, state);
    }
  }

  const settled = await settleAll(state.out, options);
  settled.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return settled;
}
