#!/usr/bin/env node
/**
 * photo-pigeon · the 30 minute empirical probe
 * ============================================
 *
 * This script exists to settle, with real bytes against the real API, the
 * questions the research left open. It is a throwaway diagnostic, not part of
 * the shipped product, and it runs standalone:
 *
 *     npx tsx scripts/probe.ts --credentials C:\path\to\client_secret_....json
 *
 * PROBE.md next to this file walks through creating the throwaway Cloud project
 * and the Desktop OAuth client that the --credentials file comes from.
 *
 * What it answers
 * ---------------
 *  1. Does Google dedupe byte identical uploads server side? Upload 20 unique
 *     small JPEGs, then re-upload 5 of them byte for byte under new filenames.
 *     Same media item ids back means yes, new ids mean no.
 *  2. Do resumable chunks each burn a request against the 10,000 per day
 *     project quota? Upload one large file in small chunks, count the HTTP
 *     requests, then read the console metrics page the summary links to.
 *  3. What exactly does the 403 look like when you bring your own client?
 *     Every 403 is caught and translated, with the rclone issue 8567 context.
 *
 * The laws it lives under
 * -----------------------
 *  · Upload only, one direction, forever. There is no code path in this file
 *    that deletes or mutates anything on Google's side, and there must never
 *    be one. The test media items this probe creates have to be removed by
 *    hand in the Google Photos UI. probe-results.json records a productUrl for
 *    every item so that is a click each, not a hunt.
 *  · The repo ships zero credentials. This script reads yours from disk and
 *    never writes a client secret, an access token, or a refresh token into
 *    probe-results.json.
 *  · Scope is photoslibrary.appendonly and nothing else, taken from
 *    src/contracts.ts so there is exactly one place that decides it.
 */

import { createHash, randomFillSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { mkdir, open as openFile, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import openInBrowser from 'open';
import pc from 'picocolors';

import { API_LIMITS, OAUTH_SCOPES } from '../src/contracts.js';

// ---------------------------------------------------------------------------
// The JPEG template
// ---------------------------------------------------------------------------

/**
 * A complete, valid, baseline 1x1 pixel JPEG: SOI, JFIF APP0, the standard
 * Annex K quantization and Huffman tables, SOF0, SOS, one MCU of scan data,
 * EOI. Roughly 630 bytes. Every byte of it is real, so this is a file Google
 * can actually decode, not a fake with a .jpg extension.
 *
 * CAVEAT, and it matters for how you read the dedupe result
 * ---------------------------------------------------------
 * The probe makes each of the 20 files unique by appending random bytes AFTER
 * the EOI marker (FF D9). That is deliberate: it is the cheapest way to get
 * genuinely distinct file bytes, and every conforming decoder stops at EOI and
 * ignores the tail, so all 20 files still decode to the same 1x1 image.
 *
 * The consequence is that the 20 files are distinct as BYTES but identical as
 * PICTURES. So the run gives us two readings, not one:
 *
 *   · If the first 20 uploads come back with 20 distinct media item ids, then
 *     Google is not collapsing on decoded image content.
 *   · If they come back with fewer than 20 ids, Google normalized the files
 *     (very likely stripping the tail) and deduped on the result. That is a
 *     finding in its own right and the summary calls it out.
 *
 * Step 3, the 5 byte identical re-uploads, is the clean test either way: same
 * bytes in, so whatever Google keys on, a dedupe would have to fire.
 *
 * If you want a test with no synthetic image at all, pass --sample with a path
 * to a real photo. The probe will use its bytes as the template instead. Do
 * that if uploads come back INVALID_ARGUMENT: a 1x1 image is legal but it is
 * also an odd thing to send, and ruling it out costs one flag.
 *
 * An alternative to appending after EOI, noted for anyone revisiting this:
 * write the random bytes into a JPEG COM (comment) segment instead. That keeps
 * the file strictly conforming with no trailing data, at the cost of having to
 * splice a segment in before the scan. Not worth it for a probe, worth knowing
 * for the product.
 */
const MINIMAL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR' +
  'CAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
  'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK' +
  'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG' +
  'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl' +
  '5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
  'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk' +
  'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE' +
  'hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk' +
  '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

/** The decoded template, read once. */
export function jpegTemplate(): Buffer {
  return Buffer.from(MINIMAL_JPEG_BASE64, 'base64');
}

// ---------------------------------------------------------------------------
// Small pure helpers, exported so scripts/probe.test.ts can hold them to account
// ---------------------------------------------------------------------------

/** True when the buffer opens with SOI, carries a start of frame, and closes with EOI. */
export function looksLikeJpeg(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  if (readJpegSize(buf) === undefined) return false;
  return findEoi(buf) !== -1;
}

/** Index of the first byte of the EOI marker, or -1 when there is none. */
export function findEoi(buf: Buffer): number {
  for (let i = 2; i + 1 < buf.length; i += 1) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) return i;
  }
  return -1;
}

/** Width and height off the start of frame header, or undefined when absent. */
export function readJpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const segmentLength = buf.readUInt16BE(i + 2);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + segmentLength;
  }
  return undefined;
}

/**
 * Builds one probe JPEG: the template verbatim, then a readable tag and random
 * bytes past EOI so the file bytes are unique while the picture is not.
 */
export function buildProbeJpeg(template: Buffer, tag: string, noiseBytes = 512): Buffer {
  const label = Buffer.from(`\n photo-pigeon probe ${tag} `, 'utf8');
  const noise = Buffer.allocUnsafe(noiseBytes);
  randomFillSync(noise);
  return Buffer.concat([template, label, noise]);
}

/** Lowercase hex sha256 of a buffer. The ledger's primary key, in miniature. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Google hands back a required chunk granularity on the resumable start call.
 * Every chunk except the last has to be a whole multiple of it, so the size the
 * caller asked for gets rounded down, never up, and never below one unit.
 */
export function planChunks(
  totalBytes: number,
  requestedChunkBytes: number,
  granularityBytes: number,
): { chunkBytes: number; chunkCount: number } {
  const unit = granularityBytes > 0 ? granularityBytes : 1;
  const rounded = Math.floor(requestedChunkBytes / unit) * unit;
  const chunkBytes = Math.max(unit, rounded);
  const chunkCount = Math.max(1, Math.ceil(totalBytes / chunkBytes));
  return { chunkBytes, chunkCount };
}

/** Human sizes, because 26214400 tells nobody anything. */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** Never let a client id reach disk whole. Enough to recognise, not enough to reuse. */
export function maskClientId(clientId: string): string {
  const [numeric] = clientId.split('-');
  const head = (numeric ?? '').slice(0, 6);
  return `${head}...apps.googleusercontent.com`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.avi': 'video/x-msvideo',
};

/** Best guess at a mime type from a filename, falling back to JPEG. */
export function mimeForPath(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'image/jpeg';
}

// ---------------------------------------------------------------------------
// Errors, and the 403 translation table
// ---------------------------------------------------------------------------

/** An HTTP response Google was not happy about, with the body kept for diagnosis. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly bodyText: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.name = 'HttpError';
  }

  /** The machine readable status string Google puts in the error envelope. */
  get googleStatus(): string {
    try {
      const parsed = JSON.parse(this.bodyText) as { error?: { status?: string } };
      return parsed.error?.status ?? '';
    } catch {
      return '';
    }
  }

  /** The human readable message Google puts in the error envelope. */
  get googleMessage(): string {
    try {
      const parsed = JSON.parse(this.bodyText) as { error?: { message?: string } };
      return parsed.error?.message ?? this.bodyText.slice(0, 400);
    } catch {
      return this.bodyText.slice(0, 400);
    }
  }
}

/** One named diagnosis for a 403, with the fix spelled out. */
export interface Diagnosis {
  cause: string;
  meaning: string;
  fix: string[];
}

/**
 * Turns a 403 into a named cause. This is the failure mode rclone issue 8567
 * collects: people bring their own client, everything looks configured, and
 * every call comes back 403 with a message that does not say which of the four
 * possible mistakes they made. The probe says which.
 *
 * https://github.com/rclone/rclone/issues/8567
 */
export function diagnose403(bodyText: string, projectId: string | undefined): Diagnosis {
  const body = bodyText.toLowerCase();
  const project = projectId ?? 'YOUR_PROJECT_ID';

  if (
    body.includes('service_disabled') ||
    body.includes('accessnotconfigured') ||
    body.includes('has not been used in project') ||
    body.includes('is disabled')
  ) {
    return {
      cause: 'The Photos Library API is not enabled on this Cloud project',
      meaning:
        'The OAuth client authenticated fine. The project behind it has never had the Photos Library API switched on, or it was switched on in a different project than the one the client belongs to. That second case is the common one: people have several projects open in tabs.',
      fix: [
        `Open https://console.cloud.google.com/apis/library/photoslibrary.googleapis.com?project=${project}`,
        'Confirm the project name in the top bar matches the project in your credentials file, then press Enable.',
        'Enabling propagates in under a minute. Run the probe again.',
      ],
    };
  }

  if (
    body.includes('access_token_scope_insufficient') ||
    body.includes('insufficient authentication scopes') ||
    body.includes('insufficient permission')
  ) {
    return {
      cause: 'The access token does not carry the appendonly scope',
      meaning:
        'Almost always a stale token: it was minted during an earlier consent that asked for different scopes, and it is being reused. Google does not upgrade a token in place.',
      fix: [
        'Delete the token cache this probe printed at startup, then run again and consent freshly.',
        'On the consent screen, make sure the "Add to your Google Photos library" permission is ticked. Google shows it as an optional checkbox and an unticked box produces exactly this error.',
      ],
    };
  }

  if (
    body.includes('policy_enforced') ||
    body.includes('advanced protection') ||
    body.includes('appnotauthorizedtouser') ||
    body.includes('blocked')
  ) {
    return {
      cause: 'The Google account is refusing unverified clients',
      meaning:
        'Accounts enrolled in Google Advanced Protection, and many Workspace accounts under an admin policy, will not grant scopes to an app that has not been through Google verification. There is no appeal path a tool can take on the user\'s behalf.',
      fix: [
        'Workspace account: ask the admin to allowlist the client id under Security, API controls, App access control.',
        'Advanced Protection on a personal account: this cannot be fixed from here. Use a different Google account for photo backup, or accept that this tool will not work for that account.',
      ],
    };
  }

  if (body.includes('ratelimitexceeded') || body.includes('quota') || body.includes('userratelimit')) {
    return {
      cause: 'Quota, arriving dressed as a 403 rather than a 429',
      meaning:
        'The project ran into its 10,000 requests per day ceiling, or a short window burst limit. Google is inconsistent about which status code it uses for this.',
      fix: [
        `Check https://console.cloud.google.com/apis/api/photoslibrary.googleapis.com/quotas?project=${project}`,
        `Back off at least ${API_LIMITS.MIN_BACKOFF_MS / 1000} seconds before retrying. One second retries make this worse, not better.`,
      ],
    };
  }

  return {
    cause: 'A 403 that does not name itself, the rclone issue 8567 shape',
    meaning:
      'Bringing your own OAuth client can 403 for four different reasons and the message rarely distinguishes them. Work down this list in order, it is ordered by how often each one is the answer.',
    fix: [
      `1. The Photos Library API is enabled on a DIFFERENT project than the client belongs to. Check https://console.cloud.google.com/apis/dashboard?project=${project}`,
      '2. The consent screen is still in Testing. Publishing is the single most skipped step. https://console.cloud.google.com/auth/audience?project=' +
        project,
      '3. You signed in with a different Google account than the one that owns the Cloud project. That is allowed, but the consent screen has to be published for it, not just have you as a test user.',
      '4. The client is the wrong type. It has to be a Desktop app client. A Web application client will reject the loopback redirect this probe uses.',
      'Context: https://github.com/rclone/rclone/issues/8567',
    ],
  };
}

// ---------------------------------------------------------------------------
// Counted HTTP
// ---------------------------------------------------------------------------

interface RequestRecord {
  phase: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

const requestLog: RequestRecord[] = [];
let currentPhase = 'startup';

function setPhase(phase: string): void {
  currentPhase = phase;
}

function requestsInPhase(phase: string): number {
  return requestLog.filter((r) => r.phase === phase).length;
}

function requestsByPhase(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of requestLog) out[r.phase] = (out[r.phase] ?? 0) + 1;
  return out;
}

/** Every single call to Google goes through here, so the tally is exhaustive. */
async function countedFetch(url: string, init: RequestInit): Promise<Response> {
  const started = Date.now();
  const res = await fetch(url, init);
  requestLog.push({
    phase: currentPhase,
    method: init.method ?? 'GET',
    // Upload URLs carry a signed token in the query string. Keep the path only.
    url: url.split('?')[0] ?? url,
    status: res.status,
    durationMs: Date.now() - started,
  });
  return res;
}

/** Throws an HttpError when the response is not ok, otherwise hands it back. */
async function ensureOk(res: Response, url: string): Promise<Response> {
  if (res.ok) return res;
  const bodyText = await res.text().catch(() => '');
  throw new HttpError(res.status, res.statusText, bodyText, url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retries on 429 and on 5xx. The floor is 30 seconds because Google's Photos
 * quota errors are documented to need it: retrying after one second is how you
 * turn one 429 into ten.
 */
async function withRetry<T>(label: string, attempt: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let n = 1; n <= maxAttempts; n += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof HttpError && (error.status === 429 || error.status >= 500);
      if (!retryable || n === maxAttempts) throw error;
      const base = API_LIMITS.MIN_BACKOFF_MS * 2 ** (n - 1);
      const waitMs = base + Math.floor(Math.random() * 5_000);
      console.log(
        pc.yellow(
          `  ${label}: HTTP ${(error as HttpError).status}, waiting ${Math.round(waitMs / 1000)}s before retry ${n + 1} of ${maxAttempts}. This pause is the correct behaviour, not a hang.`,
        ),
      );
      await sleep(waitMs);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Credentials and OAuth, loopback only
// ---------------------------------------------------------------------------

interface ClientSecret {
  clientId: string;
  clientSecret: string;
  projectId?: string;
  kind: 'installed' | 'web';
}

/** Reads the client_secret_*.json Google hands you when you make a Desktop client. */
async function loadClientSecret(path: string): Promise<ClientSecret> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, any>;
  const block = parsed.installed ?? parsed.web;
  if (!block?.client_id || !block?.client_secret) {
    throw new Error(
      `${path} does not look like an OAuth client file. Expected a top level "installed" or "web" object holding client_id and client_secret. Download it again from the Credentials page, do not hand assemble it.`,
    );
  }
  if (parsed.web && !parsed.installed) {
    console.log(
      pc.yellow(
        '  Warning: this is a Web application client, not a Desktop client. The loopback redirect will probably be rejected. Create a Desktop app client instead, PROBE.md step 5.',
      ),
    );
  }
  return {
    clientId: block.client_id,
    clientSecret: block.client_secret,
    projectId: block.project_id,
    kind: parsed.installed ? 'installed' : 'web',
  };
}

/**
 * The loopback consent flow. A server on 127.0.0.1 with an ephemeral port, PKCE
 * on, offline access so we get a refresh token. Loopback is the only redirect
 * style left that works for a desktop tool: the out of band flow is dead and the
 * device flow has no Photos scopes.
 */
async function runConsentFlow(secret: ClientSecret): Promise<Record<string, unknown>> {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const client = new OAuth2Client({
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    redirectUri,
  });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...OAUTH_SCOPES],
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  console.log('');
  console.log(pc.bold('  Consent needed. A browser window should open.'));
  console.log('  If it does not, paste this into any browser, including Firefox or Zen:');
  console.log('  ' + pc.cyan(authUrl));
  console.log('');
  console.log(
    pc.dim(
      '  You will see "Google hasn\'t verified this app". That is expected for your own\n' +
        '  unverified client. Choose Advanced, then Continue. Tick the Google Photos\n' +
        '  permission box: it is optional on the screen and an unticked box fails later.',
    ),
  );

  const code = await new Promise<string>((resolveCode, rejectCode) => {
    const timeout = setTimeout(
      () => rejectCode(new Error('Timed out after 5 minutes waiting for consent.')),
      5 * 60 * 1000,
    );

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (!url.pathname.startsWith('/oauth2callback')) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const received = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>photo-pigeon probe</title>` +
          `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;line-height:1.6">` +
          `<h1 style="font-size:1.4rem">${error ? 'Consent was declined' : 'Consent granted'}</h1>` +
          `<p>${error ? `Google returned: <code>${error}</code>. Close this tab and run the probe again.` : 'You can close this tab. The probe is running in your terminal.'}</p>` +
          `</body>`,
      );
      clearTimeout(timeout);
      if (error) rejectCode(new Error(`Consent declined: ${error}`));
      else if (!received) rejectCode(new Error('Callback arrived with no authorization code.'));
      else resolveCode(received);
    });

    openInBrowser(authUrl).catch(() => {
      console.log(pc.yellow('  Could not launch a browser automatically. Use the link above.'));
    });
  }).finally(() => server.close());

  const { tokens } = await client.getToken({ code, codeVerifier });
  return tokens as Record<string, unknown>;
}

/**
 * Returns a live access token, reusing a cached refresh token when there is one.
 * The cache is a plain file. It holds a real refresh token, so it is as
 * sensitive as a password and .gitignore already covers the directory.
 */
async function getAccessToken(secret: ClientSecret, tokenPath: string): Promise<string> {
  setPhase('auth');

  // Self test escape hatch, see the note on API_BASE.
  const injected = process.env.PIGEON_PROBE_ACCESS_TOKEN;
  if (injected) {
    console.log(pc.dim('  Using an injected access token (self test mode).'));
    return injected;
  }

  let tokens: Record<string, unknown> | undefined;

  if (existsSync(tokenPath)) {
    try {
      tokens = JSON.parse(await readFile(tokenPath, 'utf8')) as Record<string, unknown>;
      console.log(pc.dim(`  Reusing the cached token at ${tokenPath}`));
    } catch {
      console.log(pc.yellow(`  Token cache at ${tokenPath} is unreadable, asking for consent again.`));
    }
  }

  const client = new OAuth2Client({ clientId: secret.clientId, clientSecret: secret.clientSecret });

  if (tokens?.refresh_token) {
    client.setCredentials(tokens);
    try {
      const { token } = await client.getAccessToken();
      if (token) return token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('invalid_grant')) {
        console.log('');
        console.log(pc.red(pc.bold('  invalid_grant on a refresh token.')));
        console.log(
          pc.red(
            '  If this client was set up less than 7 days ago, the cause is almost certainly\n' +
              '  that the consent screen is still in Testing. Testing mode expires refresh\n' +
              '  tokens after 7 days, every time, forever. The fix is one click:\n' +
              `  https://console.cloud.google.com/auth/audience?project=${secret.projectId ?? ''}\n` +
              '  press Publish app, then delete the token cache and run the probe again.',
          ),
        );
        console.log('');
      } else {
        console.log(pc.yellow(`  Refresh failed (${message}), falling back to a fresh consent.`));
      }
    }
  }

  tokens = await runConsentFlow(secret);
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
  console.log(pc.dim(`  Token cached at ${tokenPath}`));

  client.setCredentials(tokens);
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Consent succeeded but no access token came back.');
  return token;
}

// ---------------------------------------------------------------------------
// The two endpoints that matter
// ---------------------------------------------------------------------------

/**
 * The real endpoint, unless a self test points the probe at a mock.
 *
 * PIGEON_PROBE_API_BASE and PIGEON_PROBE_ACCESS_TOKEN exist so that
 * scripts/probe.test.ts can drive the whole upload, chunk and batchCreate path
 * against a local fake and prove it works before anyone spends a Cloud project
 * on finding out. They are test scaffolding, not a feature: scripts/ is not in
 * the published package, and neither variable is read anywhere in src/.
 */
const API_BASE = process.env.PIGEON_PROBE_API_BASE ?? 'https://photoslibrary.googleapis.com';

/** Raw upload: whole file in one request, returns the upload token as plain text. */
async function uploadRaw(accessToken: string, bytes: Buffer, mimeType: string): Promise<string> {
  const url = `${API_BASE}/v1/uploads`;
  const res = await withRetry('upload', async () =>
    ensureOk(
      await countedFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/octet-stream',
          'x-goog-upload-content-type': mimeType,
          'x-goog-upload-protocol': 'raw',
        },
        body: new Uint8Array(bytes),
      }),
      url,
    ),
  );
  return (await res.text()).trim();
}

interface ResumableResult {
  uploadToken: string;
  chunkBytes: number;
  chunkCount: number;
  granularityBytes: number;
  requestCount: number;
}

/**
 * Resumable upload, chunk by chunk, which is what any real file over a few
 * megabytes has to use. Every chunk is its own HTTP request, and whether each
 * of those counts against the 10,000 per day project quota is exactly what this
 * probe is here to find out. The count returned is the client side truth.
 */
async function uploadResumable(
  accessToken: string,
  filePath: string,
  mimeType: string,
  requestedChunkBytes: number,
): Promise<ResumableResult> {
  const totalBytes = statSync(filePath).size;
  const startUrl = `${API_BASE}/v1/uploads`;

  setPhase('resumable-start');
  const startRes = await withRetry('resumable start', async () =>
    ensureOk(
      await countedFetch(startUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-length': '0',
          'x-goog-upload-command': 'start',
          'x-goog-upload-content-type': mimeType,
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-raw-size': String(totalBytes),
        },
      }),
      startUrl,
    ),
  );

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error(
      'The resumable start call returned no X-Goog-Upload-URL header. Nothing can be sent without it.',
    );
  }
  const granularityBytes = Number(startRes.headers.get('x-goog-upload-chunk-granularity') ?? 0);
  const { chunkBytes, chunkCount } = planChunks(totalBytes, requestedChunkBytes, granularityBytes);

  console.log(
    `  Server chunk granularity: ${granularityBytes ? humanBytes(granularityBytes) : 'not stated'}. ` +
      `Asked for ${humanBytes(requestedChunkBytes)} chunks, using ${humanBytes(chunkBytes)}, ` +
      `so ${chunkCount} chunk requests plus 1 start request.`,
  );

  setPhase('resumable-chunks');
  const handle = await openFile(filePath, 'r');
  let uploadToken = '';
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const offset = index * chunkBytes;
      const length = Math.min(chunkBytes, totalBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, offset);
      const isLast = index === chunkCount - 1;

      const res = await withRetry(`chunk ${index + 1}`, async () =>
        ensureOk(
          await countedFetch(uploadUrl, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-length': String(length),
              'x-goog-upload-command': isLast ? 'upload, finalize' : 'upload',
              'x-goog-upload-offset': String(offset),
            },
            body: new Uint8Array(buffer),
          }),
          uploadUrl,
        ),
      );

      process.stdout.write(
        `\r  chunk ${index + 1} of ${chunkCount} sent (${humanBytes(Math.min(offset + length, totalBytes))} of ${humanBytes(totalBytes)})   `,
      );
      if (isLast) uploadToken = (await res.text()).trim();
    }
  } finally {
    await handle.close();
    process.stdout.write('\n');
  }

  return {
    uploadToken,
    chunkBytes,
    chunkCount,
    granularityBytes,
    requestCount: requestsInPhase('resumable-start') + requestsInPhase('resumable-chunks'),
  };
}

interface CreatedItem {
  fileName: string;
  uploadToken: string;
  ok: boolean;
  mediaItemId?: string;
  productUrl?: string;
  error?: string;
}

/**
 * batchCreate: at most 50 items, and strictly serial per account. There is no
 * partial success at the call level, so every item reports for itself and a
 * retry would resend only the failed subset.
 */
async function batchCreate(
  accessToken: string,
  items: { fileName: string; uploadToken: string }[],
): Promise<CreatedItem[]> {
  if (items.length > API_LIMITS.BATCH_CREATE_MAX_ITEMS) {
    throw new Error(
      `batchCreate takes at most ${API_LIMITS.BATCH_CREATE_MAX_ITEMS} items, was given ${items.length}.`,
    );
  }
  const url = `${API_BASE}/v1/mediaItems:batchCreate`;
  const res = await withRetry('batchCreate', async () =>
    ensureOk(
      await countedFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          newMediaItems: items.map((item) => ({
            description: 'photo-pigeon probe, safe to delete',
            simpleMediaItem: { fileName: item.fileName, uploadToken: item.uploadToken },
          })),
        }),
      }),
      url,
    ),
  );

  const payload = (await res.json()) as {
    newMediaItemResults?: {
      uploadToken?: string;
      status?: { code?: number; message?: string };
      mediaItem?: { id?: string; productUrl?: string; filename?: string };
    }[];
  };

  return (payload.newMediaItemResults ?? []).map((result, index) => {
    const source = items[index]!;
    const ok = !result.status?.code || result.status.code === 0;
    return {
      fileName: source.fileName,
      uploadToken: result.uploadToken ?? source.uploadToken,
      ok: ok && Boolean(result.mediaItem?.id),
      mediaItemId: result.mediaItem?.id,
      productUrl: result.mediaItem?.productUrl,
      error: ok ? undefined : (result.status?.message ?? 'unknown batchCreate failure'),
    };
  });
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface ProbeOptions {
  credentialsPath: string;
  tokenPath: string;
  outPath: string;
  samplePath?: string;
  largePath?: string;
  largeBytes: number;
  chunkBytes: number;
  smallCount: number;
  dupCount: number;
  skipLarge: boolean;
  keep: boolean;
}

const USAGE = `
photo-pigeon probe · settles the open API questions with real bytes

  npx tsx scripts/probe.ts --credentials <path to client_secret_*.json>

Required
  --credentials <path>   Your own OAuth Desktop client JSON. See PROBE.md.

Optional
  --token <path>         Where to cache the refresh token.
                         Default: .photo-pigeon/probe-token.json
  --out <path>           Where to write results. Default: probe-results.json
  --sample <path>        Use a real photo as the file template instead of the
                         built in 1x1 JPEG. Try this if uploads are rejected.
  --large <path>         Use a real large file for the resumable test instead of
                         a generated one. This gives the most honest answer.
  --large-mb <n>         Size of the generated large file. Default: 25
  --chunk-kb <n>         Resumable chunk size, rounded to the server's
                         granularity. Default: 1024, meaning 1 MB
  --count <n>            How many small files to upload. Default: 20
  --dupes <n>            How many of those to re-upload byte identical.
                         Default: 5
  --skip-large           Skip the resumable test entirely.
  --keep                 Keep the generated temp files instead of deleting them.
  --help                 This text.

Nothing here deletes or modifies anything in Google Photos. It cannot: the only
scope requested is appendonly. The test items it creates have to be removed by
hand, and probe-results.json gives you a direct link to each one.
`;

function parseArgs(argv: string[]): ProbeOptions | 'help' {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey!;
    if (inlineValue !== undefined) {
      args.set(key, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }

  if (flags.has('help') || args.has('help')) return 'help';

  const credentials = args.get('credentials');
  if (!credentials) {
    throw new Error('--credentials is required. Run with --help, or read PROBE.md.');
  }

  const number = (key: string, fallback: number): number => {
    const raw = args.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be a positive number.`);
    return value;
  };

  return {
    credentialsPath: resolve(credentials),
    tokenPath: resolve(args.get('token') ?? join('.photo-pigeon', 'probe-token.json')),
    outPath: resolve(args.get('out') ?? 'probe-results.json'),
    samplePath: args.get('sample') ? resolve(args.get('sample')!) : undefined,
    largePath: args.get('large') ? resolve(args.get('large')!) : undefined,
    largeBytes: Math.round(number('large-mb', 25) * 1024 * 1024),
    chunkBytes: Math.round(number('chunk-kb', 1024) * 1024),
    smallCount: Math.round(number('count', 20)),
    dupCount: Math.round(number('dupes', 5)),
    skipLarge: flags.has('skip-large'),
    keep: flags.has('keep'),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface ProbeResults {
  probe: string;
  schemaVersion: number;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  environment: { node: string; platform: string; arch: string };
  client: { clientIdMasked: string; projectId?: string; clientType: string; scopes: string[] };
  findings: {
    serverSideDedup: {
      answer: 'YES' | 'NO' | 'INCONCLUSIVE';
      detail: string;
      distinctIdsAmongFirstBatch?: number;
      firstBatchSize?: number;
      duplicateIdsMatched?: number;
      duplicatesAttempted?: number;
    };
    resumableChunkQuota: {
      answer: 'MEASURE_IN_CONSOLE' | 'SKIPPED' | 'FAILED';
      detail: string;
      fileBytes?: number;
      chunkBytes?: number;
      chunkCount?: number;
      granularityBytes?: number;
      httpRequestsForOneFile?: number;
      metricsUrl?: string;
    };
    sensitiveScopeBadge: { answer: 'MANUAL'; detail: string };
    rclone8567: { encountered: boolean; diagnoses: Diagnosis[] };
  };
  uploads: {
    firstBatch: CreatedItem[];
    duplicateBatch: CreatedItem[];
    largeFile: CreatedItem[];
  };
  hashes: { fileName: string; sha256: string; bytes: number }[];
  requests: { total: number; byPhase: Record<string, number>; log: RequestRecord[] };
  errors: { step: string; message: string; status?: number; googleStatus?: string }[];
  summary: string[];
  nextAction: string;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const options = parsed;

  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date();

  console.log('');
  console.log(pc.bold('photo-pigeon probe'));
  console.log(pc.dim(`run ${runId} · started ${startedAt.toISOString()}`));
  console.log(
    pc.dim(
      'Upload only. Nothing in this script deletes or changes anything in Google Photos.',
    ),
  );
  console.log('');

  const secret = await loadClientSecret(options.credentialsPath);
  console.log(`  Client: ${maskClientId(secret.clientId)} (${secret.kind})`);
  console.log(`  Project: ${secret.projectId ?? pc.yellow('not stated in the credentials file')}`);
  console.log(`  Scope: ${OAUTH_SCOPES.join(', ')}`);
  console.log('');

  const results: ProbeResults = {
    probe: 'photo-pigeon',
    schemaVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    client: {
      clientIdMasked: maskClientId(secret.clientId),
      projectId: secret.projectId,
      clientType: secret.kind,
      scopes: [...OAUTH_SCOPES],
    },
    findings: {
      serverSideDedup: { answer: 'INCONCLUSIVE', detail: 'The probe did not get far enough.' },
      resumableChunkQuota: { answer: 'FAILED', detail: 'The probe did not get far enough.' },
      sensitiveScopeBadge: {
        answer: 'MANUAL',
        detail:
          'Not observable from the API. Look at the Data access page in the console and record whether appendonly carries a sensitive or restricted badge, because that decides whether verification is ever forceable on us.',
      },
      rclone8567: { encountered: false, diagnoses: [] },
    },
    uploads: { firstBatch: [], duplicateBatch: [], largeFile: [] },
    hashes: [],
    requests: { total: 0, byPhase: {}, log: [] },
    errors: [],
    summary: [],
    nextAction:
      'Fold these findings into the photo-pigeon PLAN before writing the queue. Three decisions hang on them: whether the local sha256 ledger is the only dedupe there will ever be, what chunk size the resumable uploader picks, and how doctor phrases its 403 diagnosis.',
  };

  const tempDir = join(tmpdir(), `photo-pigeon-probe-${runId}`);
  await mkdir(tempDir, { recursive: true });

  const recordError = (step: string, error: unknown): void => {
    if (error instanceof HttpError) {
      results.errors.push({
        step,
        message: error.googleMessage,
        status: error.status,
        googleStatus: error.googleStatus,
      });
      if (error.status === 403) {
        const diagnosis = diagnose403(error.bodyText, secret.projectId);
        results.findings.rclone8567 = {
          encountered: true,
          diagnoses: [...results.findings.rclone8567.diagnoses, diagnosis],
        };
        print403(error, diagnosis);
      } else {
        console.log(pc.red(`  ${step} failed: HTTP ${error.status} ${error.googleMessage}`));
        if (
          error.status === 400 &&
          /invalid|unsupported|corrupt/i.test(error.googleMessage) &&
          !options.samplePath
        ) {
          console.log(
            pc.yellow(
              '  That reads like the synthetic 1x1 JPEG being rejected. Re-run with\n' +
                '  --sample <path to a real photo> to rule the template out.',
            ),
          );
        }
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      results.errors.push({ step, message });
      console.log(pc.red(`  ${step} failed: ${message}`));
    }
  };

  try {
    const accessToken = await getAccessToken(secret, options.tokenPath);
    console.log(pc.green('  Authorized.'));
    console.log('');

    // -- Step 1: make the files -------------------------------------------
    console.log(pc.bold(`Step 1 · generating ${options.smallCount} unique small JPEGs`));
    const template = options.samplePath ? await readFile(options.samplePath) : jpegTemplate();
    if (options.samplePath) {
      console.log(`  Template: ${options.samplePath} (${humanBytes(template.length)})`);
    } else {
      const size = readJpegSize(template);
      console.log(
        `  Template: built in ${size?.width ?? '?'}x${size?.height ?? '?'} JPEG, ${humanBytes(template.length)}. ` +
          'Unique bytes come from random data appended past the EOI marker, so the files differ but the picture does not.',
      );
    }
    if (!looksLikeJpeg(template)) {
      console.log(
        pc.yellow('  Warning: the template does not parse as a JPEG. Uploads may be rejected.'),
      );
    }

    const smallFiles: { path: string; fileName: string; bytes: Buffer; hash: string }[] = [];
    for (let i = 0; i < options.smallCount; i += 1) {
      const fileName = `pigeon-probe-${runId}-${String(i + 1).padStart(2, '0')}.jpg`;
      const bytes = buildProbeJpeg(template, `${runId}-${i + 1}`);
      const path = join(tempDir, fileName);
      await writeFile(path, bytes);
      smallFiles.push({ path, fileName, bytes, hash: sha256(bytes) });
      results.hashes.push({ fileName, sha256: sha256(bytes), bytes: bytes.length });
    }
    const distinctHashes = new Set(smallFiles.map((f) => f.hash)).size;
    console.log(
      `  Wrote ${smallFiles.length} files to ${tempDir}, ${distinctHashes} distinct sha256 hashes.`,
    );
    if (distinctHashes !== smallFiles.length) {
      console.log(pc.red('  The generator produced collisions. Stop and fix that before reading anything else.'));
    }
    console.log('');

    // -- Step 2: upload and create ----------------------------------------
    console.log(pc.bold(`Step 2 · uploading ${smallFiles.length} files, then one batchCreate`));
    setPhase('upload-first-batch');
    const firstTokens: { fileName: string; uploadToken: string }[] = [];
    for (const [index, file] of smallFiles.entries()) {
      const uploadToken = await uploadRaw(accessToken, file.bytes, 'image/jpeg');
      firstTokens.push({ fileName: file.fileName, uploadToken });
      process.stdout.write(`\r  uploaded ${index + 1} of ${smallFiles.length}   `);
    }
    process.stdout.write('\n');

    setPhase('batch-first');
    results.uploads.firstBatch = await batchCreate(accessToken, firstTokens);
    const firstOk = results.uploads.firstBatch.filter((r) => r.ok);
    const firstIds = firstOk.map((r) => r.mediaItemId!).filter(Boolean);
    const distinctFirstIds = new Set(firstIds).size;
    console.log(
      `  batchCreate: ${firstOk.length} of ${firstTokens.length} created, ${distinctFirstIds} distinct media item ids.`,
    );
    for (const failed of results.uploads.firstBatch.filter((r) => !r.ok)) {
      console.log(pc.yellow(`  ${failed.fileName}: ${failed.error}`));
    }
    console.log('');

    // -- Step 3: the dedupe question --------------------------------------
    const dupCount = Math.min(options.dupCount, firstOk.length);
    console.log(
      pc.bold(`Step 3 · re-uploading ${dupCount} byte identical copies under new filenames`),
    );
    if (dupCount === 0) {
      console.log(pc.yellow('  Nothing was created in step 2, so there is nothing to duplicate.'));
      results.findings.serverSideDedup = {
        answer: 'INCONCLUSIVE',
        detail: 'Step 2 created no media items, so the dedupe question could not be asked.',
      };
    } else {
      setPhase('upload-duplicates');
      const originals = firstOk.slice(0, dupCount).map((created) => {
        const source = smallFiles.find((f) => f.fileName === created.fileName)!;
        return { created, source };
      });
      const dupTokens: { fileName: string; uploadToken: string }[] = [];
      for (const [index, pair] of originals.entries()) {
        // Identical bytes, different name. The bytes are what Google would key on.
        const fileName = `pigeon-probe-${runId}-copy-${String(index + 1).padStart(2, '0')}.jpg`;
        const uploadToken = await uploadRaw(accessToken, pair.source.bytes, 'image/jpeg');
        dupTokens.push({ fileName, uploadToken });
        process.stdout.write(`\r  re-uploaded ${index + 1} of ${dupCount}   `);
      }
      process.stdout.write('\n');

      setPhase('batch-duplicates');
      results.uploads.duplicateBatch = await batchCreate(accessToken, dupTokens);
      let matched = 0;
      for (const [index, result] of results.uploads.duplicateBatch.entries()) {
        const originalId = originals[index]?.created.mediaItemId;
        if (result.ok && result.mediaItemId && result.mediaItemId === originalId) matched += 1;
      }
      const dedup = matched === dupCount && dupCount > 0;
      console.log('');
      console.log(
        dedup
          ? pc.green(pc.bold('  DEDUP: YES'))
          : pc.red(pc.bold('  DEDUP: NO')),
      );
      console.log(
        `  ${matched} of ${dupCount} identical re-uploads came back with the ORIGINAL media item id.`,
      );
      results.findings.serverSideDedup = {
        answer: dedup ? 'YES' : matched > 0 ? 'INCONCLUSIVE' : 'NO',
        detail: dedup
          ? 'Byte identical uploads returned the original media item ids. Google collapses duplicates server side.'
          : matched > 0
            ? `Mixed result: ${matched} of ${dupCount} matched. Something is non deterministic, re-run before trusting either reading.`
            : 'Byte identical uploads produced brand new media item ids. There is no server side dedupe. The local sha256 ledger is the only thing preventing duplicate photos.',
        distinctIdsAmongFirstBatch: distinctFirstIds,
        firstBatchSize: firstTokens.length,
        duplicateIdsMatched: matched,
        duplicatesAttempted: dupCount,
      };
      if (distinctFirstIds < firstOk.length) {
        console.log(
          pc.yellow(
            `  Note: step 2 created ${firstOk.length} items but only ${distinctFirstIds} distinct ids.\n` +
              '  Google normalized the files, most likely by stripping the bytes past EOI, and\n' +
              '  then deduped on the result. Re-run with --sample and real photos to confirm.',
          ),
        );
      }
      console.log('');
    }

    // -- Step 4: chunks versus quota --------------------------------------
    if (options.skipLarge) {
      console.log(pc.dim('Step 4 · skipped (--skip-large)'));
      results.findings.resumableChunkQuota = {
        answer: 'SKIPPED',
        detail: 'The resumable test was skipped with --skip-large.',
      };
      console.log('');
    } else {
      console.log(pc.bold('Step 4 · one large file through the resumable path, counting requests'));
      let largePath = options.largePath;
      let largeMime = 'image/jpeg';
      if (largePath) {
        largeMime = mimeForPath(largePath);
        console.log(
          `  Using your file: ${largePath} (${humanBytes(statSync(largePath).size)}, ${largeMime})`,
        );
      } else {
        largePath = join(tempDir, `pigeon-probe-${runId}-large.jpg`);
        console.log(`  Generating ${humanBytes(options.largeBytes)} of padded JPEG...`);
        const padding = Buffer.allocUnsafe(Math.max(0, options.largeBytes - template.length));
        // randomFillSync caps per call, so fill in slices.
        const slice = 65536;
        for (let offset = 0; offset < padding.length; offset += slice) {
          randomFillSync(padding, offset, Math.min(slice, padding.length - offset));
        }
        await writeFile(largePath, Buffer.concat([template, padding]));
        console.log(
          pc.dim(
            '  Caveat: this is a 1x1 picture wearing 25 MB of trailing noise. It exercises the\n' +
              '  transport honestly, but Google may reject it at batchCreate, and if it accepts\n' +
              '  it the stored item will be tiny. Pass --large <path to a real big photo or\n' +
              '  video> for a result you can quote about storage.',
          ),
        );
      }

      try {
        const resumable = await uploadResumable(accessToken, largePath, largeMime, options.chunkBytes);
        const metricsUrl = `https://console.cloud.google.com/apis/api/photoslibrary.googleapis.com/metrics?project=${secret.projectId ?? ''}`;
        results.findings.resumableChunkQuota = {
          answer: 'MEASURE_IN_CONSOLE',
          detail:
            `One file of ${humanBytes(statSync(largePath).size)} took ${resumable.requestCount} HTTP requests ` +
            `(1 start plus ${resumable.chunkCount} chunks of ${humanBytes(resumable.chunkBytes)}). ` +
            'Whether Google charges each chunk against the 10,000 per day project quota is only visible on the console metrics page.',
          fileBytes: statSync(largePath).size,
          chunkBytes: resumable.chunkBytes,
          chunkCount: resumable.chunkCount,
          granularityBytes: resumable.granularityBytes,
          httpRequestsForOneFile: resumable.requestCount,
          metricsUrl,
        };
        console.log(
          `  ${resumable.requestCount} HTTP requests for one file: 1 start plus ${resumable.chunkCount} chunks.`,
        );

        if (resumable.uploadToken) {
          setPhase('batch-large');
          results.uploads.largeFile = await batchCreate(accessToken, [
            { fileName: `pigeon-probe-${runId}-large${extname(largePath)}`, uploadToken: resumable.uploadToken },
          ]);
          const created = results.uploads.largeFile[0];
          console.log(
            created?.ok
              ? pc.green(`  Large file created: ${created.mediaItemId}`)
              : pc.yellow(`  Large file rejected at batchCreate: ${created?.error ?? 'no result'}`),
          );
        } else {
          console.log(pc.yellow('  Finalize returned no upload token, so nothing was created.'));
        }
      } catch (error) {
        recordError('step 4 resumable upload', error);
        results.findings.resumableChunkQuota = {
          answer: 'FAILED',
          detail: 'The resumable upload threw. See errors in this file.',
          httpRequestsForOneFile:
            requestsInPhase('resumable-start') + requestsInPhase('resumable-chunks'),
        };
      }
      console.log('');
    }
  } catch (error) {
    recordError('probe', error);
    process.exitCode = 1;
  } finally {
    if (!options.keep) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(pc.dim(`  Temp files kept at ${tempDir}`));
    }
  }

  // -- Step 5 and 6: write it down and say it out loud ---------------------
  const finishedAt = new Date();
  results.finishedAt = finishedAt.toISOString();
  results.durationMs = finishedAt.getTime() - startedAt.getTime();
  results.requests = { total: requestLog.length, byPhase: requestsByPhase(), log: requestLog };
  results.summary = buildSummary(results, secret.projectId);

  await writeFile(options.outPath, JSON.stringify(results, null, 2), 'utf8');

  console.log(results.summary.join('\n'));
  console.log('');
  console.log(pc.dim(`  Full results written to ${options.outPath}`));
}

/** Pretty printer for a 403, because a raw Google 403 tells nobody what to do. */
function print403(error: HttpError, diagnosis: Diagnosis): void {
  console.log('');
  console.log(pc.red(pc.bold('  ┌─ HTTP 403 ────────────────────────────────────────────────')));
  console.log(pc.red(`  │ Google said: ${error.googleMessage}`));
  if (error.googleStatus) console.log(pc.red(`  │ Status: ${error.googleStatus}`));
  console.log(pc.red('  │'));
  console.log(pc.red(pc.bold(`  │ Most likely: ${diagnosis.cause}`)));
  for (const line of wrap(diagnosis.meaning, 66)) console.log(pc.red(`  │ ${line}`));
  console.log(pc.red('  │'));
  console.log(pc.red('  │ What to do:'));
  for (const step of diagnosis.fix) {
    for (const [index, line] of wrap(step, 64).entries()) {
      console.log(pc.red(`  │   ${index === 0 ? '' : '  '}${line}`));
    }
  }
  console.log(pc.red(pc.bold('  └───────────────────────────────────────────────────────────')));
  console.log('');
}

/** Naive word wrap. Good enough for a terminal, and it keeps URLs on one line. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The human block: what we learned, what it changes, what is still on you. */
export function buildSummary(results: ProbeResults, projectId: string | undefined): string[] {
  const rule = '='.repeat(72);
  const dedup = results.findings.serverSideDedup;
  const chunks = results.findings.resumableChunkQuota;
  const out: string[] = [];

  out.push('');
  out.push(rule);
  out.push(` photo-pigeon probe · run ${results.runId} · ${Math.round((results.durationMs ?? 0) / 1000)}s`);
  out.push(rule);
  out.push('');

  out.push(' 1 · Does Google dedupe byte identical uploads server side?');
  out.push('');
  out.push(`     DEDUP: ${dedup.answer}`);
  out.push('');
  for (const line of wrap(dedup.detail, 66)) out.push(`     ${line}`);
  if (dedup.firstBatchSize !== undefined) {
    out.push('');
    out.push(
      `     First batch: ${dedup.firstBatchSize} files uploaded, ${dedup.distinctIdsAmongFirstBatch ?? 0} distinct ids.`,
    );
    out.push(
      `     Re-uploads: ${dedup.duplicateIdsMatched ?? 0} of ${dedup.duplicatesAttempted ?? 0} returned the original id.`,
    );
  }
  out.push('');
  out.push('     What it changes: if the answer is NO, the local sha256 ledger is the');
  out.push('     only thing standing between a moved folder and a library full of');
  out.push('     duplicates, and it has to be durable before the watcher ships.');
  out.push('');

  out.push(' 2 · Does each resumable chunk burn a request against the daily quota?');
  out.push('');
  out.push(`     ANSWER: ${chunks.answer}`);
  out.push('');
  for (const line of wrap(chunks.detail, 66)) out.push(`     ${line}`);
  if (chunks.metricsUrl) {
    out.push('');
    out.push('     Read it off the console, this run is the experiment:');
    out.push(`     ${chunks.metricsUrl}`);
    out.push('');
    out.push(`     This whole run made ${results.requests.total} requests to the Photos API.`);
    out.push('     Open the metrics page, set the window to the last hour, and compare.');
    out.push('     If the console count is close to that number, every chunk costs quota');
    out.push('     and big files want big chunks. If it is far lower, chunks are free and');
    out.push('     small chunks are safe, which is better for resuming a broken upload.');
  }
  out.push('');

  out.push(' 3 · The sensitive scope badge, still on you');
  out.push('');
  for (const line of wrap(results.findings.sensitiveScopeBadge.detail, 66)) out.push(`     ${line}`);
  out.push('');
  out.push(`     https://console.cloud.google.com/auth/scopes?project=${projectId ?? ''}`);
  out.push('');

  out.push(' 4 · 403s seen this run');
  out.push('');
  if (!results.findings.rclone8567.encountered && results.uploads.firstBatch.length > 0) {
    out.push('     None. Bringing your own client worked first time, which is the');
    out.push('     result we wanted and the one the wizard has to reproduce.');
  } else if (!results.findings.rclone8567.encountered) {
    out.push('     None, but nothing was uploaded either, so this run proves nothing');
    out.push('     about 403s. See the errors below and run it again.');
  } else {
    for (const diagnosis of results.findings.rclone8567.diagnoses) {
      out.push(`     ${diagnosis.cause}`);
    }
    out.push('');
    out.push('     Every one of these is a case doctor must name out loud. Copy the');
    out.push('     wording into the doctor command rather than inventing new wording.');
  }
  out.push('');

  const created = [
    ...results.uploads.firstBatch,
    ...results.uploads.duplicateBatch,
    ...results.uploads.largeFile,
  ].filter((item) => item.ok);
  out.push(' Cleanup, which only you can do');
  out.push('');
  out.push(`     ${created.length} test items are now in your Google Photos library.`);
  out.push('     photo-pigeon will never delete them: it holds the appendonly scope and');
  out.push('     nothing else, so it has no power to. That is the law working, not a gap.');
  out.push('     Every created item has a productUrl in the results file. Open each one');
  out.push('     and delete it there, or leave them, they are a few kilobytes.');
  out.push('');

  if (results.errors.length > 0) {
    out.push(' Errors');
    out.push('');
    for (const error of results.errors) {
      out.push(`     ${error.step}: ${error.status ? `HTTP ${error.status} ` : ''}${error.message}`);
    }
    out.push('');
  }

  out.push(rule);
  for (const line of wrap(results.nextAction, 68)) out.push(` ${line}`);
  out.push(rule);

  return out;
}

// ---------------------------------------------------------------------------

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = pathToFileURL(entry).href.toLowerCase();
  const b = import.meta.url.toLowerCase();
  return a === b || fileURLToPath(import.meta.url).toLowerCase() === resolve(entry).toLowerCase();
})();

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('');
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
    console.error('');
    process.exitCode = 1;
  });
}
