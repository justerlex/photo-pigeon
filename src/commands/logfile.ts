/**
 * The log file the tray's "Open log" menu item opens.
 *
 * A tray app has no terminal, so the sentences `watch` prints have to survive
 * somewhere a user can be sent. That is this: one plain text file next to the
 * ledger, in the folder the tool already owns, at a path derived from the
 * ledger rather than configured, because a log path a user can point somewhere
 * else is a log path a support question cannot find.
 *
 * Three decisions worth stating.
 *
 * Writes are synchronous. A buffered stream is faster and loses the tail, and
 * the tail is the only part anybody ever reads, because the interesting run is
 * the one that was killed. On Windows every stop a parent process can send is a
 * TerminateProcess with no flush and no exit hook, so a line that is not on disk
 * when it is written is a line that will not be there.
 *
 * Rotation is by size and keeps three files, about a megabyte each. A watcher
 * that has been up for a month should cost three megabytes, not three hundred.
 *
 * Every line goes through a redactor. Nothing in this tool is supposed to log a
 * credential, and this is the second lock on that door: upload session URLs and
 * OAuth tokens are recognised and replaced before they reach the disk. Hashes
 * and file paths are not secrets and are kept, because without them the file
 * answers no questions.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Logger } from './log.js';

/** The log file's name. Derived from the ledger's folder, never configured. */
export const LOG_FILE_NAME = 'watch.log';

/** Roll over at about a megabyte. */
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/** watch.log, watch.log.1, watch.log.2. Three files, three megabytes, no more. */
export const DEFAULT_KEEP = 3;

/** The log file that goes with this ledger. Same folder, fixed name. */
export function logFilePathFor(ledgerPath: string): string {
  return path.join(path.dirname(path.resolve(ledgerPath)), LOG_FILE_NAME);
}

/**
 * Things that must never reach the disk.
 *
 * Deliberately specific. A rule broad enough to catch "anything long and
 * random" also catches sha256 hashes and Windows paths, and a log with the
 * evidence removed is not worth writing.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Resumable upload session URLs. These are bearer capabilities on their own:
  // anyone holding one can push bytes into the user's library for seven days.
  [/https?:\/\/\S*(?:upload_id=|upload\/v1\/|\/v1\/uploads)\S*/gi, '[upload url removed]'],
  // OAuth material by its unmistakable Google prefixes.
  [/\b(?:ya29\.|1\/\/|GOCSPX-)[A-Za-z0-9._~+/-]{8,}=*/g, '[token removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [token removed]'],
  // And by name, whatever shape the surrounding JSON or query string is in.
  [
    /\b(access_token|refresh_token|id_token|client_secret|upload_?token|code_verifier)\b(["']?\s*[:=]\s*["']?)([^\s"',&}]+)/gi,
    '$1$2[removed]',
  ],
];

/** ANSI colour, which picocolors adds when the console is a terminal and a file does not want. */
const ANSI = /\[[0-9;]*m/g;

/** Strips colour and anything that looks like a credential. Never throws. */
export function redact(text: string): string {
  let out = text.replace(ANSI, '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** A size-rotating text file. */
export interface FileLog {
  /** Absolute path of the file being written now. */
  readonly path: string;
  /** Appends one line, rotating first when this line would push the file over. */
  write(message: string): void;
  /** Stops writing. Idempotent. */
  close(): void;
}

/** Knobs, all optional. */
export interface FileLogOptions {
  /** Roll over above this many bytes. */
  maxBytes?: number;
  /** Total files kept, the live one included. Minimum one. */
  keep?: number;
  /** Clock, injectable. */
  now?: () => Date;
}

/** A sink that swallows everything, for when the log folder cannot be written. */
function deadLog(logPath: string): FileLog {
  return { path: logPath, write: () => {}, close: () => {} };
}

/**
 * Opens the rotating log.
 *
 * Never throws. A log file is a convenience and a read-only disk, a locked
 * folder or an antivirus product holding the file open is not a reason to
 * refuse to deliver photos.
 */
export function openFileLog(logPath: string, options: FileLogOptions = {}): FileLog {
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const keep = Math.max(1, options.keep ?? DEFAULT_KEEP);
  const now = options.now ?? ((): Date => new Date());

  try {
    mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  } catch {
    return deadLog(logPath);
  }

  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    size = 0;
  }

  let closed = false;
  /** True once a write has failed, so a broken disk costs one failure and not one per line. */
  let broken = false;

  /** watch.log -> watch.log.1 -> watch.log.2, and whatever was oldest is dropped. */
  const rotate = (): void => {
    try {
      rmSync(`${logPath}.${keep - 1}`, { force: true });
    } catch {
      // An old roll that will not go is not worth failing a write over.
    }
    for (let index = keep - 2; index >= 0; index -= 1) {
      const from = index === 0 ? logPath : `${logPath}.${index}`;
      const to = `${logPath}.${index + 1}`;
      try {
        renameSync(from, to);
      } catch {
        // Missing, or held open by something. Either way, carry on.
      }
    }
    size = 0;
  };

  return {
    path: logPath,
    write(message: string): void {
      if (closed || broken) return;
      const stamp = now().toISOString();
      const line = `${stamp}  ${redact(message)}\n`;
      const bytes = Buffer.byteLength(line);
      if (keep > 1 && size > 0 && size + bytes > maxBytes) rotate();
      try {
        appendFileSync(logPath, line);
        size += bytes;
      } catch {
        broken = true;
      }
    },
    close(): void {
      closed = true;
    },
  };
}

/**
 * Wraps a logger so everything it says also lands in the file.
 *
 * The console keeps its colours and its short hh:mm stamp; the file gets the
 * same sentence with a full ISO timestamp and no escape codes, because the
 * file is read days later by somebody who needs to know which day.
 */
export function withFileLog(log: Logger, file: FileLog): Logger {
  return {
    info(message) {
      log.info(message);
      file.write(message);
    },
    ok(message) {
      log.ok(message);
      file.write(message);
    },
    warn(message) {
      log.warn(message);
      file.write(`warning: ${message}`);
    },
    error(message) {
      log.error(message);
      file.write(`error: ${message}`);
    },
    muted(message) {
      log.muted(message);
      file.write(message);
    },
    plain(message = '') {
      log.plain(message);
      // Blank lines are terminal spacing, not content.
      if (message.trim() !== '') file.write(message);
    },
  };
}
