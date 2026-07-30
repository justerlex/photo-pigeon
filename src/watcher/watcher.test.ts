import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppConfig, type FileCandidate, WRITE_SETTLE_MS } from '../contracts.js';
import { buildWatchOptions, createIgnorePredicate, createWatcher, type Watcher } from './index.js';

/** Short settle window so the suite does not sit through the real two seconds per file. */
const SETTLE_MS = 300;
const POLL_MS = 40;
/** Generous headroom over the settle window: Windows file events are not instant. */
const GRACE_MS = 2_500;

let root: string;
let open: Watcher[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configFor(dirs: string[], extensions: string[]): AppConfig {
  return {
    watchDirs: dirs,
    credentialsPath: path.join(root, 'client.json'),
    tokenPath: path.join(root, 'token.json'),
    ledgerPath: path.join(root, 'ledger.json'),
    extensions,
  };
}

async function startWatcher(
  config: AppConfig,
  seen: FileCandidate[],
  errors: unknown[] = [],
): Promise<Watcher> {
  const watcher = createWatcher(config, (candidate) => seen.push(candidate), {
    stabilityThreshold: SETTLE_MS,
    pollInterval: POLL_MS,
    onError: (error) => errors.push(error),
  });
  open.push(watcher);
  await watcher.ready;
  return watcher;
}

/** Waits until the predicate holds or the deadline passes. Returns whether it held. */
async function waitFor(predicate: () => boolean, timeoutMs = GRACE_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

async function write(relative: string, contents = 'photo bytes'): Promise<string> {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
  return full;
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pigeon-watch-')));
  open = [];
});

afterEach(async () => {
  for (const watcher of open) await watcher.close();
  open = [];
  await fs.rm(root, { recursive: true, force: true });
});

describe('buildWatchOptions', () => {
  it('never polls by default: watching is event driven', () => {
    const options = buildWatchOptions(configFor([root], ['.jpg']));
    expect(options.usePolling).toBe(false);
  });

  it('turns polling on only when the config asks for the network drive fallback', () => {
    const options = buildWatchOptions({ ...configFor([root], ['.jpg']), pollFallback: true });
    expect(options.usePolling).toBe(true);
  });

  it('waits out the shared settle window before calling a file finished', () => {
    const options = buildWatchOptions(configFor([root], ['.jpg']));
    expect(options.awaitWriteFinish).toMatchObject({ stabilityThreshold: WRITE_SETTLE_MS });
  });

  it('leaves what is already on disk to the reconciliation pass', () => {
    const options = buildWatchOptions(configFor([root], ['.jpg']));
    expect(options.ignoreInitial).toBe(true);
  });
});

describe('createIgnorePredicate', () => {
  const dirs = ['C:/pics'];
  const predicate = createIgnorePredicate(dirs, ['.jpg']);
  const fileStats = { isFile: () => true } as never;

  it('keeps folders walkable: a folder is never judged on its extension', () => {
    expect(predicate(path.resolve('C:/pics/Holiday 2026'))).toBe(false);
    expect(predicate(path.resolve('C:/pics/Holiday 2026'), { isFile: () => false } as never)).toBe(
      false,
    );
  });

  it('never ignores a watch root, even a hidden one', () => {
    const hidden = createIgnorePredicate(['C:/pics/.private'], ['.jpg']);
    expect(hidden(path.resolve('C:/pics/.private'))).toBe(false);
  });

  it('ignores junk and rejected extensions once the entry is known to be a file', () => {
    expect(predicate(path.resolve('C:/pics/~$lock.jpg'), fileStats)).toBe(true);
    expect(predicate(path.resolve('C:/pics/note.txt'), fileStats)).toBe(true);
    expect(predicate(path.resolve('C:/pics/IMG_1.jpg'), fileStats)).toBe(false);
  });
});

describe('createWatcher', () => {
  it('refuses to start with nothing to watch', () => {
    expect(() => createWatcher(configFor([], ['.jpg']), () => {})).toThrow(/watchDirs/);
  });

  it('reports a new file once it has settled', async () => {
    const seen: FileCandidate[] = [];
    await startWatcher(configFor([root], ['.jpg']), seen);

    const full = await write('IMG_0001.jpg');

    expect(await waitFor(() => seen.length > 0)).toBe(true);
    expect(seen[0].path).toBe(full);
    expect(seen[0].size).toBeGreaterThan(0);
    expect(seen[0].mtimeMs).toBeGreaterThan(0);
  });

  it('holds a file back while it is still being written', async () => {
    const seen: FileCandidate[] = [];
    await startWatcher(configFor([root], ['.jpg']), seen);

    const full = path.join(root, 'growing.jpg');
    const handle = await fs.open(full, 'w');
    try {
      for (let i = 0; i < 8; i += 1) {
        await handle.write('more bytes arriving ');
        await sleep(80);
      }
      // Still mid-write, well past the settle window in elapsed time but never
      // once quiet for that long, so nothing may have been offered yet.
      expect(seen).toHaveLength(0);
    } finally {
      await handle.close();
    }

    expect(await waitFor(() => seen.length > 0)).toBe(true);
    expect(seen[0].path).toBe(full);
  });

  it('reports again when an existing file gains new bytes', async () => {
    const seen: FileCandidate[] = [];
    await startWatcher(configFor([root], ['.jpg']), seen);

    const full = await write('IMG_0002.jpg', 'first');
    expect(await waitFor(() => seen.length > 0)).toBe(true);

    await fs.appendFile(full, ' and more');
    expect(await waitFor(() => seen.length > 1)).toBe(true);
    expect(seen[1].path).toBe(full);
    expect(seen[1].size).toBeGreaterThan(seen[0].size);
  });

  it('filters junk and rejected extensions, and finds files in new subfolders', async () => {
    const seen: FileCandidate[] = [];
    await startWatcher(configFor([root], ['.jpg', '.ini', '.db']), seen);

    await write('~$lock.jpg');
    await write('half.jpg.tmp');
    await write('chrome.jpg.crdownload');
    await write('aria.jpg.partial');
    await write('desktop.ini');
    await write('Thumbs.db');
    await write('.hidden.jpg');
    await write('notes.txt');
    const keeper = await write('trip/IMG_0003.jpg');

    expect(await waitFor(() => seen.length > 0)).toBe(true);
    // Give every rejected write the same chance to arrive late before judging.
    await sleep(SETTLE_MS * 3);

    expect(seen.map((candidate) => candidate.path)).toEqual([keeper]);
  });

  it('matches extensions case-insensitively', async () => {
    const seen: FileCandidate[] = [];
    await startWatcher(configFor([root], ['.JPG']), seen);

    const full = await write('IMG_0004.jpg');

    expect(await waitFor(() => seen.length > 0)).toBe(true);
    expect(seen[0].path).toBe(full);
  });

  it('stops reporting after close, and closing twice is harmless', async () => {
    const seen: FileCandidate[] = [];
    const watcher = await startWatcher(configFor([root], ['.jpg']), seen);

    await watcher.close();
    await watcher.close();

    await write('IMG_0005.jpg');
    await sleep(SETTLE_MS * 3);

    expect(seen).toHaveLength(0);
  });

  it('ignores what was already on disk: that is reconciliation work', async () => {
    await write('already-here.jpg');

    const seen: FileCandidate[] = [];
    await startWatcher(configFor([root], ['.jpg']), seen);
    await sleep(SETTLE_MS * 3);

    expect(seen).toHaveLength(0);
  });
});
