/**
 * Credentials intake.
 *
 * Google shows an OAuth client secret exactly once now, at creation time, so we
 * never ask anyone to copy and paste it. The browser drops a
 * client_secret_*.json in Downloads, we notice it, and we copy it into
 * ~/.photo-pigeon/credentials.json. Typing a path by hand stays available for
 * anyone whose browser saves somewhere unusual.
 *
 * This repo ships zero credentials. Everything here reads the user's own file.
 */

import path from 'node:path';
import chokidar from 'chokidar';
import { type FsLike, nodeFs } from './fs-like.js';

/** Google's own download name is client_secret_<id>.apps.googleusercontent.com.json, plus browser suffixes like " (1)". */
const CLIENT_SECRET_RE = /^client_secret.*\.json$/i;

/** True when a file name looks like a downloaded Google client secret. */
export function isClientSecretFileName(name: string): boolean {
  return CLIENT_SECRET_RE.test(name);
}

/** A client_secret JSON sitting in a Downloads folder. */
export interface ClientSecretCandidate {
  /** Absolute path to the file. */
  path: string;
  /** Modified time, epoch milliseconds: newest wins when there are several. */
  mtimeMs: number;
}

/**
 * Looks through the given folders for client_secret_*.json files that are
 * already there, newest first. Folders that do not exist are skipped quietly:
 * a machine without a OneDrive Downloads is not an error.
 */
export async function scanForClientSecrets(
  dirs: string[],
  fs: FsLike = nodeFs,
): Promise<ClientSecretCandidate[]> {
  const found: ClientSecretCandidate[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!isClientSecretFileName(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile()) continue;
        found.push({ path: full, mtimeMs: stat.mtimeMs });
      } catch {
        // A file that vanished between readdir and stat is not our problem.
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The most recently modified candidate, or undefined when there are none. */
export function newestCandidate(
  candidates: ClientSecretCandidate[],
): ClientSecretCandidate | undefined {
  let best: ClientSecretCandidate | undefined;
  for (const candidate of candidates) {
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  return best;
}

/** Which kind of OAuth client the JSON describes. Desktop clients use the "installed" key. */
export type ClientType = 'installed' | 'web';

/** The parts of a Google client JSON that matter to us. */
export interface ParsedClientCredentials {
  /** "installed" for a Desktop app client, which is the only type that works here. */
  clientType: ClientType;
  /** The OAuth client id. Also the lock: content uploaded under it is only ever visible to it. */
  clientId: string;
  /** The client secret. Desktop clients have one and it is not really secret, but we still keep the file to 0600. */
  clientSecret: string;
  /** Cloud project id, when the JSON carries it. Used to deep link doctor's output. */
  projectId?: string;
  /** Redirect URIs declared for the client, usually http://localhost for Desktop. */
  redirectUris: string[];
}

/** A credentials file we could not use, with a message written for a human. */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Parses the JSON Google hands out. Throws CredentialsError with a plain
 * explanation when the file is something else, which mostly means the user
 * grabbed the wrong download.
 */
export function parseClientCredentials(raw: string): ParsedClientCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialsError('That file is not JSON, so it is not the client file Google made.');
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new CredentialsError('That JSON is not shaped like a Google client file.');
  }

  const installed = asRecord(root.installed);
  const web = asRecord(root.web);
  const section = installed ?? web;
  const clientType: ClientType = installed ? 'installed' : 'web';

  if (!section) {
    throw new CredentialsError(
      'That JSON has no installed or web section, so it is not an OAuth client file. Download the JSON from the client you just created.',
    );
  }

  const clientId = typeof section.client_id === 'string' ? section.client_id : '';
  const clientSecret = typeof section.client_secret === 'string' ? section.client_secret : '';
  if (!clientId) {
    throw new CredentialsError('That client file has no client_id in it.');
  }
  if (!clientSecret) {
    throw new CredentialsError(
      'That client file has no client_secret in it. Google only offers the secret at the moment the client is created, so create a fresh client and download that JSON.',
    );
  }

  const projectId = typeof section.project_id === 'string' ? section.project_id : undefined;
  return {
    clientType,
    clientId,
    clientSecret,
    projectId,
    redirectUris: asStringArray(section.redirect_uris),
  };
}

/** Reads and parses a client JSON from disk. */
export async function readClientCredentials(
  file: string,
  fs: FsLike = nodeFs,
): Promise<ParsedClientCredentials> {
  let raw: string;
  try {
    raw = await fs.readFile(file);
  } catch {
    throw new CredentialsError(`No file at ${file}`);
  }
  return parseClientCredentials(raw);
}

/**
 * Copies a client JSON into ~/.photo-pigeon/credentials.json and returns what it
 * contained. The copy is written through a temp file so a half written
 * credentials.json can never exist, and at mode 0600 where the platform cares.
 *
 * The source file is left exactly where it was. Nothing in photo-pigeon deletes
 * anything.
 */
export async function installCredentials(
  sourcePath: string,
  destPath: string,
  fs: FsLike = nodeFs,
): Promise<ParsedClientCredentials> {
  let raw: string;
  try {
    raw = await fs.readFile(sourcePath);
  } catch {
    throw new CredentialsError(`No file at ${sourcePath}`);
  }
  const parsed = parseClientCredentials(raw);
  if (parsed.clientType === 'web') {
    throw new CredentialsError(
      'That is a Web application client. photo-pigeon signs in through a loopback address on your own machine, which needs a Desktop app client. Create a new client and pick Desktop app as the type.',
    );
  }

  await fs.mkdir(path.dirname(destPath));
  const temp = `${destPath}.tmp`;
  await fs.writeFile(temp, raw, 0o600);
  await fs.rename(temp, destPath);
  return parsed;
}

/** Raised when waiting for a download is called off. */
export class WatchAbortedError extends Error {
  constructor() {
    super('Stopped watching for the credentials download.');
    this.name = 'WatchAbortedError';
  }
}

/**
 * Watches the given folders and resolves with the first client_secret_*.json
 * that lands and settles. Event driven, no directory polling: chokidar rides
 * the native file system events, and awaitWriteFinish keeps us from grabbing a
 * browser's half written file.
 *
 * Rejects with WatchAbortedError when the signal fires, which is how the caller
 * cancels once the user typed a path instead.
 */
export function watchForClientSecret(dirs: string[], signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new WatchAbortedError());
      return;
    }

    let settled = false;
    const watcher =
      dirs.length > 0
        ? chokidar.watch(dirs, {
            depth: 0,
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
          })
        : undefined;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      void watcher?.close().catch(() => undefined);
      action();
    };

    function onAbort(): void {
      finish(() => reject(new WatchAbortedError()));
    }

    signal.addEventListener('abort', onAbort, { once: true });

    watcher?.on('add', (added: string) => {
      if (isClientSecretFileName(path.basename(added))) {
        finish(() => resolve(added));
      }
    });
    // A Downloads folder that disappears mid wizard must not take the wizard with it.
    watcher?.on('error', () => undefined);
  });
}
