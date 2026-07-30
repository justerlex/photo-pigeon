/**
 * status: what this tool has delivered, and what it is set up to do.
 *
 * The bytes readout is not a vanity metric. API uploads are original quality
 * and come out of the user's own Google storage, so the tool that spent it says
 * how much it spent.
 */

import pc from 'picocolors';

import type { AppConfig } from '../contracts.js';
import { pathExists, resolveConfigPath } from './config.js';
import { EXIT } from './errors.js';
import { formatBytes, formatCount, plural } from './format.js';
import { createLogger, type Logger } from './log.js';
import { defaultRuntime, type Runtime } from './runtime.js';

/** Flags the status command accepts. */
export interface StatusOptions {
  /** Explicit config file. */
  config?: string;
  /** Version string for the heading. */
  version?: string;
}

const LABEL_WIDTH = 13;

function label(text: string): string {
  return pc.dim(`${text}:`.padEnd(LABEL_WIDTH));
}

/** Wraps a long space separated list so nothing is ever cut off. */
export function wrapList(values: readonly string[], width = 66): string[] {
  const lines: string[] = [];
  let current = '';
  for (const value of values) {
    if (current === '') {
      current = value;
    } else if (current.length + 1 + value.length > width) {
      lines.push(current);
      current = value;
    } else {
      current = `${current} ${value}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : ['none'];
}

async function markPath(candidate: string): Promise<string> {
  return (await pathExists(candidate)) ? candidate : `${candidate} ${pc.yellow('(missing)')}`;
}

async function printConfig(config: AppConfig, configPath: string, log: Logger): Promise<void> {
  log.plain(`${label('config')}${configPath}`);
  const [first, ...rest] = config.watchDirs;
  log.plain(`${label('watching')}${first ?? 'nothing'}`);
  for (const dir of rest) log.plain(`${' '.repeat(LABEL_WIDTH)}${dir}`);
  log.plain(`${label('album')}${config.albumName ?? 'none, uploads land in your library'}`);

  const [firstTypes, ...moreTypes] = wrapList([...config.extensions]);
  log.plain(`${label('file types')}${firstTypes ?? 'none'}`);
  for (const line of moreTypes) log.plain(`${' '.repeat(LABEL_WIDTH)}${line}`);

  log.plain(`${label('credentials')}${await markPath(config.credentialsPath)}`);
  log.plain(`${label('token')}${await markPath(config.tokenPath)}`);
  log.plain(`${label('ledger')}${await markPath(config.ledgerPath)}`);
}

/** Prints the status report. Resolves with the exit code. */
export async function runStatus(
  options: StatusOptions = {},
  runtime: Runtime = defaultRuntime,
  log: Logger = createLogger(),
): Promise<number> {
  const config = await runtime.loadConfig(options.config);
  const ledger = await runtime.openLedger(config.ledgerPath);
  const stats = ledger.stats();

  const version = options.version ? ` ${options.version}` : '';
  log.plain();
  log.plain(pc.bold(`photo-pigeon${version}`));
  log.plain();

  if (stats.count === 0) {
    log.plain('Nothing delivered yet.');
  } else {
    log.plain(
      `Delivered ${plural(stats.count, 'file')} · ${formatBytes(stats.totalBytes)} sent to Google Photos.`,
    );
    log.plain(
      pc.dim(
        `That is ${formatBytes(stats.totalBytes)} of your Google storage: API uploads are always original quality.`,
      ),
    );
  }

  const usage = await runtime.usage(config);
  if (usage) {
    log.plain();
    log.plain(
      pc.dim(
        `Today (${usage.day}): ${plural(usage.requests, 'request')} of ${formatCount(usage.ceiling)}, ${formatBytes(usage.bytesToday)} sent.`,
      ),
    );
    // Two counters, kept by two different things, and they answer different
    // questions. The bytes
    // above come from the ledger, which is the durable record of what was
    // delivered. A request is one batchCreate call, counted by the transport,
    // because batchCreate is the only call Google meters against the daily
    // limit: the uploads themselves do not count towards it.
    log.plain(
      pc.dim('A request is one batchCreate call. Sending the bytes does not count towards that limit.'),
    );
  }
  log.plain();

  await printConfig(config, await resolveConfigPath(options.config), log);
  log.plain();

  return EXIT.OK;
}
