import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LedgerEntry } from '../contracts.js';
import { hashFile } from './hash.js';
import { LedgerError, openLedger } from './ledger.js';

let dir: string;
let ledgerPath: string;
let warnings: string[];

const open = (p: string = ledgerPath) => openLedger(p, { onWarning: (m) => warnings.push(m) });

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  hash: 'a'.repeat(64),
  size: 100,
  bytes: 100,
  firstPath: path.join(dir, 'IMG_0001.jpg'),
  uploadedAt: '2026-07-28T09:00:00.000Z',
  ...over,
});

const readLines = async (p: string = ledgerPath): Promise<string[]> => {
  const text = await fs.readFile(p, 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '');
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'pigeon-ledger-'));
  ledgerPath = path.join(dir, 'ledger.jsonl');
  warnings = [];
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('opening', () => {
  it('starts empty when there is no file yet, and creates the folder', async () => {
    const nested = path.join(dir, 'state', 'ledger.jsonl');
    const ledger = await open(nested);

    expect(ledger.stats()).toEqual({ count: 0, totalBytes: 0 });
    expect(ledger.has('a'.repeat(64))).toBe(false);
    await expect(fs.stat(path.dirname(nested))).resolves.toBeTruthy();
    expect(warnings).toEqual([]);
  });

  it('tolerates an empty file and blank lines', async () => {
    await fs.writeFile(ledgerPath, '\n\n');
    const ledger = await open();
    expect(ledger.stats().count).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('round trip', () => {
  it('remembers an entry across a reopen', async () => {
    const first = await open();
    await first.add(entry({ mediaItemId: 'media-1' }));

    const second = await open();
    expect(second.has('a'.repeat(64))).toBe(true);
    expect(second.get('a'.repeat(64))).toEqual({
      hash: 'a'.repeat(64),
      size: 100,
      bytes: 100,
      firstPath: path.join(dir, 'IMG_0001.jpg'),
      uploadedAt: '2026-07-28T09:00:00.000Z',
      mediaItemId: 'media-1',
    });
    expect(warnings).toEqual([]);
  });

  it('writes one line per entry, in order', async () => {
    const ledger = await open();
    await ledger.add(entry({ hash: 'a'.repeat(64) }));
    await ledger.add(entry({ hash: 'b'.repeat(64) }));
    await ledger.add(entry({ hash: 'c'.repeat(64) }));

    const lines = await readLines();
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as LedgerEntry).hash)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    ]);
  });

  it('leaves out an absent media item id instead of writing null', async () => {
    const ledger = await open();
    await ledger.add(entry());
    const stored = JSON.parse((await readLines())[0]!) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('mediaItemId');
  });

  it('keeps every append when several land at once', async () => {
    const ledger = await open();
    const hashes = Array.from({ length: 25 }, (_, i) => String(i).padStart(64, '0'));
    await Promise.all(hashes.map((hash) => ledger.add(entry({ hash, bytes: 10 }))));

    expect(ledger.stats()).toEqual({ count: 25, totalBytes: 250 });
    expect(await readLines()).toHaveLength(25);
    expect((await open()).stats()).toEqual({ count: 25, totalBytes: 250 });
  });

  it('refuses an entry with no hash', async () => {
    const ledger = await open();
    await expect(ledger.add(entry({ hash: '' }))).rejects.toBeInstanceOf(LedgerError);
    expect(await readLines().catch(() => [])).toEqual([]);
  });
});

describe('dedup by content, not by path', () => {
  it('knows a renamed file has already been delivered', async () => {
    const original = path.join(dir, 'IMG_0001.jpg');
    const renamed = path.join(dir, 'sub', 'Beach day.jpg');
    await fs.mkdir(path.dirname(renamed), { recursive: true });
    await fs.writeFile(original, 'the same pixels either way');
    await fs.copyFile(original, renamed);

    const hashBefore = await hashFile(original);
    const hashAfter = await hashFile(renamed);
    expect(hashAfter).toBe(hashBefore);

    const ledger = await open();
    await ledger.add(entry({ hash: hashBefore, firstPath: original, size: 26, bytes: 26 }));

    // Same content, different path and different name: already delivered.
    expect(ledger.has(hashAfter)).toBe(true);
    expect(ledger.get(hashAfter)?.firstPath).toBe(original);
    expect(ledger.stats().count).toBe(1);
  });

  it('counts a repeated hash once, whatever the path says', async () => {
    const ledger = await open();
    await ledger.add(entry({ bytes: 500, firstPath: path.join(dir, 'a.jpg') }));
    await ledger.add(entry({ bytes: 500, firstPath: path.join(dir, 'copy of a.jpg') }));

    expect(ledger.stats()).toEqual({ count: 1, totalBytes: 500 });
    expect(await readLines()).toHaveLength(1);
    expect(ledger.get('a'.repeat(64))?.firstPath).toBe(path.join(dir, 'a.jpg'));
  });

  it('looks up a hash regardless of its letter case', async () => {
    const ledger = await open();
    await ledger.add(entry({ hash: 'A'.repeat(64) }));
    expect(ledger.has('a'.repeat(64))).toBe(true);
    expect(ledger.has('A'.repeat(64))).toBe(true);
  });
});

describe('stats', () => {
  it('sums the bytes actually sent', async () => {
    const ledger = await open();
    await ledger.add(entry({ hash: '1'.repeat(64), size: 1_000, bytes: 1_000 }));
    await ledger.add(entry({ hash: '2'.repeat(64), size: 2_500, bytes: 2_500 }));
    await ledger.add(entry({ hash: '3'.repeat(64), size: 300, bytes: 300 }));

    expect(ledger.stats()).toEqual({ count: 3, totalBytes: 3_800 });
    expect((await open()).stats()).toEqual({ count: 3, totalBytes: 3_800 });
  });

  it('falls back to the file size when an older line has no bytes field', async () => {
    await fs.writeFile(
      ledgerPath,
      `${JSON.stringify({
        hash: 'd'.repeat(64),
        size: 4_096,
        firstPath: 'old.jpg',
        uploadedAt: '2026-01-01T00:00:00.000Z',
      })}\n`,
    );
    const ledger = await open();
    expect(ledger.stats()).toEqual({ count: 1, totalBytes: 4_096 });
  });
});

describe('recovering from a crash mid write', () => {
  it('skips a torn last line, warns, and stays usable', async () => {
    const good = `${JSON.stringify(entry({ hash: 'a'.repeat(64), bytes: 10 }))}\n${JSON.stringify(
      entry({ hash: 'b'.repeat(64), bytes: 20 }),
    )}\n`;
    await fs.writeFile(ledgerPath, `${good}{"hash":"cccccc","size":30,"by`);

    const ledger = await open();
    expect(ledger.stats()).toEqual({ count: 2, totalBytes: 30 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cut off mid write');

    // The fragment is gone, so the next append cannot glue itself onto it.
    await ledger.add(entry({ hash: 'e'.repeat(64), bytes: 40 }));
    const lines = await readLines();
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

    warnings = [];
    const reopened = await open();
    expect(reopened.stats()).toEqual({ count: 3, totalBytes: 70 });
    expect(warnings).toEqual([]);
  });

  it('keeps a complete last line that never got its newline, and terminates it on the next append', async () => {
    const a = JSON.stringify(entry({ hash: 'a'.repeat(64), bytes: 10 }));
    const b = JSON.stringify(entry({ hash: 'b'.repeat(64), bytes: 20 }));
    await fs.writeFile(ledgerPath, `${a}\n${b}`);

    const ledger = await open();
    expect(ledger.stats()).toEqual({ count: 2, totalBytes: 30 });
    expect(warnings).toEqual([]);

    await ledger.add(entry({ hash: 'c'.repeat(64), bytes: 30 }));
    const lines = await readLines();
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as LedgerEntry).hash)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    ]);
    expect((await open()).stats()).toEqual({ count: 3, totalBytes: 60 });
  });

  it('skips unreadable lines in the middle and keeps the rest of the history', async () => {
    const a = JSON.stringify(entry({ hash: 'a'.repeat(64), bytes: 10 }));
    const b = JSON.stringify(entry({ hash: 'b'.repeat(64), bytes: 20 }));
    await fs.writeFile(ledgerPath, `${a}\nnot json at all\n{"size":5}\n${b}\n`);

    const ledger = await open();
    expect(ledger.stats()).toEqual({ count: 2, totalBytes: 30 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('line 2');
    expect(warnings[1]).toContain('line 3');
    // Nothing was rewritten: an append only file is never edited behind the user's back.
    expect(await readLines()).toHaveLength(4);
  });

  it('reads a path with non ASCII characters back byte for byte', async () => {
    const cyrillic = path.join(dir, 'Фотографии', 'снимок.jpg');
    const ledger = await open();
    await ledger.add(entry({ firstPath: cyrillic }));

    const reopened = await open();
    expect(reopened.get('a'.repeat(64))?.firstPath).toBe(cyrillic);
    expect(warnings).toEqual([]);
  });

  it('recovers a torn tail that follows a non ASCII line without losing the good lines', async () => {
    const first = JSON.stringify(entry({ firstPath: path.join(dir, 'Фотографии', 'снимок.jpg'), bytes: 12 }));
    await fs.writeFile(ledgerPath, `${first}\n{"hash":"bbbb","firstPath":"Отпуск`);

    const ledger = await open();
    expect(ledger.stats()).toEqual({ count: 1, totalBytes: 12 });
    expect(warnings).toHaveLength(1);

    await ledger.add(entry({ hash: 'f'.repeat(64), bytes: 8 }));
    const lines = await readLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
