/**
 * mime.ts is the single source of truth for which files photo-pigeon will send
 * and which of them are video. Three copies of that answer used to exist, and
 * they disagreed: .tod is a camcorder video that one of them called a photo and
 * then refused at 200 MB. These tests hold the source honest.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_SUPPORTED_EXTENSIONS,
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  extensionOf,
  knownExtensions,
  mediaKindFor,
  mediaTypeFor,
} from './mime.js';

describe('the extension lists', () => {
  it('are lowercase, dotted and free of duplicates', () => {
    for (const ext of ALL_SUPPORTED_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith('.')).toBe(true);
      expect(ext.length).toBeGreaterThan(1);
    }
    expect(new Set(ALL_SUPPORTED_EXTENSIONS).size).toBe(ALL_SUPPORTED_EXTENSIONS.length);
  });

  it('do not overlap: a file is a photo or a video, never both', () => {
    const photos = new Set(PHOTO_EXTENSIONS);
    for (const ext of VIDEO_EXTENSIONS) expect(photos.has(ext)).toBe(false);
  });

  it('add up to the whole list', () => {
    expect(ALL_SUPPORTED_EXTENSIONS).toEqual([...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
    expect(knownExtensions()).toEqual([...ALL_SUPPORTED_EXTENSIONS].sort());
  });

  it('cover what people actually have on a camera and a phone', () => {
    for (const ext of ['.jpg', '.jpeg', '.png', '.heic', '.dng', '.cr3', '.arw']) {
      expect(PHOTO_EXTENSIONS).toContain(ext);
    }
    for (const ext of ['.mp4', '.mov', '.mkv', '.mts', '.tod', '.asf', '.3g2']) {
      expect(VIDEO_EXTENSIONS).toContain(ext);
    }
  });

  it('hands out a fresh array from knownExtensions, so sorting it cannot reorder the source', () => {
    const first = knownExtensions();
    first.push('.exe');
    expect(knownExtensions()).not.toContain('.exe');
    expect(ALL_SUPPORTED_EXTENSIONS).not.toContain('.exe');
  });
});

describe('extensionOf', () => {
  it('lowercases and keeps the dot', () => {
    expect(extensionOf('C:\\Users\\casey\\IMG_1.JPG')).toBe('.jpg');
    expect(extensionOf('/home/casey/clip.MP4')).toBe('.mp4');
  });

  it('says nothing when there is nothing to say', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('C:/holiday.2026/IMG_1')).toBe('');
  });
});

describe('classification', () => {
  it('calls the camcorder formats video, ceiling and all', () => {
    for (const name of ['clip.tod', 'clip.asf', 'clip.3g2', 'clip.mts', 'clip.m2ts']) {
      expect(mediaKindFor(name)).toBe('video');
    }
  });

  it('calls raw stills photos', () => {
    for (const name of ['a.dng', 'a.cr3', 'a.nef', 'a.heic']) {
      expect(mediaKindFor(name)).toBe('photo');
    }
  });

  it('does not pretend to know an extension it has never seen', () => {
    expect(mediaKindFor('notes.xyz')).toBe('unknown');
    expect(mediaTypeFor('notes.xyz').mime).toBe('application/octet-stream');
  });

  it('ignores case, because Windows does', () => {
    expect(mediaTypeFor('HOLIDAY.JPG').mime).toBe('image/jpeg');
    expect(mediaTypeFor('CLIP.3G2').mime).toBe('video/3gpp2');
  });

  it('gives every listed extension an honest media type', () => {
    for (const ext of PHOTO_EXTENSIONS) {
      const media = mediaTypeFor(`file${ext}`);
      expect(media.kind).toBe('photo');
      expect(media.mime.startsWith('image/')).toBe(true);
    }
    for (const ext of VIDEO_EXTENSIONS) {
      const media = mediaTypeFor(`file${ext}`);
      expect(media.kind).toBe('video');
      expect(media.mime.startsWith('video/')).toBe(true);
    }
  });
});
