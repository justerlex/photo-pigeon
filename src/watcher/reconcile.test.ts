import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../contracts.js';
import { reconcile, type ReconcileOptions } from './reconcile.js';

let root: string;

/**
 * The settle gate with the waiting taken out. Every call still re-stats, which
 * is the part under test everywhere else in this file, it just does not spend
 * two real seconds proving it.
 */
const FAST: ReconcileOptions = {
  stabilityThreshold: 5,
  maxSettleWaitMs: 20,
  sleep: async () => {},
};

async function makeFile(relative: string, contents = 'x'): Promise<string> {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
  return full;
}

function names(candidates: { path: string }[]): string[] {
  return candidates.map((candidate) => path.basename(candidate.path)).sort();
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pigeon-reconcile-')));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('reconcile', () => {
  it('enumerates pre-existing files, recursing into subfolders', async () => {
    await makeFile('IMG_0001.jpg');
    await makeFile('trip/IMG_0002.JPG');
    await makeFile('trip/day two/clip.mp4');

    const found = await reconcile([root], ['.jpg', '.mp4'], FAST);

    expect(names(found)).toEqual(['IMG_0001.jpg', 'IMG_0002.JPG', 'clip.mp4']);
  });

  it('returns real size and mtime for each candidate', async () => {
    const full = await makeFile('IMG_0001.jpg', 'twelve bytes');
    const stats = await fs.stat(full);

    const [candidate] = await reconcile([root], ['.jpg'], FAST);

    expect(candidate.path).toBe(full);
    expect(candidate.size).toBe(stats.size);
    expect(candidate.mtimeMs).toBeCloseTo(stats.mtimeMs, 0);
  });

  it('filters by extension case-insensitively and drops the rest', async () => {
    await makeFile('a.JPG');
    await makeFile('b.HeIc');
    await makeFile('c.txt');
    await makeFile('d.mp4');

    const found = await reconcile([root], ['.jpg', '.heic'], FAST);

    expect(names(found)).toEqual(['a.JPG', 'b.HeIc']);
  });

  it('skips temp and system junk, including whole junk folders', async () => {
    await makeFile('keep.jpg');
    await makeFile('~$lock.jpg');
    await makeFile('half.jpg.tmp');
    await makeFile('download.jpg.crdownload');
    await makeFile('partial.jpg.partial');
    await makeFile('desktop.ini');
    await makeFile('Thumbs.db');
    await makeFile('.hidden.jpg');
    await makeFile('.git/objects/buried.jpg');

    const found = await reconcile([root], ['.jpg', '.ini', '.db'], FAST);

    expect(names(found)).toEqual(['keep.jpg']);
  });

  it('accepts every extension when the list is empty', async () => {
    await makeFile('a.jpg');
    await makeFile('b.txt');

    const found = await reconcile([root], [], FAST);

    expect(names(found)).toEqual(['a.jpg', 'b.txt']);
  });

  it('yields a file once even when watch folders overlap', async () => {
    await makeFile('trip/IMG_0002.jpg');

    const found = await reconcile([root, path.join(root, 'trip')], ['.jpg'], FAST);

    expect(found).toHaveLength(1);
  });

  it('skips a missing folder instead of failing the whole pass', async () => {
    await makeFile('IMG_0001.jpg');

    const found = await reconcile([path.join(root, 'nope'), root], ['.jpg'], FAST);

    expect(names(found)).toEqual(['IMG_0001.jpg']);
  });

  it('returns an empty list for an empty folder', async () => {
    expect(await reconcile([root], ['.jpg'], FAST)).toEqual([]);
  });

  it('sorts by path so two runs are comparable', async () => {
    await makeFile('c.jpg');
    await makeFile('a.jpg');
    await makeFile('b.jpg');

    const found = await reconcile([root], ['.jpg'], FAST);

    expect(found.map((candidate) => path.basename(candidate.path))).toEqual([
      'a.jpg',
      'b.jpg',
      'c.jpg',
    ]);
  });

  it('accepts a whole AppConfig as well as the folders and extensions', async () => {
    await makeFile('IMG_0001.jpg');
    const config: AppConfig = {
      watchDirs: [root],
      credentialsPath: path.join(root, 'client.json'),
      tokenPath: path.join(root, 'token.json'),
      ledgerPath: path.join(root, 'ledger.json'),
      extensions: ['.jpg'],
    };

    const found = await reconcile(config, FAST);

    expect(names(found)).toEqual(['IMG_0001.jpg']);
  });
});

// ---------------------------------------------------------------------------
// The write-settle gate. Law 2 applies to the startup walk exactly as it
// applies to the live watcher: nothing is offered until it stops changing.
// ---------------------------------------------------------------------------

describe('reconcile write-settle gate', () => {
  it('waits for a growing file and reports the finished size, never the truncated one', async () => {
    const full = await makeFile('IMG_1234.jpg', 'aaa');
    let writes = 0;

    const found = await reconcile([root], ['.jpg'], {
      stabilityThreshold: 1,
      maxSettleWaitMs: 10,
      // The copy is still running when the walk finds the file, and finishes
      // during the first stability window.
      sleep: async () => {
        writes += 1;
        if (writes === 1) await fs.appendFile(full, 'bbbbbbbbb');
      },
    });

    const finished = await fs.stat(full);
    expect(names(found)).toEqual(['IMG_1234.jpg']);
    expect(found[0]?.size).toBe(finished.size);
    expect(found[0]?.size).not.toBe(3);
  });

  it('leaves a file that never stops growing to the watcher instead of uploading it half written', async () => {
    const full = await makeFile('import.jpg', 'a');
    const unsettled: string[] = [];

    const found = await reconcile([root], ['.jpg'], {
      stabilityThreshold: 1,
      maxSettleWaitMs: 3,
      sleep: async () => {
        await fs.appendFile(full, 'more');
      },
      onUnsettled: (candidate) => unsettled.push(path.basename(candidate.path)),
    });

    expect(found).toEqual([]);
    expect(unsettled).toEqual(['import.jpg']);
  });

  it('drops a file that disappeared between the walk and the check', async () => {
    const full = await makeFile('gone.jpg');
    await makeFile('stays.jpg');

    const found = await reconcile([root], ['.jpg'], {
      stabilityThreshold: 1,
      maxSettleWaitMs: 5,
      sleep: async () => {
        await fs.rm(full, { force: true });
      },
    });

    expect(names(found)).toEqual(['stays.jpg']);
  });

  it('costs one stability window for the whole folder, not one per file', async () => {
    for (let index = 0; index < 25; index += 1) await makeFile(`photo-${index}.jpg`);
    let sleeps = 0;

    const found = await reconcile([root], ['.jpg'], {
      stabilityThreshold: 1,
      maxSettleWaitMs: 10,
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(found).toHaveLength(25);
    expect(sleeps).toBe(1);
  });
});
