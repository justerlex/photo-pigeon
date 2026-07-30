/**
 * Lock tests.
 *
 * The interesting half is not taking a free lock, it is judging one that is
 * already there. On Windows a watcher is normally terminated rather than asked
 * to stop, so a lock file that outlived its owner is the ordinary case and not
 * the exotic one: get that wrong in the strict direction and the tool wedges
 * after the first hard stop, get it wrong in the loose direction and two
 * watchers upload the same photo twice.
 */

import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLock,
  describeHolder,
  isProcessAlive,
  lockPathFor,
  readLock,
  selfStartedAt,
  type LockOptions,
  type LockRecord,
} from './lock.js';

let dir: string;
let ledgerPath: string;

/**
 * No heartbeat in tests: an interval per acquire is a timer per acquire.
 *
 * No second look either, by default. The real one is longer than a heartbeat
 * because that is what it takes to catch a live holder breathing, and the
 * tests that care about it ask for a window they can measure in milliseconds.
 */
const quiet: LockOptions = { heartbeatMs: 0, observeMs: 0 };

/** Polls until the condition holds, so a timing test fails as a timeout and not as a flake. */
const waitFor = async (condition: () => boolean | Promise<boolean>, within = 2_000): Promise<void> => {
  const deadline = Date.now() + within;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A pid that is not ours, so the exact self comparison does not short circuit. */
const OTHER_PID = process.pid + 1;

const writeLock = async (record: Partial<LockRecord> = {}): Promise<LockRecord> => {
  const full: LockRecord = {
    pid: OTHER_PID,
    startedAt: selfStartedAt(),
    takenAt: new Date().toISOString(),
    host: 'test-host',
    holder: 'watch',
    ...record,
  };
  await fs.writeFile(lockPathFor(ledgerPath), JSON.stringify(full), 'utf8');
  return full;
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'pigeon-lock-'));
  ledgerPath = path.join(dir, 'ledger.jsonl');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('taking a free lock', () => {
  it('writes a readable record next to the ledger', async () => {
    const result = await acquireLock(ledgerPath, quiet);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.path).toBe(path.join(dir, 'watch.lock'));
    expect(result.lock.stolen).toBe(false);

    const onDisk = await readLock(ledgerPath);
    expect(onDisk?.pid).toBe(process.pid);
    expect(onDisk?.holder).toBe('watch');

    await result.lock.release();
    expect(await readLock(ledgerPath)).toBeNull();
  });

  it('creates the folder when the ledger has never been written', async () => {
    const fresh = path.join(dir, 'not', 'there', 'ledger.jsonl');
    const result = await acquireLock(fresh, quiet);

    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
  });

  it('releases only once, and says nothing the second time', async () => {
    const result = await acquireLock(ledgerPath, quiet);
    if (!result.ok) throw new Error('expected the lock');

    await result.lock.release();
    await expect(result.lock.release()).resolves.toBeUndefined();
  });
});

describe('held', () => {
  it('refuses when the holder is alive, and names the pid', async () => {
    const holder = await writeLock();

    const result = await acquireLock(ledgerPath, { ...quiet, probe: () => true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('held');
    expect(result.heldBy.pid).toBe(holder.pid);
    expect(describeHolder(result.heldBy)).toContain(`pid ${holder.pid}`);
  });

  it('leaves the record on disk untouched', async () => {
    const holder = await writeLock();

    await acquireLock(ledgerPath, { ...quiet, probe: () => true });

    expect((await readLock(ledgerPath))?.pid).toBe(holder.pid);
  });
});

describe('stale', () => {
  it('takes over when the holding process is gone', async () => {
    await writeLock();

    const result = await acquireLock(ledgerPath, { ...quiet, probe: () => false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.stolen).toBe(true);
    expect((await readLock(ledgerPath))?.pid).toBe(process.pid);
    await result.lock.release();
  });

  it('takes over when the pid is alive but started at a different time', async () => {
    // The pid came back round to somebody else. Alive, and not the process that
    // wrote this file, which is exactly the case a liveness probe cannot see.
    const holder = await writeLock({ startedAt: 1_600_000_000_000 });

    const result = await acquireLock(ledgerPath, {
      ...quiet,
      probe: () => true,
      startedAtOf: (pid) => (pid === holder.pid ? 1_700_000_000_000 : undefined),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.stolen).toBe(true);
    await result.lock.release();
  });

  it('stays out when the reported start time matches, within tolerance', async () => {
    const startedAt = 1_600_000_000_000;
    const holder = await writeLock({ startedAt });

    const result = await acquireLock(ledgerPath, {
      ...quiet,
      probe: () => true,
      // Half a second apart: one side measured from inside the process, the
      // other from the operating system. Same process.
      startedAtOf: (pid) => (pid === holder.pid ? startedAt + 500 : undefined),
    });

    expect(result.ok).toBe(false);
  });

  it('takes over our own pid when the start time disagrees', async () => {
    // A recycled pid that happens to be ours would otherwise be judged held,
    // by us, on the strength of us being alive.
    await writeLock({ pid: process.pid, startedAt: selfStartedAt() - 60 * 60_000 });

    const result = await acquireLock(ledgerPath, quiet);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lock.stolen).toBe(true);
      await result.lock.release();
    }
  });

  it('takes over when nothing has touched the lock for longer than the stale window', async () => {
    // Alive, unverifiable, and not breathing. This is the reboot case where a
    // pid was handed to an unrelated program.
    const old = new Date(Date.now() - 30 * 60_000);
    await writeLock();
    await fs.utimes(lockPathFor(ledgerPath), old, old);

    const result = await acquireLock(ledgerPath, {
      ...quiet,
      probe: () => true,
      staleAfterMs: 5 * 60_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
  });

  it('watches a cold lock before taking it, and leaves it alone when it breathes', async () => {
    // The reproduction this test exists for: a watcher that is alive and
    // working, whose lock file's mtime has gone cold for a reason that has
    // nothing to do with it. A wall clock corrected forward by ten minutes, a
    // laptop resumed, an utimes a filter driver refused. One reading of the
    // mtime is the only discriminator left in a real run, and acting on it
    // alone hands the ledger to a second watcher while the first still has it.
    const cold = new Date(Date.now() - 30 * 60_000);
    await writeLock();
    await fs.utimes(lockPathFor(ledgerPath), cold, cold);

    // The holder's next heartbeat, mid window.
    const beat = setTimeout(() => {
      const at = new Date();
      void fs.utimes(lockPathFor(ledgerPath), at, at).catch(() => undefined);
    }, 40);

    const result = await acquireLock(ledgerPath, {
      heartbeatMs: 0,
      probe: () => true,
      staleAfterMs: 5 * 60_000,
      observeMs: 250,
    });
    clearTimeout(beat);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('held');
    // And the live holder's record is still the one on disk.
    expect((await readLock(ledgerPath))?.pid).toBe(OTHER_PID);
  });

  it('takes a cold lock that never moves for the whole window', async () => {
    const cold = new Date(Date.now() - 30 * 60_000);
    await writeLock();
    await fs.utimes(lockPathFor(ledgerPath), cold, cold);

    const result = await acquireLock(ledgerPath, {
      heartbeatMs: 0,
      probe: () => true,
      staleAfterMs: 5 * 60_000,
      observeMs: 60,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lock.stolen).toBe(true);
      await result.lock.release();
    }
  });

  it('treats a torn or hand mangled lock file as stale', async () => {
    await fs.writeFile(lockPathFor(ledgerPath), '{"pid": 41', 'utf8');

    const result = await acquireLock(ledgerPath, { ...quiet, probe: () => true });

    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
  });
});

describe('stealing happens once', () => {
  it('gives one winner when several processes judge the same lock stale', async () => {
    await writeLock();

    const attempts = await Promise.all([
      acquireLock(ledgerPath, { ...quiet, probe: () => false }),
      acquireLock(ledgerPath, { ...quiet, probe: () => false }),
      acquireLock(ledgerPath, { ...quiet, probe: () => false }),
      acquireLock(ledgerPath, { ...quiet, probe: () => false }),
    ]);

    const winners = attempts.filter((attempt) => attempt.ok);
    expect(winners).toHaveLength(1);
    for (const attempt of attempts) {
      if (!attempt.ok) expect(['held', 'contended']).toContain(attempt.reason);
    }

    for (const attempt of attempts) if (attempt.ok) await attempt.lock.release();
  });

  it('stays out while somebody else is mid steal', async () => {
    await writeLock();
    // A claim file that is fresh means a steal is in flight right now.
    await fs.writeFile(`${lockPathFor(ledgerPath)}.claim`, '{"pid":424242}', 'utf8');

    const result = await acquireLock(ledgerPath, { ...quiet, probe: () => false });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('contended');
  });

  it('sweeps a claim whose owner never finished', async () => {
    await writeLock();
    const claim = `${lockPathFor(ledgerPath)}.claim`;
    await fs.writeFile(claim, '{"pid":424242}', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(claim, old, old);

    const result = await acquireLock(ledgerPath, { ...quiet, probe: () => false });

    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
    await expect(fs.stat(claim)).rejects.toThrow();
  });
});

describe('the holder defends its own lock', () => {
  it('stands down when somebody else has taken it over', async () => {
    // Reproduced before this existed: the robbed holder never noticed, carried
    // on watching the same folders, and hashed and uploaded the same files as
    // the thief. Two watchers, one ledger, and Google gets the photo twice.
    const losses: string[] = [];
    let robber = 0;
    const mine = await acquireLock(ledgerPath, {
      heartbeatMs: 15,
      observeMs: 0,
      onLost: (loss, heldBy) => {
        losses.push(loss);
        robber = heldBy?.pid ?? 0;
      },
    });
    if (!mine.ok) throw new Error('expected the lock');

    const usurper = await writeLock({ pid: 424242 });
    await waitFor(() => losses.length > 0);

    expect(losses).toEqual(['stolen']);
    expect(robber).toBe(usurper.pid);

    // And it says it once, however long it is left running afterwards.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(losses).toEqual(['stolen']);

    await mine.lock.release();
    // The thief's record is still there: standing down is not a reason to
    // delete a file that belongs to somebody else now.
    expect((await readLock(ledgerPath))?.pid).toBe(usurper.pid);
  });

  it('takes the lock back when the file vanishes under it', async () => {
    // A thief that judged us stale removes the lock on its way out, which
    // leaves this ledger guarded by nothing while we are still watching it, so
    // a third process would start freely. Reproduced exactly that way.
    const losses: string[] = [];
    const mine = await acquireLock(ledgerPath, {
      heartbeatMs: 15,
      observeMs: 0,
      onLost: (loss) => losses.push(loss),
    });
    if (!mine.ok) throw new Error('expected the lock');

    await fs.rm(lockPathFor(ledgerPath), { force: true });
    await waitFor(async () => (await readLock(ledgerPath)) !== null);

    expect((await readLock(ledgerPath))?.pid).toBe(process.pid);
    expect(losses).toEqual([]);
    await mine.lock.release();
  });

  it('keeps saying it is alive, so nobody else reads it as abandoned', async () => {
    const mine = await acquireLock(ledgerPath, { heartbeatMs: 15, observeMs: 0 });
    if (!mine.ok) throw new Error('expected the lock');

    const at = new Date(Date.now() - 30 * 60_000);
    await fs.utimes(lockPathFor(ledgerPath), at, at);
    await waitFor(async () => {
      const stat = await fs.stat(lockPathFor(ledgerPath));
      return Date.now() - stat.mtimeMs < 60_000;
    });

    await mine.lock.release();
  });
});

describe('release', () => {
  it('leaves a lock alone once somebody else has taken it over', async () => {
    const first = await acquireLock(ledgerPath, quiet);
    if (!first.ok) throw new Error('expected the lock');

    // Somebody judged us stale and wrote themselves in.
    const usurper = await writeLock({ pid: 424242 });
    await first.lock.release();

    expect((await readLock(ledgerPath))?.pid).toBe(usurper.pid);
  });
});

describe('the liveness probe', () => {
  it('says a process that is definitely running is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('says a pid that cannot exist is not', () => {
    // Verified on win32: an unused pid answers ESRCH, and a live pid owned by
    // somebody else answers EPERM, which is why EPERM counts as alive.
    expect(isProcessAlive(0x7ffffffe)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
