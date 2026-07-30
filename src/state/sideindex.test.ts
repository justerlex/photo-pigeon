/**
 * Side index tests.
 *
 * Two halves. The first drives the cache through an injected file system, so
 * the debounce, the atomic rewrite and every failure path are exact and
 * instant. The second uses a real temp directory, because "the file was never
 * opened" is a claim about a real disk and deserves to be tested against one.
 *
 * Nothing here touches the user's config, the real ledger or the real Desktop.
 * Every path is a temp path or a fake key.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileCandidate } from '../contracts.js';
import {
  DEFAULT_MAX_ENTRIES,
  SIDE_INDEX_FILE_NAME,
  openSideIndex,
  sideIndexPathFor,
  type CancelTimer,
  type SideIndexIo,
  type SideIndexSchedule,
} from './sideindex.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const INDEX_PATH = path.resolve('/pigeon-sideindex-test/sideindex.jsonl');

const hex = (seed: string): string =>
  createHash('sha256').update(seed).digest('hex');

function candidate(name: string, size = 1024, mtimeMs = 1_700_000_000_000): FileCandidate {
  return { path: path.resolve(`/photos/${name}`), size, mtimeMs };
}

interface MemoryIo {
  io: SideIndexIo;
  files: Map<string, string>;
  calls: { read: number; append: number; rewrite: number };
  breakWrites(on: boolean): void;
  lines(): string[];
}

function memoryIo(seed?: string): MemoryIo {
  const files = new Map<string, string>();
  if (seed !== undefined) files.set(INDEX_PATH, seed);
  const calls = { read: 0, append: 0, rewrite: 0 };
  let broken = false;

  return {
    files,
    calls,
    breakWrites: (on: boolean) => {
      broken = on;
    },
    lines: () =>
      (files.get(INDEX_PATH) ?? '')
        .split('\n')
        .filter((line) => line.trim() !== ''),
    io: {
      async readFile(filePath: string): Promise<string> {
        calls.read += 1;
        const text = files.get(filePath);
        if (text === undefined) {
          const error = new Error(`ENOENT: no such file, open '${filePath}'`) as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return text;
      },
      async appendFile(filePath: string, data: string): Promise<void> {
        calls.append += 1;
        if (broken) throw new Error('the disk said no');
        files.set(filePath, (files.get(filePath) ?? '') + data);
      },
      async writeFileAtomic(filePath: string, data: string): Promise<void> {
        calls.rewrite += 1;
        if (broken) throw new Error('the disk said no');
        files.set(filePath, data);
      },
    },
  };
}

interface ManualSchedule {
  schedule: SideIndexSchedule;
  armedCount(): number;
  fireAll(): void;
}

function manualSchedule(): ManualSchedule {
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  return {
    schedule: (callback: () => void): CancelTimer => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    armedCount: () => timers.filter((timer) => !timer.cancelled).length,
    fireAll: () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback();
    },
  };
}

// ---------------------------------------------------------------------------
// Where it lives
// ---------------------------------------------------------------------------

describe('sideIndexPathFor', () => {
  it('puts the cache beside the ledger', () => {
    const ledger = path.join(path.sep, 'home', 'casey', '.photo-pigeon', 'ledger.jsonl');
    expect(sideIndexPathFor(ledger)).toBe(
      path.join(path.sep, 'home', 'casey', '.photo-pigeon', SIDE_INDEX_FILE_NAME),
    );
  });
});

// ---------------------------------------------------------------------------
// Remembering and matching
// ---------------------------------------------------------------------------

describe('the shortcut', () => {
  it('hands back a hash when path, size and mtime all match', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    const file = candidate('IMG_0001.jpg');

    expect(index.lookup(file)).toBeUndefined();
    index.remember(file, hex('one'));

    expect(index.lookup(file)).toBe(hex('one'));
    expect(index.stats.hits).toBe(1);
    expect(index.stats.bytesNotRead).toBe(1024);
  });

  it('refuses the shortcut when the mtime moved', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    index.remember(candidate('IMG_0001.jpg'), hex('one'));

    expect(index.lookup(candidate('IMG_0001.jpg', 1024, 1_700_000_000_001))).toBeUndefined();
  });

  it('refuses the shortcut when the size changed', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    index.remember(candidate('IMG_0001.jpg'), hex('one'));

    expect(index.lookup(candidate('IMG_0001.jpg', 2048))).toBeUndefined();
  });

  it('never remembers something that is not a sha256', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    const file = candidate('IMG_0001.jpg');

    index.remember(file, 'not-a-hash');
    index.remember(file, '');
    index.remember(file, 'A'.repeat(64));

    // Uppercase is folded and kept; the other two are refused outright, so a
    // malformed string can never come back out and be read as an identity.
    expect(index.lookup(file)).toBe('a'.repeat(64));
  });

  it('treats a different file at the same path as a miss', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    const first = candidate('IMG_0001.jpg', 1024, 1_000);
    index.remember(first, hex('one'));

    const replaced = candidate('IMG_0001.jpg', 4096, 2_000);
    expect(index.lookup(replaced)).toBeUndefined();

    index.remember(replaced, hex('two'));
    expect(index.lookup(replaced)).toBe(hex('two'));
    expect(index.lookup(first)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('survives a reopen', async () => {
    const memory = memoryIo();
    const first = await openSideIndex(INDEX_PATH, { io: memory.io });
    first.remember(candidate('IMG_0001.jpg'), hex('one'));
    first.remember(candidate('IMG_0002.jpg'), hex('two'));
    await first.close();

    const second = await openSideIndex(INDEX_PATH, { io: memory.io });
    expect(second.lookup(candidate('IMG_0001.jpg'))).toBe(hex('one'));
    expect(second.lookup(candidate('IMG_0002.jpg'))).toBe(hex('two'));
    expect(second.stats.entries).toBe(2);
  });

  it('writes a header and one line per file', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    index.remember(candidate('IMG_0001.jpg'), hex('one'));
    await index.close();

    const lines = memory.lines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ index: 'photo-pigeon-sideindex', version: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ size: 1024, mtimeMs: 1_700_000_000_000, hash: hex('one') });
  });

  it('creates the file with one atomic rewrite, then appends', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io });

    index.remember(candidate('a.jpg'), hex('a'));
    await index.flush();
    expect(memory.calls.rewrite).toBe(1);
    expect(memory.calls.append).toBe(0);

    index.remember(candidate('b.jpg'), hex('b'));
    await index.flush();
    expect(memory.calls.rewrite).toBe(1);
    expect(memory.calls.append).toBe(1);
  });

  it('keeps the newest reading when one path was written twice', async () => {
    const seed = [
      JSON.stringify({ index: 'photo-pigeon-sideindex', version: 1 }),
      JSON.stringify({ path: candidate('a.jpg').path, size: 1, mtimeMs: 1, hash: hex('old') }),
      JSON.stringify({ path: candidate('a.jpg').path, size: 2, mtimeMs: 2, hash: hex('new') }),
      '',
    ].join('\n');
    const memory = memoryIo(seed);

    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    expect(index.stats.entries).toBe(1);
    expect(index.lookup(candidate('a.jpg', 2, 2))).toBe(hex('new'));
    expect(index.lookup(candidate('a.jpg', 1, 1))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A cache is allowed to be wrong by being absent
// ---------------------------------------------------------------------------

describe('corruption', () => {
  it('rebuilds silently when the file is garbage', async () => {
    const warnings: string[] = [];
    const memory = memoryIo('this is not json at all\n  binary spew\n');

    const index = await openSideIndex(INDEX_PATH, {
      io: memory.io,
      onWarning: (message) => warnings.push(message),
    });

    expect(index.stats.entries).toBe(0);
    expect(index.lookup(candidate('a.jpg'))).toBeUndefined();

    // And it heals: the next write replaces the rubbish wholesale rather than
    // appending onto something it does not understand.
    index.remember(candidate('a.jpg'), hex('a'));
    await index.close();
    expect(memory.calls.rewrite).toBe(1);
    expect(memory.calls.append).toBe(0);

    const reopened = await openSideIndex(INDEX_PATH, { io: memory.io });
    expect(reopened.lookup(candidate('a.jpg'))).toBe(hex('a'));
  });

  it('says nothing at all by default: a cache miss is not news', async () => {
    const memory = memoryIo('garbage\n');
    // No onWarning. The default must be silent, not console noise on every start.
    await expect(openSideIndex(INDEX_PATH, { io: memory.io })).resolves.toBeTruthy();
  });

  it('drops a torn last line and keeps the rest', async () => {
    const warnings: string[] = [];
    const seed =
      [
        JSON.stringify({ index: 'photo-pigeon-sideindex', version: 1 }),
        JSON.stringify({ path: candidate('a.jpg').path, size: 1024, mtimeMs: 1_700_000_000_000, hash: hex('a') }),
        '{"path":"/photos/b.jpg","size":10',
      ].join('\n') + '\n';
    const memory = memoryIo(seed);

    const index = await openSideIndex(INDEX_PATH, {
      io: memory.io,
      onWarning: (message) => warnings.push(message),
    });

    expect(index.lookup(candidate('a.jpg'))).toBe(hex('a'));
    expect(index.lookup(candidate('b.jpg'))).toBeUndefined();
    expect(warnings.join(' ')).toContain('1 line');
  });

  it('rebuilds when the version is one it does not know', async () => {
    const seed = [
      JSON.stringify({ index: 'photo-pigeon-sideindex', version: 99 }),
      JSON.stringify({ path: candidate('a.jpg').path, size: 1024, mtimeMs: 1_700_000_000_000, hash: hex('a') }),
      '',
    ].join('\n');
    const memory = memoryIo(seed);

    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    expect(index.stats.entries).toBe(0);
    expect(index.lookup(candidate('a.jpg'))).toBeUndefined();
  });

  it('drops a line whose hash is not a real sha256', async () => {
    const seed = [
      JSON.stringify({ index: 'photo-pigeon-sideindex', version: 1 }),
      JSON.stringify({ path: candidate('a.jpg').path, size: 1024, mtimeMs: 1_700_000_000_000, hash: 'nope' }),
      JSON.stringify({ path: candidate('b.jpg').path, size: 1024, mtimeMs: 1_700_000_000_000, hash: hex('b') }),
      '',
    ].join('\n');
    const memory = memoryIo(seed);

    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    expect(index.lookup(candidate('a.jpg'))).toBeUndefined();
    expect(index.lookup(candidate('b.jpg'))).toBe(hex('b'));
  });

  it('keeps working when the cache cannot be written at all', async () => {
    const warnings: string[] = [];
    const memory = memoryIo();
    memory.breakWrites(true);

    const index = await openSideIndex(INDEX_PATH, {
      io: memory.io,
      onWarning: (message) => warnings.push(message),
    });

    index.remember(candidate('a.jpg'), hex('a'));
    await expect(index.close()).resolves.toBeUndefined();

    // In memory it still works for the rest of this run, which is where most of
    // the value is on a single long watch anyway.
    expect(index.lookup(candidate('a.jpg'))).toBe(hex('a'));
    expect(warnings.join(' ')).toContain('re-reads unchanged files');

    // One complaint, not one per file.
    index.remember(candidate('b.jpg'), hex('b'));
    await index.flush();
    expect(warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Writing behaviour
// ---------------------------------------------------------------------------

describe('debounced writes', () => {
  it('costs one write for a burst of five hundred files, not five hundred', async () => {
    const memory = memoryIo();
    const timers = manualSchedule();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io, schedule: timers.schedule });

    for (let n = 0; n < 500; n += 1) index.remember(candidate(`photo-${n}.jpg`), hex(`p${n}`));

    expect(memory.calls.rewrite + memory.calls.append).toBe(0);
    expect(timers.armedCount()).toBe(1);

    timers.fireAll();
    await index.flush();

    expect(memory.calls.rewrite + memory.calls.append).toBe(1);
    expect(memory.lines()).toHaveLength(501);
  });

  it('flushes what is still pending on close', async () => {
    const memory = memoryIo();
    const timers = manualSchedule();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io, schedule: timers.schedule });

    index.remember(candidate('a.jpg'), hex('a'));
    expect(memory.lines()).toHaveLength(0);

    await index.close();
    expect(memory.lines()).toHaveLength(2);
  });

  it('compacts a file that has grown far past its live entries', async () => {
    const lines = [JSON.stringify({ index: 'photo-pigeon-sideindex', version: 1 })];
    for (let n = 0; n < 1_200; n += 1) {
      lines.push(
        JSON.stringify({
          path: candidate('a.jpg').path,
          size: 1024,
          mtimeMs: 1_700_000_000_000,
          hash: hex(`round-${n}`),
        }),
      );
    }
    const memory = memoryIo(`${lines.join('\n')}\n`);

    const index = await openSideIndex(INDEX_PATH, { io: memory.io });
    expect(index.stats.entries).toBe(1);

    index.remember(candidate('b.jpg'), hex('b'));
    await index.close();

    expect(memory.calls.rewrite).toBe(1);
    expect(memory.calls.append).toBe(0);
    expect(memory.lines()).toHaveLength(3);
  });

  it('drops the oldest entries once it is full', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io, maxEntries: 3 });

    for (const name of ['a', 'b', 'c', 'd']) {
      index.remember(candidate(`${name}.jpg`), hex(name));
    }

    expect(index.stats.entries).toBe(3);
    expect(index.lookup(candidate('a.jpg'))).toBeUndefined();
    expect(index.lookup(candidate('d.jpg'))).toBe(hex('d'));
  });

  it('keeps a file young by touching it, so the cap evicts the truly idle one', async () => {
    const memory = memoryIo();
    const index = await openSideIndex(INDEX_PATH, { io: memory.io, maxEntries: 2 });

    index.remember(candidate('a.jpg'), hex('a'));
    index.remember(candidate('b.jpg'), hex('b'));
    // Seen again: a.jpg moves to the young end.
    index.remember(candidate('a.jpg'), hex('a'));
    index.remember(candidate('c.jpg'), hex('c'));

    expect(index.lookup(candidate('a.jpg'))).toBe(hex('a'));
    expect(index.lookup(candidate('b.jpg'))).toBeUndefined();
  });

  it('ships a cap that is generous enough to be invisible on a real shelf', () => {
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThanOrEqual(100_000);
  });
});

// ---------------------------------------------------------------------------
// Against a real disk
// ---------------------------------------------------------------------------

describe('on a real filesystem', () => {
  let dir: string;
  let indexPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'pigeon-sideindex-'));
    indexPath = path.join(dir, SIDE_INDEX_FILE_NAME);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, body: string): Promise<FileCandidate> => {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, body);
    const info = await fs.stat(filePath);
    return { path: filePath, size: info.size, mtimeMs: info.mtimeMs };
  };

  it('round trips a real hash through a real file', async () => {
    const photo = await write('IMG_0001.jpg', 'pretend jpeg bytes');
    const digest = createHash('sha256').update('pretend jpeg bytes').digest('hex');

    const first = await openSideIndex(indexPath, {});
    first.remember(photo, digest);
    await first.close();

    await expect(fs.stat(indexPath)).resolves.toBeTruthy();

    const second = await openSideIndex(indexPath, {});
    expect(second.lookup(photo)).toBe(digest);
  });

  it('misses after the file is genuinely touched', async () => {
    const photo = await write('IMG_0001.jpg', 'pretend jpeg bytes');
    const index = await openSideIndex(indexPath, {});
    index.remember(photo, hex('one'));

    const later = photo.mtimeMs + 5_000;
    await fs.utimes(photo.path, new Date(later), new Date(later));
    const info = await fs.stat(photo.path);

    expect(index.lookup({ path: photo.path, size: info.size, mtimeMs: info.mtimeMs })).toBeUndefined();
  });

  it('starts empty and stays quiet when there is no file yet', async () => {
    const warnings: string[] = [];
    const index = await openSideIndex(indexPath, { onWarning: (m) => warnings.push(m) });

    expect(index.stats.entries).toBe(0);
    expect(warnings).toEqual([]);
  });
});
