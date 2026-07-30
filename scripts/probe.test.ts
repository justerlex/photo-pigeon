/**
 * Tests for the pure parts of the probe.
 *
 * Nothing here touches the network or the filesystem. The point is narrow: if
 * the probe generates bad JPEGs or colliding hashes, its headline answer about
 * server side dedupe is worthless, so the generator gets checked before anyone
 * spends a Cloud project on it.
 */

import { describe, expect, it } from 'vitest';

import {
  buildProbeJpeg,
  diagnose403,
  findEoi,
  humanBytes,
  jpegTemplate,
  looksLikeJpeg,
  maskClientId,
  mimeForPath,
  planChunks,
  readJpegSize,
  sha256,
  wrap,
} from './probe.js';

describe('the built in JPEG template', () => {
  it('is a real, parseable JPEG and not a fake with a .jpg name', () => {
    const template = jpegTemplate();
    expect(template.length).toBeGreaterThan(100);
    expect(template[0]).toBe(0xff);
    expect(template[1]).toBe(0xd8);
    expect(looksLikeJpeg(template)).toBe(true);
  });

  it('reports its dimensions off the start of frame header', () => {
    const size = readJpegSize(jpegTemplate());
    expect(size).toBeDefined();
    expect(size!.width).toBeGreaterThan(0);
    expect(size!.height).toBeGreaterThan(0);
  });

  it('ends with EOI, with nothing after it', () => {
    const template = jpegTemplate();
    expect(findEoi(template)).toBe(template.length - 2);
  });
});

describe('probe file generation', () => {
  it('produces 20 files that are still valid JPEGs', () => {
    const template = jpegTemplate();
    for (let i = 0; i < 20; i += 1) {
      expect(looksLikeJpeg(buildProbeJpeg(template, `run-${i}`))).toBe(true);
    }
  });

  it('produces 20 distinct sha256 hashes, which the whole dedupe answer rests on', () => {
    const template = jpegTemplate();
    const hashes = new Set<string>();
    for (let i = 0; i < 20; i += 1) hashes.add(sha256(buildProbeJpeg(template, `run-${i}`)));
    expect(hashes.size).toBe(20);
  });

  it('keeps the template bytes untouched and varies only the tail past EOI', () => {
    const template = jpegTemplate();
    const generated = buildProbeJpeg(template, 'tag');
    expect(generated.subarray(0, template.length).equals(template)).toBe(true);
    expect(generated.length).toBeGreaterThan(template.length);
    // The first EOI is still the template's own, so decoders see the same image.
    expect(findEoi(generated)).toBe(template.length - 2);
  });

  it('re-hashing the same bytes gives the same hash, so the dedupe copies are honest', () => {
    const bytes = buildProbeJpeg(jpegTemplate(), 'fixed');
    expect(sha256(bytes)).toBe(sha256(Buffer.from(bytes)));
  });
});

describe('planChunks', () => {
  it('rounds the requested size down to a whole multiple of the granularity', () => {
    const plan = planChunks(25 * 1024 * 1024, 1_000_000, 262_144);
    expect(plan.chunkBytes % 262_144).toBe(0);
    expect(plan.chunkBytes).toBeLessThanOrEqual(1_000_000);
  });

  it('never goes below one granularity unit', () => {
    expect(planChunks(10_000_000, 1_000, 262_144).chunkBytes).toBe(262_144);
  });

  it('covers the whole file', () => {
    const total = 25 * 1024 * 1024;
    const plan = planChunks(total, 1024 * 1024, 262_144);
    expect(plan.chunkBytes * plan.chunkCount).toBeGreaterThanOrEqual(total);
    expect(plan.chunkBytes * (plan.chunkCount - 1)).toBeLessThan(total);
  });

  it('handles a server that states no granularity at all', () => {
    const plan = planChunks(5_000, 1_000, 0);
    expect(plan.chunkBytes).toBe(1_000);
    expect(plan.chunkCount).toBe(5);
  });

  it('always sends at least one chunk, even for an empty file', () => {
    expect(planChunks(0, 1024 * 1024, 262_144).chunkCount).toBe(1);
  });
});

describe('diagnose403', () => {
  it('names a disabled API and deep links the right project', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'Photos Library API has not been used in project 12345 before or it is disabled.',
      },
    });
    const diagnosis = diagnose403(body, 'pigeon-probe');
    expect(diagnosis.cause).toContain('not enabled');
    expect(diagnosis.fix.join(' ')).toContain('project=pigeon-probe');
  });

  it('names a stale token when the scope is insufficient', () => {
    const body = JSON.stringify({
      error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' },
    });
    expect(diagnose403(body, 'x').cause).toContain('appendonly');
  });

  it('names Advanced Protection and does not pretend it is fixable', () => {
    const diagnosis = diagnose403('{"error":{"message":"policy_enforced"}}', 'x');
    expect(diagnosis.cause).toContain('unverified');
    expect(diagnosis.fix.join(' ')).toContain('cannot be fixed');
  });

  it('falls back to the rclone 8567 checklist for an unnamed 403', () => {
    const diagnosis = diagnose403('{"error":{"message":"The caller does not have permission"}}', 'x');
    expect(diagnosis.fix.join(' ')).toContain('8567');
    expect(diagnosis.fix.length).toBeGreaterThanOrEqual(4);
  });

  it('survives a body that is not JSON at all', () => {
    expect(() => diagnose403('<html>502 Bad Gateway</html>', undefined)).not.toThrow();
    expect(diagnose403('nonsense', undefined).fix.join(' ')).toContain('YOUR_PROJECT_ID');
  });
});

describe('presentation helpers', () => {
  it('never writes a whole client id anywhere', () => {
    const masked = maskClientId('123456789012-abcdefghijklmnop.apps.googleusercontent.com');
    expect(masked).not.toContain('abcdefghijklmnop');
    expect(masked).toContain('apps.googleusercontent.com');
  });

  it('renders byte counts a person can read', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(25 * 1024 * 1024)).toBe('25.0 MB');
  });

  it('maps common photo and video extensions', () => {
    expect(mimeForPath('C:\\photos\\a.HEIC')).toBe('image/heic');
    expect(mimeForPath('/x/clip.mp4')).toBe('video/mp4');
    expect(mimeForPath('/x/mystery.bin')).toBe('image/jpeg');
  });

  it('wraps text without losing words', () => {
    const lines = wrap('one two three four five six seven eight nine ten', 12);
    expect(lines.join(' ').split(' ')).toHaveLength(10);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
  });
});

describe('the laws', () => {
  it('has no delete or mutate verb pointed at Google anywhere in the probe', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./probe.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/method:\s*['"]DELETE['"]/i);
    expect(source).not.toMatch(/mediaItems:batchRemove/i);
    expect(source).not.toMatch(/albums:batchRemoveMediaItems/i);
  });

  it('requests the appendonly scope and nothing else', async () => {
    const { OAUTH_SCOPES } = await import('../src/contracts.js');
    expect(OAUTH_SCOPES).toEqual(['https://www.googleapis.com/auth/photoslibrary.appendonly']);
  });

  it('contains no em dashes', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['./probe.ts', './probe.test.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(source.includes('\u2014')).toBe(false);
    }
  });
});
