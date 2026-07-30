/**
 * folders: change what is watched, without walking the whole wizard again.
 *
 * Until this command existed, the last screen of `setup` was the only place a
 * watched folder could be chosen, so changing one meant re-running a five step
 * Google Cloud walkthrough to answer a question about a local directory. This is
 * that one question, on its own, with the same validation behind it.
 *
 * ## The channel
 *
 * `--json` writes **exactly one JSON line on stdout and nothing else**, which is
 * what the tray's status window reads, and human prose goes to stderr, the same
 * split `watch --events ndjson` and `setup --events ndjson` make.
 *
 * It is one line and not a stream, and that is a deliberate difference from the
 * other two rather than a shortcut. Those are runs: they start, they narrate,
 * and `stopped` is the last thing they say. This is a request with one answer, so
 * it wears the shape `doctor --json` already established for exactly that: one
 * line, parsed by the last-line reader in `app/src-tauri/src/ipc.rs`.
 *
 * What it does keep is the rule that made the M3 machine channel legible:
 * **every request is answered, including the ones that change nothing.** A front
 * end has exactly one reading of silence, that the core did not understand, and
 * it acts on that reading. So an add of a folder that is already watched, a
 * remove of a folder that was never watched, and a remove that would leave
 * nothing to watch all come back as `folders-unchanged` carrying the core's own
 * sentence, and the page renders that sentence rather than inventing one.
 * Validation lives on the side holding the file, always.
 *
 * ## What it will not do
 *
 * * **It never touches the token, the ledger, the quota counter or the album
 *   cache.** It rewrites one array in `config.json` and copies every other key
 *   across untouched, including keys this build has never heard of.
 * * **It never stops or starts a watch, and it takes no lock.** Safe to run while
 *   a watch is running, for the same reason setup is: the lock belongs to the
 *   ledger's folder and nothing here goes near it. A running watch loaded its
 *   config at start and holds it in memory, so this file changing means nothing to
 *   it until it is restarted. That restart is the shell's job, and the shell says
 *   so out loud rather than leaving the two to diverge in silence:
 *   `app/src-tauri/src/supervisor.rs`, `restart_core`.
 * * **It deletes nothing and it un-uploads nothing.** Removing a folder from the
 *   list stops it being walked next time. Everything already delivered stays
 *   delivered and stays in the ledger, because upload only means there is no code
 *   in this program that could do anything else. A batch already in flight
 *   finishes: the shell's restart is a `stop`, which is a drain, and abandoning a
 *   half filed batch is how a file gets uploaded twice.
 */

import path from 'node:path';

import type { AppConfig } from '../contracts.js';
import { inspectAppConfig, readAppConfig, writeAppConfig } from '../wizard/config.js';
import { type FsLike, nodeFs } from '../wizard/fs-like.js';
import {
  checkWatchDir,
  cleanTypedPath,
  isWatchedAlready,
  NEEDS_A_PATH,
  sameWatchDir,
} from '../wizard/watch-dirs.js';
import { resolveConfigPath } from './config.js';
import { CommandError, EXIT, messageOf } from './errors.js';
import { plural } from './format.js';
import { createLogger, type Logger } from './log.js';

/** The two things this command can do to the list. */
export const FOLDER_ACTIONS = ['add', 'remove'] as const;

/** One of the two. */
export type FolderAction = (typeof FOLDER_ACTIONS)[number];

/**
 * The refusal when the last watched folder is the one being removed.
 *
 * Setup will not finish without a folder either: its loop asks until it has one.
 * A config with an empty `watchDirs` is refused by `validateConfig`, so honouring
 * this removal would write a file that the next watch cannot run on, and the user
 * would have asked for one folder to be dropped and got a stopped engine.
 */
export const ONE_MUST_STAY =
  'That is the only folder on the list, and the pigeon needs one folder to watch. Add another one first.';

/** Flags the folders command accepts. */
export interface FoldersOptions {
  /**
   * add or remove, as it was typed.
   *
   * A string rather than the union, because the word is read inside the run: an
   * action nobody knows has to be answered on the same channel as everything
   * else, and a parse in the command layer would be thrown past it.
   */
  action: string;
  /** The folder, as the person or the page gave it. Validated here, never trusted. */
  path: string;
  /** Explicit config file. */
  config?: string;
  /** Write the answer as one JSON line instead of a sentence. */
  json?: boolean;
  /** Where the JSON line goes. Tests use it, the CLI writes to stdout. */
  emit?: (line: string) => void;
  /** File system, injectable for tests. */
  fs?: FsLike;
  /** The clock on the answer. Injectable so a test can assert on the envelope. */
  now?: () => number;
}

/** What came of one request, without the moment it happened. */
export type FoldersOutcomeBody =
  /** The file was rewritten. `watchDirs` is the list as it now stands on disk. */
  | {
      type: 'folders-changed';
      configPath: string;
      watchDirs: string[];
      added?: string;
      removed?: string;
    }
  /**
   * Nothing was written, and this is why.
   *
   * The M3 channel rule: a request that changes nothing is answered with the
   * state it found, because what is wrong in that case is the asker's picture.
   */
  | { type: 'folders-unchanged'; configPath: string; watchDirs: string[]; why: string }
  /** The request could not be carried out at all. */
  | { type: 'failed'; error: string };

/** One answer on the wire: what came of it, plus the moment it happened. */
export type FoldersOutcome = FoldersOutcomeBody & { at: string };

/** Reads the action a caller typed, or refuses it by name. */
export function parseFolderAction(value: string): FolderAction {
  const word = value.trim().toLowerCase();
  const known = FOLDER_ACTIONS.find((action) => action === word);
  if (known) return known;
  throw new CommandError(
    `${JSON.stringify(value)} is not something photo-pigeon does to the watched folder list.`,
    EXIT.FAILED,
    `The actions are: ${FOLDER_ACTIONS.join(', ')}.`,
  );
}

/**
 * Reads the config for editing.
 *
 * Deliberately not `readConfigFile`, which refuses a config with an empty
 * `watchDirs`. That refusal is right for a watch and wrong here: a machine whose
 * list is empty is exactly the machine that needs a folder added, and the status
 * window is where somebody would do it. Every other problem still refuses,
 * because a file this build cannot fully understand is not a file a machine
 * should rewrite.
 */
async function readForEditing(
  file: string,
  fs: FsLike,
): Promise<{ stored: AppConfig; config: AppConfig }> {
  let stored: AppConfig | undefined;
  try {
    stored = await readAppConfig(file, fs);
  } catch (error) {
    throw new CommandError(
      messageOf(error),
      EXIT.NOT_CONFIGURED,
      'Fix it in an editor, or run photo-pigeon setup to write a fresh one.',
    );
  }
  if (!stored) {
    throw new CommandError(
      `No photo-pigeon config at ${file}.`,
      EXIT.NOT_CONFIGURED,
      'Run photo-pigeon setup once and this file appears.',
    );
  }
  const { config, problems } = inspectAppConfig(stored, { dir: path.dirname(file) });
  if (problems.length > 0) {
    throw new CommandError(
      `The config at ${file} could not be used:\n  - ${problems.join('\n  - ')}`,
      EXIT.NOT_CONFIGURED,
      'Fix it in an editor, or run photo-pigeon setup to write a fresh one.',
    );
  }
  return { stored, config };
}

/** What the request came to, before anything is written. */
type Verdict =
  | { changed: true; watchDirs: string[]; added?: string; removed?: string }
  | { changed: false; why: string };

async function decide(
  action: FolderAction,
  target: string,
  current: readonly string[],
  fs: FsLike,
): Promise<Verdict> {
  if (action === 'add') {
    const verdict = await checkWatchDir(target, current, fs);
    if (!verdict.ok) return { changed: false, why: verdict.why };
    return { changed: true, watchDirs: [...current, verdict.dir], added: verdict.dir };
  }

  // A removal deliberately does not ask the file system whether the folder is
  // there. A folder that has been deleted, renamed or unplugged is exactly the
  // one somebody wants off the list, and refusing to remove it because it is
  // missing would leave the list unfixable from the window.
  const cleaned = cleanTypedPath(target);
  if (!cleaned) return { changed: false, why: NEEDS_A_PATH };
  const resolved = path.resolve(cleaned);
  if (!isWatchedAlready(current, resolved)) {
    return { changed: false, why: `${resolved} is not one of the watched folders.` };
  }
  const kept = current.filter((dir) => !sameWatchDir(dir, resolved));
  if (kept.length === 0) return { changed: false, why: ONE_MUST_STAY };
  return { changed: true, watchDirs: kept, removed: resolved };
}

/**
 * Adds or removes one watched folder. Resolves with the exit code.
 *
 * `EXIT.PROBLEMS` for a request that changed nothing, which is what that code
 * has always meant here: the command ran fine and found something worth looking
 * at. `EXIT.OK` only when the file really moved.
 */
export async function runFolders(
  options: FoldersOptions,
  log: Logger = createLogger(),
): Promise<number> {
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? Date.now;
  const write = options.emit ?? ((line: string): void => void process.stdout.write(`${line}\n`));

  const answer = (body: FoldersOutcomeBody): void => {
    if (options.json !== true) return;
    write(JSON.stringify({ ...body, at: new Date(now()).toISOString() }));
  };

  const file = await resolveConfigPath(options.config);

  try {
    const action = parseFolderAction(options.action);
    const { stored, config } = await readForEditing(file, fs);
    const verdict = await decide(action, options.path, config.watchDirs, fs);

    if (!verdict.changed) {
      answer({
        type: 'folders-unchanged',
        configPath: file,
        watchDirs: config.watchDirs,
        why: verdict.why,
      });
      log.warn(verdict.why);
      return EXIT.PROBLEMS;
    }

    // Everything except `watchDirs` is copied across exactly as it was found,
    // including keys this build does not know about. The paths to the token, the
    // ledger and the credentials are in this file and none of them is this
    // command's business: it was asked about one array.
    await writeAppConfig(file, { ...stored, watchDirs: verdict.watchDirs }, fs);

    answer({
      type: 'folders-changed',
      configPath: file,
      watchDirs: verdict.watchDirs,
      ...(verdict.added ? { added: verdict.added } : {}),
      ...(verdict.removed ? { removed: verdict.removed } : {}),
    });
    log.ok(
      verdict.added
        ? `watching ${verdict.added} as well, and ${plural(verdict.watchDirs.length, 'folder')} in total`
        : `no longer watching ${verdict.removed}, and ${plural(verdict.watchDirs.length, 'folder')} left`,
    );
    // Said every time, because this is the one thing a person editing the list
    // from a window cannot see: the engine is still running on the list it
    // loaded when it started.
    log.muted('a watch that is already running keeps its old list until it restarts');
    return EXIT.OK;
  } catch (error) {
    answer({ type: 'failed', error: messageOf(error) });
    throw error;
  }
}
