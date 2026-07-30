/**
 * doctor: reads the setup on this machine and says what is wrong with it, or
 * what is about to be.
 *
 * Three of Google's quieter rules end careers of small uploaders, and all three
 * are invisible until they bite:
 *   · an app left in Testing hands out sign-ins that expire after seven days
 *   · an OAuth client nobody uses for six months is deleted automatically
 *   · uploads are only ever visible to the client id that made them, so a
 *     regenerated client orphans everything already delivered
 *
 * doctor cannot check publishing status from here, Google exposes no API for
 * it, so that one is a reminder with the exact link and the exact symptom.
 */

import path from 'node:path';
import pc from 'picocolors';
import type { AppConfig } from '../contracts.js';
import { readAppConfig, readSetupRecord } from './config.js';
import { readClientCredentials } from './credentials.js';
import { dirExists, type FsLike, nodeFs } from './fs-like.js';
import { consoleLink } from './links.js';
import { pathsIn, resolvePaths } from './paths.js';
import { daysBetween, humanizeDuration } from './time.js';
import { consoleIo, type WizardIo } from './ui.js';

/** Google deletes OAuth clients that have gone unused for this many days. */
export const IDLE_DELETE_DAYS = 180;
/** Google emails a warning 30 days before deleting an idle client, so this is when to start worrying. */
export const IDLE_WARNING_DAYS = IDLE_DELETE_DAYS - 30;

/** How much a check wants you to care. */
export type DoctorLevel = 'ok' | 'note' | 'warn' | 'fail';

/** One thing doctor looked at. */
export interface DoctorCheck {
  /** Stable identifier, handy for tests and for anyone scripting around doctor. */
  id: string;
  /** How much this matters. */
  level: DoctorLevel;
  /** One line, what was checked. */
  title: string;
  /** The detail, written for a person. */
  detail: string;
  /** A console link that would fix or confirm it. */
  link?: string;
}

/** Everything doctor found. */
export interface DoctorReport {
  /** The checks, in the order they were run. */
  checks: DoctorCheck[];
  /** False when at least one check failed. */
  ok: boolean;
}

/** Knobs for doctor, all optional. */
export interface DoctorOptions {
  /** Home directory holding ~/.photo-pigeon. Defaults to the user's. */
  homeDir?: string;
  /**
   * The folder the whole setup lives in, when it is not the one under home.
   *
   * What `-c <path>` resolves to, and it wins over `homeDir` because it is the
   * more specific of the two. This is how the health window reports on the
   * config its own tray is running against rather than on whatever is in the
   * user's home folder, which on a development machine or a rig is somebody
   * else's install entirely.
   */
  configDir?: string;
  /** File system, injectable for tests. */
  fs?: FsLike;
  /** Current time in epoch milliseconds, injectable so age tests are not flaky. */
  now?: number;
}

/**
 * Turns the age of the token file into a verdict about the six month idle
 * deletion.
 *
 * This is an estimate and the wording says so. Google publishes no way to ask
 * when a client was last used, so all doctor has is the date on the token file
 * in this folder: the auth module rewrites it on every refresh, and a refresh
 * is the kind of use that keeps a client alive. It is a good proxy and it is
 * still a proxy. Anything that used the same client from another machine, or a
 * copy of the token elsewhere, is invisible from here, so every line below is
 * hedged to what photo-pigeon can actually see.
 */
export function classifyClientIdleness(days: number): { level: DoctorLevel; detail: string } {
  const proxy = `That is worked out from the date on the token file on this machine, which is as far as photo-pigeon can tell: Google offers no way to ask when a client was last used.`;
  if (days >= IDLE_DELETE_DAYS) {
    return {
      level: 'fail',
      detail: `As far as photo-pigeon can tell, nothing has used these credentials for ${days} days. ${proxy} Google deletes OAuth clients after ${IDLE_DELETE_DAYS} days of no use, so this client may already be gone. A deleted client can be restored from the console for 30 days after it goes.`,
    };
  }
  if (days >= IDLE_WARNING_DAYS) {
    return {
      level: 'warn',
      detail: `As far as photo-pigeon can tell, nothing has used these credentials for ${days} days. ${proxy} Google deletes OAuth clients that sit unused for ${IDLE_DELETE_DAYS} days, and it emails a warning 30 days before. Running an upload now resets that clock.`,
    };
  }
  return {
    level: 'ok',
    detail: `Used ${days} days ago as far as photo-pigeon can tell, comfortably inside the ${IDLE_DELETE_DAYS} day idle window. ${proxy}`,
  };
}

/** Compares the client id in use against the one the setup was built on. */
export function describeClientLock(recordedClientId: string, currentClientId: string): DoctorCheck {
  if (recordedClientId === currentClientId) {
    return {
      id: 'client-lock',
      level: 'ok',
      title: 'Same OAuth client as at setup',
      detail:
        'Google Photos only shows uploads back to the client id that made them, and this is still that client, so the ledger matches what is actually up there.',
    };
  }
  return {
    id: 'client-lock',
    level: 'warn',
    title: 'The OAuth client changed since setup',
    detail:
      'Google Photos only ever shows uploads back to the exact client id that made them. Everything delivered under the old client is now invisible to this tool, and the local ledger still lists it as delivered. Uploads from here work normally, but the history is orphaned: if you want that older material under the new client too, it has to be uploaded again, and it will land as a second copy.',
  };
}

function check(
  id: string,
  level: DoctorLevel,
  title: string,
  detail: string,
  link?: string,
): DoctorCheck {
  return link ? { id, level, title, detail, link } : { id, level, title, detail };
}

/** Runs every check and reports. Never writes anything, never touches Google. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? Date.now();
  const paths = options.configDir ? pathsIn(options.configDir) : resolvePaths(options.homeDir);
  const checks: DoctorCheck[] = [];

  // --- config -------------------------------------------------------------
  let config: AppConfig | undefined;
  try {
    config = await readAppConfig(paths.configPath, fs);
  } catch (error) {
    checks.push(
      check('config', 'fail', 'Config is unreadable', (error as Error).message),
    );
  }

  if (!config) {
    if (checks.length === 0) {
      checks.push(
        check(
          'config',
          'fail',
          'No setup on this machine',
          `Nothing at ${paths.configPath}. Run photo-pigeon setup and the wizard will make one.`,
        ),
      );
    }
    return finish(checks);
  }

  checks.push(
    check('config', 'ok', 'Config found', `${paths.configPath}, watching ${config.watchDirs.length} folder(s).`),
  );

  for (const dir of config.watchDirs) {
    if (!(await dirExists(dir, fs))) {
      checks.push(
        check(
          'watch-dir',
          'warn',
          'A watched folder is missing',
          `${dir} is in the config but is not there right now. An unplugged drive explains it. Nothing gets uploaded from a folder that is not mounted, and nothing gets deleted either.`,
        ),
      );
    }
  }

  // --- credentials --------------------------------------------------------
  const credentialsPath = config.credentialsPath || paths.credentialsPath;
  let clientId: string | undefined;
  let projectId: string | undefined;
  try {
    const parsed = await readClientCredentials(credentialsPath, fs);
    clientId = parsed.clientId;
    projectId = parsed.projectId;
    if (parsed.clientType === 'web') {
      checks.push(
        check(
          'credentials',
          'fail',
          'Wrong kind of OAuth client',
          'That file is a Web application client. Sign-in happens on a loopback address on this machine, which only a Desktop app client is allowed to use. Create a new client, pick Desktop app, and run setup again.',
          consoleLink('createClient', parsed.projectId),
        ),
      );
    } else {
      checks.push(
        check(
          'credentials',
          'ok',
          'Credentials present and readable',
          `${credentialsPath}, Desktop client ${shortenClientId(parsed.clientId)}.`,
        ),
      );
    }
  } catch (error) {
    checks.push(
      check(
        'credentials',
        'fail',
        'Credentials missing or unusable',
        `${(error as Error).message} Run photo-pigeon setup to put your own client JSON in place. This tool ships no credentials of its own, by design.`,
      ),
    );
  }

  // --- the client id lock -------------------------------------------------
  const setup = await readSetupRecord(paths.setupPath, fs).catch(() => undefined);
  if (clientId && setup?.clientId) {
    checks.push(describeClientLock(setup.clientId, clientId));
  } else if (clientId) {
    checks.push(
      check(
        'client-lock',
        'note',
        'No record of which client this setup started on',
        'Google Photos only shows uploads back to the client id that made them, so a regenerated client orphans everything already delivered. Setups made before this record existed cannot be checked for that. Nothing is wrong, it just cannot be verified.',
      ),
    );
  }

  // --- the token ----------------------------------------------------------
  const tokenPath = config.tokenPath || paths.tokenPath;
  try {
    const stat = await fs.stat(tokenPath);
    const days = daysBetween(stat.mtimeMs, now);
    const idle = classifyClientIdleness(days);
    checks.push(
      check(
        'token',
        idle.level,
        `Signed in, token file written ${humanizeDuration(now - stat.mtimeMs)} ago`,
        idle.detail,
        idle.level === 'ok' ? undefined : consoleLink('clients', projectId ?? setup?.projectId),
      ),
    );
  } catch {
    checks.push(
      check(
        'token',
        'warn',
        'Not signed in yet',
        `No token at ${tokenPath}. Run photo-pigeon auth: a browser opens once, you approve, and the token lands here.`,
      ),
    );
  }

  // --- the two things doctor cannot see -----------------------------------
  checks.push(
    check(
      'publishing-status',
      'note',
      'Publishing status has to be checked by eye',
      'Google exposes no way to read it from here. It should say In production. If it says Testing, sign-ins expire after seven days and uploads will start failing with invalid_grant about a week after setup. That error, within a week of setting up, means this and nothing else. The fix is the Publish app button on the page below.',
      consoleLink('audience', projectId ?? setup?.projectId),
    ),
  );

  checks.push(
    check(
      'if-uploads-fail',
      'note',
      'The other two things that go wrong, and how they read',
      'A 403 saying SERVICE_DISABLED means the Photos Library API is switched off for the project, and the link below turns it back on. A sign-in Google refuses outright, often with admin_policy_enforced, means the account is managed by an organisation or is on Advanced Protection: those refuse unverified clients and there is no appeal path. That one cannot be fixed from here.',
      consoleLink('enablePhotosApi', projectId ?? setup?.projectId),
    ),
  );

  // Two numbers appear on the status screen and they are not the same kind of
  // thing, so doctor says which one to trust. The byte total is summed from the
  // ledger, which is the durable record of what was delivered. The request count
  // is the transport's day counter, and it counts batchCreate calls: the live
  // probe on 28-Jul-2026 confirmed that the upload and chunk requests carrying
  // the bytes are not metered against the daily Library API quota at all.
  checks.push(
    check(
      'storage',
      'note',
      'Uploads are original quality',
      'Everything this tool sends counts against your Google account storage at full size. Storage Saver does not apply to API uploads. For how much that has come to, read the byte total in photo-pigeon status: it is the ledger tally, summed from one line per delivered file, and the ledger is what decides whether a file counts as delivered, so that total is the canonical one. The request count beside it answers a different question. It counts batchCreate calls only, which are the calls metered against the daily Library API quota, so it runs far below the file count and it says nothing about bytes.',
    ),
  );

  return finish(checks);
}

function finish(checks: DoctorCheck[]): DoctorReport {
  return { checks, ok: !checks.some((item) => item.level === 'fail') };
}

function shortenClientId(clientId: string): string {
  return clientId.length <= 20 ? clientId : `${clientId.slice(0, 17)}...`;
}

const BADGES: Record<DoctorLevel, string> = {
  ok: pc.green('ok  '),
  note: pc.dim('note'),
  warn: pc.yellow('warn'),
  fail: pc.red('fail'),
};

/** Renders a report for a terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const item of report.checks) {
    lines.push(`${BADGES[item.level]}  ${pc.bold(item.title)}`);
    lines.push(`      ${wrap(item.detail, 6)}`);
    if (item.link) lines.push(`      ${pc.cyan(item.link)}`);
    lines.push('');
  }
  lines.push(
    report.ok
      ? pc.green('Nothing is broken.')
      : pc.red('Something above needs fixing before uploads will work.'),
  );
  return lines.join('\n');
}

/** Prints a report. */
export function printDoctorReport(report: DoctorReport, io: WizardIo = consoleIo): void {
  io.log(formatDoctorReport(report));
}

/** Soft wraps a paragraph to a readable width, indenting continuation lines. */
function wrap(text: string, indent: number, width = 78): string {
  const pad = ' '.repeat(indent);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length + indent <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${pad}`);
}

/** Where doctor looked, useful when someone wants to poke at the files themselves. */
export function doctorPaths(homeDir?: string): ReturnType<typeof resolvePaths> & { configDirName: string } {
  const paths = resolvePaths(homeDir);
  return { ...paths, configDirName: path.basename(paths.configDir) };
}
