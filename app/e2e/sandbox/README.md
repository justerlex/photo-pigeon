# app/e2e/sandbox

The install matrix, in a machine that can afford to be wrong.

Three of M5's rows cannot be walked on the machine this project is built on, and
not for want of care: **a development machine holds an install, a Run value and a
real `~/.photo-pigeon`**, which is the durable record of every photo the tool has
ever delivered. A rig that installed and uninstalled the real product under the
real name on that machine would be pointing an uninstaller at the one directory
the whole design exists to protect. So the venue is Windows Sandbox: a disposable
Windows that has never seen this product, is thrown away when the window closes,
and can be wrong at no cost.

    make-wsb.ps1        writes photo-pigeon.wsb and install-facts.json for this
                        checkout. Run it first, every time.
    photo-pigeon.wsb    the sandbox configuration. Generated. Double-click it.
    bootstrap.ps1       the rig. Runs on logon inside the sandbox, and refuses to
                        run anywhere else.
    sandbox-assert.ps1  the assertions, as functions that answer with records.
                        Dot-sourced by the rig, and tested outside a sandbox by
                        ../rig-selftest.ps1 against a fake directory tree.
    install-facts.json  generated: what the product is called, read off the files
                        that own each name.

---

## What it proves, and what it does not

**It proves the install matrix.** Nine sections, in the transcript's own order:

| # | Section | What it settles |
|---|---|---|
| 1 | A fresh machine, installed silently | the `/S` install finishes, exits 0, elevates nothing and starts nothing |
| 2 | The shape of what landed | every file the layout contract names, under `%LOCALAPPDATA%\Photo Pigeon`, one Add or Remove Programs entry, a Start Menu shortcut that points at the exe, and **nothing on the Desktop** |
| 3 | Launched, and the state directory is still not there | the tray runs, no core is spawned, the shell log says first run, and `~/.photo-pigeon` **does not exist yet**. Then the Run value, all seven assertions |
| 4 | A state directory made by hand | a marker with a GUID in it and a three line ledger, so what survives cannot be a coincidence |
| 5 | Uninstalled silently, with the tray still running | the uninstaller deals with a running app rather than the other way around |
| 6 | What the uninstall took, and the one thing it may not touch | the directory, the shortcuts, the Run value and the uninstall entry all go; **the marker and the ledger survive byte for byte** |
| 7 | Installed again, over the residue | the uninstall-reinstall row, with the state directory and the shell's log directory still on disk |
| 8 | And it runs | the reinstalled tray comes up and writes its Run value again |
| 9 | Installed over a live install | the update a stranger gets: one entry, one directory, one shortcut, the Run value preserved, the running tray stopped by the installer itself |

**It does not prove the walk a stranger takes, and the transcript says so at both
ends.** Three separate reasons, each of which is a row that stays in a human's
hands:

- **No Google account.** The wizard cannot finish in here, so no photo is
  delivered, no token is written, and the first-delivery toast cannot be seen.
  That is section 1 of the M5 pass in `../CHECKLIST.md`, and nothing publishes
  before it is walked.
- **No mark of the web.** The installer arrives through a mapped folder, which
  carries no `Zone.Identifier`, so **SmartScreen has nothing to warn about and
  the wall never appears**. The real wall shows only on a machine that
  downloaded the file in a browser and has never run it before, and nothing
  waits on a capture of it: the docs describe the wall in words.
- **No genuinely dead core.** The red badge icon state exists and can only be
  seen by eye while a core really will not start. This rig cannot construct that
  state and neither can any other rig in this repository.

---

## Running it

1. **Enable Windows Sandbox once**, as an administrator. It needs a reboot, and
   virtualisation has to be on in the firmware:

       Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM

   **Windows ships the feature disabled**, so this is a real step and not a
   formality. `make-wsb.ps1` asks and says so.

2. **Build the installer**, then generate the configuration:

       pwsh -File app\e2e\sandbox\make-wsb.ps1

   It refuses to write anything if a frozen name has moved, or if the bundle
   directory holds more than one installer. That second refusal is item 4.2 of
   the M5 checklist wired into the front door: two near-identical installers side
   by side is how the wrong file ships.

3. **Double-click `photo-pigeon.wsb`.** The rig runs on logon and leaves its
   console open. When it is finished, read the transcript **on the host**, in the
   folder `make-wsb.ps1` printed (by default `%TEMP%\photo-pigeon-sandbox`).
   There are two files per run: a `.txt` written line by line as it happens, and
   a `.json` of the same records.

4. **Close the sandbox.** Everything inside it goes, which is the point.

Exit codes, for a run driven by hand rather than by the logon command: `0` every
check passed, `1` a check failed, `2` a rail refused and nothing was touched.

---

## The rails

`bootstrap.ps1` installs and uninstalls the real product under the real name.
Nothing else in this repository is allowed to do that, and `rig-common.ps1`
refuses to so much as drive a binary out of `%LOCALAPPDATA%`. So four rails have
to hold before it touches anything, and all four fail closed:

1. **The account is `WDAGUtilityAccount`.** Windows Sandbox logs in as that
   account and no interactive session on a real machine uses it.
2. **There is no state directory.** Every configured machine has one, and the one
   machine this must never run on has the ledger it would be walking past.
3. **There is no install.** A fresh sandbox has never seen this product.
4. **The caller said so.** The `.wsb` passes `-ConfirmSandbox`; a hand has to
   type it.

The rails are a function of their arguments rather than of the machine, which is
what lets `../rig-selftest.ps1` watch them fire. **Seen firing**: run on a
development machine, the rig stops with three rails failed and the fourth failing
too when the switch is left off, prints "nothing was installed and nothing was
touched", and exits 2.

**It never kills a process.** The silent installer and the silent uninstaller
both stop a running shell by themselves: `CheckIfAppIsRunning` in the generated
`utils.nsh` does it without asking under `IfSilent`. So the rig launches the tray
and lets the installer deal with it, exactly as an update on a stranger's machine
would, and section 9 asserts that it happened.

---

## Notes for whoever changes this

**PowerShell 5.1.** Windows Sandbox ships Windows PowerShell and no `pwsh`.
`bootstrap.ps1` and `sandbox-assert.ps1` are therefore 5.1 and neither may
dot-source `rig-common.ps1`, which declares `#Requires -Version 7.0` and would
refuse to load. Downloading a PowerShell into a disposable VM so that a test can
run is a dependency the test does not need.

The one thing that wall costs is two second copies: `Split-PigeonRunValue` and
`Get-PigeonRunValue`, whose originals live in `rig-common.ps1`. A second copy of
a safety-shaped parser is exactly what that file's header forbids, so both are
**held to their originals by a test**: `rig-selftest.ps1` runs each pair over the
same inputs, including the broken Run value shapes from the M3 blocker note and
every value in the real Run key, and fails if any field disagrees.

**Every path in a `.wsb` is absolute.** A Windows Sandbox configuration cannot
hold a relative path and does not expand environment variables, and a
`HostFolder` that does not exist stops the sandbox from starting at all. That is
why the file is generated rather than written by hand, and why the generated one
in this directory names whichever checkout generated it. Re-run `make-wsb.ps1`
after moving the checkout, and read the first comment in the `.wsb` if a sandbox
refuses to start.

**Networking is on, and that is deliberate.** `INSTALLWEBVIEW2MODE` in the
generated `installer.nsi` is `downloadBootstrapper`, so an install on a machine
with no WebView2 runtime fetches one, and a stranger's machine would do the same.
Modelling an offline install is a one word edit in the `.wsb`; the transcript
will then show the installer aborting at its WebView2 step rather than leaving
you guessing.

**The facts are read, never guessed.** `install-facts.json` is written by
`make-wsb.ps1` out of `app/src-tauri/tauri.conf.json`,
`app/scripts/sidecar-layout.json`, the repo root `package.json` and
`src/wizard/paths.ts`. Nothing inside the sandbox knows the install directory,
the exe name or the Run value name except through that file, and a rename that
moved any of them fails the generator instead of testing the wrong directory.

**Two things the rig deliberately leaves to a hand**, both in `../CHECKLIST.md`:

- **Answering yes to the application-data question.** The uninstaller's own
  checkbox has no command line switch. A silent uninstall leaves it unticked,
  which is the default case this rig proves; item 3.4 of the M5 pass is the
  deliberate opposite, and a law that only holds while the user declines is not a
  law.
- **The two icon states added in round 3.** The paused ring at 16 px and the red
  badge. Both are eye rows, and the red one needs a core that genuinely will not
  start.
