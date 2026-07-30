import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DIR_NAME, downloadsCandidates, resolvePaths } from './paths.js';

const HOME = path.join(path.sep === '\\' ? 'C:\\Users\\tester' : '/home/tester');

describe('resolvePaths', () => {
  it('keeps everything under one folder in the home directory', () => {
    const paths = resolvePaths(HOME);
    expect(paths.configDir).toBe(path.join(HOME, CONFIG_DIR_NAME));
    expect(paths.configPath).toBe(path.join(HOME, CONFIG_DIR_NAME, 'config.json'));
    expect(paths.credentialsPath).toBe(path.join(HOME, CONFIG_DIR_NAME, 'credentials.json'));
    expect(paths.tokenPath).toBe(path.join(HOME, CONFIG_DIR_NAME, 'token.json'));
    expect(paths.ledgerPath).toBe(path.join(HOME, CONFIG_DIR_NAME, 'ledger.jsonl'));
    expect(paths.setupPath).toBe(path.join(HOME, CONFIG_DIR_NAME, 'setup.json'));
  });
});

describe('downloadsCandidates', () => {
  it('uses the home Downloads folder by default', () => {
    const dirs = downloadsCandidates({ env: {}, homeDir: HOME, platform: 'linux' });
    expect(dirs).toEqual([path.resolve(path.join(HOME, 'Downloads'))]);
  });

  it('includes the OneDrive Downloads folder on Windows, since Known Folder Move relocates it', () => {
    const dirs = downloadsCandidates({
      env: { USERPROFILE: HOME, OneDrive: path.join(HOME, 'OneDrive') },
      homeDir: HOME,
      platform: 'win32',
    });
    expect(dirs).toContain(path.resolve(path.join(HOME, 'Downloads')));
    expect(dirs).toContain(path.resolve(path.join(HOME, 'OneDrive', 'Downloads')));
  });

  it('does not repeat a folder when USERPROFILE and the home directory agree', () => {
    const dirs = downloadsCandidates({
      env: { USERPROFILE: HOME },
      homeDir: HOME,
      platform: 'win32',
    });
    expect(dirs).toHaveLength(1);
  });

  it('honours the override and ignores everything else', () => {
    const override = path.join(HOME, 'elsewhere');
    const dirs = downloadsCandidates({
      env: { PHOTO_PIGEON_DOWNLOADS: override, OneDrive: path.join(HOME, 'OneDrive') },
      homeDir: HOME,
      platform: 'win32',
    });
    expect(dirs).toEqual([path.resolve(override)]);
  });
});
