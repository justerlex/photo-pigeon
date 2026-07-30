/*
 * The status and history window's front end.
 *
 * External, for the same CSP reason as the setup page: `default-src 'self'`
 * and nothing here needs it loosened.
 *
 * It polls rather than subscribes, and that is deliberate. The event stream is
 * the supervisor's, and a page that listened to it would be a second consumer
 * of the same events with its own idea of what they mean, which is exactly the
 * duplicate that cost the M3 review a critical. Instead the supervisor
 * publishes one snapshot on every render and this reads it, so the window and
 * the menu are the same picture by construction.
 *
 * The poll is a UI refresh in an open window and not a schedule that does work.
 * TRAY-DESIGN law 2 forbids a timer that sends `rescan`; nothing here sends
 * anything to the core except when somebody presses a button. When the window is
 * closed it is destroyed, so the timer goes with it.
 *
 * ## The controls, and the one rule they are all instances of
 *
 * This window is the main UI as of the status-window reshape, so Pause, Resume
 * and Deliver now live here. Everything about them comes from the snapshot: the
 * wording, the enabled state, and the word a click writes. Nothing is computed
 * here and nothing is guessed, and the reason is that both ways of guessing are
 * shipped criticals in this project's own history. The M3 review's first was a
 * menu claiming Paused over an engine that was delivering; its second was a
 * button that cleared a quota hold nobody had lifted. A page is a worse place to
 * make either mistake than a menu is, because it is bigger and it is the surface
 * a person is actually looking at.
 *
 * So there is no optimistic repaint anywhere below. A click disables its own
 * button, which is a statement about the click and not about the engine, and the
 * next snapshot says what really happened.
 *
 * ## The Watching list, which is the one part that writes
 *
 * It writes only when a person clicks, and every path it sends is a string it was
 * given: from `pick_folder` or out of the snapshot the core filled. The core
 * validates every one of them, so this page holds no rule about what a folder is
 * and no rule about how many have to stay.
 */

const invoke = window.__TAURI__.core.invoke;

/*
 * The page chrome's strings, per TRAY-DESIGN's i18n section, with the English at
 * every call site as the fallback. Nothing the supervisor sends passes through
 * here: the status line, the storage line and the storage honesty sentence are
 * painted from the snapshot exactly as they arrive.
 */
const t = window.pigeonI18n.t;

const el = (id) => document.getElementById(id);

/*
 * Editing the Watching list, from this page.
 *
 * Two module level facts and no more, because everything else on this page is
 * painted from the snapshot and a second source of truth is how a window starts
 * disagreeing with the engine.
 *
 *   pendingRemoval  the folder whose row is mid question, so the poll can
 *                   repaint without throwing the question away
 *   busy            an edit is in flight, so a second click cannot send a
 *                   second one
 *
 * `lastNote` is the one line of copy this page keeps, and it is never this page's
 * own words about a rule: it is the sentence the core sent back, or the shell's
 * about the restart it did afterwards.
 */
let pendingRemoval = null;
let busy = false;
let lastNote = '';

/*
 * What the Watching list was last built from: the folders, and the row mid
 * question.
 *
 * The poll replaces the whole list once a second, which was free while the rows
 * were text and is not free now that they hold buttons: an element swapped out
 * between a mousedown and a mouseup gets no click at all, so a rebuild on a timer
 * is a button that quietly ignores one press in some fraction of them, and it
 * takes the keyboard focus off a row the moment somebody tabs to it. The list is
 * therefore rebuilt when its contents change and not when the clock ticks. Both
 * things a row can be drawn from are in the signature, because the confirm
 * sentence is a state of the list as much as the folders are.
 */
let builtFrom = '';

const ui = {
  statusLine: el('status-line'),
  storageLine: el('storage-line'),
  attention: el('attention'),
  attentionText: el('attention-text'),
  delivered: el('c-delivered'),
  skipped: el('c-skipped'),
  failed: el('c-failed'),
  bytes: el('c-bytes'),
  honesty: el('honesty'),
  watchDirs: el('watch-dirs'),
  watchNote: el('watch-note'),
  addWatched: el('add-watched'),
  recent: el('recent'),
  autostart: el('autostart'),
  autostartNote: el('autostart-note'),
  engineAction: el('engine-action'),
  deliverNow: el('deliver-now'),
  openLog: el('open-log'),
  openSetup: el('open-setup'),
  engine: el('engine'),
  shellLog: el('shell-log'),
};

/** How often the open window repaints. Cheap, and it dies with the window. */
const REFRESH_MS = 1000;

/**
 * The word the engine button writes, as the last snapshot published it.
 *
 * `pause`, `resume`, or nothing. It is held here rather than read back off the
 * button because a label is for a person: "Resume" and "Starting again" are two
 * labels for one moment in the pause, and only the shell knows which word, if
 * any, the core would answer right now.
 */
let engineWord = null;

/**
 * Matches `format_bytes` in state.rs and `formatBytes` in the core.
 *
 * The units are a contract with those two and not page copy, which is why they
 * carry no locale keys. A byte count wants the platform's own number formatting
 * rather than a string table, and picking that is v0.2 work.
 */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (!bytes) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The clock part of an ISO moment, or nothing. */
function clockOf(iso) {
  if (typeof iso !== 'string') return '';
  const t = iso.indexOf('T');
  return t > 0 && iso.length >= t + 6 ? iso.slice(t + 1, t + 6) : '';
}

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function row(...parts) {
  const li = document.createElement('li');
  for (const part of parts) li.append(part);
  return li;
}

function emptyRow(text) {
  return row(span('what empty', text));
}

function button(label, onClick) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function actions(...buttons) {
  const holder = document.createElement('div');
  holder.className = 'row-actions';
  for (const node of buttons) holder.append(node);
  return holder;
}

/*
 * Open this row's folder, by its position, and say which folder that position was
 * showing.
 *
 * The same rule `open_path` holds with its kinds, one step further along: the
 * list came from the shell's own snapshot, so an index cannot name anything this
 * app was not already watching, and a page that handed a path back for opening
 * would be an arbitrary file opener wearing a scoped permission. That has not
 * changed. The path travelling beside the index is not an address and the shell
 * cannot open it: it is this row's account of itself, and all it can do is stop
 * the wrong folder from opening.
 *
 * Why it has to: this page repaints once a second, so a folder removed from the
 * front of the list shifts every row below it while the window still shows the
 * old order. Row 1 said Screenshots when it was drawn and index 1 is the next
 * folder along by the time the click lands, both in range, and the click opens
 * something the person did not press. The shell refuses on the disagreement
 * instead.
 *
 * The refusal is shown, like every other refused click on this page. It used to
 * be swallowed, which was fair while the only refusal was a row that had already
 * gone: the repaint took the row away and the silence explained itself. A shifted
 * list is the other kind, where the row is still on screen and still says what it
 * said, and a click that quietly does nothing there is a dead button.
 */
function openRow(dir, index) {
  const open = button(t('status.watching.open', 'Open folder'), async () => {
    try {
      await invoke('open_watched', { index, path: dir });
      answered('');
    } catch (why) {
      // The shell's own sentence, for the same reason the folder edits render the
      // core's: the side that refused is the side that knows what changed.
      answered(String(why));
    }
    await refresh();
  });
  // The path is already the visible half of the row, so the button says what it
  // does and the tooltip says which one it is.
  open.title = dir;
  return open;
}

/*
 * One folder, with both of its actions on its own row.
 *
 * Two decisions land in the same place: a folder is
 * opened and stopped from the row it is named in, so nothing has to guess which
 * folder a lone button meant and there is no second list to keep in step.
 *
 * The path is the string the core sent in the snapshot, and it is the same string
 * that goes back to `remove_watched_folder`, where the core revalidates it. This
 * page never builds a path, never joins one and never shortens one: a list that
 * showed a prettier version of the truth would be a list whose Remove button
 * removed something else.
 */
function watchRow(dir, index) {
  if (pendingRemoval === dir) return askingRow(dir);
  const li = row(span('what path selectable', dir));
  li.className = 'acted';
  li.append(
    actions(
      openRow(dir, index),
      button(t('status.watching.remove', 'Remove'), () => {
        pendingRemoval = dir;
        void refresh();
      }),
    ),
  );
  return li;
}

/*
 * The same row, mid question.
 *
 * The sentence names the folder and says what removing it does not do. That
 * second half is the whole point: the fear a person has at this button is that
 * their photos are about to go, and the true answer is that this tool has never
 * been able to delete anything, here or in their library.
 */
function askingRow(dir) {
  const li = row(span('what path selectable', dir));
  li.className = 'asking';
  li.append(
    span(
      'small',
      t(
        'status.watching.confirm',
        'Stop watching this folder? Nothing is deleted from your disk and nothing is removed from Google Photos. New photos here simply stop being sent.',
      ),
    ),
    actions(
      button(t('status.watching.confirmYes', 'Stop watching it'), () => void removeFolder(dir)),
      button(t('status.watching.confirmNo', 'Keep watching it'), () => {
        pendingRemoval = null;
        void refresh();
      }),
    ),
  );
  return li;
}

/** Remember the answer to the last click. Empty means the click was honoured. */
function answered(text) {
  lastNote = typeof text === 'string' ? text : '';
}

/*
 * The one line under the list.
 *
 * The answer to the last click outranks the shell's running commentary, because a
 * refusal is about the thing the person just pressed and the commentary is about
 * what is running. A click that was honoured clears it, and then the shell's own
 * sentence about the restart is what shows.
 */
function paintNote(shellNotice) {
  const text = lastNote || (typeof shellNotice === 'string' ? shellNotice : '');
  ui.watchNote.textContent = text;
  ui.watchNote.classList.toggle('hidden', text === '');
}

/*
 * The two edits, each naming its own command.
 *
 * Named literally rather than passed as a string, so the sweep in
 * `src/commands/ui-pages.test.ts` can see every command this page can reach. An
 * `invoke` whose name is a variable is a call the allowlist cannot check, which
 * makes the allowlist a comment.
 */
const addWatched = (dir) => invoke('add_watched_folder', { path: dir });
const removeWatched = (dir) => invoke('remove_watched_folder', { path: dir });

/*
 * One edit, and whatever the core said about it.
 *
 * Every answer is rendered, including the ones that changed nothing, because the
 * core answers every request for exactly that reason: a window that hears nothing
 * has one reading of silence and it is the wrong one. The sentence is the core's,
 * never this page's: the rule about how many folders have to stay lives with the
 * file, and a page that repeated it would be the second place it lives.
 *
 * The busy guard answers too. A click refused while an edit is in flight is
 * still a click, and a refusal with no sentence is a dead button wearing a
 * working label: the same silence this page refuses to accept from the core.
 */
async function edit(request, dir) {
  if (busy) {
    answered(t('status.watching.busy', 'Still working on the last change. One moment, then try again.'));
    return;
  }
  busy = true;
  try {
    const answer = await request(dir);
    if (answer && answer.type === 'folders-changed') {
      // Deliberately not a sentence of our own about what happens next: the
      // shell's own notice arrives on the next snapshot and says whether the
      // engine is starting again, which is the part that is worth reading.
      answered('');
    } else if (answer && typeof answer.why === 'string') {
      answered(answer.why);
    } else {
      answered(
        t(
          'status.watching.unexplained',
          'That did not change anything, and this build could not tell why.',
        ),
      );
    }
  } catch (why) {
    answered(String(why));
  } finally {
    busy = false;
    pendingRemoval = null;
    await refresh();
  }
}

async function removeFolder(dir) {
  await edit(removeWatched, dir);
}

/*
 * The engine line, as four whole sentences rather than one sentence and three
 * fragments.
 *
 * A translator handed ", version {version}" on its own cannot see what it
 * attaches to, and a language that wants the number somewhere else in the
 * sentence cannot be written at all. So every shape the footer can take is its
 * own key. It costs four lines here and it buys four sentences a person can
 * actually translate.
 */
function engineLine(snapshot) {
  const pid = snapshot.corePid;
  if (!pid) return t('status.engine.notStarted', 'Engine: not started.');

  const version = snapshot.coreVersion;
  const values = { pid, version };
  if (version && snapshot.dryRun) {
    return t(
      'status.engine.runningVersionDryRun',
      'Engine: process {pid}, version {version}, dry run.',
      values,
    );
  }
  if (version) {
    return t('status.engine.runningVersion', 'Engine: process {pid}, version {version}.', values);
  }
  if (snapshot.dryRun) {
    return t('status.engine.runningDryRun', 'Engine: process {pid}, dry run.', values);
  }
  return t('status.engine.running', 'Engine: process {pid}.', values);
}

/*
 * Repaint from one snapshot.
 *
 * Everything on this page comes from the same struct, `StatusSnapshot` in
 * app/src-tauri/src/supervisor.rs, and the field names below are that contract.
 * Nothing is computed here that the shell already knows: the status line and
 * the storage line are the menu's own strings, so the window and the tray
 * cannot drift into two different accounts of the same run.
 */
function paint(snapshot) {
  // Written only when the shell sent one: an empty snapshot leaves the markup's
  // own words standing, the same rule the controls follow, rather than this
  // page authoring a second copy of a sentence the shell owns.
  if (snapshot.statusLine) ui.statusLine.textContent = snapshot.statusLine;
  ui.storageLine.textContent = snapshot.storageLine || '';
  if (snapshot.storageHonesty) ui.honesty.textContent = snapshot.storageHonesty;

  const needsLooking = typeof snapshot.attention === 'string' && snapshot.attention !== '';
  ui.attention.classList.toggle('hidden', !needsLooking);
  ui.attentionText.textContent = needsLooking ? snapshot.attention : '';

  ui.delivered.textContent = String(snapshot.delivered ?? 0);
  ui.skipped.textContent = String(snapshot.skipped ?? 0);
  ui.failed.textContent = String(snapshot.failed ?? 0);
  ui.bytes.textContent = formatBytes(snapshot.bytes ?? 0);

  /*
   * The controls. Three fields of the snapshot, applied and not interpreted.
   *
   * The label is only written when there is one, so a snapshot that arrives
   * without it leaves the markup's own words standing rather than emptying the
   * button. Enabled follows the shell in both directions, which is what keeps
   * this honest during a quota hold: the engine really is running then, the
   * amber line above says so, and pausing it and asking for one more pass are
   * both things the core would answer. The one thing this page may never do is
   * decide for itself that a red line means nothing works.
   */
  const control = snapshot.engineControl ?? {};
  if (control.label) ui.engineAction.textContent = control.label;
  engineWord = typeof control.word === 'string' ? control.word : null;
  ui.engineAction.disabled = control.enabled !== true || engineWord === null;
  ui.deliverNow.disabled = snapshot.deliverNowEnabled !== true;

  const dirs = snapshot.watchDirs ?? [];
  // A row whose folder is no longer in the list has nothing left to confirm.
  if (pendingRemoval !== null && !dirs.includes(pendingRemoval)) pendingRemoval = null;
  const wanted = JSON.stringify([dirs, pendingRemoval]);
  if (wanted !== builtFrom) {
    builtFrom = wanted;
    ui.watchDirs.replaceChildren(
      ...(dirs.length === 0
        ? [emptyRow(t('status.watching.empty', 'The engine has not said what it watches yet.'))]
        : dirs.map((dir, index) => watchRow(dir, index))),
    );
  }
  paintNote(snapshot.notice);

  // The way into first run, shown only while nothing is configured: no core
  // and no watched folders is the shape an unconfigured machine has. A
  // configured machine passes through that state for under a second at
  // startup, which is why this is a quiet link and not a takeover.
  const unconfigured = !snapshot.corePid && dirs.length === 0;
  ui.openSetup.classList.toggle('hidden', !unconfigured);

  // Newest first, because a person opening this window wants the last thing
  // that happened, and the ring arrives newest last.
  const recent = snapshot.recent ?? [];
  ui.recent.replaceChildren(
    ...(recent.length === 0
      ? [emptyRow(t('status.recent.empty', 'Nothing yet.'))]
      : [...recent].reverse().map((entry) => {
          const when = document.createElement('time');
          when.textContent = clockOf(entry.at);
          return row(when, span('what', entry.detail));
        })),
  );

  ui.autostart.checked = snapshot.autostartOn === true;
  ui.autostart.disabled = snapshot.autostartAvailable !== true;
  if (snapshot.autostartAvailable !== true) {
    ui.autostartNote.textContent = t(
      'status.autostart.unavailable',
      'Starting with Windows is a Windows feature and this build cannot set it from here.',
    );
  }

  ui.engine.textContent = engineLine(snapshot);
  ui.shellLog.textContent = snapshot.shellLogPath ?? '';
}

async function refresh() {
  try {
    paint(await invoke('status_snapshot'));
  } catch {
    // A snapshot that cannot be read is not worth breaking the page over. The
    // next tick tries again.
  }
}

ui.openSetup.addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    await invoke('open_setup');
  } catch {
    // The tray menu's own item is the fallback door.
  }
});

ui.autostart.addEventListener('change', async () => {
  // Say what is wanted; the registry still decides. The next snapshot carries
  // what really happened, so a write that failed shows as the state that
  // exists rather than as the one that was asked for.
  await invoke('autostart_set', { on: ui.autostart.checked });
  await refresh();
});

/*
 * Pause or resume, whichever the last snapshot said this button is.
 *
 * The word is checked again here even though a wordless control is a disabled
 * one, because the two facts are set together in `paint` and a future edit could
 * separate them. The core answers every one of these words on the machine
 * channel, including the ones that change nothing, so the shell always has an
 * answer to publish and this page never has to interpret silence.
 */
ui.engineAction.addEventListener('click', async () => {
  if (engineWord === null) return;
  // Disabled on the click and left that way until a snapshot re-enables it. This
  // is a receipt for the press and not a claim about the engine: the shell moves
  // to "Pausing, finishing what is in flight" when it is really pausing, and if
  // the core never answers the word the shell says so in the line above.
  ui.engineAction.disabled = true;
  try {
    await invoke('engine_action', { kind: engineWord });
  } catch {
    // A refusal is not this page's to explain. The next snapshot carries what
    // really happened, and the shell has better words for it than a window that
    // was one poll behind when the click landed.
  }
});

// One reconciliation pass, because a person asked for one. TRAY-DESIGN law 2: a
// gesture and never a timer, which is why this is the only thing on the page
// that can cause a scan and it needs a click every time.
ui.deliverNow.addEventListener('click', async () => {
  ui.deliverNow.disabled = true;
  try {
    await invoke('engine_action', { kind: 'deliver' });
  } catch {
    // Same reason. A pass the shell would not ask for changes nothing here.
  }
});

/*
 * Adding a folder: the native picker, then straight back to the core.
 *
 * The precedent is the setup page, which has done exactly this since M4. The page
 * never learns a path it was not given: `pick_folder` opens a native dialog from
 * Rust and hands back a string, the string goes back for the core to validate, and
 * nothing in the webview reads or writes it. That is why neither of these needs a
 * file system permission, and neither has one.
 *
 * Choosing a folder in a native dialog already is the confirming gesture, so it
 * adds rather than filling a box somebody then has to press Add on. A folder the
 * core refuses comes straight back as the core's own sentence.
 */
ui.addWatched.addEventListener('click', async () => {
  if (busy) {
    answered(t('status.watching.busy', 'Still working on the last change. One moment, then try again.'));
    return;
  }
  // The picker holds the flag too. The native dialog is modeless to this page,
  // so without it every extra click while one was open spawned another dialog:
  // as many pickers as clicks, found on a walk of the built window. Down again in
  // the finally so a cancelled or failed pick cannot wedge the page.
  busy = true;
  let picked;
  try {
    picked = await invoke('pick_folder');
  } catch (why) {
    answered(String(why));
    await refresh();
    return;
  } finally {
    busy = false;
  }
  // Cancelled is null and means nothing happened, not an empty answer.
  if (typeof picked !== 'string' || picked === '') return;
  await edit(addWatched, picked);
});

// A kind, never a path. `open_path` decides for itself what "log" means, which
// is why this page can offer the button without being an arbitrary file opener
// wearing a scoped permission. The watched folders are reached by their rows
// instead, so nothing on this page asks for the "watched" kind any more: that
// button was the one that had to guess which folder somebody meant.
ui.openLog.addEventListener('click', () => void invoke('open_path', { kind: 'log' }));

void refresh();
setInterval(() => void refresh(), REFRESH_MS);
