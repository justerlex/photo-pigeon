import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashFile, hashFileWithStats } from './hash.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'pigeon-hash-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('matches the known sha256 of an empty file', async () => {
    const file = path.join(dir, 'empty.jpg');
    await fs.writeFile(file, '');
    await expect(hashFile(file)).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known sha256 of a small file', async () => {
    const file = path.join(dir, 'hello.jpg');
    await fs.writeFile(file, 'hello world');
    await expect(hashFile(file)).resolves.toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  it('streams a file larger than one read chunk without changing the digest', async () => {
    const file = path.join(dir, 'big.mp4');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await fs.writeFile(file, bytes);

    const expected = createHash('sha256').update(bytes).digest('hex');
    await expect(hashFile(file)).resolves.toBe(expected);
  });

  it('gives the same hash to the same bytes under a different name', async () => {
    const original = path.join(dir, 'IMG_0001.jpg');
    const renamed = path.join(dir, 'beach day.jpg');
    await fs.writeFile(original, 'same pixels');
    await fs.copyFile(original, renamed);

    expect(await hashFile(original)).toBe(await hashFile(renamed));
  });

  it('lets a missing file surface as ENOENT so callers can branch on it', async () => {
    await expect(hashFile(path.join(dir, 'gone.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('hashFileWithStats', () => {
  it('returns the hash next to the size and mtime', async () => {
    const file = path.join(dir, 'stat.jpg');
    await fs.writeFile(file, 'twelve bytes');

    const result = await hashFileWithStats(file);
    expect(result.hash).toBe(await hashFile(file));
    expect(result.size).toBe(12);
    expect(result.mtimeMs).toBeGreaterThan(0);
  });
});
