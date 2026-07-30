/**
 * Where photo-pigeon keeps its things, and where a browser drops a downloaded
 * client secret. Everything here is pure so it can be tested without touching
 * the real home directory.
 */

import os from 'node:os';
import path from 'node:path';

/** Folder under the user's home that holds config, credentials, token and ledger. */
export const CONFIG_DIR_NAME = '.photo-pigeon';

/**
 * The file names inside that folder, in one place, so no module ever has a
 * second opinion about what the ledger or the token is called.
 */
export const STATE_FILE_NAMES = {
  /** The AppConfig. */
  config: 'config.json',
  /** The user's own OAuth client JSON. */
  credentials: 'credentials.json',
  /** The refresh token. */
  token: 'token.json',
  // .jsonl, not .json: the ledger is one JSON object per line and the extension
  // should say so.
  ledger: 'ledger.jsonl',
  /** Wizard bookkeeping. */
  setup: 'setup.json',
} as const;

/** Every file photo-pigeon owns on disk. */
export interface PigeonPaths {
  /** ~/.photo-pigeon */
  configDir: string;
  /** The AppConfig, as JSON. */
  configPath: string;
  /** The user's own OAuth client JSON, copied here from Downloads. */
  credentialsPath: string;
  /** The refresh token, written by the auth module, never by the wizard. */
  tokenPath: string;
  /** The sha256 ledger: the durable record of everything delivered. One JSON object per line. */
  ledgerPath: string;
  /** Wizard bookkeeping: which client id this setup was built on, so doctor can spot a regenerated one. */
  setupPath: string;
}

/**
 * Every photo-pigeon file that belongs beside a config file in the given folder.
 *
 * This is what a hand edited config falls back to when it names some paths and
 * leaves others out: whatever folder the config file itself sits in.
 */
export function pathsIn(configDir: string): PigeonPaths {
  return {
    configDir,
    configPath: path.join(configDir, STATE_FILE_NAMES.config),
    credentialsPath: path.join(configDir, STATE_FILE_NAMES.credentials),
    tokenPath: path.join(configDir, STATE_FILE_NAMES.token),
    ledgerPath: path.join(configDir, STATE_FILE_NAMES.ledger),
    setupPath: path.join(configDir, STATE_FILE_NAMES.setup),
  };
}

/** Resolves every photo-pigeon path under the given home directory. */
export function resolvePaths(homeDir: string = os.homedir()): PigeonPaths {
  return pathsIn(path.join(homeDir, CONFIG_DIR_NAME));
}

/** Inputs for working out where downloads land, injectable so tests stay off the real machine. */
export interface DownloadsLookup {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

/**
 * Candidate Downloads folders, most likely first.
 *
 * Windows makes this less obvious than it sounds: OneDrive Known Folder Move
 * relocates Downloads under the OneDrive root, and some machines have both.
 * We hand back every plausible folder and let the caller watch the ones that
 * actually exist. PHOTO_PIGEON_DOWNLOADS overrides the lot.
 */
export function downloadsCandidates(lookup: DownloadsLookup = {}): string[] {
  const env = lookup.env ?? process.env;
  const homeDir = lookup.homeDir ?? os.homedir();
  const platform = lookup.platform ?? process.platform;

  const override = env.PHOTO_PIGEON_DOWNLOADS?.trim();
  if (override) return [path.resolve(override)];

  const candidates: string[] = [];
  const push = (dir: string | undefined): void => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  push(path.join(homeDir, 'Downloads'));
  if (platform === 'win32') {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) push(path.join(userProfile, 'Downloads'));
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const root = env[key]?.trim();
      if (root) push(path.join(root, 'Downloads'));
    }
  }
  return candidates;
}
