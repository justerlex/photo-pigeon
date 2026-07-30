/*
 * The language scaffold.
 *
 * TRAY-DESIGN's i18n section: **scaffold only in this round.** The page
 * chrome moves into `locales/en.json` behind a tiny `t()`, a switcher slot sits
 * top right of the setup page and stays hidden while English is the only locale,
 * and full i18n (core event keys, Rust tray strings, a translator guide) is a
 * named v0.2 milestone. So the whole of this file's job today is to be the seam
 * that a `locales/xx.json` file can arrive through later without any page being
 * rewritten to receive it.
 *
 * The shape of the thing, and why each part is the way it is:
 *
 *   * **English is the DOM, not a table.** Every `[data-i18n]` element already
 *     holds its English text, and every `t()` call site passes its English as
 *     the second argument. So with `en` as the chosen locale nothing loads,
 *     nothing sweeps and nothing is replaced: the pages render exactly the bytes
 *     they render today, by construction rather than by care. `en.json` is the
 *     reference a translator copies and the file the test suite compares the
 *     pages against, so a key whose English drifts from the page is a red test
 *     rather than a surprise in somebody else's language.
 *   * **A missing key falls back to English and never to a key name.** A page
 *     that shows `status.watching.empty` to a user is worse than a page in the
 *     wrong language, and a half translated locale file is the normal state of
 *     every translation that ever gets merged.
 *   * **No framework and no build step.** A locale is one JSON file, dropped in
 *     `locales/` and named in `LOCALES` below. Nothing is generated, so nothing
 *     can be stale.
 *   * **CSP safe.** No inline script anywhere: `default-src 'self'` stands
 *     untouched, and `copy-law.test.ts` holds it. A locale table is read with a
 *     dynamic `import` of a local JSON module, which is the same kind of
 *     same-origin page asset `pigeon.css` is. There is no `fetch` here and no
 *     network of any kind: `ui-pages.test.ts` sweeps for both.
 *
 * What must never grow here:
 *
 *   * **a sentence the core sends.** The wizard's prose, the status line, the
 *     storage honesty sentence and every doctor row arrive over the machine
 *     channel and render as received. That is the copy law: this window is a
 *     surface for the core's words and not a second author of them. Keying them
 *     means the core carrying message keys with English fallback text, which is
 *     the first item of the v0.2 milestone and not something a page can do on
 *     its own.
 *   * **a rule about what a locale may say.** A translator's file is data. It is
 *     read for keys and never evaluated.
 *   * **a date, a number or a byte count.** Those want the platform's own
 *     locale aware formatting rather than a string table, and picking that is
 *     part of v0.2. `formatBytes` also matches `format_bytes` in `state.rs` and
 *     the core's own, so its units are a contract with two other files.
 */

/*
 * **The whole file is one function, and that is load bearing rather than tidy.**
 *
 * A classic `<script src>` shares one global scope with every other script on
 * the page, so a top level name here is a name `setup.js`, `status.js` and
 * `health.js` all have to avoid. That is not a hypothetical: this file declared
 * `t` and each page opened with `const t = window.pigeonI18n.t`, which is a
 * lexical name over a var scoped one and therefore a `SyntaxError` raised while
 * the page's own script is instantiated. The page script does not run at all,
 * the window renders the placeholder words in its markup, and a webview reports
 * the reason to a console nobody has open. All three windows shipped that way for
 * the length of one round.
 *
 * So nothing below reaches the global scope. The one thing this file publishes is
 * `window.pigeonI18n`, which is what every page reads it through anyway, and
 * `ui-pages.test.ts` holds the rule for all three pages rather than for this one
 * file.
 */
(() => {
  /*
   * The registry. One entry per shipped locale, in the order the switcher offers
   * them, with the first entry as the fallback for everything.
   *
   * A locale's `code` is its `locales/<code>.json` file. Adding a language is
   * adding a file and a line here, which is the whole of what a translation PR is
   * meant to be.
   *
   * English is the only entry today, and that is what keeps every page byte
   * identical: one locale means no switcher is rendered, no table is loaded and no
   * text is replaced.
   */
  const LOCALES = [{ code: 'en', label: 'English' }];

  /** The locale every other one falls back to, key by key. */
  const FALLBACK = LOCALES[0].code;

  /*
   * Where the chosen locale is remembered.
   *
   * `localStorage` and not the config file, deliberately: which language a person
   * reads a window in is a property of the window and not of the backup, so it
   * has no business travelling through the core, the config or a setup answer. It
   * also means the choice survives a window being destroyed on close, which is the
   * only lifetime a window in this app has.
   */
  const STORAGE_KEY = 'photo-pigeon.locale';

  /** The table for the chosen locale. Empty for English, which is the DOM. */
  let table = {};

  /** The chosen locale's code. Resolved once, at boot, against the registry. */
  let chosen = FALLBACK;

  function known(code) {
    return LOCALES.some((locale) => locale.code === code);
  }

  /*
   * Which locale to render in.
   *
   * A stored code that the registry does not know is ignored rather than honoured:
   * a locale file can be removed from a build, and a window that remembered it
   * would otherwise be a window with no strings at all. Storage can also throw
   * outright, in a webview with site data blocked, and a language preference is
   * not worth a blank page.
   */
  function storedLocale() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return typeof stored === 'string' && known(stored) ? stored : FALLBACK;
    } catch {
      return FALLBACK;
    }
  }

  function remember(code) {
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // A choice that cannot be written still applies to the window that made it.
    }
  }

  /*
   * The whole fallback rule, as a function of its inputs.
   *
   * Pure, and exposed, because it is the one decision in this file that has to be
   * right in a language nobody here reads, and the M3 review's lesson about the
   * tray tick applies word for word: reaching the real thing needs a running
   * window, and that is an argument for extracting the decision rather than for
   * leaving it unguarded.
   *
   * `english` is the English text, written at the call site so the code reads as
   * the sentence it renders. It is also the fallback, so a key the chosen locale
   * has not translated shows English rather than a key name, and a key nobody has
   * written yet still renders.
   *
   * `values` fills `{name}` tokens. Plain replacement, no expression language: a
   * translator moves a token around a sentence, and that is the whole of the power
   * they need. A token with no value is left standing, because a visible `{count}`
   * in a translated string is a bug report and a silently empty one is not, and a
   * value that is missing is left standing for the same reason rather than written
   * out as the word undefined.
   */
  function resolve(from, key, english, values) {
    const translated = from && typeof from[key] === 'string' ? from[key] : undefined;
    let text = translated ?? (typeof english === 'string' ? english : '');
    if (values) {
      for (const name of Object.keys(values)) {
        const value = values[name];
        if (value === undefined || value === null) continue;
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }

  /** One string, in the chosen locale. */
  function t(key, english, values) {
    return resolve(table, key, english, values);
  }

  /*
   * Sweep a tree and translate everything marked in it.
   *
   * Two marks, both attributes on the element that owns the text:
   *
   *   data-i18n="key"                     the element's text
   *   data-i18n-attr="alt:key"            an attribute's value, comma separated
   *                                       for more than one
   *
   * The element's current text is the English fallback, which is what makes the
   * English pass a no-op: `textContent` is written back exactly as it was found,
   * wrapping and indentation included. Every marked element is a leaf for the same
   * reason, since writing `textContent` on a parent would take its children with
   * it, and `i18n.test.ts` holds that.
   *
   * `lookup` is the translator to sweep with, and it is a parameter for the same
   * reason `resolve` is exported: a sweep that can only be watched through a real
   * webview is a sweep with no test.
   */
  function apply(root, lookup) {
    const scope = root ?? document;
    const say = lookup ?? t;

    for (const node of scope.querySelectorAll('[data-i18n]')) {
      const key = node.getAttribute('data-i18n');
      if (key) node.textContent = say(key, node.textContent);
    }

    for (const node of scope.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of (node.getAttribute('data-i18n-attr') ?? '').split(',')) {
        const colon = pair.indexOf(':');
        if (colon < 1) continue;
        const name = pair.slice(0, colon).trim();
        const key = pair.slice(colon + 1).trim();
        if (name && key) node.setAttribute(name, say(key, node.getAttribute(name)));
      }
    }
  }

  /*
   * Read a locale's table.
   *
   * A local JSON module, imported by relative path, exactly as local as the
   * stylesheet and the page scripts. It is only ever reached for a locale that is
   * not the fallback, so today it is not reached at all: English needs no file at
   * runtime and a build with one locale never loads anything.
   *
   * A file that will not load leaves the table empty, which is English. A
   * translation that is missing is not a reason for a window to fail to open.
   */
  async function load(code) {
    if (code === FALLBACK) return {};
    try {
      const module = await import(`./locales/${code}.json`, { with: { type: 'json' } });
      const loaded = module.default ?? module;
      return loaded && typeof loaded === 'object' ? loaded : {};
    } catch {
      return {};
    }
  }

  /*
   * The switcher, top right, and only when there is a choice to make.
   *
   * The rule puts the slot in the page and keeps it empty while English is the
   * only locale, so the airmail design ships as designed and
   * a second locale file is the only thing that ever makes a control appear. It is
   * built here rather than written into the pages because its options are the
   * registry, and a page that listed languages in markup would be a second copy of
   * the registry to forget to update.
   */
  function switcher() {
    const slots = document.querySelectorAll('[data-i18n-switcher]');
    if (slots.length === 0 || LOCALES.length < 2) return;

    for (const slot of slots) {
      // The select sits inside its own label rather than beside one with a `for`,
      // so the control needs no id and two slots on one page cannot collide.
      const label = document.createElement('label');
      label.className = 'lang__label';

      const word = document.createElement('span');
      word.textContent = t('language.label', 'Language');

      const select = document.createElement('select');
      for (const locale of LOCALES) {
        const option = document.createElement('option');
        option.value = locale.code;
        option.textContent = locale.label;
        option.selected = locale.code === chosen;
        select.append(option);
      }

      // A language changes on the reload, not by repainting live: the pages build
      // strings at event time as well as at load, so a half swept window would be
      // two languages at once. A reload of a local page costs nothing and every
      // window here is created on demand anyway.
      select.addEventListener('change', () => {
        remember(select.value);
        window.location.reload();
      });

      label.append(word, select);
      slot.replaceChildren(label);
      slot.classList.remove('hidden');
    }
  }

  /*
   * Boot.
   *
   * Resolved as a promise so a page can wait for the table if it ever needs to,
   * and so this file is one expression rather than a sequence somebody can
   * reorder. With English chosen the whole of it is: read storage, find `en`, load
   * nothing, sweep nothing, and render no switcher because there is nothing to
   * switch to.
   *
   * The switcher call is outside the locale branch on purpose: an English reader
   * on a build that ships a second language is exactly the person who needs the
   * control, so it is the size of the registry that decides whether it appears and
   * never which locale happens to be chosen.
   *
   * **One thing v0.2 owes this, named rather than carried quietly.** A page script
   * runs before this promise settles, so a string a page builds during its own
   * first paint, `Checking...` on the health page, is read from an empty table. In
   * English that is the answer anyway. In another language it is one English word
   * for the length of a load, and the fix is for a page to await `ready` before its
   * first paint rather than for this file to load synchronously.
   */
  const ready = (async () => {
    chosen = storedLocale();
    if (chosen !== FALLBACK) {
      table = await load(chosen);
      document.documentElement.setAttribute('lang', chosen);
      apply(document);
    }
    switcher();
    return chosen;
  })();

  window.pigeonI18n = {
    t,
    resolve,
    apply,
    ready,
    locale: () => chosen,
    locales: () => LOCALES.map((locale) => ({ ...locale })),
  };
})();
