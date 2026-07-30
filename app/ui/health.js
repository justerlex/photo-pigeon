/*
 * The health window's front end.
 *
 * External, for the same CSP reason as the other two pages.
 *
 * It renders the core's own `DoctorReport` and nothing else. There is no second
 * opinion here and there must never be one: a rule this page checked for itself
 * would be a rule that could disagree with `photo-pigeon doctor`, and the
 * person reading this window is the same person who might run that command
 * five minutes later.
 *
 * The check runs once when the window opens, because somebody who clicked
 * Setup and health has already asked for it, and again on demand. It is a
 * gesture every time: nothing on a timer runs it.
 */

const invoke = window.__TAURI__.core.invoke;

/*
 * The page chrome's strings, per TRAY-DESIGN's i18n section, with the English at
 * every call site as the fallback. The findings themselves are the core's own
 * and are rendered as received: a doctor row is a sentence from another process.
 */
const t = window.pigeonI18n.t;

const el = (id) => document.getElementById(id);

const ui = {
  verdict: el('verdict'),
  lede: el('lede'),
  checks: el('checks'),
  runDoctor: el('run-doctor'),
  openLog: el('open-log'),
};

/*
 * The four levels the core reports, and the word each one shows beside its
 * mark.
 *
 * The word is not decoration. A health row is a plain sentence with green,
 * amber or red as a small mark beside it, and a mark that is only a colour is
 * a mark that eight percent of men cannot read. So every dot has a word, and
 * the word is what the row actually means rather than the level's internal
 * name: `warn` is a thing to look at before it bites, `fail` is a thing to fix
 * now.
 *
 * Each word is a function and not a string because a locale table can arrive
 * after this file has run: a constant would freeze whatever was loaded at the
 * moment the script was parsed, which is English. Asking at render time cannot
 * be wrong.
 */
const LEVELS = {
  ok: () => t('health.level.ok', 'ok'),
  note: () => t('health.level.note', 'note'),
  warn: () => t('health.level.warn', 'warning'),
  fail: () => t('health.level.fail', 'fix this'),
};

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.append(span('what empty', text));
  return li;
}

/*
 * One finding: a mark, a sentence, the detail, and the link as text to copy.
 *
 * `Object.hasOwn` and not `in`, which is round two's banked minor: `in` asks the
 * prototype chain, so `constructor` and `toString` are levels this page would
 * think it knew. The guard passed, `LEVELS[level]()` called something off
 * `Object.prototype`, and the row rendered `[object Object]` as its mark in a
 * class no stylesheet has. Only the core's own `DoctorReport` reaches this and
 * `DoctorLevel` is a closed union of four, so it was latent rather than live, and
 * one rename in the core away from being a window full of garbage marks.
 */
function checkRow(check) {
  const level =
    typeof check.level === 'string' && Object.hasOwn(LEVELS, check.level) ? check.level : 'note';

  const li = document.createElement('li');
  li.append(span(`mark mark-${level}`, LEVELS[level]()));

  const what = document.createElement('div');
  what.className = 'what';
  what.append(span('selectable', check.title ?? ''));

  if (check.detail) {
    const detail = document.createElement('p');
    detail.className = 'detail selectable';
    detail.textContent = check.detail;
    what.append(detail);
  }

  // A console link is shown and never opened. Photo Pigeon hands links to the
  // system browser from its own process; a page in this app has no permission
  // to open a URL and will not grow one.
  if (typeof check.link === 'string' && check.link !== '') {
    const link = document.createElement('p');
    link.className = 'detail path selectable';
    link.textContent = check.link;
    what.append(link);
  }

  li.append(what);
  return li;
}

/** The one line at the top: what the whole report adds up to. */
function summarize(checks, ok) {
  const bad = checks.filter((check) => check.level === 'fail').length;
  const warned = checks.filter((check) => check.level === 'warn').length;

  if (bad > 0) {
    ui.verdict.textContent =
      bad === 1
        ? t('health.summary.oneToFix', 'One thing to fix')
        : t('health.summary.manyToFix', '{count} things to fix', { count: bad });
    ui.lede.textContent = t(
      'health.summary.fixLede',
      'Each row below says what it is and what fixes it.',
    );
    return;
  }
  if (warned > 0) {
    ui.verdict.textContent =
      warned === 1
        ? t('health.summary.oneToWatch', 'One thing to watch')
        : t('health.summary.manyToWatch', '{count} things to watch', { count: warned });
    ui.lede.textContent = t(
      'health.summary.watchLede',
      'Nothing is broken. These are the ones that bite later.',
    );
    return;
  }
  ui.verdict.textContent =
    ok === false
      ? t('health.title', 'Health')
      : t('health.summary.allGood', 'Everything checks out');
  ui.lede.textContent = t('health.summary.okLede', 'This is the same check the command line runs.');
}

async function runCheck() {
  ui.runDoctor.disabled = true;
  ui.checks.replaceChildren(emptyRow(t('health.checking', 'Checking...')));
  try {
    const report = await invoke('doctor_report');
    const checks = Array.isArray(report.checks) ? report.checks : [];
    summarize(checks, report.ok);
    ui.checks.replaceChildren(
      ...(checks.length === 0
        ? [emptyRow(t('health.checks.empty', 'The health check had nothing to say.'))]
        : checks.map(checkRow)),
    );
  } catch (why) {
    // An error explains the fix and does not apologise. This one usually means
    // the engine binary could not be found, which is a broken install rather
    // than a broken setup, so it says where to look.
    ui.verdict.textContent = t('health.error.title', 'The check did not run');
    ui.lede.textContent = t(
      'health.error.lede',
      'Photo Pigeon could not start its own engine to ask.',
    );
    ui.checks.replaceChildren(emptyRow(String(why)));
  } finally {
    ui.runDoctor.disabled = false;
  }
}

ui.runDoctor.addEventListener('click', () => void runCheck());
ui.openLog.addEventListener('click', () => void invoke('open_path', { kind: 'log' }));

void runCheck();
