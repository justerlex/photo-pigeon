/**
 * Name filters shared by the live watcher and the reconciliation walk.
 *
 * Everything here is pure and synchronous: given a name, is it junk, and does
 * it carry an extension we accept. Keeping it pure means both entry points
 * apply exactly the same rules, and the rules are testable on their own.
 */

import path from 'node:path';

/**
 * Files whose whole name marks them as operating system or shell bookkeeping.
 * Compared lowercase.
 */
const JUNK_NAMES: ReadonlySet<string> = new Set([
  'desktop.ini',
  'thumbs.db',
  'ehthumbs.db',
  'ehthumbs_vista.db',
  '.ds_store',
  '$recycle.bin',
  'system volume information',
]);

/**
 * Suffixes that mean "this file is still being written or downloaded".
 * Compared lowercase, matched on the tail of the name.
 */
const JUNK_SUFFIXES: readonly string[] = [
  '.tmp',
  '.temp',
  '.crdownload',
  '.partial',
  '.part',
  '.download',
  '.filepart',
  '.!ut', // uTorrent
];

/**
 * Prefixes that mean the same thing.
 * `~$` is the Office lock file, `.~lock.` is LibreOffice.
 */
const JUNK_PREFIXES: readonly string[] = ['~$', '.~lock.'];

/**
 * True when this single path segment is temp or system junk we never upload.
 * Applies to folders as well as files: a junk folder is not descended into.
 * Hidden dotfiles count as junk, which also keeps `.git` and friends out.
 */
export function isJunkName(name: string): boolean {
  if (name.length === 0) return true;
  if (name === '.' || name === '..') return true;

  const lower = name.toLowerCase();

  if (JUNK_NAMES.has(lower)) return true;
  if (JUNK_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (JUNK_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;

  // Hidden dotfiles and dot folders. A name that is only dots is junk too.
  if (lower.startsWith('.')) return true;

  // Trailing `~` is the classic editor backup.
  if (lower.endsWith('~')) return true;

  return false;
}

/** True when the basename of this path is temp or system junk. */
export function isJunkPath(filePath: string): boolean {
  return isJunkName(path.basename(filePath));
}

/**
 * Normalizes a configured extension list: lowercase, leading dot guaranteed,
 * blanks dropped. Accepts `jpg` and `.JPG` alike, so config typos still work.
 */
export function normalizeExtensions(extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of extensions) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    out.push(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
  }
  return [...new Set(out)];
}

/**
 * True when the file carries one of the accepted extensions, compared
 * case-insensitively. An empty accept list means "accept everything",
 * which is what a user who cleared the setting is asking for.
 * `extensions` may be raw config values: it is normalized here.
 */
export function hasAllowedExtension(
  filePath: string,
  extensions: readonly string[],
): boolean {
  const allowed = normalizeExtensions(extensions);
  if (allowed.length === 0) return true;
  const ext = path.extname(filePath).toLowerCase();
  if (ext.length === 0) return false;
  return allowed.includes(ext);
}

/**
 * The same test with a pre-normalized list, for hot loops that would otherwise
 * normalize the config on every single directory entry.
 */
export function hasAllowedExtensionNormalized(
  filePath: string,
  normalized: readonly string[],
): boolean {
  if (normalized.length === 0) return true;
  const ext = path.extname(filePath).toLowerCase();
  if (ext.length === 0) return false;
  return normalized.includes(ext);
}

/** True when the path is worth offering to the upload queue: not junk, right extension. */
export function isUploadable(
  filePath: string,
  normalizedExtensions: readonly string[],
): boolean {
  if (isJunkPath(filePath)) return false;
  return hasAllowedExtensionNormalized(filePath, normalizedExtensions);
}
