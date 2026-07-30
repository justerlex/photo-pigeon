/**
 * The seam between the commands and the rest of the app.
 *
 * Commands never import the gphotos, state, watcher or wizard modules directly.
 * They go through a Runtime, which means two things: the tests can hand the
 * commands fakes with no filesystem and no network, and a module that is still
 * a stub fails at the moment it is actually needed rather than at import time.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type { AppConfig, FileCandidate, GPhotosClient, Ledger } from '../contracts.js';
import type { Logger as SpeakingLogger } from '../gphotos/log.js';
import type { DoctorReport } from '../wizard/doctor.js';
import type { PigeonPaths } from '../wizard/paths.js';
import type { WizardOptions } from '../wizard/index.js';
import type { LockOptions, LockResult } from '../state/lock.js';
import type { SideIndex } from '../state/sideindex.js';
import { readConfigFile } from './config.js';

/**
 * What a command tells the Google Photos client about the run it is part of.
 *
 * Both members exist because a machine channel is not a terminal. Under
 * `--events` stdout carries the event stream and nothing else, and the cancel
 * is stdin closing rather than Ctrl-C, and the gphotos module knew about
 * neither: it wrote `info` to `console.log` and it waited out a consent screen
 * nobody was going to answer.
 */
export interface SpeakingOptions {
  /** Where the module's prose goes. Under a machine channel, stderr. */
  logger?: SpeakingLogger;
  /** Abandons a consent wait when the run is cancelled. */
  signal?: AbortSignal;
}

export type { Lock, LockRecord, LockResult } from '../state/lock.js';
export type { SideIndex } from '../state/sideindex.js';

/** What startWatching hands back when it has a way to be stopped. Optional by design. */
export interface WatchHandle {
  close(): Promise<void> | void;
}

/** A rendered health check: the wizard decides what is wrong, the command prints it. */
export interface DoctorResult {
  /** False when at least one check failed. */
  ok: boolean;
  /** The report, already formatted for a terminal. */
  text: string;
}

/** What the watcher and the startup scan came to. */
export interface StartResult {
  /** The running watcher, when it gave us a way to stop it. */
  handle: WatchHandle | undefined;
  /** Everything the startup scan found on disk. Already offered to the caller. */
  reconciled: FileCandidate[];
}

/** The transport's durable request and byte counters, when they can be read. */
export interface UsageSummary {
  day: string;
  requests: number;
  remaining: number;
  ceiling: number;
  bytesUploaded: number;
  bytesToday: number;
}

/** Everything a command needs from the outside world. */
export interface Runtime {
  /** Reads the config the user set up, honoring an explicit path. */
  loadConfig(explicitPath?: string): Promise<AppConfig>;
  /** Opens the sha256 ledger, the durable record. */
  openLedger(ledgerPath: string): Promise<Ledger>;
  /**
   * Builds the Google Photos client for this config. Async only so the import
   * stays lazy.
   *
   * The logger is the machine channel's, and leaving it out is how stdout got
   * polluted. The gphotos module says things out loud, and its default sink
   * writes `info` to `console.log`. Under `--events` stdout belongs to the
   * event stream and nothing else, so a command running a machine channel
   * hands its stderr speaker in here. The worst of what leaked without it was
   * the consent URL itself, which the OAuth law says a window must never be
   * able to read.
   */
  createClient(config: AppConfig, speaking?: SpeakingOptions): Promise<GPhotosClient>;
  /** Arms the watcher, then walks the folders once. Every candidate reaches onCandidate. */
  start(
    config: AppConfig,
    onCandidate: (candidate: FileCandidate) => void,
  ): Promise<StartResult>;
  /**
   * One reconciliation walk, on demand, with no watcher attached.
   *
   * This is what "Deliver now" is made of, and the distinction from `start` is
   * the whole point: a rescan must not arm a second watcher, and it must not
   * cost a restart. Every file found is handed to onCandidate and also
   * returned, so the caller can say how many there were.
   *
   * Optional so that a fake runtime in a test, or a build where the watcher
   * module is a stub, refuses the request with a sentence instead of failing
   * to construct. Law 2 still stands: this runs when a person asks for it and
   * never on a timer.
   */
  reconcile?(
    config: AppConfig,
    onCandidate: (candidate: FileCandidate) => void,
  ): Promise<FileCandidate[]>;
  /** The transport's own counters, or undefined when they cannot be read. */
  usage(config: AppConfig): Promise<UsageSummary | undefined>;
  /**
   * Runs the first run wizard and returns the config it wrote.
   *
   * The options are how the tray's window runs the same wizard: an `io` and an
   * `ask` that speak NDJSON instead of a terminal, and a `configDir` so a test
   * or the E2E rig can run a whole setup somewhere the real install is not.
   */
  runWizard(options?: WizardOptions): Promise<AppConfig>;
  /** Runs the wizard's own health check and hands back its verdict and its report. */
  runDoctor(configDir?: string): Promise<DoctorResult>;
  /**
   * The same health check, unflattened.
   *
   * `runDoctor` above collapses the report into a terminal string, which is
   * right for `photo-pigeon doctor` and useless to the health window: a page
   * wants the levels and the checks, not a rendered block. The structure has
   * existed in `wizard/doctor.ts` since the beginning and only the command
   * layer ever flattened it, so this is a passthrough past the flattening and
   * not new core design.
   */
  runDoctorReport(configDir?: string): Promise<DoctorReport>;
  /** Every file photo-pigeon owns, for a given config folder or for the home one. */
  pigeonPaths(configDir?: string): Promise<PigeonPaths>;
  /** sha256 of a file's contents, lowercase hex. */
  hashFile(filePath: string): Promise<string>;
  /**
   * Takes the single instance lock that guards this ledger's folder.
   *
   * Comes back with a result rather than throwing when somebody else holds it:
   * "already running" is an answer the command has a sentence for, not a crash.
   */
  acquireLock(ledgerPath: string, options?: LockOptions): Promise<LockResult>;
  /**
   * Opens the path, size and mtime cache that lets an unchanged file skip its
   * sha256 read.
   *
   * This is what makes start-at-login survivable: without it, every logon reads
   * the whole library again to be told nothing changed. Null means the cache is
   * unavailable, which costs speed and nothing else, so it is never a reason to
   * refuse to run.
   */
  openSideIndex(ledgerPath: string): Promise<SideIndex | null>;
}

/**
 * sha256 of a file, streamed so a 20 GB video never lands in memory.
 *
 * This is the fallback. If the state module exports its own hashFile, that one
 * wins, because the ledger and the hash have to agree forever.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Hashing is not in contracts.ts, so the state module may or may not export it.
 * If it does, that one wins: the ledger and the hash have to agree forever, and
 * the module that owns the ledger owns that decision.
 */
interface StateModuleExtras {
  hashFile?: (filePath: string) => Promise<string>;
}

let stateExtras: StateModuleExtras | undefined;

async function loadStateExtras(): Promise<StateModuleExtras> {
  if (!stateExtras) {
    stateExtras = (await import('../state/index.js')) as unknown as StateModuleExtras;
  }
  return stateExtras;
}

/** The real runtime: lazy imports, so a command only touches the modules it needs. */
export const defaultRuntime: Runtime = {
  async loadConfig(explicitPath?: string): Promise<AppConfig> {
    return readConfigFile(explicitPath);
  },

  async openLedger(ledgerPath: string): Promise<Ledger> {
    const { openLedger } = await import('../state/index.js');
    return openLedger(ledgerPath);
  },

  async createClient(config: AppConfig, speaking: SpeakingOptions = {}): Promise<GPhotosClient> {
    const { createGPhotosClient } = await import('../gphotos/index.js');
    return createGPhotosClient(config, {
      ...(speaking.logger ? { logger: speaking.logger } : {}),
      ...(speaking.signal ? { auth: { signal: speaking.signal } } : {}),
    });
  },

  async start(
    config: AppConfig,
    onCandidate: (candidate: FileCandidate) => void,
  ): Promise<StartResult> {
    // Watcher first, walk second, which is the watcher module's own rule: the
    // other order leaves a window where a file that lands mid walk is seen by
    // neither. Anything seen twice is dropped by the hash, not uploaded twice.
    const { startWithReconcile } = await import('../watcher/index.js');
    const { watcher, reconciled } = await startWithReconcile(config, onCandidate);
    return { handle: watcher, reconciled };
  },

  async reconcile(
    config: AppConfig,
    onCandidate: (candidate: FileCandidate) => void,
  ): Promise<FileCandidate[]> {
    // The same walk startWithReconcile runs, without the watcher: the watcher
    // this run already has is still live and still catching new files, and a
    // second one would deliver every event twice.
    const { reconcile } = await import('../watcher/index.js');
    const found = await reconcile(config);
    for (const candidate of found) onCandidate(candidate);
    return found;
  },

  async usage(config: AppConfig): Promise<UsageSummary | undefined> {
    try {
      const { createGPhotosClient } = await import('../gphotos/index.js');
      return await createGPhotosClient(config).usage();
    } catch {
      // The counters are a nicety on the status screen. Never a reason to fail.
      return undefined;
    }
  },

  async runWizard(options: WizardOptions = {}): Promise<AppConfig> {
    const { runWizard } = await import('../wizard/index.js');
    return runWizard(options);
  },

  async runDoctor(configDir?: string): Promise<DoctorResult> {
    const { runDoctor, formatDoctorReport } = await import('../wizard/index.js');
    const report = await runDoctor(configDir ? { configDir } : {});
    return { ok: report.ok, text: formatDoctorReport(report) };
  },

  async runDoctorReport(configDir?: string): Promise<DoctorReport> {
    const { runDoctor } = await import('../wizard/index.js');
    return runDoctor(configDir ? { configDir } : {});
  },

  async pigeonPaths(configDir?: string): Promise<PigeonPaths> {
    const { pathsIn, resolvePaths } = await import('../wizard/paths.js');
    return configDir ? pathsIn(configDir) : resolvePaths();
  },

  async hashFile(filePath: string): Promise<string> {
    const state = await loadStateExtras();
    if (typeof state.hashFile === 'function') return state.hashFile(filePath);
    return sha256File(filePath);
  },

  async acquireLock(ledgerPath: string, options: LockOptions = {}): Promise<LockResult> {
    // Imported straight from the module rather than through state/index.js, so
    // this seam does not depend on a barrel file another hand owns. The exit
    // hook is asked for here and nowhere else: a real run should tidy up after
    // itself, and a test handing in a fake runtime should not be quietly adding
    // process listeners.
    const { acquireLock } = await import('../state/lock.js');
    return acquireLock(ledgerPath, { releaseOnExit: true, ...options });
  },

  async openSideIndex(ledgerPath: string): Promise<SideIndex | null> {
    try {
      const { openSideIndex, sideIndexPathFor } = await import('../state/sideindex.js');
      return await openSideIndex(sideIndexPathFor(ledgerPath));
    } catch {
      // A cache that will not open is a slow run, not a failed one. The ledger
      // is the record; this only decides whether a file has to be read again.
      return null;
    }
  },
};
