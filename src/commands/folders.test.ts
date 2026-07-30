/**
 * `folders add` and `folders remove`, against a throwaway config in TEMP.
 *
 * This command rewrites the one file the whole tool is configured by, so the
 * tests are as much about what it leaves alone as about what it changes. Every
 * run below is pointed at a temp folder with `-c`, and the production install on
 * this machine is never named, read or written.
 *
 * The last two run the real CLI as a child process, because the guarantee the
 * status window depends on is about a file descriptor: under `--json` stdout
 * carries one JSON line and nothing else, so the shell may parse it strictly and
 * fail loudly rather than guess. A module test cannot see that, for the same
 * reason `machine-channel.test.ts` exists: the prose that would break it comes
 * from the layer above the run.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../contracts.js';
import { EXIT } from './errors.js';
import { type FoldersOutcome, ONE_MUST_STAY, runFolders } from './folders.js';
import type { Logger } from './log.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let work: string | undefined;

afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = undefined;
});

/** A logger that says nothing and remembers everything. */
function quiet(): { log: Logger; lines: () => string[] } {
  const lines: string[] = [];
  const push = (message: string): void => void lines.push(message);
  return {
    lines: () => lines,
    log: {
      info: push,
      ok: push,
      warn: push,
      error: push,
      muted: push,
      plain: (message = '') => push(message),
    },
  };
}

interface Scratch {
  dir: string;
  configPath: string;
  /** Folders that exist on disk, by the name they were made under. */
  folder(name: string): Promise<string>;
  read(): Promise<Record<string, unknown>>;
}

/**
 * A config folder with the shape the wizard writes: the watched folders, and the
 * three paths that are none of this command's business.
 */
async function scratch(watched: string[] = ['photos'], extra: object = {}): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), 'pigeon-folders-'));
  work = dir;
  const dirs: string[] = [];
  for (const name of watched) {
    const made = join(dir, name);
    await mkdir(made, { recursive: true });
    dirs.push(made);
  }
  const configPath = join(dir, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        watchDirs: dirs,
        credentialsPath: join(dir, 'credentials.json'),
        tokenPath: join(dir, 'token.json'),
        ledgerPath: join(dir, 'ledger.ndjson'),
        extensions: ['.jpg'],
        ...extra,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return {
    dir,
    configPath,
    async folder(name) {
      const made = join(dir, name);
      await mkdir(made, { recursive: true });
      return made;
    },
    async read() {
      return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    },
  };
}

/** One request, with the answer line captured rather than printed. */
async function ask(
  action: string,
  target: string,
  configPath: string,
): Promise<{ code: number; outcome: FoldersOutcome; said: string[] }> {
  const lines: string[] = [];
  const { log, lines: said } = quiet();
  const code = await runFolders(
    {
      action,
      path: target,
      config: configPath,
      json: true,
      emit: (line) => void lines.push(line),
      now: () => Date.UTC(2026, 6, 30, 12, 0, 0),
    },
    log,
  );
  expect(lines).toHaveLength(1);
  return { code, outcome: JSON.parse(lines[0]) as FoldersOutcome, said: said() };
}

describe('folders add', () => {
  it('appends the folder and answers with the list as it now stands', async () => {
    const box = await scratch();
    const second = await box.folder('more photos');

    const { code, outcome } = await ask('add', second, box.configPath);

    expect(code).toBe(EXIT.OK);
    expect(outcome.type).toBe('folders-changed');
    expect(outcome).toMatchObject({ added: second, configPath: box.configPath });
    expect(outcome.type === 'folders-changed' && outcome.watchDirs).toEqual([
      join(box.dir, 'photos'),
      second,
    ]);
    // And the answer carries the moment it happened, like every other event in
    // this project.
    expect(outcome.at).toBe('2026-07-30T12:00:00.000Z');
    expect((await box.read())['watchDirs']).toEqual([join(box.dir, 'photos'), second]);
  });

  it('copies every other key across untouched, including one it has never heard of', async () => {
    // The paths to the token, the ledger and the credentials live in this file
    // and none of them is this command's business. Neither is a key a newer
    // build might add: an editor that drops what it does not understand is an
    // editor nobody can trust with a config.
    const box = await scratch(['photos'], {
      albumName: 'holidays',
      pollFallback: true,
      somethingAFutureBuildAdded: { deep: [1, 2, 3] },
    });
    const before = await box.read();

    const { code } = await ask('add', await box.folder('second'), box.configPath);

    expect(code).toBe(EXIT.OK);
    const after = await box.read();
    for (const key of Object.keys(before)) {
      if (key === 'watchDirs') continue;
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after['somethingAFutureBuildAdded']).toEqual({ deep: [1, 2, 3] });
  });

  it('answers an add that changes nothing with the state it found', async () => {
    // The M3 channel rule, on this channel: a request that changes nothing is
    // still answered, because a front end reads silence as "it did not
    // understand" and acts on that reading.
    const box = await scratch();
    const already = join(box.dir, 'photos');

    const { code, outcome } = await ask('add', already, box.configPath);

    expect(code).toBe(EXIT.PROBLEMS);
    expect(outcome.type).toBe('folders-unchanged');
    expect(outcome.type === 'folders-unchanged' && outcome.why).toBe(
      'That one is already on the list.',
    );
    expect(outcome.type === 'folders-unchanged' && outcome.watchDirs).toEqual([already]);
  });

  it('refuses a folder that is not there, in the words setup uses', async () => {
    const box = await scratch();
    const missing = join(box.dir, 'nowhere');

    const { code, outcome } = await ask('add', missing, box.configPath);

    expect(code).toBe(EXIT.PROBLEMS);
    expect(outcome.type === 'folders-unchanged' && outcome.why).toBe(`No folder at ${missing}`);
    expect((await box.read())['watchDirs']).toEqual([join(box.dir, 'photos')]);
  });

  it('takes a path with the quotes Copy as path leaves on it', async () => {
    const box = await scratch();
    const second = await box.folder('second');

    const { code, outcome } = await ask('add', `"${second}"`, box.configPath);

    expect(code).toBe(EXIT.OK);
    expect(outcome).toMatchObject({ added: second });
  });
});

describe('folders remove', () => {
  it('drops the folder and leaves the rest of the list in order', async () => {
    const box = await scratch(['one', 'two', 'three']);

    const { code, outcome } = await ask('remove', join(box.dir, 'two'), box.configPath);

    expect(code).toBe(EXIT.OK);
    expect(outcome).toMatchObject({ removed: join(box.dir, 'two') });
    expect((await box.read())['watchDirs']).toEqual([join(box.dir, 'one'), join(box.dir, 'three')]);
  });

  it('removes a folder that is not on the disk any more', async () => {
    // The whole point of being able to edit the list. A folder that was deleted,
    // renamed or unplugged is exactly the one somebody wants off the list, and a
    // removal that first insisted the folder exist would leave the list
    // unfixable from the window.
    const box = await scratch(['one', 'gone']);
    await rm(join(box.dir, 'gone'), { recursive: true });

    const { code, outcome } = await ask('remove', join(box.dir, 'gone'), box.configPath);

    expect(code).toBe(EXIT.OK);
    expect(outcome).toMatchObject({ removed: join(box.dir, 'gone') });
    expect((await box.read())['watchDirs']).toEqual([join(box.dir, 'one')]);
  });

  it('refuses to leave nothing to watch, and says what to do instead', async () => {
    // Setup will not finish without a folder either, and a config with an empty
    // watchDirs is refused by validateConfig. Honouring this would answer "one
    // folder off the list" with a stopped engine.
    const box = await scratch(['only']);

    const { code, outcome } = await ask('remove', join(box.dir, 'only'), box.configPath);

    expect(code).toBe(EXIT.PROBLEMS);
    expect(outcome.type === 'folders-unchanged' && outcome.why).toBe(ONE_MUST_STAY);
    expect((await box.read())['watchDirs']).toEqual([join(box.dir, 'only')]);
  });

  it('answers a remove for a folder that was never on the list', async () => {
    const box = await scratch(['one', 'two']);
    const stranger = await box.folder('stranger');

    const { code, outcome } = await ask('remove', stranger, box.configPath);

    expect(code).toBe(EXIT.PROBLEMS);
    expect(outcome.type === 'folders-unchanged' && outcome.why).toContain('is not one of the');
    expect(outcome.type === 'folders-unchanged' && outcome.why).toContain(stranger);
  });

  it('reads a second spelling of one Windows folder as the same folder', async () => {
    if (process.platform !== 'win32') return;
    const box = await scratch(['One', 'Two']);

    const { code, outcome } = await ask(
      'remove',
      join(box.dir, 'One').toLowerCase(),
      box.configPath,
    );

    expect(code).toBe(EXIT.OK);
    expect(outcome.type === 'folders-changed' && outcome.watchDirs).toEqual([join(box.dir, 'Two')]);
  });
});

describe('what it will not touch', () => {
  it('never writes the token, the ledger, the quota counter or the album cache', async () => {
    // The tray must not write any of these: TRAY-DESIGN section 7. This command
    // is the closest anything outside a watch comes to them, because their paths
    // are in the file it edits.
    const box = await scratch();
    const bystanders = ['token.json', 'ledger.ndjson', 'credentials.json', 'quota.json', 'albums.json'];
    for (const name of bystanders) {
      await writeFile(join(box.dir, name), `${name} as it was\n`, 'utf8');
    }
    const before = await Promise.all(bystanders.map((name) => stat(join(box.dir, name))));

    const { code } = await ask('add', await box.folder('second'), box.configPath);
    expect(code).toBe(EXIT.OK);

    for (const [index, name] of bystanders.entries()) {
      const after = await stat(join(box.dir, name));
      expect(after.mtimeMs, name).toBe(before[index].mtimeMs);
      expect(await readFile(join(box.dir, name), 'utf8'), name).toBe(`${name} as it was\n`);
    }
  });

  it('refuses an action nobody knows, on the channel, naming the two that exist', async () => {
    const box = await scratch();
    const lines: string[] = [];
    const { log } = quiet();

    await expect(
      runFolders(
        { action: 'rename', path: join(box.dir, 'photos'), config: box.configPath, json: true, emit: (line) => void lines.push(line) },
        log,
      ),
    ).rejects.toThrow(/not something photo-pigeon does/);

    // Answered rather than swallowed, which is the same rule the core follows
    // for a word it does not know on a watch's stdin.
    const outcome = JSON.parse(lines[0]) as FoldersOutcome;
    expect(outcome.type).toBe('failed');
  });

  it('says there is no config rather than writing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pigeon-folders-'));
    work = dir;
    const { log } = quiet();

    await expect(
      runFolders({ action: 'add', path: dir, config: join(dir, 'config.json') }, log),
    ).rejects.toThrow(/No photo-pigeon config at/);

    await expect(stat(join(dir, 'config.json'))).rejects.toThrow();
  });

  it('will not rewrite a config it cannot fully understand', async () => {
    const box = await scratch();
    await writeFile(box.configPath, JSON.stringify({ watchDirs: 'not an array' }), 'utf8');
    const before = await readFile(box.configPath, 'utf8');
    const { log } = quiet();

    await expect(
      runFolders({ action: 'add', path: box.dir, config: box.configPath }, log),
    ).rejects.toThrow(/could not be used/);

    expect(await readFile(box.configPath, 'utf8')).toBe(before);
  });

  it('adds to a list that is empty, which is the machine that most needs it', async () => {
    // readConfigFile refuses a config with no watchDirs, and that refusal is
    // right for a watch and wrong here: an empty list is exactly what somebody
    // opens the window to fix.
    const box = await scratch([]);
    const first = await box.folder('photos');

    const { code, outcome } = await ask('add', first, box.configPath);

    expect(code).toBe(EXIT.OK);
    expect(outcome.type === 'folders-changed' && outcome.watchDirs).toEqual([first]);
  });
});

// ---------------------------------------------------------------------------
// the process boundary
// ---------------------------------------------------------------------------

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function runCli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PHOTO_PIGEON_DEBUG: '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('--json at the process boundary', () => {
  it(
    'puts one JSON line on stdout and every human word on stderr',
    async () => {
      const box = await scratch();
      const second = await box.folder('second');

      const run = await runCli(['folders', 'add', second, '--json', '-c', box.configPath]);

      expect(run.code).toBe(EXIT.OK);
      const lines = run.out.split('\n').filter((line) => line.trim() !== '');
      expect(lines).toHaveLength(1);
      const outcome = JSON.parse(lines[0]) as FoldersOutcome;
      expect(outcome.type).toBe('folders-changed');
      // The sentence about the running watch keeping its old list is the one a
      // person needs, and it never shares a descriptor with the answer.
      expect(run.err).toContain('keeps its old list until it restarts');
      expect(run.out).not.toContain('restarts');
    },
    60_000,
  );

  it(
    'keeps a refusal off stdout as prose, hint and all',
    async () => {
      // The M1 stage 2 review's second critical, in the one shape it can still
      // happen: a CommandError printed by the outer catch through a logger whose
      // warn goes to stdout. One non-JSON line takes a strict parser down.
      const box = await scratch();
      await writeFile(box.configPath, '{ not json', 'utf8');

      const run = await runCli(['folders', 'add', box.dir, '--json', '-c', box.configPath]);

      expect(run.code).toBe(EXIT.NOT_CONFIGURED);
      for (const line of run.out.split('\n').filter((line) => line.trim() !== '')) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      expect(JSON.parse(run.out.trim()) as FoldersOutcome).toMatchObject({ type: 'failed' });
      expect(run.err).toContain('Fix it in an editor');
    },
    60_000,
  );

  it(
    'says it plainly with no flag at all, and writes no JSON',
    async () => {
      const box = await scratch();
      const second = await box.folder('second');

      const run = await runCli(['folders', 'add', second, '-c', box.configPath]);

      expect(run.code).toBe(EXIT.OK);
      expect(run.out).toContain(second);
      expect(run.out).not.toContain('folders-changed');
      const written = JSON.parse(await readFile(box.configPath, 'utf8')) as AppConfig;
      expect(written.watchDirs).toHaveLength(2);
    },
    60_000,
  );
});
