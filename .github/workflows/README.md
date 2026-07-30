# The two workflows

Everything between a green `main` and a published release. The milestone these
were written for has one exit: a stranger downloads an installer from a GitHub
Release, gets past SmartScreen because the page told them how, and backs up a
folder. Background and every decision behind this: `docs/TRAY-DESIGN.md`
section 5, and the M5 working plan in section 6. The order a human executes them
in is `docs/RELEASE.md`.

| File | Fires on | Does |
|---|---|---|
| `ci.yml` | push to `main`, every pull request | one job, `windows-latest`: version lockstep, the core suite, the sidecar staging, the shell suite |
| `release.yml` | a `v*` tag | the whole road, ending in a **draft** release carrying the installer, its `.sig` and `latest.json` |
| `release.yml` | that release being **published** | `npm publish --provenance`, from the same tag |

## The secrets, and who can make them

All three are made by the maintainer, out of accounts nothing in this repository
can reach. No workflow can create one.

| Secret | What it is | Needed by |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the minisign private key from `tauri signer generate`, whole file contents | the tag road, for the update payload |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its passphrase | the same |
| `NPM_TOKEN` | a granular automation token. The npm account uses passkey 2FA, so CI cannot log in as a human | the npm road |

Four things about the signing key that are easy to get wrong, and the first three
are from section 5:

- **It is not Authenticode.** It proves an update came from this project. It does
  nothing at all for SmartScreen. Two signatures, two entirely different problems.
- **Losing it strands every user.** An installed copy can only ever be updated by
  a build signed with this key. There is no recovery but asking people to download
  a fresh installer by hand. It is backed up offline, in a password manager,
  **before** the first release, because the day the key matters is the day it is
  already gone.
- **The public half is committed**, in `tauri.conf.json` under
  `plugins.updater.pubkey`. That file belongs to the updater, not to these
  workflows.
- **A set secret says nothing about which key it holds.** The repository ships a
  clearly marked throwaway public key until the real one exists, and step
  2 of `docs/RELEASE.md` is the swap. A tag with the secrets set and the swap
  forgotten passes every other check and ships a build that trusts a key nobody
  signs with, which is silent and permanent. So the tag road decodes the pubkey
  in its first minute and refuses the throwaway by id. That gate is tag only, and
  it keeps the dead id for ever.

Without `NPM_TOKEN` the npm job explains itself and exits green. That is
deliberate: the npm half of a launch is allowed to arrive a day after the
installer.

## Why the shape is this shape

**One job in `ci.yml`.** The Rust suite cannot run until the sidecar is staged,
and the sidecar is an 85 MB `node.exe` plus a 1.7 MB bundle. Two jobs would mean
building it twice or passing it between runners. Ordering inside one job is
cheaper and it is the gate.

**Windows, not ubuntu, for the core suite.** Section 5 sketched a fast ubuntu job.
The core suite has only ever been green on Windows, it holds file locks, path and
ledger behaviour, and the product is a Windows tray. Proving it on Linux is a new
claim to make rather than a box to tick, and M5 is not the milestone for it.

**The sidecar is staged before anything Rust.** `tauri.conf.json` names
`binaries/` and `resources/` in `externalBin` and `resources`, both are
gitignored, and a fresh clone has neither, so the Rust build fails until they
exist. `app/package.json` wires this to `prebuild` for a human, and nothing in
these workflows goes through that script. A test holds the ordering:
`scripts/workflows.test.ts`.

**`npm publish` is on the click, not on the tag.** Section 5 put it on the tag.
The two halves of a release are not equally reversible: a draft release is
invisible and deletable, an npm publish is a public version number with a 72 hour
window and a name that can never be reused. Publishing is a human click by
project rule, so the click that publishes the Release is the click that publishes
the package. Overruling this is one `if` and one trigger.

**`latest.json` is assembled by `scripts/make-latest-json.mjs`, not by
`tauri-action`'s `includeUpdaterJson`.** Because it can be tested at the desk, and
because of one trap that goes red nowhere else: `productName` is "Photo Pigeon",
with a space, so the bundler writes `Photo Pigeon_0.1.0_x64-setup.exe`, and GitHub
replaces whitespace with dots when it takes a release asset. A manifest carrying
the bundler's spelling points at a 404, and every installed copy fails its update
check silently, forever. `scripts/make-latest-json.test.ts` is that case.

**The release is a draft and nothing here undrafts it.** Asserted, not intended.

**The e2e rig is not run by CI.** `app/e2e` is Windows PowerShell that launches
real trays and waits on a tray icon, an HKCU `Run` value and a pair of eyes. A
hosted runner has no desktop session to put a tray in, so a green rig there would
mean nothing. Section 1 of the M5 pass in `app/e2e/CHECKLIST.md` is the
pre-publish must and a person walks it.

## The version, in one place, checked in three

`scripts/check-versions.mjs` compares the root `package.json` against
`app/package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` and, on the
release road, the tag. It runs in both workflows and again under `npm test`
through `scripts/check-versions.test.ts`, so drift fails at the desk before it
fails on a runner. `app/src-tauri/build.rs` keeps its own copy of the
`Cargo.toml` comparison, and that is not redundancy: it fires on the machine that
caused the drift.

## The same road, at the desk

```
node scripts/check-versions.mjs
npm ci
npm test
npm ci --prefix app
node app/scripts/build-sidecar.mjs
cargo test --manifest-path app/src-tauri/Cargo.toml
```

## What only the first real tag can prove

Everything below is written and reviewed and has never executed. It is listed so
that the first tag is read as a test rather than as a release.

- That the runner's Rust toolchain, WebView2 headers and NSIS build produce the
  same installer a development machine produces.
- That `tauri-action` with `projectPath: app` finds the config and leaves the
  bundle where `make-latest-json.mjs` looks for it.
- That `bundle.createUpdaterArtifacts` is on, the signing secrets are set, and the
  committed pubkey is no longer the throwaway, so a `.sig` exists at all and the
  build that makes it can be trusted by the build that ships. All three live in
  `tauri.conf.json` or in a secret and belong to the updater work rather than to
  these files, so the tag road checks all three in its first minute and refuses
  the whole run rather than failing at the assemble step twenty minutes later. A
  release nobody can update is not a release this project ships.
- That `gh release create --draft --verify-tag` accepts the assets, and that
  GitHub renames `Photo Pigeon_...exe` to `Photo.Pigeon_...exe` exactly as the
  manifest predicts. **Check that URL by hand on the draft before publishing.**
- That npm accepts `--provenance`. It needs a public repository, and so does the
  SignPath Foundation application, so the order is public first, then publish.
