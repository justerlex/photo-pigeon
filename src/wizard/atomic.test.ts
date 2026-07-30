/**
 * The atomic write, on the real file system and through the seam.
 *
 * The torn-write test is the one that matters: a reader hammering the file
 * while it is rewritten thirty times must never see anything but whole JSON.
 * It moved here with the writer when the dead second config module went away.
 */

import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileAtomic, writeFileAtomicVia } from './atomic.js';
import type { FsLike, StatLike } from './fs-like.js';

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-pigeon-atomic-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** An in-memory FsLike: enough for the seam, and it touches no disk at all. */
function fakeFs(): { fs: FsLike; files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const fs: FsLike = {
    async mkdir(target) {
      calls.push(`mkdir ${target}`);
    },
    async readdir() {
      return [...files.keys()];
    },
    async stat(): Promise<StatLike> {
      throw new Error('not needed');
    },
    async readFile(file) {
      const found = files.get(file);
      if (found === undefined) throw new Error(`missing ${file}`);
      return found;
    },
    async writeFile(file, data) {
      calls.push(`writeFile ${path.basename(file)}`);
      files.set(file, data);
    },
    async rename(from, to) {
      calls.push('rename');
      const found = files.get(from);
      if (found === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, found);
    },
  };
  return { fs, files, calls };
}

describe('writeFileAtomic', () => {
  it('creates the folder it was pointed at and writes the bytes', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'config.json');
    await writeFileAtomic(target, '{"hello":true}\n');
    expect(await fsp.readFile(target, 'utf8')).toBe('{"hello":true}\n');
  });

  it('replaces an existing file rather than failing on it', async () => {
    const target = path.join(dir, 'config.json');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    expect(await fsp.readFile(target, 'utf8')).toBe('second');
  });

  it('never leaves a torn or half written file behind', async () => {
    const target = path.join(dir, 'config.json');
    const small = JSON.stringify({ watchDirs: [path.join(dir, 'one')] }, null, 2);
    const large = JSON.stringify(
      { watchDirs: Array.from({ length: 500 }, (_, i) => path.join(dir, `folder-${i}`)) },
      null,
      2,
    );
    await writeFileAtomic(target, small);

    let stop = false;
    let cleanReads = 0;
    const reader = (async () => {
      while (!stop) {
        try {
          JSON.parse(readFileSync(target, 'utf8'));
          cleanReads++;
        } catch (err) {
          // A locked or momentarily absent file during rename is fine on Windows.
          // A parse failure is not: it would mean a reader saw a half written file.
          if (err instanceof SyntaxError) throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    for (let i = 0; i < 30; i++) {
      await writeFileAtomic(target, i % 2 === 0 ? large : small);
    }
    stop = true;
    await reader;

    expect(cleanReads).toBeGreaterThan(0);
    expect((await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves nothing but the file it was asked for', async () => {
    await writeFileAtomic(path.join(dir, 'config.json'), 'body');
    expect(await fsp.readdir(dir)).toEqual(['config.json']);
  });
});

describe('writeFileAtomicVia', () => {
  it('goes through the seam, temp file first, rename second', async () => {
    const { fs, files, calls } = fakeFs();
    const target = path.join(dir, 'config.json');
    await writeFileAtomicVia(fs, target, 'body');

    expect(files.get(target)).toBe('body');
    expect([...files.keys()]).toEqual([target]);
    expect(calls[0]).toBe(`mkdir ${dir}`);
    expect(calls[1]?.startsWith('writeFile .config.json.')).toBe(true);
    expect(calls[2]).toBe('rename');
  });

  it('picks a temp name nobody else would pick, so two writers cannot collide', async () => {
    const { fs, calls } = fakeFs();
    const target = path.join(dir, 'config.json');
    await writeFileAtomicVia(fs, target, 'one');
    await writeFileAtomicVia(fs, target, 'two');
    const temps = calls.filter((entry) => entry.startsWith('writeFile'));
    expect(temps).toHaveLength(2);
    expect(temps[0]).not.toBe(temps[1]);
  });
});
