# Contributing

Short, because the interesting parts are written down elsewhere and pointing at
them is more useful than repeating them. `docs/TRAY-DESIGN.md` is the design of
record for the tray shell, `PROBE.md` is what was measured against Google's API
rather than assumed, and `app/e2e/CHECKLIST.md` is the passes a machine cannot
walk.

## Setting up

Windows, Node 20 or newer, and the Rust stable MSVC toolchain if you are touching
the shell.

```
npm ci
npm test          # the core suite
npm run build     # tsc, into dist/
```

**The shell will not build until the core is staged as a sidecar.** Both
directories it is staged into are generated and gitignored, so a fresh clone has
neither and the Rust build fails on a missing file rather than on anything you
wrote:

```
node app/scripts/build-sidecar.mjs     # builds the core and stages it, from anywhere in the repo
cd app/src-tauri && cargo test         # the shell suite
```

Then, from `app/`, where `npm ci` fetches the Tauri CLI and esbuild: `npm run dev`
runs the tray, and `npm run build -- --no-sign` makes the installer. The flag is
needed. The app updates itself, so the bundler wants to sign the update payload
with a private key that exists only in the release secrets, and a plain
`npm run build` compiles the whole release before stopping with "A public key has
been found, but no private key".

## What a pull request carries

- **Both suites green**, the core's and the shell's. Neither is slow.
- **A test before a fix.** If you are closing a defect or changing behaviour, the
  failing test comes first and the pull request says what was red before it went
  green.
- **The house style below**, which is enforced by tests rather than by review.
- **One subject.** A rename, a refactor and a behaviour change in one branch are
  three reviews wearing one hat.

## Translating

**One file is a whole translation.** This is meant to be the easiest contribution
in the project, and it is the one most wanted.

1. Copy `app/ui/locales/en.json` to `app/ui/locales/<code>.json`, where the code
   is your language's own BCP 47 tag: `de`, `ru`, `pt-BR`.
2. Translate the values. **Leave the keys alone.**
3. Add one line to `LOCALES` in `app/ui/i18n.js`, in the order you would like the
   switcher to offer languages:

   ```js
   const LOCALES = [
     { code: 'en', label: 'English' },
     { code: 'de', label: 'Deutsch' },
   ];
   ```

   The label is your language's name **in your language**, because somebody
   looking for their own language is not reading English while they look.
4. Run `npm test`. The locale tests check that your keys exist in `en.json`, that
   every `{token}` still has its braces and its name, and that no file carries an
   em dash.
5. Open the pull request. Say which language, and say if any sentence had to
   change shape to work, because that is usually a sentence that needs a token
   rather than a translator's patience.

Three things worth knowing before you start:

- **A half finished file is a good contribution.** Any key you have not
  translated falls back to English, key by key, by design. A missing translation
  is never a blank window.
- **`{tokens}` are the sentence's moving parts.** Move them anywhere in the
  sentence you like. Do not rename them and do not lose a brace.
- **Not everything is reachable from that file yet.** The tray menu, the
  notifications and every sentence the engine sends are still English only.
  Moving them into the same catalogue is the next version's headline work, and it
  is a bigger change than a locale file.

**You get credit.** A merged translation puts your name in the README's
translator list with the language you brought, and in the release notes of the
version it first ships in. Add yourself in the same pull request, or ask and it
will be added for you.

## House style

Every string a person reads is held by a test, so these are conventions with
teeth: a pull request that breaks one goes red rather than through review. This
is the one place they are written down, and every other document in the
repository points here rather than restating them.

- **No em dashes anywhere.** U+2014 is the character. Not in copy, not in code,
  not in comments, not in a locale file, not in this document. A colon, a comma
  or brackets say the same thing without it. `src/commands/copy-law.test.ts`
  sweeps every shipped surface and `src/commands/front-door.test.ts` sweeps the
  documents.
- **Sentence case inside a window.** Tabs, buttons, headings, labels, body text:
  "Deliver now", not "Deliver Now". The only Title Case in the product is a
  window's own title bar, where the product names itself: "Photo Pigeon: Status".
  A title bar is the product introducing itself in a taskbar full of other
  products, and the inside of a window is one person being spoken to.
- **The storage sentence is a fixed string.** Word for word, everywhere it
  appears:

  > Uploads are original quality and count against your Google storage. Storage Saver does not apply.

  It lives in `src/commands/watch.ts` as `STORAGE_HONESTY`, it is imported or
  quoted from there rather than retyped, and the tests compare it verbatim.
  Paraphrasing it is always wrong: it is the sentence that stops a person being
  surprised by a bill, and a second wording is two claims where there is one
  fact.
- **Warm plain English, and honesty before polish.** Say what a thing does, say
  what it costs, and say what a person has to click. No marketing, no apologies,
  no exclamation marks. If a sentence needs a footnote to be true, rewrite the
  sentence.
- **Buttons say what they do.** "Choose folder", never "OK" or "Browse...".

## What this project will not do

Not up for negotiation, and a pull request that reaches for any of them will be
declined however good the code is:

- **Upload only, forever.** No delete, no edit, no move, no organise. The scope
  is `photoslibrary.appendonly` and it stays that way.
- **The delivery record belongs to the user.** Nothing but the core writes
  `~/.photo-pigeon/ledger.jsonl`, and no installer or uninstaller goes near that
  directory.
- **No shipped credentials.** Every user makes their own Google client, so the
  quota they spend is their own.
- **The windows get no file system and no external URL.** A webview in this app
  cannot read a file: the fs plugin rides in transitively under the dialog
  plugin, but no fs permission is granted to any window, and an ungranted
  command is unreachable from a page. Capabilities grow one permission at a
  time, each with a written reason.
- **No rescan timers.** "Deliver now" is a gesture a person makes, never a
  schedule.

## Reporting something

Include your Windows version, whether you installed the app or used `npx`, and
what the health tab or `photo-pigeon doctor` says. If you are pasting a log, note
that credentials are already stripped from `~/.photo-pigeon/watch.log` before it
is written, so it is safe to attach, but read it anyway: it holds your folder
paths and your file names.
