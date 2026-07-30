/*
 * The first-run window's front end.
 *
 * An external file rather than an inline <script>, because the CSP is
 * `default-src 'self'` and an inline script would need it loosened. Nothing
 * here needs it.
 *
 * What this file is allowed to know:
 *
 *   * how to render a setup event
 *   * how to send an answer
 *   * how far along the airmail rail should be
 *
 * What it must never grow:
 *
 *   * a validation rule. The core owns the state machine, so the core owns
 *     which answers are acceptable, and it says so on the channel. A rule
 *     written here is a second copy of a rule and the first place the two
 *     front ends drift.
 *   * a URL it opens. Console links are handed to the system browser by the
 *     core. Consent is too. This page never navigates anywhere.
 *   * a memory of the walk. The core is the state machine; this renders what
 *     it is told and holds only the id of the question on screen, so that an
 *     answer can name it.
 *   * a read of a file. A dragged path and a picked folder are strings, and
 *     they go back to the core exactly as a typed path does.
 *
 * The contract is docs/ASK-PROTOCOL.md. The commands are the fourteen in
 * app/src-tauri/src/ipc.rs, of which this page reaches six.
 */

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

/*
 * The page chrome's strings, per TRAY-DESIGN's i18n section. The English is written
 * at every call site and is also the fallback, so a locale that has not
 * translated a key shows English rather than a key name. Nothing the core sends
 * passes through here: the wizard's prose renders as received.
 */
const t = window.pigeonI18n.t;

const el = (id) => document.getElementById(id);

const ui = {
  railFill: el('rail-fill'),
  rail: el('rail'),
  stepOf: el('step-of'),
  title: el('title'),
  lede: el('lede'),

  welcome: el('welcome'),
  autostart: el('autostart'),
  autostartNote: el('autostart-note'),
  start: el('start'),

  walk: el('walk'),
  said: el('said'),
  prewarn: el('prewarn'),

  ask: el('ask'),
  question: el('question'),
  fieldInput: el('field-input'),
  fieldConfirm: el('field-confirm'),
  fieldFolder: el('field-folder'),
  fieldDrop: el('field-drop'),
  drop: el('drop'),
  answerText: el('answer-text'),
  askError: el('ask-error'),
  sendText: el('send-text'),
  chooseFolder: el('choose-folder'),
  yes: el('answer-yes'),
  no: el('answer-no'),

  signing: el('signing'),
  done: el('done'),
  delivery: el('delivery'),
  postmarkDate: el('postmark-date'),
  doneLine: el('done-line'),
  doneText: el('done-text'),
  finish: el('finish'),

  trouble: el('trouble'),
  troubleText: el('trouble-text'),
};

/** The id of the question on screen, or null between questions. */
let openAsk = null;
/** True once setup_start has been accepted, so a second click cannot spawn a second sidecar. */
let started = false;
/** True only while the credentials question is open, which is when a drop means something. */
let dropArmed = false;
/** How many console screens the core says there are. Corrected by the first heading. */
let totalSteps = 5;

// ---------------------------------------------------------------------------
// the airmail rail
// ---------------------------------------------------------------------------

/*
 * The rail is the one bold element and it is also the only progress indicator,
 * so its arithmetic is worth stating rather than sprinkling.
 *
 * The walk has one segment for the welcome screen, one per console screen, and
 * one for the delivery at the end, so five screens make seven segments. The
 * welcome segment is the reason the arithmetic is not simply `index / total`:
 * without it the signature element is blank on the one screen whose whole job
 * is to set the tone, and an empty rail reads as a bug rather than as a start.
 *
 * The notches are drawn from the same number, so a rail and its scale cannot
 * drift apart, and they are rebuilt on the first heading in case a future
 * wizard has a different number of screens.
 */
function segments() {
  return totalSteps + 2;
}

function drawNotches() {
  const existing = ui.rail.querySelectorAll('.rail__notch');
  for (const node of existing) node.remove();
  for (let n = 1; n < segments(); n += 1) {
    const notch = document.createElement('i');
    notch.className = 'rail__notch';
    notch.style.top = `${(n / segments()) * 100}%`;
    // Before the fill in document order, so the stripe paints over a notch it
    // has already passed. A notch is a mark on the empty part of the rail.
    ui.rail.prepend(notch);
  }
}

function progress(fraction) {
  const percent = Math.max(0, Math.min(1, fraction)) * 100;
  ui.railFill.style.setProperty('--progress', `${percent}%`);
  ui.rail.setAttribute('aria-valuenow', String(Math.round(percent)));
}

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------

function show(node, visible) {
  node.classList.toggle('hidden', !visible);
}

/** Exactly one of the four is up at a time, which is the whole screen model. */
function screen(which) {
  show(ui.welcome, which === 'welcome');
  show(ui.walk, which === 'walk');
  show(ui.signing, which === 'signing');
  show(ui.done, which === 'done');
}

function trouble(text) {
  ui.troubleText.textContent = text;
  show(ui.trouble, true);
}

// ---------------------------------------------------------------------------
// the wizard's prose
// ---------------------------------------------------------------------------

/** The paragraph still being written, or null between them. */
let openLine = null;

/*
 * One line of the wizard's prose.
 *
 * The core's own lines are terminal shaped: a blank line separates paragraphs,
 * a marked line (`step`, `note`, `problem`, `good`) starts one, and a plain
 * line after either of those is the same paragraph continuing, indented to sit
 * under a prefix the terminal draws and the window does not. So plain lines
 * join what came before and everything else starts fresh, which turns the
 * terminal's fragments back into the paragraphs they were written as without
 * changing a single word.
 */
function say(level, text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') {
    openLine = null;
    return;
  }
  const weight = level || 'plain';
  if (weight === 'plain' && openLine) {
    // textContent throughout, never innerHTML. The wizard's prose is the
    // core's, but a folder path inside it is the user's, and a page that builds
    // markup out of a path is a page that can be made to run something.
    openLine.textContent = `${openLine.textContent} ${trimmed}`;
    return;
  }
  const line = document.createElement('p');
  line.className = `said said-${weight}`;
  line.textContent = trimmed;
  ui.said.append(line);
  openLine = line;
}

function heading(index, total, title) {
  openLine = null;
  if (Number.isFinite(total) && total > 0 && total !== totalSteps) {
    totalSteps = total;
    drawNotches();
  }
  ui.stepOf.textContent = t('setup.step', 'Step {index} of {total}', { index, total });
  ui.title.textContent = title;
  ui.lede.textContent = t(
    'setup.walk.lede',
    'Photo Pigeon opens each screen in your browser and waits here for you.',
  );
  ui.said.replaceChildren();
  progress((index + 1) / segments());

  // The unverified app warning belongs from the publishing screen onward: that
  // is where the wizard first explains it, and it is the screen that decides
  // whether the warning is ever seen at all.
  show(ui.prewarn, index >= 4);
}

/*
 * A console deep link.
 *
 * Rendered as text to copy and never as an anchor. The core opened it, or said
 * it could not; either way a page in this app has no permission to open a URL
 * and will not grow one. That is the same rule that keeps Google's consent
 * screen out of this window, and it is worth it being the same rule.
 */
function link(url, opened) {
  const row = document.createElement('div');
  row.className = 'link-row';

  const path = document.createElement('span');
  path.className = 'path selectable';
  path.textContent = url;

  const note = document.createElement('span');
  note.className = 'opened';
  note.textContent = opened
    ? t('setup.link.opened', 'Opened in your browser.')
    : t('setup.link.copy', 'Copy this into your browser.');

  row.append(path, note);
  ui.said.append(row);
  // A link ends the paragraph it followed. What comes after it is a new one.
  openLine = null;
}

// ---------------------------------------------------------------------------
// the one open question
// ---------------------------------------------------------------------------

/*
 * Which extra control an input question gets.
 *
 * Read off the core's own message, because the core is the only thing that
 * knows what it is asking for and the page must not keep a list of question
 * ids. Two shapes earn a control:
 *
 *   folder  the native picker, which is `pick_folder` in Rust
 *   json    the drop target, plus the line about the Downloads watcher
 *
 * Everything else is a plain field. The previous version of this page offered
 * the folder picker to any message containing the word "path", which handed a
 * folder chooser to the question asking for a JSON file.
 */
function helperFor(message) {
  if (/\bjson\b/i.test(message)) return 'json';
  if (/\bfolder\b/i.test(message)) return 'folder';
  return 'none';
}

function ask(event) {
  openAsk = event.id;
  ui.question.textContent = event.message;
  show(ui.ask, true);

  const hasError = typeof event.error === 'string' && event.error !== '';
  show(ui.askError, hasError);
  ui.askError.textContent = hasError ? event.error : '';

  const isText = event.kind === 'input';
  const helper = isText ? helperFor(event.message) : 'none';
  dropArmed = helper === 'json';

  show(ui.fieldInput, isText);
  show(ui.fieldConfirm, !isText);
  show(ui.fieldFolder, helper === 'folder');
  show(ui.fieldDrop, helper === 'json');

  if (isText) {
    ui.answerText.value = typeof event.default === 'string' ? event.default : '';
    ui.answerText.focus();
    ui.answerText.select();
  } else {
    (event.default === false ? ui.no : ui.yes).focus();
  }
}

function closeAsk() {
  openAsk = null;
  dropArmed = false;
  show(ui.ask, false);
  ui.drop.classList.remove('over');
}

/*
 * The card, put back up for a question this page had stopped showing.
 *
 * ASK-PROTOCOL rule 4: an answer for a dead ask id is refused, the refusal
 * names the question that really is open, and that question stays live because
 * nothing was consumed. Nothing follows it, either. A refusal for the live id
 * re-asks with the same id and the reason on it, and this page renders that
 * `ask` as it renders any other; a refusal for a dead id does not re-ask, so a
 * page that had already taken its card down is left silent with a live question
 * behind it and no way to reach it. Unreachable from this file's own wiring,
 * where every send is guarded by `openAsk`, which is exactly why it is written
 * down instead of trusted: the recovery is one wrong guard away from being the
 * thing that ships broken.
 *
 * What arrives is an id and nothing else, so what goes back up is the card the
 * last `ask` rendered: its words, its kind, its extra control. The page keeps
 * no memory of the walk on purpose, and a question re-invented here would be
 * the page writing the wizard's copy. The line above the field is the page's
 * own for the same reason in reverse: the core's sentence for this refusal is
 * about the protocol rather than about the answer somebody typed.
 */
function reopenAsk(id) {
  openAsk = id;
  // Armed off what is on screen rather than remembered, so the credentials
  // question comes back able to take a dropped file again.
  dropArmed = !ui.fieldDrop.classList.contains('hidden');
  ui.askError.textContent = t(
    'setup.answer.stillWaiting',
    'That answer did not reach the wizard. This is the question it is still waiting on.',
  );
  show(ui.askError, true);
  show(ui.ask, true);
  const typing = !ui.fieldInput.classList.contains('hidden');
  (typing ? ui.answerText : ui.yes).focus();
}

async function answer(value) {
  if (openAsk === null) return;
  const id = openAsk;
  // Closed before the round trip, so a double click cannot send the same
  // answer twice. If the core refuses it, the same question comes back with
  // the same id and the reason on it.
  closeAsk();
  try {
    await invoke('setup_answer', { payload: { id, value } });
  } catch (why) {
    trouble(String(why));
  }
}

// ---------------------------------------------------------------------------
// the postmark
// ---------------------------------------------------------------------------

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

/** The date a postmark carries, in the one form every post office uses. */
function stampDate(when) {
  const day = String(when.getDate()).padStart(2, '0');
  return `${day} ${MONTHS[when.getMonth()]} ${when.getFullYear()}`;
}

/*
 * The moment an event says it happened.
 *
 * A postmark is a date the post office stamped, so it is the moment setup
 * finished and not the moment this page got round to drawing it. Every core
 * event carries `at`, sampled when the event became true, which is where that
 * moment lives: the page reads it rather than asking the machine what time it
 * is now.
 *
 * The render moment is the explicit fallback, and it stays explicit. The
 * shell's own lines on this channel carry `at: null` on purpose, because there
 * was no core to ask, and a core one version behind could carry no moment at
 * all. A postmark with no date on it would be the worse answer.
 */
function momentOf(event) {
  const at = typeof event.at === 'string' ? new Date(event.at) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date();
}

function stamp(when) {
  ui.postmarkDate.textContent = stampDate(when);
  // The resting state of the postmark is the stamped one, so adding this class
  // is the difference between arriving with an animation and arriving without.
  // Under prefers-reduced-motion the same class lands everything at once.
  ui.delivery.classList.add('play');
}

// ---------------------------------------------------------------------------
// the event stream
// ---------------------------------------------------------------------------

function handle(event) {
  switch (event.type) {
    case 'setup-started':
      screen('walk');
      show(ui.trouble, false);
      show(ui.prewarn, false);
      // The warning frame travels between two screens, so a run that starts
      // again in the same window has to find it back where it began. Without
      // this a second walk reaches the publishing step and shows nothing,
      // because the frame is still parked on a hidden screen.
      ui.walk.append(ui.prewarn);
      ui.stepOf.textContent = t('setup.eyebrow.starting', 'Starting');
      break;

    case 'heading':
      heading(event.index, event.total, event.title);
      break;

    case 'say':
      say(event.level, event.text);
      break;

    case 'link':
      link(event.url, event.opened === true);
      break;

    case 'ask':
      ask(event);
      break;

    case 'answered':
      if (event.accepted) break;
      // A refusal names the question that is open, and that one field carries
      // three different pieces of news.
      //
      // It names a question this page is not showing, so the card has to come
      // back up. That is protocol rule 4, where the id was dead and no re-ask
      // follows; it is also the ordinary refusal, where this page closed the
      // card on send and the re-ask is one line behind this event. The two are
      // deliberately not told apart, because the card belongs on screen either
      // way and the `ask` behind a re-ask renders the core's own sentence over
      // the page's. Telling them apart would only buy silence on the path where
      // a re-ask went missing.
      //
      // It names the question already on screen: nothing to do at all.
      //
      // It names nothing at all: rule 5, no question is open, so there is
      // nothing to come back to and this walk cannot be finished in this window.
      if (typeof event.open === 'string' && event.open !== '') {
        if (event.open !== openAsk) reopenAsk(event.open);
      } else {
        const why = event.error
          ? String(event.error)
          : t('setup.answer.lost', 'That answer did not reach the wizard');
        const tidy = /[.!?]$/.test(why) ? why : `${why}.`;
        trouble(
          t(
            'setup.answer.reopen',
            '{why} Close this window and open setup again to pick up the walk.',
            { why: tidy },
          ),
        );
      }
      break;

    case 'cancelled':
      if (event.id === openAsk) closeAsk();
      break;

    case 'setup-written':
      closeAsk();
      ui.stepOf.textContent = t('setup.eyebrow.signingIn', 'Signing in');
      ui.title.textContent = t('setup.written.title', 'Finish in your browser');
      ui.lede.textContent = t('setup.written.lede', 'Your settings are saved.');
      progress((totalSteps + 1) / segments());
      break;

    case 'signing-in':
      closeAsk();
      // The prewarn frame moves onto the waiting screen, because this is the
      // minute the user meets the page it describes.
      ui.signing.append(ui.prewarn);
      show(ui.prewarn, true);
      screen('signing');
      progress((totalSteps + 1.5) / segments());
      break;

    case 'setup-done':
      closeAsk();
      ui.stepOf.textContent = t('setup.eyebrow.done', 'Done');
      ui.title.textContent = t('setup.done.title', 'Photo Pigeon is ready');
      ui.lede.textContent = t('setup.done.lede', 'Signed in, and your credentials work.');
      ui.doneLine.textContent = t(
        'setup.done.signedIn',
        'Signed in. The pigeon starts watching now.',
      );
      if (typeof event.ledgerPath === 'string' && event.ledgerPath !== '') {
        ui.doneText.textContent = t(
          'setup.done.textWithLedger',
          'Anything already in your watched folders goes on the first pass. ' +
            'The record of everything delivered lives at {ledgerPath}. ' +
            'You can close this window: the pigeon lives in the notification area.',
          { ledgerPath: event.ledgerPath },
        );
      }
      screen('done');
      progress(1);
      stamp(momentOf(event));
      break;

    case 'failed':
      trouble(event.error ?? t('setup.failed', 'Setup did not finish. Nothing was written.'));
      break;

    case 'setup-refused':
      trouble(event.error ?? t('setup.refused', 'Setup could not be started.'));
      screen('welcome');
      started = false;
      ui.start.disabled = false;
      break;

    case 'setup-exited':
      closeAsk();
      started = false;
      break;

    case 'stopping':
    case 'stopped':
      break;

    default:
      // A type this build does not know is not a reason to break the page. The
      // shell's own rule for the watch stream, applied here.
      break;
  }
}

listen('setup-event', (message) => {
  let event;
  try {
    event = JSON.parse(message.payload);
  } catch {
    return;
  }
  if (event && typeof event.type === 'string') handle(event);
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

ui.start.addEventListener('click', async () => {
  if (started) return;
  started = true;
  ui.start.disabled = true;
  try {
    await invoke('setup_start');
  } catch (why) {
    started = false;
    ui.start.disabled = false;
    trouble(String(why));
  }
});

ui.yes.addEventListener('click', () => void answer(true));
ui.no.addEventListener('click', () => void answer(false));
ui.sendText.addEventListener('click', () => void answer(ui.answerText.value));
ui.answerText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void answer(ui.answerText.value);
});

ui.chooseFolder.addEventListener('click', async () => {
  const picked = await invoke('pick_folder');
  // Cancelled is null and means nothing happened, not an empty answer.
  if (typeof picked !== 'string' || picked === '') return;
  ui.answerText.value = picked;
  // Choosing a folder in a native dialog already is the confirming gesture, so
  // it answers rather than filling a box somebody then has to press Next on. A
  // path the core refuses comes straight back as the same question.
  void answer(picked);
});

/*
 * Start with Windows, on the screen where TRAY-DESIGN section 8 wants it: a
 * visible line during first run, not a settings page discovered later.
 *
 * The checkbox renders the registry rather than a preference. The write lands
 * on the supervisor thread after `autostart_set` returns, so one immediate
 * read can still see the world from before the click; the handler re-reads
 * until the registry agrees or stops changing, and the registry's answer is
 * always the last word: a write that failed ends showing the state that
 * exists and not the one that was asked for.
 */
async function readAutostart() {
  try {
    ui.autostart.checked = (await invoke('autostart_get')) === true;
  } catch {
    ui.autostart.disabled = true;
    ui.autostartNote.textContent = t(
      'setup.autostart.unavailable',
      'Starting with Windows is a Windows feature and this build cannot set it from here. The tray menu has the same tick.',
    );
  }
}

/*
 * The Finish button on the done screen (the status-window reshape):
 * open the status window, close this one. Both halves happen in Rust, so
 * the close still travels the CloseRequested path and destroy-on-close
 * stays the only exit a setup window has.
 */
ui.finish.addEventListener('click', async () => {
  try {
    await invoke('finish_setup');
  } catch (why) {
    trouble(String(why));
  }
});

ui.autostart.addEventListener('change', async () => {
  const asked = ui.autostart.checked;
  try {
    await invoke('autostart_set', { on: asked });
  } catch (why) {
    trouble(String(why));
  }
  for (const delay of [0, 150, 450, 1200]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await readAutostart();
    if (ui.autostart.checked === asked) break;
  }
});

/*
 * Dragging the downloaded client JSON onto the window.
 *
 * Tauri intercepts drag and drop before the page sees it, and hands over the
 * dropped paths rather than the files, which is exactly the shape this app
 * wants: the page learns a string and the core reads the file. That is the same
 * trade `pick_folder` makes, and the reason neither of them needs the file
 * system plugin.
 *
 * It is wired defensively because it is the one capability here that a future
 * Tauri release could move. If it is not available, the typed path and the
 * core's own Downloads watcher both still finish the walk, so a missing
 * listener costs a convenience and never the setup.
 */
async function wireDragDrop() {
  try {
    const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
    if (!webview || typeof webview.onDragDropEvent !== 'function') return;
    await webview.onDragDropEvent((event) => {
      if (!dropArmed) return;
      const kind = event?.payload?.type;
      if (kind === 'over' || kind === 'enter') {
        ui.drop.classList.add('over');
        return;
      }
      if (kind === 'leave' || kind === 'cancel') {
        ui.drop.classList.remove('over');
        return;
      }
      if (kind !== 'drop') return;
      ui.drop.classList.remove('over');
      const paths = Array.isArray(event.payload.paths) ? event.payload.paths : [];
      const first = paths.find((path) => typeof path === 'string' && path !== '');
      if (!first) return;
      ui.answerText.value = first;
      void answer(first);
    });
  } catch {
    // No drag and drop on this build. The field and the watcher still work.
  }
}

drawNotches();
// The welcome screen is the first segment, so the rail carries ink from the
// moment the window opens.
progress(1 / segments());
void readAutostart();
void wireDragDrop();
