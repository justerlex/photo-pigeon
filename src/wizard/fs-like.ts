/**
 * The narrow slice of node:fs/promises the wizard uses, as an interface, so
 * tests can hand in a fake or point at a temp directory without monkey patching
 * modules.
 */

import fsp from 'node:fs/promises';

/** Just enough of a stat result for what the wizard and doctor need to know. */
export interface StatLike {
  mtimeMs: number;
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The file system operations the wizard performs. Nothing here deletes user data. */
export interface FsLike {
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  stat(target: string): Promise<StatLike>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** The real thing, backed by node:fs/promises. */
export const nodeFs: FsLike = {
  async mkdir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  },
  readdir(dir) {
    return fsp.readdir(dir);
  },
  stat(target) {
    return fsp.stat(target);
  },
  readFile(file) {
    return fsp.readFile(file, 'utf8');
  },
  async writeFile(file, data, mode) {
    await fsp.writeFile(file, data, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
  },
  rename(from, to) {
    return fsp.rename(from, to);
  },
};

/** True when the path exists and is a readable file. */
export async function fileExists(file: string, fs: FsLike = nodeFs): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** True when the path exists and is a directory. */
export async function dirExists(dir: string, fs: FsLike = nodeFs): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
