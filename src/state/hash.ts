/**
 * Content hashing.
 *
 * The sha256 of a file's bytes is this tool's idea of identity. Paths are only
 * breadcrumbs: a photo that gets renamed, moved to another watched folder or
 * copied twice is the same content and must never be delivered twice.
 *
 * Hashing is streamed, so a 20 GB video costs a 1 MB buffer, not 20 GB of RAM.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';

/** Read a megabyte at a time: large enough to keep the disk busy, small enough to stay invisible in RSS. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Stream a file through sha256 and return the lowercase hex digest.
 *
 * Filesystem errors pass through untouched, so callers can still branch on
 * `err.code === 'ENOENT'` when a file disappears between discovery and hashing.
 */
export async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: CHUNK_BYTES });
  for await (const chunk of stream) {
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

/** A file's content hash together with the stat fields the queue and the ledger need. */
export interface HashedFile {
  /** sha256 of the file contents, lowercase hex. */
  hash: string;
  /** Size in bytes at the moment of hashing. */
  size: number;
  /** Last modified time, epoch milliseconds. */
  mtimeMs: number;
}

/**
 * Hash a file and stat it in one pass over the API, for callers that need both.
 *
 * The stat is taken after the read, so `size` describes the bytes that were
 * actually hashed unless the file changed underneath us.
 */
export async function hashFileWithStats(filePath: string): Promise<HashedFile> {
  const hash = await hashFile(filePath);
  const info = await fs.stat(filePath);
  return { hash, size: info.size, mtimeMs: info.mtimeMs };
}
