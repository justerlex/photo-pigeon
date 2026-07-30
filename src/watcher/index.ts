/**
 * Folder watching: event driven through fs.watch, never directory polling.
 *
 * On Windows chokidar rides node's fs.watch, which rides ReadDirectoryChangesW,
 * so the operating system tells us about a new file instead of us asking a
 * thousand times an hour. Two rules follow from that and both are load bearing:
 *
 *  1. Nothing here scans on a timer. The only full walk is `reconcile`, run
 *     once at startup to catch whatever landed while the app was closed. The
 *     `pollFallback` flag exists solely for network drives, where the operating
 *     system does not deliver change notifications, and it defaults to off.
 *  2. A file is only offered once it has stopped changing. Cameras, phone
 *     imports and browser downloads all write in pieces, and uploading a half
 *     written photo would deliver a broken image forever, so every candidate
 *     waits out a stability window first.
 *
 * The watcher reports on `add` and on `change`. A changed file has new bytes,
 * and this module has no idea whether those bytes are new to Google. That is
 * the sha256 ledger's job downstream: it hashes, it decides, and moves and
 * renames cost nothing.
 */

import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { watch, type ChokidarOptions, type FSWatcher, type MatchFunction } from 'chokidar';

import { type AppConfig, type FileCandidate, WRITE_SETTLE_MS } from '../contracts.js';
import { isJunkName, isJunkPath, normalizeExtensions, hasAllowedExtensionNormalized } from './junk.js';
import { reconcile } from './reconcile.js';

export { reconcile, MAX_SETTLE_WAIT_MS, type ReconcileOptions } from './reconcile.js';
export {
  isJunkName,
  isJunkPath,
  normalizeExtensions,
  hasAllowedExtension,
  hasAllowedExtensionNormalized,
  isUploadable,
} from './junk.js';

/** Called once per settled file. Never called for a folder, junk, or a rejected extension. */
export type OnCandidate = (candidate: FileCandidate) => void;

/** Knobs the config does not carry, mostly so tests do not have to wait two seconds per file. */
export interface WatcherOptions {
  /** Milliseconds a file must stop changing before it counts as settled. Defaults to WRITE_SETTLE_MS. */
  stabilityThreshold?: number;
  /** How often the stability check re-stats a file that is still growing. */
  pollInterval?: number;
  /** Watch errors, an unreadable folder for instance, arrive here instead of crashing the process. */
  onError?: (error: unknown) => void;
}

/** A running watcher. Upload only: there is no method here that touches Google. */
export interface Watcher {
  /** Resolves once every folder has been walked and live events are flowing. */
  ready: Promise<void>;
  /** Stops watching and releases every handle. Safe to call more than once. */
  close(): Promise<void>;
  /** The folders being watched, absolute and resolved. */
  readonly watchDirs: readonly string[];
}

/** True when `candidate` is the same folder as `ancestor` or sits underneath it. */
function isSameOrInside(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  const prefix = ancestor.endsWith(path.sep) ? ancestor : ancestor + path.sep;
  return candidate.startsWith(prefix);
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The predicate chokidar consults for files and for folders alike.
 *
 * Two traps live here. First, chokidar asks about folders too, so a rule that
 * rejects anything without an accepted extension would reject every folder and
 * the watch would never descend. Extensions are therefore only judged when we
 * know the entry is a file. Second, chokidar asks about the watch roots
 * themselves, so a user who watches a folder named `.photos` would otherwise
 * have the hidden-file rule silently switch their whole sync off.
 */
export function createIgnorePredicate(
  watchDirs: readonly string[],
  extensions: readonly string[],
): MatchFunction {
  const roots = watchDirs.map((dir) => path.resolve(dir));
  const normalized = normalizeExtensions(extensions);

  return (candidate: string, stats?: Stats): boolean => {
    const resolved = path.resolve(candidate);

    // Never ignore a watch root or anything on the way down to one.
    for (const root of roots) {
      if (samePath(resolved, root)) return false;
      if (isSameOrInside(root, resolved)) return false;
    }

    if (isJunkName(path.basename(resolved))) return true;

    // Only files are judged on their extension. Folders pass so the walk continues.
    if (stats?.isFile() && !hasAllowedExtensionNormalized(resolved, normalized)) return true;

    return false;
  };
}

/**
 * Builds the chokidar options for a config. Exported so the defaults that
 * matter, event driven rather than polled and settle before upload, can be
 * asserted directly instead of inferred from behaviour.
 */
export function buildWatchOptions(
  config: AppConfig,
  options: WatcherOptions = {},
): ChokidarOptions {
  const stabilityThreshold = options.stabilityThreshold ?? WRITE_SETTLE_MS;
  const pollInterval = options.pollInterval ?? 100;

  return {
    // Startup reconciliation handles what is already on disk, so the live
    // watcher would only duplicate that work.
    ignoreInitial: true,
    persistent: true,
    // Off by default and on only for network drives, where the operating
    // system does not deliver change notifications at all.
    usePolling: config.pollFallback === true,
    alwaysStat: true,
    // Editors that save by writing a temp file and renaming it should read as
    // one change, not as a create plus a delete.
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold,
      pollInterval,
    },
    ignored: createIgnorePredicate(config.watchDirs, config.extensions ?? []),
  };
}

/**
 * Starts watching every configured folder and reports each settled file.
 *
 * Returns immediately: the watcher is live, and `ready` resolves once the
 * initial walk is done. Nothing is uploaded from here, and nothing remote is
 * ever read, written or deleted. This module's whole output is FileCandidate
 * values handed to `onCandidate`.
 */
export function createWatcher(
  config: AppConfig,
  onCandidate: OnCandidate,
  options: WatcherOptions = {},
): Watcher {
  const watchDirs = (config.watchDirs ?? []).map((dir) => path.resolve(dir));
  if (watchDirs.length === 0) {
    throw new Error('watcher: no folders to watch, set watchDirs first');
  }

  const normalized = normalizeExtensions(config.extensions ?? []);
  const reportError = options.onError ?? (() => {});

  let closed = false;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const chokidarOptions = buildWatchOptions(config, options);
  const watcher: FSWatcher = watch(watchDirs, chokidarOptions);

  /**
   * Second filter pass. The ignore predicate already rejects most of this, but
   * it sees folders without stats and sees files before they settle, so the
   * final word on what reaches the queue is taken here where the stats are real.
   */
  const offer = async (filePath: string, stats?: Stats): Promise<void> => {
    if (closed) return;

    const resolved = path.resolve(filePath);
    if (isJunkPath(resolved)) return;
    if (!hasAllowedExtensionNormalized(resolved, normalized)) return;

    let info = stats;
    if (!info || typeof info.size !== 'number') {
      try {
        info = await fs.stat(resolved);
      } catch {
        // The file vanished between the event and the stat. Nothing to send.
        return;
      }
    }
    if (!info.isFile()) return;
    if (closed) return;

    onCandidate({
      path: resolved,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  };

  const handle = (filePath: string, stats?: Stats): void => {
    offer(filePath, stats).catch(reportError);
  };

  watcher.on('add', handle);
  // A changed file has new bytes. Whether those bytes are new to Google is the
  // ledger's call, not ours.
  watcher.on('change', handle);
  watcher.on('error', (error) => reportError(error));
  watcher.on('ready', () => resolveReady());

  return {
    ready,
    watchDirs,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      resolveReady();
      await watcher.close();
    },
  };
}

/**
 * Convenience entry point for the run command: start the watcher and resolve
 * once it is live. The returned handle is how the command shuts it down again.
 */
export async function startWatching(
  config: AppConfig,
  onCandidate: OnCandidate,
  options: WatcherOptions = {},
): Promise<Watcher> {
  const watcher = createWatcher(config, onCandidate, options);
  await watcher.ready;
  return watcher;
}

/**
 * One reconciliation pass followed by a live watcher, which is the whole
 * startup sequence a run command needs: everything already on disk is offered
 * first, then the process settles into pure event driven watching.
 */
export async function startWithReconcile(
  config: AppConfig,
  onCandidate: OnCandidate,
  options: WatcherOptions = {},
): Promise<{ watcher: Watcher; reconciled: FileCandidate[] }> {
  // Watcher first, walk second. A file that lands mid-walk is then caught by
  // one of the two, and if it is caught by both the ledger drops the repeat.
  // The other order leaves a window where a file is caught by neither.
  const watcher = await startWatching(config, onCandidate, options);
  // The walk waits out the same stability window the live path does. A file
  // still being written when it gives up stays with the watcher, which is
  // already seeing change events for it.
  const reconciled = await reconcile(config, {
    stabilityThreshold: options.stabilityThreshold ?? WRITE_SETTLE_MS,
  });
  for (const candidate of reconciled) onCandidate(candidate);
  return { watcher, reconciled };
}
