import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OAuth2Client } from 'google-auth-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAUTH_SCOPES } from '../contracts.js';
import {
  AuthError,
  YOUNG_TOKEN_WINDOW_MS,
  audienceConsoleUrl,
  clientIdChangeWarning,
  createAuthorizer,
  createPkcePair,
  headlessAdvice,
  invalidGrantAdvice,
  loadClientSecret,
  readStoredToken,
  runConsentFlow,
  writeStoredToken,
  type ClientSecret,
} from './auth.js';
import { silentLogger } from './log.js';

let dir: string;

const INSTALLED = {
  installed: {
    client_id: '1234-abc.apps.googleusercontent.com',
    client_secret: 'GOCSPX-not-a-real-secret',
    project_id: 'pigeon-loft-42',
    redirect_uris: ['http://localhost'],
  },
};

const secret: ClientSecret = {
  clientId: INSTALLED.installed.client_id,
  clientSecret: INSTALLED.installed.client_secret,
  projectId: INSTALLED.installed.project_id,
  shape: 'installed',
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pigeon-auth-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the scope', () => {
  it('is append only and nothing else, ever', () => {
    expect(OAUTH_SCOPES).toEqual(['https://www.googleapis.com/auth/photoslibrary.appendonly']);
  });
});

describe('loadClientSecret', () => {
  it('reads the desktop client shape', async () => {
    const path = join(dir, 'client_secret_installed.json');
    await writeFile(path, JSON.stringify(INSTALLED));

    await expect(loadClientSecret(path)).resolves.toEqual({
      clientId: INSTALLED.installed.client_id,
      clientSecret: INSTALLED.installed.client_secret,
      projectId: 'pigeon-loft-42',
      shape: 'installed',
    });
  });

  it('reads the web client shape too', async () => {
    const path = join(dir, 'client_secret_web.json');
    await writeFile(
      path,
      JSON.stringify({ web: { client_id: 'web-id', client_secret: 'web-secret' } }),
    );

    const loaded = await loadClientSecret(path);
    expect(loaded.shape).toBe('web');
    expect(loaded.clientId).toBe('web-id');
    expect(loaded.projectId).toBeUndefined();
  });

  it('points at the wizard when the file is missing', async () => {
    await expect(loadClientSecret(join(dir, 'nope.json'))).rejects.toThrow(/photo-pigeon setup/);
  });

  it('says so plainly when the json is broken', async () => {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ oops');
    await expect(loadClientSecret(path)).rejects.toThrow(/not valid JSON/);
  });

  it('turns a service account key away with the reason', async () => {
    const path = join(dir, 'sa.json');
    await writeFile(path, JSON.stringify({ type: 'service_account', client_email: 'x@y.z' }));
    await expect(loadClientSecret(path)).rejects.toThrow(/service account/);
    await expect(loadClientSecret(path)).rejects.toThrow(/Desktop app/);
  });

  it('rejects a file with no client id', async () => {
    const path = join(dir, 'half.json');
    await writeFile(path, JSON.stringify({ installed: { client_id: 'only-id' } }));
    await expect(loadClientSecret(path)).rejects.toThrow(/no client id and secret/);
  });
});

describe('the token file', () => {
  it('round trips', async () => {
    const path = join(dir, 'nested', 'token.json');
    await writeStoredToken(path, {
      clientId: 'client-1',
      refreshToken: 'refresh-1',
      obtainedAt: '2026-07-28T10:00:00.000Z',
      scope: OAUTH_SCOPES[0],
    });

    const read = await readStoredToken(path);
    expect(read?.clientId).toBe('client-1');
    expect(read?.refreshToken).toBe('refresh-1');

    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('treats a token with no refresh token as no token at all', async () => {
    const path = join(dir, 'token.json');
    await writeFile(path, JSON.stringify({ clientId: 'client-1' }));
    await expect(readStoredToken(path)).resolves.toBeUndefined();
  });

  it('returns nothing for a missing file instead of throwing', async () => {
    await expect(readStoredToken(join(dir, 'absent.json'))).resolves.toBeUndefined();
  });
});

describe('the invalid_grant diagnosis', () => {
  it('names the Testing consent screen when the token is young, with the exact link', () => {
    const advice = invalidGrantAdvice({
      tokenAgeMs: 3 * 24 * 60 * 60 * 1000,
      projectId: 'pigeon-loft-42',
    });

    expect(advice).toContain('Testing mode');
    expect(advice).toContain('seven days');
    expect(advice).toContain('Publish app');
    expect(advice).toContain('https://console.cloud.google.com/auth/audience?project=pigeon-loft-42');
    expect(advice).toContain('about 3 day(s) old');
  });

  it('still fires on the eighth day, and stops after the window', () => {
    const justInside = invalidGrantAdvice({ tokenAgeMs: YOUNG_TOKEN_WINDOW_MS - 1 });
    const justOutside = invalidGrantAdvice({ tokenAgeMs: YOUNG_TOKEN_WINDOW_MS + 1 });

    expect(justInside).toContain('Testing mode');
    expect(justOutside).not.toContain('Testing mode');
    expect(justOutside).toContain('myaccount.google.com/permissions');
  });

  it('falls back to the generic advice when the token age is unknown', () => {
    const advice = invalidGrantAdvice({});
    expect(advice).toContain('photo-pigeon login');
    expect(advice).toContain('nothing will be sent twice');
  });
});

describe('console deep links', () => {
  it('carries the project when there is one, and survives odd project ids', () => {
    expect(audienceConsoleUrl('a b')).toBe('https://console.cloud.google.com/auth/audience?project=a%20b');
    expect(audienceConsoleUrl()).toBe('https://console.cloud.google.com/auth/audience');
  });
});

describe('the client id lock warning', () => {
  it('names both ids and says the ledger is now the record', () => {
    const warning = clientIdChangeWarning('old-id', 'new-id');
    expect(warning).toContain('old-id');
    expect(warning).toContain('new-id');
    expect(warning).toContain('ledger');
    expect(warning).toContain('forever');
  });
});

describe('headless machines', () => {
  it('tells the user to sign in elsewhere and copy the token', async () => {
    const advice = headlessAdvice('/srv/pigeon/token.json');
    expect(advice).toContain('/srv/pigeon/token.json');
    expect(advice).toContain('loopback');
  });

  it('refuses to open a browser when the run is not interactive', async () => {
    const credentialsPath = join(dir, 'client_secret.json');
    await writeFile(credentialsPath, JSON.stringify(INSTALLED));

    const authorizer = createAuthorizer({
      credentialsPath,
      tokenPath: join(dir, 'token.json'),
      interactive: false,
      logger: silentLogger,
      openBrowser: async () => {
        throw new Error('a browser must never be opened in this test');
      },
    });

    await expect(authorizer.ensureAuth()).rejects.toBeInstanceOf(AuthError);
    await expect(authorizer.ensureAuth()).rejects.toThrow(/copy the token file/);
  });

  it('reads the client id and project id straight off the credentials file', async () => {
    const credentialsPath = join(dir, 'client_secret.json');
    await writeFile(credentialsPath, JSON.stringify(INSTALLED));

    const authorizer = createAuthorizer({
      credentialsPath,
      tokenPath: join(dir, 'token.json'),
      logger: silentLogger,
    });

    await expect(authorizer.clientId()).resolves.toBe(INSTALLED.installed.client_id);
    await expect(authorizer.projectId()).resolves.toBe('pigeon-loft-42');
  });
});

/** base64url(sha256(input)), the S256 transform RFC 7636 defines. */
function s256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

describe('createPkcePair', () => {
  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    expect(codeChallenge).toBe(s256(codeVerifier));
  });

  it('produces a verifier RFC 7636 will accept', () => {
    const { codeVerifier } = createPkcePair();
    // 43 to 128 characters, drawn only from the unreserved set.
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('leaves the challenge url safe, with no base64 padding', () => {
    const { codeChallenge } = createPkcePair();
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).not.toContain('=');
    expect(codeChallenge).not.toContain('+');
    expect(codeChallenge).not.toContain('/');
  });

  it('is fresh every time, so one leaked code cannot unlock the next login', () => {
    const pairs = Array.from({ length: 20 }, () => createPkcePair().codeVerifier);
    expect(new Set(pairs).size).toBe(20);
  });
});

describe('the loopback consent flow', () => {
  /** Pulls the redirect target and state out of the url the browser would open. */
  function readAuthUrl(url: string): { redirectUri: string; state: string; scope: string } {
    const parsed = new URL(url);
    return {
      redirectUri: parsed.searchParams.get('redirect_uri') ?? '',
      state: parsed.searchParams.get('state') ?? '',
      scope: parsed.searchParams.get('scope') ?? '',
    };
  }

  /** What runConsentFlow handed to the token exchange. */
  interface ExchangeArgs {
    code?: string;
    codeVerifier?: string;
  }

  /**
   * Stands in for the round trip to Google's token endpoint and records what the
   * exchange was asked to send. The real call goes out through node-fetch inside
   * the auth library, so this is the seam that keeps the test off the network.
   */
  function stubTokenExchange(tokens: Record<string, unknown>): { seen: () => ExchangeArgs | undefined } {
    let seen: ExchangeArgs | undefined;
    const spy = vi.spyOn(OAuth2Client.prototype, 'getToken');
    spy.mockImplementation(((codeOrOptions: string | ExchangeArgs) => {
      seen = typeof codeOrOptions === 'string' ? { code: codeOrOptions } : codeOrOptions;
      return Promise.resolve({ tokens, res: null });
    }) as unknown as typeof OAuth2Client.prototype.getToken);
    return { seen: () => seen };
  }

  it('asks only for the append only scope, over loopback, with offline access', async () => {
    let seen = '';
    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async (url) => {
        seen = url;
        const { redirectUri, state } = readAuthUrl(url);
        await fetch(`${redirectUri}?error=access_denied&state=${state}`);
      },
    });

    await expect(attempt).rejects.toThrow(/access_denied/);

    const parsed = new URL(seen);
    expect(parsed.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/photoslibrary.appendonly',
    );
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });

  it('explains that the tool can only add, when consent is declined', async () => {
    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async (url) => {
        const { redirectUri, state } = readAuthUrl(url);
        await fetch(`${redirectUri}?error=access_denied&state=${state}`);
      },
    });

    await expect(attempt).rejects.toThrow(/never read or delete/);
  });

  it('refuses a callback whose state does not match', async () => {
    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async (url) => {
        const { redirectUri } = readAuthUrl(url);
        await fetch(`${redirectUri}?code=stolen&state=someone-elses`);
      },
    });

    await expect(attempt).rejects.toThrow(/did not match this request/);
  });

  it('refuses a callback with no code', async () => {
    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async (url) => {
        const { redirectUri, state } = readAuthUrl(url);
        await fetch(`${redirectUri}?state=${state}`);
      },
    });

    await expect(attempt).rejects.toThrow(/without an authorisation code/);
  });

  it('gives up rather than listening forever', async () => {
    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 30,
      openBrowser: async () => undefined,
    });

    await expect(attempt).rejects.toThrow(/Timed out/);
  });

  it('cancels cleanly when the signal was aborted before the wait began', async () => {
    // The window that closes between the last wizard answer and the consent
    // screen: the abort has already fired by the time this flow is entered.
    // The cancel sentence must come back, not a ReferenceError, and the
    // loopback listener must not survive to keep the sidecar alive.
    const handlesBefore = (
      process as unknown as { _getActiveHandles: () => unknown[] }
    )._getActiveHandles().length;

    const controller = new AbortController();
    controller.abort();
    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async () => undefined,
      signal: controller.signal,
    });

    await expect(attempt).rejects.toThrow(/cancelled before Google answered/);

    await vi.waitFor(() => {
      const now = (
        process as unknown as { _getActiveHandles: () => unknown[] }
      )._getActiveHandles().length;
      expect(now).toBeLessThanOrEqual(handlesBefore);
    });
  });

  it('puts an S256 challenge on the consent url, never the verifier', async () => {
    let seen = '';
    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async (url) => {
        seen = url;
        const { redirectUri, state } = readAuthUrl(url);
        await fetch(`${redirectUri}?error=access_denied&state=${state}`);
      },
    });

    await expect(attempt).rejects.toThrow(/access_denied/);

    const parsed = new URL(seen);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The whole point of S256 over plain: the browser carries the digest only.
    expect(parsed.searchParams.get('code_verifier')).toBeNull();
  });

  it('sends the verifier on the exchange, and it matches the challenge it advertised', async () => {
    const exchange = stubTokenExchange({ refresh_token: 'refresh-1', access_token: 'access-1' });

    let seen = '';
    const tokens = await runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async (url) => {
        seen = url;
        const { redirectUri, state } = readAuthUrl(url);
        await fetch(`${redirectUri}?code=auth-code-1&state=${state}`);
      },
    });

    expect(tokens.refresh_token).toBe('refresh-1');

    const sent = exchange.seen();
    expect(sent?.code).toBe('auth-code-1');
    expect(sent?.codeVerifier).toBeTruthy();

    // The binding that makes a stolen loopback code useless.
    const advertised = new URL(seen).searchParams.get('code_challenge');
    expect(advertised).toBe(s256(sent!.codeVerifier!));
  });

  it('generates a different verifier for every consent attempt', async () => {
    const verifiers: string[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const exchange = stubTokenExchange({ refresh_token: `refresh-${attempt}` });
      await runConsentFlow(secret, OAUTH_SCOPES, {
        logger: silentLogger,
        timeoutMs: 60_000,
        openBrowser: async (url) => {
          const { redirectUri, state } = readAuthUrl(url);
          await fetch(`${redirectUri}?code=auth-code&state=${state}`);
        },
      });
      verifiers.push(exchange.seen()!.codeVerifier!);
      vi.restoreAllMocks();
    }

    expect(verifiers[0]).not.toBe(verifiers[1]);
  });

  it('still refuses a login with no refresh token, PKCE or not', async () => {
    stubTokenExchange({ access_token: 'access-only' });

    const attempt = runConsentFlow(secret, OAUTH_SCOPES, {
      logger: silentLogger,
      timeoutMs: 60_000,
      openBrowser: async (url) => {
        const { redirectUri, state } = readAuthUrl(url);
        await fetch(`${redirectUri}?code=auth-code-1&state=${state}`);
      },
    });

    await expect(attempt).rejects.toBeInstanceOf(AuthError);
    await expect(attempt).rejects.toThrow(/no refresh token/);
  });
});
