/**
 * The language scaffold, held to the one promise it makes in this round.
 *
 * TRAY-DESIGN's i18n section: the page chrome moves into
 * `app/ui/locales/en.json` behind a tiny `t()`, a switcher slot sits top right
 * of the setup page, and **with English as the only locale nothing visible
 * changes anywhere.** That last clause is the whole risk of this round. An
 * extraction pass touches every sentence in the product, in a file type no
 * compiler reads, and the failure it invites is silent: a key that does not
 * exist, a sentence that lost a word on the way into JSON, a `{count}` left
 * standing in front of a user.
 *
 * So the checks below hold four things:
 *
 *   * **the keys resolve.** Every `data-i18n` and `data-i18n-attr` key in the
 *     three pages, and every key a page script asks `t()` for, exists in
 *     `en.json`. A key that does not is a string that renders as whatever the
 *     fallback happens to be, in one state nobody opens.
 *   * **the English did not move.** Each key's value in `en.json` is the text
 *     that stands in the page, word for word once HTML wrapping is collapsed.
 *     This is what makes "byte identical English" a test rather than a claim, and
 *     it is the check that catches a paraphrase during extraction.
 *   * **the fallback rule.** A missing key shows English, never a key name, and a
 *     token with no value is left visible rather than silently emptied.
 *   * **the scaffold is inert.** One locale in the registry means no switcher is
 *     built, and a remembered locale that the build no longer ships is ignored
 *     rather than honoured.
 *
 * `ui-pages.test.ts` holds the wiring and the laws over the same directory, and
 * `copy-law.test.ts` sweeps the locale files for em dashes along with the rest of
 * the shipped surfaces. This file is only about the language seam.
 *
 * **Not extracted, on purpose, and each absence is a rule rather than an
 * omission.** The storage honesty sentence, the wizard's prose, the status and
 * storage lines, the doctor rows and every error the core or the shell hands over
 * render as received: they arrive over the machine channel from another process,
 * the copy law says a window is a surface for them and not a second author, and
 * carrying message keys on those events is the first item of the v0.2 milestone
 * in TRAY-DESIGN section 6. The window titles belong to `windows.rs` and travel
 * with the Rust strings in the same milestone.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { STORAGE_HONESTY } from './watch.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const UI = join(REPO_ROOT, 'app', 'ui');

/** The three real pages, each with the script that drives it. */
const PAGES = ['setup', 'status', 'health'] as const;

const read = (relative: string): Promise<string> => readFile(join(UI, relative), 'utf8');

async function english(): Promise<Record<string, string>> {
  return JSON.parse(await read(join('locales', 'en.json'))) as Record<string, string>;
}

/** Collapse the whitespace an HTML author uses for wrapping, so a sentence can be compared. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Every `data-i18n` key in a page, with the text it stands in front of. */
function textKeys(html: string): { key: string; text: string }[] {
  const found: { key: string; text: string }[] = [];
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>/g)) {
    const [tag, name, key] = [match[0], match[1], match[2]];
    const opens = (match.index ?? 0) + tag.length;
    const closes = html.indexOf(`</${name}>`, opens);
    found.push({ key, text: closes < 0 ? '' : html.slice(opens, closes) });
  }
  return found;
}

/** Every `attribute:key` pair in a page, with the attribute's current value. */
function attrKeys(html: string): { key: string; text: string }[] {
  const found: { key: string; text: string }[] = [];
  for (const match of html.matchAll(/<[a-zA-Z][\w-]*\b[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g)) {
    for (const pair of match[1].split(',')) {
      const colon = pair.indexOf(':');
      if (colon < 1) continue;
      const name = pair.slice(0, colon).trim();
      const key = pair.slice(colon + 1).trim();
      const value = new RegExp(`\\s${name}="([^"]*)"`).exec(match[0]);
      found.push({ key, text: value ? value[1] : '' });
    }
  }
  return found;
}

/** Every key a script asks `t()` for. */
function scriptKeys(js: string): string[] {
  return [...js.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]);
}

/**
 * Every `t()` call whose English is a plain literal, with that English.
 *
 * A call site writes its own English as the second argument, which is what
 * renders today: English never loads a table, so `en.json`'s value for a script
 * key is read by nobody but a translator. That is exactly why it has to be
 * compared with the literal. A translator working from a sentence the product
 * does not say produces a translation of something else.
 *
 * Literals joined with `+` are one sentence written across several lines, so they
 * are read as one. A call whose English is anything other than literals is
 * skipped rather than guessed at.
 */
function callSites(js: string): { key: string; english: string }[] {
  const found: { key: string; english: string }[] = [];
  const literals = /^\s*'(?:[^'\\]|\\.)*'(?:\s*\+\s*'(?:[^'\\]|\\.)*')*/;

  for (const match of js.matchAll(/\bt\(\s*'([^']+)'\s*,/g)) {
    const rest = js.slice((match.index ?? 0) + match[0].length);
    const run = literals.exec(rest);
    if (!run) continue;
    // The argument has to end here, or what was matched is only part of it.
    if (!/^\s*[,)]/.test(rest.slice(run[0].length))) continue;
    const english = [...run[0].matchAll(/'((?:[^'\\]|\\.)*)'/g)]
      .map((piece) => piece[1].replace(/\\(['\\])/g, '$1'))
      .join('');
    found.push({ key: match[1], english });
  }
  return found;
}

/*
 * `i18n.js` in a context of its own.
 *
 * It is a classic browser script that hangs one object off `window`, which is
 * exactly what makes it loadable here: a fresh context, a fake `window` holding
 * the storage it persists into, and a `document` that answers every sweep with
 * nothing. No jsdom and no bundler, so what runs in the test is the same file
 * the window loads rather than a transformed copy of it.
 */
interface Helper {
  t(key: string, english?: string, values?: Record<string, unknown>): string;
  resolve(
    from: Record<string, string>,
    key: string,
    english?: string,
    values?: Record<string, unknown>,
  ): string;
  apply(root: unknown, lookup?: (key: string, english: string) => string): void;
  ready: Promise<string>;
  locale(): string;
  locales(): { code: string; label: string }[];
}

async function helper(stored?: string): Promise<Helper> {
  const source = await read('i18n.js');
  const written = new Map<string, string>();
  if (stored !== undefined) written.set('photo-pigeon.locale', stored);

  const sandbox = {
    window: {
      localStorage: {
        getItem: (key: string) => written.get(key) ?? null,
        setItem: (key: string, value: string) => void written.set(key, value),
      },
    },
    document: {
      querySelectorAll: () => [] as unknown[],
      documentElement: { setAttribute: () => undefined },
    },
  };

  runInNewContext(source, sandbox);
  const loaded = (sandbox.window as unknown as { pigeonI18n: Helper }).pigeonI18n;
  await loaded.ready;
  return loaded;
}

// ---------------------------------------------------------------------------
// the keys resolve
// ---------------------------------------------------------------------------

describe('every key the pages ask for exists in English', () => {
  it('resolves every data-i18n key in the three pages', async () => {
    const table = await english();
    const missing: string[] = [];
    for (const page of PAGES) {
      const html = await read(`${page}.html`);
      for (const { key } of [...textKeys(html), ...attrKeys(html)]) {
        if (!(key in table)) missing.push(`${page}.html: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('resolves every key the three scripts ask t() for', async () => {
    const table = await english();
    const missing: string[] = [];
    for (const page of PAGES) {
      for (const key of scriptKeys(await read(`${page}.js`))) {
        if (!(key in table)) missing.push(`${page}.js: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('carries no key nobody uses', async () => {
    // A dead key is a sentence a translator is asked to translate for nothing,
    // and the first one makes the file impossible to review.
    const table = await english();
    const used = new Set<string>();
    for (const page of PAGES) {
      const html = await read(`${page}.html`);
      for (const { key } of [...textKeys(html), ...attrKeys(html)]) used.add(key);
      for (const key of scriptKeys(await read(`${page}.js`))) used.add(key);
    }
    // The switcher's own label is built in `i18n.js` and belongs to no page.
    for (const key of scriptKeys(await read('i18n.js'))) used.add(key);
    expect(Object.keys(table).filter((key) => !used.has(key))).toEqual([]);
  });

  it('is a flat file of strings, which is what a translator is handed', async () => {
    const table = await english();
    expect(Object.keys(table).length).toBeGreaterThan(40);
    const notAString = Object.entries(table).filter(([, value]) => typeof value !== 'string');
    expect(notAString).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the English did not move
// ---------------------------------------------------------------------------

describe('the visible English is the English in the file', () => {
  for (const page of PAGES) {
    it(`${page}.html says exactly what en.json says`, async () => {
      const table = await english();
      const html = await read(`${page}.html`);
      const drifted: string[] = [];
      for (const { key, text } of [...textKeys(html), ...attrKeys(html)]) {
        if (!(key in table)) continue;
        if (flatten(text) !== flatten(table[key])) {
          drifted.push(`${key}: page has ${JSON.stringify(flatten(text))}`);
        }
      }
      expect(drifted).toEqual([]);
    });
  }

  for (const page of PAGES) {
    it(`${page}.js says exactly what en.json says`, async () => {
      const table = await english();
      const drifted: string[] = [];
      const sites = callSites(await read(`${page}.js`));
      // A page with no built strings would pass this test by having nothing in
      // it, so the sweep says how much it swept.
      expect(sites.length, `${page}.js has no t() call with a literal English`).toBeGreaterThan(2);
      for (const { key, english: literal } of sites) {
        if (key in table && table[key] !== literal) {
          drifted.push(`${key}: the call site says ${JSON.stringify(literal)}`);
        }
      }
      expect(drifted).toEqual([]);
    });
  }

  it('gives every t() call its English at the call site', async () => {
    // A `t('some.key')` with no second argument is a string that renders empty
    // the day its key is missing, which is the one failure this scaffold exists
    // to make impossible.
    for (const page of [...PAGES, 'i18n']) {
      const js = await read(`${page}.js`);
      const bare = [...js.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
      expect(bare, `${page}.js`).toEqual([]);
    }
  });

  it('leaves no page sentence unkeyed, which is how the extraction misses one', async () => {
    // The other direction, and the one the checks above cannot see. They start
    // from a key and ask whether it resolves, so a sentence with no key at all is
    // invisible to every one of them: it renders in English forever and turns up
    // as an English line in a translated window, which is the shape of every
    // half-done extraction anybody has ever shipped.
    //
    // A page's own copy reaches the DOM by being assigned to `textContent`, so
    // that is what is swept. A literal on the right of one is page copy that never
    // went through `t()`. Text taken off the page itself, or a value another
    // process sent, is not a literal and is not caught here, which is right: those
    // are the sentences the copy law says a window renders as received.
    const unkeyed: string[] = [];
    for (const page of PAGES) {
      const js = await read(`${page}.js`);
      for (const match of js.matchAll(/\.textContent\s*=\s*\n?\s*(['"`])((?:[^\\]|\\.)*?)\1/g)) {
        // A template that interpolates is composed from values rather than
        // authored, so it is not the sentence anybody would translate: the setup
        // page grows one of its own lines by appending to it.
        if (match[1] === '`' && match[2].includes('${')) continue;
        unkeyed.push(`${page}.js: ${match[2].slice(0, 60)}`);
      }
      // The same sentence hiding behind a fallback. `x.textContent = value ||
      // 'literal'` renders the literal in exactly the state nobody opens, which
      // is where an unkeyed sentence waits for a translated window. The empty
      // string is not a sentence, so `|| ''` stays what it is: a field with
      // nothing to say.
      for (const match of js.matchAll(
        /\.textContent\s*=[^;\n]*?(?:\|\||\?\?)\s*(['"`])((?:[^\\\n]|\\.)+?)\1/g,
      )) {
        if (match[1] === '`' && match[2].includes('${')) continue;
        unkeyed.push(`${page}.js: ${match[2].slice(0, 60)}`);
      }
    }
    expect(unkeyed).toEqual([]);
  });

  it('leaves the sentences another process owns alone', async () => {
    // The copy law: the storage honesty sentence is never paraphrased, and the
    // window renders it as the core sends it. A key for it here would be a
    // second copy of the one sentence this project is most tempted to soften.
    const table = await english();
    const values = Object.values(table);
    expect(values).not.toContain(STORAGE_HONESTY);
    for (const value of values) {
      expect(value, 'a core sentence leaked into the locale file').not.toContain(
        'count against your Google storage',
      );
    }
  });

  it('marks only leaves, so a sweep cannot eat a child element', async () => {
    // `apply` writes `textContent`, which replaces everything inside the element.
    // A `data-i18n` on a paragraph that holds a span would delete the span in
    // every language except English, where the sweep never runs.
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const { key, text } of textKeys(await read(`${page}.html`))) {
        if (text.includes('<')) offenders.push(`${page}.html: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the fallback rule
// ---------------------------------------------------------------------------

describe('a missing key shows English and never a key name', () => {
  it('prefers the locale, falls back to the English at the call site', async () => {
    const i18n = await helper();
    const table = { 'a.key': 'Ya perevyol' };
    expect(i18n.resolve(table, 'a.key', 'The English')).toBe('Ya perevyol');
    expect(i18n.resolve(table, 'another.key', 'The English')).toBe('The English');
  });

  it('never renders the key itself, even with nothing to fall back on', async () => {
    const i18n = await helper();
    expect(i18n.resolve({}, 'status.watching.empty')).toBe('');
    expect(i18n.resolve({}, 'status.watching.empty', undefined)).not.toContain('status.');
  });

  it('ignores a translation that is not a string', async () => {
    const i18n = await helper();
    const table = { 'a.key': 12 } as unknown as Record<string, string>;
    expect(i18n.resolve(table, 'a.key', 'The English')).toBe('The English');
  });

  it('fills tokens and leaves an unfilled one standing', async () => {
    const i18n = await helper();
    expect(i18n.resolve({}, 'k', 'Step {index} of {total}', { index: 2, total: 5 })).toBe(
      'Step 2 of 5',
    );
    // Visible rather than silently empty: a token with no value is a bug report.
    expect(i18n.resolve({}, 'k', 'Step {index} of {total}', { index: 2 })).toBe(
      'Step 2 of {total}',
    );
  });

  it('leaves a token standing rather than writing out the word undefined', async () => {
    // The engine line hands over a version that is often not there, and a
    // translator who puts `{version}` in a sentence that has none would otherwise
    // ship the word undefined to a user.
    const i18n = await helper();
    expect(i18n.resolve({}, 'k', 'Engine: process {pid}, version {version}.', { pid: 42 })).toBe(
      'Engine: process 42, version {version}.',
    );
    expect(
      i18n.resolve({}, 'k', 'Engine: process {pid}, version {version}.', {
        pid: 42,
        version: undefined,
      }),
    ).toBe('Engine: process 42, version {version}.');
  });

  it('fills a token the translator moved', async () => {
    const i18n = await helper();
    const table = { 'a.key': '{total} shagov, sejchas {index}' };
    expect(i18n.resolve(table, 'a.key', 'Step {index} of {total}', { index: 2, total: 5 })).toBe(
      '5 shagov, sejchas 2',
    );
  });

  it('sweeps a tree by attribute, passing what is there as the fallback', async () => {
    const i18n = await helper();
    const seen: string[] = [];
    const node = {
      attributes: { 'data-i18n': 'a.key' } as Record<string, string>,
      textContent: 'The English',
      getAttribute(name: string) {
        return this.attributes[name] ?? null;
      },
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
    };
    const image = {
      attributes: { 'data-i18n-attr': 'alt:b.key', alt: 'A pigeon' } as Record<string, string>,
      getAttribute(name: string) {
        return this.attributes[name] ?? null;
      },
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
    };
    const root = {
      querySelectorAll: (selector: string) =>
        selector === '[data-i18n]' ? [node] : selector === '[data-i18n-attr]' ? [image] : [],
    };

    i18n.apply(root, (key, fallback) => {
      seen.push(`${key} <- ${fallback}`);
      return `translated ${key}`;
    });

    expect(seen).toEqual(['a.key <- The English', 'b.key <- A pigeon']);
    expect(node.textContent).toBe('translated a.key');
    expect(image.attributes.alt).toBe('translated b.key');
  });
});

// ---------------------------------------------------------------------------
// the scaffold is inert
// ---------------------------------------------------------------------------

describe('with English as the only locale nothing changes', () => {
  it('ships one locale, so no switcher is ever built', async () => {
    const i18n = await helper();
    expect(i18n.locales().map((locale) => locale.code)).toEqual(['en']);
    expect(i18n.locale()).toBe('en');
  });

  it('renders the switcher only when there is a second language to choose', async () => {
    // The guard is in `i18n.js` and the slot is in the page: the control appears
    // when the registry grows and not before, so the airmail design ships as
    // designed.
    const js = await read('i18n.js');
    expect(js).toMatch(/LOCALES\.length\s*<\s*2/);
    const setup = await read('setup.html');
    expect(setup).toMatch(/data-i18n-switcher/);
    // Hidden in the markup, and only `i18n.js` may unhide it.
    const slot = /<div[^>]*data-i18n-switcher[^>]*>/.exec(setup);
    expect(slot).not.toBeNull();
    expect(slot![0]).toContain('hidden');
  });

  it('leaves the English pages untouched, because the sweep never runs', async () => {
    // The one promise of this round, and the reason the English text stays in the
    // markup rather than moving into the table: nothing loads, nothing sweeps.
    let swept = 0;
    const source = await read('i18n.js');
    const sandbox = {
      window: {
        localStorage: { getItem: () => null, setItem: () => undefined },
      },
      document: {
        querySelectorAll: (selector: string) => {
          if (selector === '[data-i18n]' || selector === '[data-i18n-attr]') swept += 1;
          return [] as unknown[];
        },
        documentElement: { setAttribute: () => undefined },
      },
    };
    runInNewContext(source, sandbox);
    await (sandbox.window as unknown as { pigeonI18n: Helper }).pigeonI18n.ready;
    expect(swept).toBe(0);
  });

  it('ignores a remembered locale this build does not ship', async () => {
    // A locale file can leave a build, and a window that honoured the memory of
    // it would be a window with no strings at all.
    const i18n = await helper('xx');
    expect(i18n.locale()).toBe('en');
  });

  it('remembers the locale in the window and not in the config', async () => {
    // Which language somebody reads a window in is a property of the window. It
    // has no business travelling through the core, the config or a setup answer.
    const js = await read('i18n.js');
    expect(js).toContain('localStorage');
    expect(js).not.toContain('invoke(');
    expect(js).not.toContain('setup_answer');
  });

  it('survives a webview with storage blocked', async () => {
    const source = await read('i18n.js');
    const sandbox = {
      window: {
        localStorage: {
          getItem: () => {
            throw new Error('storage is blocked here');
          },
          setItem: () => {
            throw new Error('storage is blocked here');
          },
        },
      },
      document: {
        querySelectorAll: () => [] as unknown[],
        documentElement: { setAttribute: () => undefined },
      },
    };
    runInNewContext(source, sandbox);
    const loaded = (sandbox.window as unknown as { pigeonI18n: Helper }).pigeonI18n;
    await expect(loaded.ready).resolves.toBe('en');
  });
});

// ---------------------------------------------------------------------------
// the pages are wired through it
// ---------------------------------------------------------------------------

describe('the pages load the helper before they use it', () => {
  for (const page of PAGES) {
    it(`${page}.html loads i18n.js first`, async () => {
      const html = await read(`${page}.html`);
      const helperTag = html.indexOf('<script src="i18n.js"></script>');
      const ownTag = html.indexOf(`<script src="${page}.js"></script>`);
      expect(helperTag, `${page}.html does not load i18n.js`).toBeGreaterThan(-1);
      expect(ownTag).toBeGreaterThan(helperTag);
    });

    it(`${page}.js takes t() off the one helper`, async () => {
      const js = await read(`${page}.js`);
      expect(js).toContain('window.pigeonI18n.t');
    });
  }
});
