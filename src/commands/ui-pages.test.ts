/**
 * The window pages, swept for the laws they are subject to.
 *
 * `app/ui` is HTML, CSS and plain JavaScript, and it is the one part of this
 * repository that no compiler and no type checker looks at. Every mistake it
 * can make is a mistake nothing catches until somebody opens the window and
 * sees a blank page or, worse, does not see the blank page because the failure
 * is one dead button in the corner.
 *
 * So the checks below are deliberately mechanical. They hold five different
 * kinds of promise:
 *
 *   * **the scripts are programs.** Every shipped page script parses. It is the
 *     floor under everything else in this file: each check below reads a page as
 *     text, and text that cannot be compiled passes all of them while the window
 *     it drives renders nothing at all.
 *   * **the laws.** No network, no remote URL, no command outside the fourteen in
 *     `app/src-tauri/src/ipc.rs`, no event channel outside the one the
 *     capability grants. Each of these is a structural guarantee elsewhere in
 *     the app, and each is one careless line away from being only a convention
 *     in the pages.
 *   * **the wiring.** Every id a script reaches for exists in the page it
 *     belongs to. This is the whole class of bug that a webview swallows
 *     silently: `getElementById` returns null, the listener is never attached,
 *     and the button simply does nothing for the rest of the milestone.
 *   * **the promises about the copy.** The storage honesty sentence is one
 *     sentence, written once, in `src/commands/watch.ts`, and it appears word
 *     for word on the two surfaces TRAY-DESIGN section 0 names.
 *   * **the quality floor.** Both themes, reduced motion, visible focus, local
 *     fonts. These are the things nobody notices working and everybody notices
 *     missing, which is exactly what a test is for.
 *
 * `copy-law.test.ts` holds the em dash sweep and the CSP promises over the same
 * directory. The two files are deliberately separate: that one is about what
 * may not appear anywhere in the app, this one is about whether these pages
 * are correct.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createContext, runInContext, Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { STORAGE_HONESTY } from './watch.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const UI = join(REPO_ROOT, 'app', 'ui');

/** The three real pages, each with the script that drives it. */
const PAGES = ['setup', 'status', 'health'] as const;

/**
 * Every command a page may call, copied from `app/src-tauri/src/ipc.rs`.
 *
 * A fifteenth name appearing in a page is either a command somebody added
 * without writing down why, or a typo that would fail silently at runtime with
 * an unhandled rejection nobody sees. Both are worth a red test.
 */
const COMMANDS = [
  'setup_start',
  'setup_answer',
  'pick_folder',
  'doctor_report',
  'status_snapshot',
  'autostart_get',
  'autostart_set',
  'open_path',
  'finish_setup',
  'open_setup',
  'engine_action',
  'open_watched',
  'add_watched_folder',
  'remove_watched_folder',
];

/**
 * The proper nouns a sentence case string is still allowed to capitalise past
 * its first word. Short on purpose: a long list is Title Case wearing a licence.
 */
const PROPER_NOUNS = ['Photo', 'Pigeon', 'Windows', 'Google'];

/** Every string that sits inside a window: tabs, headings, buttons, captions. */
function insideStrings(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<(h1|h2|button|figcaption|a)[^>]*>([\s\S]*?)<\/\1>/g)) {
    found.push(match[2]);
  }
  return found
    .map((text) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '');
}

/** The window titles the shell sets, read out of the Rust that sets them. */
async function windowTitles(): Promise<Record<string, string>> {
  const rust = await readFile(
    join(REPO_ROOT, 'app', 'src-tauri', 'src', 'windows.rs'),
    'utf8',
  );
  const fn = rust.slice(rust.indexOf('pub const fn title'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  return Object.fromEntries(
    [...body.matchAll(/Page::(\w+) => "([^"]+)"/g)].map((match) => [match[1], match[2]]),
  );
}

/** The only event channel any page subscribes to. The capability grants listening and nothing else. */
const CHANNELS = ['setup-event'];

async function uiFiles(extensions: string[]): Promise<string[]> {
  const entries = await readdir(UI, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath ?? UI, entry.name));
}

const read = (relative: string): Promise<string> => readFile(join(UI, relative), 'utf8');

/** Collapse the whitespace an HTML author uses for wrapping, so a sentence can be found. */
function flatten(html: string): string {
  return html.replace(/\s+/g, ' ');
}

/** Every id declared in a page. */
function idsIn(html: string): string[] {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
}

/** Every id a script reaches for, through `el(...)` or the DOM call itself. */
function idsWanted(js: string): string[] {
  const helper = [...js.matchAll(/\bel\('([^']+)'\)/g)].map((match) => match[1]);
  const direct = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  return [...new Set([...helper, ...direct])];
}

// ---------------------------------------------------------------------------
// the scripts are programs
// ---------------------------------------------------------------------------

describe('every page script is a program a webview can run', () => {
  it('compiles, all of them, so a window cannot ship as a blank page', async () => {
    // The floor under this whole file, and it was missing. Every other check
    // here reads a page as text, and text is happy to hold a script that no
    // engine will accept: one lost comment opener is a `SyntaxError` at load,
    // which in a webview means the listeners are never attached, the poll never
    // starts, and the window renders the markup's own placeholder words forever.
    // Nothing in the app says so either. There is no console anybody looks at,
    // the page still paints, and the sentence on it is the one a cold shell
    // writes, so the failure reads as "the engine has not said anything yet".
    //
    // Compiled and deliberately not run: running a page needs a document, a
    // `window.__TAURI__` and a clock, which is what the sandbox in
    // `i18n.test.ts` is for. Compiling is the property that was unheld, it is
    // held for every script in the directory rather than for a list somebody
    // maintains, and `node:vm` is the same engine the pages are written for.
    const broken: string[] = [];
    const scripts = await uiFiles(['.js']);
    expect(scripts.length).toBeGreaterThanOrEqual(4);

    for (const file of scripts) {
      const source = await readFile(file, 'utf8');
      try {
        new Script(source, { filename: basename(file) });
      } catch (error) {
        broken.push(`${basename(file)}: ${messageOfSyntaxError(error)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('shares one global scope with the other scripts on its page and collides with none', async () => {
    // Two classic `<script src>` tags in one document are two scripts in **one
    // global scope**. That is not an artefact of this test or of a bundler: it is
    // what a page is, and it turns a name that reads as private into a name every
    // other script on the page can trip over. A `const` in one script over a
    // `function` of the same name in another is a `SyntaxError` raised while the
    // second script is instantiated, so that whole file never runs, and a webview
    // reports it to a console nobody has open.
    //
    // A collision that is *legal* is barely better: two function declarations of
    // one name are allowed, the last one silently wins, and a page's helper
    // quietly belongs to somebody else.
    //
    // So the rule is disjoint top level names, page by page, and the fix for a
    // collision is never a rename around it: a file two pages share keeps nothing
    // in the global scope but the one object it publishes.
    const collisions: string[] = [];
    for (const page of PAGES) {
      const owner = new Map<string, string>();
      const scripts = scriptsOf(await read(`${page}.html`));
      expect(scripts.length, `${page}.html loads no scripts`).toBeGreaterThan(1);
      for (const script of scripts) {
        for (const name of globalsOf(await read(script))) {
          const first = owner.get(name);
          if (first === undefined) owner.set(name, script);
          else collisions.push(`${page}.html: ${first} and ${script} both declare ${name}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  for (const page of PAGES) {
    it(`${page}.html loads its scripts in order and paints something`, async () => {
      // The check the other two are the floor under, and the only test in this
      // repository that makes a page's own code run. Everything else about
      // `app/ui` is read as text, and text passes every sweep in this file while
      // the window it drives is blank.
      //
      // The stubs are thin on purpose. The document answers `getElementById` for
      // the ids the page declares and nothing else, `invoke` answers what the
      // shell answers, and no clock ticks. So this holds the load, the wiring and
      // the first paint, and it holds nothing about layout, which needs a pair
      // of eyes. A page that reaches for something this stub does not have
      // fails here naming it, which is a true report rather than a nuisance: the
      // stub is the whole of what a page in this app may assume.
      const html = await read(`${page}.html`);
      const world = pageWorld(idsIn(html));
      for (const script of scriptsOf(html)) {
        const source = await read(script);
        try {
          runInContext(source, world.context, { filename: script });
        } catch (error) {
          expect.fail(`${script} threw while loading: ${messageOfSyntaxError(error)}`);
        }
      }
      // The first paint is behind an `invoke`, so it lands a turn of the event
      // loop later. Waited for rather than assumed: a page that never paints is
      // exactly what this is looking for, so the wait has to be long enough that
      // nothing painted means nothing painted.
      await new Promise((settle) => setTimeout(settle, 0));

      expect(world.listening(), `${page}.js attached no handler`).toBeGreaterThan(0);
      // The two pages that read the shell on load have painted by now. Setup has
      // not, and that is right rather than tolerated: its first words are the
      // wizard's, so nothing is written until a `setup-event` arrives, and a page
      // that painted its own version of the walk would be writing the core's copy.
      if (page !== 'setup') {
        expect(world.painted(), `${page}.js painted nothing`).toBeGreaterThan(0);
      }
    });
  }
});

/**
 * A document and a `window` thin enough to be honest, with the two counters the
 * test reads back: how much text was painted, and how many handlers were hung.
 *
 * Every element answers the same small shape, because a page in this app is
 * allowed to assume exactly that much: an id it declared, `textContent`, the
 * three class list calls, `append`, `replaceChildren`, `addEventListener`, and
 * the two flags a control has. `focus` is there because the setup page moves the
 * keyboard when it puts a card back up.
 */
function pageWorld(
  ids: string[],
  /**
   * What the shell answers, for a test that needs a particular answer. Merged
   * over the ordinary ones, so a case names only the reply it is about.
   */
  replies: Record<string, unknown> = {},
): {
  context: object;
  painted: () => number;
  listening: () => number;
  textOf: (id: string) => string;
} {
  let painted = 0;
  let listening = 0;

  const element = (id: string): Record<string, unknown> => {
    const children: unknown[] = [];
    const node: Record<string, unknown> = {
      id,
      value: '',
      checked: false,
      disabled: false,
      title: '',
      className: '',
      href: '',
      children,
      classList: {
        toggle: () => undefined,
        add: () => undefined,
        remove: () => undefined,
        contains: () => false,
      },
      style: { setProperty: () => undefined, removeProperty: () => undefined },
      append: (...kids: unknown[]) => void children.push(...kids),
      prepend: (...kids: unknown[]) => void children.unshift(...kids),
      replaceChildren: (...kids: unknown[]) => void children.splice(0, children.length, ...kids),
      remove: () => undefined,
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
      getAttribute: () => null,
      querySelectorAll: () => [] as unknown[],
      addEventListener: () => void (listening += 1),
      focus: () => undefined,
      scrollIntoView: () => undefined,
    };
    let text = '';
    Object.defineProperty(node, 'textContent', {
      get: () => text,
      set: (written: unknown) => {
        text = String(written ?? '');
        if (text !== '') painted += 1;
      },
    });
    return node;
  };

  const declared = new Map(ids.map((id) => [id, element(id)]));
  const snapshot = {
    statusLine: 'Watching two folders',
    storageLine: 'Nothing sent yet',
    storageHonesty: STORAGE_HONESTY,
    icon: 'ok',
    attention: null,
    engineControl: { label: 'Pause', word: 'pause', enabled: true },
    deliverNowEnabled: true,
    watchDirs: ['D:\\Camera Roll', 'D:\\Screenshots'],
    delivered: 3,
    skipped: 1,
    failed: 0,
    bytes: 4096,
    corePid: 4321,
    coreVersion: '0.1.0',
    dryRun: false,
    autostartOn: true,
    autostartAvailable: true,
    notice: null,
    recent: [{ at: '2026-07-30T09:15:00.000Z', detail: 'sent one photo' }],
    shellLogPath: 'C:\\log\\tray.log',
  };

  const answers: Record<string, unknown> = {
    status_snapshot: snapshot,
    doctor_report: { ok: true, checks: [{ level: 'ok', title: 'Token', detail: 'It works.' }] },
    autostart_get: true,
    ...replies,
  };

  const context = {
    window: {
      __TAURI__: {
        core: { invoke: (name: string) => Promise.resolve(answers[name] ?? null) },
        event: { listen: () => Promise.resolve(() => undefined) },
      },
      localStorage: { getItem: () => null, setItem: () => undefined },
      location: { reload: () => undefined },
    },
    document: {
      getElementById: (id: string) => declared.get(id) ?? null,
      createElement: (tag: string) => element(`<${tag}>`),
      querySelectorAll: () => [] as unknown[],
      documentElement: { setAttribute: () => undefined },
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };

  /** Everything one element ended up saying, itself and everything under it. */
  const textIn = (node: unknown): string => {
    if (node === null || typeof node !== 'object') return '';
    const record = node as Record<string, unknown>;
    const own = typeof record.textContent === 'string' ? record.textContent : '';
    const kids = Array.isArray(record.children) ? record.children.map(textIn).join(' ') : '';
    return [own, kids].filter((text) => text !== '').join(' ');
  };

  return {
    context: createContext(context),
    painted: () => painted,
    listening: () => listening,
    textOf: (id: string) => textIn(declared.get(id)),
  };
}

/** The first line of what the engine said, which is the part that names the bug. */
function messageOfSyntaxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0];
}

/** The scripts a page loads, in the order the page loads them. */
function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
}

/**
 * Every name a classic script declares at the top level of the one global scope
 * it shares with the other scripts on the page.
 *
 * `const`, `let` and `class` land in the global lexical environment; `var` and a
 * function declaration land on the global object. Both halves are collected,
 * because the failure this is looking for is between the two: a lexical name in
 * one script over a var name in another is a `SyntaxError`, and the script that
 * carries the lexical name does not run at all.
 */
function globalsOf(js: string): string[] {
  const names = new Set<string>();
  for (const match of js.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of js.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of js.matchAll(/^class\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  return [...names];
}

// ---------------------------------------------------------------------------
// the laws
// ---------------------------------------------------------------------------

describe('the autostart toggle tells the truth', () => {
  it('re-reads after a write until the registry answer settles', async () => {
    // The write lands on the supervisor thread after `autostart_set` returns,
    // so a single immediate read can see the world from before the click, and
    // the checkbox then lies for the life of the window (the M4 review's
    // second critical). The handler must keep reading until the value agrees
    // or stops changing, so a failed write ends on the state that exists
    // rather than the one that was asked for.
    const js = await read('setup.js');
    const afterSet = js.slice(js.indexOf('autostart_set'));
    expect(afterSet).toMatch(/for\s*(await)?\s*\(const delay of/);
    expect(afterSet).toContain('readAutostart');
  });
});

describe('the ask card comes back when the wizard is still waiting', () => {
  it('recovers the live question a refusal names, instead of sitting silent', async () => {
    // ASK-PROTOCOL rule 4. An answer for a dead ask id is refused, the refusal
    // names the question that really is open, and that question stays live
    // because nothing was consumed. Nothing follows it either: a refusal for
    // the live id re-asks with the same id, a refusal for a dead one does not.
    // So a page that had already taken its card down is left with a live
    // question the user cannot see and no way to reach it. It is unreachable
    // from today's wiring, where every send is guarded by `openAsk`, which is
    // why it is pinned rather than trusted: it is one wrong guard from being
    // the shipped critical of a later milestone.
    const js = await read('setup.js');
    const answered = js.slice(js.indexOf("case 'answered'"), js.indexOf("case 'cancelled'"));
    expect(answered, 'the answered arm never acts on a live open id').toMatch(/reopenAsk\(/);

    const reopen = js.slice(js.indexOf('function reopenAsk('));
    const body = reopen.slice(0, reopen.indexOf('\n}'));
    // The card goes back up, and the page adopts the id the core named so the
    // next answer can name it too.
    expect(body).toContain('openAsk = ');
    expect(body).toContain('show(ui.ask, true)');
    // What comes back is the card the last `ask` rendered. The page keeps no
    // memory of the walk, so a question re-invented here would be the page
    // writing the wizard's copy.
    expect(body).not.toContain('ui.question.textContent =');
  });
});

describe('the postmark says when setup finished', () => {
  it('takes the moment off the done event, with the render date as the fallback', async () => {
    // The stamp used to be `new Date()` at render time, which is the machine's
    // date when the page happened to draw rather than the moment the run
    // finished. Every core event already carries `at`, so the moment was on the
    // wire and the page only had to read it. The fallback is explicit and stays
    // explicit: the shell's own lines carry `at: null` on purpose, and an older
    // core could carry no moment at all.
    const js = await read('setup.js');
    expect(js, 'no helper reads the moment off the event').toContain('function momentOf(');

    const done = js.slice(js.indexOf("case 'setup-done'"), js.indexOf("case 'failed'"));
    expect(done).toMatch(/stamp\(momentOf\(event\)\)/);

    const stamp = js.slice(js.indexOf('function stamp('));
    expect(stamp.slice(0, stamp.indexOf('\n}')), 'the stamp makes its own date').not.toContain(
      'new Date()',
    );

    const moment = js.slice(js.indexOf('function momentOf('));
    const body = moment.slice(0, moment.indexOf('\n}'));
    expect(body).toContain('event.at');
    expect(body, 'nothing to draw when the event carries no moment').toContain('new Date()');
  });
});

describe('the pages are self contained', () => {
  it('asks the network for nothing, in any file', async () => {
    // The CSP is `default-src 'self'`, so a remote request would be blocked
    // rather than served. That makes this a test about honesty rather than
    // about security: a page that reaches for a font it cannot have is a page
    // that renders in the fallback face on every machine and looks fine on the
    // one it was written on.
    const files = await uiFiles(['.html', '.css', '.js']);
    expect(files.length).toBeGreaterThanOrEqual(7);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/https?:\/\//i.test(text)) offenders.push(`${file}: absolute URL`);
      // A protocol relative reference, which is the other way a CDN gets in.
      // Restricted to markup and styles, where `//` is never a comment.
      if (/\.(html|css)$/.test(file) && /["'(]\s*\/\//.test(text)) {
        offenders.push(`${file}: protocol relative URL`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no fetching machinery at all', async () => {
    const scripts = await uiFiles(['.js']);
    for (const file of scripts) {
      const text = await readFile(file, 'utf8');
      for (const forbidden of [
        'fetch(',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'sendBeacon',
        'importScripts',
      ]) {
        expect(text, `${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('never frames anything', async () => {
    // An iframe is the one element that could render a remote page inside this
    // app, which is the shape of the OAuth law's worst failure. `windows.rs`
    // makes window creation a closed enum for the same reason; this is the
    // matching guarantee one level down.
    for (const page of PAGES) {
      const html = await read(`${page}.html`);
      expect(html, page).not.toMatch(/<iframe|<embed|<object/i);
    }
  });

  it('names Google nowhere as a host', async () => {
    // Consent opens in the system browser, from the core, always. The
    // `signing-in` event deliberately carries no URL, so there is nothing for a
    // page to render even by accident, and there is nothing here to render it
    // with either.
    const files = await uiFiles(['.html', '.css', '.js']);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toContain('accounts.google.com');
      expect(text, file).not.toContain('console.cloud.google.com');
    }
  });

  it('calls only the fourteen commands the shell exposes', async () => {
    const scripts = await uiFiles(['.js']);
    const called = new Set<string>();
    for (const file of scripts) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/invoke\('([^']+)'/g)) called.add(match[1]);
    }
    expect(called.size).toBeGreaterThan(0);
    expect([...called].filter((name) => !COMMANDS.includes(name))).toEqual([]);
  });

  it('is checking against the list the shell really registers', async () => {
    // The list above is copied from `ipc.rs` by hand, which makes it a comment
    // the day the two disagree: a command added there and forgotten here is a
    // fifteenth name this sweep waves through. The Rust side holds the other half
    // of this seam (`every_command_is_registered_exactly_once_and_nothing_else_is`
    // pins `lib.rs`'s handler list to the same source), so between them the
    // command surface is one fact in three files rather than three opinions.
    const ipc = await readFile(join(REPO_ROOT, 'app', 'src-tauri', 'src', 'ipc.rs'), 'utf8');
    const production = ipc.split('#[cfg(test)]')[0];
    const declared = [
      ...production.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)/g),
    ].map((match) => match[1]);
    expect(declared.slice().sort()).toEqual(COMMANDS.slice().sort());
  });

  it('names every command it calls, so the allowlist can see all of them', async () => {
    // The check above scans for a quoted name. An `invoke` whose first argument
    // is a variable is a call it cannot see, so a page could reach anything the
    // handler registers and the allowlist would still pass. Whoever writes a
    // helper that takes a command name will find out here.
    const scripts = await uiFiles(['.js']);
    const offenders: string[] = [];
    for (const file of scripts) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/\binvoke\(\s*([^'\s)])/g)) {
        offenders.push(`${file}: invoke(${match[1]}...`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('subscribes only to the channel the capability grants', async () => {
    const scripts = await uiFiles(['.js']);
    const heard = new Set<string>();
    for (const file of scripts) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/listen\('([^']+)'/g)) heard.add(match[1]);
    }
    expect([...heard].filter((name) => !CHANNELS.includes(name))).toEqual([]);
  });

  it('only ever sends back a folder it was given', async () => {
    // The rule the whole editing surface rests on: the page learns a path from
    // `pick_folder`, which is a native dialog opened in Rust, or out of the
    // snapshot the core filled from its own `started` event. It never builds one,
    // joins one or shortens one, and the core revalidates whatever comes back.
    // Anything that looked like path arithmetic in here would be a page inventing
    // a path, which is the one thing this design does not allow.
    const status = await read('status.js');
    expect(status).toMatch(/invoke\('add_watched_folder',\s*\{\s*path:\s*dir\s*\}\)/);
    expect(status).toMatch(/invoke\('remove_watched_folder',\s*\{\s*path:\s*dir\s*\}\)/);
    // The picked string is handed straight over, not adjusted on the way.
    expect(status).toMatch(/invoke\('pick_folder'\)/);
    expect(status).toContain('await edit(addWatched, picked)');
    // Nothing anywhere in the page touches either string except to pass it on.
    for (const arithmetic of ['path.join', "+ '\\\\'", "+ '/'", 'dir +', '+ dir', 'dir.', 'picked.']) {
      expect(status, `status.js does path arithmetic: ${arithmetic}`).not.toContain(arithmetic);
    }
  });

  it('asks before it stops watching a folder, and says what removing does not do', async () => {
    // The fear at this button is that the photos are about to go. The true answer
    // is that this tool has never been able to delete anything, here or in the
    // library, so the sentence says so rather than asking "are you sure".
    const status = await read('status.js');
    const sentence = /Stop watching this folder\?[^']*/.exec(status);
    expect(sentence, 'no confirm sentence at all').not.toBeNull();
    expect(sentence![0]).toContain('Nothing is deleted');
    expect(sentence![0]).toContain('Google Photos');
    // Two buttons, and neither of them is a bare yes or no. Read through the
    // locale scaffold, which is where every page string on this window lives:
    // `i18n.test.ts` pins each call site's English to en.json, so the key and
    // the words are one fact and this can name either.
    expect(status).toContain("t('status.watching.confirmYes', 'Stop watching it')");
    expect(status).toContain("t('status.watching.confirmNo', 'Keep watching it')");
  });

  it('puts the folder actions on the folder row, and the add below the list', async () => {
    // Each row owns both of what can be done to it, so a folder is opened and
    // removed from the row it is named in and there is no selection to keep in
    // step. Adding sits below the list, because that is where a list grows.
    //
    // A row takes its index as well as its path, because opening names a
    // position and only removing may name a path.
    const html = await read('status.html');
    const status = await read('status.js');
    expect(status).toMatch(/function watchRow\(dir, index\)/);
    expect(status).toContain("t('status.watching.remove', 'Remove')");
    expect(status).toContain("t('status.watching.open', 'Open folder')");
    expect(status).toContain('row-actions');
    const list = html.indexOf('id="watch-dirs"');
    const add = html.indexOf('id="add-watched"');
    expect(list).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(list);
  });

  it('does not rebuild the folder rows on the clock, only when they change', async () => {
    // The poll replaced the whole list once a second, which was free while the
    // rows were text. It is not free now they hold buttons: an element swapped
    // between a mousedown and a mouseup gets no click, so a rebuild on a timer is
    // a button that ignores some fraction of presses and looks broken at random.
    const status = await read('status.js');
    const paint = status.slice(status.indexOf('function paint('));
    const rebuild = paint.indexOf('ui.watchDirs.replaceChildren');
    expect(rebuild).toBeGreaterThan(-1);
    // The rebuild is inside a guard, and the guard is about the contents.
    expect(paint.slice(0, rebuild)).toMatch(/if \(wanted !== builtFrom\)/);
  });

  it('renders the core sentence when an edit changed nothing', async () => {
    // The core answers every request, including the ones that change nothing, and
    // the whole point of that is that the window shows the answer. A page that
    // repeated the rule instead would be the second place the rule lives.
    const status = await read('status.js');
    expect(status).toContain('answered(answer.why)');
    expect(status).toMatch(/folders-changed/);
  });

  it('sends the one payload carrying form and nothing else', async () => {
    // docs/ASK-PROTOCOL.md section 3: `answer {"id":"...","value":...}` is the
    // whole of M4's vocabulary growth. The shell frames the line; the page's
    // half of that contract is the shape of the object it hands over, and this
    // is where a page could quietly start sending something else.
    const setup = await read('setup.js');
    expect(setup).toMatch(/invoke\('setup_answer',\s*\{\s*payload:\s*\{\s*id,\s*value\s*\}\s*\}\)/);
  });
});

// ---------------------------------------------------------------------------
// the wiring
// ---------------------------------------------------------------------------

describe('the wiring holds', () => {
  for (const page of PAGES) {
    it(`${page}.html declares every id ${page}.js reaches for`, async () => {
      const html = await read(`${page}.html`);
      const js = await read(`${page}.js`);
      const declared = new Set(idsIn(html));
      const missing = idsWanted(js).filter((id) => !declared.has(id));
      expect(missing).toEqual([]);
    });

    it(`${page}.html declares no id twice`, async () => {
      const ids = idsIn(await read(`${page}.html`));
      const seen = new Set<string>();
      const twice = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
      expect(twice).toEqual([]);
    });

    it(`${page}.html loads the one stylesheet and its own script`, async () => {
      const html = await read(`${page}.html`);
      expect(html).toContain('<link rel="stylesheet" href="pigeon.css" />');
      expect(html).toContain(`<script src="${page}.js"></script>`);
    });
  }

  it('the two everyday views can reach each other', async () => {
    // The tray opens one window for status and health. Whichever page it lands
    // on, the other is one click away, and the click is an ordinary navigation
    // to a local file rather than a second window: no window is created, so the
    // no-window-at-idle law is untouched.
    const status = await read('status.html');
    const health = await read('health.html');
    expect(status).toContain('href="health.html"');
    expect(health).toContain('href="status.html"');
    expect(status).toContain('aria-current="page"');
    expect(health).toContain('aria-current="page"');
  });
});

// ---------------------------------------------------------------------------
// the control surface
// ---------------------------------------------------------------------------

/*
 * The status-window reshape made the status window the main UI:
 * a left click on the tray already opens it, so Pause, Resume and Deliver now
 * live on it and the tray menu keeps its own copies as duplicates of the same
 * supervisor truth.
 *
 * Every test below is about that word, truth. A control on this page is a view
 * of `StatusSnapshot` and nothing else, because the two ways of getting it wrong
 * are both shipped criticals in this project's own history: the M3 review's
 * first critical was a menu claiming Paused over an engine that was delivering,
 * and its second was a button that cleared a quota hold nobody had lifted.
 */
describe('the status window is the control surface', () => {
  it('carries the engine controls and no longer guesses one watched folder', async () => {
    const html = await read('status.html');
    for (const id of ['engine-action', 'deliver-now', 'open-log']) {
      expect(idsIn(html), id).toContain(id);
    }
    // The list is the surface for folders now, one row each, so the single
    // button that opened whichever folder came first has nothing left to mean.
    // Asserted on the ids and on what a person can read, not on the file: the
    // comment above that section says what the button was, which is the kind of
    // history the file is meant to keep.
    expect(idsIn(html)).not.toContain('open-watched');
    expect(flatten(html)).not.toContain('Open watched folder');
    // The empty state survives the reshape: a list with no rows still says why.
    expect(flatten(html)).toContain('The engine has not said what it watches yet.');
  });

  it('renders the pause label the shell sent and never one of its own', async () => {
    // The label is Pause, Resume, "Pausing, finishing what is in flight" or
    // "Starting again", and which one it is depends on state the page cannot
    // see. `action_item` in state.rs is the only thing that knows, so the page
    // prints what it was given: a page with its own wording is a page that can
    // say Pause at a paused engine.
    const js = await read('status.js');
    expect(js).toMatch(/engineAction\.textContent\s*=\s*[a-z]/i);
    expect(js, 'a literal button label in the page').not.toMatch(
      /engineAction\.textContent\s*=\s*['"`]/,
    );
  });

  it('takes both enabled states from the snapshot', async () => {
    // Not from the label, not from a count of watched folders, and not from
    // whether the last click seemed to work. `deliver_now_enabled` and the
    // engine control's own flag are the shell's answers and they are the ones
    // the menu renders too.
    const js = await read('status.js');
    expect(js).toMatch(/engineAction\.disabled\s*=/);
    expect(js).toMatch(/deliverNow\.disabled\s*=/);
    expect(js).toContain('deliverNowEnabled');
  });

  it('writes the word the snapshot published and never one read off the label', async () => {
    // The whole shape of the M3 vocabulary: `pause` and `resume` are different
    // words with different meanings, and a page that decided between them by
    // reading its own button would be deciding from a picture that is up to one
    // poll old. The snapshot carries the word beside the label so the two can
    // never come apart.
    const js = await read('status.js');
    const call = /invoke\('engine_action',\s*\{\s*kind:\s*([^}]+)\}\)/g;
    const actions = [...js.matchAll(call)].map((match) => match[1].trim());
    expect(actions.length, 'no engine_action call at all').toBeGreaterThanOrEqual(2);
    // Deliver now is the one action that is always the same word, because it is
    // one gesture and not a toggle.
    expect(actions).toContain("'deliver'");
    expect(actions.filter((action) => /^'(pause|resume)'$/.test(action))).toEqual([]);
  });

  it('leaves the amber attention line to the repaint, so a click cannot clear it', async () => {
    // The M3 review's second critical, one level up. Deliver now writes
    // `rescan`, the core answers every rescan with a `delivering` of its own,
    // and the shell clears a quota hold on the word `resumed` and nothing else.
    // A page that hid its own attention block on click would put that critical
    // back on the surface the user is actually looking at, and no test in the
    // shell would notice.
    const js = await read('status.js');
    expect(js).toContain('ui.attention');
    expect(
      js.lastIndexOf('ui.attention'),
      'the attention line is touched outside paint()',
    ).toBeLessThan(js.indexOf('async function refresh'));
  });

  it('rebuilds the watching list only when the folders have changed', async () => {
    // Every row holds a button now and the page repaints once a second, so a
    // list rebuilt on every tick would take the keyboard focus off a row button
    // the moment somebody tabbed to it and would cancel a hover mid press. That
    // is the class of defect a webview swallows silently: nothing throws, and
    // the person who hits it cannot quite say what happened.
    const js = await read('status.js');
    const watching = js.slice(js.indexOf('const dirs = snapshot.watchDirs'));
    const beforeTheRebuild = watching.slice(0, watching.indexOf('replaceChildren'));
    expect(beforeTheRebuild, 'the list is rebuilt unconditionally').toMatch(/\bif\s*\(/);
  });

  it('opens a watched folder by index, and says which folder that row was showing', async () => {
    // The same rule `open_path` holds with its kinds, one step further: the page
    // names a position in a list the shell published, so there is no address on
    // the wire that a page could have invented, and an index is still the whole
    // address. What the path adds is a check, and it is the independent pass's
    // banked finding: this list repaints once a second, so a folder removed from
    // the front of it shifts every row below while the window still shows the old
    // order, and the click opens a folder the person did not press. Both are in
    // range, so nothing out of range catches it.
    //
    // So the row sends what it was showing as well as where it is, the shell
    // resolves the index against its own list as it always did, and a
    // disagreement is a refusal. The string cannot open anything: see
    // `watched_row` in `app/src-tauri/src/supervisor.rs`.
    const js = await read('status.js');
    expect(js).toMatch(/invoke\('open_watched',\s*\{\s*index,\s*path:\s*dir\s*\}\)/);
    // Verbatim, and the same string the Remove button sends: a page that
    // prettified a path would be a page whose check passed on a folder it was not
    // showing, or failed on the one it was.
    const openRow = js.slice(js.indexOf('function openRow'), js.indexOf('function watchRow'));
    expect(openRow, 'the row builds a path of its own').not.toMatch(/dir\s*\.\s*(replace|slice)/);
    // And the refusal is answered rather than swallowed. Before this check a
    // refused Open said nothing, which was tolerable while the only refusal was a
    // row that had already gone: the repaint took the row away and the silence
    // explained itself. A shifted list is the other kind. The row is still there,
    // still says what it said, and a click that quietly does nothing is a dead
    // button, which is the one thing this page's own law forbids.
    expect(openRow, 'a refused Open says nothing').toMatch(/catch[\s\S]*answered\(/);
  });
});

// ---------------------------------------------------------------------------
// the health rows
// ---------------------------------------------------------------------------

describe('the health window renders a level it does not know', () => {
  it('falls back to a note instead of a mark made of the prototype chain', async () => {
    // Round two's banked minor. `check.level in LEVELS` asks the prototype chain,
    // so `constructor` and `toString` are levels this page thinks it knows: the
    // guard passes, `LEVELS[level]()` calls something off `Object.prototype`, and
    // the mark renders `[object Object]` in a class no stylesheet has. The four
    // real levels are a closed union in the core's own `DoctorLevel` and only the
    // core reaches this, so it is latent rather than live, and it is one core
    // rename away from being a window full of garbage marks.
    //
    // Held by rendering it rather than by reading the source, because what is
    // wrong is what a person would see: the page is loaded for real against a
    // report carrying both names, the way the load test already loads all three.
    const html = await read('health.html');
    const world = pageWorld(idsIn(html), {
      doctor_report: {
        ok: false,
        checks: [
          { level: 'constructor', title: 'A level off the prototype chain' },
          { level: 'toString', title: 'The other one' },
          // The control, so a page that rendered nothing at all cannot pass: a
          // real level still shows its own word, from the locale table.
          { level: 'warn', title: 'A level the core really has' },
        ],
      },
    });
    for (const script of scriptsOf(html)) {
      runInContext(await read(script), world.context, { filename: script });
    }
    await new Promise((settle) => setTimeout(settle, 0));

    const rendered = world.textOf('checks');
    expect(rendered, 'a mark rendered from the prototype chain').not.toContain('[object');
    expect(rendered, 'the control level did not render').toContain('warning');
    expect(rendered, 'the unknown levels did not fall back to a note').toContain('note');
    // And the rows are still the rows: three findings, each with its sentence,
    // because a fallback that dropped the row would hide a finding rather than
    // mark it.
    for (const title of [
      'A level off the prototype chain',
      'The other one',
      'A level the core really has',
    ]) {
      expect(rendered, title).toContain(title);
    }
  });
});

// ---------------------------------------------------------------------------
// the copy
// ---------------------------------------------------------------------------

describe('the copy keeps its promises', () => {
  it('gives each page the window title the shell sets', async () => {
    // The two tier casing law: a window title is branded Title Case, and
    // everything inside the window is sentence case. The
    // title tag and the Rust title are the same fact in two files, and status and
    // health are two views of one window, so they carry one title between them.
    const titles = await windowTitles();
    expect(titles).toEqual({ Setup: 'Photo Pigeon: Setup', Status: 'Photo Pigeon: Status' });

    const expected: Record<string, string> = {
      setup: titles.Setup,
      status: titles.Status,
      health: titles.Status,
    };
    for (const page of PAGES) {
      expect(await read(`${page}.html`), page).toContain(`<title>${expected[page]}</title>`);
    }
  });

  it('writes every heading, tab and button inside a window in sentence case', async () => {
    // The other tier. It is the half that drifts, because Title Case feels
    // tidier one heading at a time and reads as a brochure once there are six of
    // them. Proper nouns keep their capitals; nothing else does.
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const label of insideStrings(await read(`${page}.html`))) {
        const past = label.split(' ').slice(1);
        for (const word of past) {
          const bare = word.replace(/[^A-Za-z]/g, '');
          if (bare === '' || !/^[A-Z]/.test(bare)) continue;
          if (PROPER_NOUNS.includes(bare)) continue;
          offenders.push(`${page}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('says the storage sentence word for word where the law puts it', async () => {
    // TRAY-DESIGN section 0: the first-run window, the status window and the
    // tooltip's expanded status, and not buried in an About box. The tooltip is
    // the shell's. These two are the pages', and the sentence is the core's, so
    // it is imported rather than retyped.
    for (const page of ['setup', 'status']) {
      const html = flatten(await read(`${page}.html`));
      expect(html, page).toContain(STORAGE_HONESTY);
    }
  });

  it('draws the frightening screens and ships no screenshot of anybody else', async () => {
    // The three frightening screens are line drawings on purpose. A fabricated
    // Google or Windows screenshot would be a small forgery of somebody else's
    // product and would be wrong the moment either of them ships a redesign.
    //
    // The capture slots that once held a place for real screenshots are retired:
    // the drawings ARE the shipped art, so the rule inverts. Nothing may point
    // at a captures file, and the only raster in the page is this project's own
    // mascot.
    const setup = await read('setup.html');
    expect([...setup.matchAll(/A diagram, not a screenshot/g)]).toHaveLength(3);
    expect(setup).not.toContain('captures/');

    const sources = [...setup.matchAll(/<img[\s\S]*?src="([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    expect([...new Set(sources)]).toEqual(['pigeon-mascot.png']);
  });

  it('has no button whose label is a shrug', async () => {
    // TRAY-DESIGN's copy law in the one place it is easiest to break: buttons
    // say what they do. "Browse..." is the shipped example, because the version
    // of this page that had one offered a folder chooser to the question that
    // wanted a JSON file.
    const vague = ['OK', 'Ok', 'Submit', 'Go', 'Continue', 'Browse...', 'Browse…', 'Click here'];
    for (const page of PAGES) {
      const html = await read(`${page}.html`);
      for (const match of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)) {
        const label = match[1].trim();
        expect(vague, `${page}: ${label}`).not.toContain(label);
        expect(label.length, `${page} has a button with no label`).toBeGreaterThan(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// the quality floor
// ---------------------------------------------------------------------------

describe('the quality floor is held by the stylesheet', () => {
  it('bundles its fonts, locally, with the licence beside them', async () => {
    const css = await read('pigeon.css');
    const faces = [...css.matchAll(/@font-face\s*\{[\s\S]*?\}/g)].map((match) => match[0]);
    expect(faces.length).toBeGreaterThan(0);

    for (const face of faces) {
      const src = /url\("([^"]+)"\)/.exec(face);
      expect(src, face).not.toBeNull();
      const url = src![1];
      expect(url, 'a bundled font is a relative path').not.toMatch(/^(https?:)?\/\//);
      expect(url).toMatch(/\.woff2$/);
      expect(existsSync(join(UI, url)), `${url} is missing from the bundle`).toBe(true);
    }

    // Bitter is under the SIL Open Font License, which requires the licence to
    // travel with the files. It ships beside them rather than in a credits box.
    expect(existsSync(join(UI, 'fonts', 'OFL.txt'))).toBe(true);
  });

  it('answers prefers-reduced-motion by standing still', async () => {
    const css = await read('pigeon.css');
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/.exec(css);
    expect(block, 'no reduced motion block at all').not.toBeNull();
    expect(block![0]).toContain('animation-duration');
    expect(block![0]).toContain('transition-duration');
  });

  it('shows where the keyboard is', async () => {
    const css = await read('pigeon.css');
    const focus = /:focus-visible\s*\{([\s\S]*?)\}/.exec(css);
    expect(focus, 'nothing styles :focus-visible').not.toBeNull();
    expect(focus![1]).toMatch(/outline:\s*\d+px/);
    expect(focus![1]).not.toMatch(/outline:\s*(none|0)/);
  });

  it('carries a full palette in every theme it declares', async () => {
    // The drift this catches: somebody adds a colour to the light palette,
    // forgets the dark one, and the page is fine on their machine and unreadable
    // on a machine set to dark. Every colour valued token in :root has to be
    // answered in all three theme blocks.
    const css = await read('pigeon.css');

    const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(rootBlock).not.toBeNull();
    const colours = [...rootBlock![1].matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{3,8}|rgba?\()/gi)].map(
      (match) => match[1],
    );
    expect(colours.length).toBeGreaterThanOrEqual(10);

    const themes: [string, RegExp][] = [
      ['prefers-color-scheme: dark', /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/],
      ['data-theme light', /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/],
      ['data-theme dark', /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/],
    ];

    for (const [label, pattern] of themes) {
      const found = pattern.exec(css);
      expect(found, `no ${label} block`).not.toBeNull();
      const missing = colours.filter((token) => !found![1].includes(`${token}:`));
      expect(missing, `${label} is missing tokens`).toEqual([]);
    }
  });

  it('keeps the airmail edge to hard stops, so nothing in here is a gradient wash', async () => {
    // The one bold element is a printed stripe, not a blend. Every gradient
    // function in the file belongs to the rail, and each of its colour stops is
    // a hard stop: a repeating-linear-gradient whose bands fade would be a
    // gradient by another name, and the design says there are none.
    const css = await read('pigeon.css');
    const gradients = [...css.matchAll(/[a-z-]*gradient\(/g)].map((match) => match[0]);
    expect(gradients.length).toBeGreaterThan(0);
    for (const gradient of gradients) {
      expect(gradient).toBe('repeating-linear-gradient(');
    }
  });
});

// ---------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------

describe('the bundle points at these pages', () => {
  it('is what tauri.conf.json ships as the frontend', async () => {
    const conf = JSON.parse(
      await readFile(join(REPO_ROOT, 'app', 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as { build: { frontendDist: string } };
    expect(conf.build.frontendDist).toBe('../ui');
    // An entry point has to exist in that directory or the bundler has nothing
    // to build, even though no window is ever pointed at it.
    expect(existsSync(join(UI, 'index.html'))).toBe(true);
  });

  it('ships the mascot the two moments need', async () => {
    // TRAY-DESIGN's icon is frozen and untouched. This is the page art: the
    // welcome screen and the postmark, and nowhere else. A mascot used as
    // wallpaper is a mascot nobody looks at.
    expect(existsSync(join(UI, 'pigeon-mascot.png'))).toBe(true);
    const setup = await read('setup.html');
    expect([...setup.matchAll(/pigeon-mascot\.png/g)]).toHaveLength(2);
    for (const page of ['status', 'health']) {
      expect(await read(`${page}.html`), page).not.toContain('pigeon-mascot.png');
    }
  });
});

// A directory listing helper wants a parent path on every entry, and Node's
// older shapes did not carry one. Fail loudly here rather than silently
// skipping every file if that ever changes underfoot.
describe('the sweep really swept', () => {
  it('found the three pages, every script and the stylesheet', async () => {
    const files = await uiFiles(['.html', '.css', '.js']);
    const names = files.map((file) => file.slice(dirname(file).length + 1));
    for (const expected of [
      'setup.html',
      'status.html',
      'health.html',
      'setup.js',
      'status.js',
      'health.js',
      // The language scaffold, loaded by all three pages. Listed here so the
      // laws above sweep it rather than sweeping around it.
      'i18n.js',
      'pigeon.css',
      'index.html',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// a refused click still answers
// ---------------------------------------------------------------------------

describe('the busy guard speaks', () => {
  it('answers the click it refuses instead of swallowing it', async () => {
    // The round's own law, written where the folder edits render the core's
    // answers: a front end has exactly one reading of silence, that the other
    // side did not understand. The page holds the core to that and has to hold
    // itself to it too. A click that lands while an edit is in flight is
    // refused, and a refusal with no sentence is indistinguishable from a dead
    // button: the native dialog never opens, nothing changes, nothing says why.
    // So every busy guard in the page answers before it returns.
    const js = await read('status.js');
    const swallowed = [...js.matchAll(/if \(busy\) return;/g)].map((match) => match[0]);
    expect(swallowed).toEqual([]);
    // The control, so a sweep that matches nothing cannot pass: the guards
    // exist and each one speaks. A refactor that adds or removes a guard must
    // move this count on purpose.
    const speaking = [...js.matchAll(/if \(busy\) \{\s*\n\s*answered\(/g)];
    expect(speaking).toHaveLength(2);
  });

  it('holds the flag while the picker is open, so clicks cannot stack dialogs', async () => {
    // The native dialog is modeless to this page: nothing about an open picker
    // stops the next click from reaching the listener, and on a walk of the
    // built window rapid clicks on Add spawned one dialog per click. So the
    // flag goes up before the picker opens and comes down in a finally, which turns every
    // extra click into the busy sentence the guard above already speaks.
    const js = await read('status.js');
    const listener = /ui\.addWatched\.addEventListener[\s\S]*?\n\}\);/.exec(js);
    expect(listener, 'the add listener is missing').not.toBeNull();
    const block = listener![0];
    const flagUp = block.indexOf('busy = true;');
    const picker = block.indexOf("invoke('pick_folder')");
    expect(picker).toBeGreaterThan(-1);
    expect(flagUp, 'the add listener never raises busy').toBeGreaterThan(-1);
    expect(flagUp, 'busy goes up after the picker opened').toBeLessThan(picker);
    expect(block, 'the flag needs a finally to come down on every path').toContain('finally');
  });
});
