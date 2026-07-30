/**
 * The one module that reads and writes ~/.photo-pigeon/config.json.
 *
 * There were three opinions about the config in this repo. This is the only one
 * now: the wizard writes through it, the commands read through it, and the
 * extension list it falls back to comes from gphotos/mime.ts, which is the
 * single source of truth for what this tool knows how to send. Nothing here
 * reads a credential: it deals in paths, never in secrets.
 *
 * The file on disk is exactly the AppConfig shape from contracts.ts, pretty
 * printed, so anyone can open it in an editor and change a folder without
 * running the wizard again. Hand edits are expected, which is why reading is
 * forgiving about form and strict about meaning: a leading ~ is expanded, 'JPG'
 * and '.jpg' are the same file type, unknown keys are ignored so an older build
 * never chokes on a newer file, and every problem is collected and reported
 * together rather than one per run.
 */

import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../contracts.js';
import { ALL_SUPPORTED_EXTENSIONS } from '../gphotos/mime.js';
import { writeFileAtomic, writeFileAtomicVia } from './atomic.js';
import { type FsLike, nodeFs } from './fs-like.js';
import { pathsIn, resolvePaths } from './paths.js';
import { watchDirKey } from './watch-dirs.js';

/**
 * Extensions the watcher accepts out of the box.
 *
 * Not a list: an alias for the one in gphotos/mime.ts, which is where every
 * extension this tool recognises is written down. Kept under this name because
 * that is what the wizard's public surface has always called it. Editable in
 * config.json afterwards, which is the point of having a default at all.
 */
export const DEFAULT_EXTENSIONS: readonly string[] = ALL_SUPPORTED_EXTENSIONS;

/**
 * What the wizard remembers about the setup itself. Not part of AppConfig
 * because it is bookkeeping, not behaviour, but doctor needs it: content
 * uploaded under one client id is invisible to any other, so a changed client
 * id means the ledger's history is orphaned and the user has to be told.
 */
export interface SetupRecord {
  /** The OAuth client id this setup was built on. */
  clientId: string;
  /** Cloud project id from the client JSON, when it carried one. */
  projectId?: string;
  /** ISO 8601 timestamp of when the wizard finished. */
  setupAt: string;
  /** ISO 8601 timestamp of when the user confirmed clicking Publish app. */
  publishConfirmedAt?: string;
}

// ---------------------------------------------------------------------------
// Normalizing
// ---------------------------------------------------------------------------

/** Turns a leading ~ into the home directory, so a hand edited config still works. */
export function expandHome(input: string, home: string = os.homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(home, input.slice(2));
  return input;
}

/** Lowercase with a leading dot: 'JPG' and '.jpg' mean the same file type. Empty when it means nothing. */
export function normalizeExtension(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '' || trimmed === '.') return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/**
 * Windows paths are case insensitive, so two spellings of one folder are one
 * folder.
 *
 * The key comes from `./watch-dirs.ts`, which is also where the two front ends
 * that take a folder from a person ask whether it is already on the list. This
 * used to be its own comparison and the validator used `includes`, so the writer
 * and the validator disagreed and the loser was the user's second answer.
 */
function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of paths) {
    const key = watchDirKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a config that leaves things out gets its answers from. */
export interface InspectOptions {
  /** The folder the config file sits in. Unnamed paths fall back to siblings of it. Defaults to ~/.photo-pigeon. */
  dir?: string;
  /** Home directory used to expand a leading ~. Defaults to the real one. */
  home?: string;
}

/** What came of reading a config: the best version of it, and everything wrong with it. */
export interface ConfigInspection {
  /** Usable even when problems is not empty: every bad field fell back to its default. */
  config: AppConfig;
  /** One sentence per problem, all of them, so a hand edit gets fixed in one pass. */
  problems: string[];
}

/**
 * Turns whatever was on disk into an AppConfig and says what was wrong with it.
 *
 * Never throws and never stops at the first mistake. Callers decide what a
 * problem means: the wizard writes what it built, the commands refuse to run
 * and print the list.
 */
export function inspectAppConfig(raw: unknown, options: InspectOptions = {}): ConfigInspection {
  const home = options.home ?? os.homedir();
  const dir = options.dir ?? resolvePaths(home).configDir;
  const siblings = pathsIn(dir);
  const problems: string[] = [];

  const fallback: AppConfig = {
    watchDirs: [],
    credentialsPath: siblings.credentialsPath,
    tokenPath: siblings.tokenPath,
    ledgerPath: siblings.ledgerPath,
    extensions: [...DEFAULT_EXTENSIONS],
  };

  if (!isPlainObject(raw)) {
    problems.push('the file must contain a JSON object with a watchDirs array');
    return { config: fallback, problems };
  }

  const absolute = (value: string): string => path.resolve(expandHome(value.trim(), home));

  const readPath = (value: unknown, key: string, fallbackPath: string): string => {
    if (value === undefined || value === null) return fallbackPath;
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key} must be a path, written as a string`);
      return fallbackPath;
    }
    return absolute(value);
  };

  const watchDirs: string[] = [];
  if (raw['watchDirs'] !== undefined && raw['watchDirs'] !== null) {
    const rawDirs = raw['watchDirs'];
    if (!Array.isArray(rawDirs)) {
      problems.push('watchDirs must be an array of folder paths');
    } else {
      rawDirs.forEach((entry: unknown, i: number) => {
        if (typeof entry !== 'string' || entry.trim() === '') {
          problems.push(`watchDirs[${i}] must be a folder path, written as a string`);
          return;
        }
        watchDirs.push(absolute(entry));
      });
    }
  }

  let extensions = [...fallback.extensions];
  if (raw['extensions'] !== undefined && raw['extensions'] !== null) {
    const rawExtensions = raw['extensions'];
    if (!Array.isArray(rawExtensions)) {
      problems.push("extensions must be an array like ['.jpg', '.mp4']");
    } else {
      const normalized: string[] = [];
      let rejected = 0;
      rawExtensions.forEach((entry: unknown, i: number) => {
        if (typeof entry !== 'string') {
          problems.push(`extensions[${i}] must be a string like '.jpg'`);
          rejected++;
          return;
        }
        const ext = normalizeExtension(entry);
        if (ext === '') {
          problems.push(`extensions[${i}] is empty, it should look like '.jpg'`);
          rejected++;
          return;
        }
        if (!normalized.includes(ext)) normalized.push(ext);
      });
      if (normalized.length === 0 && rejected === 0) {
        problems.push('extensions is empty, so nothing would ever be sent');
      }
      if (normalized.length > 0) extensions = normalized;
    }
  }

  let albumName: string | undefined;
  if (raw['albumName'] !== undefined && raw['albumName'] !== null) {
    if (typeof raw['albumName'] !== 'string') {
      problems.push('albumName must be a string');
    } else if (raw['albumName'].trim() !== '') {
      albumName = raw['albumName'].trim();
    }
  }

  const readFlag = (value: unknown, key: string): boolean | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
      problems.push(`${key} must be true or false`);
      return undefined;
    }
    return value;
  };

  const dryRun = readFlag(raw['dryRun'], 'dryRun');
  const pollFallback = readFlag(raw['pollFallback'], 'pollFallback');

  const config: AppConfig = {
    watchDirs: dedupePaths(watchDirs),
    credentialsPath: readPath(raw['credentialsPath'], 'credentialsPath', fallback.credentialsPath),
    tokenPath: readPath(raw['tokenPath'], 'tokenPath', fallback.tokenPath),
    ledgerPath: readPath(raw['ledgerPath'], 'ledgerPath', fallback.ledgerPath),
    extensions,
  };
  if (albumName !== undefined) config.albumName = albumName;
  if (dryRun) config.dryRun = true;
  if (pollFallback) config.pollFallback = true;

  return { config, problems };
}

/**
 * Fills in everything the wizard did not ask about, so the written config is
 * always complete.
 *
 * The write side of inspectAppConfig. The wizard's own input is already typed,
 * so there is nothing here to refuse: blank folders are dropped, duplicates
 * collapse, and what comes back is what goes on disk.
 */
export function normalizeAppConfig(
  partial: Partial<AppConfig> & Pick<AppConfig, 'watchDirs' | 'credentialsPath' | 'tokenPath' | 'ledgerPath'>,
): AppConfig {
  return inspectAppConfig(partial, { dir: path.dirname(path.resolve(partial.credentialsPath)) }).config;
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Writes JSON through a temp file so a crash cannot leave half a config behind.
 *
 * The real file system gets the flushed write from atomic.ts. An injected seam
 * gets the same temp-then-rename dance without the flush, which is all a fake
 * can promise anyway.
 */
async function writeJsonAtomic(file: string, value: unknown, fs: FsLike): Promise<void> {
  if (fs === nodeFs) {
    await writeFileAtomic(file, serialize(value));
    return;
  }
  await writeFileAtomicVia(fs, file, serialize(value));
}

async function readJson<T>(file: string, fs: FsLike): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it in an editor, or delete it and run the wizard again.`);
  }
}

/** Writes the config to disk, creating ~/.photo-pigeon on the way. */
export async function writeAppConfig(
  configPath: string,
  config: AppConfig,
  fs: FsLike = nodeFs,
): Promise<void> {
  await writeJsonAtomic(configPath, config, fs);
}

/**
 * Reads the config, or undefined when there is none yet. Throws when the file
 * exists but is broken.
 *
 * What comes back is whatever the file said, unchecked: run it through
 * inspectAppConfig before trusting a field.
 */
export async function readAppConfig(
  configPath: string,
  fs: FsLike = nodeFs,
): Promise<AppConfig | undefined> {
  return readJson<AppConfig>(configPath, fs);
}

/** Writes the setup record. */
export async function writeSetupRecord(
  setupPath: string,
  record: SetupRecord,
  fs: FsLike = nodeFs,
): Promise<void> {
  await writeJsonAtomic(setupPath, record, fs);
}

/** Reads the setup record, or undefined when there is none. */
export async function readSetupRecord(
  setupPath: string,
  fs: FsLike = nodeFs,
): Promise<SetupRecord | undefined> {
  return readJson<SetupRecord>(setupPath, fs);
}
