/**
 * login tests with a fake Runtime: no filesystem, no browser, no network.
 *
 * The point of this command is that the advice printed elsewhere in the tool
 * leads somewhere. So the tests check the two things a caller depends on: that
 * it actually reaches ensureAuth, and that a refusal from ensureAuth comes back
 * as a nonzero exit rather than a cheerful "signed in".
 */

import { describe, expect, it } from 'vitest';

import type { AppConfig, GPhotosClient } from '../contracts.js';
import { EXIT } from './errors.js';
import type { Logger } from './log.js';
import { runLogin } from './login.js';
import type { Runtime } from './runtime.js';

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    watchDirs: ['/photos'],
    credentialsPath: '/home/.photo-pigeon/credentials.json',
    tokenPath: '/home/.photo-pigeon/token.json',
    ledgerPath: '/home/.photo-pigeon/ledger.jsonl',
    extensions: ['.jpg'],
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

interface Harness {
  runtime: Runtime;
  calls: string[];
}

function harness(config: AppConfig, authFails?: Error): Harness {
  const calls: string[] = [];

  const client: GPhotosClient = {
    async ensureAuth() {
      calls.push('ensureAuth');
      if (authFails) throw authFails;
    },
    async uploadFile() {
      throw new Error('login must never upload');
    },
    async batchCreate() {
      throw new Error('login must never create media items');
    },
  };

  const runtime: Runtime = {
    async loadConfig() {
      calls.push('loadConfig');
      return config;
    },
    async openLedger() {
      throw new Error('login must never open the ledger');
    },
    async createClient() {
      calls.push('createClient');
      return client;
    },
    async start() {
      throw new Error('login must never start the watcher');
    },
    async usage() {
      return undefined;
    },
    async runWizard() {
      throw new Error('login must never run the wizard');
    },
    async runDoctor() {
      throw new Error('login must never run doctor');
    },
    async hashFile() {
      throw new Error('login must never hash a file');
    },
  };

  return { runtime, calls };
}

describe('runLogin', () => {
  it('reaches ensureAuth and reports success', async () => {
    const config = testConfig();
    const { runtime, calls } = harness(config);
    const { log, lines } = recordingLogger();

    const code = await runLogin({}, runtime, log);

    expect(code).toBe(EXIT.OK);
    expect(calls).toEqual(['loadConfig', 'createClient', 'ensureAuth']);
    expect(lines.join('\n')).toContain('signed in.');
  });

  it('tells the user where the token landed, since the headless path is to copy it', async () => {
    const config = testConfig({ tokenPath: '/home/.photo-pigeon/token.json' });
    const { runtime } = harness(config);
    const { log, lines } = recordingLogger();

    await runLogin({}, runtime, log);

    const output = lines.join('\n');
    expect(output).toContain('/home/.photo-pigeon/token.json');
    expect(output).toContain('no browser');
  });

  it('lets a refusal from ensureAuth out rather than claiming success', async () => {
    const { runtime } = harness(testConfig(), new Error('consent screen still in Testing'));
    const { log, lines } = recordingLogger();

    await expect(runLogin({}, runtime, log)).rejects.toThrow('consent screen still in Testing');
    expect(lines.join('\n')).not.toContain('signed in.');
  });

  it('passes an explicit config path through to loadConfig', async () => {
    const config = testConfig();
    const seen: (string | undefined)[] = [];
    const { runtime } = harness(config);
    const wrapped: Runtime = {
      ...runtime,
      async loadConfig(explicitPath?: string) {
        seen.push(explicitPath);
        return config;
      },
    };
    const { log } = recordingLogger();

    await runLogin({ config: '/elsewhere/config.json' }, wrapped, log);

    expect(seen).toEqual(['/elsewhere/config.json']);
  });
});
