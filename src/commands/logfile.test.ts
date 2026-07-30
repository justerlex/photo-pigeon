/**
 * Log file tests.
 *
 * Two things have to be true or the file is a liability rather than an asset:
 * it must stop growing, and it must never contain a credential.
 */

import { readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Logger } from './log.js';
import {
  DEFAULT_KEEP,
  logFilePathFor,
  openFileLog,
  redact,
  withFileLog,
} from './logfile.js';

let dir: string;
let logPath: string;

/** A fixed clock, so every line is exactly as long as the next one. */
const at = (): Date => new Date('2026-07-28T20:00:00.000Z');

/** 24 characters of ISO stamp, two spaces, the message, one newline. */
const lineBytes = (message: string): number => 24 + 2 + Buffer.byteLength(message) + 1;

const exists = (file: string): boolean => {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
};

const linesIn = (file: string): string[] =>
  readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'pigeon-log-'));
  logPath = path.join(dir, 'watch.log');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('where it lives', () => {
  it('sits next to the ledger, under a name nobody chose', () => {
    expect(logFilePathFor(path.join(dir, 'ledger.jsonl'))).toBe(path.join(dir, 'watch.log'));
  });
});

describe('rotation', () => {
  it('rolls exactly at the size boundary and not before', () => {
    const message = 'x'.repeat(100);
    const each = lineBytes(message);
    const maxBytes = 1024;
    const fits = Math.floor(maxBytes / each); // 8 lines, 1016 bytes

    const file = openFileLog(logPath, { maxBytes, now: at });
    for (let index = 0; index < fits; index += 1) file.write(message);

    // Full to the brim, and still one file.
    expect(statSync(logPath).size).toBe(fits * each);
    expect(statSync(logPath).size).toBeLessThanOrEqual(maxBytes);
    expect(exists(`${logPath}.1`)).toBe(false);

    // The line that would cross the line is the line that rolls it.
    file.write(message);
    expect(exists(`${logPath}.1`)).toBe(true);
    expect(linesIn(`${logPath}.1`)).toHaveLength(fits);
    expect(linesIn(logPath)).toHaveLength(1);
    file.close();
  });

  it('keeps three files and lets the oldest go', () => {
    const message = 'y'.repeat(100);
    const each = lineBytes(message);
    const maxBytes = 1024;
    const fits = Math.floor(maxBytes / each);

    const file = openFileLog(logPath, { maxBytes, now: at });
    // Enough to roll well past the number of files kept.
    for (let index = 0; index < fits * 6; index += 1) file.write(message);
    file.close();

    expect(DEFAULT_KEEP).toBe(3);
    expect(exists(logPath)).toBe(true);
    expect(exists(`${logPath}.1`)).toBe(true);
    expect(exists(`${logPath}.2`)).toBe(true);
    expect(exists(`${logPath}.3`)).toBe(false);
  });

  it('picks up where the last run left off instead of truncating it', () => {
    const first = openFileLog(logPath, { now: at });
    first.write('from the run before');
    first.close();

    const second = openFileLog(logPath, { now: at });
    second.write('from this run');
    second.close();

    expect(linesIn(logPath)).toHaveLength(2);
  });

  it('writes nothing more once it is closed', () => {
    const file = openFileLog(logPath, { now: at });
    file.write('before');
    file.close();
    file.write('after');

    expect(readFileSync(logPath, 'utf8')).not.toContain('after');
  });

  it('never throws when the folder cannot be written', () => {
    // A path whose parent is a file, so the mkdir cannot work.
    const blocked = path.join(logPath, 'inside', 'watch.log');
    openFileLog(logPath, { now: at }).write('makes watch.log a file');

    const file = openFileLog(blocked, { now: at });
    expect(() => file.write('nowhere to go')).not.toThrow();
    file.close();
  });
});

describe('redaction', () => {
  it('removes a resumable upload session URL', () => {
    const line = redact(
      'session https://photoslibrary.googleapis.com/v1/uploads?upload_id=ABC123secret&upload_protocol=resumable ready',
    );
    expect(line).not.toContain('ABC123secret');
    expect(line).toContain('[upload url removed]');
  });

  it('removes access and refresh tokens by their Google shapes', () => {
    expect(redact('token ya29.a0AfB_byQnotreal_ABCDEFG')).not.toContain('a0AfB_byQnotreal');
    expect(redact('stored 1//0gLONGREFRESHTOKENVALUE')).not.toContain('0gLONGREFRESHTOKEN');
    expect(redact('secret GOCSPX-abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('removes anything named like a credential, in JSON or in a query string', () => {
    expect(redact('{"refresh_token":"1234567890abcdef"}')).not.toContain('1234567890abcdef');
    expect(redact('access_token=zzzzzzzzzzzz&scope=appendonly')).not.toContain('zzzzzzzzzzzz');
    expect(redact('access_token=zzzzzzzzzzzz&scope=appendonly')).toContain('scope=appendonly');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrst')).not.toContain('abcdefghijkl');
  });

  it('keeps the things the file exists to record', () => {
    const hash = 'a'.repeat(64);
    const line = redact(`delivered IMG_0001.jpg from C:\\Users\\someone\\Desktop, ${hash}`);
    expect(line).toContain('IMG_0001.jpg');
    expect(line).toContain('C:\\Users\\someone\\Desktop');
    expect(line).toContain(hash);
  });

  it('strips terminal colour, which a file has no use for', () => {
    expect(redact('\u001b[32mdelivered\u001b[39m IMG_0002.jpg')).toBe('delivered IMG_0002.jpg');
  });
});

describe('the logger decorator', () => {
  it('says everything twice: once to the console, once to the file', () => {
    const said: string[] = [];
    const console_: Logger = {
      info: (m) => said.push(m),
      ok: (m) => said.push(m),
      warn: (m) => said.push(m),
      error: (m) => said.push(m),
      muted: (m) => said.push(m),
      plain: (m = '') => said.push(m),
    };
    const file = openFileLog(logPath, { now: at });
    const log = withFileLog(console_, file);

    log.info('checking the folders against the ledger');
    log.ok('delivered IMG_0003.jpg');
    log.error('could not upload IMG_0004.jpg');
    log.plain('');
    file.close();

    expect(said).toContain('delivered IMG_0003.jpg');
    const written = readFileSync(logPath, 'utf8');
    expect(written).toContain('checking the folders against the ledger');
    expect(written).toContain('delivered IMG_0003.jpg');
    expect(written).toContain('error: could not upload IMG_0004.jpg');
    // Blank lines are terminal spacing, not content.
    expect(linesIn(logPath)).toHaveLength(3);
  });

  it('redacts on the way to the file without touching the console', () => {
    const said: string[] = [];
    const push = (m: string): void => void said.push(m);
    const console_: Logger = {
      info: push,
      ok: push,
      warn: push,
      error: push,
      muted: push,
      plain: (m = '') => push(m),
    };
    const file = openFileLog(logPath, { now: at });
    withFileLog(console_, file).info('session https://storage.googleapis.com/upload/v1/x?upload_id=SECRET');
    file.close();

    expect(said[0]).toContain('SECRET');
    expect(readFileSync(logPath, 'utf8')).not.toContain('SECRET');
  });
});
