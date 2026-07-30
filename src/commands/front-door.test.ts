/**
 * The front door, swept rather than remembered.
 *
 * M5's exit criterion is about a stranger: they download an installer from a
 * GitHub Release, get past SmartScreen because the page told them how, and back
 * up a folder. Everything in that sentence except the installer itself is
 * writing, and writing is the one part of this project with no compiler.
 *
 * So the README and CONTRIBUTING.md get the same treatment `copy-law.test.ts`
 * gives the windows and `ui-pages.test.ts` gives the pages: the promises that
 * matter are asserted rather than intended. Five of them have teeth.
 *
 *   1. **The storage sentence is the core's own, word for word.** It is imported
 *      from `watch.ts` rather than retyped, exactly as the pages import it, and
 *      every mention of Storage Saver in either document has to sit inside it.
 *      A paraphrase in the README is the same defect as a paraphrase in a window
 *      and it is easier to write, because prose invites tidying.
 *   2. **The installer comes first and npx comes second.** The stranger in the
 *      exit criterion is not a terminal user. Ordering is checked by position,
 *      because a README can name both and still bury the one a stranger needs.
 *   3. **The two clicks are named in the order they are made.** More info, then
 *      Run anyway. Reversed, the section is a riddle in front of a wall.
 *   4. **Every picture is in the tree, and none of it is a screenshot.** The
 *      capture plan was retired and the eight capture slots replaced with the
 *      setup wizard's own line drawings, copied out to `docs/art/`: a drawing is
 *      honest about being a drawing and it does not go stale the day Windows
 *      ships a redesign. So the slot rule inverts. Nothing may point at a file
 *      that is not there, and the mascot appears once rather than everywhere.
 *   5. **The pitch is above the first heading.** What this is, which platform,
 *      and which hole it fills, before a reader has scrolled or a search engine
 *      has stopped reading.
 *
 * Deliberately a file sweep and not a render, for the reason `copy-law.test.ts`
 * gives: the point is that nobody can quietly break one of these, including in a
 * paragraph nobody re-reads.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STORAGE_HONESTY } from './watch.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** U+2014. Named rather than pasted, so this file does not contain one. */
const EM_DASH = String.fromCharCode(0x2014);

function read(relative: string): Promise<string> {
  return readFile(join(REPO_ROOT, relative), 'utf8');
}

/** Markdown wraps its prose, so a sentence is compared with its wrapping gone. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function exists(relative: string): Promise<boolean> {
  try {
    await readFile(join(REPO_ROOT, relative));
    return true;
  } catch {
    return false;
  }
}

/** A document with its HTML comments taken out, so a reminder is not a claim. */
function uncommented(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Every image in a document, as alt text plus target.
 *
 * Both spellings, because the front door uses both: markdown for nothing at the
 * moment and `<img>` wherever a width or a centred block is wanted, which on
 * GitHub is the only way to have either.
 */
function images(markdown: string): { alt: string; src: string }[] {
  const found = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((match) => ({
    alt: match[1],
    src: match[2],
  }));

  for (const tag of markdown.matchAll(/<img\b[^>]*>/g)) {
    found.push({
      alt: /\balt="([^"]*)"/.exec(tag[0])?.[1] ?? '',
      src: /\bsrc="([^"]*)"/.exec(tag[0])?.[1] ?? '',
    });
  }
  return found;
}

/** A target that names a file in this repository rather than a web address. */
function inTree(src: string): boolean {
  return !/^https?:\/\//.test(src);
}

// ---------------------------------------------------------------------------
// the README
// ---------------------------------------------------------------------------

describe('the README is the front door', () => {
  it('says the storage sentence word for word, and paraphrases it nowhere', async () => {
    const readme = flatten(await read('README.md'));
    expect(readme).toContain(STORAGE_HONESTY);
    // Every Storage Saver in the document is inside that sentence. The old
    // README had a second, longer version of the same claim, which is how a
    // sentence with one source of truth ends up with two wordings.
    expect(occurrences(readme, 'Storage Saver')).toBe(occurrences(readme, STORAGE_HONESTY));
  });

  it('offers both install paths and puts the installer first', async () => {
    const readme = await read('README.md');
    const releases = readme.indexOf('/releases');
    const npx = readme.indexOf('npx photo-pigeon');
    expect(releases, 'the README links a GitHub Release').toBeGreaterThan(-1);
    expect(npx, 'the README keeps the npx path for terminal people').toBeGreaterThan(-1);
    expect(releases, 'the installer is the first path a stranger meets').toBeLessThan(npx);
  });

  it('names the two clicks past SmartScreen, in the order they are made', async () => {
    const readme = flatten(await read('README.md'));
    const moreInfo = readme.indexOf('More info');
    const runAnyway = readme.indexOf('Run anyway');
    expect(moreInfo).toBeGreaterThan(-1);
    expect(runAnyway).toBeGreaterThan(-1);
    expect(moreInfo, 'More info is the first click').toBeLessThan(runAnyway);
    // What the box actually says, and why it says it. TRAY-DESIGN section 5:
    // pre-warn before the user meets the wall, and do not apologise for it.
    expect(readme).toContain('Unknown publisher');
    expect(readme).toContain('SignPath');
  });

  it('shows nothing it does not have, and says what each picture is', async () => {
    const readme = await read('README.md');
    const local = images(readme).filter((image) => inTree(image.src));
    // The mascot, and at least the wall, which is the one drawing the install
    // section cannot do without.
    expect(local.length).toBeGreaterThanOrEqual(2);

    for (const image of local) {
      expect(await exists(image.src), `${image.src} is pointed at and is not there`).toBe(true);
      expect(image.alt.length, `${image.src} needs alt text a person can read`).toBeGreaterThan(20);
    }

    // The capture plan is dead, and a stale path to a directory that no longer
    // exists is how it would come back one image at a time.
    expect(readme).not.toContain('docs/captures/');
    expect(local.filter((image) => image.src.startsWith('docs/art/')).length).toBeGreaterThan(0);
  });

  it('carries the mascot once, at the top, rather than scattered', async () => {
    // The whole of the cutesie factor
    // is spent in one place on purpose: a mascot per section is a brochure.
    const readme = await read('README.md');
    expect(occurrences(readme, 'pigeon-mascot.png')).toBe(1);
    expect(readme.indexOf('pigeon-mascot.png')).toBeLessThan(readme.indexOf('\n## '));
  });

  it('wears a small badge row and no badge that lies', async () => {
    const readme = uncommented(await read('README.md'));
    const badges = images(readme).filter((image) => image.src.startsWith('https://img.shields.io/'));
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(badges.length, 'four badges is the ceiling, and calm is the point').toBeLessThanOrEqual(
      4,
    );

    // The package is not published yet, so a version badge would render an error
    // or a lie, and either is worse than the empty space. The reminder to add it
    // lives in an HTML comment, which is why the comments came out first.
    expect(badges.some((badge) => badge.src.includes('/npm/'))).toBe(false);
    expect(await read('README.md')).toContain('img.shields.io/npm/v/photo-pigeon');
  });

  it('says what this is, where it runs and what it replaces, before the first heading', async () => {
    const readme = await read('README.md');
    const first = readme.indexOf('\n## ');
    expect(first).toBeGreaterThan(-1);
    const above = flatten(readme.slice(0, first));

    expect(above).toContain('Google Photos');
    expect(above).toContain('Windows');
    expect(above).toContain('Drive for desktop');
    expect(above).toMatch(/folder/i);
  });

  it('holds the community door open, with credit attached', async () => {
    // Project decision: easy translation PRs as a
    // community door. One file is a whole translation, and a merged translator is
    // credited here and in the release notes.
    const readme = flatten(await read('README.md'));
    expect(readme).toContain('app/ui/locales');
    expect(readme).toContain('CONTRIBUTING.md');
    expect(readme).toContain('release notes');
  });

  it('states the three laws a user should know', async () => {
    const readme = flatten(await read('README.md'));
    // Never deletes, the ledger is local, and an uninstall leaves the archive
    // alone. All three are laws in TRAY-DESIGN section 0 and section 5, and all
    // three are what a person is really asking when they hand over their photos.
    expect(readme).toContain('photoslibrary.appendonly');
    expect(readme).toContain('ledger.jsonl');
    expect(readme).toMatch(/uninstall/i);
    expect(readme).toContain('~/.photo-pigeon');
  });

  it('tells a developer how to get from a clone to both suites', async () => {
    const readme = flatten(await read('README.md'));
    expect(readme).toContain('npm ci');
    expect(readme).toContain('npm test');
    expect(readme).toContain('cargo test');
    // The worktree trap, in the document a newcomer reads first: the two staged
    // paths are gitignored, so a fresh clone cannot build the shell until the
    // sidecar script has run.
    expect(readme).toContain('node app/scripts/build-sidecar.mjs');
  });
});

// ---------------------------------------------------------------------------
// CONTRIBUTING
// ---------------------------------------------------------------------------

describe('CONTRIBUTING is the short version', () => {
  it('names both suites and the sidecar staging between them', async () => {
    const guide = flatten(await read('CONTRIBUTING.md'));
    expect(guide).toContain('npm ci');
    expect(guide).toContain('npm test');
    expect(guide).toContain('cargo test');
    expect(guide).toContain('node app/scripts/build-sidecar.mjs');
  });

  it('carries the translation recipe end to end', async () => {
    const guide = flatten(await read('CONTRIBUTING.md'));
    expect(guide).toContain('app/ui/locales/en.json');
    expect(guide).toContain('app/ui/i18n.js');
    expect(guide).toContain('LOCALES');
  });

  it('states the copy laws a PR has to respect', async () => {
    const guide = flatten(await read('CONTRIBUTING.md'));
    expect(guide).toContain('em dash');
    expect(guide).toMatch(/[Ss]entence case/);
    // The sentence itself, so a contributor can compare rather than trust their
    // memory of it, and every mention of Storage Saver is inside it here too.
    expect(guide).toContain(STORAGE_HONESTY);
    expect(occurrences(guide, 'Storage Saver')).toBe(occurrences(guide, STORAGE_HONESTY));
  });
});

// ---------------------------------------------------------------------------
// the translation door
// ---------------------------------------------------------------------------

/** Every `{token}` in a string, sorted, so two strings can be compared. */
function tokensOf(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

/**
 * What is wrong with a translated table, against the English one.
 *
 * The three faults a real translation PR arrives with, and none of them is the
 * translator's fault so much as the format's: a key English does not have, a
 * value that is not a string, and a `{token}` that lost a brace or changed its
 * name. Everything else is allowed, including a mostly empty file, because
 * `i18n.js` falls back key by key and a half finished translation is a useful
 * contribution.
 */
function faultsIn(
  english: Record<string, unknown>,
  translated: Record<string, unknown>,
  label: string,
): string[] {
  const faults: string[] = [];
  for (const [key, value] of Object.entries(translated)) {
    if (!(key in english)) {
      faults.push(`${label}: ${key} is not a key en.json has`);
      continue;
    }
    if (typeof value !== 'string') {
      faults.push(`${label}: ${key} is not a string`);
      continue;
    }
    const wanted = tokensOf(String(english[key]));
    const found = tokensOf(value);
    if (wanted.join(',') !== found.join(',')) {
      faults.push(`${label}: ${key} wants {${wanted.join('} {')}} and has {${found.join('} {')}}`);
    }
  }
  return faults;
}

describe('the translation door is real', () => {
  it('catches the three faults a locale file arrives with', () => {
    // CONTRIBUTING.md promises a translator that `npm test` checks their file.
    // With English as the only shipped locale the sweep below has nothing to
    // read, so the promise is held by proving the comparison itself rather than
    // by a run that passes because there is no work in it.
    const english = { 'a.sent': 'Sent {count} of {total}', 'a.plain': 'Watching' };

    expect(faultsIn(english, { 'a.sent': 'Envoye {nombre} de {total}' }, 'fr')).toHaveLength(1);
    expect(faultsIn(english, { 'a.sent': 'Envoye count} de {total}' }, 'fr')).toHaveLength(1);
    expect(faultsIn(english, { 'a.nope': 'Rien' }, 'fr')).toHaveLength(1);
    expect(faultsIn(english, { 'a.plain': 42 }, 'fr')).toHaveLength(1);

    // And the shapes that are fine: a moved token, and a file with one line in it.
    expect(faultsIn(english, { 'a.sent': 'De {total}, {count} envoyes' }, 'fr')).toEqual([]);
    expect(faultsIn(english, { 'a.plain': 'En surveillance' }, 'fr')).toEqual([]);
  });

  it('holds across every locale file this build ships', async () => {
    const dir = join(REPO_ROOT, 'app', 'ui', 'locales');
    const english = JSON.parse(await read('app/ui/locales/en.json')) as Record<string, unknown>;
    const others = (await readdir(dir)).filter(
      (name) => name.endsWith('.json') && name !== 'en.json',
    );

    const faults: string[] = [];
    for (const name of others) {
      const table = JSON.parse(await read(`app/ui/locales/${name}`)) as Record<string, unknown>;
      faults.push(...faultsIn(english, table, name));
    }
    expect(faults).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the copy law over the documents
// ---------------------------------------------------------------------------

describe('no em dashes in the documents either', () => {
  /** Every file under a directory whose name ends one of these ways. */
  async function filesIn(dir: string, ...endings: string[]): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(join(REPO_ROOT, dir), { withFileTypes: true });
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push(...(await filesIn(relative, ...endings)));
        continue;
      }
      if (endings.some((ending) => entry.name.endsWith(ending))) found.push(relative);
    }
    return found;
  }

  it('holds across every document in the repository', async () => {
    // The art is swept with the prose because it is prose: the drawings in
    // docs/art carry the words a reader meets under the heading they illustrate.
    const files = [
      'README.md',
      'CONTRIBUTING.md',
      'PROBE.md',
      ...(await filesIn('docs', '.md', '.svg')),
      ...(await filesIn('app/e2e', '.md')),
    ];
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await read(file);
      if (!text.includes(EM_DASH)) continue;
      offenders.push(`${file}:${text.slice(0, text.indexOf(EM_DASH)).split('\n').length}`);
    }
    expect(offenders).toEqual([]);
  });

  it('holds across the workflows, before there are any', async () => {
    // The guard arrives ahead of the files on purpose. M5 adds
    // .github/workflows, and a YAML file is the one shipped surface nothing here
    // has ever swept: no compiler reads it and a job name is human copy.
    // An empty list passes, which is what makes this cheap to have early.
    let files: string[] = [];
    try {
      files = (await readdir(join(REPO_ROOT, '.github', 'workflows'))).filter(
        (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
      );
    } catch {
      files = [];
    }

    const offenders: string[] = [];
    for (const name of files) {
      const text = await read(`.github/workflows/${name}`);
      if (text.includes(EM_DASH)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
