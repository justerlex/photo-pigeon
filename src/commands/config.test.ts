/**
 * The read side of the one config module.
 *
 * Every test here points at a temp folder through an explicit path. Nothing in
 * this file may read or write the real ~/.photo-pigeon: there is a live
 * photo-pigeon watching real folders on this machine.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALL_SUPPORTED_EXTENSIONS } from '../gphotos/mime.js';
import { normalizeAppConfig, writeAppConfig } from '../wizard/config.js';
import { pathsIn } from '../wizard/paths.js';
import { defaultConfigPath, readConfigFile, resolveConfigPath, validateConfig } from './config.js';
import { CommandError, EXIT } from './errors.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-pigeon-cmd-config-'));
  configPath = path.join(dir, 'config.json');
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** Writes a config file by hand, the way a person with an editor would. */
async function writeRaw(value: unknown): Promise<void> {
  await fsp.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('resolveConfigPath', () => {
  it('honours an explicit path and makes it absolute', async () => {
    expect(await resolveConfigPath(configPath)).toBe(path.resolve(configPath));
    expect(await resolveConfigPath('  ')).toBe(await defaultConfigPath());
  });

  it('falls back to the file the wizard writes', async () => {
    const fallback = await defaultConfigPath();
    expect(fallback.endsWith(path.join('.photo-pigeon', 'config.json'))).toBe(true);
  });
});

describe('the config the wizard wrote, read back by a command', () => {
  it('round trips: what setup writes is exactly what watch reads', async () => {
    const paths = pathsIn(dir);
    const written = normalizeAppConfig({
      watchDirs: [path.join(dir, 'Pictures')],
      credentialsPath: paths.credentialsPath,
      tokenPath: paths.tokenPath,
      ledgerPath: paths.ledgerPath,
      albumName: 'photo-pigeon',
    });
    await writeAppConfig(paths.configPath, written);

    expect(await readConfigFile(paths.configPath)).toEqual(written);
  });

  it('takes the extension defaults from gphotos/mime.ts when the file names none', async () => {
    await writeRaw({ watchDirs: [path.join(dir, 'Pictures')] });
    const config = await readConfigFile(configPath);
    expect(config.extensions).toEqual([...ALL_SUPPORTED_EXTENSIONS]);
  });

  it('hangs the paths it was not given off the folder the config sits in', async () => {
    await writeRaw({ watchDirs: [path.join(dir, 'Pictures')] });
    const config = await readConfigFile(configPath);
    expect(config.credentialsPath).toBe(path.join(dir, 'credentials.json'));
    expect(config.tokenPath).toBe(path.join(dir, 'token.json'));
    expect(config.ledgerPath).toBe(path.join(dir, 'ledger.jsonl'));
  });

  it('takes a hand edited extension however it was typed', async () => {
    await writeRaw({ watchDirs: [path.join(dir, 'Pictures')], extensions: ['JPG', ' .HEIC'] });
    expect((await readConfigFile(configPath)).extensions).toEqual(['.jpg', '.heic']);
  });
});

describe('when the config cannot be used', () => {
  it('says where the missing file should have been', async () => {
    await expect(readConfigFile(configPath)).rejects.toMatchObject({
      name: 'CommandError',
      code: EXIT.NOT_CONFIGURED,
    });
    await expect(readConfigFile(configPath)).rejects.toThrow(/No photo-pigeon config at/);
  });

  it('sends a broken file to an editor rather than printing a stack', async () => {
    await fsp.writeFile(configPath, '{ not json at all', 'utf8');
    await expect(readConfigFile(configPath)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a config with nothing to watch, and says what to add', async () => {
    await writeRaw({ watchDirs: [] });
    await expect(readConfigFile(configPath)).rejects.toThrow(/nothing to watch/);
    try {
      await readConfigFile(configPath);
      expect.unreachable('a config with no watchDirs should not be usable');
    } catch (error) {
      expect((error as CommandError).hint).toContain('watchDirs');
    }
  });

  it('lists every problem at once instead of one per run', () => {
    try {
      validateConfig({ watchDirs: [''], extensions: [42], dryRun: 'yes' }, configPath);
      expect.unreachable('a config this broken should not be usable');
    } catch (error) {
      const message = (error as CommandError).message;
      expect(message).toContain('watchDirs[0]');
      expect(message).toContain('extensions[0]');
      expect(message).toContain('dryRun');
      expect((error as CommandError).code).toBe(EXIT.NOT_CONFIGURED);
    }
  });

  it('refuses a file that is not an object at all', () => {
    expect(() => validateConfig('nope', configPath)).toThrow(CommandError);
    expect(() => validateConfig(['a', 'list'], configPath)).toThrow(/JSON object/);
  });
});
