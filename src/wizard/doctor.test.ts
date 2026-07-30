import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAppConfig, writeAppConfig, writeSetupRecord } from './config.js';
import {
  classifyClientIdleness,
  describeClientLock,
  type DoctorCheck,
  type DoctorReport,
  formatDoctorReport,
  IDLE_DELETE_DAYS,
  IDLE_WARNING_DAYS,
  runDoctor,
} from './doctor.js';
import { resolvePaths } from './paths.js';

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const DAY = 24 * 60 * 60 * 1000;

const credentialsJson = (clientId = CLIENT_ID): string =>
  JSON.stringify({
    installed: {
      client_id: clientId,
      project_id: 'photo-pigeon-uploads',
      client_secret: 'GOCSPX-notarealsecret',
      redirect_uris: ['http://localhost'],
    },
  });

let home: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-pigeon-doctor-'));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

/** Lays down a complete, healthy setup under the temp home. */
async function seedSetup(options: { clientId?: string; setupClientId?: string; tokenAgeDays?: number } = {}) {
  const paths = resolvePaths(home);
  const watchDir = path.join(home, 'Camera');
  await fsp.mkdir(watchDir, { recursive: true });
  await writeAppConfig(
    paths.configPath,
    normalizeAppConfig({
      watchDirs: [watchDir],
      credentialsPath: paths.credentialsPath,
      tokenPath: paths.tokenPath,
      ledgerPath: paths.ledgerPath,
    }),
  );
  await fsp.writeFile(paths.credentialsPath, credentialsJson(options.clientId), 'utf8');
  await writeSetupRecord(paths.setupPath, {
    clientId: options.setupClientId ?? options.clientId ?? CLIENT_ID,
    projectId: 'photo-pigeon-uploads',
    setupAt: new Date().toISOString(),
  });
  await fsp.writeFile(paths.tokenPath, '{"refresh_token":"not-a-real-token"}', 'utf8');
  if (options.tokenAgeDays) {
    const when = new Date(Date.now() - options.tokenAgeDays * DAY);
    await fsp.utimes(paths.tokenPath, when, when);
  }
  return { paths, watchDir };
}

const find = (report: DoctorReport, id: string): DoctorCheck | undefined =>
  report.checks.find((item) => item.id === id);

describe('classifyClientIdleness', () => {
  it('is content well inside the window', () => {
    expect(classifyClientIdleness(30).level).toBe('ok');
    expect(classifyClientIdleness(IDLE_WARNING_DAYS - 1).level).toBe('ok');
  });

  it('warns from the point Google starts emailing about deletion', () => {
    expect(classifyClientIdleness(IDLE_WARNING_DAYS).level).toBe('warn');
    expect(classifyClientIdleness(IDLE_DELETE_DAYS - 1).level).toBe('warn');
  });

  it('fails once the client may already be gone', () => {
    const verdict = classifyClientIdleness(IDLE_DELETE_DAYS);
    expect(verdict.level).toBe('fail');
    expect(verdict.detail).toMatch(/restored/);
  });

  /**
   * The verdict is read off the token file's date, because Google publishes no
   * way to ask when a client was last used. Every one of these lines has to
   * admit that rather than state idleness as fact.
   */
  it('says out loud that this is an estimate from the token file', () => {
    for (const days of [30, IDLE_WARNING_DAYS, IDLE_DELETE_DAYS]) {
      const verdict = classifyClientIdleness(days);
      expect(verdict.detail).toMatch(/as far as photo-pigeon can tell/i);
      expect(verdict.detail).toMatch(/token file/);
    }
  });
});

describe('describeClientLock', () => {
  it('is quiet when the client is the same one', () => {
    expect(describeClientLock(CLIENT_ID, CLIENT_ID).level).toBe('ok');
  });

  it('warns that history is orphaned when the client changed', () => {
    const verdict = describeClientLock(CLIENT_ID, 'other.apps.googleusercontent.com');
    expect(verdict.level).toBe('warn');
    expect(verdict.detail).toMatch(/invisible/);
  });
});

describe('runDoctor', () => {
  it('fails when there is no setup at all', async () => {
    const report = await runDoctor({ homeDir: home });
    expect(report.ok).toBe(false);
    expect(find(report, 'config')?.level).toBe('fail');
  });

  it('passes a healthy setup', async () => {
    await seedSetup();
    const report = await runDoctor({ homeDir: home });
    expect(report.ok).toBe(true);
    expect(find(report, 'credentials')?.level).toBe('ok');
    expect(find(report, 'client-lock')?.level).toBe('ok');
    expect(find(report, 'token')?.level).toBe('ok');
  });

  it('always reminds about publishing status and about storage', async () => {
    await seedSetup();
    const report = await runDoctor({ homeDir: home });
    const publishing = find(report, 'publishing-status');
    expect(publishing?.detail).toMatch(/invalid_grant/);
    expect(publishing?.link).toBe(
      'https://console.cloud.google.com/auth/audience?project=photo-pigeon-uploads',
    );
    expect(find(report, 'storage')?.detail).toMatch(/original quality|full size/);
  });

  /**
   * Two numbers show up on the status screen and only one of them is a byte
   * count. The ledger tally is the canonical one, and the request counter is
   * batchCreate calls, which is the only thing Google meters against the daily
   * Library API quota. Doctor has to keep those apart or the user reads the
   * small number as their storage.
   */
  it('calls the ledger tally canonical and the request count batchCreate only', async () => {
    await seedSetup();
    const report = await runDoctor({ homeDir: home });
    const storage = find(report, 'storage');
    expect(storage?.detail).toMatch(/ledger tally/);
    expect(storage?.detail).toMatch(/canonical/);
    expect(storage?.detail).toMatch(/batchCreate calls only/);
  });

  it('describes the token check as what was written, not as a fact from Google', async () => {
    await seedSetup();
    const report = await runDoctor({ homeDir: home });
    const token = find(report, 'token');
    expect(token?.title).toMatch(/token file/);
    expect(token?.detail).toMatch(/as far as photo-pigeon can tell/i);
  });

  it('explains the two failures it cannot see from here', async () => {
    await seedSetup();
    const report = await runDoctor({ homeDir: home });
    const pointer = find(report, 'if-uploads-fail');
    expect(pointer?.detail).toMatch(/SERVICE_DISABLED/);
    expect(pointer?.detail).toMatch(/Advanced Protection/);
    expect(pointer?.link).toBe(
      'https://console.cloud.google.com/apis/library/photoslibrary.googleapis.com?project=photo-pigeon-uploads',
    );
  });

  it('warns when the credentials were regenerated after setup', async () => {
    await seedSetup({ clientId: 'new.apps.googleusercontent.com', setupClientId: CLIENT_ID });
    const report = await runDoctor({ homeDir: home });
    expect(find(report, 'client-lock')?.level).toBe('warn');
  });

  it('warns when nothing has used the client in months', async () => {
    await seedSetup();
    const paths = resolvePaths(home);
    const stat = await fsp.stat(paths.tokenPath);
    const report = await runDoctor({ homeDir: home, now: stat.mtimeMs + IDLE_WARNING_DAYS * DAY });
    expect(find(report, 'token')?.level).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('warns when sign-in has not happened yet', async () => {
    await seedSetup();
    await fsp.rm(resolvePaths(home).tokenPath);
    const report = await runDoctor({ homeDir: home });
    expect(find(report, 'token')?.level).toBe('warn');
    expect(find(report, 'token')?.detail).toMatch(/photo-pigeon auth/);
  });

  it('fails on a Web client, which cannot do loopback sign-in', async () => {
    await seedSetup();
    const paths = resolvePaths(home);
    await fsp.writeFile(
      paths.credentialsPath,
      JSON.stringify({ web: { client_id: 'w.apps.googleusercontent.com', client_secret: 'x' } }),
      'utf8',
    );
    const report = await runDoctor({ homeDir: home });
    expect(report.ok).toBe(false);
    expect(find(report, 'credentials')?.level).toBe('fail');
  });

  it('fails when the credentials are gone', async () => {
    await seedSetup();
    await fsp.rm(resolvePaths(home).credentialsPath);
    const report = await runDoctor({ homeDir: home });
    expect(report.ok).toBe(false);
    expect(find(report, 'credentials')?.detail).toMatch(/ships no credentials/);
  });

  it('warns about a watched folder that is not mounted', async () => {
    const { watchDir } = await seedSetup();
    await fsp.rm(watchDir, { recursive: true });
    const report = await runDoctor({ homeDir: home });
    expect(find(report, 'watch-dir')?.level).toBe('warn');
    expect(report.ok).toBe(true);
  });
});

describe('formatDoctorReport', () => {
  it('prints every check and a closing verdict', async () => {
    await seedSetup();
    const report = await runDoctor({ homeDir: home });
    const text = formatDoctorReport(report);
    for (const item of report.checks) {
      expect(text).toContain(item.title);
    }
    expect(text).toMatch(/Nothing is broken/);
  });
});
