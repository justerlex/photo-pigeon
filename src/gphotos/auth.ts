/**
 * Bring your own OAuth client.
 *
 * This repo ships zero credentials. Not a client id, not a secret, not an
 * encoded one, not a hosted broker. Each user creates a free Cloud project,
 * downloads their own client_secret_*.json, and gets their own private 10,000
 * requests a day. That is the whole reason the tool can exist without Google
 * verification and without a quota shared with strangers.
 *
 * Consequences encoded here:
 *  - The only scope ever requested is photoslibrary.appendonly. Reading or
 *    deleting the user's library is impossible by construction, not by policy.
 *  - The redirect is a loopback address on 127.0.0.1 with an ephemeral port.
 *    Out of band codes are dead and the device flow has no Photos scopes.
 *  - Loopback redirects are the one OAuth surface any other program on the
 *    machine can race for, so the exchange is bound with PKCE (S256). Without
 *    it a local eavesdropper who caught the callback could spend the code.
 *  - invalid_grant on a young token has exactly one likely cause: the consent
 *    screen is still in Testing, where refresh tokens die after seven days.
 *    The fix is one click, so the tool names it instead of printing a stack.
 *  - Content is visible only to the client id that uploaded it, forever. A
 *    regenerated client orphans the history, so a changed client id is a loud
 *    warning, never a silent re-auth.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Credentials } from 'google-auth-library';

import { OAUTH_SCOPES } from '../contracts.js';
import { type Logger, consoleLogger } from './log.js';

/** Refresh tokens minted while the consent screen is in Testing die after seven days. */
export const TESTING_MODE_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** A little slack on top of seven days, so the diagnosis still fires on day eight. */
export const YOUNG_TOKEN_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

/** How long the loopback server waits for the user to finish consenting. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;

/** The user's own OAuth client, as read from the file Google gave them. */
export interface ClientSecret {
  clientId: string;
  clientSecret: string;
  /** Present in desktop client downloads. Powers the console deep links. */
  projectId?: string;
  /** Which key the file used. Desktop clients are "installed", the other is "web". */
  shape: 'installed' | 'web';
}

/** What lands in tokenPath. Deliberately readable: users need to be able to move it. */
export interface StoredToken {
  /** The client id that minted this token. A different one means orphaned history. */
  clientId: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  scope?: string;
  tokenType?: string;
  /** ISO timestamp of the consent that produced this refresh token. */
  obtainedAt: string;
}

/** Anything wrong with credentials, consent, or refresh, phrased for a human. */
export class AuthError extends Error {
  readonly advice?: string;

  constructor(message: string, advice?: string) {
    super(advice ? `${message}\n\n${advice}` : message);
    this.name = 'AuthError';
    this.advice = advice;
  }
}

/** The bit of the world that knows who the user is. */
export interface Authorizer {
  /** Refresh, or run the consent flow, and resolve once a usable token exists. */
  ensureAuth(): Promise<void>;
  /** A bearer token. Pass true to discard the cached one and force a refresh. */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
  /** The active client id, for warnings and for the album cache key. */
  clientId(): Promise<string>;
  /** The Cloud project id when the credentials file carried one. */
  projectId(): Promise<string | undefined>;
  /** Age of the stored refresh token in milliseconds, if there is one. */
  tokenAgeMs(): number | undefined;
}

/** Wiring for the authorizer. Tests replace the browser and the clock. */
export interface AuthOptions {
  credentialsPath: string;
  tokenPath: string;
  scopes?: readonly string[];
  /** Opens the consent URL. Defaults to the system browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** False on headless boxes: fail with instructions instead of opening a browser. */
  interactive?: boolean;
  now?: () => number;
  logger?: Logger;
  /** Abandon a consent wait that is no longer wanted. See `runConsentFlow`. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Credential file
// ---------------------------------------------------------------------------

interface RawSecretBody {
  client_id?: string;
  client_secret?: string;
  project_id?: string;
  redirect_uris?: string[];
}

interface RawSecretFile {
  installed?: RawSecretBody;
  web?: RawSecretBody;
  type?: string;
}

/**
 * Reads client_secret_*.json in either shape Google hands out. Desktop clients
 * arrive under "installed", the web ones under "web", and both work with a
 * loopback redirect.
 */
export async function loadClientSecret(credentialsPath: string): Promise<ClientSecret> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath, 'utf8');
  } catch {
    throw new AuthError(
      `No OAuth client file at ${credentialsPath}.`,
      [
        'photo-pigeon ships no credentials of its own, on purpose: your own client gives you',
        'your own private daily quota and needs no Google verification.',
        'Run `photo-pigeon setup` and the wizard will walk you through creating one.',
      ].join('\n'),
    );
  }

  let parsed: RawSecretFile;
  try {
    parsed = JSON.parse(raw) as RawSecretFile;
  } catch {
    throw new AuthError(
      `The OAuth client file at ${credentialsPath} is not valid JSON.`,
      'Download it again from the Google Cloud console and keep the file exactly as it arrives.',
    );
  }

  if (parsed.type === 'service_account') {
    throw new AuthError(
      'That file is a service account key, not an OAuth client.',
      [
        'Google Photos does not accept service accounts: a person has to consent to their own library.',
        'In the console, create an OAuth client of type Desktop app and download that file instead.',
      ].join('\n'),
    );
  }

  const shape: 'installed' | 'web' = parsed.installed ? 'installed' : 'web';
  const body = parsed.installed ?? parsed.web;

  if (!body?.client_id || !body?.client_secret) {
    throw new AuthError(
      `The file at ${credentialsPath} has no client id and secret under "installed" or "web".`,
      'Use the JSON that the Download button on the OAuth client page produces, unedited.',
    );
  }

  return {
    clientId: body.client_id,
    clientSecret: body.client_secret,
    projectId: body.project_id,
    shape,
  };
}

// ---------------------------------------------------------------------------
// Token file
// ---------------------------------------------------------------------------

/** Reads the stored token, or undefined when there is none yet. */
export async function readStoredToken(tokenPath: string): Promise<StoredToken | undefined> {
  try {
    const raw = await readFile(tokenPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredToken>;
    if (!parsed.refreshToken || !parsed.clientId) return undefined;
    return {
      clientId: parsed.clientId,
      refreshToken: parsed.refreshToken,
      accessToken: parsed.accessToken,
      expiryDate: parsed.expiryDate,
      scope: parsed.scope,
      tokenType: parsed.tokenType,
      obtainedAt: parsed.obtainedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

/** Writes the token file, owner readable only, creating the folder if needed. */
export async function writeStoredToken(tokenPath: string, token: StoredToken): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// The messages that earn the tool its keep
// ---------------------------------------------------------------------------

/** Deep link to the page where the Publish app button lives. */
export function audienceConsoleUrl(projectId?: string): string {
  return projectId
    ? `https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(projectId)}`
    : 'https://console.cloud.google.com/auth/audience';
}

/**
 * The single most valuable paragraph in this package.
 *
 * A refresh token that dies within a week is not a bug in the tool and not a
 * revoked grant: it is the consent screen sitting in Testing mode. Every other
 * project in this space makes users find that out on a forum.
 */
export function invalidGrantAdvice(input: {
  tokenAgeMs?: number;
  projectId?: string;
  originalMessage?: string;
}): string {
  const link = audienceConsoleUrl(input.projectId);
  const young = input.tokenAgeMs !== undefined && input.tokenAgeMs < YOUNG_TOKEN_WINDOW_MS;

  if (young) {
    const days = Math.max(1, Math.round(input.tokenAgeMs! / (24 * 60 * 60 * 1000)));
    return [
      `Google rejected the saved login (invalid_grant) and that login is only about ${days} day(s) old.`,
      'That combination has one overwhelmingly likely cause: your consent screen is still in Testing mode,',
      'and Google expires refresh tokens from Testing apps after seven days.',
      '',
      'The fix is one click:',
      `  1. Open ${link}`,
      '  2. Press "Publish app" and confirm.',
      '  3. Run `photo-pigeon login` once more.',
      '',
      'You do not need Google verification for this. An unverified published app works forever for its own owner,',
      'and you will see the "Google hasn\'t verified this app" screen once, which is expected here.',
    ].join('\n');
  }

  return [
    'Google rejected the saved login (invalid_grant).',
    'Usual causes: access was removed at myaccount.google.com/permissions, the password changed,',
    'or the OAuth client was deleted after six months of no use.',
    '',
    'Run `photo-pigeon login` to sign in again. Nothing already uploaded is affected,',
    'and the local ledger means nothing will be sent twice.',
  ].join('\n');
}

/** Said out loud when the token on disk belongs to a different client id. */
export function clientIdChangeWarning(oldClientId: string, newClientId: string): string {
  return [
    'This OAuth client is not the one that uploaded before.',
    `  was: ${oldClientId}`,
    `  now: ${newClientId}`,
    'Google shows app created content only to the client id that created it, forever.',
    'Photos already in your library stay there and stay yours, but this client cannot see or confirm them.',
    'The local ledger is now the only record of what was delivered, and it is still honoured,',
    'so nothing it knows about will be uploaded twice.',
  ].join('\n');
}

/** Printed when a token is needed on a machine with no browser. */
export function headlessAdvice(tokenPath: string): string {
  return [
    'photo-pigeon needs to sign in, but this run is not interactive and Google only accepts a loopback redirect.',
    'Sign in on a desktop machine with the same client_secret json, then copy the token file across:',
    `  ${tokenPath}`,
    'The token belongs to the client id, not to the machine, so it works once it lands here.',
  ].join('\n');
}

function isInvalidGrant(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${JSON.stringify((error as { response?: { data?: unknown } }).response?.data ?? '')}`
      : String(error);
  return text.includes('invalid_grant');
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** A PKCE pair: the secret that stays in this process and the digest Google sees. */
export interface PkcePair {
  /** Never leaves the machine except on the token exchange, over TLS to Google. */
  codeVerifier: string;
  /** base64url(sha256(codeVerifier)). Safe to put in a URL the browser carries. */
  codeChallenge: string;
}

/**
 * Proof Key for Code Exchange, RFC 7636, S256.
 *
 * The authorisation code comes back over plain http on 127.0.0.1, because that
 * is the only redirect style Google still allows a desktop app. Anything else
 * running as this user can listen on loopback and, in the worst case, get to a
 * code first. PKCE makes a stolen code worthless: the exchange only succeeds if
 * it also carries the verifier, and the verifier never crosses the loopback hop.
 *
 * The verifier is generated here rather than by the auth library so the shape is
 * visible and testable: 32 random bytes, base64url encoded, which is 43
 * characters, exactly the RFC minimum, and every character is already in the
 * unreserved set the spec allows.
 */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url');
  // base64url output is pure ASCII, so the default utf8 read of it is the same
  // byte sequence the RFC asks to be hashed.
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// The loopback consent flow
// ---------------------------------------------------------------------------

const CONSENT_PAGE_OK = `<!doctype html><meta charset="utf-8"><title>photo-pigeon</title>
<body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:18vh auto;padding:0 1.5rem;color:#222">
<h1 style="font-size:1.4rem">The pigeon is authorised.</h1>
<p>You can close this tab and go back to the terminal. Nothing here was sent anywhere except to Google.</p>
</body>`;

const CONSENT_PAGE_FAIL = `<!doctype html><meta charset="utf-8"><title>photo-pigeon</title>
<body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:18vh auto;padding:0 1.5rem;color:#222">
<h1 style="font-size:1.4rem">That did not complete.</h1>
<p>Close this tab and check the terminal for what to try next.</p>
</body>`;

/**
 * Spins up a one shot http listener on 127.0.0.1, opens the consent page, and
 * resolves with the credentials Google returns. The port is ephemeral, which is
 * why the OAuth client must be a Desktop app: Google allows any loopback port
 * for those, so nothing has to be registered in advance.
 *
 * Two things bind the callback to this request. The state parameter proves the
 * response belongs to the request we made. PKCE proves the exchange is being
 * done by the process that started it. State alone is a check we run on
 * ourselves; PKCE is a check Google runs on us, which is the one that matters
 * when the code has already leaked.
 */
export async function runConsentFlow(
  secret: ClientSecret,
  scopes: readonly string[],
  options: {
    openBrowser: (url: string) => Promise<void>;
    logger: Logger;
    timeoutMs?: number;
    /**
     * Give up waiting, because the run was cancelled.
     *
     * The consent wait is the one place setup can sit for five minutes with
     * nothing to do, and it holds a loopback listener open the whole time. On a
     * machine channel the parent's cancel is stdin closing, and without this
     * the wait ignores it: the run had no pending question to fail, so nothing
     * observed the cancel and the listener kept the event loop alive until the
     * timeout. A window closed mid sign-in left a process behind.
     */
    signal?: AbortSignal;
  },
): Promise<Credentials> {
  const state = randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = createPkcePair();
  const server = createServer();

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new OAuth2Client({
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    redirectUri,
  });

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...scopes],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  const code = await new Promise<string>((resolve, reject) => {
    let done = false;

    const finish = (error?: Error, value?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // Always close the listener. A stray port open on 127.0.0.1 after a
      // failed login is both a leak and a small piece of attack surface.
      server.close();
      if (error) reject(error);
      else resolve(value as string);
    };

    // Nothing was saved, which is worth saying: the token is only written after
    // Google hands back a code, so a cancelled consent leaves no credential and
    // no half-signed-in state behind.
    function onAbort(): void {
      finish(new AuthError('The sign in was cancelled before Google answered. Nothing was saved.'));
    }

    // The timer exists before anything can call `finish`: an already-aborted
    // signal runs `onAbort` synchronously below, and `finish` clears the
    // timer, so declaring it later is a ReferenceError on exactly the path a
    // window takes when it closes between the last answer and this wait.
    const timer = setTimeout(() => {
      finish(
        new AuthError(
          'Timed out waiting for the Google consent screen.',
          'Run the command again when you have the browser in front of you.',
        ),
      );
    }, options.timeoutMs ?? CONSENT_TIMEOUT_MS);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/favicon.ico') {
        res.writeHead(404).end();
        return;
      }

      const returnedState = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');
      const codeParam = url.searchParams.get('code');

      if (returnedState !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(CONSENT_PAGE_FAIL);
        finish(new AuthError('The consent response did not match this request. Nothing was saved.'));
        return;
      }

      if (errorParam) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(CONSENT_PAGE_FAIL);
        finish(
          new AuthError(
            `Google returned "${errorParam}" instead of an authorisation code.`,
            errorParam === 'access_denied'
              ? 'The consent screen was declined. photo-pigeon can only add photos, it can never read or delete your library.'
              : undefined,
          ),
        );
        return;
      }

      if (!codeParam) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(CONSENT_PAGE_FAIL);
        finish(new AuthError('Google redirected back without an authorisation code.'));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CONSENT_PAGE_OK);
      finish(undefined, codeParam);
    });

    options.logger.info('Opening the Google consent screen in your browser.');
    options.logger.info(`If nothing opens, paste this into any browser:\n  ${authUrl}`);
    void options.openBrowser(authUrl).catch(() => {
      options.logger.warn('Could not launch a browser automatically. Use the link above.');
    });
  });

  // The verifier travels only here, in the POST body to Google over TLS. It was
  // never in the browser, never in a query string, never on the loopback hop.
  const { tokens } = await client.getToken({ code, codeVerifier });

  if (!tokens.refresh_token) {
    throw new AuthError(
      'Google returned an access token but no refresh token, so the login would not survive an hour.',
      [
        'Remove photo-pigeon at https://myaccount.google.com/permissions and run `photo-pigeon login` again.',
        'The next consent will include the refresh token.',
      ].join('\n'),
    );
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// The authorizer
// ---------------------------------------------------------------------------

async function defaultOpenBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}

/** Builds the authorizer. Nothing touches the network until ensureAuth or getAccessToken. */
export function createAuthorizer(options: AuthOptions): Authorizer {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? consoleLogger;
  const scopes = options.scopes ?? OAUTH_SCOPES;
  const interactive = options.interactive ?? true;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;

  let secret: ClientSecret | undefined;
  let client: OAuth2Client | undefined;
  let stored: StoredToken | undefined;
  let ready: Promise<void> | undefined;

  async function getSecret(): Promise<ClientSecret> {
    secret ??= await loadClientSecret(options.credentialsPath);
    return secret;
  }

  function buildClient(withSecret: ClientSecret, token: StoredToken): OAuth2Client {
    const built = new OAuth2Client({
      clientId: withSecret.clientId,
      clientSecret: withSecret.clientSecret,
    });
    built.setCredentials({
      refresh_token: token.refreshToken,
      access_token: token.accessToken,
      expiry_date: token.expiryDate,
      scope: token.scope,
      token_type: token.tokenType,
    });

    // google-auth-library emits this whenever it mints something new. Persisting
    // keeps the file honest across restarts without an extra round trip.
    built.on('tokens', (fresh: Credentials) => {
      const next: StoredToken = {
        clientId: withSecret.clientId,
        refreshToken: fresh.refresh_token ?? token.refreshToken,
        accessToken: fresh.access_token ?? undefined,
        expiryDate: fresh.expiry_date ?? undefined,
        scope: fresh.scope ?? token.scope,
        tokenType: fresh.token_type ?? token.tokenType,
        obtainedAt: fresh.refresh_token ? new Date(now()).toISOString() : token.obtainedAt,
      };
      stored = next;
      void writeStoredToken(options.tokenPath, next).catch((error: unknown) => {
        logger.warn(`Could not save the refreshed Google token: ${String(error)}`);
      });
    });

    return built;
  }

  async function authorize(): Promise<void> {
    const withSecret = await getSecret();
    const existing = await readStoredToken(options.tokenPath);

    if (existing && existing.clientId !== withSecret.clientId) {
      logger.warn(clientIdChangeWarning(existing.clientId, withSecret.clientId));
    }

    const usable =
      existing &&
      existing.clientId === withSecret.clientId &&
      (!existing.scope || existing.scope.includes('photoslibrary.appendonly'))
        ? existing
        : undefined;

    if (usable) {
      stored = usable;
      client = buildClient(withSecret, usable);
      try {
        await refreshAccessToken(false);
        return;
      } catch (error) {
        if (!isInvalidGrant(error)) throw error;
        logger.warn(
          invalidGrantAdvice({
            tokenAgeMs: tokenAge(usable),
            projectId: withSecret.projectId,
          }),
        );
        client = undefined;
        stored = undefined;
      }
    }

    if (!interactive) {
      throw new AuthError('No usable Google login on this machine.', headlessAdvice(options.tokenPath));
    }

    logger.info(
      'photo-pigeon is asking Google for permission to ADD photos only. It cannot read or delete anything in your library.',
    );

    const credentials = await runConsentFlow(withSecret, scopes, {
      openBrowser,
      logger,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const token: StoredToken = {
      clientId: withSecret.clientId,
      refreshToken: credentials.refresh_token as string,
      accessToken: credentials.access_token ?? undefined,
      expiryDate: credentials.expiry_date ?? undefined,
      scope: credentials.scope ?? scopes.join(' '),
      tokenType: credentials.token_type ?? undefined,
      obtainedAt: new Date(now()).toISOString(),
    };

    await writeStoredToken(options.tokenPath, token);
    stored = token;
    client = buildClient(withSecret, token);
    logger.info(`Signed in. The token lives at ${options.tokenPath} and is readable only by you.`);
  }

  function tokenAge(token: StoredToken | undefined): number | undefined {
    if (!token) return undefined;
    const at = Date.parse(token.obtainedAt);
    if (Number.isNaN(at) || at === 0) return undefined;
    return Math.max(0, now() - at);
  }

  async function refreshAccessToken(force: boolean): Promise<string> {
    if (!client) throw new AuthError('Not signed in yet.');
    if (force && client.credentials) {
      // Marking the cached token expired is how you make the library go get a
      // new one without reaching for the deprecated refresh call.
      client.setCredentials({ ...client.credentials, expiry_date: 1 });
    }
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new AuthError('Google returned an empty access token.');
      return token;
    } catch (error) {
      if (isInvalidGrant(error)) {
        const withSecret = await getSecret();
        throw new AuthError(
          'Google rejected the saved login.',
          invalidGrantAdvice({
            tokenAgeMs: tokenAge(stored),
            projectId: withSecret.projectId,
          }),
        );
      }
      throw error;
    }
  }

  return {
    async ensureAuth(): Promise<void> {
      ready ??= authorize().catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
      await ready;
    },

    async getAccessToken(forceRefresh = false): Promise<string> {
      await this.ensureAuth();
      return refreshAccessToken(forceRefresh);
    },

    async clientId(): Promise<string> {
      return (await getSecret()).clientId;
    },

    async projectId(): Promise<string | undefined> {
      return (await getSecret()).projectId;
    },

    tokenAgeMs(): number | undefined {
      return tokenAge(stored);
    },
  };
}
