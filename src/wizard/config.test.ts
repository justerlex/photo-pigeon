import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../contracts.js';
import { ALL_SUPPORTED_EXTENSIONS, PHOTO_EXTENSIONS, VIDEO_EXTENSIONS } from '../gphotos/mime.js';
import {
  DEFAULT_EXTENSIONS,
  expandHome,
  inspectAppConfig,
  normalizeAppConfig,
  normalizeExtension,
  readAppConfig,
  readSetupRecord,
  writeAppConfig,
  writeSetupRecord,
} from './config.js';
import { resolvePaths } from './paths.js';

let home: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-pigeon-config-'));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

describe('the default extensions', () => {
  it('are gphotos/mime.ts, not a second list kept here', () => {
    expect(DEFAULT_EXTENSIONS).toBe(ALL_SUPPORTED_EXTENSIONS);
  });

  it('cover both halves of what the tool can send', () => {
    expect(DEFAULT_EXTENSIONS).toEqual(expect.arrayContaining([...PHOTO_EXTENSIONS]));
    expect(DEFAULT_EXTENSIONS).toEqual(expect.arrayContaining([...VIDEO_EXTENSIONS]));
    expect(DEFAULT_EXTENSIONS).toContain('.jpg');
    expect(DEFAULT_EXTENSIONS).toContain('.mp4');
  });

  it('are lowercase and dotted, which is what contracts asks for', () => {
    for (const extension of DEFAULT_EXTENSIONS) {
      expect(extension).toBe(normalizeExtension(extension));
    }
  });
});

describe('normalizeAppConfig', () => {
  const base = {
    watchDirs: ['photos'],
    credentialsPath: path.resolve('/c/credentials.json'),
    tokenPath: path.resolve('/c/token.json'),
    ledgerPath: path.resolve('/c/ledger.jsonl'),
  };

  it('fills in the default extensions', () => {
    expect(normalizeAppConfig(base).extensions).toEqual([...DEFAULT_EXTENSIONS]);
  });

  it('makes watch folders absolute, since the watcher gets no cwd', () => {
    expect(normalizeAppConfig(base).watchDirs[0]).toBe(path.resolve('photos'));
  });

  it('normalises extensions to lowercase with a leading dot', () => {
    const config = normalizeAppConfig({ ...base, extensions: ['JPG', '.HEIC', 'mp4'] });
    expect(config.extensions).toEqual(['.jpg', '.heic', '.mp4']);
  });

  it('says one folder once, however many times it was named', () => {
    const twice = normalizeAppConfig({ ...base, watchDirs: ['photos', 'photos'] });
    expect(twice.watchDirs).toHaveLength(1);
  });

  it('leaves the optional flags out when they are not asked for', () => {
    const config = normalizeAppConfig(base);
    expect('albumName' in config).toBe(false);
    expect('dryRun' in config).toBe(false);
    expect('pollFallback' in config).toBe(false);
  });

  it('keeps an album name when there is one', () => {
    expect(normalizeAppConfig({ ...base, albumName: 'Holidays' }).albumName).toBe('Holidays');
  });
});

describe('inspectAppConfig', () => {
  const dir = path.resolve('/somewhere/.photo-pigeon');

  it('fills in every path the file leaves out, beside the config file itself', () => {
    const { config, problems } = inspectAppConfig({ watchDirs: [] }, { dir });
    expect(problems).toEqual([]);
    expect(config.credentialsPath).toBe(path.join(dir, 'credentials.json'));
    expect(config.tokenPath).toBe(path.join(dir, 'token.json'));
    expect(config.ledgerPath).toBe(path.join(dir, 'ledger.jsonl'));
    expect(config.extensions).toEqual([...DEFAULT_EXTENSIONS]);
  });

  it('expands a leading tilde, because people hand edit this file', () => {
    const { config, problems } = inspectAppConfig(
      { watchDirs: ['~/Pictures'], ledgerPath: '~/ledger.jsonl' },
      { dir, home: path.resolve('/home/casey') },
    );
    expect(problems).toEqual([]);
    expect(config.watchDirs[0]).toBe(path.resolve(path.join('/home/casey', 'Pictures')));
    expect(config.ledgerPath).toBe(path.resolve(path.join('/home/casey', 'ledger.jsonl')));
  });

  it('normalises and dedupes the extensions it was given', () => {
    const { config, problems } = inspectAppConfig(
      { watchDirs: ['p'], extensions: ['JPG', '.PNG', 'mp4', '.mp4'] },
      { dir },
    );
    expect(problems).toEqual([]);
    expect(config.extensions).toEqual(['.jpg', '.png', '.mp4']);
  });

  it('reports every problem at once, so a hand edit gets fixed in one pass', () => {
    const { problems } = inspectAppConfig(
      { watchDirs: [''], extensions: [42], dryRun: 'yes', albumName: 7 },
      { dir },
    );
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toContain('watchDirs[0]');
    expect(problems.join('\n')).toContain('extensions[0]');
    expect(problems.join('\n')).toContain('dryRun');
    expect(problems.join('\n')).toContain('albumName');
  });

  it('still hands back a usable config when the file was wrong', () => {
    const { config } = inspectAppConfig({ extensions: 'jpg' }, { dir });
    expect(config.extensions).toEqual([...DEFAULT_EXTENSIONS]);
  });

  it('refuses anything that is not a JSON object', () => {
    expect(inspectAppConfig('nope', { dir }).problems).toHaveLength(1);
    expect(inspectAppConfig(null, { dir }).problems).toHaveLength(1);
    expect(inspectAppConfig([1, 2], { dir }).problems).toHaveLength(1);
  });

  it('says so when the extension list would send nothing', () => {
    const { problems } = inspectAppConfig({ watchDirs: ['p'], extensions: [] }, { dir });
    expect(problems.join('\n')).toContain('nothing would ever be sent');
  });

  it('ignores keys it does not know, so an older build reads a newer file', () => {
    const { config, problems } = inspectAppConfig({ watchDirs: ['p'], futureSetting: true }, { dir });
    expect(problems).toEqual([]);
    expect('futureSetting' in config).toBe(false);
  });

  it('keeps the flags a file sets on purpose', () => {
    const { config } = inspectAppConfig(
      { watchDirs: ['p'], dryRun: true, pollFallback: true, albumName: '  Trip  ' },
      { dir },
    );
    expect(config.dryRun).toBe(true);
    expect(config.pollFallback).toBe(true);
    expect(config.albumName).toBe('Trip');
  });

  it('drops a blank album name instead of filing uploads into one called nothing', () => {
    expect(inspectAppConfig({ watchDirs: ['p'], albumName: '   ' }, { dir }).config.albumName).toBeUndefined();
  });
});

describe('expandHome and normalizeExtension', () => {
  it('expands the tilde only where it means the home directory', () => {
    expect(expandHome('~', '/home/casey')).toBe('/home/casey');
    expect(expandHome('~/Pictures', '/home/casey')).toBe(path.join('/home/casey', 'Pictures'));
    expect(expandHome('/already/absolute', '/home/casey')).toBe('/already/absolute');
    expect(expandHome('~notahome', '/home/casey')).toBe('~notahome');
  });

  it('takes an extension however it was typed', () => {
    expect(normalizeExtension('JPG')).toBe('.jpg');
    expect(normalizeExtension('  .HEIC ')).toBe('.heic');
    expect(normalizeExtension('.')).toBe('');
    expect(normalizeExtension('')).toBe('');
  });
});

describe('writeAppConfig and readAppConfig', () => {
  it('writes the config into the folder it makes, and reads it back unchanged', async () => {
    const paths = resolvePaths(home);
    const config: AppConfig = normalizeAppConfig({
      watchDirs: [home],
      credentialsPath: paths.credentialsPath,
      tokenPath: paths.tokenPath,
      ledgerPath: paths.ledgerPath,
      albumName: 'photo-pigeon',
    });

    await writeAppConfig(paths.configPath, config);
    expect(await readAppConfig(paths.configPath)).toEqual(config);
  });

  it('round trips through inspectAppConfig with nothing to complain about', async () => {
    const paths = resolvePaths(home);
    const written = normalizeAppConfig({
      watchDirs: [home],
      credentialsPath: paths.credentialsPath,
      tokenPath: paths.tokenPath,
      ledgerPath: paths.ledgerPath,
      albumName: 'photo-pigeon',
    });
    await writeAppConfig(paths.configPath, written);

    const readBack = await readAppConfig(paths.configPath);
    const { config, problems } = inspectAppConfig(readBack, { dir: paths.configDir });
    expect(problems).toEqual([]);
    expect(config).toEqual(written);
  });

  it('writes JSON a human can edit, ending in a newline', async () => {
    const paths = resolvePaths(home);
    await writeAppConfig(
      paths.configPath,
      normalizeAppConfig({
        watchDirs: [home],
        credentialsPath: paths.credentialsPath,
        tokenPath: paths.tokenPath,
        ledgerPath: paths.ledgerPath,
      }),
    );
    const raw = await fsp.readFile(paths.configPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').length).toBeGreaterThan(5);
  });

  it('leaves no temp file behind', async () => {
    const paths = resolvePaths(home);
    await writeAppConfig(
      paths.configPath,
      normalizeAppConfig({
        watchDirs: [home],
        credentialsPath: paths.credentialsPath,
        tokenPath: paths.tokenPath,
        ledgerPath: paths.ledgerPath,
      }),
    );
    const entries = await fsp.readdir(paths.configDir);
    expect(entries).toEqual(['config.json']);
  });

  it('replaces an earlier config rather than failing on it', async () => {
    const paths = resolvePaths(home);
    const first = normalizeAppConfig({
      watchDirs: [home],
      credentialsPath: paths.credentialsPath,
      tokenPath: paths.tokenPath,
      ledgerPath: paths.ledgerPath,
    });
    await writeAppConfig(paths.configPath, first);
    const second = { ...first, watchDirs: [path.join(home, 'again')] };
    await writeAppConfig(paths.configPath, second);
    expect((await readAppConfig(paths.configPath))?.watchDirs).toEqual([path.join(home, 'again')]);
  });

  it('returns nothing when there is no config yet', async () => {
    expect(await readAppConfig(resolvePaths(home).configPath)).toBeUndefined();
  });

  it('complains loudly about a config that exists but is broken', async () => {
    const paths = resolvePaths(home);
    await fsp.mkdir(paths.configDir, { recursive: true });
    await fsp.writeFile(paths.configPath, '{ this is not json', 'utf8');
    await expect(readAppConfig(paths.configPath)).rejects.toThrow(/not valid JSON/);
  });
});

describe('the setup record', () => {
  it('remembers the client id the setup was built on', async () => {
    const paths = resolvePaths(home);
    await writeSetupRecord(paths.setupPath, {
      clientId: 'abc.apps.googleusercontent.com',
      projectId: 'photo-pigeon-uploads',
      setupAt: '2026-07-28T09:00:00.000Z',
      publishConfirmedAt: '2026-07-28T08:58:00.000Z',
    });
    const record = await readSetupRecord(paths.setupPath);
    expect(record?.clientId).toBe('abc.apps.googleusercontent.com');
    expect(record?.publishConfirmedAt).toBe('2026-07-28T08:58:00.000Z');
  });

  it('returns nothing when there is no record', async () => {
    expect(await readSetupRecord(resolvePaths(home).setupPath)).toBeUndefined();
  });
});

describe('one config module', () => {
  /** Every .ts file under src, so the guard below cannot be walked around. */
  async function sourceFiles(): Promise<string[]> {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const names = await fsp.readdir(src, { recursive: true, withFileTypes: true });
    return names
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name));
  }

  it('leaves nothing importing the config module that was deleted', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await fsp.readFile(file, 'utf8');
      if (/from\s+'[^']*state\/(config|atomic)\.js'/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the extension defaults in one place, so no module hardcodes a second list', async () => {
    // Naming a couple of extensions in a doc comment or an error message is
    // fine. Naming a dozen is a list, and gphotos/mime.ts is the only file
    // allowed to hold one.
    const A_LIST = 8;
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (file.endsWith(`${path.sep}mime.ts`) || file.endsWith('.test.ts')) continue;
      const text = await fsp.readFile(file, 'utf8');
      const named = text.match(/'\.[a-z0-9]{2,5}'/g) ?? [];
      if (named.length >= A_LIST) offenders.push(`${file} names ${named.length} extensions`);
    }
    expect(offenders).toEqual([]);
  });
});
