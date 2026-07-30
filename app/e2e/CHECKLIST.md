*Four passes live in this file, oldest first. **M2** is the regression list for
anything that touches the icon, the menu or the drain. **M3** is the one with the
reboot in it. **M4** is first run without a terminal. **M5** is at the bottom, it
is the release pass, and it is the current one.*

---

# M2 manual pass

The scripted rig (`run-e2e.ps1`) proves the machinery: the sidecar comes up
against the right config, a photo really is delivered, the core drains and lets
go of its lock. It cannot see the tray. Everything below needs eyes.

The M2 exit criterion is one sentence: **install the NSIS build, drop a photo
into a watched folder, watch it deliver, without a terminal ever being opened.**
This list is that sentence, broken into steps that can be ticked.

Fill in the date, the build and the result, and keep the filled copy with the
milestone. A step that fails is a note, not a stop: keep going, so one pass
finds every problem instead of one.

    Date:
    Build:            (installer file name, or the exe and its timestamp)
    Windows theme:    light / dark
    Display scaling:  100% / 125% / 150%
    Result:           pass / pass with notes / fail

---

## Before you start

If a production watch is running against `~/.photo-pigeon` on this machine, it
must not be stopped, and nothing here may point at it. Every step below runs
against a throwaway config that the rig builds for you.

- [ ] **0.1** Build the run directory and read the launch lines it prints:

      pwsh -File app\e2e\run-e2e.ps1 -Stage prepare `
        -CredentialsPath <your client json> -TokenPath <your token json>

- [ ] **0.2** That directory now holds a copy of your token. Note the path. The
      last step of this list deletes it.
- [ ] **0.3** Set both environment variables it printed, in the window you are
      about to launch from. `PHOTO_PIGEON_CONFIG` is what keeps this whole pass
      off the real config, and `PHOTO_PIGEON_SHELL_LOG` puts the shell's own log
      where you can find it.
- [ ] **0.4** Launch the tray from that window, then prove the override arrived
      before you drop anything. The prepare step prints this command:

          Get-CimInstance Win32_Process -Filter "Name='pigeon-core.exe' OR Name='node.exe'" |
            Select-Object ProcessId, CommandLine

      The tray's sidecar must show `-c <the run directory>\config.json`. **If it
      shows no `-c` at all, stop.** No `-c` means the variable did not reach the
      tray, and a tray with no override runs the engine against the real config.
      Quit the tray from its menu, set the variable, start again. A release build
      has no rail that catches this for you: only the debug build refuses to
      spawn without the variable.

If you are testing the installed build rather than `target\release`, install it
first, then launch it from a shell that has those two variables set. A debug
build refuses to spawn the engine without `PHOTO_PIGEON_CONFIG`, which is the
safety rail working, not a bug.

---

## 1. The icon exists and can be seen

- [ ] **1.1** The pigeon appears in the tray within two seconds of launch.
      Note the wait if it is longer: cold start to icon visible is an M2 number
      the design doc is still missing.
- [ ] **1.2** Windows 11 hides new tray icons. If it went to the overflow
      flyout, drag it out onto the taskbar and say so here. This is a real
      finding for the first-run window, not a nuisance.
- [ ] **1.3** **Dark taskbar.** The icon is legible: not a dark shape on a dark
      bar, not a white box.
- [ ] **1.4** **Light taskbar.** Settings, Personalisation, Colours, choose
      light mode. The icon swaps and stays legible. It follows the taskbar, not
      the app theme, and on many machines those two genuinely differ.
- [ ] **1.5** Put the theme back the way you found it. The icon follows again
      without a restart.
- [ ] **1.6** At 125% or 150% scaling the icon is sharp, not a blurred 16 pixel
      bitmap stretched up.

## 2. The menu tells the truth

- [ ] **2.1** Left click or right click opens the menu. Nothing else opens: no
      window, no console flash.
- [ ] **2.2** The first line is the live status. It names how many folders are
      being watched and what has gone today.
- [ ] **2.3** The second line carries the storage sentence: bytes sent, original
      quality. That is the storage honesty law at a glance and it is not
      allowed to be missing.
- [ ] **2.4** Both status lines are greyed out and cannot be clicked.
- [ ] **2.5** Hover the icon. The tooltip says the same thing the menu says.
      They come from the same state, so they may not disagree.

## 3. A delivery, watched

- [ ] **3.1** With the tray running, drop one photo in:

      pwsh -File app\e2e\run-e2e.ps1 -Stage drop -RunDir <the run directory>

      Or copy a real photo into the run directory's `watch` folder by hand. A
      real camera JPEG is worth doing once: the generated PNG is 145 bytes and
      proves nothing about a file that takes a while to upload.

- [ ] **3.2** The icon changes to the delivering state within a few seconds.
      Note how long: settle is two seconds, the queue's quiet flush is ten.
- [ ] **3.3** Open the menu while it is delivering. The status line has moved.
- [ ] **3.4** The icon returns to idle after the queue empties. It does not get
      stuck on delivering, and it does not animate or flash.
- [ ] **3.5** The photo is in Google Photos. If you left the album name alone it
      is in an album called `photo-pigeon e2e`.
- [ ] **3.6** Drop the same photo again, under a different name. It is
      recognised as already delivered and is not uploaded twice. The content
      hash is the identity, so a rename changes nothing.

## 4. Open log, open folder

- [ ] **4.1** **Open watched folder** opens the run directory's `watch` folder
      in Explorer. It opens the folder actually being watched, not a guess.
- [ ] **4.2** **Open log** opens a readable log in whatever handles `.log`.
- [ ] **4.3** The log's last lines describe the delivery you just watched. The
      log and the tooltip cannot disagree: both come from the same event stream.
- [ ] **4.4** Nothing in the log is a credential. Scan for `ya29.`, `GOCSPX-`,
      `refresh_token` and any `upload_id=` URL. Every one of those should be
      absent or replaced.

## 5. Pause and resume

- [ ] **5.1** **Pause.** The icon greys. The menu item becomes Resume.
- [ ] **5.2** The engine really stopped: the `pigeon-core.exe` (or `node.exe`)
      child is gone from Task Manager, and the run directory's `watch.lock` has
      been removed.
- [ ] **5.3** Drop a photo while paused. Nothing happens. Nothing is lost.
- [ ] **5.4** **Resume.** The engine comes back, the icon leaves grey, and the
      photo dropped while paused is delivered without being asked for twice.
- [ ] **5.5** Note how long resume takes to catch up. The M2 pause is stop and
      respawn, so a resume re-reconciles. On a big library that is the cost M3
      exists to remove.

## 6. Quit drains

This is the one that matters most, and the one the rig can only half prove.

- [ ] **6.1** Drop a photo, then immediately choose **Quit photo-pigeon** while
      it is still delivering.
- [ ] **6.2** The menu says what it is doing before it goes: it is finishing,
      not just leaving. The second line offers to leave without waiting, and it
      says what that costs. It does not promise the engine carries on without
      the tray, because it cannot: the shell holds the only write handle on the
      engine's stdin, so walking out during a drain is read as a second stop and
      the engine stops waiting on the wire.
- [ ] **6.3** The tray icon disappears only after the engine has finished.
- [ ] **6.4** The photo dropped just before the quit is in Google Photos, and
      there is a line for it in the run directory's `ledger.jsonl`. Nothing was
      abandoned in flight. Do this with one click, not two: a second click is
      the escape hatch and it is allowed to cost the file in flight.
- [ ] **6.5** Task Manager has no `photo-pigeon.exe` and no orphan
      `pigeon-core.exe` or `node.exe` from this run.
- [ ] **6.6** `watch.lock` is gone from the run directory. A killed watch always
      leaves its lock behind, so its absence is the proof that this was a drain
      and not a kill.

## 7. Memory, with a real watch behind it

The M0 numbers were measured with no sidecar. These replace them and belong in
the M2 column of the table in section 6 of TRAY-DESIGN.md.

- [ ] **7.1** With the tray idle and watching, no window ever opened:

      Get-Process | Where-Object { $_.Name -match 'photo-pigeon|pigeon-core|msedgewebview2|node' } |
        Select-Object Name, Id, @{n='WorkingSetMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},
                                @{n='PrivateMB';e={[math]::Round($_.PrivateMemorySize64/1MB,1)}}

      Shell working set: ______ MB  (target 15, reopen the decision at 25)
      Core working set:  ______ MB  (target 40 to 80, reopen at 120)

- [ ] **7.2** `msedgewebview2.exe` count while no window is open: ______
      It has to be zero. That is the whole no-window-at-idle law.
- [ ] **7.3** Same two numbers during a delivery: shell ______ MB, core ______ MB.
      The shell must not grow while the engine works.
- [ ] **7.4** Cold start to tray icon visible: ______ seconds. Under two is the
      target. This needs a human with a clock, which is why it is here.

## 8. The rails held

- [ ] **8.1** The production watch is still running. Same pid as before this
      pass started.
- [ ] **8.2** `~/.photo-pigeon` was not written to by anything you did. Its
      `watch.log` has no lines from this session's tray.
- [ ] **8.3** No terminal window ever appeared during any step above. A console
      flash on launch is a finding.
- [ ] **8.4** Nothing offered to delete anything. Upload only, forever.

## 9. Put the machine back

- [ ] **9.1** Quit the tray from its own menu.
- [ ] **9.2** Delete the run directory, which still holds a copy of your token:

      Remove-Item -Recurse -Force <the run directory>

- [ ] **9.3** If you installed a build for this pass and do not want it, uninstall
      it. The uninstaller must leave `~/.photo-pigeon` alone. That is an M5 test
      with its own assertion, but notice it here if it goes wrong.

---

## Notes from this M2 pass

---

# M3 manual pass

Two scripts have already run before this list is opened, and neither of them can
see the tray:

    pwsh -File app\e2e\rig-selftest.ps1
    pwsh -File app\e2e\run-m3.ps1 -Scenario all -CredentialsPath ... -TokenPath ...

Between them they prove the words (`pause`, `resume`, `rescan`, `detach`), that a
pause really holds without a respawn, that a detached core finishes its batch
after the shell is gone, that the Run value is quoted and points at the right
exe with the right flag, and that a photo dropped after a cold relaunch arrives.
So none of that is here. **What is here is everything with a human in it: the
literal reboot, the four toasts, the toggle, and the words on the menu.**

The M3 exit criterion is one sentence: **reboot the machine, log in, drop a
photo, it arrives with nothing clicked.** Item 1 is that sentence and nothing
else may be ticked before it is.

    Date:
    Build:            (installer file name, or the exe and its timestamp)
    Windows theme:    light / dark
    Result:           pass / pass with notes / fail

---

## 0. Before you start

Two of the items below are the real machine and the rest are a throwaway. Keep
them apart, because it is the difference between a reboot test and a mess.

**The real machine, deliberately: items 1 and 2.** The Run key launches the
installed exe with no environment at all, so it opens the real
`~/.photo-pigeon` and watches the folders you really use. That is the point of
the milestone, and the only two items allowed to do it.

**A throwaway, for everything else: items 3 to 7.** Build one and read the two
launch lines it prints:

    pwsh -File app\e2e\run-e2e.ps1 -Stage prepare `
      -CredentialsPath <your client json> -TokenPath <your token json>

- [ ] **0.1** That directory now holds a copy of your token. Note the path. The
      last step of this list deletes it.
- [ ] **0.2** Set both variables it printed in the window you launch from.
      `PHOTO_PIGEON_CONFIG` keeps the pass off the real config.
      `PHOTO_PIGEON_SHELL_LOG` moves the shell's log **and its
      `shell-state.json` beside it**, which is what makes the first-delivery
      toast available to test more than once.
- [ ] **0.3** Prove the override arrived before dropping anything. The prepare
      step prints the command; the sidecar must show `-c <run dir>\config.json`.
      **No `-c` at all means stop.**
- [ ] **0.4** Note which Run value name a throwaway launch is allowed to touch.
      A build running out of `target\` calls it `Photo Pigeon (dev)`, and one
      launched with `PHOTO_PIGEON_AUTOSTART_NAME` set uses whatever that says.
      Only the installed copy owns the value called `Photo Pigeon`.

## 1. The reboot. This is the milestone.

- [ ] **1.1** Install the M3 build. If `%LOCALAPPDATA%\photo-pigeon` is still
      there from M2, the display-name rename means the new one installs
      elsewhere: **uninstall the old one** and say so here if both were present.
- [ ] **1.2** Launch it once, from the Start menu, with no terminal anywhere.
      The Start menu entry says **Photo Pigeon**, not photo-pigeon.
- [ ] **1.3** Open the menu. **Start with Windows** is already ticked, without
      anybody having been asked. That is the default, and it is the whole reason
      this milestone exists.
- [ ] **1.4** Read the value back by hand, before trusting anything:

          Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
            Select-Object -ExpandProperty 'Photo Pigeon'

      It has to look exactly like this, quotes and all:

          "C:\Users\<you>\AppData\Local\Photo Pigeon\photo-pigeon.exe" --autostart

      Quotes wrap the path only. The flag sits outside the closing quote. An
      unquoted value is the M3 blocker come back, and it breaks silently for
      anybody whose account name has a space in it.

- [ ] **1.5** Quit the tray from its own menu. Reboot the machine. Really
      reboot: a sign out and back in is a weaker test and it is not this one.
- [ ] **1.6** Log in. Do not open anything. Time it: the pigeon appears in the
      tray within ______ seconds of the desktop settling.
- [ ] **1.7** Drop a photo into a watched folder. **Click nothing.** It arrives
      in Google Photos.
- [ ] **1.8** No console window flashed at login, no splash, no window at all.
- [ ] **1.9** Task Manager, Startup tab: **Photo Pigeon**, enabled, and its
      impact is not "High". Note what it says.

## 2. Start with Windows, both ways

Still the installed copy, still the real value.

- [ ] **2.1** Untick **Start with Windows**. The tick goes.
- [ ] **2.2** The value is gone from the Run key. The command in 1.4 returns
      nothing at all.
- [ ] **2.3** Quit the tray, launch it again. The line is **still unticked**. A
      default that reapplies itself is not a default, it is a nag.
- [ ] **2.4** Tick it again. The value comes back, quoted, with the flag.
- [ ] **2.5** Turn it off in **Task Manager's** Startup tab instead. Reopen the
      tray menu: the line shows unticked, because the truth is the registry and
      not something the app remembers.
- [ ] **2.6** Put it back the way you want to live with it.

## 3. The four toasts

Windows only files a toast under this app once it has been installed, so run
these against the **installed** build, pointed at the throwaway config from
item 0. Each trigger touches nothing but the run directory.

- [ ] **3.1 First delivery, the only happy one.** The run directory has no
      `shell-state.json` yet, so this launch has never delivered anything.
      Drop a photo.
      Toast: **Photo Pigeon delivered its first photo**, and the body says it is
      at original quality and counts against Google storage.
- [ ] **3.2** Drop a second photo. **No toast.** One happy toast ever, and that
      was it. Quit and relaunch against the same run directory, drop a third:
      still no toast.
- [ ] **3.3 Sign in needed.** Quit the tray. Open the run directory's
      `token.json` and corrupt the refresh token (change a few characters inside
      the quotes, leave the JSON valid). Relaunch, drop a photo.
      Toast: **Photo Pigeon needs you to sign in**. The tray icon carries the
      amber dot, and the menu says the same thing the toast said.
      *Never do this to the real token in `~/.photo-pigeon`.*
- [ ] **3.4 Today's Google limit.** Quit the tray. In the run directory write
      `quota.json` with today's date and a spent budget:

          {"day":"YYYY-MM-DD","requests":9000,"unmetered":0,"bytesToday":0,"bytesTotal":0}

      Relaunch, drop a photo.
      Toast: **Photo Pigeon has hit today's Google limit**, and it says when the
      rest goes and that nothing is lost. The icon is the paused one, not the
      attention one, and the menu line agrees.
- [ ] **3.5 It stopped on its own.** With the tray running against the run
      directory, find the sidecar in Task Manager and check its command line
      really names the run directory's `config.json`. **Only that one.** End it.
      Toast: **Photo Pigeon has stopped**, and it tells you how to start it
      again.
- [ ] **3.6** Nothing above toasted per file. If you saw one toast per photo at
      any point in this list, that is a finding and it outranks the rest of the
      page.
- [ ] **3.7** Every toast said **Photo Pigeon**. None of them said
      photo-pigeon, and none of them showed a file path or anything that looks
      like a token.

## 4. Deliver now

- [ ] **4.1** With the tray running and idle, choose **Deliver now**. Nothing
      restarts: the sidecar keeps the same pid in Task Manager.
- [ ] **4.2** Copy a photo into the watched folder while the tray is **not**
      running, then start the tray and use Deliver now. It goes. (This is the
      network-drive escape hatch, and it is the reason the item exists.)
- [ ] **4.3** Press it twice quickly. Nothing breaks and nothing is delivered
      twice.
- [ ] **4.4** It is a gesture and never a timer: leave the tray alone for five
      minutes with nothing dropped, and the log shows no scan nobody asked for.

## 5. Pause is real now

M2's pause was a stop and a respawn. This is the item that says it is not any
more.

- [ ] **5.1** **Pause.** The icon greys and the menu item becomes Resume.
- [ ] **5.2** The sidecar is **still there** in Task Manager, same pid, and the
      run directory still has its `watch.lock`. At M2 both disappeared.
- [ ] **5.3** Drop a photo while paused. Nothing happens. Nothing is lost.
- [ ] **5.4** **Resume.** It goes, at once, without a full rescan first. On a
      big library note how quick this is compared to the M2 number in the M2
      list above.
- [ ] **5.5** A quota pause and a pause you asked for read differently in the
      menu. Trigger 3.4 again if you want to see them side by side: the quota
      one says when it comes back, yours does not.

## 6. Quit finally tells the truth

- [ ] **6.1** Drop a photo, and while it is still delivering choose
      **Quit Photo Pigeon**.
- [ ] **6.2** The first press says it is finishing. Wait: the icon disappears
      only when the engine is done, and the photo is in Google Photos.
- [ ] **6.3** Now do it again with a **big** photo, and press Quit a second
      time. The second line says something like **Leave, it finishes on its
      own**, and it is not a lie any more: the tray goes at once, and the photo
      still arrives.
- [ ] **6.4** Task Manager a minute later: no `photo-pigeon.exe`, and the
      `pigeon-core.exe` that was finishing has gone too, on its own.
- [ ] **6.5** `watch.lock` is gone from the run directory. A killed watch always
      leaves its lock behind, so its absence is the proof this was a drain.

## 7. The names a human reads

The rename is display-only. Machines still say photo-pigeon everywhere.

- [ ] **7.1** Start menu, Add or Remove Programs, the installer's own window and
      the uninstaller: **Photo Pigeon**.
- [ ] **7.2** Tray tooltip: the first line says Photo Pigeon.
- [ ] **7.3** Every menu line, every toast: Photo Pigeon, never photo-pigeon.
- [ ] **7.4** And the machine side is unchanged, which matters just as much:
      the exe is still `photo-pigeon.exe`, the state directory is still
      `~/.photo-pigeon`, and `npx photo-pigeon --help` still prints its own
      terminal name. A terminal product keeps its terminal name.

## 8. The rails held

- [ ] **8.1** `~/.photo-pigeon` was touched only by the two items that were
      supposed to touch it (1 and 2). Its `watch.log` has no lines from the
      throwaway sessions.
- [ ] **8.2** The Run key has exactly one photo-pigeon value in it, and it is
      the installed one. Nothing called `photo-pigeon-e2e-...` or
      `Photo Pigeon (dev)` was left behind:

          Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
            Select-Object -Property *

- [ ] **8.3** No terminal window appeared during any step above. As of M4 this
      is stronger than it was: there is no code path left that could open one.
      The tray's Setup item is a window and the wizard runs as a sidecar with
      `CREATE_NO_WINDOW`.
- [ ] **8.4** Nothing offered to delete anything. Upload only, forever.

## 9. Put the machine back

- [ ] **9.1** Quit the tray from its own menu.
- [ ] **9.2** Delete the run directory, which still holds a copy of your token:

          Remove-Item -Recurse -Force <the run directory>

- [ ] **9.3** Decide, deliberately, whether Start with Windows is on. Item 2
      left it wherever you last clicked.

---

## Notes from this pass

---

# M4 manual pass

Three scripts have already run before this list is opened, and none of them can
see the glass:

    pwsh -File app\e2e\rig-selftest.ps1
    pwsh -File app\e2e\run-m4.ps1 -Scenario setup,doctor
    pwsh -File app\e2e\run-m4.ps1 -Scenario all

Between them they prove that a temp environment with no config reaches a written
config with every ask answered from a script, that doctor comes back green
against it, that a photo becomes a ledger line, that the window opens and its
page runs, that closing it destroys it and leaves no webview behind, that killing
it mid flow leaves nothing half written, and that the handle count does not
climb. So none of that is here.

**What is here is everything with a human in it: the five screens, the words on
them, the folder picker, the two screenshots, and the one thing no rig will ever
be allowed to do, which is type a Google password.**

The M4 exit criterion is one sentence: **a machine with no config reaches a
first delivery, and the only text the user typed was their Google password.**
Item 1 is that sentence and nothing else may be ticked before it is.

    Date:
    Build:            (installer file name, or the exe and its timestamp)
    Windows theme:    light / dark
    Display scaling:  100% / 125% / 150%
    Result:           pass / pass with notes / fail

---

## 0. Before you start

**Item 1 is the real thing and everything else is a throwaway.** Item 1 needs a
Google account and a browser, so it is the only item that reaches Google at all.

For item 1 you need a machine with no config. Do NOT delete
`~/.photo-pigeon` to make one: use a throwaway config path, exactly as the rig
does, and check the tray really opened against it before typing anything.

    $env:PHOTO_PIGEON_CONFIG = "$env:TEMP\pigeon-m4\config.json"
    $env:PHOTO_PIGEON_SHELL_LOG = "$env:TEMP\pigeon-m4\shell.log"
    $env:PHOTO_PIGEON_AUTOSTART_NAME = 'photo-pigeon-e2e-manual'
    New-Item -ItemType Directory -Force "$env:TEMP\pigeon-m4\watch" | Out-Null
    & <the exe>

- [ ] **0.1** Nothing exists at that config path yet.
- [ ] **0.2** Any tray already running is quit, from its own menu, so there is
      only one Photo Pigeon on the machine.

## 1. First run, all the way through. This is the milestone.

- [ ] **1.1** The tray starts and the first-run window opens **by itself**. You
      did not have to find a menu item to get here.
- [ ] **1.2** No terminal window appeared, at any point, ever.
- [ ] **1.3** The five steps read in an order that makes sense to somebody who
      has never seen a Google Cloud console.
- [ ] **1.4** Each deep link button opens the right console page **in the system
      browser**, not inside the window.
- [ ] **1.5** The "Google hasn't verified this app" screenshot appears BEFORE
      you meet that screen, not after.
- [ ] **1.6** Drag the downloaded client JSON onto the window and it is
      accepted. Then try the Downloads intake: it notices the file on its own.
- [ ] **1.7** The folder picker is the **native Windows dialog**. Not a text box
      with a path in it.
- [ ] **1.8** The storage honesty screen says uploads count against your Google
      storage at full size, in the wizard's own words.
- [ ] **1.9** Sign-in opens the **system browser**. A consent page rendered
      inside the app window is an immediate fail of the whole milestone.
- [ ] **1.10** While consent is happening the window says it is waiting for you
      to finish in the browser, and nothing more.
- [ ] **1.11** Setup finishes. Drop a photo into the watched folder.
      **It arrives.** That is the exit criterion.
- [ ] **1.12** Exactly one toast: "First photo delivered." Drop a second photo:
      **no second toast.**

## 2. The words on the glass

The house style these check against is written down once, in `CONTRIBUTING.md`.

- [ ] **2.1** Every human surface reads **Photo Pigeon**, with the space. The
      window title, every heading, the tray tooltip, the menu.
- [ ] **2.2** **No em dashes anywhere.** Not in a heading, not in body text, not
      in a button, not in an error. Search the page source if you like: U+2014.
- [ ] **2.3** Sentence case, warm plain English. No "Configure", no "Initialize",
      no exclamation marks.
- [ ] **2.4** Nothing anywhere offers to delete, move or organise a photo.
      Upload only, forever.
- [ ] **2.5** Read it at 125% and at 150% scaling. Nothing is clipped and
      nothing needs a horizontal scrollbar.
- [ ] **2.6** Read it in the other Windows theme. Both are legible.

## 3. The window is a window

- [ ] **3.1** It can be moved, and it can be closed with the X.
- [ ] **3.2** Closing it does NOT quit the tray. The icon is still there.
- [ ] **3.3** Open it again from the tray menu. It comes back.
- [ ] **3.4** With the window closed, Task Manager shows **zero**
      `msedgewebview2.exe` processes under Photo Pigeon.
- [ ] **3.5** Close the window mid setup, before the config is written, then
      reopen it. It does not resume into a half-answered state that lies about
      what was already done.
- [ ] **3.6** Both windows open **centered on the display**, and on a
      multi-monitor desk that is the display the mouse is on rather than
      wherever the last one was. No test can see this: a window needs a screen.
- [ ] **3.7** The title bar says **Photo Pigeon: Status**, and it still says that
      after clicking through to the Health tab and back. The tab strip moves in
      place inside one window, so the title must not follow the page.
- [ ] **3.8** With **two or more watched folders**, the menu's **Open watched
      folder** opens the status window rather than picking one of them, and each
      folder opens from its own row there. With exactly one it opens that folder
      as it always did.

## 4. The health window

- [ ] **4.1** It opens from the menu and renders the doctor report a person can
      read: one line per check, worst first.
- [ ] **4.2** A check that is only a note does not look like a failure.
- [ ] **4.3** The `invalid_grant` advice is there, in full. It is the best
      paragraph in the package and it must survive the move to a window.
- [ ] **4.4** Clicking an auth-needed toast opens this window rather than the
      log.
- [ ] **4.5** The tray menu carries **Status and history...** under Open log and
      **Initial setup...** under Start with Windows, with no em dash in
      either, and each opens the window its label promises.
- [ ] **4.6** Toggle **Start with Windows** from inside the status window. The
      tray menu's tick follows on the next open and the registry value really
      moved. Put it back where you found it.

## 5. The rails held

- [ ] **5.1** `~/.photo-pigeon` was never written to during this pass. Its
      `config.json` and `setup.json` have their old timestamps.
- [ ] **5.2** The Run key has no value called `photo-pigeon-e2e-manual` left in
      it, and nothing new under any other name:

          Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
            Select-Object -Property *

- [ ] **5.3** No terminal window appeared during any step above.
- [ ] **5.4** Nothing was installed under the product name during this pass.

## 6. Put the machine back

- [ ] **6.1** Quit the throwaway tray from its own menu.
- [ ] **6.2** Delete the throwaway directory, which holds a real token:

          Remove-Item -Recurse -Force "$env:TEMP\pigeon-m4"

- [ ] **6.3** Remove the manual Run value if the shell left one:

          Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
            -Name 'photo-pigeon-e2e-manual' -ErrorAction SilentlyContinue

- [ ] **6.4** Start your own tray again.

---

## Notes from this M4 pass

---

# M5 manual pass

**M5 is the first pass whose work is mostly not code:** an installer met three
different ways, a wall a stranger has to get past, and a walk nothing publishes
without. The rest of M5 is rows 1 to 19 of the working plan in section 6 of
`docs/TRAY-DESIGN.md`, which say whose hands each row needs. This list is row 20.

There is one script at the top of it, and it deliberately runs somewhere else.
`app/e2e/sandbox/` walks the install matrix inside a **Windows Sandbox**: a silent
install on a machine that has never seen this product, the shape of what lands, a
silent uninstall that has to leave a hand-made ledger byte for byte intact, a
reinstall over the residue, and an install over a live install. **It proves that
half so a human does not have to walk it three times, and it proves nothing about
the stranger.** Item 0.5 runs it and item 1 is still the milestone.

**This list installs and uninstalls the real product on real machines.** No
script may run any of that: every install on a real machine below is done by
hand, deliberately, because a working machine carries a live copy of this product
and the ledger under `~/.photo-pigeon` is the durable record of everything it has
ever delivered. That directory is what the whole pass is protecting, and item 0.2
is the only baseline the later sections have to compare against.

**The one exception is item 0.5, and it is an exception about the venue and not
about the rule.** That rig installs nothing on any machine that will still exist
an hour later: it runs inside a Windows Sandbox, it refuses to start unless the
account is the sandbox's own and there is neither an install nor a state
directory present, and everything it wrote goes when the window closes.

The M5 exit criterion is one sentence: **a stranger can download an installer
from a GitHub Release, get past SmartScreen because the page told them how, and
back up a folder.** Item 1 is that sentence and nothing else may be ticked before
it is.

    Date:
    Build:            (installer file name, byte size, and its timestamp)
    Tag / version:    (the tag, and what the file name says)
    Fresh machine:    (which machine or VM, and what it had never seen)
    Sandbox rig:      (transcript file name, and its summary line)
    Windows theme:    light / dark
    Result:           pass / pass with notes / fail

---

## 0. Before you start

- [ ] **0.1** Read this item before installing anything. Section 1 installs on a
      machine that has never had this product, and **sections 2 and 3 install and
      uninstall under the product name on the machine that carries the live
      copy.** That is allowed here and nowhere else in this repository, it is why
      no script does it, and it is the reason the next item exists.
- [ ] **0.2** Take the baseline of the thing being protected, and keep the file:

          Get-ChildItem "$HOME\.photo-pigeon" -Recurse -Force |
            Select-Object FullName, Length, LastWriteTimeUtc |
            Format-Table -AutoSize |
            Out-File "$env:TEMP\pigeon-m5-baseline.txt"
          (Get-Content "$HOME\.photo-pigeon\ledger.jsonl").Count
          Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
            Select-Object -ExpandProperty 'Photo Pigeon'

      Note the ledger's line count here: ______ lines. Every later section
      compares against this file, and "I think it looked the same" is not a
      comparison.
- [ ] **0.3** Quit the live tray **from its own menu**, and wait for the icon to
      go. Not from Task Manager: a killed watch leaves its lock behind and you
      would spend the rest of the pass chasing it.
- [ ] **0.4** Note the installer you are testing by name, byte size and
      timestamp. If there is more than one file in the bundle directory, stop and
      do section 4 first. Two near-identical installers side by side is how the
      wrong one ships. `make-wsb.ps1` in the next item refuses to run at all
      while there is more than one, so this item and that refusal are the same
      guard from two directions.
- [ ] **0.5 Run the sandbox rig, and read its transcript before you install
      anything by hand.** It is free, it runs unattended, and it walks the whole
      install matrix on a machine that can afford to be wrong. Everything it
      catches is something you would otherwise find halfway through section 2
      with a real ledger on the machine.

          pwsh -File app\e2e\sandbox\make-wsb.ps1

      Then double-click the `photo-pigeon.wsb` it wrote. Windows Sandbox needs the
      `Containers-DisposableClientVM` feature and a reboot, and the generator says
      so if it is off. **Windows ships that feature disabled**, so expect that
      step the first time.
- [ ] **0.6** Read the transcript **on the host**, out of the folder the
      generator named (by default `%TEMP%\photo-pigeon-sandbox`). Two files per
      run, a `.txt` and a `.json`. Write the summary line into the header above.
      **A FAIL in there stops this pass**: it is the same installer you are about
      to run by hand.
- [ ] **0.7** Know what the rig did **not** prove, because the next four sections
      are written on the assumption that you do. It never signed in to Google, so
      nothing was delivered and no toast was raised. It never met SmartScreen,
      because a file that arrived through a mapped folder carries no mark of the
      web. It never answered yes to the uninstaller's application-data question,
      which has no command line switch, so item 3.4 is still yours. And it cannot
      construct a dead core, so section 5 is still an eye.

## 1. The walk a stranger takes. This is the milestone.

**This needs a machine that has never seen this product**, which is a second
machine or a clean VM. Your own machine cannot be one and cannot be made into
one: it holds an install, a Run value, a real `~/.photo-pigeon` and an installer
Windows has already watched run, so it cannot show the wall and cannot prove a
first run. A throwaway config on your own machine is the weaker test the other
passes use, and it does not test any of the four things below.

- [ ] **1.1** Download the installer **from the GitHub Release page**, in a
      browser, as a stranger would. Not from a build directory and not over a
      network share.
- [ ] **1.2** The Release page told you about the wall **before** you met it: the
      two words are in order, **More info** then **Run anyway**, above the
      download link, with the drawing of the box beside them if it rendered.
- [ ] **1.3** The wall appears and looks like the screenshot. It says **Unknown
      publisher**. Getting past it took exactly the two clicks the page named,
      and nothing else. **If the wall does not appear, this machine is not fresh
      and item 1 has not been walked.**
- [ ] **1.4** ~~Capture the wall while it is on screen.~~ **Superseded: the front
      door draws the wall rather than photographing it, so nothing is waiting on
      this picture.** Take it for yourself if you want it, but item 1.3 is the
      proof and this is not.
- [ ] **1.5** The install asks for no elevation, no admin password, no UAC
      prompt. It lands in `%LOCALAPPDATA%\Photo Pigeon`.
- [ ] **1.6** Start Menu says **Photo Pigeon**. Nothing was left on the Desktop.
- [ ] **1.7** Launch it. There is no config on this machine, so the setup window
      opens **by itself** and no terminal window appears at any point.
- [ ] **1.8** Walk the whole setup as a stranger, with your own Google account,
      typing nothing but your Google password. Follow only what the window says.
- [ ] **1.9** Drop a photo into the folder you chose. **It arrives in Google
      Photos.** That is the exit criterion.
- [ ] **1.10** Exactly one toast, the first-delivery one. Drop a second photo:
      no second toast. This is a virgin ledger, so it is the only machine where
      that toast can honestly be tested.
- [ ] **1.11** Note anything you had to work out for yourself. A stranger has
      nobody to ask, and this is the last time anybody on this project will see
      these screens without knowing what they do.

## 2. The rest of the install matrix

Back on your own machine, with the baseline from 0.2 in hand and the live tray
quit from its own menu.

**The sandbox rig has already walked the shape of every row in this section**, so
what is left here is the half it cannot have: a real config, a real token and a
real ledger. Read these rows as "and it still behaves against the live copy",
not as "and now find out whether it does".

**Install over install is the one row with a history.** Exercised twice by hand
before this list existed, in the M3 and M4 passes, and it behaved both times: one
entry, one directory, the Run value intact. Record the third walk below rather
than treating it as the first.

- [ ] **2.1 Install over install.** Run the same installer over the existing
      install. It replaces it: one entry in Add or Remove Programs, one install
      directory, one Start Menu shortcut, no second copy under any name. Third
      time this has been done by hand, and the sandbox rig's section 9 does it
      with the tray deliberately left running.
- [ ] **2.2** The Run value is still there, still quoted, still ending in
      `--autostart`, and still pointing at a file that exists. An update that
      strands the Run value is a tool that silently stops starting.
- [ ] **2.3** Launch it. It finds the existing config, watches the folders it was
      already watching, and does not offer to set anything up. `~/.photo-pigeon`
      matches the baseline: same files, same sizes, same mtimes, except
      `watch.lock`, which moves because a live watch heartbeats it.
- [ ] **2.4** Drop a photo. It delivers, and the ledger has **one** new line
      rather than a re-upload of anything already in it. Line count now:
      ______, against ______ at 0.2.
- [ ] **2.5 Uninstall, then reinstall.** Uninstall from Add or Remove Programs,
      then install the same file again. Section 3 is the uninstall half in
      detail; this row is only about what comes back: the tray starts, finds the
      same config, and delivers without asking for anything.
- [ ] **2.6** Nothing in 2.5 asked you to sign in again. The token lives in
      `~/.photo-pigeon` and no installer may reach it.

## 3. The uninstaller and the record it may not touch

The law is in section 5 of `docs/TRAY-DESIGN.md` and it holds by construction:
the uninstaller's deletions are confined to the install directory, the shortcuts,
the uninstall registry keys, the Run value, and
`%APPDATA%`/`%LOCALAPPDATA%\io.github.justerlex.photopigeon`. `~/.photo-pigeon`
is in none of those. **These rows are the guard on that, not the fix.**

The sandbox rig asserts the same law on a state directory it makes itself: a
marker carrying a GUID that has never existed before, and a ledger, both compared
by sha256 and last write time across a silent uninstall. What it cannot do is
tick the checkbox, because that checkbox has no command line switch. So 3.1 to
3.3 are a second sighting of something already proved, and **3.4 is the row
nothing but a hand can cover.**

- [ ] **3.1** Uninstall. The uninstaller's own window says **Photo Pigeon**.
- [ ] **3.2** `~/.photo-pigeon` is untouched, compared against the baseline file
      from 0.2 rather than remembered. Same files, same byte sizes, same
      mtimes. The ledger has the same line count as 2.4 left it.
- [ ] **3.3** The install directory `%LOCALAPPDATA%\Photo Pigeon` is gone, the
      Start Menu entry is gone, the Add or Remove Programs entry is gone, and
      the `Photo Pigeon` Run value is gone.
- [ ] **3.4 Now ask it to delete your data, on purpose.** Install again,
      uninstall again, and this time answer **yes** to the application-data
      question rather than declining it. `%LOCALAPPDATA%\io.github.justerlex.photopigeon`
      goes, which is the shell's own log directory, and **`~/.photo-pigeon` is
      still there with the same ledger line count.** This is the row that proves
      the law rather than assuming the user will be careful: a person who ticks
      the box has asked for what the box named and nothing more.
- [ ] **3.5** If this build ever grows a "also delete my delivery record"
      checkbox of its own, it is off by default, it says what it costs in words
      next to it, and it is the only thing in this project allowed to reach that
      directory. Say here which of those was true.

## 4. Two installers in a directory is how the wrong one ships

- [ ] **4.1** List what is actually in the bundle directory:

          Get-ChildItem app\src-tauri\target\release\bundle\nsis\*.exe |
            Select-Object Name, Length, LastWriteTime

- [ ] **4.2** There is **exactly one** file and it is the build you just made,
      by timestamp and by byte size. Delete anything that is not this build. A
      pre-rename `photo-pigeon_0.1.0_x64-setup.exe` really did sit here beside
      the current one, which is where this row came from, and
      `app\e2e\sandbox\make-wsb.ps1` now refuses to generate a sandbox
      configuration while there is more than one file, so the sandbox rig cannot
      quietly test the wrong installer.
- [ ] **4.3** The version in the file name matches the tag and matches
      `package.json`. Three things can disagree here and CI fails the tag when
      they do, so a disagreement found by eye means the check did not run.
- [ ] **4.4** The file attached to the Release is that same file, by byte size.
      Not one with the same name.

## 5. The two icon states nobody has looked at yet

Round 3 added a fifth tray icon and put a ring on the paused one, and neither has
been seen by a person on an installed build. **No rig on this project can look at
a tray icon**, and the red one cannot even be constructed by one: it means "nothing
will deliver until you act", and the only honest way to see it is a core that
genuinely will not start.

Run these against the **installed** build pointed at a throwaway config, exactly
as the M3 toast rows do. Never against `~/.photo-pigeon`.

- [ ] **5.1 Paused wears the ring.** Pause from the menu and look at the icon
      **in the taskbar at 16 px**, not blown up in the overflow flyout. It reads
      as a state: a hollow ring over a greyed bird, which is the badge silhouette
      with the middle out. The greying alone did not read as anything, and that is
      why the ring was added.
- [ ] **5.2** The same at 125% and at 150% scaling, and against **both** a light
      and a dark taskbar. A ring that closes up into a blob at one of those is a
      finding.
- [ ] **5.3** Resume clears it, and the icon goes back to the idle bird with no
      ring and no badge. A state with no clearing condition is the law this fifth
      icon had to pay for.
- [ ] **5.4 The red badge, if you can make one.** It is heavier than the amber it
      has to be told apart from, and it means the tool has stopped rather than
      paused. The cheapest honest trigger is a throwaway config whose
      `credentialsPath` names a file that is not there: the core starts, says it
      needs a sign in, fails and stops, and the shell does not respawn it, because
      a sign in cannot be given from a tray menu. The icon is red, the menu says
      what happened, and the action item says **Try again**.
- [ ] **5.5** Red and amber are told apart at a glance, side by side if you can
      arrange it: amber is held and comes back by itself, which is what today's
      Google limit is, and red is broken until you act. If they read as the same
      dot, that is a finding and it outranks the rest of this section.
- [ ] **5.6** If you could not construct the red state, say so here rather than
      ticking 5.4. It has unit tests and no sighting, and an unsighted state is
      worth knowing about at a launch.

## 6. The rails held

- [ ] **6.1** `~/.photo-pigeon` matches the 0.2 baseline, one last time, at the
      end of everything. This is the only rail that matters in this pass and it
      is worth reading twice.
- [ ] **6.2** The Run key holds one Photo Pigeon value and nothing from an
      earlier pass:

          Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' |
            Select-Object -Property *

- [ ] **6.3** Nothing anywhere offered to delete, move or organise a photo.
      Upload only, forever, including in the installer and the uninstaller.
- [ ] **6.4** No terminal window appeared during any step above, on either
      machine.
- [ ] **6.5** The fresh machine from section 1 still has the token you signed in
      with. Decide what happens to it: uninstall and delete its
      `~/.photo-pigeon`, or keep the machine as the place first runs get tested.
      Either is fine, an undecided one is not.
- [ ] **6.6** The sandbox is closed, and with it the install, the marker and the
      hand-made ledger the rig wrote. Nothing in a sandbox outlives its window,
      which is the whole reason that venue is allowed to install anything.

## 7. Put the machine back

- [ ] **7.1** Install the build you intend to live with, and launch it once.
- [ ] **7.2** Start with Windows is where you want it, deliberately, and the Run
      value reads back correctly.
- [ ] **7.3** The tray is running, watching the folders it was watching before
      this pass started, and the ledger's line count is the one section 2 left.
- [ ] **7.4** Delete the baseline file if the pass passed, and keep it with the
      notes if it did not:

          Remove-Item "$env:TEMP\pigeon-m5-baseline.txt"

---

## Notes from this M5 pass

