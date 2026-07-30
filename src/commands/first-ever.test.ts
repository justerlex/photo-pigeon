/**
 * "The very first photo ever delivered", as a fact rather than as a guess.
 *
 * TRAY-DESIGN section 3 promises exactly one happy toast, on the very first
 * delivery ever, and the project rule is that "first ever" means
 * the ledger was empty before that delivery, core-owned, with the shell's own
 * flag file retired. That rule has two ways to be implemented and one of
 * them is silently dead:
 *
 * **The dead one.** Sample the ledger where the toast decision lives, on
 * receipt of the delivered event. `UploadQueue.record` writes the ledger entry
 * and *then* reports the outcome, so by the time anything downstream can look,
 * the count is 1 on the very first delivery of a virgin install and never 0
 * again. The condition is false on the first photo and false forever after: a
 * happy toast nobody can ever see, on every machine.
 *
 * **The other wrong one.** Snapshot emptiness once when the ledger is opened
 * and stamp it on every delivery of that run. A person who drops twelve photos
 * as their first action gets twelve identical toasts, which is the duplicate
 * the M3 review just spent a critical fixing, arrived at from the other side.
 *
 * So the truth is sampled immediately before the ledger write, per delivery,
 * and travels on the event. It cannot be recomputed downstream and nothing
 * downstream should try.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  BatchCreateItem,
  BatchCreateOutcome,
  FileCandidate,
  Ledger,
  LedgerEntry,
  UploadOutcome,
} from '../contracts.js';
import type { Logger } from './log.js';
import { UploadQueue } from './queue.js';

function fakeLedger(seed: LedgerEntry[] = []): Ledger {
  const entries = new Map<string, LedgerEntry>(seed.map((entry) => [entry.hash, entry]));
  return {
    has: (hash) => entries.has(hash),
    get: (hash) => entries.get(hash),
    add: async (entry) => {
      entries.set(entry.hash, entry);
    },
    stats: () => ({
      count: entries.size,
      totalBytes: [...entries.values()].reduce((total, entry) => total + entry.bytes, 0),
    }),
  };
}

const quietLog: Logger = {
  info: () => {},
  ok: () => {},
  warn: () => {},
  error: () => {},
  plain: () => {},
  muted: () => {},
};

function fakeClient(): {
  uploadFile(filePath: string): Promise<string>;
  batchCreate(items: BatchCreateItem[]): Promise<BatchCreateOutcome[]>;
} {
  return {
    async uploadFile(filePath: string): Promise<string> {
      return `token-${path.basename(filePath)}`;
    },
    async batchCreate(items: BatchCreateItem[]): Promise<BatchCreateOutcome[]> {
      return items.map((item) => ({
        uploadToken: item.uploadToken,
        fileName: item.fileName,
        ok: true,
        mediaItemId: `media-${item.fileName}`,
      }));
    },
  };
}

function candidate(name: string): FileCandidate {
  return { path: `/photos/${name}`, size: 1024, mtimeMs: 1_700_000_000_000 };
}

async function deliver(ledger: Ledger, names: string[]): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];
  const queue = new UploadQueue({
    ledger,
    client: fakeClient(),
    hashFile: async (filePath) => `hash-${path.basename(filePath)}`,
    log: quietLog,
    sleep: async () => {},
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  for (const name of names) queue.offer(candidate(name));
  await queue.drain();
  return outcomes;
}

describe('the first delivery ever', () => {
  it('is true exactly once when a virgin ledger takes a whole first batch', async () => {
    // The state the M3 rig cannot construct: a brand new install whose user's
    // first action is dropping twelve photos in at once. One toast, not twelve
    // and not zero.
    const names = Array.from({ length: 12 }, (_, index) => `photo-${index}.jpg`);

    const outcomes = await deliver(fakeLedger(), names);

    const delivered = outcomes.filter((outcome) => outcome.status === 'uploaded');
    expect(delivered).toHaveLength(12);
    expect(delivered.filter((outcome) => outcome.firstEver === true)).toHaveLength(1);
    // And it is the first one, not an arbitrary one.
    expect(delivered[0]?.firstEver).toBe(true);
    for (const outcome of delivered.slice(1)) expect(outcome.firstEver).toBeFalsy();
  });

  it('is never true again once the ledger has a single line in it', async () => {
    // The veteran CLI user who installs the tray. Nothing about them is new,
    // and the happy toast is for somebody who needs proof the thing works.
    const veteran = fakeLedger([
      {
        hash: 'hash-old.jpg',
        size: 10,
        bytes: 10,
        firstPath: '/photos/old.jpg',
        uploadedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const outcomes = await deliver(veteran, ['new-a.jpg', 'new-b.jpg']);

    const delivered = outcomes.filter((outcome) => outcome.status === 'uploaded');
    expect(delivered).toHaveLength(2);
    for (const outcome of delivered) expect(outcome.firstEver).toBeFalsy();
  });

  it('is sampled before the ledger write, which is the whole point', async () => {
    // The falsifying control. If the flag were read after `ledger.add`, this
    // ledger would already hold entry one and the answer would be false, which
    // is exactly the bug: a happy toast that is dead for everybody, forever.
    const ledger = fakeLedger();
    const seenAtAdd: number[] = [];
    const watched: Ledger = {
      ...ledger,
      add: async (entry) => {
        seenAtAdd.push(ledger.stats().count);
        await ledger.add(entry);
      },
    };

    const outcomes = await deliver(watched, ['only.jpg']);

    expect(seenAtAdd).toEqual([0]);
    expect(outcomes[0]?.firstEver).toBe(true);
    // And the ledger really did take the line, so the sample is genuinely from
    // before the write rather than from a write that never happened.
    expect(ledger.stats().count).toBe(1);
  });
});
