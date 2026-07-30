/**
 * Where the config lives and how a command reads it.
 *
 * The wizard is the writer and therefore the authority: it owns resolvePaths,
 * readAppConfig, inspectAppConfig and the default extension list, and this file
 * borrows all four rather than keeping a second opinion about any of them. What
 * it adds is the refusal: a command that cannot run says so in a sentence and
 * says what to do next. Nothing here ever reads a credential: it deals in
 * paths, never in secrets.
 *
 * Both wizard modules imported here are pure. paths.ts touches nothing but
 * node:path, and config.ts touches the file system only when it is asked to, so
 * neither drags the prompts library into a plain `photo-pigeon status`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AppConfig } from '../contracts.js';
import { inspectAppConfig, readAppConfig } from '../wizard/config.js';
import { resolvePaths } from '../wizard/paths.js';
import { CommandError, EXIT, messageOf } from './errors.js';

/** The config file the wizard writes, asked of the wizard itself. */
export async function defaultConfigPath(): Promise<string> {
  return resolvePaths().configPath;
}

/** The config file this invocation should read, honoring an explicit --config. */
export async function resolveConfigPath(explicitPath?: string): Promise<string> {
  if (explicitPath && explicitPath.trim() !== '') return path.resolve(explicitPath);
  return defaultConfigPath();
}

/**
 * Turns whatever was on disk into an AppConfig, or explains what is wrong.
 *
 * Forgiving about the paths, which fall back to siblings of the config file,
 * and strict about watchDirs, because a watcher with nothing to watch is a bug
 * the user should hear about rather than a silent no-op. Every other problem
 * comes back at once, so a hand edited file gets fixed in one pass instead of
 * one problem per run.
 */
export function validateConfig(value: unknown, source: string): AppConfig {
  const file = path.resolve(source);
  const { config, problems } = inspectAppConfig(value, { dir: path.dirname(file) });

  if (problems.length > 0) {
    throw new CommandError(
      `The config at ${source} could not be used:\n  - ${problems.join('\n  - ')}`,
      EXIT.NOT_CONFIGURED,
      'Fix it in an editor, or run photo-pigeon setup to write a fresh one.',
    );
  }

  if (config.watchDirs.length === 0) {
    throw new CommandError(
      `The config at ${source} has no watchDirs, so there is nothing to watch.`,
      EXIT.NOT_CONFIGURED,
      'Run photo-pigeon setup, or add a watchDirs array of folder paths.',
    );
  }

  return config;
}

/** Reads and validates the config, or throws a CommandError that says what to do next. */
export async function readConfigFile(explicitPath?: string): Promise<AppConfig> {
  const file = await resolveConfigPath(explicitPath);

  let stored: AppConfig | undefined;
  try {
    stored = await readAppConfig(file);
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
  return validateConfig(stored, file);
}

/** True when the path exists and can be read. Used for the status readout only. */
export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
