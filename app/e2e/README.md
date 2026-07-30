# app/e2e

The scripted end to end rig for the tray shell, and the manual checklist that
covers what a script cannot see.

- `run-e2e.ps1` : the delivery rig. PowerShell 7, Windows only, no dependencies.
- `run-m3.ps1` : the M3 scenarios. The words, pause, detach, the Run key, and a
  delivery after a cold relaunch.
- `run-m4.ps1` : the M4 scenarios. First run without a terminal, doctor's
  report on a throwaway setup, a simulated delivery, and what a window costs.
- `rig-common.ps1` : the rails every script runs on. Dot-sourced, never
  executed. The safety refusals live here and nowhere else, so there is one copy
  of them. **The tray-launch rail moved here at M4**, out of `run-m3.ps1`, for
  that reason: two rigs now launch trays.
- `rig-selftest.ps1` : tests the rig's own dangerous and intricate parts, and
  launches no tray. 160 checks.
- `sandbox/` : the M5 install matrix, in a Windows Sandbox. The one place in this
  repository that installs and uninstalls the real product under the real name,
  which is why it refuses to run anywhere but inside a disposable machine. It has
  its own README.
- `m3-vocabulary.json` : the words and events `run-m3.ps1` asserts on, in one
  file, so a rename on the core's side costs an edit rather than a hunt.
- `m4-protocol.json` : the same thing for M4. The setup channel's events, the
  one payload-carrying answer form, the scripted answers, the handle and RAM
  budgets, and the first-delivery rule.
- `fake-core.mjs` : the rig's stand-in core. Speaks the watch vocabulary,
  records a delivery, reaches no network. It is how a delivery is proved on a
  machine with no Google account. It REFUSES `setup`, deliberately.
- `fake-setup.mjs` : a setup channel that answers nothing but the protocol, so
  the rig's own ask loop can be tested before an M4 core exists. **Only
  `rig-selftest.ps1` runs it**, and only to test the rig.
- `CHECKLIST.md` : the human passes. M2, M3, M4, then M5, as tickable steps.

Nothing in here is imported by the app or the core. It is a test harness that
drives a built binary from the outside, so it can be run against
`target\release`, against an installed NSIS build, or against the CLI itself.

---

## Run it

**Rig self test. No network, no secrets, nothing is uploaded.** Start here, and
run it again any time the rig itself is suspect. It drives the CLI directly
instead of the tray, so a failure here is a rig fault or a core fault and never
a tray fault.

    pwsh -File app\e2e\run-e2e.ps1 -Target Core -DryRun

**The real thing.** One photo really is delivered to Google Photos, using the
credentials and token you point at. Nothing is hardcoded and `~/.photo-pigeon`
is never read.

    pwsh -File app\e2e\run-e2e.ps1 `
      -CredentialsPath C:\path\to\client.json `
      -TokenPath      C:\path\to\token.json

**Against the CLI, for real, when the tray is broken and you want to know
whether the core still works:**

    pwsh -File app\e2e\run-e2e.ps1 -Target Core `
      -CredentialsPath ... -TokenPath ...

**Set up for the manual pass**, then hand the printed launch lines to a human:

    pwsh -File app\e2e\run-e2e.ps1 -Stage prepare -CredentialsPath ... -TokenPath ...

**Drop one more photo** into a run that is already going:

    pwsh -File app\e2e\run-e2e.ps1 -Stage drop -RunDir <printed run directory>

Exit code is 0 when every check passed and 1 when any check failed. The console
output is the report; the same thing lands in `report.json` in the run
directory, along with the core's log, the shell's log and the ledger.

### The M3 scenarios

`run-m3.ps1` is the second rig. It answers the four things M3 added, and each
scenario is separately runnable so a failure can be repeated in twenty seconds
rather than four minutes.

    pwsh -File app\e2e\rig-selftest.ps1                       # the guards, first
    pwsh -File app\e2e\run-m3.ps1 -Scenario vocabulary -DryRun
    pwsh -File app\e2e\run-m3.ps1 -Scenario all -CredentialsPath ... -TokenPath ...

| Scenario | Needs | What it proves |
|---|---|---|
| `vocabulary` | nothing | the core answers `pause`, `resume` and `rescan`, and still answers an unknown word by name on stderr. The control is a word that cannot be real. |
| `pause` | nothing | a real pause: same pid, same lock, no respawn. A photo dropped while paused is not delivered, and is delivered after resume. |
| `rescan` | nothing | Deliver now walks the folders, without a respawn and without ending the run. |
| `detach` | credentials for the timing half | `stop`, `detach`, then the shell dying: the batch still finishes, the exit is 0, and the impatient path never runs. A control sends `stop` and dies without saying detach, which must still be impatient. |
| `runkey` | a tray, an M3 build | the Run value the shell writes is quoted, is REG_SZ, names the exe it was launched from, and carries the boot flag. |
| `stalepath` | a tray, an M3 build | a Run value pointing somewhere else is rewritten on the next launch. |
| `coldstart` | a tray | quit, launch again with the boot flag as the only argument, drop a photo, it arrives. The machine half of the M3 exit criterion. |

**The Run key rule, which is the reason this script is separate.** The rig never
writes a Run value: the shell writes it and the rig reads it back. Every tray it
launches carries `PHOTO_PIGEON_AUTOSTART_NAME` set to a name beginning
`photo-pigeon-e2e-`, so the value the shell writes is a value the rig is allowed
to delete, and the guards in `rig-common.ps1` refuse every other name. A snapshot
of the whole key is taken before the first launch and compared at the end. If a
tray ignores the override and writes the product name instead, the rig finds it
by the exe its data names, removes it, and stops.

The dry run is real but partial: a dry run uploads nothing, so a drain takes
milliseconds and nothing can be in flight. The detach scenario says so in its own
output rather than pretending, and marks the timing checks `info` or `skip`.

### The M4 scenarios

`run-m4.ps1` is the third rig, and it splits the M4 exit criterion at the one
place it is honest to split it. The criterion is *"a machine with no config
reaches a first delivery, and the only text the user typed was their Google
password"*. A rig cannot type a Google password and must never try.

    pwsh -File app\e2e\rig-selftest.ps1                    # the guards, first
    pwsh -Command "& .\app\e2e\run-m4.ps1 -Scenario setup,doctor"   # no tray, no network
    pwsh -Command "& .\app\e2e\run-m4.ps1 -Scenario all"

| Scenario | Needs | What it proves |
|---|---|---|
| `setup` | an M4 core | a temp environment with no config drives the real `setup --events ndjson` end to end, every ask answered from a script, and a config file lands in the temp directory with every path in it under `%TEMP%`. |
| `doctor` | `doctor --json -c` | doctor reads that throwaway environment and comes back green, with every check it is unhappy about named rather than counted. |
| `delivery` | a tray | a photo in the watched folder becomes a ledger line. **The upload is simulated** by `fake-core.mjs`: what this proves is the shell's half, plus the first-ever truth arriving on the event. |
| `window` | an M4 shell | a tray with no config opens the first-run window by itself, the page really runs, `WM_CLOSE` destroys it, and no webview process outlives the close. |
| `orphan` | an M4 shell | the window is closed mid flow, and then killed mid flow. Nothing half written is left behind and the setup sidecar exits both times. |
| `handles` | an M4 shell | open and close a window and watch the handle count. This is the number TRAY-DESIGN section 6 asks for at M4. |

**The two rails that keep a setup run off the real config**, and they are the
reason this script is separate. Both are asserted before anything is launched:

1. **The flag.** `setup --help` must declare `-c, --config`. A build that
   declares `--events` but not `-c` is a **failure**, not a skip: it has the M4
   channel and shipped without the one flag that keeps it off a real user's
   config. A build that declares neither simply predates the milestone and every
   scenario skips.

   **That state has really shipped, which is why it is a failure and not a
   skip.** The first build with a setup channel declared `--events` and not
   `-c`, and `runWizard` resolved its paths from `resolvePaths(options.homeDir)`
   with nothing on the CLI able to set it. So `setup --events ndjson` wrote to
   the real `~/.photo-pigeon` and no flag could stop it. A build in that state
   cannot run the `setup` scenario and cannot be tested by hand for a first run
   either, because the only way to make "a machine with no config" would be to
   move a real one out of the way.
2. **The home directory.** Every child is launched with `USERPROFILE` pointing
   into `%TEMP%`, and the run refuses to start until node has been asked, in
   that environment, where its home is. A setup that ignored every flag it was
   given would still land under `%TEMP%`. Afterwards the sandbox's own
   `.photo-pigeon` is asserted absent, which is how "the flag was obeyed" is
   told apart from "the flag was ignored and the other rail caught it".

Afterwards the production folder is compared against a witness taken before
anything launched: nothing created, nothing removed, and `config.json`,
`setup.json` and `credentials.json` untouched to the byte. It is deliberately
**not** an equality check on the whole folder, because a live watch may be
running against it and is supposed to be appending to its ledger.

**Nothing is ever installed**, under the product name or any other. The rig
refuses to drive a binary out of `%LOCALAPPDATA%` or Program Files at all: that
is where an installed Photo Pigeon lives, and these scenarios post messages
at windows and terminate webview hosts on purpose. It does not offer one as a
fallback either. The candidate list is repo builds, so a machine that has only
ever installed is told to build rather than handed a path the guard would then
abort on.

**The handle probe needs one thing the shell does not have yet.** It opens and
closes a window three times in one process and measures the slope, deliberately
scoring the cycles AFTER the first: TRAY-DESIGN's own A/B already measured what
the first window costs, the Windows UI stack mapping in, paid once. There is no
scriptable way to open the window a second time, because the trigger is a tray
menu item. Pass one as `-OpenWindowCommand` and the probe runs in full; without
it, it runs the one cycle a first run gives it and marks the slope `skip` rather
than inventing a number. Same shape as `-QuitCommand`, and for the same reason.

### The M5 install matrix, in a Windows Sandbox

`sandbox/` is the fourth rig and the only one that installs anything. It exists
because three M5 rows cannot be walked on a development machine at all: **it
holds an install, a Run value and a real `~/.photo-pigeon`**, and an uninstaller
pointed at that machine is an uninstaller walking past the durable record of
every photo the tool has ever delivered. So the venue is a disposable Windows.

    pwsh -File app\e2e\sandbox\make-wsb.ps1     # then double-click the .wsb

What it settles, in one unattended run: a silent install on a machine that has
never seen this product, the shape of what lands, a launch that leaves
`~/.photo-pigeon` **absent** because no config means no core, the Run value's
seven assertions on a real installed copy, a silent uninstall that takes the
directory and the shortcuts and the Run value and **leaves a hand-made ledger
byte for byte intact**, a reinstall over the residue, and an install over a live
install. Every assertion lands in a transcript mapped back out to the host.

What it cannot settle, and says so at the top of its own script and at the top of
every transcript: the walk a stranger takes. No Google account, so no delivery
and no first toast; no mark of the web on a file that arrived through a mapped
folder, so **no SmartScreen wall**; and no way to construct a genuinely dead core,
so the red badge icon state stays an eye row. Those are section 1 and the icon
rows of the M5 pass in `CHECKLIST.md`.

Two of its parts are second copies of `rig-common.ps1` helpers, because Windows
Sandbox ships Windows PowerShell 5.1 and no `pwsh`, and `rig-common.ps1` declares
7.0. `rig-selftest.ps1` holds both copies to their originals over the same inputs,
and runs every one of the sandbox rig's assertions against a fake install tree
under TEMP, so the only thing first exercised inside a sandbox is the sandbox.

### The flags worth knowing

| Flag | Why |
|---|---|
| `-ExePath` | Which binary. Default: `app\src-tauri\target\release\photo-pigeon.exe`, then the debug build. Repo builds only, and an installed copy is refused however it is named. |
| `-Album` | The album the test photo is filed into. Default `photo-pigeon e2e`, so a human can find and delete it. `-Album ''` files it nowhere. |
| `-QuitCommand` | A scriptable quit, once the shell has one. See below. |
| `-CoreJs`, `-NodeExe` | Passed through as `PHOTO_PIGEON_CORE_JS` and `PHOTO_PIGEON_NODE`, for driving a packaged build over a specific `dist/cli.js`. |
| `-ShellLog` | Read a shell log somewhere else instead of the one in the run directory. |
| `-IdleSettleSec` | How long to let the shell settle before the idle memory reading. Default 30, which matches how the M0 number was taken. `0` skips it and makes the run about half a minute shorter. |
| `-KeepSecrets` | Leave the copied credentials and token in the run directory. Off by default. |
| `-AllowExistingTray` | Run even though a tray is already up. Off by default, because two trays fight. |

---

## What it asserts

In order, with the ones that are load bearing marked.

**Preflight**

1. Credentials and token came in as parameters and both exist. The real config
   directory is never read.
   - **Safety.** `-ConfigEnvName` is the name the shell actually reads, taken
     from `app/scripts/sidecar-layout.json` rather than from memory. Setting the
     wrong name sets nothing at all, and a tray with no override runs against
     the production config, so this is checked before anything is launched.
     Tray target only: `-Target Core` puts `-c` on the command line itself.
2. **Safety.** Every generated path resolves under `%TEMP%`, and the run refuses
   to start if any of them would land inside `~/.photo-pigeon`.
3. Which photo-pigeon watches were already running, found by command line rather
   than by reading anything they own. On a development machine that is usually
   the production watch, `node dist/cli.js watch`.
4. No tray is already running, unless you said one may be.

**Launch**

5. The binary exists, and its name is `photo-pigeon.exe` rather than the M0
   spike's `photo-pigeon-tray.exe`.
6. The process is still alive three seconds later. If it is not, its stderr is
   printed.
7. **Safety.** The tray spawned a child, and that child's command line names the run's
   throwaway config. If it names `~/.photo-pigeon` instead, the shell is stopped
   immediately and the run refuses to continue.
8. **Safety.** `PHOTO_PIGEON_CONFIG` really did become `-c <path>` on the
   sidecar's command line. **A missing `-c` stops the run**, it does not merely
   mark it failed: no `-c` means the override never reached the shell, and a
   shell with no override hands the core no config, so the core opens its own
   default, which is the production one. Only a debug build refuses that
   (`config_choice` in `paths.rs`) and this rig prefers the release build, so
   carrying on would mean four minutes of polling while a core reads and writes
   the real ledger. Same stop if the tray spawned no child to check at all, and
   same stop if the command line cannot be read and no lock appears in the run
   directory either. In every case the shell is stopped and the core is left to
   drain: nothing is ever killed by pid.

**Sidecar up**

9. The core took the throwaway lock: `watch.lock` appears in the run directory,
   holds a pid, and that pid is the child the rig tracked. This is the strongest
   available proof that the tray is watching the right thing, and it does not
   depend on the shell logging anything.
10. `watch.log` exists in the run directory, so **Open log** has something to
    open.
11. The shell wrote its own log where `PHOTO_PIGEON_SHELL_LOG` told it to.

**Memory** (M2 asks for the M0 rows to be re-measured under load)

12. Tray shell idle working set, after a settle. Fails above 25 MB, which is the
    number section 1 of TRAY-DESIGN.md says reopens the shell technology
    decision. Warns above the 15 MB target.
13. **Zero `msedgewebview2.exe` processes while no window is open.** The whole
    no-window-at-idle law in one check.
14. Core sidecar working set while watching with an empty queue. Warns above 80,
    fails above 120.
15. Peak working set of both, sampled every second across the delivery.

**Delivery**

16. A valid one pixel PNG is generated with bytes that have never existed
    before: a random pixel plus a GUID in a `tEXt` chunk, so its sha256 cannot
    collide with anything already in a ledger. Verified as a real PNG (chunk
    CRCs, zlib stream, and the Windows imaging stack decodes it).
17. It is written outside the watched folder and moved in, so the watcher can
    never see a half written file.
18. **The delivery landed**: a line in the throwaway ledger whose `hash` is
    exactly the sha256 of the file the rig made. Not a path match, not a count.
19. That entry carries a Google `mediaItemId`, and its byte count matches the
    file on disk.
20. How many seconds passed between the drop and the ledger line.
21. In a dry run there is no ledger line by design, so the proof is the side
    index instead: it records a hash only for bytes the core read itself. The
    ledger is also asserted to have stayed empty.

**The event contract** (`-Target Core` only, where the stream is visible)

22. The NDJSON stream carries `started`, `delivering` and `delivered`.
23. Every event carries an `at`.
24. The last line of the run is `stopped`.

**Quit and drain**

25. Nothing is stopped until the ledger has been quiet for three seconds. The
    rig never asks for a stop while work is moving.
26. The quit goes out. How, see below.
27. The shell exited.
28. **The core drained and exited on its own, and was never killed.** If it is
    still there after the drain window, the rig says so, prints the pid, and
    leaves it alone.
29. `watch.lock` is gone. A killed watch always leaves its lock behind, so the
    absence of the file is the proof that this was a drain.
30. **Safety.** Every watch that predated this run is still alive. This is the
    check that says the production watch was not touched.

**Always**

31. The copied credentials and token are deleted from the run directory, on
    every exit path including a crash, unless `-KeepSecrets` says otherwise.

---

## How the quit is asked for

The tray has no scriptable quit today, and this is the honest state of it.

**`-Target Core`**: the shipped protocol exactly. A bare `stop` line on the
child's stdin, then wait for `{"type":"stopped"}` and the exit. No signal is
sent, because on Windows none arrives. This path doubles as a reference
implementation of what the tray's supervisor has to do.

**`-Target Tray`, default**: the rig stops **the shell only**. It tries
`CloseMainWindow` first, which does nothing to a window-less tray app, then
`Process.Kill()` on that one process. It never uses `Kill(entireProcessTree)`
and it never touches the core.

That is safe, and it is a real test rather than a workaround: when the shell
dies its end of the sidecar's stdin pipe closes, the core reads end of file, and
end of file means stop. The rig then asserts that the core drained and released
its lock on its own. **Exercised**: an aborted run left the core parentless and
it exited cleanly by itself, lock removed.

What it does not cover is the menu item, the "finishing 3 files, then closing"
sentence, and the second click. Those are checklist steps 6.1 to 6.6.

**`-QuitCommand '<anything>'`**: if the shell grows a scriptable quit, pass it
here and the rig runs it in place of the kill. Everything after it, the drain
assertions and the orphan check, is unchanged. Two shapes would both work
without touching this script:

- a `--quit` argument handled through `tauri-plugin-single-instance`, which
  section 2 of TRAY-DESIGN.md already says ships, so a second launch could carry
  the instruction instead of starting a rival;
- a quit request file in a directory named by an environment variable, watched
  by the shell. Cheaper to write, but it needs a watcher in the shell, and the
  shell adding a file watcher for the benefit of a test is worse than the kill.

The first one is the better buy, and it is not needed for M2.

---

## What stays human only

The rig cannot see the tray. None of these can be scripted without UI
automation, and UI automation of the Windows tray overflow is more fragile than
the thing it would be testing:

- that the icon is visible at all, and legible against both a light and a dark
  taskbar;
- that it is sharp at 125% and 150% scaling;
- that the icon changes state during a delivery, and that it goes back;
- that the menu opens, that the status line and the storage sentence are on it,
  and that they say the truth;
- that the tooltip agrees with the menu;
- **Open log** and **Open watched folder** actually opening the right thing;
- pause and resume, driven from the menu;
- quit drains, driven from the menu, including the second click;
- cold start to icon visible, which needs a clock and an eye;
- that no console window ever flashes.

M3 adds four more, and they are the reason its checklist section is longer than
its scenario list:

- **the four toasts**, which no process can read back. The M3 checklist has a
  safe trigger for each one, and all four touch nothing but a run directory: a
  fresh `shell-state.json` for the happy one, a corrupted throwaway token for
  auth, a pre-spent `quota.json` for the limit, and ending the throwaway sidecar
  for the unexpected exit;
- **the toggle**, ticked and unticked from the menu, read back out of the
  registry by hand;
- **the literal reboot**, which is the milestone's exit criterion and the one
  thing here that runs against the real config on purpose;
- **the display name**, everywhere a human reads one.

M5 adds five, and the first is the milestone's own exit criterion:

- **the walk a stranger takes**, on a machine that has never seen this product:
  the download in a browser, the SmartScreen wall and the two clicks past it, the
  wizard with a real Google account, and a photo that arrives. The sandbox rig
  proves the install matrix and deliberately not this;
- **the SmartScreen screenshot**, which can only be taken on a machine Windows
  has never watched run this file;
- **answering yes to the uninstaller's application-data question**, because that
  checkbox has no command line switch and a law that only holds while the user
  declines is not a law;
- **the paused tray icon wearing its ring at 16 px**, which is a judgement about
  legibility and not a pixel comparison;
- **the red badge**, which is only honest to look at while a core genuinely will
  not start. No rig in this repository can construct that state.

All of it is `CHECKLIST.md`, in that order.

---

## Notes for whoever changes the shell

The rig reads these from the shell's side of the contract. If any of them moves,
the rig needs a flag, not an edit:

| What | Where it is declared | The rig's flag |
|---|---|---|
| `PHOTO_PIGEON_CONFIG` becomes `-c <path>` | `app/src-tauri/src/paths.rs` | `-ConfigEnvName` |
| `PHOTO_PIGEON_SHELL_LOG` names the shell's log | same | `-ShellLog` |
| The binary is `photo-pigeon.exe` | `tauri.conf.json`, `mainBinaryName` | `-ExePath` |
| `PHOTO_PIGEON_AUTOSTART_NAME` moves the Run value name aside | `app/src-tauri/src/paths.rs`, used by `autostart.rs` | `-AutostartNameEnv` |
| The boot flag is `--autostart` | `app/src-tauri/src/autostart.rs`, `BOOT_FLAG` | `-BootFlag` |
| The Run value name is productName | `tauri.conf.json`, `productName` | `m3-vocabulary.json` |
| The shell knows how to spawn a setup channel | `app/scripts/sidecar-layout.json`, a `setup` block or `spawn.setupArgs` | none, and that is deliberate |
| The setup window's title | the window builder | `m4-protocol.json`, `window.titleMarker` |

The first three are checked before anything is launched. The autostart three are
read from `app/scripts/sidecar-layout.json` when it carries an `autostart` block,
and from `app/e2e/m3-vocabulary.json` when it does not. **Declaring them in the
layout file is the better home**, because the shell is already held against that
file by a drift test in `paths.rs`, and nothing holds the rig's copy to anything.
**The layout file carries the block**, so that is where the values come from and
the run says so out loud: *"the autostart facts came from a contract, not a
guess: ... from app\scripts\sidecar-layout.json"*. The copy in
`m3-vocabulary.json` stays as the fallback and as the thing to compare against
when the two ever disagree.

Two things the rig would rather not have to infer:

- **A line in the shell log when the boot flag is recognised.** `coldstart` looks
  for the flag in the shell's own log to prove the word that ships is the word
  the boot path parses, which is the disagreement M3 had to settle. Without it
  the check can only warn. **The shell writes that line**, on every launch and
  in both directions ("this launch came from the Run key" and "did not come
  from"), so the check passes rather than warns.
- **Anything the shell starts remembering between launches.** It does now:
  `shell-state.json` holds the autostart decision, and it lives beside the
  shell's log, so `PHOTO_PIGEON_SHELL_LOG` moves both at once. That is the right
  shape and the rig depends on it. If either file ever moves somewhere
  `PHOTO_PIGEON_SHELL_LOG` does not reach, the rig needs a new flag and the
  checklist needs a new cleanup step.

  **It held the first-delivery toast flag too until M4, and no longer does.**
  "First ever" means the ledger was empty before that delivery, which is the
  core's fact and not the shell's, so the flag went and the `delivered` event
  carries `firstEver` instead. One consequence for a rig author: a throwaway
  config with an empty ledger really is a first delivery, and it really will
  toast, however many times an installed copy has toasted before.

- **`app/e2e/run-m4.ps1`** covers the half of M4 a script can see: the setup
  machine channel, the ask id lifecycle, the one payload-carrying stdin form,
  and `doctor --json`. It cannot observe a window and no rig on this project
  ever will, so `docs/ASK-PROTOCOL.md` section 6 and `CHECKLIST.md` section 7b
  are the rest of the review rather than a backlog.

Everything else the rig looks at belongs to the core and is derived from the
config it wrote: the ledger, `watch.lock`, `watch.log` and `sideindex.jsonl` all
live beside the ledger path, which the rig chose.

M4 adds three more, and the first two are the ones without which a scenario
cannot run at all rather than merely warn:

- **`setup` must take `-c, --config`.** Two rigs' worth of safety rests on it.
  `run-m4.ps1` reads `setup --help` before it launches anything, and a build
  that declares `--events` without `-c` is reported as a fault rather than
  skipped, because that build has the M4 channel and no way to be kept off a
  real user's config.
- **A `setup` block in `app/scripts/sidecar-layout.json`** is how the rig knows
  the shell in front of it has a first-run window at all. Without it, the
  window, orphan and handle scenarios skip **without launching anything**, which
  is on purpose: pointing an M3 tray at a config path that does not exist puts
  it in a respawn loop against a core that cannot read it.
- **A scriptable way to open the setup window in an already running tray.** The
  handle probe needs to open one more than once and the trigger is a menu item.
  Pass one as `-OpenWindowCommand`; without it the probe reports the first-open
  cost and marks the slope `skip`. The single-instance guard TRAY-DESIGN
  section 2 says ships is the natural home for it: a second launch carrying an
  argument, forwarded to the first instance, exactly as this file already
  proposes for `-QuitCommand`.
