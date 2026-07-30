/**
 * What counts as a watched folder, in one place.
 *
 * There are two front ends that take a folder from a person now: the setup
 * wizard's last screen, and the status window's Watching list, which the
 * `folders` command rewrites. A rule about paths that lives in one of them is a
 * rule the other will disagree with, and the disagreement is not academic: the
 * writer collapses two spellings of one Windows folder into one entry, so a
 * front end that thinks they are two folders reports a change that never
 * happens.
 *
 * Three rules, all of them small, all of them here:
 *
 * 1. **A quoted path is a path.** Windows Explorer's Copy as path wraps the
 *    thing in quotes, so a person pasting one is pasting quotes, and refusing
 *    that would be refusing the most ordinary way to answer.
 * 2. **A watched folder is an absolute resolved path.** Whatever was typed is
 *    resolved once, here, and the resolved form is what everything else deals
 *    in.
 * 3. **Two paths are the same folder if the file system says so**, which on
 *    Windows means case insensitively. `dedupePaths` in `./config.ts` reaches
 *    for the same comparison, so the validator and the writer cannot drift.
 *
 * Nothing here reads a credential and nothing here writes anything: it deals in
 * paths and asks the file system one question about each.
 */

import path from 'node:path';

import { dirExists, type FsLike, nodeFs } from './fs-like.js';

/** Setup's own words for an answer with nothing in it. */
export const NEEDS_A_PATH = 'A folder path, please.';

/** Setup's own words for a folder that is already being watched. */
export const ALREADY_ON_THE_LIST = 'That one is already on the list.';

/** Strips the quotes Windows adds when you use Copy as path. */
export function cleanTypedPath(value: string): string {
  return value.trim().replace(/^"(.*)"$/s, '$1').trim();
}

/**
 * The key two paths share when they are the same folder.
 *
 * Exported because `config.ts` dedupes with it. One comparison, two callers, no
 * third opinion.
 */
export function watchDirKey(dir: string): string {
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

/** Are these two paths the same watched folder? */
export function sameWatchDir(one: string, other: string): boolean {
  return watchDirKey(one) === watchDirKey(other);
}

/** Is this folder already on the list, whichever way it was spelled? */
export function isWatchedAlready(dirs: readonly string[], candidate: string): boolean {
  return dirs.some((dir) => sameWatchDir(dir, candidate));
}

/** A folder path that passed, or the sentence that refused it. */
export type WatchDirVerdict = { ok: true; dir: string } | { ok: false; why: string };

/**
 * The whole of what a typed or picked folder has to satisfy.
 *
 * Returns the resolved folder or the sentence to show, which is the shape both
 * front ends want: the wizard's `validate` wants `true` or a sentence, and the
 * `folders` command wants the resolved path it is about to write.
 */
export async function checkWatchDir(
  value: string,
  existing: readonly string[],
  fs: FsLike = nodeFs,
): Promise<WatchDirVerdict> {
  const cleaned = cleanTypedPath(value);
  if (!cleaned) return { ok: false, why: NEEDS_A_PATH };
  const resolved = path.resolve(cleaned);
  if (!(await dirExists(resolved, fs))) return { ok: false, why: `No folder at ${resolved}` };
  if (isWatchedAlready(existing, resolved)) return { ok: false, why: ALREADY_ON_THE_LIST };
  return { ok: true, dir: resolved };
}
