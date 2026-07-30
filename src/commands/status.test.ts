/**
 * status tests with a fake Runtime: no filesystem to speak of, no network.
 *
 * What is being pinned here is honesty. The bytes come from the ledger, which
 * is the durable record, and the request count comes from the transport and
 * means something narrower: batchCreate calls. A reader who confuses the two
 * would think uploading a big video eats the daily limit, and it does not.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AppConfig, Ledger, LedgerStats } from '../contracts.js';
import type { Logger } from './log.js';
import type { Runtime, UsageSummary } from './runtime.js';
import { runStatus, wrapList } from './status.js';

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dir = path.join('/tmp', 'photo-pigeon-status', '.photo-pigeon');
  return {
    watchDirs: [path.join('/tmp', 'photo-pigeon-status', 'Pictures')],
    credentialsPath: path.join(dir, 'credentials.json'),
    tokenPath: path.join(dir, 'token.json'),
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    extensions: ['.jpg', '.mp4'],
    ...overrides,
  };
}

function recordingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (message: string): void => {
    lines.push(message);
  };
  return {
    lines,
    log: {
      info: push,
      ok: push,
      warn: push,
      error: push,
      muted: push,
      plain: (message = '') => {
        lines.push(message);
      },
    },
  };
}

function fakeRuntime(stats: LedgerStats, usage?: UsageSummary): Runtime {
  const ledger: Ledger = {
    has: () => false,
    get: () => undefined,
    add: async () => {},
    stats: () => stats,
  };
  const unused = (): never => {
    throw new Error('status should not need this');
  };
  return {
    loadConfig: async () => testConfig(),
    openLedger: async () => ledger,
    usage: async () => usage,
    createClient: unused,
    start: unused,
    runWizard: unused,
    runDoctor: unused,
    hashFile: unused,
  };
}

const said = (lines: string[]): string => lines.join('\n');

describe('runStatus', () => {
  it('quotes the ledger for what has been delivered', async () => {
    const { log, lines } = recordingLogger();
    await runStatus({ config: path.join('/tmp', 'nowhere', 'config.json') }, fakeRuntime({ count: 3, totalBytes: 5_242_880 }), log);
    expect(said(lines)).toContain('Delivered 3 files');
    expect(said(lines)).toContain('5.0 MB');
    expect(said(lines)).toContain('original quality');
  });

  it('says nothing has been delivered rather than showing a zero', async () => {
    const { log, lines } = recordingLogger();
    await runStatus({ config: path.join('/tmp', 'nowhere', 'config.json') }, fakeRuntime({ count: 0, totalBytes: 0 }), log);
    expect(said(lines)).toContain('Nothing delivered yet.');
  });

  it('spells out that a request is a batchCreate call, not an upload', async () => {
    const { log, lines } = recordingLogger();
    await runStatus(
      { config: path.join('/tmp', 'nowhere', 'config.json') },
      fakeRuntime(
        { count: 3, totalBytes: 1024 },
        {
          day: '2026-07-28',
          requests: 12,
          remaining: 9_988,
          ceiling: 10_000,
          bytesUploaded: 4096,
          bytesToday: 2048,
        },
      ),
      log,
    );
    const text = said(lines);
    expect(text).toContain('Today (2026-07-28)');
    expect(text).toContain('12 requests of 10,000');
    expect(text).toContain('A request is one batchCreate call.');
    expect(text).toContain('does not count towards that limit');
  });

  it('leaves the request line out when the counters cannot be read', async () => {
    const { log, lines } = recordingLogger();
    await runStatus({ config: path.join('/tmp', 'nowhere', 'config.json') }, fakeRuntime({ count: 1, totalBytes: 10 }), log);
    expect(said(lines)).not.toContain('batchCreate');
  });

  it('prints the config it read and the folders it watches', async () => {
    const { log, lines } = recordingLogger();
    await runStatus({ config: path.join('/tmp', 'nowhere', 'config.json') }, fakeRuntime({ count: 0, totalBytes: 0 }), log);
    const text = said(lines);
    expect(text).toContain(path.resolve(path.join('/tmp', 'nowhere', 'config.json')));
    expect(text).toContain(path.join('/tmp', 'photo-pigeon-status', 'Pictures'));
    expect(text).toContain('.jpg .mp4');
  });
});

describe('wrapList', () => {
  it('wraps rather than cutting anything off, because a missing type looks like a bug', () => {
    const lines = wrapList(['.jpg', '.jpeg', '.png', '.heic'], 12);
    expect(lines.join(' ').split(' ')).toEqual(['.jpg', '.jpeg', '.png', '.heic']);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('says none rather than printing an empty line', () => {
    expect(wrapList([])).toEqual(['none']);
  });
});
