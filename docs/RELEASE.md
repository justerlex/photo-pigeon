# photo-pigeon release runbook

The ordered steps that turn a green `main` into a published release, who or what
performs each one, and what proves it happened. This is a publish-day document
and not a design one: `docs/TRAY-DESIGN.md` says why each of these things is the
way it is. Where the two disagree about a reason, TRAY-DESIGN wins. Where they
disagree about an order, this file wins, because an order is only ever learned by
doing it wrong once.

**Where the other pieces live, so this file does not restate them and drift.**
`README.md` owns everything a user reads, including the unsigned wall's words and
the drawings beside them. `.github/workflows/README.md` owns the shape of the two
workflows and the three secrets they read. `app/e2e/CHECKLIST.md` owns the manual
pass. `app/e2e/sandbox/README.md` owns the disposable machine. This file owns the
order and the hands.

**This document names secrets and never carries one.** Every command below that
touches a secret names the secret and stops there. There is no example value, no
placeholder that looks like a key, and no "replace this with yours" string
anywhere in this file, because a placeholder that looks like a key is how a real
key ends up pasted next to it.

---

## Two roles, and nothing sits between them

Read **maintainer** as: a person, with the accounts and a machine. It needs an
identity, an account only that person can sign into, a password manager, a
machine in a state nothing can fake, or a judgement that has to be made by
somebody.

Read **CI** as: the tag-triggered workflow in `.github/workflows/release.yml`.
It builds, it checks, it drafts, and it does nothing a person has not already
made irreversible on purpose.

**An unassigned row waits forever**, which is why every row below carries hands.
If a step reads as "someone should", that is a defect in this file.

## The order is the document

| # | Step | Hands |
|---|---|---|
| 1 | Generate the updater keypair, back up the private half, keep the public half | **maintainer** |
| 2 | Bake the real public key into `tauri.conf.json`, remove the throwaway, commit | **maintainer** |
| 3 | Put the signing secrets into the repo's GitHub secrets | **maintainer** |
| 4 | Push, tag `v0.1.0`, then watch the workflow produce the **draft** Release | **maintainer**, then CI |
| 5 | ~~Take the captures the README's slots name, into `docs/captures/`~~ **superseded, and the row stays so nothing below it moves** | nobody |
| 6 | The sandbox rig run, then the fresh-user walk of `app/e2e/CHECKLIST.md` M5 | **maintainer** |
| 7 | Repo public, publish the draft Release, npm, the SignPath application | **maintainer** |
| 8 | Verify the published `latest.json` serves and an installed copy sees no update | **maintainer** |

Two of those orderings are laws rather than preferences, and both are laws
because getting them backwards is expensive:

- **The key exists before the tag.** Step 1 before step 2 before step 3 before
  step 4. A tag that builds against a public key whose private half is not in the
  secret store produces an installer nobody can ever update, and it produces it
  for every user at once.
- **Nothing publishes before the walk.** Step 6 before step 7. The exit criterion
  is about a stranger, and the only way to test a stranger's path is to walk it as
  one.

---

## 1. The updater keypair · maintainer

Run it from `app/`, where the Tauri CLI lives, on a checkout whose `app/`
dependencies are installed (`npm ci` inside `app/` if they are not, because the
CLI is a devDependency of that package and of no other):

```
New-Item -ItemType Directory -Force "$HOME\.tauri" | Out-Null
cd app
npm run tauri -- signer generate -w "$HOME\.tauri\photo-pigeon-updater.key"
```

Five things about that line, and each of them is the reason it is written that
way rather than shorter:

- **No `-p` flag.** The CLI has one, and using it would put the passphrase in a
  shell history file and in the scrollback of whatever terminal ran it. Without
  it, the CLI prompts, and the passphrase exists only in a head and in a password
  manager. One thing to check first, because the CLI's own `--ci` switch reads
  the `CI` environment variable: if `CI` is set in that shell, the prompt is
  skipped and you get a key with no passphrase and no warning. Run
  `echo $env:CI` and make sure it prints nothing.
- **`-w` and not the default.** Without `-w` the CLI prints both halves to
  stdout, which means the private half lives in scrollback. Written to a file, it
  lives in one place you can point at and then remove.
- **`$HOME` and not `%USERPROFILE%`.** A `%USERPROFILE%` written into a shell
  that does not expand it becomes a literal directory name, relative to wherever
  you were standing, and `app/` is where this step tells you to stand. That is a
  private key inside a working tree, one `git add -A` from being permanent, and
  the shell says nothing at all about it. Use `$HOME` in PowerShell and in Git
  Bash, and after the command runs read the path it printed rather than the path
  you typed. `.gitignore` refuses both halves under any `%USERPROFILE%`-shaped
  directory, which is a net and not a substitute for looking.
- **Not inside the repo, and not inside any worktree.** A private key in a git
  working tree is one `git add -A` away from being in the history forever, and a
  git history is not a thing you can take a key back out of.
- **Not in `~/.photo-pigeon`.** That directory is the product's own state and the
  frozen naming law owns it. Nothing on this list may write there.

It writes two files: the private key at that path, and the public key at the same
path with `.pub` on the end.

Then, in this order:

1. **Into a password manager, before the tag exists.** Two entries: the whole
   contents of the private key file, and the passphrase. TRAY-DESIGN section 5
   states the consequence and it is worth restating with the work in front of
   you: **an installed copy can only ever be updated by a build signed with this
   key.** Losing it strands every user on the version they have, forever, with no
   recovery except asking each of them to download a fresh installer by hand. The
   backup happens now and not after the release, because the day the key matters
   is the day it is already gone.
2. **The `.pub` file's contents go into step 2.** That half is public by design.
   It is safe in a commit and on a web page.
3. **The private key file comes off the disk once step 3 is done.** The password
   manager holds the record. A key file sitting in a directory that syncs to a
   cloud drive is a key in the cloud.

**This is not Authenticode.** This signature says an update came from this
project. It does nothing whatsoever about SmartScreen, and conflating the two is
the classic way to believe a project is signed when it is not. Two signatures,
two entirely different problems.

**And this is the cheapest possible moment to lose the key.** No release exists
yet, so if any of it leaks before step 4, the whole recovery is: generate a new
pair and start this runbook again at step 1. After the first installed copy is in
somebody's hands, that stops being true forever.

## 2. The real public key replaces the throwaway · maintainer

> **Done for this repository.** The shipped pubkey is the release key, minisign
> id `B2FD12B5938FBBB2`; the throwaway, its Cargo.toml warning, its swap-day
> test and its `.updater-throwaway/` directory are all gone, and
> `git grep -n E17F8D75CFB8611F -- app` comes back empty. The section stays as
> written because a key rotation walks the same road.

The repository ships a clearly marked throwaway key so the updater plugin could
be wired, built and tested before a real key existed. This step is the swap, and
it is one string in one file: `plugins.updater.pubkey` in
`app/src-tauri/tauri.conf.json`, beside `bundle.createUpdaterArtifacts` and the
endpoint that the manifest is served from.

**What is in the repository today**, so the search below has something exact to
look for. The throwaway is loud in four places on purpose, and the fourth is the
one that outlives it:

| Where | What it says | After the swap |
|---|---|---|
| `app/src-tauri/tauri.conf.json`, `plugins.updater.pubkey` | the key itself, id `E17F8D75CFB8611F` | holds the real key |
| `app/src-tauri/Cargo.toml`, the header block | the warning, because a JSON file whose parser is `deny_unknown_fields` cannot carry a comment | deleted |
| `app/src-tauri/src/updater.rs`, `the_pubkey_in_the_shipped_config_is_still_the_throwaway` | a test that fails the moment the key changes, on purpose, and whose failure message is this checklist | deleted |
| `.github/workflows/release.yml`, "refuse to ship the throwaway updater key" | the tag road's own gate: it decodes the pubkey and fails the tag on this id, in the first minute | **stays, for ever** |

**The fourth row is why this step is a machine gate and not an ordering one.**
Everything above it is a reminder that a person can read past. The gate cannot be
read past: an un-swapped `tauri.conf.json` fails the tag before it has spent a
minute, with the sentence that names this step. It keeps the id deliberately,
because a denylist of one dead keypair is exactly what it is, and it carries the
half of the deleted test that has to survive, which is that the pubkey decodes to
a real minisign public key at all.

The throwaway's private half was generated so the wiring and its tests had a real
minisign key to hold, and it sits at `.updater-throwaway/throwaway.key` in the
checkout, gitignored by name and by extension twice over. It is there rather than
deleted because it is the only way to reproduce the one check that can be made
locally: that the `.sig` a build produces and the pubkey in the config are the
same pair. It protects nothing. No build has ever been published with it, nothing
signed with it can be trusted by anybody, and nothing needs to be.

**Two ways to build the installer locally, and only one of them wants a key.**
`bundle.createUpdaterArtifacts` is true, so a plain `npm run build` from `app/`
dies after the full release compile with "A public key has been found, but no
private key", which is four minutes for a message about a variable. Anybody who
only wants an installer skips signing and pays nothing:

```
npm run build -- --no-sign
```

The one that wants the key is the pair check, and it is the whole reason the
throwaway is still on disk. From `app/`, with the two variables the bundler reads
by name, and the passphrase typed rather than printed here, because a passphrase
written into a runbook is exactly the shape a real one gets pasted over:

```
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw ..\.updater-throwaway\throwaway.key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host 'passphrase' -MaskInput
npm run build
```

**Delete that directory in the same commit as the swap.** It is the fourth thing
on the list below, and after step 1 there is a real key and no reason for a fake
one to exist.

The swap is done when all five of these are true:

- `plugins.updater.pubkey` holds the contents of the `.pub` file from step 1.
- **Nothing that ships names the throwaway key any more.** The marker is the key
  id and not the word. `throwaway` has been the e2e rig's own vocabulary for a
  throwaway config since M3, so `git grep -in throwaway` returns around a hundred
  lines across the tree and not one of them is a key. The id is exact:

  ```
  git grep -n E17F8D75CFB8611F -- app
  ```

  **Empty is the proof.** The scope is `app/`, which is the tree that ships, and
  it has exactly two hits before the swap: the second and third rows of the table
  above. Both go in the same commit as the key, and the test is deleted rather
  than updated, because its whole job was to fail once. Three files outside that
  scope keep the id on purpose and are meant to: this runbook, the gate in
  `.github/workflows/release.yml`, and the assertion in `scripts/workflows.test.ts`
  that the gate is still there.
- `cargo test` in `app/src-tauri` is green again, which it will not be until that
  test is gone.
- `.updater-throwaway/` is deleted from the checkout. It is gitignored, so no
  commit will ever mention it and nothing will remind you.
- The commit says so plainly, in the repo's voice, so that `git log` over
  `tauri.conf.json` reads as one deliberate event and not as a config tweak.

**The committed public key and the secret in step 3 must be halves of the same
pair.** No test in this repo can check it, because the two halves live in two
places no test sees at once: one is a commit, the other is a GitHub secret. The
order in this runbook is the guard, and the gate in the fourth row above is the
machine half of it. But the gate can only refuse a key it already knows is dead:
a real key paired with the wrong real key is not something it can see.

**One thing does see both halves, and it is the bundler.** The Tauri CLI this
repo pins, 2.11.4, derives the public half of `TAURI_SIGNING_PRIVATE_KEY`,
compares it to `plugins > updater > pubkey`, and has a sentence for the
disagreement. Verbatim, out of the shipped binary:

    The updater secret key from `TAURI_SIGNING_PRIVATE_KEY` does not match the
    public key from `plugins > updater > pubkey`. If you are not rotating keys,
    this means your configuration is wrong and won't be accepted at runtime when
    performing update

**Read the build step's log for that sentence, and do not lean on it.** Whether
the CLI refuses the build or only warns is not established, and the wording
hedges towards a warning, because a hard error there would break a legitimate key
rotation. So it is the loudest available signal and not a gate: a warning inside
a twenty minute log is a thing nobody sees unless a runbook said where to look.
Step 4 says to look.

The local proof still worth taking, with its limit understood: build once with
the signing variables pointing at the new key, confirm a `.sig` appears beside
the installer, and read that same log for the mismatch sentence. What it does not
prove is that the signature verifies, because the bundler never checks its own
output. It compares keys, not signatures.

## 3. The signing secrets · maintainer

GitHub, the repo, Settings, Secrets and variables, Actions, New repository
secret. Two secrets, named exactly, because the workflow and the bundler read
them by name:

| Secret name | What goes in it |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the entire contents of the private key file from step 1, header line included |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the passphrase typed at the prompt in step 1 |

And for the npm job, which runs on the published Release rather than on the tag,
a third:

| Secret name | What goes in it |
|---|---|
| `NPM_TOKEN` | a granular automation token minted at npmjs.com under the publishing account |

The npm account uses passkey 2FA, and a workflow cannot answer a passkey. That is
the whole reason the token exists, and the reason only a person with that account
can mint it.

Three rules about this step, and they are short because they are absolute:

- **Paste into GitHub's own field and nowhere else.** Not into a chat message,
  not into a commit, not into an issue, not into a scratch file "just to get the
  formatting right".
- **No value of any of these three appears in this document, ever.** This table
  names them. That is the whole contract.
- **If a value does land somewhere it should not, treat it as burned.** For the
  signing pair that means step 1 again from the top, which is cheap today and
  never again. For the npm token it means revoke and mint another.

## 4. Push, tag, and watch a draft appear · maintainer, then CI

`github.com/justerlex/photo-pigeon` already exists and is **private**, which is
the state this step wants: a private repo runs Actions, produces a draft Release
and shows nobody anything. Making it public is step 7 and it is deliberately the
last irreversible act on the list.

```
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

The tag is `v` followed by exactly what the root `package.json` says. Versioning
is lockstep: one version, one tag, one number, and CI compares the tag to the
manifest and fails the whole tag rather than shipping three quarters of a
release. `app/src-tauri/Cargo.toml` is already in the lockstep from the other
side: `build.rs` hard-fails the build when it disagrees with the root manifest,
which is a failure on the machine that caused it instead of a report after the
fact.

**What the tag actually runs**: one job, `installer`, on `windows-latest`, whose
first two steps exist to fail fast rather than to build anything.

1. **It refuses to build a release nobody could update.** If
   `bundle.createUpdaterArtifacts` is not true, or `TAURI_SIGNING_PRIVATE_KEY` is
   not set for this repository, the job stops in its first minute. That is step 3
   checking itself.
2. **It refuses to ship the throwaway key.** It decodes
   `plugins.updater.pubkey` and stops the tag if it is still `E17F8D75CFB8611F`,
   or if it is not a minisign public key at all. That is step 2 checking itself,
   and it is the one gate on this road that used to be nothing but a person
   remembering.
3. **The version lockstep, the tag included.** Five files and the tag.
4. Both suites, the core's and the shell's, with the sidecar staged **before** the
   Rust build, because `tauri.conf.json` names `binaries/` and `resources/` and a
   fresh clone has neither.
5. The bundle directory cleared, then the installer built, then `latest.json`
   assembled from the installer and its `.sig`, then a **draft** Release created
   with `.github/release-notes.md` as its body.

All of that is one job and one road. The second job in that file runs only when a
Release is **published**, which is a human click in step 7.

What to check before going near step 6: the job green, a draft Release carrying
the NSIS installer, its `.sig` and `latest.json`, and the version in the
installer's file name equal to the tag. If you can see a disagreement by eye, the
check did not run.

**And one search inside the log, which nothing else in this pipeline does.** Open
the "build the installer" step and search it for `does not match the public key`.
Nothing found is the answer you want. That step is the only moment in the whole
release where the committed public key and the secret private key are in the same
process, and section 2 has the sentence it prints and the reason it may be only a
warning rather than a failure.

**One thing to check by hand on the draft, because no test can reach it.** GitHub
rewrites spaces in asset names to dots, so `Photo Pigeon_0.1.0_x64-setup.exe`
becomes `Photo.Pigeon_0.1.0_x64-setup.exe` in the download URL, and `latest.json`
predicts that rename rather than observing it. Open the draft, copy the
installer's real download URL, and compare it to the `url` in the attached
`latest.json`. A disagreement here is an update that 404s for every user.

**Draft is the gate, and the gate is the point of this step.** A tag builds, it
does not announce. Everything that happens on a tag has to be a thing that can be
thrown away, because the walk in step 6 has not happened yet and the walk is
allowed to fail.

Which is why one thing the workflow must not do: **the tag must not be able to
publish to npm.** An npm publish is the one irreversible act in this pipeline.
The npm job is wired to the Release being published rather than to the tag, which
satisfies this; the law is written here so that a later edit moving it back has
something to be measured against.

**A tag is never moved.** If the build is wrong, the fix is a new version number
and a new tag, not a tag pointing somewhere new: a moved tag is a version that
means two different things, and every diagnosis after it is guesswork. Nothing
was published, so a burnt tag costs one version number, and version numbers are
the cheapest thing in this project.

## 5. Superseded: the captures · nobody

**Retired, and the step keeps its number so nothing below it moves.** Real
screenshots turned out not to be needed: the setup wizard's line drawings are
stylistically right and they do not go stale the day Microsoft ships a redesign.
The three of them were copied out to `docs/art/` and the README uses them where a
capture slot used to be, `docs/captures/` is gone with its checklist, and
`front-door.test.ts` now asserts the opposite of what it did: the README may
point at no picture that is not in the tree.

Two consequences, so nothing waits for a photograph that is not coming:

- **The Release page needs no capture either**, which is step 7.2's own line.
  `.github/release-notes.md` carries the drawing at a raw URL and the two clicks
  in words, so the only thing added by hand before publishing is what changed.
- **The wall is still walked, it is just not photographed.** Item 1.3 of the M5
  pass in `app/e2e/CHECKLIST.md` is the one that matters and it has not moved: if
  the wall does not appear, the machine was not fresh and the walk proved
  nothing. Item 1.4 asked for the picture and is marked in place.

## 6. The sandbox rig, then the walk · maintainer

`app/e2e/CHECKLIST.md`, the M5 manual pass. Read its section 0 before installing
anything: it takes the baseline of `~/.photo-pigeon` and it quits the live tray
from its own menu, and every later comparison in the pass is against that
baseline file rather than against a memory of it.

**The rig is the venue and the walk is the eyes.** They are two different proofs
and neither substitutes for the other:

- **The sandbox rig** is a machine that has never seen this product and forgets it
  again when it closes, which is what makes the install matrix runnable at all:
  install over install, uninstall and reinstall, and the uninstaller's
  confinement, none of them performed on the machine that holds the live ledger.
  A disposable machine is also the only honest venue for the deliberate opposite,
  answering **yes** to the application-data question on purpose and finding
  `~/.photo-pigeon` still there afterwards. A law that only holds while the user
  declines is not a law. How to run it lives with the rig, in
  `app/e2e/sandbox/README.md`; what matters here is when, and the M5 pass says it
  plainly: **whatever rig carries the uninstall assertion runs before the
  checklist is opened**, so that a person's attention is spent on the walk and not
  on the matrix. Two facts about the venue that are not the rig's fault: Windows
  Sandbox is off by default on Windows and enabling it needs administrator rights
  and a reboot, and the committed `.wsb` holds absolute paths, so
  `app/e2e/sandbox/make-wsb.ps1` is regenerated on the branch being released
  before anything is run. Checklist item 0.5 starts with the generator for exactly
  that reason.
- **The walk** is section 1 of the checklist, and it is the milestone. A person
  who never opens a terminal, a machine with no config, and a photo that arrives
  in Google Photos. It cannot be delegated to a script, because what is being
  tested is a stranger's understanding and the only instrument for that is a pair
  of eyes meeting these screens for the first time.

Two mechanical facts that decide whether the walk proves anything:

- **The download must be a browser download, on the machine being tested.** A file
  copied in over a share or dragged into a sandbox does not carry the mark of the
  web, and without that mark **the wall does not appear at all**. A pass where the
  wall never showed up is not a pass, it is a machine that was not fresh or a file
  that was not downloaded. The checklist says this at item 1.3 and it is the item
  most likely to be misread as good news.
- **The Release is still a draft, so the download needs one login.** A draft
  Release's assets are not readable by an anonymous browser, and this step happens
  before step 7 on purpose. So sign into GitHub once in the fresh machine's own
  browser and download from the draft Release page. It is the same page, the same
  asset and the same wall; the login is the only difference, and it is the one
  difference that does not touch anything being tested. After step 7, checklist
  item 4.4 closes the loop: the file attached to the published Release is the same
  file, by byte size, and not merely one with the same name.

**Nothing in step 7 happens until section 1 of the checklist is ticked.**

## 7. Public, published, packaged, applied · maintainer

Four acts, in this order, and the order is not cosmetic: each one assumes the one
before it.

**7.1 Flip the repo public.** The Release page has to be readable by a stranger
for the download link to mean anything, and SignPath has to be able to read the
source. One check before pressing it, because making a repository public makes its
whole history public at once: no signing key ever touched a commit. The private
key file has a fixed header line, so the search is exact and it names no secret
value:

```
git log --all -p | Select-String -SimpleMatch "minisign encrypted secret key"
```

Nothing found is the answer you want. Anything found means step 1 again, before
the repo goes anywhere.

**7.2 Publish the draft Release.** The installer, its `.sig`, `latest.json`, the
release notes, and the unsigned-wall text above the download link. The two words
in order, **More info** then **Run anyway**, one plain sentence on why Windows
flags an unknown publisher regardless of what the program does, and no apology. A
user who was warned and told what to click trusts the tool more afterwards, not
less. The body the draft arrives with is `.github/release-notes.md`, which
already carries all of that; the only thing it cannot carry is what changed in
this version, and that is added by hand before publishing.

**One look at the draft between 7.1 and 7.2.** The wall's drawing in that body is
a raw URL into this repository, which serves nothing at all while the repository
is private, so the draft renders it for the first time in the minutes after 7.1.
If it is not there, the two clicks are still in words above it and the line can
be deleted.

**7.3 npm.** The workflow's npm job is wired to the published Release, so this is
watching it run rather than typing anything. By hand it is one command from the
repo root:

```
npm publish
```

and the account's passkey 2FA prompts. `prepublishOnly` cleans and rebuilds
`dist` on the way, so the tarball cannot carry a stale build, and `files` is
`dist`, `README.md` and `LICENSE`, so nothing in `app/` or `docs/` can reach npm
by accident.

Note what is missing from that command: `--provenance` needs a CI environment's
OIDC identity and fails outside one, so a hand publish does not carry provenance.
The workflow's job runs `npm publish --provenance` for that reason, and provenance
needs the repository to be public already, which 7.1 has just made it.

**And this is the second reason npm comes after 7.1 rather than before it.**
npmjs.com renders the README, and the README's pictures are the mascot in
`app/ui/` and the drawings in `docs/art/`, neither of which the tarball carries:
npm resolves a relative image path against the repository named in the manifest,
which returns nothing at all while that repository is private. **A published
version's README is frozen**, so a publish made one minute too early is a package
page with broken images on it for as long as that version exists.

**Then read the package page once, because npm is not GitHub.** The mascot and
the drawings sit in centred `<img>` blocks, which is the only way to have a width
on GitHub, and npm's renderer is a different one. If a picture is missing there
and present on GitHub, the fix is an absolute raw URL in the same tag, and it
ships in the next version rather than this one.

**7.4 The SignPath Foundation application.** It goes in as soon as the first
Release exists, because eligibility requires the project to **already** be
released in the form to be signed, and review takes days to weeks. Every line of
the eligibility table in TRAY-DESIGN section 5 passes: MIT, no proprietary
component, upload only and easy to demonstrate, actively maintained, and a
download page that says what the thing does.

**And there is one box on that form this project deliberately did not decide in
advance.** The certificate is issued to the Foundation, so the publisher line a
user reads on a signed build says **SignPath Foundation**, while
`bundle.publisher` in `tauri.conf.json` says `justerlex`. Both are true and they
are not the same claim, and the form asks for a project name while this product
has four frozen ones: the display name "Photo Pigeon", the machine name
`photo-pigeon`, the repository `justerlex/photo-pigeon`, and the bundle
identifier `io.github.justerlex.photopigeon`. None of them is wrong to put on a
form and none of them is interchangeable once a certificate exists.

    The name given on the application: ______________________
    What `bundle.publisher` says afterwards: ______________________
    Date: __________

**Fill that in with the form in front of you, and then record the answer in
section 0 of `docs/TRAY-DESIGN.md`, next to the frozen list.** It is left blank
here rather than guessed so that it is not discovered halfway through a form that
cannot be saved. And whatever the answer is, the README's install section says
plainly that the name behind a softened wall is a name the user has never heard
of, rather than letting them find out on their own.

## 8. The updater, proved against the real thing · maintainer

The published manifest is the last thing on this list because it is the first
thing that cannot exist earlier.

```
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://github.com/justerlex/photo-pigeon/releases/latest/download/latest.json" |
  Select-Object -ExpandProperty Content
```

What it has to show: valid JSON, a `version` equal to the released version with
no `v` on the front, and a `platforms` entry for `windows-x86_64` carrying both a
`signature` and a `url`, with the url naming the asset that is actually attached
to the published Release. The endpoint is a static URL under
`releases/latest/download/` precisely so that this check is the same check
forever.

Then the negative proof, which is the one that matters on launch day: **an
installed copy of the released version checks and finds nothing.** It checks
twenty seconds after launch, so this is one launch of the shipped installer plus
one read of `%LOCALAPPDATA%\io.github.justerlex.photopigeon\logs\tray.log`, and
what belongs in the log is the no-update line and not a download. Appendix A
lists the lines by name.

Record all of it in the notes at the bottom of the M5 pass in
`app/e2e/CHECKLIST.md`: the URL, the version served, the asset the url names, and
the log line. A verification nobody wrote down is a verification that will be
done again by the next person who wonders.

---

## Appendix A. What the updater does at runtime

Updates are on by default. A release day should know what the thing it is
shipping does on its own. The whole policy is `app/src-tauri/src/updater.rs`,
which has no clock, no network and no `AppHandle`, plus its call sites in
`supervisor.rs`.

- **The check** goes out twenty seconds after launch and then once every 24
  hours. Never on a user gesture, never a modal, and one update at a time: while
  bytes are held, no further check goes out.
- **The download** happens straight away and quietly, and the bytes are held in
  memory. The signature is verified inside the download against the public key in
  `tauri.conf.json`, so bytes that survive it are bytes this project signed.
- **The only thing said out loud** is four words: the tray's Quit item reads
  "Quit and update Photo Pigeon" while an update is held. There is no toast, no
  window and no badge, and a check that fails says nothing at all to the user.
- **The install runs from the quit path only**, and only on the ways of leaving
  that cannot have an upload in flight: no engine was running, or the engine
  drained and reported `stopped`. A detached exit, the second Quit press,
  installs nothing, because a detach leaves the core uploading as an orphan. An
  exit whose drain was never confirmed installs nothing either: the `stopped`
  receipt is required rather than inferred from an exit code.
- **`install()` is the last thing the process does.** On Windows the plugin exits
  the app itself after handing the installer to the shell. That is a documented
  installer limitation and cannot be worked around.

### One measured number that is still open

A release build of `0.1.0` produces a **23.4 MB** installer, because the bundled
`node.exe` is 81 MB before NSIS compresses it. The updater holds that whole
payload in memory from the moment the download finishes until the app is quit,
which is what TRAY-DESIGN section 5 says to do, and it is 23.4 MB against the
9.87 MB the whole shell measured at idle at M0.

It is built the way the document says and the number is written down rather than
quietly worked around. Two rules of the same document meet here, section 5's
"hold the bytes" and section 1's resident memory budget, and neither was written
knowing this figure. The alternative is to spill the verified bytes to a file in
the app's own cache directory and read them back at the quit: the whole shape of
the policy survives, and it costs a path to own, a sweep on the next launch and
one more refusal for a file that went away. The plugin writes its own temp file
at install time regardless.

Until that is decided, the shell log says the number out loud on every download:
`... waiting for a clean quit, N bytes held`.

One env seam, for a rig or a bench that must not phone home:

```
set PHOTO_PIGEON_UPDATE_CHECK=off
```

It is read in both debug and release builds, because the run worth holding back
is a real installed copy in the middle of a measurement. It is not a user setting
and there is deliberately no menu item for it. `app/e2e/rig-common.ps1` sets it
for every rig shell, before the per-rig environment, so a rig can still override
it deliberately.

### The log lines a walk can be read out of

The shell log is `%LOCALAPPDATA%\io.github.justerlex.photopigeon\logs\tray.log`
unless `PHOTO_PIGEON_SHELL_LOG` says otherwise.

```
update checks are on: the first goes out in 20s and then every 24h
checking for an update
update 0.1.1 is available, this copy is 0.1.0. Downloading quietly.
update 0.1.1 is downloaded, verified and waiting for a clean quit, N bytes held
not installing update 0.1.1 on this exit, Detached: the engine was left to finish on its own, ...
installing update 0.1.1 on the way out, Drained. This is the last thing this process does.
```

The fifth line is the falsifier's own evidence. A run where nothing installed and
a run where nothing was ever wired look identical from the outside, so the refusal
has to name the version it was holding and the way out it refused.

---

## What only CI, or only publish day, can prove

Named here rather than left as a good feeling, because the honest half of a
release runbook is the list of things it cannot close.

- **The workflow itself.** The preflight, the sidecar staged before the Rust
  build, the tag-versus-manifest comparison failing a bad tag, and a draft Release
  with three assets on it. A workflow can be read, and a workflow that has never
  run has not been tested. The first tag is the test, and the specific pieces of
  it that have never executed are listed in `.github/workflows/README.md`.
- **Signature agreement between the committed public key and the CI secret.** No
  test in this repo can see both halves. Three things stand in for one: the
  ordering in steps 1 to 4, the tag road's key gate, which closes the un-swapped
  half of it by machine, and the bundler's own comparison, which is the only
  thing anywhere that holds both halves at once. Step 4 says where to read it,
  section 2 says why it is a signal and not a gate.
- **The wall.** It shows once per machine per file, and it needs a real download
  on a machine that has never met this installer. It cannot be constructed on a
  development machine and it cannot be faked.
- **The stranger.** Whether the setup window explains itself to somebody who has
  never seen it is the exit criterion of this milestone, and it is unmeasurable by
  any means except one person walking it once.
- **The sandbox venue.** Windows Sandbox has never been enabled on the machine the
  rig was written on, so every assertion downstream of the venue check has been
  proved against a fake tree in a temp directory rather than against a real
  install.

And the updater's own plumbing, row by row, because **not one of these has ever
executed.** They are numbered so a publish-day note can say which one it means.

1. **The quit-path install, watched once by hand** (TRAY-DESIGN section 6's
   M5 row 5). An update is downloaded and waiting. The user quits during a
   delivery. The drain completes, the ledger has the line, and only then does the
   installer appear.
2. **The mid-delivery wait, attempted deliberately** (row 6). An update is ready
   while a `batchCreate` is in flight and **nothing installs**. This has to be
   attempted rather than hoped for, because a passing run looks exactly like a run
   where the updater was never wired. Grep the log for the "not installing update"
   line and read the way out it names.
3. **The endpoint resolves.** Nothing has ever fetched
   `https://github.com/justerlex/photo-pigeon/releases/latest/download/latest.json`,
   because the repository is private and has no Releases. Until the first public
   Release exists, every check in every dev session fails with a line in the log,
   and that is the wiring working rather than a defect.
4. **`latest.json` has the shape the plugin parses.** It is assembled by
   `scripts/make-latest-json.mjs` from the installer and its `.sig`, and its
   `platforms["windows-x86_64"].signature` and `.url` have never been read by the
   plugin.
5. **CI's private key is the committed public key's pair.** The bundler compares
   the two and prints a sentence when they disagree, which is the log search in
   step 4, but it never verifies the signature it has just made. A mismatched
   pair that gets past that line produces a Release that looks perfect and cannot
   be installed by anybody, and the first real download is the only test of that.
6. **The download survives the real path.** GitHub redirects release assets to
   `objects.githubusercontent.com`; the plugin follows it with
   `Accept: application/octet-stream` and a user agent of its own.
7. **The passive NSIS install replaces the app in place.** No wizard, no clicks, a
   progress bar, and afterwards: the install directory is still
   `%LOCALAPPDATA%\Photo Pigeon`, the HKCU Run value still points at
   `photo-pigeon.exe` inside it, the Start Menu shortcut still carries the
   AppUserModelID that names the toasts, and `~/.photo-pigeon` is untouched. That
   last one is row 12's law, and the updater is a second door into it that row 12
   does not walk.
8. **The relaunch after the install.** The plugin forwards this session's own argv
   to the installer, so a session that Windows started at boot relaunches with
   `--autostart` on it. Today that flag only changes one log line, so this is a
   thing to notice rather than a thing to fear, and it is worth noticing before it
   becomes a thing that matters.
9. **The 24 hour timer over a real day.** Only ever tested against a fake clock. A
   machine left running for two days should show exactly two "checking for an
   update" lines after the launch one.
10. **The version the updated copy reports.** After the install, the tray and the
    status window should read the new number, from the one place it is written.
11. **All of it needs a second version to exist.** Rows 1 and 2 are the two proofs
    the updater actually owes, and **v0.1.1 is where they are proved for real.**
    Launch day can close rows 3 to 7 and 10; it cannot close 1, 2, 8 or 9.
