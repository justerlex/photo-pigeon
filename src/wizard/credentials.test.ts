import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FsLike, StatLike } from './fs-like.js';
import {
  CredentialsError,
  installCredentials,
  isClientSecretFileName,
  newestCandidate,
  parseClientCredentials,
  scanForClientSecrets,
  WatchAbortedError,
  watchForClientSecret,
} from './credentials.js';

/** A tiny in memory file system, so these tests never touch a real Downloads folder. */
function memoryFs(files: Record<string, { content?: string; mtimeMs?: number; dir?: boolean }>): {
  fs: FsLike;
  written: Map<string, { data: string; mode?: number }>;
  renames: Array<[string, string]>;
} {
  const written = new Map<string, { data: string; mode?: number }>();
  const renames: Array<[string, string]> = [];
  const madeDirs = new Set<string>();

  const statOf = (target: string): StatLike | undefined => {
    const entry = files[target];
    if (entry) {
      return {
        mtimeMs: entry.mtimeMs ?? 0,
        size: entry.content?.length ?? 0,
        isFile: () => !entry.dir,
        isDirectory: () => Boolean(entry.dir),
      };
    }
    const w = written.get(target);
    if (w) {
      return { mtimeMs: 0, size: w.data.length, isFile: () => true, isDirectory: () => false };
    }
    if (madeDirs.has(target)) {
      return { mtimeMs: 0, size: 0, isFile: () => false, isDirectory: () => true };
    }
    return undefined;
  };

  const fs: FsLike = {
    async mkdir(dir) {
      madeDirs.add(dir);
    },
    async readdir(dir) {
      const entry = files[dir];
      if (!entry?.dir) throw new Error(`ENOENT: ${dir}`);
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      return Object.keys(files)
        .filter((key) => key.startsWith(prefix) && !files[key]?.dir)
        .map((key) => key.slice(prefix.length))
        .filter((name) => !name.includes(path.sep));
    },
    async stat(target) {
      const stat = statOf(target);
      if (!stat) throw new Error(`ENOENT: ${target}`);
      return stat;
    },
    async readFile(file) {
      const entry = files[file];
      if (entry?.content !== undefined) return entry.content;
      const w = written.get(file);
      if (w) return w.data;
      throw new Error(`ENOENT: ${file}`);
    },
    async writeFile(file, data, mode) {
      written.set(file, mode === undefined ? { data } : { data, mode });
    },
    async rename(from, to) {
      const value = written.get(from);
      if (!value) throw new Error(`ENOENT: ${from}`);
      written.delete(from);
      written.set(to, value);
      renames.push([from, to]);
    },
  };

  return { fs, written, renames };
}

const DESKTOP_JSON = JSON.stringify({
  installed: {
    client_id: '1234567890-abcdef.apps.googleusercontent.com',
    project_id: 'photo-pigeon-uploads',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    client_secret: 'GOCSPX-notarealsecret',
    redirect_uris: ['http://localhost'],
  },
});

const WEB_JSON = JSON.stringify({
  web: {
    client_id: '1234567890-web.apps.googleusercontent.com',
    client_secret: 'GOCSPX-alsonotreal',
    redirect_uris: ['https://example.test/callback'],
  },
});

describe('isClientSecretFileName', () => {
  it('matches what Chrome, Edge and Firefox actually save', () => {
    expect(
      isClientSecretFileName('client_secret_1234-abcdef.apps.googleusercontent.com.json'),
    ).toBe(true);
    expect(isClientSecretFileName('client_secret.json')).toBe(true);
    expect(isClientSecretFileName('client_secret_2 (1).json')).toBe(true);
    expect(isClientSecretFileName('CLIENT_SECRET_X.JSON')).toBe(true);
  });

  it('ignores everything else in a Downloads folder', () => {
    expect(isClientSecretFileName('holiday.jpg')).toBe(false);
    expect(isClientSecretFileName('client_secret.json.crdownload')).toBe(false);
    expect(isClientSecretFileName('my_client_secret.json')).toBe(false);
    expect(isClientSecretFileName('credentials.json')).toBe(false);
  });
});

describe('scanForClientSecrets', () => {
  const downloads = path.join('C:', 'Users', 'tester', 'Downloads');
  const oneDrive = path.join('C:', 'Users', 'tester', 'OneDrive', 'Downloads');

  it('finds matching files across folders, newest first', async () => {
    const { fs } = memoryFs({
      [downloads]: { dir: true },
      [oneDrive]: { dir: true },
      [path.join(downloads, 'client_secret_old.json')]: { content: '{}', mtimeMs: 1000 },
      [path.join(downloads, 'cat.png')]: { content: 'x', mtimeMs: 9000 },
      [path.join(oneDrive, 'client_secret_new.json')]: { content: '{}', mtimeMs: 5000 },
    });

    const found = await scanForClientSecrets([downloads, oneDrive], fs);
    expect(found.map((item) => path.basename(item.path))).toEqual([
      'client_secret_new.json',
      'client_secret_old.json',
    ]);
  });

  it('skips folders that are not there instead of failing', async () => {
    const { fs } = memoryFs({
      [downloads]: { dir: true },
      [path.join(downloads, 'client_secret_a.json')]: { content: '{}', mtimeMs: 1 },
    });
    const found = await scanForClientSecrets([downloads, oneDrive, 'D:\\nope'], fs);
    expect(found).toHaveLength(1);
  });

  it('returns nothing when the folder holds nothing relevant', async () => {
    const { fs } = memoryFs({
      [downloads]: { dir: true },
      [path.join(downloads, 'invoice.pdf')]: { content: 'x', mtimeMs: 1 },
    });
    expect(await scanForClientSecrets([downloads], fs)).toEqual([]);
  });
});

describe('newestCandidate', () => {
  it('picks the most recent', () => {
    const best = newestCandidate([
      { path: 'a', mtimeMs: 10 },
      { path: 'b', mtimeMs: 30 },
      { path: 'c', mtimeMs: 20 },
    ]);
    expect(best?.path).toBe('b');
  });

  it('handles an empty list', () => {
    expect(newestCandidate([])).toBeUndefined();
  });
});

describe('parseClientCredentials', () => {
  it('reads a Desktop client', () => {
    const parsed = parseClientCredentials(DESKTOP_JSON);
    expect(parsed.clientType).toBe('installed');
    expect(parsed.clientId).toBe('1234567890-abcdef.apps.googleusercontent.com');
    expect(parsed.projectId).toBe('photo-pigeon-uploads');
    expect(parsed.redirectUris).toEqual(['http://localhost']);
  });

  it('reads a Web client but labels it as one', () => {
    expect(parseClientCredentials(WEB_JSON).clientType).toBe('web');
  });

  it('explains itself when the file is not JSON', () => {
    expect(() => parseClientCredentials('not json at all')).toThrow(CredentialsError);
  });

  it('explains itself when the JSON is some other file', () => {
    expect(() => parseClientCredentials('{"hello":"world"}')).toThrow(/installed or web/);
  });

  it('catches a client file with no secret in it', () => {
    const noSecret = JSON.stringify({ installed: { client_id: 'x.apps.googleusercontent.com' } });
    expect(() => parseClientCredentials(noSecret)).toThrow(/only offers the secret/);
  });
});

describe('installCredentials', () => {
  const source = path.join('C:', 'Users', 'tester', 'Downloads', 'client_secret_x.json');
  const dest = path.join('C:', 'Users', 'tester', '.photo-pigeon', 'credentials.json');

  it('copies the file in through a temp file and locks it down', async () => {
    const { fs, written, renames } = memoryFs({ [source]: { content: DESKTOP_JSON, mtimeMs: 1 } });
    const parsed = await installCredentials(source, dest, fs);

    expect(parsed.clientId).toBe('1234567890-abcdef.apps.googleusercontent.com');
    expect(written.get(dest)?.data).toBe(DESKTOP_JSON);
    expect(written.get(dest)?.mode).toBe(0o600);
    expect(renames).toEqual([[`${dest}.tmp`, dest]]);
  });

  it('leaves the downloaded original alone', async () => {
    const files = { [source]: { content: DESKTOP_JSON, mtimeMs: 1 } };
    const { fs } = memoryFs(files);
    await installCredentials(source, dest, fs);
    expect(await fs.readFile(source)).toBe(DESKTOP_JSON);
  });

  it('refuses a Web client, since loopback sign-in needs a Desktop one', async () => {
    const { fs, written } = memoryFs({ [source]: { content: WEB_JSON, mtimeMs: 1 } });
    await expect(installCredentials(source, dest, fs)).rejects.toThrow(/Desktop app/);
    expect(written.has(dest)).toBe(false);
  });

  it('says so plainly when the path does not exist', async () => {
    const { fs } = memoryFs({});
    await expect(installCredentials(source, dest, fs)).rejects.toThrow(CredentialsError);
  });
});

describe('watchForClientSecret', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-pigeon-downloads-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('picks up a client secret that lands in the folder', async () => {
    const controller = new AbortController();
    const found = watchForClientSecret([dir], controller.signal);
    await settle(400);
    const dropped = path.join(dir, 'client_secret_1234.apps.googleusercontent.com.json');
    await fsp.writeFile(dropped, DESKTOP_JSON, 'utf8');
    await expect(found).resolves.toBe(dropped);
  }, 15_000);

  it('ignores everything else that lands there', async () => {
    const controller = new AbortController();
    const found = watchForClientSecret([dir], controller.signal);
    found.catch(() => undefined);
    await settle(400);
    await fsp.writeFile(path.join(dir, 'holiday.jpg'), 'not a photo really', 'utf8');
    const outcome = await Promise.race([found.then(() => 'resolved'), settle(2_000).then(() => 'waiting')]);
    expect(outcome).toBe('waiting');
    controller.abort();
  }, 15_000);

  it('can be called off, which is how the typed path wins the race', async () => {
    const controller = new AbortController();
    const found = watchForClientSecret([dir], controller.signal);
    controller.abort();
    await expect(found).rejects.toThrow(WatchAbortedError);
  });

  it('does not fall over when there is no folder to watch', async () => {
    const controller = new AbortController();
    const found = watchForClientSecret([], controller.signal);
    controller.abort();
    await expect(found).rejects.toThrow(WatchAbortedError);
  });
});
