/**
 * Log lines: hh:mm prefix, picocolors used gently.
 *
 * Color carries one bit of meaning only: dim is background detail, yellow is
 * something to look at later, red is something that failed. Everything else is
 * plain text, so the output stays readable when it is piped to a file.
 */

import pc from 'picocolors';

/** Where the commands write. Injectable so tests can read what was said. */
export interface Logger {
  /** Normal progress. */
  info(message: string): void;
  /** Something landed successfully. */
  ok(message: string): void;
  /** Worth knowing, not worth stopping for. */
  warn(message: string): void;
  /** Something failed. Goes to stderr. */
  error(message: string): void;
  /** Background detail: skips, counts, paths. */
  muted(message: string): void;
  /** Verbatim line with no timestamp, for banners and summaries. */
  plain(message?: string): void;
}

/** Two digit hour and minute, the only timestamp a folder watcher needs. */
export function timestamp(at: Date = new Date()): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface LoggerOptions {
  /** Where normal lines go. Defaults to stdout. */
  out?: (line: string) => void;
  /** Where errors go. Defaults to stderr. */
  err?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/** Builds the standard logger. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const stamp = (): string => pc.dim(timestamp(now()));

  return {
    info(message) {
      out(`${stamp()} ${message}`);
    },
    ok(message) {
      out(`${stamp()} ${pc.green(message)}`);
    },
    warn(message) {
      out(`${stamp()} ${pc.yellow(message)}`);
    },
    error(message) {
      err(`${stamp()} ${pc.red(message)}`);
    },
    muted(message) {
      out(pc.dim(`${timestamp(now())} ${message}`));
    },
    plain(message = '') {
      out(message);
    },
  };
}

/**
 * The logger for a run whose stdout belongs to somebody else.
 *
 * Under `--events ndjson` stdout is a machine channel and a parent process is
 * allowed to be strict about it, so every human line, including the ones an
 * error path prints on the way out, moves to stderr. Both channels go to the
 * same place here on purpose: the distinction that matters is stdout against
 * everything else, not info against error.
 */
export function createStderrLogger(): Logger {
  const toStderr = (line: string): void => void process.stderr.write(`${line}\n`);
  return createLogger({ out: toStderr, err: toStderr });
}

/** A logger that says nothing. Handy for tests and for future non-tty callers. */
export function createSilentLogger(): Logger {
  const nothing = (): void => {};
  return {
    info: nothing,
    ok: nothing,
    warn: nothing,
    error: nothing,
    muted: nothing,
    plain: nothing,
  };
}
