/**
 * The copy law, swept rather than remembered.
 *
 * TRAY-DESIGN section 0: no em dashes, warm plain English. It applies to menu
 * labels, toasts and window copy, and until M4 it was held by three things that
 * are all easy to forget: a unit test over the tray's rendered strings, a unit
 * test over the four toast bodies, and a manual sweep at review time.
 *
 * M4 adds the window pages, which are the biggest surface of human copy this
 * project has ever had and the only one written in a file type nothing was
 * checking. The M4 review's own note said the baseline was clean, so any em dash
 * that appears now is newly introduced, which is exactly the shape of thing a
 * test should be holding rather than a person.
 *
 * The directory moved from `app/src` to `app/ui` when the designed pages
 * landed, and this file moved with it rather than being left pointing at a
 * directory that no longer exists.
 *
 * Deliberately a file sweep and not a render: the point is that nobody can
 * introduce one anywhere in a shipped surface, including in a string this suite
 * never evaluates.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** U+2014. Named rather than pasted, so this file does not contain one. */
const EM_DASH = String.fromCharCode(0x2014);

/**
 * Every shipped surface, by directory and extension.
 *
 * `.json` joined the windows when the language scaffold moved
 * the page chrome into `app/ui/locales`. A locale file is the largest surface of
 * human copy this project has, and a translator who has never read this document
 * is exactly the person who will paste one in from a word processor.
 */
const SURFACES: { label: string; dir: string; extensions: string[] }[] = [
  {
    label: 'the windows',
    dir: join(REPO_ROOT, 'app', 'ui'),
    extensions: ['.html', '.js', '.css', '.json'],
  },
  { label: 'the tray shell', dir: join(REPO_ROOT, 'app', 'src-tauri', 'src'), extensions: ['.rs'] },
];

async function filesIn(dir: string, extensions: string[]): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await filesIn(full, extensions)));
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
  }
  return found;
}

describe('no em dashes in anything a person reads', () => {
  for (const surface of SURFACES) {
    it(`holds across ${surface.label}`, async () => {
      const files = await filesIn(surface.dir, surface.extensions);
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        if (!text.includes(EM_DASH)) continue;
        const line = text.slice(0, text.indexOf(EM_DASH)).split('\n').length;
        offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${line}`);
      }
      expect(offenders).toEqual([]);
    });
  }

  it('holds across the core, tests aside', async () => {
    // Tests may quote one to assert it is refused. Nothing shipped may carry
    // one, and dist/ is generated from exactly these files.
    const files = (await filesIn(join(REPO_ROOT, 'src'), ['.ts'])).filter(
      (file) => !file.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (text.includes(EM_DASH)) offenders.push(file.slice(REPO_ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});

describe('the windows do not depend on what the CSP allows', () => {
  it('carries no inline script and no style attribute', async () => {
    // The M4 review's note: `style-src 'self' 'unsafe-inline'` is acceptable
    // today and materially harder to tighten after pages ship. Nothing here
    // needs it, so nothing here uses it, and the way to keep that true is to
    // assert it rather than to intend it. Inline script is a separate matter
    // and is already forbidden by `default-src 'self'`, so a page that grew one
    // would simply not run; asserting it here means the failure is a red test
    // rather than a blank window.
    const pages = await filesIn(join(REPO_ROOT, 'app', 'ui'), ['.html']);
    expect(pages.length).toBeGreaterThanOrEqual(3);

    for (const page of pages) {
      const text = await readFile(page, 'utf8');
      expect(text, page).not.toMatch(/\sstyle\s*=\s*["']/);
      // A script element with a body, as opposed to one with a src.
      expect(text, page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
      expect(text, page).toMatch(/<link rel="stylesheet" href="pigeon\.css" \/>/);
    }
  });
});
