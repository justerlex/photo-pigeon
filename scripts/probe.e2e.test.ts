/**
 * End to end test for the probe, against a fake Google Photos API.
 *
 * The probe gets one shot at being right: someone spends ten minutes clicking
 * through the Cloud console, runs it, and either gets an answer or gets a
 * stack trace. So the whole transport, the raw upload, the resumable chunk
 * loop, batchCreate, the dedupe comparison and the 403 box, is driven here
 * against a local server that speaks the same protocol Google does.
 *
 * The fake is deliberately strict about the protocol: wrong offset, missing
 * finalize, or an oversized batch and it fails the request, so a regression in
 * the probe shows up as a failing test rather than as a confusing morning.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const PROBE = join(import.meta.dirname, 'probe.ts');
/** The child has to run from the repo root, that is where node finds tsx. */
const REPO_ROOT = join(import.meta.dirname, '..');
const ACCESS_TOKEN = 'fake-access-token';

interface FakeOptions {
  /** Return the original media item id when the same bytes arrive again. */
  dedupe: boolean;
  /** Fail every request with this status instead of serving it. */
  failWith?: { status: number; body: string };
}

interface Fake {
  server: Server;
  baseUrl: string;
  /** Every request the fake saw, in order. */
  seen: { method: string; path: string; command?: string }[];
  /** uploadToken to the sha256 of the bytes that produced it. */
  tokenToHash: Map<string, string>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function startFake(options: FakeOptions): Promise<Fake> {
  const seen: Fake['seen'] = [];
  const tokenToHash = new Map<string, string>();
  const hashToMediaId = new Map<string, string>();
  const sessions = new Map<string, { chunks: Buffer[]; received: number }>();
  let tokenCounter = 0;
  let itemCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      const command = req.headers['x-goog-upload-command'] as string | undefined;
      seen.push({ method: req.method ?? '', path: url.pathname, command });

      const fail = (status: number, body: string): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      };

      if (options.failWith) {
        fail(options.failWith.status, options.failWith.body);
        return;
      }
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        fail(401, JSON.stringify({ error: { code: 401, message: 'no token' } }));
        return;
      }

      // Resumable session start.
      if (url.pathname === '/v1/uploads' && command === 'start') {
        const sessionId = `session-${sessions.size + 1}`;
        sessions.set(sessionId, { chunks: [], received: 0 });
        res.writeHead(200, {
          'x-goog-upload-url': `${(server.address() as AddressInfo) && baseUrlOf(server)}/session/${sessionId}`,
          'x-goog-upload-chunk-granularity': '262144',
        });
        res.end('');
        return;
      }

      // Raw upload, whole file in one request.
      if (url.pathname === '/v1/uploads') {
        const body = await readBody(req);
        const token = `token-${(tokenCounter += 1)}`;
        tokenToHash.set(token, createHash('sha256').update(body).digest('hex'));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(token);
        return;
      }

      // Resumable chunk.
      if (url.pathname.startsWith('/session/')) {
        const sessionId = url.pathname.slice('/session/'.length);
        const session = sessions.get(sessionId);
        if (!session) {
          fail(404, JSON.stringify({ error: { code: 404, message: 'unknown session' } }));
          return;
        }
        const offset = Number(req.headers['x-goog-upload-offset']);
        if (offset !== session.received) {
          fail(
            400,
            JSON.stringify({ error: { code: 400, message: `bad offset ${offset}, expected ${session.received}` } }),
          );
          return;
        }
        const body = await readBody(req);
        session.chunks.push(body);
        session.received += body.length;

        if (command?.includes('finalize')) {
          const token = `token-${(tokenCounter += 1)}`;
          tokenToHash.set(token, createHash('sha256').update(Buffer.concat(session.chunks)).digest('hex'));
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end(token);
        } else {
          res.writeHead(200, { 'x-goog-upload-status': 'active' });
          res.end('');
        }
        return;
      }

      // batchCreate.
      if (url.pathname === '/v1/mediaItems:batchCreate') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          newMediaItems: { simpleMediaItem: { fileName: string; uploadToken: string } }[];
        };
        if (body.newMediaItems.length > 50) {
          fail(400, JSON.stringify({ error: { code: 400, message: 'more than 50 items' } }));
          return;
        }
        const newMediaItemResults = body.newMediaItems.map((item) => {
          const { fileName, uploadToken } = item.simpleMediaItem;
          const hash = tokenToHash.get(uploadToken);
          if (!hash) {
            return { uploadToken, status: { code: 3, message: 'unknown upload token' } };
          }
          let id = options.dedupe ? hashToMediaId.get(hash) : undefined;
          if (!id) {
            id = `media-item-${(itemCounter += 1)}`;
            hashToMediaId.set(hash, id);
          }
          return {
            uploadToken,
            status: { message: 'Success' },
            mediaItem: { id, filename: fileName, productUrl: `https://photos.example/${id}` },
          };
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ newMediaItemResults }));
        return;
      }

      fail(404, JSON.stringify({ error: { code: 404, message: `no route for ${url.pathname}` } }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = baseUrlOf(server);
  return { server, baseUrl, seen, tokenToHash };
}

function baseUrlOf(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

interface RunResult {
  code: number | null;
  stdout: string;
  results: Record<string, any>;
}

async function runProbe(fake: Fake, extraArgs: string[], workDir: string): Promise<RunResult> {
  const credentialsPath = join(workDir, 'client_secret_fake.json');
  await writeFile(
    credentialsPath,
    JSON.stringify({
      installed: {
        client_id: '123456789012-fake.apps.googleusercontent.com',
        client_secret: 'fake-secret',
        project_id: 'pigeon-probe-test',
      },
    }),
  );
  const outPath = join(workDir, 'probe-results.json');

  const args = [
    '--import',
    'tsx',
    PROBE,
    '--credentials',
    credentialsPath,
    '--token',
    join(workDir, 'token.json'),
    '--out',
    outPath,
    ...extraArgs,
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PIGEON_PROBE_API_BASE: fake.baseUrl,
        PIGEON_PROBE_ACCESS_TOKEN: ACCESS_TOKEN,
        NO_COLOR: '1',
      },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(`${out}\n[exit ${code}]`));
  });

  let results: Record<string, any> = {};
  try {
    results = JSON.parse(await readFile(outPath, 'utf8')) as Record<string, any>;
  } catch {
    results = {};
  }
  return { code: 0, stdout, results };
}

let workDir: string | undefined;
let fake: Fake | undefined;

afterEach(async () => {
  fake?.server.close();
  fake = undefined;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = undefined;
});

describe('the probe, driven end to end against a fake Photos API', () => {
  it('reports DEDUP: NO when identical bytes come back as new items', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pigeon-e2e-'));
    fake = await startFake({ dedupe: false });
    const run = await runProbe(fake, ['--count', '20', '--dupes', '5', '--skip-large'], workDir);

    expect(run.stdout).toContain('DEDUP: NO');
    expect(run.results.findings.serverSideDedup.answer).toBe('NO');
    expect(run.results.findings.serverSideDedup.duplicateIdsMatched).toBe(0);
    expect(run.results.findings.serverSideDedup.duplicatesAttempted).toBe(5);
    // 20 unique files must land as 20 distinct ids, otherwise the generator is broken.
    expect(run.results.findings.serverSideDedup.distinctIdsAmongFirstBatch).toBe(20);
    expect(run.results.uploads.firstBatch).toHaveLength(20);
    expect(run.results.uploads.duplicateBatch).toHaveLength(5);
    // 20 uploads plus 5 re-uploads plus 2 batchCreate calls.
    expect(run.results.requests.total).toBe(27);
    expect(run.results.requests.byPhase['batch-first']).toBe(1);
    expect(run.results.requests.byPhase['batch-duplicates']).toBe(1);
  }, 60_000);

  it('reports DEDUP: YES when the server collapses identical bytes', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pigeon-e2e-'));
    fake = await startFake({ dedupe: true });
    const run = await runProbe(fake, ['--count', '6', '--dupes', '3', '--skip-large'], workDir);

    expect(run.stdout).toContain('DEDUP: YES');
    expect(run.results.findings.serverSideDedup.answer).toBe('YES');
    expect(run.results.findings.serverSideDedup.duplicateIdsMatched).toBe(3);
  }, 60_000);

  it('sends every file it generated, with no two files sharing bytes', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pigeon-e2e-'));
    fake = await startFake({ dedupe: false });
    const run = await runProbe(fake, ['--count', '20', '--dupes', '5', '--skip-large'], workDir);

    const uploadedHashes = [...fake.tokenToHash.values()];
    expect(uploadedHashes).toHaveLength(25);
    // 20 distinct files, 5 of them sent a second time byte for byte.
    expect(new Set(uploadedHashes).size).toBe(20);
    // What reached the server is exactly what the probe wrote down.
    const recorded = new Set(run.results.hashes.map((h: { sha256: string }) => h.sha256));
    for (const hash of uploadedHashes) expect(recorded.has(hash)).toBe(true);
  }, 60_000);

  it('chunks a large file correctly and counts every request', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pigeon-e2e-'));
    fake = await startFake({ dedupe: false });
    const run = await runProbe(
      fake,
      ['--count', '2', '--dupes', '1', '--large-mb', '3', '--chunk-kb', '256'],
      workDir,
    );

    const chunks = run.results.findings.resumableChunkQuota;
    expect(chunks.answer).toBe('MEASURE_IN_CONSOLE');
    expect(chunks.granularityBytes).toBe(262_144);
    expect(chunks.chunkBytes).toBe(262_144);
    expect(chunks.chunkCount).toBe(12); // 3 MB over 256 KB chunks
    expect(chunks.httpRequestsForOneFile).toBe(13); // plus the start call
    expect(chunks.metricsUrl).toContain('pigeon-probe-test');

    // The fake rejects an out of order offset, so reaching finalize proves the loop.
    const finalize = fake.seen.filter((r) => r.command?.includes('finalize'));
    expect(finalize).toHaveLength(1);
    expect(run.results.uploads.largeFile[0].ok).toBe(true);
    expect(run.stdout).toContain('1 start plus 12 chunks');
  }, 60_000);

  it('never asks the server to delete or modify anything', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pigeon-e2e-'));
    fake = await startFake({ dedupe: false });
    await runProbe(fake, ['--count', '3', '--dupes', '1', '--large-mb', '1', '--chunk-kb', '256'], workDir);

    for (const request of fake.seen) {
      expect(request.method).toBe('POST');
      expect(request.path).not.toContain('batchRemove');
      expect(request.path).not.toContain(':delete');
    }
  }, 60_000);

  it('prints the rclone 8567 box on a 403 and still writes results', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pigeon-e2e-'));
    fake = await startFake({
      dedupe: false,
      failWith: {
        status: 403,
        body: JSON.stringify({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Photos Library API has not been used in project 12345 before or it is disabled.',
          },
        }),
      },
    });
    const run = await runProbe(fake, ['--count', '3', '--dupes', '1', '--skip-large'], workDir);

    expect(run.stdout).toContain('HTTP 403');
    expect(run.stdout).toContain('not enabled');
    expect(run.stdout).toContain('apis/library/photoslibrary.googleapis.com?project=pigeon-probe-test');
    expect(run.results.findings.rclone8567.encountered).toBe(true);
    expect(run.results.findings.serverSideDedup.answer).toBe('INCONCLUSIVE');
    // A failed run still leaves a written record behind.
    expect(run.results.errors.length).toBeGreaterThan(0);
  }, 60_000);

  it('never writes a client secret or a token into the results file', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pigeon-e2e-'));
    fake = await startFake({ dedupe: false });
    const run = await runProbe(fake, ['--count', '2', '--dupes', '1', '--skip-large'], workDir);

    const raw = JSON.stringify(run.results);
    expect(raw).not.toContain('fake-secret');
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain('123456789012-fake.apps.googleusercontent.com');
    expect(run.results.client.clientIdMasked).toBe('123456...apps.googleusercontent.com');
  }, 60_000);
});
