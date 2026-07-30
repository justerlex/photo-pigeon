# The ask protocol

The contract for the setup channel: how `photo-pigeon setup` asks a question over
NDJSON, how a front end answers it, and what happens to an answer that arrives
late, twice or wrong. Three pieces of code are built against this document:
`src/commands/setup-channel.ts`, `app/src-tauri/src/setup_host.rs` and
`app/ui/setup.js`.

Where this and the code disagree, **the code wins and this document is the
bug**, exactly as `docs/TRAY-DESIGN.md` says of itself. The authorities are:

| Thing | Authority |
|---|---|
| The event shapes | `SetupEventBody` in `src/commands/setup-channel.ts` |
| The answer form | `createSetupChannel().line` in the same file |
| The seam the wizard asks through | `Ask` in `src/wizard/ask.ts` |
| The words on the wire | `spawn.setupArgs` and `spawn.answerWord` in `app/scripts/sidecar-layout.json` |
| The shell's half | `app/src-tauri/src/setup_host.rs` |

---

## 0. Why there is a protocol at all

The wizard is one state machine and it has two front ends: first run gets its
own window, and the terminal wizard stays whole for CLI users. That is decision
3 in TRAY-DESIGN section 8.

The wizard's **output** has sat behind `WizardIo` since the first version, so a
test could run the whole walk quietly. Its **input** did not. `steps.ts`
imported `confirm` and `input` from `@inquirer/prompts` and called them, and
`requireInteractive()` threw when `process.stdin.isTTY` was false, which is
exactly what a sidecar spawned by a tray is. So the window could not reuse the
wizard and would have had to grow a second copy of it, which is two copies of
every rule about what a Google project id looks like and two places for them to
drift.

The input sits behind a seam too now. One state machine, two front ends:

```
                    src/wizard/steps.ts          the screens, unchanged
                       |            |
              ctx.io   |            |   ctx.ask
                       v            v
   terminal     consoleIo      terminalAsk       @inquirer/prompts
   window       channel.io     channel.ask       NDJSON, this document
```

---

## 1. The shape of the channel

`photo-pigeon setup --events ndjson` is the same kind of process
`watch --events ndjson` is, and a reader who knows one knows the other:

- **stdout carries one JSON line per event and nothing else**, so a parent may
  parse it strictly and fail loudly rather than guess.
- **human prose goes to stderr.** The two never share a descriptor. The choice
  is made once, from the flag, for the run and its error path together, so a
  strict parser never meets a sentence.
- **every event carries `type` and `at`.** The envelope key is `type`, never
  `t`.
- **`stopped` is the last line of every run**, including the runs that failed
  before anything started and the runs somebody cancelled.

Two flags matter besides `--events`:

| Flag | What it does |
|---|---|
| `-c, --config <path>` | Writes the whole setup beside that config file instead of under the home folder. This is what makes a real setup runnable in a temp directory by a test or by the rig, with any production install unreachable. |
| `--no-open` | Prints the console links instead of handing them to a browser. For a headless machine, and for any test that must not open a browser on somebody's desktop. |

---

## 2. The events

Copied from `SetupEventBody`, which is the authority.

| `type` | Carries | What a front end does with it |
|---|---|---|
| `setup-started` | `pid`, `version?`, `configPath`, `steps` | The run is up and this is where it will write. |
| `heading` | `index`, `total`, `title` | A new screen. Clear the prose from the last one. |
| `say` | `level`, `text` | One line of the wizard's own prose. `level` is `plain`, `step`, `note`, `problem` or `good`, which is the weight the terminal renders as a colour. |
| `link` | `url`, `opened` | A console deep link. `opened` says whether the core already handed it to the system browser. |
| `ask` | `id`, `kind`, `message`, `default?`, `error?` | The one open question. `error` is present only on a re-ask. |
| `answered` | `id`, `accepted`, `error?`, `open?` | The receipt for exactly one `answer` line. |
| `cancelled` | `id` | That question is off the table and was never answered. |
| `setup-written` | `configPath`, `watchDirs`, `album?` | The config is on disk. Sign-in is next. |
| `signing-in` | nothing | Consent is happening in the system browser. **Deliberately carries no URL.** |
| `setup-done` | `configPath`, `ledgerPath` | Finished, and the credentials really work. The moment is the envelope's `at`, and the window's postmark is stamped from it rather than from the machine's clock at render time. |
| `failed` | `error` | The run itself did not make it. |
| `stopping` | `reason` | `stdin` for a cancel, `done` otherwise. |
| `stopped` | `exitCode` | Always the last line. |

The shell adds three of its own on the same Tauri channel, and every one of
them carries `"from": "shell"` so a page can tell "the core said this" from
"the shell could not reach the core", which are different problems with
different next steps: `setup-refused`, `answered` (only for an answer that
never reached a sidecar), and `setup-exited`.

---

## 3. The one payload-carrying form

**The core's stdin vocabulary is six bare words and setup adds exactly one
form.** Not a seventh word: a form.

```
answer {"id":"<the ask id>","value":<the answer>}
```

One line. The word, one space, then one JSON object. The core splits on the
first space and parses the rest.

Setup also answers `stop` and `quit`, which are two of the six, and end of file,
which means the same thing. `detach`, `pause`, `resume` and `rescan` belong to a
watch and are answered by name on the human channel rather than swallowed: a
front end has exactly one reading of silence, that the core did not understand
the word, and it acts on that reading.

`value` is a boolean for a `confirm` and a string for an `input`. The channel is
forgiving about the near misses (`"yes"`, `"true"`, a number where a string was
wanted) and refuses anything genuinely unusable by name, because a first-run
window that cannot be finished over a one character difference is worse than a
strict parser is good.

---

## 4. The ask id lifecycle

Written as rules, because this is the part a front end gets wrong silently.

1. **Ids are decimal strings, from `"1"`, counting up, per run.** They are not
   reused and they mean nothing outside the run that minted them.
2. **One question is open at a time.** The core does not emit a second `ask`
   until the first is settled, so a front end never has to reconcile two.
3. **Every `answer` line gets exactly one `answered` event.** Including the ones
   that change nothing. This is the machine-channel rule applied to the one new
   form, and it is the whole reason the protocol is legible: a window that hears
   nothing knows it was not understood.
4. **An answer for a dead id is refused and names the live one.**
   `{"type":"answered","id":"3","accepted":false,"error":"that is not the
   question that is open","open":"5"}`. The live question stays live: nothing
   was consumed. A window that closed mid ask and reopened is the ordinary way
   to hold a dead id.
5. **An answer with no question open** is the same refusal with `"open":null`.
6. **A refused answer re-asks the same question, with the same id**, carrying
   `error`. Validation lives on the side holding the state machine, always. A
   window never re-implements a rule; it renders the sentence the core sent
   back.
7. **Validation runs with the question off the table**, so a second answer
   arriving while a rule is being checked is a dead id rather than a race.
8. **`cancelled` closes a question nobody answered.** Two ways to reach it: the
   run was asked to stop, or the question was aborted by the core itself, which
   the credentials intake does when the Downloads watcher wins the race against
   the typed path.

A page has to handle all three shapes the `open` field can take on a refusal,
and the middle one is the easy one to miss: the question already on screen (the
core re-asks, so there is nothing to do), a question the page is not showing
(rule 4, put the card back up for the id the refusal named), and none at all
(rule 5, this walk cannot be finished here). An `answered` with
`{accepted: false, open: <live id>}` arriving after the page has closed its ask
card otherwise leaves a silent window holding a live question the user can no
longer see.

---

## 5. The laws this channel is subject to

Not new laws. The ones from TRAY-DESIGN sections 0 and 7, restated where
somebody implementing this will be standing.

**Consent opens in the system browser, from the core, always.** The
`signing-in` event carries no URL, deliberately, so there is nothing on the wire
for a window to render even by accident. Console deep links do travel, as `link`
events, and they are a different thing: they are opened by the core when it is
allowed to, and the page shows them as text to copy. `setup-channel.test.ts`
asserts every `link` URL's host is `console.cloud.google.com` and that
`accounts.google.com` never appears on stdout. On the shell's side,
`windows.rs` is a closed enum of two local relative paths and there is no
`WebviewUrl::External` in the crate, so an auth URL has no wire to arrive on
there either.

**The webview never touches the file system.** `tauri-plugin-fs` *is* compiled
in, transitively under `tauri-plugin-dialog`, so the guarantee is the ungranted
permission and not the absent crate: `capabilities/default.json` grants no
`fs:` permission to any window, and an ungranted plugin command is unreachable
from a page. The one command that hands a page something it did not already
know is `pick_folder`, which opens the native dialog from Rust and returns a
string; the page sends that string back as an ordinary answer and the core
validates it exactly as it validates a path a terminal user typed.

**Upload only, forever.** There is nothing in this protocol that could delete or
mutate anything, here or at Google, and there is no scope wider than
`photoslibrary.appendonly` to ask for.

**The copy law applies to every `say` and every `ask` message**, which are the
wizard's own words: no em dashes, warm plain English, sentence case.
`CONTRIBUTING.md` carries the full law and the tests that hold it.

---

## 6. The states worth constructing by hand

Every defect this project has shipped lived in a state the rig cannot
construct, and windows are invisible to a rig entirely, so this list is what a
review of this protocol should be built around from the start. The starred ones
have tests today.

- **An answer arriving for a dead ask id.** ✅ `setup-channel.test.ts`
- **A window closed mid ask.** The shell sends `stop`; the run ends on
  `stopped` and writes nothing. ✅ `setup-channel.test.ts` covers the cancel;
  the close itself is `windows.rs` calling `setup_host::stop`.
- **A double `setup_start`.** Refused by pid, and the window is told on the same
  channel rather than left waiting. ✅ `setup_host.rs`
- **An answer that fails the core's own validation.** Same id comes back with
  the sentence. ✅ `setup-channel.test.ts`
- **A refusal arriving for an ask the page has already closed.** Rule 4's
  recovery path. ✅ `ui-pages.test.ts`
- **A cancel between the last answer and the consent screen.** The one path that
  reaches the loopback wait already aborted. ✅ `auth.test.ts`, which also holds
  the handle count to baseline so a leaked listener cannot return quietly.
- **Setup attempted while a watch holds the lock.** Safe: setup takes no lock.
  Not covered by a test.
- **A second window opened after the first was destroyed.** `show` builds again
  because the label is free. Not covered by a test.
- **An answer carrying a newline**, from a pasted path. ✅ `setup_host.rs`
- **A veteran CLI ledger, and a rotated or missing one.** These belong to the
  first-ever rule in TRAY-DESIGN section 3 rather than to this protocol: see
  `first-ever.test.ts`.
