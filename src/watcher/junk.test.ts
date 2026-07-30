import { describe, expect, it } from 'vitest';

import {
  hasAllowedExtension,
  hasAllowedExtensionNormalized,
  isJunkName,
  isJunkPath,
  isUploadable,
  normalizeExtensions,
} from './junk.js';

describe('isJunkName', () => {
  it('rejects the office and download half-written files', () => {
    expect(isJunkName('~$report.docx')).toBe(true);
    expect(isJunkName('holiday.jpg.tmp')).toBe(true);
    expect(isJunkName('beach.jpg.crdownload')).toBe(true);
    expect(isJunkName('beach.jpg.partial')).toBe(true);
    expect(isJunkName('beach.jpg.part')).toBe(true);
  });

  it('rejects windows and mac shell bookkeeping, whatever the casing', () => {
    expect(isJunkName('desktop.ini')).toBe(true);
    expect(isJunkName('Desktop.ini')).toBe(true);
    expect(isJunkName('Thumbs.db')).toBe(true);
    expect(isJunkName('THUMBS.DB')).toBe(true);
    expect(isJunkName('.DS_Store')).toBe(true);
    expect(isJunkName('$RECYCLE.BIN')).toBe(true);
    expect(isJunkName('System Volume Information')).toBe(true);
  });

  it('rejects hidden dotfiles and editor backups', () => {
    expect(isJunkName('.hidden.jpg')).toBe(true);
    expect(isJunkName('.git')).toBe(true);
    expect(isJunkName('photo.jpg~')).toBe(true);
  });

  it('accepts ordinary photos and ordinary folders', () => {
    expect(isJunkName('IMG_0421.JPG')).toBe(false);
    expect(isJunkName('sunset.heic')).toBe(false);
    expect(isJunkName('Holiday 2026')).toBe(false);
    expect(isJunkName('a.file.with.dots.jpg')).toBe(false);
  });

  it('reads the basename out of a full path', () => {
    expect(isJunkPath('C:\\Users\\casey\\Pictures\\IMG_1.jpg'.replace(/\\/g, '/'))).toBe(false);
    expect(isJunkPath('/home/casey/pics/Thumbs.db')).toBe(true);
  });
});

describe('normalizeExtensions', () => {
  it('lowercases, adds the leading dot, drops blanks and repeats', () => {
    expect(normalizeExtensions(['.JPG', 'png', ' .HEIC ', '', '.jpg'])).toEqual([
      '.jpg',
      '.png',
      '.heic',
    ]);
  });
});

describe('hasAllowedExtension', () => {
  const extensions = ['.jpg', '.heic', '.mp4'];

  it('matches case-insensitively in both directions', () => {
    expect(hasAllowedExtension('IMG_0001.JPG', extensions)).toBe(true);
    expect(hasAllowedExtension('clip.MP4', extensions)).toBe(true);
    expect(hasAllowedExtension('note.txt', extensions)).toBe(false);
    expect(hasAllowedExtension('sunset.heic', ['.HEIC'])).toBe(true);
  });

  it('rejects files with no extension at all', () => {
    expect(hasAllowedExtension('README', extensions)).toBe(false);
  });

  it('accepts everything when the list is empty', () => {
    expect(hasAllowedExtension('anything.xyz', [])).toBe(true);
  });

  it('has a pre-normalized twin for hot loops', () => {
    expect(hasAllowedExtensionNormalized('IMG.JPG', ['.jpg'])).toBe(true);
    expect(hasAllowedExtensionNormalized('IMG.gif', ['.jpg'])).toBe(false);
  });
});

describe('isUploadable', () => {
  it('needs both a clean name and an accepted extension', () => {
    expect(isUploadable('/pics/IMG_1.jpg', ['.jpg'])).toBe(true);
    expect(isUploadable('/pics/~$IMG_1.jpg', ['.jpg'])).toBe(false);
    expect(isUploadable('/pics/IMG_1.txt', ['.jpg'])).toBe(false);
  });
});
