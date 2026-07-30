/**
 * The laws, tested against the source itself.
 *
 * Behaviour tests prove what the code does today. These prove what it cannot
 * become tomorrow without someone noticing: no verb but POST, no endpoint that
 * removes anything, no credential baked into the package, no scope beyond
 * append only. A refactor that breaks one of these fails here first.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { API_LIMITS, OAUTH_SCOPES } from '../contracts.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let sources: { name: string; text: string }[] = [];

beforeAll(async () => {
  const names = (await readdir(HERE)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  sources = await Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(HERE, name), 'utf8') })),
  );
});

describe('the shipped module', () => {
  it('is all here', () => {
    expect(sources.map((s) => s.name).sort()).toEqual([
      'auth.ts',
      'batch.ts',
      'http.ts',
      'index.ts',
      'limiter.ts',
      'log.ts',
      'mime.ts',
      'uploads.ts',
    ]);
  });
});

describe('law 1: upload only, one direction, forever', () => {
  it('sets no HTTP method other than POST', () => {
    for (const { name, text } of sources) {
      const methods = [...text.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
      for (const method of methods) {
        expect(`${name}:${method}`).toBe(`${name}:POST`);
      }
    }
  });

  it('names no endpoint that could remove or change existing media', () => {
    const forbidden = [
      'batchRemoveMediaItems',
      'batchRemove',
      ':delete',
      'mediaItems.delete',
      'albums.delete',
      'sharedAlbums:leave',
      'unshare',
    ];
    for (const { name, text } of sources) {
      for (const fragment of forbidden) {
        expect(`${name} contains ${fragment}: ${text.includes(fragment)}`).toBe(
          `${name} contains ${fragment}: false`,
        );
      }
    }
  });

  it('calls no Google host except the Photos API', () => {
    // Everything else that looks like a link in this module is help text: the
    // console page with the Publish app button and the account permissions page.
    const allowed = [
      'https://photoslibrary.googleapis.com',
      'https://console.cloud.google.com/auth/audience',
      'https://myaccount.google.com/permissions',
      'http://127.0.0.1',
    ];

    for (const { name, text } of sources) {
      const urls = [...text.matchAll(/https?:\/\/[^\s'"`)\\]+/g)].map((m) => m[0]);
      for (const url of urls) {
        const ok = allowed.some((prefix) => url.startsWith(prefix));
        expect(`${name} -> ${url}: ${ok}`).toBe(`${name} -> ${url}: true`);
      }
    }
  });
});

describe('law 3: this package ships zero credentials', () => {
  it('embeds no client id', () => {
    for (const { name, text } of sources) {
      expect(`${name}: ${/\d{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com/.test(text)}`).toBe(
        `${name}: false`,
      );
      expect(`${name}: ${text.includes('.apps.googleusercontent.com')}`).toBe(`${name}: false`);
    }
  });

  it('embeds no client secret', () => {
    for (const { name, text } of sources) {
      expect(`${name}: ${/GOCSPX-[A-Za-z0-9_-]{6,}/.test(text)}`).toBe(`${name}: false`);
    }
  });

  it('asks for no scope beyond append only', () => {
    const otherScopes = [
      'photoslibrary.readonly',
      'photoslibrary.sharing',
      'photoslibrary.edit',
      'photoslibrary.appcreateddata',
      'auth/drive',
      'auth/userinfo',
    ];
    for (const { name, text } of sources) {
      for (const scope of otherScopes) {
        expect(`${name} asks for ${scope}: ${text.includes(scope)}`).toBe(
          `${name} asks for ${scope}: false`,
        );
      }
    }
    expect(OAUTH_SCOPES).toHaveLength(1);
  });

  it('uses a loopback redirect and nothing else', () => {
    const auth = sources.find((s) => s.name === 'auth.ts');
    expect(auth?.text).toContain('127.0.0.1');
    expect(auth?.text).not.toContain('urn:ietf:wg:oauth:2.0:oob');
    expect(auth?.text).not.toContain('oauth2.googleapis.com/device');
  });
});

describe('law 4: the API discipline is taken from contracts, not retyped', () => {
  it('uses the shared constants for the numbers that matter', () => {
    const batch = sources.find((s) => s.name === 'batch.ts')?.text ?? '';
    const http = sources.find((s) => s.name === 'http.ts')?.text ?? '';

    expect(batch).toContain('API_LIMITS.BATCH_CREATE_MAX_ITEMS');
    expect(http).toContain('API_LIMITS.MIN_BACKOFF_MS');

    expect(API_LIMITS.BATCH_CREATE_MAX_ITEMS).toBe(50);
    expect(API_LIMITS.MIN_BACKOFF_MS).toBe(30_000);
  });
});

describe('law 7: the copy has no em dashes', () => {
  it('holds across every file in this module, tests included', async () => {
    const names = (await readdir(HERE)).filter((name) => name.endsWith('.ts'));
    for (const name of names) {
      const text = await readFile(join(HERE, name), 'utf8');
      // Written as an escape so this file does not fail its own check.
      expect(`${name} has an em dash: ${text.includes(String.fromCharCode(0x2014))}`).toBe(
        `${name} has an em dash: false`,
      );
    }
  });
});
