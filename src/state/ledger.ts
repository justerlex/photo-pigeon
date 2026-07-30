/**
 * The ledger: the durable record of everything this tool has delivered.
 *
 * One JSON object per line, appended and never rewritten. It is keyed by the
 * sha256 of the file contents, which is what makes a rename free: the bytes
 * are the identity, the path is a breadcrumb.
 *
 * This file matters more than it looks. Google shows app created content only
 * to the client id that uploaded it, so if the user regenerates their OAuth
 * client the history on Google's side becomes invisible forever and this
 * ledger is the only surviving record of what was already sent.
 *
 * Nothing here ever deletes or mutates anything on Google's side, by law and
 * by construction: the ledger only knows how to append.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Ledger, LedgerEntry, LedgerStats, OpenLedger } from '../contracts.js';

/** Byte value of a newline: lines are split on bytes so non ASCII paths keep their offsets honest. */
const NEWLINE = 0x0a;

/** Where a warning goes. The CLI hands in its own printer, tests collect them. */
export type WarnFn = (message: string) => void;

/** Knobs for opening a ledger. Everything optional: the contract signature stays a single path. */
export interface OpenLedgerOptions {
  /** Called for every skipped line, defaults to console.warn. */
  onWarning?: WarnFn;
}

/** Something is wrong with an entry the caller tried to add. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

/**
 * Read one stored line back into an entry.
 *
 * Only the hash is load bearing: a line without a usable hash is not a record
 * of anything. Everything else falls back rather than throwing away history.
 */
function parseEntry(text: string): LedgerEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;

  const hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : '';
  if (hash === '') return null;

  const size = finiteOr(raw.size, 0);
  const entry: LedgerEntry = {
    hash,
    size,
    bytes: finiteOr(raw.bytes, size),
    firstPath: typeof raw.firstPath === 'string' ? raw.firstPath : '',
    uploadedAt: typeof raw.uploadedAt === 'string' ? raw.uploadedAt : '',
  };
  if (typeof raw.mediaItemId === 'string' && raw.mediaItemId !== '') entry.mediaItemId = raw.mediaItemId;
  return entry;
}

/** Explicit key order so the file diffs cleanly and stays pleasant to read by hand. */
function serializeEntry(entry: LedgerEntry): string {
  const shape: Record<string, unknown> = {
    hash: entry.hash,
    size: entry.size,
    bytes: entry.bytes,
    firstPath: entry.firstPath,
    uploadedAt: entry.uploadedAt,
  };
  if (entry.mediaItemId !== undefined) shape.mediaItemId = entry.mediaItemId;
  return JSON.stringify(shape);
}

/** Check what the caller handed us before it becomes a permanent line on disk. */
function prepareEntry(entry: LedgerEntry): LedgerEntry {
  if (!isPlainObject(entry)) throw new LedgerError('ledger entry must be an object');
  if (typeof entry.hash !== 'string' || entry.hash.trim() === '') {
    throw new LedgerError('ledger entry needs a sha256 hash: content is the identity, not the path');
  }
  const size = finiteOr(entry.size, 0);
  const prepared: LedgerEntry = {
    hash: entry.hash.trim().toLowerCase(),
    size,
    bytes: finiteOr(entry.bytes, size),
    firstPath: typeof entry.firstPath === 'string' ? entry.firstPath : '',
    uploadedAt:
      typeof entry.uploadedAt === 'string' && entry.uploadedAt !== ''
        ? entry.uploadedAt
        : new Date().toISOString(),
  };
  if (typeof entry.mediaItemId === 'string' && entry.mediaItemId !== '') {
    prepared.mediaItemId = entry.mediaItemId;
  }
  return prepared;
}

/** What reading the file produced, before any of it is trusted. */
interface LoadResult {
  entries: LedgerEntry[];
  /** True when the file's last line has no newline yet, so the next append must add one first. */
  pendingNewline: boolean;
}

async function loadFile(ledgerPath: string, warn: WarnFn): Promise<LoadResult> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(ledgerPath);
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return { entries: [], pendingNewline: false };
    throw err;
  }

  const entries: LedgerEntry[] = [];
  let lineNumber = 0;
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== NEWLINE) continue;
    lineNumber++;
    const text = buffer.subarray(start, i).toString('utf8').trim();
    start = i + 1;
    if (text === '') continue;
    const entry = parseEntry(text);
    if (entry === null) {
      warn(
        `ledger ${ledgerPath}: line ${lineNumber} is not a readable record, skipping it. ` +
          'One already delivered file may be sent a second time.',
      );
      continue;
    }
    entries.push(entry);
  }

  // Anything after the last newline was still being written when the process stopped.
  if (start < buffer.length) {
    const tailText = buffer.subarray(start).toString('utf8').trim();
    const tail = tailText === '' ? null : parseEntry(tailText);
    if (tail !== null) {
      // A complete record that simply never got its newline: keep it, terminate it on the next append.
      entries.push(tail);
      return { entries, pendingNewline: true };
    }
    warn(
      `ledger ${ledgerPath}: the last line was cut off mid write, dropping it. ` +
        'One already delivered file may be sent a second time.',
    );
    // Truncating the torn tail keeps the next append from gluing itself onto a fragment.
    await fs.truncate(ledgerPath, start);
  }

  return { entries, pendingNewline: false };
}

class JsonlLedger implements Ledger {
  private readonly byHash = new Map<string, LedgerEntry>();
  private totalBytes = 0;
  private pendingNewline: boolean;
  /** Appends run one at a time, so two callers can never interleave a line. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ledgerPath: string,
    loaded: LoadResult,
  ) {
    this.pendingNewline = loaded.pendingNewline;
    for (const entry of loaded.entries) {
      // First write wins: an older line is the earlier delivery.
      if (this.byHash.has(entry.hash)) continue;
      this.byHash.set(entry.hash, entry);
      this.totalBytes += entry.bytes;
    }
  }

  has(hash: string): boolean {
    return this.byHash.has(hash.trim().toLowerCase());
  }

  get(hash: string): LedgerEntry | undefined {
    return this.byHash.get(hash.trim().toLowerCase());
  }

  /**
   * Append one delivery and flush it to disk before resolving.
   *
   * Adding a hash that is already known is a no op: the ledger records content,
   * and the first delivery is the one that happened.
   */
  async add(entry: LedgerEntry): Promise<void> {
    const prepared = prepareEntry(entry);
    return this.enqueue(async () => {
      if (this.byHash.has(prepared.hash)) return;

      const line = `${this.pendingNewline ? '\n' : ''}${serializeEntry(prepared)}\n`;
      const handle = await fs.open(this.ledgerPath, 'a');
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      this.pendingNewline = false;
      this.byHash.set(prepared.hash, prepared);
      this.totalBytes += prepared.bytes;
    });
  }

  stats(): LedgerStats {
    return { count: this.byHash.size, totalBytes: this.totalBytes };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Open the ledger at this path, creating an empty one when it does not exist.
 *
 * Every line is read into memory once, so lookups during a watch are
 * synchronous and free. A line that cannot be read is skipped with a warning
 * rather than stopping the tool: a ledger that refuses to open would leave the
 * user with no way to back anything up.
 */
export const openLedger = async (
  ledgerPath: string,
  options: OpenLedgerOptions = {},
): Promise<Ledger> => {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const resolved = path.resolve(ledgerPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const loaded = await loadFile(resolved, warn);
  return new JsonlLedger(resolved, loaded);
};

/** Compile time proof that the implementation still satisfies the shared contract. */
const _contractCheck: OpenLedger = openLedger;
void _contractCheck;
