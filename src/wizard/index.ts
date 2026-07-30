/**
 * First run setup: deep links the Google Cloud console down to two manual
 * moments, takes in the client JSON the browser downloads, and writes the
 * config.
 *
 * The wizard never runs OAuth itself. It hands back an AppConfig and the setup
 * command chains sign-in after it.
 */

import type { AppConfig } from '../contracts.js';
import { type Ask, terminalAsk } from './ask.js';
import { normalizeAppConfig, readAppConfig, writeAppConfig, writeSetupRecord } from './config.js';
import { type FsLike, nodeFs } from './fs-like.js';
import { downloadsCandidates, pathsIn, resolvePaths } from './paths.js';
import {
  askWatchChoices,
  intakeCredentials,
  requireInteractive,
  showIntro,
  showOutro,
  stepConsentScreen,
  stepCreateClient,
  stepCreateProject,
  stepEnableApi,
  stepPublish,
  type StepContext,
} from './steps.js';
import { consoleIo, note, say, type WizardIo } from './ui.js';

/** Knobs, all optional. Defaults are the real console, the real home directory and a real browser. */
export interface WizardOptions {
  /** Where output goes. Defaults to the console. */
  io?: WizardIo;
  /** Home directory to write ~/.photo-pigeon under. Defaults to the user's. */
  homeDir?: string;
  /** Folders to watch for the downloaded client JSON. Defaults to the platform's Downloads folders. */
  downloadsDirs?: string[];
  /** False to only print links instead of launching a browser. */
  openLinks?: boolean;
  /** File system, injectable for tests. */
  fs?: FsLike;
  /** Prefilled answer for the folder question. */
  defaultWatchDir?: string;
  /**
   * How questions get asked. Defaults to the terminal prompts.
   *
   * The tray's first-run window hands in the NDJSON channel instead, which is
   * the whole of what makes one state machine serve both front ends.
   */
  ask?: Ask;
  /**
   * The folder photo-pigeon writes into, when it is not the one under home.
   *
   * This is what `setup -c <path>` resolves to: the directory holding the
   * named config file, which is the same fallback a hand edited config already
   * gets. It exists so a test and the E2E rig can run a whole setup without
   * being able to reach the real `~/.photo-pigeon` at all.
   */
  configDir?: string;
}

/**
 * Walks the user through creating their own OAuth client and writes the config.
 *
 * Resolves with the config that was written, or with the existing one when the
 * user is re-running setup and decides to keep what they have.
 */
export async function runWizard(options: WizardOptions = {}): Promise<AppConfig> {
  const io = options.io ?? consoleIo;
  const fs = options.fs ?? nodeFs;
  const paths = options.configDir ? pathsIn(options.configDir) : resolvePaths(options.homeDir);
  const downloadsDirs = options.downloadsDirs ?? downloadsCandidates();
  const ask = options.ask ?? terminalAsk;
  const ctx: StepContext = { io, fs, ask, openLinks: options.openLinks ?? true };

  requireInteractive(ask);

  const existing = await readAppConfig(paths.configPath, fs);
  if (existing) {
    say(io);
    note(io, `There is already a setup at ${paths.configPath}`);
    const startOver = await ask.confirm({
      message: 'Run through setup again and replace it?',
      default: false,
    });
    if (!startOver) {
      say(io, '  Left alone. Nothing was changed.');
      return existing;
    }
  }

  showIntro(ctx);

  const projectId = await stepCreateProject(ctx);
  await stepEnableApi(ctx, projectId);
  await stepConsentScreen(ctx, projectId);
  const publishConfirmedAt = await stepPublish(ctx, projectId);
  await stepCreateClient(ctx, projectId);

  const intake = await intakeCredentials(ctx, {
    downloadsDirs,
    destPath: paths.credentialsPath,
  });

  const choices = await askWatchChoices(ctx, options.defaultWatchDir);

  const config = normalizeAppConfig({
    watchDirs: choices.watchDirs,
    credentialsPath: paths.credentialsPath,
    tokenPath: paths.tokenPath,
    ledgerPath: paths.ledgerPath,
    albumName: choices.albumName,
  });

  await writeAppConfig(paths.configPath, config, fs);
  await writeSetupRecord(
    paths.setupPath,
    {
      clientId: intake.parsed.clientId,
      projectId: intake.parsed.projectId ?? projectId,
      setupAt: new Date().toISOString(),
      publishConfirmedAt,
    },
    fs,
  );

  // intake.sourcePath is where the client JSON was picked up from, and the outro
  // suggests deleting that original. It is a password and we have our own copy.
  showOutro(
    ctx,
    paths.configPath,
    config.watchDirs,
    intake.parsed.projectId ?? projectId,
    intake.sourcePath,
  );
  return config;
}

export { runDoctor, formatDoctorReport, printDoctorReport } from './doctor.js';
export type { DoctorCheck, DoctorLevel, DoctorOptions, DoctorReport } from './doctor.js';
export { CONSOLE_LINKS, consoleLink, withProject } from './links.js';
export { resolvePaths, pathsIn, downloadsCandidates, type PigeonPaths } from './paths.js';
export { terminalAsk, NO_TERMINAL_MESSAGE, type Ask } from './ask.js';
export { DEFAULT_EXTENSIONS, readAppConfig, readSetupRecord, type SetupRecord } from './config.js';
