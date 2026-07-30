/**
 * Crash-safe file writing.
 *
 * Everything durable this tool owns lives in a plain file the user can read,
 * so a half written file is the one failure we refuse to ship: write to a temp
 * file in the same directory, flush it, then rename over the target. Rename is
 * atomic on NTFS and on POSIX alike, so a reader sees either the whole old file
 * or the whole new one, never a torn middle.
 *
 * Two doors into the same dance. writeFileAtomic goes straight at
 * node:fs/promises and can therefore flush the bytes before the rename, which
 * is the strong guarantee and what every real run gets. writeFileAtomicVia goes
 * through the wizard's injectable FsLike so a test can hand in a fake, and it
 * gives up only the flush, because a seam that small cannot express one.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { FsLike } from './fs-like.js';

/**
 * Windows refuses to replace a file while someone else has it open: an
 * antivirus scanner, the search indexer, or a second photo-pigeon reading the
 * config. Those handles live for milliseconds, so the rename waits them out
 * rather than failing the write. Roughly 1.4 seconds of patience in total.
 */
const RENAME_RETRY_DELAYS_MS = [5, 15, 40, 90, 180, 350, 700];

/** Transient Windows lock errors: worth another attempt, unlike a real permission problem. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

/** Files this tool owns are the user's alone: config, token and credentials all sit at 0600. */
const OWNER_ONLY = 0o600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;

/** A temp name nobody else will pick, in the same folder so the rename stays on one volume. */
function tempPathFor(targetPath: string): string {
  const unique = `${process.pid.toString(36)}${randomBytes(4).toString('hex')}`;
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${unique}.tmp`);
}

async function renameWithRetry(
  from: string,
  to: string,
  rename: (a: string, b: string) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) {
        throw err;
      }
      // Jitter keeps two processes from retrying in lockstep forever.
      const base = RENAME_RETRY_DELAYS_MS[attempt]!;
      await sleep(base + Math.random() * base * 0.5);
    }
  }
}

/**
 * Write a file so that it is never observed half written.
 *
 * Creates the parent directory when missing. The temp file is flushed to disk
 * before the rename, so a power cut leaves the old file intact rather than a
 * new file full of zeroes.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: string | Uint8Array,
  mode = OWNER_ONLY,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });

  const tmpPath = tempPathFor(targetPath);
  try {
    const handle = await fs.open(tmpPath, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmpPath, targetPath, (from, to) => fs.rename(from, to));
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * The same dance over an injected file system, for tests and for any caller
 * that has its own seam.
 *
 * Two things are missing compared with writeFileAtomic, both because FsLike is
 * deliberately tiny: there is no flush, and a failed rename leaves the temp
 * file behind, because nothing in FsLike deletes anything. Real runs never come
 * through here.
 */
export async function writeFileAtomicVia(
  seam: FsLike,
  targetPath: string,
  data: string,
  mode = OWNER_ONLY,
): Promise<void> {
  await seam.mkdir(path.dirname(targetPath));
  const tmpPath = tempPathFor(targetPath);
  await seam.writeFile(tmpPath, data, mode);
  await renameWithRetry(tmpPath, targetPath, (from, to) => seam.rename(from, to));
}
