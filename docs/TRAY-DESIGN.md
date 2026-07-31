# Photo Pigeon tray shell: the design of record

The desktop shell that wraps the shipped CLI core, so a person who never opens a terminal can back up a folder to Google Photos.

This document says what was decided, why, what was measured, and what the shell may never do. Where it and the code disagree, **the code wins and this document is the bug.** Anything here that tells the shell what to send or what to expect is a promise about `src/commands/watch.ts`, and the union in `WatchEventBody` is the authority on every event shape quoted below.

Three things live elsewhere on purpose. The copy conventions that apply to every string in the product (no em dashes, sentence case inside a window, the storage sentence word for word) are collected in `CONTRIBUTING.md`. The publish-day order is `docs/RELEASE.md`. The setup channel's own contract is `docs/ASK-PROTOCOL.md`.

Section numbers are part of the interface. Code comments and tests cite section 0's laws, section 2's notes, section 4's failure modes and section 8's decisions by number, so the numbering does not move.

---

## 0. What the tray inherits

The tray is a shell. The engine already exists and is tested. The shell may not fork the engine's judgement on any of these:

| Law | What it means for the tray |
|---|---|
| Upload only, forever | No menu item, no button, no IPC command may reach a delete or a mutate. There is none to reach: the scope is `photoslibrary.appendonly`. |
| Event driven watching | The tray never adds a rescan timer of its own. "Deliver now" is a user gesture, not a schedule. |
| BYO client, zero shipped credentials | The installer ships no client id and no secret. The first-run window walks the user through making their own, exactly as the terminal wizard does. |
| batchCreate serial, 50 max, fresh tokens, 30s floor | Lives entirely in the core. The tray never talks to Google. |
| Storage honesty | The sentence about original quality and storage cost appears in the first-run window, in the status window, and in the tray tooltip's expanded status. Not buried in an About box. |
| Content-hash ledger is the durable record | The tray never writes to the ledger. Only the core process does. The uninstaller never deletes it. |
| No em dashes, warm plain English | Applies to menu labels, toasts and window copy. `CONTRIBUTING.md` carries the full copy law and the tests that hold it. |

One more, added by the shell: **the webview never touches `~/.photo-pigeon`.** Config reads and writes go through the Rust side, which goes through the core. A web page in this app has no file system.

Under Tauri this is a build setting rather than a convention. Capabilities are allowlists: a permission that is not granted does not exist at runtime. The strongest form of the rule is therefore *not adding the plugin to `Cargo.toml` at all*, and the second strongest is granting it nothing. `tauri-plugin-shell` is not compiled in: the core is spawned with `std::process::Command`, so there is no `shell:allow-execute` to scope and no webview path to a spawn of any kind. `tauri-plugin-fs` *is* compiled in transitively under `tauri-plugin-dialog`, so for that one the guarantee is the ungranted permission: `capabilities/default.json` grants no `fs:` permission to any window, and an ungranted plugin command is unreachable from a page.

The plugins this app gets are `notification`, `dialog`, `opener`, `single-instance`, `process` and `updater`. Autostart is driven directly rather than through a plugin, for the reason in section 4. Every privileged action runs in Rust off a tray click or off one of the fourteen IPC commands, so the plugins are used from the Rust side and exposed to no webview.

### The name the user reads, and the names the machine keeps

This is a law rather than a style preference, because half of these strings are load-bearing identifiers and changing one by accident strands an installed copy.

**Humans read "Photo Pigeon".** Two words, both capitalised, everywhere copy is human facing: `productName`, the NSIS installer's display name and its Add/Remove Programs entry, the Start Menu shortcut, the tray tooltip header, every toast title, every menu string, every window title.

**Machine identifiers are frozen and stay `photo-pigeon`.** These are the ones a rename would break, and none of them is ever read by a person who is not debugging:

| Identifier | Frozen value | What breaks if it moves |
|---|---|---|
| npm package name | `photo-pigeon` | the published package, every `npx photo-pigeon` in the wild, the README |
| `mainBinaryName` | `photo-pigeon.exe` | Task Manager, the Run key data, the NSIS `CheckIfAppIsRunning` macro, every path in `sidecar-layout.json`'s resolution notes |
| bundle `identifier` | `io.github.justerlex.photopigeon` | the AppUserModelID, so **every toast loses its name and icon**, and `app_log_dir()`, so the shell log moves |
| state directory | `~/.photo-pigeon` | the ledger, which is the durable record. Untouchable, forever |
| sidecar name | `pigeon-core.exe` | `sidecar-layout.json` and the three readers that agree through it |
| the CLI banner | `photo-pigeon 0.1.0` | nothing, and it stays because a terminal product may keep its terminal name |

**`productName` is the one display string with a blast radius.** The generated NSIS script uses it for the install directory (`StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"`), for the uninstall registry key and for the manufacturer product key, and it is what `package_info().name` returns in Rust, which is the Run value's **name**. So `productName: "Photo Pigeon"` means all of these at once:

1. The install directory is `%LOCALAPPDATA%\Photo Pigeon`, **which contains a space on every machine**. Quoting the Run value is unconditionally load bearing, not prudent. See section 4 and the M3 blocker note in section 6.
2. An install under a different `productName` is **not upgraded**, because the uninstall key it would be found by is keyed on the old name. It is orphaned in place with its own Add/Remove entry. Uninstall by hand before installing a renamed build.
3. The Run value's name is `Photo Pigeon`. A value written under an older name would keep launching an exe in a directory the new installer never touches, so the first Run value must be written after a rename and never before.
4. `app_log_dir()` and the uninstaller's opt-in data deletion are keyed on the bundle identifier, not on `productName`, so the shell log stays at `%LOCALAPPDATA%\io.github.justerlex.photopigeon\logs\tray.log` and the uninstaller's reach is unchanged.

There is no separate display-name key to reach for: the live NSIS schema has no `displayName`. `productName` is the only lever, and a custom NSIS template to hold the install directory still is not worth owning.

### Casing, and it is two tiers

The naming law above says which letters the product's name is spelled with. This one says where Title Case is allowed at all, and it has two tiers because a window has an outside and an inside.

| Tier | Rule | Examples |
|---|---|---|
| A window's own title | **Branded Title Case.** The product names itself, then a colon, then what the window is. | "Photo Pigeon: Status", "Photo Pigeon: Setup" |
| Everything inside a window | **Sentence case.** Tabs, buttons, section headings, labels, body prose, error text. | "Watching", "Deliver now", "Start with Windows", "Pick a folder" |

The reason is not consistency for its own sake. **A title bar is the product introducing itself in a taskbar full of other products, and the inside of a window is one person being spoken to.** Title Case on a button reads as a brochure written by a committee, and sentence case is what warm plain English looks like when it is set in type.

The main window is plain **"Photo Pigeon: Status"** in all three places that can disagree: `Page::title` in `app/src-tauri/src/windows.rs`, and the `<title>` tags of `app/ui/status.html` and `app/ui/health.html`. One test covers all three, because three copies of one name is exactly how a name drifts. Health is a tab inside the status window and not a window of its own, so it does not get a title of its own either.

Two things the casing law does not touch. **The tray menu is not a window**, and its labels are sentence case with the brand spelled in full where the product names itself ("Deliver now", "Open log", "Quit Photo Pigeon"). And **window labels are machine identifiers**, not titles: `setup` and `status` in `windows.rs` are how a second click finds the first window, they are in the frozen tier of the naming law, and no casing rule applies to them.

---

## 1. Shell technology

**Tauri 2, tray-first. No window exists at idle.**

The tray icon is core in Tauri v2, not a plugin: `tauri::tray::TrayIconBuilder`, behind the `tray-icon` cargo feature. The app declares zero windows in `tauri.conf.json` (`app.windows: []`) and creates a `WebviewWindow` only when the user asks for setup or status, then destroys it on close rather than hiding it. `RunEvent::ExitRequested` calls `api.prevent_exit()` so closing the last window does not quit the app.

That structure is what the memory budget rests on: at idle there is no WebView2 process in the tree at all, and the falsifiable version of the claim is "Task Manager shows zero `msedgewebview2.exe` children while the pigeon is watching".

### Why not Electron

**Electron is out, and resident memory is the reason.** Resident memory is a design constraint on this project, not a tuning parameter to be traded against developer convenience. The comparison the decision turned on is kept because it is the honest record of what the trade actually was:

| | Electron | Tauri 2 | Headless node + tray helper |
|---|---|---|---|
| Language of the shell | TypeScript, same as the core | Rust for the shell, TS for the web view | TypeScript |
| Can it run the core as is | Yes, Electron embeds Node | No. Needs a Node sidecar | Yes, it is a Node process |
| Tray, menu, toast, login item | Built in | Built in via plugins | Tray via a third party helper binary, toasts via `node-notifier`, login item by hand |
| Windows installer | `electron-builder` NSIS, mature | `tauri-bundler` NSIS or MSI, also good | Nothing. Write NSIS or Inno Setup by hand |
| Installer size | roughly 90 to 130 MB | small on its own, plus whatever the Node sidecar weighs | roughly 40 to 60 MB if Node is bundled |
| Resident memory | 150 to 250 MB is the usual quoted range | small shell, plus a full Node process for the sidecar | one Node process, plus a few MB for the helper |
| Toolchains to keep alive | one | two (Rust and Node), two lockfiles, two signing stories | one, plus a prebuilt helper binary nobody here wrote |
| Design surface | a real web page, full CSS | a real web page, but every native call crosses into Rust | none. Native menus only |

The argument for Electron was that the core is Node-native all the way down, so Tauri relocates the work into a sidecar that is still Node and the memory win mostly evaporates. Three things are wrong with it, and they are worth keeping because they are why the decision is coherent rather than a preference:

**It compared totals when the constraint is the resident floor.** A background uploader is idle almost all of the time it exists. The number that matters is what sits in RAM on a machine that is doing something else, forever, and the shell is the part that is always resident. The two processes are budgeted separately: the shell has a hard floor to defend, the engine is charged for the work it is actually doing and can be stopped.

**The "memory win evaporates" claim is false at idle and true under load.** Under load the sidecar dominates either way. At idle they do not converge at all: a Tauri app with zero windows has no webview process, because WebView2 is only spawned when a window is created. That is the whole game for a tray app.

**The installer-size row was optimistic and stays optimistic.** A small Tauri shell was the number being quoted, and this app must also ship a Node runtime: `node.exe` at the pinned version is 81.3 MB on disk. The honest expectation is tens of MB compressed by NSIS, not single digits. Still well under Electron, and section 6 has the measured figure.

The tray, notification and autostart stories held up. The design surface argument was the strongest thing Electron had, and it survives: Tauri windows are still real web pages with full CSS. What crosses into Rust is native calls, and this app makes very few of them.

### The RAM budget

| Process | State | Target | Reopen the decision at | Measured |
|---|---|---|---|---|
| Tray shell | idle, watching, no window ever opened | **15 MB** | **25 MB** | 2.06 MB private working set at M3 |
| Tray shell | window open | note it, no budget | n/a | 3.53 MB private working set, plus 6 webview processes at 88.70 MB of their own |
| Tray shell | window opened then destroyed | returns to the idle figure | a permanent step up means the window is being hidden, not destroyed | 3.65 MB private working set, zero webview processes |
| Core sidecar (Node) | watching, queue empty | 40 to 80 MB | 120 MB | 41.18 MB working set at M3 |
| Core sidecar (Node) | hashing a 20 GB file | flat, the hash is streamed | any growth with file size is a leak, and a regression against a shipped guarantee | not yet measured under a large file |

**The shell's Target and Reopen figures are private working set.** The two budgets are separate on purpose: the engine is allowed to cost what the work costs, because a user can see it in Task Manager doing something and because it can be stopped. The shell is not allowed to cost anything, because it is the part that is always there.

#### Which number the budget is about

**Working set is the wrong number to hold a tray app to, and the correction is worth understanding before reading any table in this document.**

Working set counts private pages *and* shared, file-backed pages: the machine code of every DLL the process has touched. A tray app that a person actually uses opens its menu and clicks Open log, and Windows maps in the shell UI and launcher stack to serve that, plus whatever Explorer extensions the user has installed. Those pages are code, shared with every other process on the machine, backed by files rather than by the page file, and Windows does not trim them while there is no memory pressure. **They are not the shell's demand and no amount of work on the shell can remove them.**

The same binary, in two conditions:

| | modules mapped | working set | of which shared | **private working set** | private bytes |
|---|---|---|---|---|---|
| fresh launch, never clicked, live sidecar | 30 | 10.61 MB | 8.93 MB | **1.67 MB** | 2.26 MB |
| an installed copy, 10.3 hours up, menu used | 84 | 32.04 MB | 28.19 MB | **3.85 MB** | 5.16 MB |

So the honest statement is two sentences and not one. **Against private working set, the shell costs 1.7 MB fresh and 3.9 MB after a day of real use, against a 15 MB target.** Against total working set, a used shell reads 32 MB, which is past the figure named as the trigger to abandon Tauri, and 28 of those 32 megabytes are Windows' code that would be resident whether this app existed or not.

- **The budget is private working set: 15 MB target, 25 MB reopens the decision.** Worst observed: 3.85 MB.
- **Total working set stays in the tables as an observation, never as a trigger.** It is the number a user reads off Task Manager's default column, so it is worth knowing and worth being able to explain, and it is not a number this app controls.

Both numbers travel side by side in every table here. One of them is what this project is answerable for and the other is what a user will read back to us. Neither is buried, and only the first one moves anything.

#### The fallback, and its exact trigger

If the tray shell idles above **25 MB** of private working set, fall back to the third column of the comparison table: **a tiny native tray helper** driving the headless Node core. Not to Electron, which is not on the table under any measurement.

That fallback is worse in the ways the table already names (no installer story, an unsigned third-party helper exe, awkward menu updates over stdio, nowhere to draw a first run), so it is a genuine loss and not a free option. It is on the table anyway, because the memory constraint outranks the design surface. The trigger is a number, so the decision does not turn on anyone's judgement in the moment.

The trigger has not been reached at any milestone. It stays written down because the measurement is repeated whenever the shell grows a process or a surface.

#### Concrete rules that keep the weight down

- **Menu-first, no window at idle.** Windows are created on demand and destroyed on close, never hidden. This is load-bearing for the RAM budget, not tidiness.
- **The `identifier` in `tauri.conf.json` becomes the AppUserModelID**, and Windows toasts silently do nothing without it. Two consequences: the value must be set before the notification plugin is used, and **toasts will not appear at all in `tauri dev` on Windows until the app has been installed once**, because it is the Start Menu shortcut created by the installer that registers the AUMID.
- **Pin the Tauri major and minor.** Treat a Tauri upgrade as a release of its own, with a smoke test.
- **Two toolchains, honestly.** Rust plus Node, two lockfiles (`Cargo.lock` and `app/package-lock.json`), and a `rust-toolchain.toml` pinning the stable MSVC toolchain so CI and a developer machine cannot drift.
- **Re-measure whenever the shell grows a process or a surface**, and write the numbers into section 6.

#### Toolchain prerequisites

| Component | Why it is needed | Note |
|---|---|---|
| `rustup` / `cargo` / `rustc`, stable MSVC | the shell | `winget install Rustlang.Rustup` **fails**, exit 16, "No applicable installer found": the manifest carries no user-scope installer. Download `rustup-init.exe` and run it directly. With `--no-modify-path` the user PATH needs fixing by hand afterwards. |
| VS BuildTools 2022, C++ workload | the linker | Verify with `vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64`. A hello-world crate that compiles and runs is the real check. |
| WebView2 runtime | every window | Guaranteed only on Windows 11, so ship the bootstrapper in the installer through `bundle.windows.webviewInstallMode`. |
| node / npm | the core, and the bundled sidecar runtime | Pin the exact version: this is the Node that gets shipped. |

**The runtime dependency tree has zero native modules.** Every production package is pure JavaScript, no `.node` binaries and no `binding.gyp`; `chokidar` 4 dropped `fsevents`. The only `.node` files anywhere are dev-only, inside `vitest`'s own toolchain. That is what makes the single-file esbuild bundle in section 5 possible at all.

---

## 2. Process architecture

**The core runs as a child process of the shell, using the CLI's own code path. One pipeline in this repo, forever.**

The in-process alternative is gone twice over: by the decision, and by physics, since the shell is a Rust process and there is no way to embed the Node core in it without rewriting the core in Rust. The reasoning still explains why the child-process shape is right, which matters when someone is tempted to shortcut it later.

**In-process** would have been cheaper by one process and needed no protocol. Against it: the main process is the UI thread, and a reconcile pass over a large library streams every file through sha256 on the same event loop that serves the tray menu, so the menu can stall. A crash in the pipeline takes the tray with it, and a background uploader should outlive its own UI bugs. And `runWatch` owns `SIGINT` and `SIGTERM` itself, with no other way to be stopped.

**Child process** means the tray spawns the shipped CLI and reads structured events from it. The tray runs literally the same code path as `photo-pigeon watch`, which is the strongest argument by far. Crash isolation goes both ways. The pipeline's memory is separate and legible in Task Manager, which matters when a user asks why a photo app is using 400 MB, and it is what makes the two-budget table in section 1 measurable rather than notional. It costs one process and one protocol.

### The mechanism: a sidecar over NDJSON

The core is declared in `tauri.conf.json` under `bundle.externalBin`. **`app/src-tauri/src/supervisor.rs` owns the child directly through `std::process::Command` and does its own line framing in `events.rs`.** The shell plugin is not compiled in, and the reason is correctness before security: `tauri-utils`' `read_line` **treats a lone `\r` as a line ending as well as `\n`.** NDJSON frames on `\n` only. A JSON event whose payload carries a carriage return, and a Windows path or a Google error string is exactly where one would come from, would be split into two fragments, and both halves would then fail to parse. That is a corrupted event stream on a rare input, which is the worst kind of bug to ship in a background tool: invisible until it is not.

Three notes this design was built on, all of them checked and all of them closed:

1. **Stdout arrives as bytes, not strings.** Decode with `String::from_utf8_lossy`, and never assume a line is valid UTF-8 just because a filename usually is. `events.rs` decodes exactly that way, on a plain `Read` rather than on a plugin event.
2. **Line splitting is the shell's own.** `LineAssembler` splits on `\n` and nothing else, and `assembler_carries_sixty_four_kilobytes_whole` holds a 64 KB line intact. The ceiling is `MAX_LINE_BYTES`, one megabyte, and a longer line is dropped loudly rather than buffered forever. This is the note that decided the framing question above.
3. **Orphan risk.** A sidecar must not outlive its parent by accident. It does not: the shell holds the only write handle on the child's stdin, so the shell dying is an EOF, and EOF is a stop. Proved twice: by the E2E rig, which stops the shell only and then asserts the core drained and released its lock by itself, and by an aborted run that left the core parentless and it still exited cleanly. The one qualification is `detach`, below: EOF is a stop for a shell that leaves without having asked for anything, and deliberately not a stop for a shell that said `detach` first.

There is a second benefit of owning the spawn that was not the reason: with no `tauri-plugin-shell` there is no `shell:allow-execute` permission to scope, and therefore no path from a webview to a spawn at all. Section 0's law gets its strongest available form for free.

Commands travel back on the child's stdin as bare lines: `stdin.write_all(b"stop\n")`. Not a JSON envelope. The core's parser is eight lines long and it is the contract.

**Send `stop` and then leave stdin open.** Writing the line and tidily closing the handle makes the core read *two* stop requests, the line and then the EOF: measured as `stopping reason=stdin`, then `stopping reason=impatient`, exit 130, and the drain cut short. That is an abandoned half batch arrived at by being tidy. The process test asserts exit code 0 and exactly one `stopping` event as the guard on it. **The one exception is `detach`: after it, closing stdin is correct and required**, because a detached core has been told the pipe is about to die and that the death means nothing.

```
Tauri shell (Rust)                  sidecar (Node)
  tray icon + menu        <--->      photo-pigeon watch --events ndjson
  windows, created on demand           chokidar, hash, upload, batchCreate, ledger
  autostart toggle                     holds the single-instance lock
  updater                              writes the log file
```

### Why the stop path uses no signals

`runWatch` accepts a stop handle that does what the `SIGINT` path does: close intake, close the watcher, drain, resolve. The signal handlers stay for terminal users and call the same function. That handle is not optional, because **on Windows a signal sent from another process is not a catchable signal.** Node maps it to `TerminateProcess`, so the handler never runs and a batch in flight is lost. Measured, parent Node process, a fresh child per case, the child holding handlers for `SIGTERM`, `SIGINT`, `SIGHUP` and `SIGBREAK`, on win32 10.0.22621 and node v22.18.0:

| Channel | Handler ran in the child? | What the parent was told |
|---|---|---|
| `child.kill('SIGTERM')` | **no** | exit signal `SIGTERM` |
| `child.kill('SIGINT')` | **no** | exit signal `SIGINT` |
| `child.kill('SIGBREAK')` | **no** | exit signal `SIGKILL` |
| `child.kill('SIGHUP')` | **no** | exit signal `SIGKILL` |
| `child.kill()` | **no** | exit signal `SIGTERM` |
| `process.kill(pid, 'SIGTERM')` | **no** | exit code 1, no signal at all |
| write `stop\n` to stdin | **yes** | the child chose its own exit code |
| `stdin.end()`, so EOF | **yes** | the child chose its own exit code |
| IPC `send('stop')` | **yes** | the child chose its own exit code |

**There is no signal delivery to another process on Windows.** Every kill is `TerminateProcess` wearing a signal's name, and the name libuv hands back to the parent is fiction: the child never saw it, ran no handler and drained nothing. Note rows three and four especially, where the parent is told `SIGKILL` for a signal it did not send. Confirmed against the built CLI rather than a toy: hard-killing a live `watch` produced no `stopping` event, no `stopped` event, and left the lock file behind.

Three things follow, and all three are in the core:

- **Stdin is the stop path, and EOF means the same thing.** One line, `stop`. EOF covers the case the tray cannot otherwise handle, its own death. Measured stop-to-exit on an idle watch: **9 to 10 ms**.
- **Anything that must survive a hard stop has to be on disk when it is written.** That is why the log file appends synchronously.
- **Stale lock detection is load-bearing, not defensive.** A killed watch always leaves its lock behind, so "the holder is dead" is the normal case. `process.kill(pid, 0)` answers `ESRCH` for an exited pid and `EPERM` for a live pid owned by somebody else, which makes it a usable liveness probe.

So the stop path is: **write `stop\n` to stdin, wait for `{"type":"stopped"}`, then wait for the child to exit.** `kill()` is the timeout branch after a generous drain window, not the mechanism.

### The event stream

`--events ndjson` is the entire integration surface. Everything else the tray does, it does by reading lines. The envelope key is `type`, never `t`, and every event carries the ISO moment it happened as `at`. The lines below are copied out of real runs rather than composed:

```
{"type":"started","pid":81992,"version":"0.1.0","watchDirs":["D:\\Photos"],"album":"Camera","dryRun":false,"once":false,"ledgerPath":"...\\.photo-pigeon\\ledger.jsonl","lockPath":"...\\.photo-pigeon\\watch.lock","logPath":"...\\.photo-pigeon\\watch.log","at":"2026-07-28T18:58:13.730Z"}
{"type":"scanning","dirs":["D:\\Photos"],"at":"2026-07-28T18:58:13.741Z"}
{"type":"delivering","found":12,"reason":"scan","at":"2026-07-28T18:58:15.774Z"}
{"type":"delivered","path":"D:\\Photos\\IMG_0421.jpg","hash":"9f2c...","bytes":4194304,"mediaItemId":"AF1Qip...","firstEver":true,"at":"..."}
{"type":"skipped","path":"D:\\Photos\\IMG_0420.jpg","hash":"1a77...","reason":"already-delivered","at":"..."}
{"type":"failed","path":"D:\\Photos\\clip.mov","hash":"...","error":"over the Google limit of 20 GB","at":"..."}
{"type":"auth-needed","reason":"invalid_grant","at":"..."}
{"type":"lock-lost","reason":"stolen","heldBy":71608,"stopping":true,"at":"..."}
{"type":"paused","reason":"user","at":"2026-07-29T08:12:07.990Z"}
{"type":"resumed","reason":"user","waiting":1,"at":"2026-07-29T08:12:35.167Z"}
{"type":"detached","at":"2026-07-29T08:12:53.661Z"}
{"type":"stopping","reason":"stdin","at":"..."}
{"type":"stopped","exitCode":0,"totals":{"seen":1,"skipped":0,"delivered":0,"wouldUpload":1,"failed":0,"bytes":0,"requests":0,"dropped":0,"deferred":0},"at":"2026-07-28T18:58:15.782Z"}
```

One shape is still transcribed from `WatchEventBody` rather than captured, because reaching it needs a real Google project with its day's budget really spent, and no rig can arrange that on demand. Replace it with a captured line the first time anybody sees it in the wild:

```
{"type":"paused","reason":"quota","resumesAt":"2026-07-30T00:00:00.000Z","detail":"the daily request budget for this Google project is spent","at":"..."}
```

What a shell author needs beyond the shapes, and cannot get from them:

- **One `paused` shape covers both kinds of hold.** `reason: "quota"` is the day's request budget being spent and carries `resumesAt`, the moment it comes back, plus `detail`, the sentence. `reason: "user"` is somebody having asked, and carries neither, because it lifts when they say so and not before. **Two holds can be on at once and neither clears the other.**
- **`resumed` carries `waiting`, the number of files that were held, and it is one `resumed` per hold that lifts**, not one per return to running. So `waiting` is `0` for a lift that released nothing because the other hold is still on. Both silent cases are real: a person resuming into a day whose budget is spent, and a budget coming back at midnight under a pause that person asked for. A `delivering` with `reason: "resumed"` follows immediately **when the queue is really running again**, and deliberately does not follow a lift that released nothing, because a `delivering` is a claim that work is moving.
- **`delivering.reason` has three values**, `"scan"`, `"resumed"` and `"rescan"`. The last is how a tray knows its own Deliver now click landed.
- **`delivered` carries `firstEver` only when true**, so absence reads as "not the first" rather than as "unknown". Section 3's notifications has the rule and the ordering trap behind it.
- **`stopped` is always the last line of a run**, including the runs that failed before anything started, which emit `failed` and then `stopped` and nothing else. That is the double start path, and a tray can rely on it. A detached run is not an exception: it ends on `stopped` too, and only the reader has gone.
- **`detached` is sent the moment the word arrives, before the drain**, because the whole point of detaching is that the parent does not have to wait.
- **`lock-lost` with `"stopping":true` means the core is standing down through no fault of the shell**: another process judged this one abandoned and took the ledger. The right tray answer is the attention icon and the pid, not an automatic respawn, because a respawn walks straight into the same lock.
- **`failed` events are per file and also per run.** A `failed` with no `path` is the run itself.
- **Human prose never reaches stdout.** The channel is chosen once, from the flag, for the run and its error path together, so a parent may parse stdout strictly.

### Commands going the other way

The core's stdin parser accepts **bare lines, one command to a line, case insensitive**. It is `listenOnStdin` in `src/commands/watch.ts`, it is deliberately tiny, and the list lives in one exported constant, `STDIN_WORDS`.

| Line | What it does |
|---|---|
| `stop` | closes intake, drains the queue, emits `stopping` then `stopped`, exits |
| `quit` | the same thing under the other obvious name |
| end of file | the same thing again, **unless a `detach` came first** |
| `detach` | the parent is leaving and this run finishes the whole drain alone, as an orphan, then exits itself |
| `pause` | holds everything and keeps collecting. No respawn, no re-scan, nearly free |
| `resume` | lets it flow again |
| `rescan` | one reconciliation pass on demand, plus a queue flush. This is Deliver now |

Anything else is answered on the human channel by name and never swallowed: a swallowed command is how a shell ends up waiting for a drain that was never asked for, giving up, and reaching for `child.kill()`. So the core says `"{\"cmd\":\"stop\"}" is not a command this build understands on stdin. The words are stop, quit, detach, pause, resume, rescan, one to a line, not a JSON envelope.`

`docs/ASK-PROTOCOL.md` adds exactly one payload-carrying **form** on top of these six words, for setup only. Not a seventh word.

#### The detach protocol

Read this as a contract, not a summary: **every other stop-protocol sentence in this document is written against these five facts.**

1. **`detach` is answered with a receipt before anything else happens.** `{"type":"detached"}` goes out on the first line, ahead of the log line and ahead of the stop request, because the parent is waiting on exactly that line. A shell may exit as soon as it reads `detached`.
2. **The let-go flag is set before the stop is requested**, and that ordering is the mechanism rather than a detail. A detach that arrives *during* a drain reaches the same handler a second `stop` would, and the handler asks the gate whether the run has been let go before it reaches for the impatient path.
3. **After a detach, end of file is not a stop.** The core logs that the parent has gone as agreed and carries on. Before a detach, EOF is a stop. The log line differs between the two cases on purpose: from outside, a core that was let go and a core orphaned by a crash look identical, and the log file is the only place that difference survives.
4. **After a detach, a second request is not impatience.** `waitForStop`'s repeat branch returns instead of calling `queue.leaveNow()`, so nothing abandons the batch.
5. **The run still ends normally.** `stopping` with `reason: "detach"`, then the drain, then `stopped` with its totals, then exit, into a pipe nobody is reading and into the log file, where they can be read afterwards.

So the shell's quit sequence is two different words rather than the same word twice:

```
first click    write "stop\n"        leave stdin OPEN, render "finishing 3 files, then closing"
               wait for {"type":"stopped"}, then exit

second click   write "detach\n"      wait for {"type":"detached"}, then exit and let stdin close
               the core finishes the drain as an orphan and exits itself
```

**Every `pause` and every `resume` is answered on the machine channel, including the ones that change nothing.** This is a rule about the channel rather than about the queue: a shell has exactly one reading of silence, that the core did not understand the word, and it acts on that reading. So a `resume` at a run holding nothing for that user answers `resumed` with `waiting: 0`, and a `pause` at a run already paused answers `paused` again. Neither is a transition, both are the state the word found, and the state is what the asker got wrong. **`pause` and `resume` are refused while a run is stopping**, with a sentence saying so, and those two refusals need no machine answer of their own: `stopping` and `stopped` are on their way, and any way of ending a run answers everything outstanding.

The same event stream is what the log file records, so "Open log" and the tray tooltip can never disagree.

### Packaging a Node core as a sidecar binary

Electron would have supplied a Node runtime for free. Tauri does not, so the runtime is shipped deliberately.

| Option | What ships | Decision |
|---|---|---|
| **`node.exe` renamed as the sidecar, plus `core.mjs` as a bundled resource** | the exact Node the core was tested on, plus a one-file esbuild bundle of the core | **Chosen** |
| Node SEA (`--experimental-sea-config` plus `postject`) | one file | Rejected. Same size, since the runtime is embedded either way, so the only win is file count. Still experimental. And injecting a blob into `node.exe` **invalidates its Authenticode signature**, which is the opposite of what an unsigned project wants. |
| `bun build --compile` | one file, possibly smaller | Rejected. It swaps the runtime under a core whose whole test suite ran on Node. The durability guarantees this tool sells (`fs.open(..., 'a')` plus `handle.sync()`, `chokidar` riding `ReadDirectoryChangesW`) are Node behaviours that were tested, not language features. Changing the runtime changes them silently. |
| Require the user to have Node installed | nothing | Rejected. The audience is a person who never opens a terminal. |

The chosen row is good rather than least-bad: **`node.exe` ships already signed by the OpenJS Foundation**, and renaming a PE file does not invalidate an Authenticode signature, because the signature covers the file's contents and not its name. So while Photo Pigeon itself is unsigned, the largest binary in the package carries a valid signature from a known publisher. The cost is the 81.3 MB, and it is the honest reason the installer-size row in section 1 was rewritten.

### The single-instance guard

This part must be exactly right. The failure mode of getting it wrong is not a crash, it is silent duplicate uploads against a request budget. What breaks when two processes watch the same setup:

- `JsonlLedger` serialises appends **within one process only**. Its `has()` map is a snapshot taken at open, so process B never learns about the entries process A wrote after B started. Both hash the same new file, both miss it in their own map, both upload it. The ledger then has two lines and Google has two media items.
- `quota.json` is a plain `writeFile` of the whole counter. Two processes last-write-wins each other, so the day's spend is undercounted and the tool blows through its own ceiling.
- `albums.json` has the same shape and the same race, which means a second album of the same name.
- Both watchers report every new file, doubling the work before any of the above matters.

So: **one watcher per ledger, enforced by the core, not by the shell.** `src/state/lock.ts` is the implementation:

```
Lock file    <dirname(ledgerPath)>/watch.lock

Contents     { "pid": 12345,
               "startedAt": 1769587923114,     epoch ms, so a recycled pid is catchable
               "takenAt": "2026-07-28T09:12:03.114Z",
               "host": "<hostname>",
               "holder": "watch" }

Acquire      fs.open(lockPath, 'wx')   exclusive create, fails with EEXIST if held
             write the record, fsync, close

On EEXIST    read and parse the record, then judge it, cheapest test first
               1. our own pid?   settle it exactly, by start time
               2. alive?         process.kill(pid, 0), ESRCH means gone
               3. same process?  startedAtOf(pid) when the platform can say. A
                                 seam: nothing supplies it on Windows today
               4. breathing?     mtime within 5 minutes -> held
               cold, alive and unidentifiable is NOT an answer. It is watched
               for 35s, longer than a heartbeat, and only a lock that never
               moves in that window is taken
             the steal itself goes through an exclusive create of watch.lock.claim,
             so exactly one of several simultaneous stealers wins

Heartbeat    every 30s, and it reads before it writes
               file names somebody else -> we were robbed: stand down, tell the
                                           run through onLost, stop delivering
               file is gone             -> a thief exited and deleted it: take it
                                           back with an exclusive create
               otherwise                -> utimes(now), and if utimes is refused,
                                           rewrite the record, which moves the
                                           mtime too

Release      unlink, but only when the file on disk still names our pid
```

**Why both liveness and freshness.** Windows recycles pids, so a dead holder's pid can belong to something else and liveness alone would lock the user out forever. A hard kill runs no exit handler, so the file survives with nobody holding it and freshness alone would let a briefly suspended process be stolen from. Together they refuse only when someone is demonstrably alive and demonstrably recent.

**Why the freshness half needs the two extra rules**, which were added after the failure was reproduced rather than argued. Test 3 is a seam nothing supplies in production, so **the mtime is the sole discriminator in every real run**, and it is evidence rather than proof: a wall clock corrected forward by more than five minutes, a laptop resumed, or an `utimes` a filter driver silently refuses all make a healthy holder look abandoned. Backdating one lock file's mtime by ten minutes while its holder carried on watching was enough: the second watch stole the lock, ran a full pass against the same ledger, and deleted the lock on the way out, leaving the still-live first watcher holding nothing at all. Two fixes, both in `lock.ts`:

- **The steal looks twice.** A cold lock whose pid is alive and cannot be identified is watched for longer than one heartbeat. A holder that is really there touches the file inside that window and keeps its lock. The cost is one pause at start, paid only in the ambiguous case.
- **The holder defends itself.** Every heartbeat re-reads the file before touching it. Somebody else's record means we were robbed, and the run stands down through `onLost` rather than delivering against a ledger a second process is now writing. A missing file means a thief exited, and it is taken straight back. The tray sees this as a `lock-lost` event with `"stopping":true`.

**Why the ledger path is the key and not the config path.** The ledger is the resource that must never be double-written. Two config files may legitimately point at one ledger, and they must collide. Equally important for safety: a test that uses `--config` with a temp directory gets a temp ledger and therefore its own lock, so **no test can ever contend with a production instance.**

Residual gap, stated honestly: `quota.json` and `albums.json` live beside `tokenPath`, not beside the ledger. Two hand-written configs that share a token but not a ledger would still race the request counter. Rare enough to handle with a `doctor` check rather than a second lock.

On top of the file lock the tray also uses **`tauri-plugin-single-instance`**, which only covers tray against tray: a second launch focuses the first instead of starting a rival. It does nothing about a terminal `photo-pigeon watch`, which is what the file lock is for. Both ship.

What each side does when refused:

- **CLI:** a sentence naming the pid and the moment it started, plus the next step, and exit **`EXIT.ALREADY_RUNNING = 5`**. It has its own code because it is the failure a shell meets most often and the only one where waiting and trying later is the right answer: nothing is broken, something else is already delivering these folders. Under `--events ndjson` the refusal is also a `failed` event followed by `stopped`, and that is the better signal for a shell, because a code cannot name a pid. Branch on the event when you have one, and on 5 when all you have is a process.
- **CLI, related:** `watch --once` exits `EXIT.PROBLEMS = 3` when at least one file failed. It is the code `doctor` already wore for "the command did its job and found something worth looking at", and a scheduled task that cannot tell a clean pass from a pass that dropped photos is a task nobody checks. Deferred and dropped files are deliberately not failures.
- **Tray:** do not spawn. Go to the attention icon, tooltip "another copy is already watching", menu item "Try again". No silent retry loop.
- **Tray, once running:** a `lock-lost` event is the same state arriving late. Same attention icon, same pid, and the same rule against a silent respawn, which would only walk into the lock the core just lost.

---

## 3. Tray UX

### The function split, and it is a law

**The tray is the glimpse and the quick hand. The window is the instrument panel.** The status window is the main UI, and the split has to be written down, because the failure mode is not a wrong pixel: it is a feature that exists in exactly one of the two places and a user who cannot find it.

**The tray's job is to be read without stopping what you were doing.** Two greyed lines that answer "is it working" and "what has it cost me", the two or three gestures a person makes on the way past, and nothing that has to be read twice. A left click opens the window, a right click opens the menu, which is where Windows puts a menu anyway.

**The window's job is to be the whole truth in full sentences.** Every folder being watched, on its own row, with its own actions. The storage honesty sentence unabbreviated, which the 127-unit tooltip cap has never been able to carry. History. The health check. And every control the tray has, because a person who came to the window should not have to go back out to the taskbar to press Pause.

Three consequences, and they are the law rather than the taste:

- **Duplication between the two is the point, not a smell.** Pause, Resume and Deliver now live in both places and both render the same supervisor truth: one state machine, two renderers, exactly as the tooltip and the status line have shared one state since M2. A duplicate that can disagree is a bug. A duplicate that cannot is a courtesy to whichever surface the user happened to be looking at.
- **Anything the tray can do, the window can do.** The reverse does not hold, and must not: the window is allowed to be the only home of a thing that needs room, and the tray is not allowed to be the only home of anything at all.
- **Where the tray would have to guess, it hands over to the window instead.** "Open watched folder" with one watched directory opens it. With more than one it opens the status window, where every folder has its own row and the user picks. A tray item that guesses which folder somebody meant is worse than one that gets out of the way, because the guess is silent and looks like an answer.

And one thing the window may never become: **required for the ordinary day.** A person who never opens it still gets a working uploader that tells them what it costs, which is why the status line keeps the storage sentence at a glance and why the icon states below carry the whole state machine on their own.

### Icon states

**Five states, and the law is not the number.** The law is that **each state has a trigger and a clearing condition, so the icon can never get stuck.** That is the entry fee for a sixth, if there is ever one.

| State | Icon | Set by | Cleared by |
|---|---|---|---|
| Idle | pigeon, calm | `started`, and the quiet window expiring with nothing in flight | n/a, it is the resting state the other four clear to |
| Delivering | pigeon with a filled green dot | `scanning`, or a `delivering` that found something, or a `delivered` | a quiet window that **the same event armed** |
| Paused | pigeon, greyed, **with a hollow grey ring in the badge's corner** | `paused` with `reason: "user"` | `resumed` with `reason: "user"`, **and only that one** |
| Attention | pigeon with an amber dot | `auth-needed`, a `lock-lost` that is not standing down, a `paused` with `reason: "quota"`, a crash the shell is still retrying, or failures since the user last opened the menu | opening the menu clears the failure flavour; auth and lock clear only when actually fixed; a respawn that gets up clears a crash; **the quota line clears on `resumed` with `reason: "quota"`, or on a `delivering` carrying `reason: "resumed"`, and on nothing else** |
| Broken | pigeon with a red dot | `CoreStatus::Halted`, the shell's own name for a stop no respawn can fix: a spawn that failed, a start the core refused, a lock another copy took, a sign in only a person can give. Or the respawn ladder widened to its five minute ceiling with nothing up | a core reaching `started`. A spawn takes the status off `Halted`; only `started` takes the ladder's own judgement off, which is why the badge does not blink calm for the second between a respawn and the next death |

**Amber and red are a severity split.** Amber means held and coming back by itself, which is what a quota hold until midnight is. Red means nothing will deliver until somebody acts. Those two ask a person for opposite things, one for nothing at all and one for their attention now, and one dot cannot carry both: a budget that returns at midnight and an engine that will not start until you sign in would look identical in the only place most people ever look. **A crash the shell is still retrying stays amber**, deliberately, because it really may come back by itself. Red is for the ladder having widened to five minutes with nothing getting in, which is a tool that has stopped working whatever the code calls it.

**Broken is scoped to what the shell can know.** The core does not say whether a crash was a bad network moment or a config it will never load, and no event was invented to make it. So Broken is the two things this side really knows: the `ExitVerdict` `on_child_exit` reaches by itself, where `Refused`, `StoodDown` and `NeedsUser` all mean a respawn walks into the same wall, and the respawn ladder hitting its ceiling. If the core ever marks a config or a token as unloadable on its way out, that is a third trigger and it is welcome; nothing in `state.rs` has to move to accept one.

**The words move with the badge, off one predicate.** "The engine stopped. Starting it again shortly." is honest about a wobble and is a promise nobody keeps at the top of the ladder. `AppState::will_not_come_up` is read by the icon and by the status line, so the tooltip, the menu row and the status window cannot disagree about the one state a person is being asked to act on. The `Halted` half quotes the core's own sentence through `halted_line`, which says more than anything the shell could add.

**Broken raises no toast of its own, and that is a decision rather than an omission.** Every way into Broken already raises exactly one, latched once per unhealthy stretch by `stopped_toast_shown` and armed again by `started`: a refusal and a stood-down lock go out through `exit_toast`, a sign in goes out at its own event, and the crash loop's toast is gated on the very fact that turns the badge red. A Broken toast on top of those would be the same news twice. The one way in with no toast is a spawn that never resolved a core at all, which is a boot-time state with its sentence in the menu and in the status window.

**Paused wears a ring as well as its dimming, and a ring rather than a pause glyph.** The greyed bird reads as the artwork stepping back, which is right, and then there is nothing on it saying what stepped back. A glyph loses on `icons.rs`'s third law, the one that made every other state a coloured dot: at this size a person reads hue before they read form, so two upright bars are a smudge with a meaning nobody can reach. A ring is not a glyph. It is the badge's own silhouette with the middle taken out, which is a difference a person reads at the size they already read a dot at. It borrows the badge's corner, size and transparent moat, so somebody who has learned where to look for one mark has learned where to look for the other. **The colour is mid grey and not a hue, because paused is not a severity and may not borrow one of the three colours that are**, which is the same reason the grey icon has always meant a person and never a problem. Mid grey clears the 3 to 1 contrast floor a graphical mark needs against both of Windows' taskbars, 3.6 to 1 on the light one and 4.1 to 1 on the dark, and `the_paused_ring_reads_on_both_a_light_and_a_dark_taskbar` holds those numbers rather than this paragraph. The ring keeps full opacity where the artwork drops to 65 percent, which is what lets a mark be read on an icon whose whole point is to be dim.

**Precedence, where two states are true at once:** broken, then paused, then attention, then delivering, then idle. Pinned by `the_icon_precedence_runs_broken_paused_attention_delivering_idle` in `state.rs`. The only pair worth arguing is the first and red wins it: "nothing will deliver until you act" is news, and "nothing is delivering because you said so" is not. That pair is unreachable today, because both halves of broken are read off a status that holds one value at a time and a core that has answered `pause` is a core that is up. The arms are in that order anyway, so the precedence is what the code says rather than what today's reachability happens to allow.

**A clearing condition has to be evidence about the state it clears.** The quota line used to clear on *any* `delivering`, which stopped being safe the moment "Deliver now" existed: the click writes `rescan`, the core answers every rescan with a `delivering` of its own, reason `"rescan"`, emitted before it has looked at whether it is paused. So the clearing condition became the user's own click: one press took the tray from "Google limit reached, back at 00:00" to "watching" with every file still held, and nothing could put it back, since a core does not re-announce a hold it is already on. `rescan` is evidence that somebody pressed a button and `scan` that a run started. Only `resumed` is evidence about the budget.

**What the grey icon is about**, because the two readings differ in a state a person reaches in two clicks. It goes out when *the person's* hold goes, whether or not the budget's is still on, because that icon is a statement about what somebody asked for and not about whether bytes are moving. A person who pauses, meets a quota pause, and then changes their mind gets the grey icon off, the amber line still up, and the tooltip saying when the day's budget comes back. The alternative reading leaves the menu saying "Paused. New photos are noticed and held." over an engine that is only waiting for midnight, with no way out but Quit and relaunch.

Windows details that will bite otherwise:

- Windows has no template-image concept (that is macOS). Ship a light-taskbar and a dark-taskbar variant and pick between them at runtime, once the artwork needs it. Today's mascot carries its own light and dark inside the silhouette, measured: across its 628 opaque pixels the luminance runs from 0 to 250, median 105, with 222 pixels below 80 and 133 above 176, which is what makes one variant legible on both taskbars rather than lucky on one.
- **Picking the variant is not what it looks like under Tauri.** `Window::theme()` is the wrong signal: it reflects `AppsUseLightTheme`, while the taskbar follows a *different* registry value, `SystemUsesLightTheme`, both under `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`. These genuinely diverge, and a machine with a dark taskbar and light apps is ordinary. Read `SystemUsesLightTheme` directly and re-read it on `WM_SETTINGCHANGE`. A tray-only app has no window and therefore no window theme API at all, so the registry read is not an optimisation, it is the only route.
- Ship a multi-resolution `.ico` (16, 20, 24, 32, 48) or the icon is a blurry mess at 125 and 150 percent scaling.
- **Windows 11 hides new tray icons in the overflow flyout by default.** A user who installs this, sees no pigeon, and concludes it did not work is a support ticket and a bad review. The first-run window must show where the icon went and how to drag it out, with a picture.
- Do not animate the delivering state by swapping frames on a timer. It is a background tool, it should be quiet, and a spinning tray icon reads as spam.
- **The five marks are composited in Rust from the one shipped PNG, not drawn as five files.** `icons.rs` decodes `icons/32x32.png` once at startup and punches the mark in, which keeps the states from drifting apart and keeps the file a designer replaces down to exactly one. The light and dark variants above, when they arrive, are one more input to that function rather than five more files to keep in step.

### Context menu

```
  Watching 1 folder · 12 delivered                (disabled, live status line)
  340 MB sent, original quality                   (disabled, the storage law)
  ------------------------------------------------
  Pause                                           (one item, several labels)
  Deliver now
  ------------------------------------------------
  Open watched folder                             (one folder opens it, several open the window)
  Open log
  Status and history...
  ------------------------------------------------
  Start with Windows                              (checkbox)
  Initial setup...
  ------------------------------------------------
  Quit Photo Pigeon
```

**Menu item ids are the machine tier of the naming law and a label change may never move one.** The setup item's id is frozen at `ids::SETUP_WINDOW`, the string `"setup_window"`, in `app/src-tauri/src/tray.rs`: the id is what the click handler matches on and what every test names. The label is "Initial setup..." rather than anything about health, because health lives in the status window and "initial" is the warning: re-running setup on a configured machine writes a new config and is not what a curious person wants to click. The status item's label, "Status and history...", is allowed to differ from the window's title: the item says what you will get and the title bar says where you are.

Notes on the ones with teeth:

- **The status line is where storage honesty lives at a glance.** "340 MB sent, original quality" is the whole law in five words, in front of the user every time they open the menu. The full sentence lives one click away in the status window. **Counters are per session and never per day:** the status line says "12 delivered", never "12 delivered today", because the shell has no date bookkeeping and will not claim what it cannot count.
- **The Pause line is one action item wearing several labels** (Pause, Pausing..., Resume, Try again, Start again now) rather than a row of mostly disabled items.
- **Pause holds the queue in place; it does not stop and respawn.** A respawn runs `reconcile` and the queue then hashes every file it finds, so on a 100 GB library a pause and a resume would mean reading 100 GB. The core-side `pause` and `resume` words hold everything and keep collecting. **The two pause reasons are distinct and neither clears the other:** a user pause does not lift when the quota pause lifts, and resuming out of a user pause while the day's budget is still spent leaves the files waiting and says so. A shell that collapses them into one boolean will show "watching" while nothing moves.
- **Deliver now** sends `rescan`: one `reconcile` pass plus a `queue.flush()`, answered with a `delivering` carrying `reason: "rescan"`, which is how the shell knows its own click landed. This is the manual escape hatch for network drives and for the user who does not trust it yet. It is a gesture, never a timer. Law 2 stands: **no timer may ever send this word.**
- **Open log** and **Open watched folder** go through `tauri-plugin-opener`, scoped in capabilities to the log directory and the configured watch roots. Not a general "open anything the webview asks for" permission.
- **Open watched folder does not guess.** One watched directory: it opens. More than one: **it opens the status window**, where the Watching list gives every folder its own row and its own open button. The `started` event has always been able to carry more than one path, so "the watched folder" was a singular the config never promised.
- **Quit always drains first and says so:** "finishing 3 files, then closing". The second click sends `detach`, waits for `{"type":"detached"}`, and only then exits, so the label can honestly read "Leave, it finishes on its own". The quit path is also where a downloaded update gets applied, and `install()` must be the last thing it ever does. See section 5.

### Notifications

Via `tauri-plugin-notification`. Default: **only attention states.** Never per file. A tool that toasts on every photo gets muted within a day, and then the one toast that mattered is muted too.

Every title reads "Photo Pigeon", per the naming law in section 0. The whole set:

- `auth-needed`: "Photo Pigeon needs you to sign in again." Clicking opens the health tab with the `invalidGrantAdvice` text, which is the best paragraph in the package.
- `paused` with `reason: "quota"`: "Today's Google limit is reached. Everything else goes tomorrow, nothing is lost." **Say when it comes back**, from the event's `resumesAt`, because "tomorrow" is a guess and the event carries the answer.
- child exited unexpectedly: "Photo Pigeon stopped. Click to restart." Unexpectedly means an exit the shell did not ask for. A clean exit after a `stop` or a `detach` is not a surprise and must not toast.
- `lock-lost` with `"stopping":true`: "Another copy of Photo Pigeon took over this folder set, so this one stopped." No restart button: there is nothing to restart into.
- Exactly one happy toast, on the very first delivery ever: "First photo delivered." Then never again. New users need proof the thing works; everyone else needs silence.

**A user pause raises no toast**, because the user did it and knows. Only `reason: "quota"` toasts.

**"First ever" means the ledger was empty before that delivery.** That is core-owned truth, so the shell is told rather than remembering, and the shell keeps no flag of its own for it. Three things follow, and the third decides whether the rule works or only reads well:

- The shell's own `firstDeliveryToastShown` is retired. `autostartDecided` stays in `shell_state.rs`, because that one genuinely is a fact about the shell and about nothing else.
- Removing it is a migration and not a rewrite. `Flags` is `#[serde(rename_all = "camelCase", default)]` with no unknown-field rule, so an installed copy whose `shell-state.json` still carries the retired key loads without complaint and keeps its autostart answer.
- **The ordering trap.** `UploadQueue.record` writes the ledger entry *before* it reports the outcome: `src/commands/queue.ts` calls `ledger.add` and then `onOutcome`. So anything that counts the ledger on receipt of a `delivered` event sees one record on a virgin install's very first photo, and never sees zero again as long as the install lives. That is a happy toast nobody could ever see, on every machine, and it would be green in every test that only checks the toast is not raised twice. **The emptiness is sampled before the write and travels on the event** as `firstEver`, **per delivery and not per run**: snapshotting emptiness when the ledger is opened and stamping every delivery of that run would give somebody who drops twelve photos as their first action twelve identical toasts.

One consequence, named rather than left to be discovered: a user who deletes or loses their ledger gets one more happy toast. That is the rule taken literally and it is the honest answer, because to that install nothing has ever been delivered. The alternative, a suppress-only latch kept in the shell, would give one fact two homes.

Remember the AUMID note in section 1: none of these appear in `tauri dev` until the app has been installed once, and the AUMID is the frozen bundle identifier rather than the display name, so the display rename does not disturb them.

### First run

**The first-run window is the destination, and it is what ships.** The alternative was spawning the terminal wizard in a console, which is zero duplication and is already tested, but the entire premise is a consumer who never opens a terminal and the first thing that option does is open a terminal. It also cannot offer a native folder picker.

The window is a real page: five steps, deep link buttons, a drop target or Downloads intake for the client JSON, a native folder picker via `tauri-plugin-dialog`, the "Google hasn't verified this app" screenshot as a pre-warning, the SmartScreen explainer, the tray-overflow explainer and the storage honesty screen.

What made it affordable is that the wizard is one state machine with two front ends rather than two wizards. Already reusable as is: `links.ts`, `paths.ts`, `credentials.ts` and the Downloads watching inside `intakeCredentials`, `config.ts`, `doctor.ts`. Already injectable: the wizard's **output**, behind `WizardIo`. What was missing was the wizard's **input**, which `steps.ts` used to import from `@inquirer/prompts` directly, with `requireInteractive()` refusing a non-TTY, which is exactly what a sidecar spawned by a tray is. The input now sits behind an `ask` seam on `StepContext` the way the output sits behind `io`, so the terminal wizard and the window are thin front ends over one state machine.

The seam crosses the sidecar boundary on the channel that already exists rather than a second one: the wizard runs as `setup --events ndjson` and emits `{"type":"ask", ...}` on stdout in the same envelope every other event uses. The answer comes back as **one form**, `answer` followed by a single space and one compact JSON object carrying the ask's `id` and its `value`. The six bare words are untouched. **`docs/ASK-PROTOCOL.md` is the contract**, and three pieces of code are built against it: `src/commands/setup-channel.ts`, `app/src-tauri/src/setup_host.rs` and `app/ui/setup.js`. Two details a reader will want: an answer is refused on the same `answered` event that receipts a good one, told apart by `accepted`, and **a refusal also re-asks**, so the question a front end is looking at is always the newest `ask` with that id. Stdin stays open for the whole run and closing it is the cancel, which is also the only cancel.

**OAuth consent opens the system browser and the core listens on 127.0.0.1.** Do not render Google's consent page in a `WebviewWindow`. Google blocks embedded webviews for OAuth, it is against their policy, and the loopback flow already works. The window shows "waiting for you to finish in the browser" and nothing more. This is law 3 in section 0 reaching its most tempting corner.

---

## 4. Start at login

**Default on, one visible line saying so, one-click toggle.** A backup tool that does not run is not a backup tool. The line is visible during first run, not buried in a settings page discovered later, and the toggle is one click in the tray menu.

### The mechanism

On Windows this is one value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Per user, no admin prompt, no elevation, no scheduled task, and the value is read back so the menu checkbox always shows the truth rather than a remembered preference.

**`auto-launch` 0.5 is driven directly from `app/src-tauri/src/autostart.rs`, and `tauri-plugin-autostart` is not a dependency.** The plugin cannot write a quoted value and no published version can: it computes the path itself inside its own `setup`, and the quotes have to wrap the path. The full read is the M3 blocker note at the end of section 6's M3, and the install directory contains a space on every machine, so this is not a nicety. **Pin `auto-launch` at 0.5, not 0.6**: 0.6 adds a `WindowsEnableMode` whose default tries `HKEY_LOCAL_MACHINE` first and falls back to the user hive on access denied, which is the opposite of this project's no-elevation rule.

```rust
let exe = std::env::current_exe()?;
let auto = auto_launch::AutoLaunchBuilder::new()
    .set_app_name("Photo Pigeon")                     // must equal productName, exactly
    .set_app_path(&format!("\"{}\"", exe.display()))  // the whole fix is these two quotes
    .set_args(&["--autostart"])
    .build()?;
auto.enable()?;   // "C:\...\photo-pigeon.exe" --autostart
```

**Capabilities grant nothing here.** `capabilities/default.json` exposes no autostart permission of any kind, because every privileged action runs in Rust: a page reads the checkbox through an IPC command, never through a plugin's own IPC.

#### The boot flag is `--autostart`

One word, and it **names the provenance of the launch**, which is the only thing the flag is for. `--hidden` would name a window suppression that does not exist: this app declares zero windows, so there is nothing at any launch to hide, and a flag that describes a behaviour the app does not have is a flag somebody will eventually implement. What the boot path really wants to know is "did this launch come from the Run key", because that is the launch that may want to wait a few seconds for the desktop to finish loading before the first reconcile pass.

The falsifiable check is not that the source says `--autostart` but that the **Run value** does: read the value back and confirm it ends in `--autostart`, with the path quoted and the argument outside the closing quote. The exact target format is in section 6's M3 blocker note.

Two conditions make the login item durable, and both are choices made elsewhere in this document:

- **A stable exe path across updates.** `tauri-bundler`'s NSIS target defaults to a current-user install into `%LOCALAPPDATA%`, no admin required, and updates land in the same directory, so the Run value keeps pointing at a real file. Versioned install directories would break this on every update. The directory is `%LOCALAPPDATA%\{productName}`, so it is stable across updates and *not* stable across a display rename. See section 0.
- **`--autostart` handled on boot:** no window, no splash, straight to the tray, and the first reconcile pass starts quietly.

#### Two failure modes to handle rather than assume away

1. **The Run value removed behind our back**, by a cleanup tool or Task Manager's Startup tab. Show the checkbox unticked rather than insisting. Reading the value back already tells the truth here.
2. **A stale path in the Run value.** The value records the exe path as it was when autostart was enabled. If the app is ever reinstalled somewhere else, the value points at nothing and boot silently fails. So on every launch: if enabled, compare the recorded path with our own, and rewrite it if they differ. The plugin does not do this and never did; `is_enabled()` asks only whether the value exists. **This is the re-assertion**, and `Reassert` in `autostart.rs` is what it answers with.

There is a third, which is about the menu rather than the registry, and it is why the tick is written the way it is. **A write that fails leaves the tick showing the opposite of the registry.** muda flips a check item on screen the instant it is clicked, before any of our code runs, so the tick is showing what was *asked for* while the click is still being handled. If the write then fails, the registry ends exactly where it started and the item is left saying the opposite. The correction has to reach the item through **two** caches and not one: the supervisor's `last_render`, which decides whether a render is posted at all, and `TrayUi::applied`, which decides which rows of a posted render are written. Forging a difference in the first alone gets a render posted and then compared away by the second. **So the tick is the one row written on every render rather than only when it changes**, and `tray::writes` is where that rule lives, as a pure function, so that it has a test: reaching the real menu item needs an `AppHandle`, and that is an argument for extracting the decision rather than for leaving it unguarded.

### Why this retires the Task Scheduler stopgap

Keeping `photo-pigeon watch` alive across reboots without a shell means a Task Scheduler task. That stopgap fails on five counts, and the login item fixes all five:

1. **Not consumer installable.** Creating the task means `schtasks` in an admin shell or an XML import. The tray is a checkbox.
2. **Invisible.** A task that fails to start shows nothing anywhere. The tray shows an amber dot and a toast.
3. **Awkward for a console program.** Either a console window sits on the desktop forever, or it is hidden and the user has no way to look at it.
4. **Fragile paths.** The task hard-codes a path to Node and to the installed CLI, both of which move when Node is upgraded or the package is reinstalled. The login item points at the app's own exe, which the installer owns, and the app carries its own Node.
5. **Hard to turn off.** Undoing it means finding the task again.

There is also a timing argument. Task Scheduler's "at system startup" runs before logon, which is wrong for this tool: the token file is per user and the network may not be up. The Run key fires after the desktop is loaded, with the user's profile mounted and networking ready. That is exactly when a folder watcher wants to wake up.

---

## 5. Repo shape and release

### Getting the tray into the repo without touching the npm package

The published package must not grow a shell, and it must not grow a byte. It publishes `files: ["dist", "README.md", "LICENSE"]`, so anything outside `dist` is invisible to npm already. The only question was how the tray resolves the core, and the answer is that it does not resolve it at all: **esbuild bundles `dist/cli.js` plus its runtime deps into one `core.mjs`, shipped as a Tauri resource.** One build step, no dependency resolution, nothing to hoist, nothing to dereference. A Rust shell cannot resolve a Node module under any arrangement, so "one file the sidecar can run" is not merely the cheapest option, it is the only shape that means anything.

```
photo-pigeon/
  package.json          published to npm, no shell deps anywhere near it
  src/  dist/           the CLI core
  app/
    package.json        "private": true, devDeps: @tauri-apps/cli, esbuild
    package-lock.json   its own
    ui/                 the pages: setup, status, health, and the locale table
    src-tauri/
      Cargo.toml        tauri (tray-icon), notification, dialog, opener,
                        single-instance, process, updater, auto-launch.
                        NOT shell: see section 2, the spawn is std::process
      Cargo.lock
      rust-toolchain.toml
      tauri.conf.json
      src/              tray, menu, sidecar supervision, IPC, updater policy
      capabilities/     one file, deliberately short
      binaries/         generated: node.exe renamed pigeon-core-<triple>.exe
      resources/        generated: core.mjs, the esbuild bundle of ../../dist/cli.js
      icons/            multi-resolution .ico
    scripts/
      build-sidecar.mjs   writes both generated directories
      sidecar-layout.json the path contract, below
      smoke-sidecar.mjs   the spawn contract, executable
    e2e/                  the rigs and the human CHECKLIST.md
```

Properties worth stating out loud: the npm tarball cannot change, because nothing in `app/` is inside `files`. `npm install` for a CLI user never sees Rust, Tauri or a bundled Node. The tray cannot drift from the CLI, because it runs the CLI's own compiled output. And if a second consumer of the core ever appears, that is the moment to promote to npm workspaces, not before.

Both `binaries/` and `resources/` are generated, gitignored, and produced by one script that runs `tsc` in the root, esbuild over `dist/cli.js`, and a copy of the pinned `node.exe` under its target-triple name. A build that finds a stale `core.mjs` ships yesterday's core, so the script deletes before it writes.

**The bundle is `core.mjs` and not `core.cjs`, and that is a build error rather than a preference.** `src/cli.ts` ends in a top level await, and esbuild refuses that outright with the `cjs` output format. Node decides a file's module system by its extension, so ESM content in a `.cjs` file is a syntax error on the other side too. CJS would additionally have needed an `import.meta` shim and a rewrite of the core to unwrap the top level await. ESM needs neither and builds with zero warnings.

**`@inquirer/prompts` stays in the bundle.** Marking it external saves a fraction of a percent (the whole bundle is 1.14 MB inside an 85.94 MB installed footprint) against `pigeon-core.exe core.mjs setup` crashing for anybody who runs the installed core from a terminal.

#### The resource path contract

**`app/scripts/sidecar-layout.json` is the one place any of these names is written down.** It is the reason three separately written pieces agree without anybody remembering to make them agree.

| Side | How it reads the contract |
|---|---|
| `app/scripts/build-sidecar.mjs` | writes it, having just produced the files it describes |
| `app/src-tauri/src/paths.rs` | `include_str!` plus `serde_json`, parsed once. No path literal of its own |
| `app/src-tauri/tauri.conf.json` | `bundle.externalBin` and `bundle.resources` must match the contract word for word |

It carries the bundle name, the sidecar name, the two bundle lists, the pinned Node version, the four environment variable names, and the argument vector with `{coreBundleAbsPath}` and `{configPath}` still in it. `paths.rs` fills the placeholders in rather than composing a vector, so the flags cannot drift away from the ones `smoke-sidecar.mjs` verified.

Two of the drift guards are tests rather than good intentions, which is what makes "cannot drift" true rather than hoped:

- `the_layout_and_this_module_agree_on_the_env_names` fails the build if the Rust copy and the JSON copy of the four env names disagree. The Rust side owns them, the JSON repeats them, and the test is the join.
- `the_core_bundle_is_found_at_exactly_the_layout_path_and_nowhere_else` stages a plausible near miss on disk, `resources/core.cjs` alongside a bare `core.mjs`, and asserts neither satisfies the lookup. It proves the rule by behaviour instead of by grepping a file for its own literals.

**Resolution order is one directory on Windows.** `tauri_utils::platform`'s `resource_dir_from` returns the exe directory unconditionally, and `tauri-build` stages `externalBin` next to the exe with the triple stripped and copies `bundle.resources` keeping their relative path. The NSIS bundler lays the install directory out identically. So `tauri dev`, `target/release` and the installed directory are one shape, not three, and dev exercises the shipped layout. Ahead of all of it sits `PHOTO_PIGEON_CORE_JS`, used verbatim when set, which is the seam that lets a test or a developer point the tray at an unbundled `dist/cli.js` with no rebuild.

**One consequence for CI, by design:** because `tauri.conf.json` names `binaries/` and `resources/`, a `cargo` build fails until they are staged. A fresh clone must run `node app/scripts/build-sidecar.mjs` before the Rust build. `app/package.json` wires this to `predev` and `prebuild`, but a CI job that calls `tauri-action` directly rather than through npm needs the staging step of its own, ordered before the Rust build.

### Versioning

**Lockstep: one version, one tag, one number.** One GitHub Release carries both the installer and the npm publish, so "what version are you on" has exactly one answer. The accepted cost: a tray-only fix bumps the npm package too, so the CLI gets an occasional release with no changes in it. The counter-argument (a consumer installer that says 0.3.0 reads as unfinished) was heard and set aside, because decoupling after the fact is easy and re-merging two version lines is not.

The version is written in exactly one place and read everywhere else. The repo root `package.json` is the source. `app/src-tauri/tauri.conf.json` reads `"version": "../../package.json"`, which is Tauri's own supported form, so the installer name, the NSIS product version and the updater's comparison all come from that one file. Proved by making the two disagree: with `app/package.json` set to 9.9.9, the bundler still produced `photo-pigeon_0.1.0_x64-setup.exe`. `app/package.json` has no `version` field at all, deliberately: it is private, never published, and a number able to lie eventually will.

**`Cargo.toml` is checked by the build, not by CI.** `app/src-tauri/build.rs` runs `assert_version_lockstep()` before `tauri_build::build()` and hard-fails when `Cargo.toml`'s version and the root `package.json`'s disagree, naming both files. It re-runs when the root manifest changes, and it degrades to a `cargo:warning` rather than a failure when that file cannot be read, so an odd checkout cannot brick the build. Cosmetic drift is still drift, and a build script catches it on the machine that caused it, before the commit exists. Proved to fire rather than merely written.

**The tag is the third thing that can disagree.** A `v0.1.0` tag against a manifest reading anything else is a release whose installer, npm package and Release page all say something different from the git history, so the tag road compares the tag to `package.json` and fails the whole tag rather than shipping three quarters of a release. **A tag is never moved either**: a moved tag is a version that means two things, and a burnt tag costs a version number, which is the cheapest thing this project owns.

### Build and release pipeline

Two workflows rather than three jobs. One guards every push to `main` and every pull request with both suites. One runs on a `v*` tag: a preflight, the lockstep with the tag in it, both suites, the sidecar staging, the installer build, `latest.json`, and a draft Release. It is one job rather than three because the core's suite has only ever been green on Windows, and a Linux gate would be a new claim rather than a checkbox.

Two laws come with it, both about what a tag is allowed to mean:

- **A tag builds, it does not announce.** The Release a tag produces is a **draft**, so the artefacts land somewhere the fresh-user walk is still allowed to fail.
- **Nothing irreversible happens on a tag.** In this pipeline that names exactly one thing: the npm publish. It cannot be taken back in any way that looks good, so it runs on the Release being published rather than on the tag. `npm publish --provenance` needs the workflow's OIDC permissions set, and the npm account uses passkey 2FA, so CI needs a granular automation token.

The preflight is the same instinct: a tag with `bundle.createUpdaterArtifacts` off, or no signing secret set, or a public key that is not the real one, is refused in its first minute, because an installer nobody can ever update is worse than no installer. **The publish-day order is `docs/RELEASE.md`.** This section says what the pipeline is; that document says who presses what, in which order, and what proves it happened.

### Auto-update

**On by default.** Background download, apply on next launch, never mid delivery, never a forced restart. Google moves furniture and a background uploader that cannot be patched is a liability.

The mechanism is `tauri-plugin-updater`:

- **Artifacts.** `bundle.createUpdaterArtifacts: true` makes the bundler emit the update payload and its signature alongside the installer.
- **Signature.** `tauri signer generate` produces a minisign keypair. The public key goes in `tauri.conf.json` under `plugins.updater.pubkey`; the private key and its password become CI secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. **This is not Authenticode.** It proves an update came from us and does nothing at all for SmartScreen. Two signatures, two entirely different problems, and conflating them is the classic way to think a project is signed when it is not.
- **Losing that private key means no installed copy can ever be updated again.** Every user is stranded on their current version and the only recovery is asking them to download a fresh installer by hand. It is backed up offline, in a password manager, before the first release and not after.
- **Endpoint.** `plugins.updater.endpoints` points at a static JSON manifest on GitHub Releases, at a stable URL such as `https://github.com/justerlex/photo-pigeon/releases/latest/download/latest.json`. The URL supports `{{current_version}}`, `{{target}}` and `{{arch}}` if it ever needs to become dynamic.
- **Install mode.** `plugins.updater.windows.installMode: "passive"`: a progress bar, no wizard, no clicks.

The never-mid-delivery rule maps onto the plugin cleanly, which is why Tauri v2 is comfortable here rather than merely acceptable: v2 splits **`download()`** from **`install()`**, where v1 only had the combined call.

- Check for an update on launch and once every 24 hours after. Never on a user gesture, never with a modal.
- `download()` in the background whenever one exists. Hold the bytes. Say nothing, or at most a quiet "an update is ready" line in the menu.
- **Call `install()` from the quit path only, after the sidecar has drained and reported `{"type":"stopped"}`.** Never while the queue has work, never while a `batchCreate` is in flight.
- **`install()` must be the last thing the quit path ever does**, because on Windows the app is exited automatically when install runs. That is a documented Windows installer limitation, not a Tauri quirk, and it cannot be worked around. Use the plugin's `on_before_exit` hook for any final cleanup, and make sure the lock file is already released by then.
- If the user quits while a delivery is running: drain, then install, then exit. They see "finishing 3 files, then closing" and a progress bar afterwards, never an installer over a running upload.

**The updater has no IPC and no capability.** The policy is a pure module with no clock, no network and no `AppHandle`, its only call site is the quit path in the supervisor, and the plugin's four commands are granted to no webview: `install` replaces this running process, so a page that could reach it could restart the machine's uploader mid-batch, which is the one thing this policy exists to forbid.

**One cost, recorded rather than worked around.** The installer is 23.4 MB, and the policy holds the downloaded bytes until the next quit, so the shell holds 23.4 MB in memory from the moment a download finishes, against a shell that idles under 4 MB. The log says it out loud on every download. The alternative, spilling the verified bytes to the app's own cache directory and reading them back at the quit, keeps the whole shape of the policy and costs a path to own, a sweep on the next launch, and one more refusal for a file that went away. The plugin writes its own temp file at install time regardless. `docs/RELEASE.md` appendix A carries the open question.

### Code signing

**Launch unsigned, document the wall, and apply to SignPath Foundation as a build step. No money is spent.**

#### What unsigned actually means for the user

The browser warns on the download, and then Windows shows "Windows protected your PC" with **Unknown publisher**. The Run button is hidden behind **More info**. A meaningful share of consumers stop there, and the ones who do not stop feel uneasy, which is worse for a tool that is asking for access to their photo library.

#### The documentation duty, which is the actual work

This is not a README footnote. It is the same pattern the wizard already uses for Google's own "Google hasn't verified this app" interstitial, and it works because it **pre-warns before the user meets the wall rather than explaining after**:

- A screenshot of the exact SmartScreen dialog, in the README's install section and on the GitHub Release page, above the download link.
- The two words the user needs, in order: **More info**, then **Run anyway**.
- One plain sentence on why: this is a free tool signed by nobody, the code is public, and Windows flags every unknown publisher regardless of what the program does.
- The same treatment inside the first-run window for anyone who got past it and is now wondering what they installed.

Do not apologise for it and do not bury it. A user who was warned and told what to click trusts the tool more afterwards, not less.

**The screenshot cannot be taken on a machine that has already trusted the file**, because Windows stops showing the wall for something it has seen run. The honest capture is a fresh download on a machine that has never met this installer.

#### SignPath Foundation, the free path

Free OV code signing for open source projects. The certificate lives on SignPath's HSM, the private key never touches a developer machine, and signing happens inside their service wired to GitHub Actions, so it becomes a build step rather than a ceremony. Requirements, against this project:

| Requirement | Photo Pigeon |
|---|---|
| OSI-approved license, no commercial dual-licensing | MIT. Passes. |
| No proprietary or non-open-source component | Passes. The bundled Node is MIT, and WebView2 is a system runtime that is not bundled. |
| No malware or unwanted programs | Passes, and the upload-only law is easy to demonstrate. |
| Actively maintained | Passes. |
| **The project must already be released in the form that should be signed** | **Shipping unsigned first is a prerequisite, not just a saving.** |
| Functionality described on the download page | Write the release page properly. It is needed anyway. |

Review takes days to weeks, so the application goes in as soon as the first release exists. Two caveats, so nobody is surprised: **the publisher name users will see is "SignPath Foundation"**, not this project's name, because the certificate is issued to the Foundation; and **an OV certificate does not carry EV's instant SmartScreen reputation**, so the wall softens as downloads accumulate rather than vanishing on the first signed build.

And one rule that follows from the packaging choice in section 2: **do not modify `node.exe`.** Renaming keeps the OpenJS Foundation signature valid; injecting a SEA blob destroys it. While the rest of the package is unsigned, that signature is the only one in the box.

#### Paid options, recorded and not proposed

Prices checked July 2026. Recording them is not proposing them, and nothing here is authorised.

| Option | Price | Notes |
|---|---|---|
| **Azure Trusted Signing** | **9.99 USD/month** Basic, 5,000 signatures/month, 0.005 USD per signature above that. Premium is 99.99/month. | The cheap modern path, with an individual-developer route in public preview: identity validation through Microsoft Entra Verified ID with a government photo ID. The certificate carries the developer's own name, which SignPath's does not. |
| **Certum Open Source Code Signing** | roughly **69 to 85 EUR** for the first year including the smart card and reader, roughly **29 EUR/year** to renew | A cloud variant (SimplySign) avoids the physical card. Since 2023 all code signing keys must live on certified hardware or an HSM, so a cheap file-based certificate no longer exists at any price. |
| Traditional OV or EV certificate | a few hundred USD per year, plus a hardware token | Only EV buys instant SmartScreen reputation. Not worth it for a free tool. |

If the free path stalls, Azure at ten dollars a month is the fallback to raise, with a number attached rather than a shrug.

### Two more release rules

- **The uninstaller never deletes `~/.photo-pigeon`.** The ledger is the durable record and deleting it means re-uploading the user's entire library on the next install. The law holds by construction: Tauri's NSIS uninstaller confines its deletions to `$INSTDIR`, the shortcuts, the uninstall registry keys, the Run value, and `$APPDATA`/`$LOCALAPPDATA\io.github.justerlex.photopigeon` behind the application-data question it asks on the way out, and `~/.photo-pigeon` is in none of those. The assertion in the rig is a guard on a law that already holds, and the deliberate opposite is part of it: **answer yes to that question on purpose and confirm the ledger is still there afterwards.** A law that only holds while the user declines is not a law. If an "also delete my delivery record" checkbox is ever added, it is off by default, it spells out what it costs beside it, and it is the only thing in this project allowed to reach that directory.
- **Do not suppress Start Menu shortcut creation to look tidy.** The installed shortcut is what gives toasts their name and icon on Windows. See the AUMID note in section 1.

---

## 6. Build history: what each milestone built and what it proved

Smallest first, each milestone independently useful, each with an exit criterion that can be checked rather than felt. What follows is what each one built and what it measured. The numbers are the record this project is held to.

### M0 · Spike and measure

Install the toolchain, prove the C++ build tools work, and build a hello-world Tauri tray. Prove on a real Windows 11 machine: the icon renders against both light and dark taskbars driven by `SystemUsesLightTheme` and not by the app theme; the menu opens; the Run key round-trips; a toast appears from an installed build once the identifier is set; `tauri-bundler` produces an installable NSIS package; a 64 KB sidecar stdout line arrives whole; and **there are zero `msedgewebview2.exe` processes in the tree while no window is open.**

*Exit: every row of the measurement block is filled in, and the tray shell idle figure is at or under 15 MB. Above 25 MB, stop and take the native tray helper fallback before anything is built on top of the shell.*

**Exit met at 9.87 MB of working set. Tauri 2 tray-first confirmed, the fallback not needed.**

> #### The measurement block
>
> Measured on the **release** build, with the idle row repeated on the **installed** build to be sure the number was not an artefact of running from `target\release`. The targets column stays: the point of the table is the comparison.
>
> `Get-Process | Where-Object { $_.Name -match 'photo-pigeon|msedgewebview2|node' } | Select-Object Name, Id, @{n='WorkingSetMB';e={[math]::Round($_.WorkingSet64/1MB,1)}}, @{n='PrivateMB';e={[math]::Round($_.PrivateMemorySize64/1MB,1)}}`
>
> | Measurement | Target | Reopen at | M0, no sidecar | M2, real watch delivering |
> |---|---|---|---|---|
> | Tray shell idle, no window ever opened | 15 MB | **25 MB** | **9.87 MB** working set, 1.93 MB private, one process, settled at t+31s. Installed build: 9.90 MB. **PASS** | **9.95 MB** working set, 2.14 MB private, settled at t+30s with a live sidecar watching. Installed build: 10.60 MB. **PASS**, and the sidecar cost the shell 0.08 MB |
> | WebView2 child processes at idle | **zero** | any | **zero.** 6 while a window is open, 0 after it closes, verified twice. **PASS** | **zero**, asserted by the rig while a delivery was in flight. **PASS** |
> | Tray shell, first-run window open | note it | n/a | **306.70 MB** working set / 159.16 MB private across **7 processes**, to render one static page | answered at M4: **3.53 MB private working set** in the shell, 20.35 MB working set, 322 handles, with the real five-step page open on 6 webview processes costing 88.70 MB private working set of their own |
> | Tray shell, after the window is destroyed | back to the idle figure | a permanent step up | **23.35 MB**, and **not cumulative**: a second open/close cycle settled *lower*, at 21.70 MB. Private commit stays near 5 MB, so the residue is trimmable shared pages rather than demand | answered at M4: **3.65 MB private working set**, 302 handles, zero webview processes. The window went down by 0.08 MB and 23 handles, so the close gives back more than it keeps |
> | Core sidecar, watching, queue empty | 40 to 80 MB | 120 MB | no sidecar exists yet | **45.96 MB** working set, 55.62 MB private, spawned by the tray. 45.25 MB on a second run driven from the CLI instead, so the number is the core's and not the shell's. **PASS** |
> | **Shell plus sidecar together, watching** | not budgeted separately | n/a | n/a | **55.91 MB** across two processes. Recorded because it is the number a user reads off Task Manager, and because section 1 budgets the two apart. For comparison, the Electron range quoted for a shell alone was 150 to 250 MB |
> | Core sidecar, hashing a 20 GB file | flat | any growth with file size | not measured | **still not measured.** The M2 delivery is a 145 byte PNG; peak under that load was 50.27 MB, which bounds nothing |
> | NSIS installer size | note it | n/a | **1,240,870 bytes, 1.18 MB.** `currentUser` mode, no elevation, silent `/S` works, uninstaller clean | **23,391,338 bytes, 22.31 MB.** Times 18.9, and all of it is the bundled runtime. Inside section 1's revised "tens of MB" expectation |
> | Installed footprint on disk | note it | n/a | **3,504,640 bytes, 3.34 MB** for the shell exe, plus the uninstaller | **90,115,718 bytes, 85.94 MB across 6 files.** `pigeon-core.exe` 85.20 MB, `photo-pigeon.exe` 3.50 MB, `core.mjs` 1.13 MB, `NODE-LICENSE.txt` 0.14 MB, plus the manifest and the uninstaller |
> | Cold start to tray icon visible | under 2s | 5s | not measured: it needs a visual timestamp rather than a process counter | **still not measured.** It needs an eye and a clock, so it is a checklist step. The process is alive and has spawned its sidecar inside 4s, which is a ceiling and not the number |
> | 64 KB stdout line arrives whole | yes | no means buffer in Rust | not measured: no sidecar to send it. The largest line the core emits in practice is `started` at roughly 700 bytes | **settled by construction**, which is the "no" branch of the reopen column: the shell frames its own lines, so there is no plugin buffer to have a ceiling |
> | **Drop to ledger line, one 145 byte PNG** | note it | n/a | n/a | **15.6 seconds**, tray-spawned sidecar, real Google Photos delivery. Mostly the debounce and the batch floor rather than the wire |
>
> **The window-open row is the hardest evidence in this document for the no-window-at-idle law.** Three hundred megabytes and seven processes, to draw one static page. Two supporting facts were checked because the design fails silently without them: a window can be created again after being destroyed, and quitting leaves zero orphans. The M4 column later showed the 300 MB was never this app's own demand, and the law still stands on it, because those processes exist as long as a window does.
>
> | Window-open process | working set MB |
> |---|---|
> | shell | 23.18 |
> | WebView2 browser | 112.93 |
> | GPU | 60.43 |
> | renderer | 50.91 |
> | utility | 32.33 |
> | utility | 18.49 |
> | crashpad | 8.43 |
>
> **Proofs beyond memory.** The icon renders on a dark taskbar and on a light one, with `SystemUsesLightTheme` toggled and a `WM_SETTINGCHANGE` broadcast. The menu opens with its greyed status line, separators and check item. Autostart round-trips: off to on writes the Run value, reopening the menu shows the tick read back from the real key, off removes the value entirely. And a toast is delivered, with an unplanned controlled comparison settling the AUMID question: the toast from the *uninstalled* binary was filed under the launching host, while the *installed* one was filed under the product. **The Start Menu shortcut AUMID is what confers toast identity.**

**Two real bugs the spike found, both of which shaped later milestones.**

1. **Tauri's NSIS template drops a Desktop shortcut and there is no config switch to stop it.** `NsisConfig` has no `createDesktopShortcut` key. Fixed through `installerHooks` to `nsis-hooks.nsh`, which deletes the shortcut post-install and again post-uninstall.
2. **`tauri-plugin-autostart` writes an unquoted Run key value.** Confirmed by a raw registry read. See the M3 blocker note below, which is where it was chased to the bottom.

### M1 · Core seams

`src/state/lock.ts` implementing section 2's guard, with tests for held, stale-by-death, stale-by-pid-reuse and steal-once. A `WatchEvent` union plus `onEvent` on `WatchOptions`, wiring the `onOutcome` the queue already accepts. A stop handle on `runWatch` so stopping does not need a signal. A `--events ndjson` flag. A rotating log file sink. Plus the **side index**: a path plus size plus mtime table that lets a start skip re-hashing unchanged files, with the content hash still authoritative for anything new or changed, and a documented fallback to a full hash pass when the index is missing or corrupt. Plus two benches: whether a signal from a parent process reaches a Node child's handler on Windows, and whether the sidecar survives its parent being killed.

*Exit: `watch --events ndjson` emits parseable lines, a second watch against the same ledger refuses with a named pid, a second start over an unchanged library does no hashing, and every existing test still passes.*

**Exit met. What it proved:**

- **Every line on stdout parses as JSON**, each carrying an ISO `at`, with human prose on stderr. The guarantee is about a file descriptor, so it is tested where it lives: a test spawns the real CLI against a temp config and a held lock and parses every stdout line. The one path that had leaked prose was the double start, from an outer error handler the run's own stderr swap could not reach, which is the most likely failure a tray meets.
- **The second watch refuses and names the pid**, with the moment it started.
- **A second pass over an unchanged tree does no hashing, proved against a disk rather than a counter.** Every photo in the temp tree was held open by a helper process with `FileShare.None`, making reading the bytes impossible. The second pass reported all three files correctly and never touched one. The falsifying control was run too: with the side index deleted, the same locked tree fails all three files with `EBUSY`.
- **Stop by stdin takes 9 to 10 ms on an idle watch**, ending `delivering` to `stopping` to `stopped` with a totals block, and the lock file is gone afterwards.
- The signal bench is in section 2. It came back worse than the assumption it was testing: **no signal reaches a child's handler on Windows at all.**

Two behaviour changes made while integrating, recorded because they are behaviour and not tidying. **A dry run keeps the side index**, because the dry-run promise is about the user's library and the ledger, not about the disk: a dry run already writes a lock file and a log, so skipping the cache bought a purity that had already been spent and charged the careful user a full re-hash every time. And **`skipped-duplicate` is actually emitted** now; it existed in `UploadStatus` but nothing in the queue ever produced one, so the event was unreachable.

### M2 · The tray wraps an already-configured install

Spawn the bundled sidecar, map events to icon states, live status line, tooltip, pause, quit with drain, Open log, Open watched folder. No first run, no autostart, no notifications yet.

*Exit: install the NSIS build, drop a photo into a watched folder, watch it deliver, without a terminal ever being opened. Memory rows re-measured under load.*

**Exit met on both halves.** The binary is `photo-pigeon.exe`, the installer carries the Node runtime, and a generated PNG was really delivered to Google Photos by a tray-spawned sidecar. A script cannot see a tray icon, so the icon states, the menu, the tooltip, Pause and Resume from the menu, and quit-by-menu were walked by hand.

> **The run: 30 assertions, 30 passed.** Release build, throwaway config under `%TEMP%`. The load-bearing ones, in the order they matter:
>
> - **The tray spawned the core with the throwaway config, not a production one.** `PHOTO_PIGEON_CONFIG` became `-c <temp config>` on the sidecar's own command line, read back off the live process rather than out of a log. The rig kills the shell and aborts if that argument ever names `~/.photo-pigeon`.
> - **The core took the throwaway lock**, and the pid in `watch.lock` is the child the rig tracked. That is the strongest available proof the tray is watching the right thing, and it depends on nothing the shell chose to log.
> - **The delivery landed**: a line in the throwaway ledger whose `hash` is exactly the sha256 of the PNG the rig generated, carrying a Google `mediaItemId` and the right byte count. Not a path match and not a count. 15.6 seconds from drop to ledger.
> - **The quit is a drain, not a kill.** The rig stops the shell only, never the core. The core saw EOF on stdin, drained, exited on its own and removed its lock. A killed watch always leaves its lock behind, so the absence of that file is the proof.
> - **A live production watch on the same machine was never touched**, asserted at the end by pid against the list taken before the run started.
>
> Silent install checked separately and in full: `/S` install, the installed layout matching the contract, the installed exe launching and resolving its core out of the install directory, then `/S` uninstall leaving no files behind, with `~/.photo-pigeon` byte-identical and same-mtime across the whole cycle.

**Decided design that came out of M2 rather than out of the plan:**

- **The shell's own log lives at `%LOCALAPPDATA%\io.github.justerlex.photopigeon\logs\tray.log`**, not beside the core's log, because the core's log path only arrives in the `started` event and the runs most worth logging never get that far. `PHOTO_PIGEON_SHELL_LOG` overrides it.
- **The menu is one action item wearing several labels** rather than several mostly-disabled items.
- **Counters are per session, not per day.**
- **Open watched folder is disabled until the core has started once**, since `started` is the only source for the watched directories. Reading the config in the shell would cross the line section 0 draws.
- **The tooltip is capped at 127 UTF-16 units**, because Windows `szTip` is 128 including the terminator. The storage honesty line is never what gets cut: the detail line is truncated instead, and the short form "Original quality, counts against your Google storage." is what fits. The full sentence lives in the windows.

**Three durable rules came out of M2**, each one a promise this document made that the code was not keeping, and none of them reachable by the rig:

1. **Setting a busy flag and arming its clearing timer must be one call that cannot be half done.** `scanning` set the busy flag and armed nothing; `delivering` with `found: 0` cleared only the scan flag; and since the core emits `delivering` after every scan whether it found anything or not, a healthy watch with nothing new to send held the delivering icon forever. Every icon state is promised a clearing condition, and this one had a clearing condition nothing ever armed. The more useful finding is about the test that was meant to guard it: it called the timer callback by hand, and production only ever calls it when an event asked for it, so the test proved the state machine could be got out of the state rather than that anything would get it out. The tests now drive a miniature of the supervisor's real timer wiring.
2. **A quit menu may not promise a continuation the shell cannot deliver.** The shell holds the only write handle on the child's stdin, so a shell that leaves is an EOF, and an EOF reaching a core that is already stopping was a *second* stop, answered with `queue.leaveNow()` and exit 130. The labels moved first, and then M3 moved the behaviour to match the original promise with `detach`. **A detach word that is not a second stop was the only real fix**, and it is a core change, not one the shell may make alone.
3. **The drain window must be generous and must be renewed by any event from the core.** `DRAIN_TIMEOUT` was 60 seconds against a core whose 429 backoff *starts* at 30 seconds and doubles, so a healthy retrying queue routinely reached the attention state and was offered the one action that really does abandon the batch. It is five minutes now, renewed by any event, so only a core that has gone genuinely silent reaches it.

A fourth finding was about the rig rather than the product, and it is the rule the rigs have followed since: **a safety check that fails must stop the run, never record a failure and continue.** The rig's guard fired only when the sidecar command line *named* a production directory; in the failure mode that actually happens, a mistyped variable name, the command line carries no config path at all, matched neither test, and fell through. Every safety branch now stops the shell and leaves the core to drain, because nothing in that script is ever killed by pid.

### M3 · It survives a reboot and it tells you when it needs you

Start with Windows, default on, with the visible line, plus `--autostart` boot and the stale-path re-assertion, driven through `auto-launch` directly rather than the plugin. Attention states wired to `auth-needed`, `paused` with `reason: "quota"`, and child exit. The three attention toasts plus the single first-delivery toast. Deliver now. Core-side real pause replacing stop-and-respawn. Plus two things the milestone grew while it was being scoped: **the core's stdin vocabulary from two words to six, including the `detach`**, and the display-name sweep from section 0.

*Exit: reboot the machine, log in, drop a photo, it arrives with nothing clicked.*

That exit splits, because a script cannot reboot a machine. **Machines verify the Run value's contents byte for byte and a cold relaunch that delivers. The literal reboot is a checklist line.** A green rig with an unquoted Run value is a failed milestone, which is the whole reason the value check is on the machine side. Both halves came back.

> #### M3 delivery record
>
> Every machine row is a rig run against a throwaway config in TEMP and a Run value scoped to a name beginning `photo-pigeon-e2e-`. No production install or state directory was read or written, and the Run key held the same number of values before and after.
>
> | Check | Result |
> |---|---|
> | Run key value, read raw | **`"<install dir>\photo-pigeon.exe" --autostart`**, kind `REG_SZ`. Quotes wrap the path and only the path, the flag sits outside the closing quote, the path is already expanded. Six shape assertions, six passed. Written **within 30 seconds of the first launch with nothing clicked**, which is the default-on half |
> | `StartupApproved\Run` companion value | present, `02 00 00 00 00 00 00 00 00 00 00 00`, which is Task Manager's word for enabled. Written by `auto-launch` on enable and **not removed on disable** |
> | Stale-path re-assertion, exe moved then relaunched | **passed.** Value staled by hand to a path that does not exist, the next launch noticed the recorded path was not its own and rewrote it, and all six shape assertions passed again afterwards |
> | Cold relaunch delivers with nothing clicked | **passed.** Two sessions on one config, the second launched with `--autostart` as its only argument: **0 WebView2 processes**, the shell log names `--autostart` so the flag is parsed rather than merely accepted, a photo dropped after the relaunch arrived, and the second session read the ledger the first one left |
> | Reboot, log in, drop a photo | **passed**, by hand. This is M3's exit criterion in the words it was written in |
> | Toasts: auth-needed, quota pause, unexpected exit, first delivery ever | **copy and raising verified; the OS surface is a checklist item.** `toasts.rs` unit tests pin every title to "Photo Pigeon", forbid the package name and em dashes, and hold the quota toast to naming its resume time; the state machine tests pin when each is raised, including the first-delivery toast being spent exactly once. **Nothing scriptable can see a Windows toast** |
> | Deliver now sends `rescan`, answered with `delivering reason=rescan` | **passed.** A second `scanning` event, same pid, no `stopped`, and the watch still delivered afterwards |
> | Pause holds without a respawn, and resume does not re-hash | **passed, and it is discriminating.** Same pid throughout, same lock file, a photo dropped while paused and **25 seconds with nothing moved**, longer than the queue's own quiet flush, then delivered on resume without being asked for twice. `reason` came back `user`, told apart from a quota pause |
> | Quit second press sends `detach`, core drains as an orphan and exits 0 | **the words passed; the click is a checklist item.** Three sequences: `stop` then `detach` then the shell dies; `detach` cold with no `stop` first; and the M2 control of `stop` then a vanished shell. All three: `detached` acknowledged, batch reached the side index, **no impatient stop anywhere in the stream or on stderr**, exit code 0, lock released |
> | Core tests | **559 passed, 31 files** (531 before M3). `tsc --noEmit` clean |
> | Shell tests | **128 passed** (77 before M3). `cargo check --all-targets` clean. Includes a real HKCU round trip under a self-test name, reading the raw bytes back through `RegGetValueW` and deleting both the value and its companion |
> | Tray shell idle, private working set | **2.06 MB** after 30 seconds of settling |
> | Tray shell idle, total working set | **9.84 MB**, and 9.84 MB peak under load. Nothing M3 added is measurable: the notification plugin, the Run-key writer and the state file together cost less than the 0.7 MB noise floor |
> | Core sidecar, watching, queue empty | **41.18 MB** working set, 53.4 MB private, 43.66 MB peak under load. Target 40 to 80, reopen at 120 |
> | Installer size, installed footprint | **23,566,895 B (22.48 MB)**. Installed footprint **86.10 MB**: `photo-pigeon.exe` 3.56 MB, `pigeon-core.exe` 81.26 MB, `core.mjs` 1.14 MB, the Node licence 0.14 MB |
>
> **Verified out of the generated `installer.nsi` rather than assumed**, because three of these are the difference between an uninstall that finishes and one that leaves something behind: `!define PRODUCTNAME "Photo Pigeon"`, the install directory is `$LOCALAPPDATA\${PRODUCTNAME}`, the Start Menu shortcut is `${PRODUCTNAME}.lnk`, `MAINBINARYNAME` is `photo-pigeon`, `BUNDLEID` is `io.github.justerlex.photopigeon`, and the uninstaller runs `DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"`. **That last line is why the Run value's name has to equal `productName` and not something prettier**: `autostart.rs` writes under `package_info().name`, the two agree, and a test asserts they still do.

> #### The working set investigation, and why the budget's metric moved
>
> **The question.** M2 recorded the shell idling at 9.95 MB. An installed copy after a day of real use showed roughly 32 MB in Task Manager. Three suspects: the recut icon set, a first-launch window-icon decode, or working set against private bytes being compared as though they were the same thing.
>
> **The answer: measurement artifact. No regression, nothing to fix.** The third suspect was right and the first two are dead, one of them by an experiment rather than by argument.
>
> **The icon set costs nothing at runtime, measured rather than reasoned.** The shell was built twice from an isolated clone, identical except that the second build had the previous icon set checked out over the recut one. Same toolchain, same staged sidecar, same throwaway dry-run config, same 31 second settle:
>
> | Build | exe on disk | modules | working set | private working set | private bytes | handles |
> |---|---|---|---|---|---|---|
> | the recut set that ships | 3,591,168 B | 32 | **10.64 MB** | **1.69 MB** | 2.29 MB | 164 |
> | the same commit with the previous icons | 3,466,752 B | 32 | **10.65 MB** | **1.70 MB** | 2.31 MB | 164 |
>
> One hundredth of a megabyte apart, and in favour of the recut set. That is the noise floor, not a difference. `icons.rs` builds every tray state from `include_bytes!("../icons/32x32.png")`, so the decoded buffer is 32 by 32 by 4 bytes whatever the source art looks like, and the large source files in the tree are never opened by the running program.
>
> **The A/B settles a second thing on the way past.** Both builds read about 10.6 MB where the M2 table says 9.95 MB, and one of them carries M2's own icons, so that 0.7 MB is not the art and not any code change: it is this measurement against that one, a different config and a different afternoon. **Treat 0.7 MB as the run-to-run noise on the working set figure** and do not read a trend into anything smaller. The private working set figures were much steadier, which is one more reason to prefer them.
>
> **Where the 32 MB comes from.** The same binary in two conditions, read out of the running processes without touching either:
>
> | | uptime | modules mapped | working set | of which shared | private working set | private bytes | handles |
> |---|---|---|---|---|---|---|---|
> | fresh probe, never clicked | 11 min | **30** | 10.66 MB | 8.97 MB | **1.69 MB** | 2.29 MB | 164 |
> | an installed copy in daily use | 10.3 h | **84** | 32.04 MB | 28.19 MB | **3.85 MB** | 5.16 MB | 415 |
>
> The long-lived process has **54 modules mapped that the fresh one does not, carrying 44.7 MB of image between them**, and the fresh one has none the other lacks. None of them is this project's code. The largest are `OneCoreUAPCommonProxyStub`, `SETUPAPI`, `CoreUIComponents`, `msi`, `iertutil`, `urlmon`, `Windows.UI`, `textinputframework`, `COMDLG32`, `PROPSYS` and `twinui.appcore`: the Windows shell and UI stack, mapped in the first time a native menu is opened. **`Windows.System.Launcher.dll` names the trigger exactly**, because it is what `tauri-plugin-opener` calls when somebody clicks Open log or Open watched folder. Two of the 54 are not Microsoft's at all, but Explorer shell extensions installed on that machine, injected into any process that touches a shell API. **A different user's number will differ by whatever they have installed, which is the clearest possible sign that this is not a number the app controls.**
>
> **Checked for a leak, because "it grew" deserves better than a shrug.** The fresh probe was left idle with a live sidecar and re-read: at 31 seconds 10.62 MB working set, 1.67 MB private working set, 164 handles; at 11 minutes 10.66 MB, 1.69 MB, 164 handles. **Flat to the hundredth of a megabyte, with the handle count identical.** So there is no per-tick growth in the idle loop. The step from 1.69 to 3.85 MB is a one-off paid when the shell UI stack loads, not a slope. The number that would falsify that is the handle count: 164 fresh against 415 after a day.
>
> **Method, for whoever repeats it.** The installed copy was read with `Get-Process` and `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process` and nothing else: never stopped, never restarted, never written to. The probe ran the same release binary out of a scratch directory against a throwaway `dryRun` config in `%TEMP%`, so the core signed in to nothing, reached no network, and took a lock beside a temp ledger that no production watch can contend with. The sidecar's own command line was read back off the live process and the probe was gated to stop itself if that command line had ever failed to name the throwaway config.

**Three durable rules came out of M3.** All three lived in states the rig cannot construct: it has no Google project whose day's budget it can spend, and it cannot see a menu.

1. **Every `pause` and every `resume` is answered on the machine channel, including the ones that change nothing.** The core's `resume` had three refusal branches that answered on stderr and emitted nothing. A shell has exactly one reading of an unanswered word, that the core does not know it, so it set the status back to `Paused` and stranded the tray there permanently: grey icon and "Paused. New photos are noticed and held." over an engine that was delivering, with Deliver now disabled and Quit-and-relaunch the only way out. One rule rather than three patches. `UploadQueue`'s `onResumed` fires once per hold rather than once per return to running, which also gave the second silent lift a voice: a budget coming back at midnight under somebody's pause.
2. **A clearing condition has to be evidence about the state it clears.** "Deliver now" cleared the quota attention state without a single file moving, because the shell cleared the amber line on *any* `delivering` and the core answers every rescan with one. The full reasoning is in section 3's icon states.
3. **The autostart tick is written on every render, not only when it changes.** The correction for a failed write was dead code, because it forged a difference in one cache and a second cache compared it away. Section 4 has the mechanism.

> #### The M3 blocker note: the autostart plugin cannot write a quoted Run value, and no upstream version can
>
> Read rather than assumed:
>
> - `tauri-plugin-autostart` 2.5.1 (newest published) computes the path itself inside its plugin `setup`: `builder.set_app_path(&current_exe()?.display().to_string())`. Its public `Builder` exposes `arg`, `args`, `app_name` and `macos_launcher`, and nothing that influences the path. Quoting through plugin arguments is impossible: the quotes must wrap the path, and the path is not ours to supply.
> - `auto-launch` 0.5.0, which the plugin depends on, writes `format!("{} {}", app_path, args.join(" "))` into the key. **`auto-launch` 0.6.0, the current release, writes the identical line.** Upgrading fixes nothing. This is not a stale dependency.
> - Two smaller facts a re-assertion check needs: with no arguments the value ends in a **trailing space**, so naive equality against the exe path fails; and `is_enabled()` only asks whether the value exists and whether Task Manager has not disabled it. It never compares the recorded path with the running exe.
>
> Why it bites: the install directory is `%LOCALAPPDATA%\Photo Pigeon`, which contains a space **on every machine**, and it lives under `C:\Users\<account>\`, where an account name containing a space is also ordinary. Unquoted, Windows parses `C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe --autostart` left to right, looks for `C:\Users\John.exe`, and boot silently does nothing. The user sees a backup tool that quietly stopped backing up.
>
> **The correct value, for the implementation and for repairing a machine by hand:**
>
> ```
> Key    HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
> Name   Photo Pigeon        productName, which is also package_info().name. The value NAME
>                            comes from the product and the value DATA from the exe, so a
>                            binary rename never touches it and a display rename does. Write
>                            the first value AFTER any rename, never before: a value under an
>                            old name would keep launching an exe in a directory the new
>                            installer does not touch.
> Type   REG_SZ              not REG_EXPAND_SZ, so the path must already be expanded
> Data   "C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe" --autostart
>        quotes wrap the path only, arguments sit outside the closing quote
>        note both spaces: one from the account name, one from the product name, and the
>        second one is on every machine
>
> Companion value, which is what Task Manager's Startup tab reads and writes:
> Key    HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run
> Name   Photo Pigeon        the same name as the Run value, and it has to stay that way
> Type   REG_BINARY
> Data   02 00 00 00 00 00 00 00 00 00 00 00   enabled
>        03 ... plus a non zero 8 byte FILETIME  disabled by the user in Task Manager
> auto-launch's own test is "the last eight bytes are all zero", so anything the user turns
> off in Task Manager reads back as off, which is correct behaviour to keep.
> ```
>
> **The chosen shape is to drop the plugin and drive `auto-launch` directly, with the quotes baked into the path**, which is section 4's code block. `auto-launch` writes the app path verbatim, so a pre-quoted path lands exactly right, and the crate is already in `Cargo.lock` as the plugin's own dependency, so nothing new is fetched or compiled. The alternative, writing both values with `windows-sys` (already a dependency, add the `Win32_System_Registry` feature, roughly thirty lines), is only worth it if the direct dependency is unwanted, because it means owning the Task Manager override behaviour by hand.

### M4 · First run without a terminal

The ask seam (`src/wizard/ask.ts`), so `steps.ts` no longer imports a prompt library and `requireInteractive` is a method on the front end rather than a TTY check inside the state machine. The setup machine channel (`src/commands/setup-channel.ts`, plus `--events`, `-c` and `--no-open` on `setup`). The IPC commands in `app/src-tauri/src/ipc.rs`. Two windows created on demand and destroyed on close (`windows.rs`). The setup sidecar host (`setup_host.rs`). The setup and health pages. And this document's companion, `docs/ASK-PROTOCOL.md`.

*Exit: a machine with no config reaches a first delivery, and the only text the user typed was their Google password.*

**Two rules came out of M4 and both outlive it.**

- **Core-owned truth travels on the event, sampled at the moment it is true.** `UploadQueue.record` reads `ledger.stats().count == 0` immediately before `ledger.add` and puts `firstEver` on the outcome, `watch.ts` puts it on the `delivered` event, `events.rs` takes it as a `#[serde(default)]` bool, and `state.rs` raises the toast when it is told to and never counts for itself. Present only when true, so absence reads as "not the first" rather than as "unknown", which is what lets an older core read as a stream of ordinary deliveries.
- **Every word is answered on the machine channel, including the ones that change nothing**, restated for a new channel. `setup --events ndjson` exiting 1 on an unknown flag meant the first IPC call in the exit criterion spawned a process that died before creating a single file, and it was invisible because nothing had ever spawned the real CLI in a test.

Two defects worth keeping as classes rather than instances:

- **A cancel between the last wizard answer and the consent screen threw a TDZ ReferenceError, leaked the loopback listener, and hung the sidecar forever.** `finish` cleared a timer declared below the synchronous already-aborted branch, so the one path a closing window takes before the consent wait crashed inside the promise executor with `done` already true and `server.close()` three lines below the throw. The ref'd listener kept the sidecar alive, the reaper never ran, and every later `setup_start` was refused with "setup is already running": first run unrecoverable without killing the orphan by hand. Fixed by initialising the timer before anything can call `finish`. The test holds the handle count to baseline so the leak cannot quietly return.
- **A page that reads back its own write must keep reading until the answer settles.** The Start with Windows checkbox snapped back after a click and then lied for the life of the window, because the write lands on the supervisor thread after the command returns and the page's immediate read-back hit the snapshot from before its own click. `setup.js` re-reads on a short ladder, so a failed write ends showing the state that exists, and `autostart_get` reads the registry live rather than the render-lagged snapshot.

##### M4 measurements: the window-open row, finally taken

> Measured on the release build against a throwaway config under `%TEMP%` with `USERPROFILE` pointed there too. Taken twice by two different paths, agreeing to within 0.2 MB, which is well inside the 0.7 MB run-to-run noise.
>
> | State | private working set | working set | handles | webview processes | webview private WS |
> |---|---|---|---|---|---|
> | First-run window open | **3.53 / 3.73 MB** | 20.35 / 20.65 MB | 322 / 325 | 6 | 88.70 / 85.21 MB |
> | Window opened then destroyed | **3.65 MB** | 20.64 MB | 302 | **0** | 0 |
> | **Shell plus webviews together, window open** | **92.23 / 88.94 MB** | not taken for the hosts | 322 / 325, the shell's own | **7 processes in the tree** | as above |
>
> **The together row is arithmetic on the two columns above it, not a third reading**, so it carries the run-to-run noise twice over and nothing smaller than about 1.5 MB should be read as a difference. The working set figure is deliberately absent rather than estimated: the probe reads the webview hosts by private working set only. And it is an observation, never a trigger. The row that answers to the budget is the one above it, where the window is gone and the tree is one process again at 3.65 MB.
>
> **The budget passes with room to spare, and M0's 306 MB is explained.** M0 recorded 306.70 MB across seven processes for one static page. Under the ratified metric the same situation reads **3.53 MB**: the shell's own demand with a real five-step page open is a fifth of the 15 MB target. The 300 MB was never this app. It is the WebView2 runtime, it is still there, and it is still the reason the no-window-at-idle law exists, but it now sits in its own column where it cannot be mistaken for something this project can control.
>
> **The close gives back more than it keeps**, which is the falsifier this row exists for. Private working set went 3.73 to 3.65 MB and handles went 325 to 302, so a destroyed window is really destroyed rather than hidden. Zero webview processes afterwards, asserted rather than eyeballed.
>
> **Two things this measurement does not answer.**
>
> 1. **The slope is unmeasured.** One open-and-close cycle cannot have a direction, and the rig reports `skip` rather than inventing a number. The blocker is named: there is no scriptable way to make an already running tray open a second window, because the trigger is a tray menu item and no rig can see a menu. `run-m4.ps1 -OpenWindowCommand` is the seam waiting for it, and `tauri-plugin-single-instance` is the natural way to feed it.
> 2. **The 164-against-415 handle question is untouched.** These readings are from a *first-run* shell, which has no config and opens its window immediately, so its UI stack is loaded before any baseline can be taken: 323 handles here against 164 for a configured tray that never drew anything. The two numbers are not comparable, and lining them up would be the same mistake M0 made with working set. Whether a tray climbs over a day of menu rebuilds needs a day.

### Round 2 · The status window becomes the main UI

Six changes, and the first two are the substantial ones.

**The status window is the main UI and a full control surface.** A left click on the tray opens it, and that click is only worth making if what opens is the whole instrument. Pause, Resume and Deliver now live on the status window, and the Watching list gives every watched folder its own row with its own open button. The tray menu keeps the same quick actions, unchanged, as duplicates. Keeping the duplicates is the part worth arguing, because the tidy instinct is to move a control rather than to have it twice: **the tray is where a person is standing when they want to pause**, and sending them into a window to press a button they can already see would trade a real gesture for an architectural preference. The rule that makes duplication safe rather than sloppy is the function split at the top of section 3: both surfaces render the same supervisor state and neither computes its own.

**Watched folders can be edited outside setup, and the wiring is the feature.** Before this, the final setup step was the only place a folder was ever chosen, so a person who bought a new camera and made a new folder had one route: re-run the whole five-step wizard. And re-running setup on a configured machine used to write a new config, restart nothing and say nothing, so the user saw a success screen and no change until the next launch. Shipping a folder editor onto that would be shipping a lie with a nicer font. So the law is: **a config change the core has not been restarted onto has not happened**, and the surface may not report success until the restart has.

Three halves to that, and each one carries a rule:

**The core.** `photo-pigeon folders add <path>` and `folders remove <path>`, with `--json` writing exactly one JSON line on stdout and every human word on stderr. One line and not an ndjson stream, deliberately: `watch` and `setup` are runs that narrate and end on `stopped`, this is a request with one answer, so it wears the shape `doctor --json` already established. It keeps the rule that makes that channel legible: **every request is answered, including the ones that change nothing.** A folder already on the list, a folder that was never on it, and the removal that would leave nothing to watch all come back as `folders-unchanged` carrying the core's own sentence and `EXIT.PROBLEMS`. Validation is not a second copy of setup's: the rule lives in `src/wizard/watch-dirs.ts` and both front ends reach for it. It never touches the token, the ledger, the quota counter or the album cache, and every other config key including ones this build has never heard of is copied across untouched.

**The shell.** `supervisor::restart_core`: the stop word, the wait, the respawn, and one plain sentence on the status surface, because a config that changed and an engine still running on the old one is a divergence, and a silent divergence is the whole failure. `StopIntent::Restart` is deliberately not `Quitting`: the same drain, and the shell stays. **A restart is a stop and never a kill**, so section 2's whole stop protocol applies, including the rule that stdin stays open after `stop`. Three decisions are pure functions with tests rather than conditions inside a spawn: `restart_plan` (a second edit waits for the stop already going, one stop never two, because a second `stop` is `impatient` in the core's own `waitForStop`), `takes_over_the_stop` (a Quit pressed during a restart moves that stop's intent rather than writing another), and `setup_ended_plan` (a config that exists after a setup run is a config the engine should be running on, whether or not there was one before).

**A pause is not the shell's to lift.** A fresh run comes up running, so restarting a paused core would answer "change my folder list" with "and your pause is gone". The restart waits and the **resume performs it**, so the run that comes up is both unpaused, which is what resume means, and on the new list, which is what the edit asked for.

Two honest consequences. A restart is a stop with a full drain and then a fresh reconcile pass, so on a large library it is not free, and it is still the only correct answer: the core reads its watch set once, at start, and there is no word in the six-word vocabulary that means "watch this too". And **a removal costs a batch in flight nothing**: the drain uploads every file already in the queue, including files from the folder being dropped, because the ledger entry is written after the upload and an abandoned batch is a file uploaded twice.

**The window.** Each folder removes from its own row behind a confirm sentence that says what removing does *not* do, and the add sits below the list and goes through `ipc::pick_folder`. `add_watched_folder` and `remove_watched_folder` are the first commands that take a path from a page, and they take it under the rule the design already had: the string is one the page received, from the picker or out of the core's own snapshot, and this process does not read it, write it, open it or stat it. It becomes one element of an argument vector and the core applies the rule it applies to a path a terminal user typed.

**One defect the extraction found.** `askWatchChoices` refused a duplicate with an exact string match while the writer collapses two spellings of one Windows folder into one entry. So `D:\Photos` and then `d:\photos` was accepted, answered with "Subfolders are included." as though it had taken, and then dropped on the way to disk: a typed answer taken, acknowledged and silently discarded. One comparison now, in `watch-dirs.ts`, used by the validator and by `dedupePaths`.

**Languages are scaffolded and not translated.** Page chrome strings move to `app/ui/locales/en.json` and are read through a tiny `t()` helper in `app/ui/i18n.js`, and a language switcher slot sits top right of the setup page and stays hidden while English is the only locale. What this does **not** touch, listed so nobody reads the scaffold as a promise: the core's event prose, the Rust tray strings, the toast titles and bodies, and right-to-left layout. Why in this order: **the cost of putting a string in a table is small and constant, and the cost of finding every string afterwards is the one that grows.** And a switcher with one language in it is a promise that can be kept, while a half-translated window is not: a person who picks their language and gets two thirds of a page has been told something false about how finished this is. Hence the hidden slot rather than a visible menu with one entry.

**Windows open centered.** A window is created on demand and destroyed on close, and a destroyed window remembers nothing, so "wherever Windows puts it" is a different place on every open. For the first-run window that is a window a new user has to go and find on a screen they were not looking at. Centered is the one predictable position that costs no persisted state.

Also in round 2: the casing law and the rename of the main window to "Photo Pigeon: Status" (section 0), the tray's "Initial setup..." label with its id frozen (section 3), and the multi-folder handover (section 3).

**Four defects came out of round 2, and all four are one shape: a promise no test was in a position to check.** Three were about `app/ui`, where nothing had ever run a page, and the fourth about the IPC list, where nothing had ever read it.

1. **`status.js` had not parsed since the merge, so the main UI was a blank window wearing its own placeholder words.** A comment's opening `/*` was lost in a merge, leaving a bare `*` at the top level: `SyntaxError` at load, no listeners, no poll, and a page whose visible sentence is the one a cold shell writes. Thirty tests over that file passed, because every one of them read it as text.
2. **All three windows failed to load anyway, from the moment the language scaffold landed.** Two classic `<script src>` tags in one document are two scripts in one global scope. `i18n.js` declared `t` there, every page opens with `const t = window.pigeonI18n.t`, and a lexical name over a var scoped one is a `SyntaxError` raised while the page's own script is instantiated. `i18n.js` is one function now and publishes nothing but `window.pigeonI18n`.
3. **The handler list in `lib.rs` carried `ipc::open_watched` twice.** Nothing at runtime breaks on it, and that is the point: the module doc calls that list the complete set of privileged things a page can ask for, and a list holding a name twice is a list nobody has read. It is now pinned from both sides.
4. **A folder edit and a health check waited on a Node start on the thread that draws the app.** `run_core` blocks until the child exits, and a synchronous Tauri command does its waiting on the thread that handled the IPC request, which on Windows is the WebView2 UI thread: 181, 171 and 206 ms measured, with the tray icon, the menu and every `run_on_main_thread` behind it. The trio is async, and reaches `run_core` through `spawn_blocking`, with a sweep that walks every call site to its enclosing function so a fourth command cannot be added on the old pattern.

**The durable half is the test.** `ui-pages.test.ts` compiles every script in `app/ui`, holds the scripts a page loads to disjoint global names, and **loads each page for real** in one context against a thin document, so a page that cannot boot is a red test rather than something found by opening a window. A page reaching for a DOM call the stub does not have fails there naming the call. `i18n.test.ts` gained the sweep that runs the other way, from the DOM back to the table, which is the only direction that can see a sentence with no key at all.

Two more rules from the independent pass over the same branch: **a refused click still answers** (two busy guards swallowed a click in silence, which is the exact silence the folder edits refuse to accept from the core, handed back by the page itself), and **an unkeyed-string sweep has to read fallback literals too**, because `|| 'Starting up'` was the one page sentence a sweep anchored on the equals sign could not see.

**The IPC surface is fourteen commands** and `capabilities/default.json` did not grow across any of the round's four additions, which is the part worth reading: a page that can pause the engine and change what is watched holds no permission it did not hold before.

### M5 · Release engineering

M5 is the first milestone whose work is not mostly code and the first that cannot be finished by a machine alone. Half of it is a form, a password manager, a browser and a pair of eyes. **So every row says whose hands it needs**, because an unassigned row in a release list waits for the other party forever.

Read **maintainer** as: it needs an identity, an account only the maintainer can sign into, a screenshot of a machine in a state nobody can fake, or a judgement. Read **machine** as: it can be built and proved by whoever is working, with a test where a test is possible.

| # | Row | Hands |
|---|---|---|
| 1 | Updater keypair generated | machine |
| 2 | The private key backed up offline, before the first release | **maintainer** |
| 3 | The two CI secrets set from that key | **maintainer** |
| 4 | `tauri-plugin-updater` wired: check on launch and every 24 hours, `download()` in the background, `install()` from the quit path only | machine |
| 5 | The quit-path install proved on a real update | machine, watched once by the **maintainer** |
| 6 | The mid-delivery attempt proved to wait | machine |
| 7 | GitHub Actions running the release road on a tag | machine |
| 8 | The version-mismatch check, with the tag joining the lockstep | machine |
| 9 | The npm granular automation token | **maintainer** |
| 10 | The unsigned-wall text: README, Release page, first-run window | machine |
| 11 | The real SmartScreen screenshot | **maintainer** |
| 12 | Uninstall leaves `~/.photo-pigeon` alone, with an assertion | machine |
| 13 | The stale-installer sweep of `target/release/bundle/nsis/` | machine |
| 14 | README: installer instructions beside the npx instructions | machine |
| 15 | The front-door artwork | machine |
| 16 | The GitHub repo created and pushed | **maintainer** |
| 17 | The tag, the Release, and the installer attached to it | machine on the tag, **maintainer** presses it |
| 18 | `npm publish` | machine in the pipeline, **maintainer** holds the token |
| 19 | The SignPath Foundation application submitted | **maintainer** |
| 20 | The fresh-user walk and the install matrix in `app/e2e/CHECKLIST.md` | **maintainer**, and it is the pre-publish must |

**Rows 1 to 3, the keypair.** `tauri signer generate` makes a minisign keypair; the public half goes into `tauri.conf.json` and is committed, the private half and its password become the two CI secrets. **An installed copy can only ever be updated by a build signed with this key, so losing it strands every user on the version they have, forever, with no recovery but a fresh installer downloaded by hand.** The backup is offline, in a password manager, and it happens **before** the first release rather than after, because the day the key matters is the day it is already gone.

**Rows 4 to 6, the updater, and this is the row that needs a real second version.** The policy is in section 5. Testing it needs two builds and an endpoint, so the shape is: install `0.1.0`, publish `0.1.1` with its updater artifacts, let the installed copy find it on its own rather than being told to. Two named proofs, and neither is satisfied by an update that merely worked:

- **The quit-path install.** An update is downloaded and waiting; the user quits during a delivery; the drain completes; the ledger has the line; and only then does the installer appear.
- **The mid-delivery wait.** An update is ready while a `batchCreate` is in flight and **nothing installs.** This is the falsifier, so it has to be attempted deliberately: a passing run here looks exactly like a run where the updater was never wired at all, which is why row 5 has to pass too.

**Rows 7 and 8, CI.** Two ordering facts CI cannot guess: the sidecar staging must run **before** the Rust build, because `tauri.conf.json` names `binaries/` and `resources/` and a fresh clone has neither; and `tauri-action` is called directly rather than through the npm scripts that carry the `prebuild` hook. The version lockstep is already enforced by `build.rs`, and what M5 adds is the tag as the third thing that can disagree.

**Rows 10 and 11, the unsigned wall, and the screenshot is the work.** Section 5 has the text and the reason the screenshot cannot be taken on a machine that has already trusted the file.

**Row 12, the uninstaller, and the good news is structural.** Section 5 has the confinement list and the deliberate opposite the checklist asks for.

**Row 13, the stale installers.** The bundle output directory can hold installers from different builds, and **two near-identical installers side by side is how the wrong file ships.** The sweep is: clear the directory before the release build, and treat anything found in it afterwards that is not the build just made as a bug in the release script rather than as a leftover.

**Rows 14 and 15, the README.** The npx instructions were already there. What was missing was the installer half and every image.

**Rows 16 to 18, the publish.** `package.json` names the repository, homepage and bugs URLs, so the name has been decided since the manifest was written. The npm account uses passkey 2FA, so CI needs a granular automation token, and `--provenance` needs the workflow's OIDC permissions set alongside it. The Release carries the installer, the updater artifacts and the manifest the updater endpoint reads, which is why the endpoint can be a static URL under `releases/latest/download/`.

**Row 19, SignPath, and there is a name question to answer with the form open.** The eligibility table in section 5 passes on every line, and the ordering is understood. What is deliberately not decided in advance: **the form asks for a project name and this product has four.** The display name "Photo Pigeon", the npm and machine name `photo-pigeon`, the repository path, and the bundle identifier. Section 0 freezes all four for their own reasons and none of them is wrong to put on a form, but they are not interchangeable once a certificate exists. Decide it at application time and record the answer in section 0 beside the frozen list.

**Row 20 is the pre-publish must.** A machine with no config, a person who never opens a terminal, and a first delivery. **Nothing publishes before it is walked**, because the exit criterion is about a stranger and the only way to test a stranger's path is to walk it as one. The one thing that cannot be borrowed: a machine that already holds an install, a Run value, a real ledger and a file Windows has already watched somebody run is not the fresh one and cannot be made into one.

**For v0.1.0 the maintainer waived that order on 2026-07-31**, with the sandbox matrix green at 122/0 behind it, and the walk moved to the far side of the publish: section 1 of the M5 pass runs against the public Release, and what it finds ships as v0.1.1. The rule is not softened for the next version, and the waiver is dated so it cannot be read as one.

*Exit: a stranger can download an installer from a GitHub Release, get past SmartScreen because the page told them how, and back up a folder.*

**What M5 built against that plan:**

- **The updater is wired**, under the policy in section 5, and the shipped public key is a **clearly marked throwaway** until the real keypair exists, because the real one is generated by the maintainer with their own passphrase into their own password manager. The discipline is what makes that safe rather than sloppy: the marker is the key id, it is greppable, the swap is one string in one file, and the release runbook's step is not finished until the search comes back empty. The consequence being guarded against: **a public key committed without its private half in the secret store ships an update that downloads and then refuses to install, for every user, at once.**
- **CI has two roads**, described in section 5, and the tag road ends in a draft.
- **The README carries the unsigned wall**, with the SmartScreen screenshot above the download link, the two words in the order a user needs them, and no apology anywhere near it. It also carries the SignPath consequence in words: a softened wall with an unfamiliar name behind it is a thing to be told, not to discover. The front door uses the setup wizard's own line drawings rather than product screenshots, copied out to `docs/art/`: a drawing does not go stale the day Microsoft ships a redesign, and the guard on it asserts that nothing may be pointed at that is not in the tree.
- **A disposable-Windows sandbox rig gives the install matrix a venue.** Install over install, uninstall and reinstall, and the uninstaller's confinement are all things only a machine holding a live ledger could otherwise host, which is exactly the machine that must not host them. Two things the rig is not. It is not a stranger, so the fresh-user walk is still a human walk. And a file copied into a disposable machine carries no mark of the web, so **the SmartScreen wall does not appear for a file that was not downloaded there**: a pass where the wall never showed up is a machine that was not fresh, not a machine that was fine.

**One machine gate arrived late in M5, and it is the shape worth keeping.** The tag road's preflight asked whether the signing secret is set. Nothing asked **which** key, and the only guard in the repo asserted that the throwaway public key is still in place, so it was green in exactly the state that is dangerous and red when the swap is done right. The dangerous state is one forgotten step: both secrets set, the swap not done, and every gate green (preflight, lockstep, both suites, a real signature over a fake key's promise, a manifest, and a draft that looks perfect). What ships trusts a key nobody signs with, so every daily update check downloads and fails verification, and a failed check is one log line with no toast and no attention state. Silent, permanent, and unfixable without a hand-downloaded installer. **The tag road now decodes `plugins.updater.pubkey`, refuses the known throwaway by id, and asserts the value is a minisign public key at all.** Tag only, so local builds are untouched. The id stays in that file forever, because a denylist of one dead keypair is what it is.

One claim this document and the runbook both made turned out to be false, and it is worth stating correctly: **the pipeline can see both halves of the key at once even though no test can.** The pinned Tauri CLI derives the public half of the signing secret and compares it to `plugins.updater.pubkey`, and it has a sentence for the disagreement. Whether it fails the build or only warns was not established, so the runbook treats it as the loudest available signal and not as a gate.

**Two open items carried out of M5**, named rather than quietly carried: `add_watched_folder` accepts any string a page sends and nothing pins it to a `pick_folder` result (not exploitable today, since the core revalidates and argument injection was probed dead, but a one-shot nonce on the picker's return would close the class structurally); and the core accepts a parent or a child of an already watched folder, so overlapping trees mean two watchers over the same files and an inflated "already had" counter, with double upload still impossible because of the ledger. An overlap rule in `checkWatchDir` closes it.

### v0.2 · Languages, properly

The scaffold reaches page chrome and nothing else. This milestone is the rest of it, in the order the work actually falls:

1. **Core events carry message keys with English fallback text.** Every sentence a window shows that it did not write is the core's or the shell's: the wizard's prose on `say`, the storage honesty sentence, the status and storage lines off `StatusSnapshot`, every `DoctorCheck` title and detail, and each error either process hands over. The copy law is why the pages render them as received rather than keying them locally, and it is also why they cannot be translated where they land. The shape that fixes it is the one M4 used for `firstEver`: a field on the event, sampled where the truth is. An event grows `key` plus the English `text` it already carries, a window shows `t(key, text)`, and an older core is a stream of untranslated sentences rather than a stream of blanks. `ask` events need the same, and `docs/ASK-PROTOCOL.md` grows the field beside the answer form.
2. **The Rust strings join the same locale files.** The tray menu labels, the tooltip, the four toast bodies, the status and storage lines in `state.rs` and the window titles in `windows.rs`. One catalogue for the whole product, read by both halves, which keeps a translator looking at one file per language rather than at a page file and a menu file that disagree. The tooltip's 127 UTF-16 unit ceiling becomes a per locale check rather than an English one, because that is exactly the kind of thing that only breaks in German.
3. **Two decisions the scaffold deliberately left open**, both because they want a real translator's answer rather than a guess: the diagram labels that quote Windows' and Google's own buttons (More info, Run anyway, Advanced), which a reader's own Windows may name differently; and dates, numbers and byte counts, which want the platform's locale aware formatting rather than a string table.
4. **Pages await the table before their first paint.** `i18n.js` resolves its locale asynchronously, so a string a page builds during its own load is read from an empty table. Harmless in English, one English word for the length of a load in anything else.

**A translation is one file**, and the contract is in `CONTRIBUTING.md`: copy `en.json`, translate the values, add one line to `LOCALES` with the language's name in that language, and leave the keys alone. A missing key falls back to English by design, so a half finished file is a useful contribution and never a broken window. What is not fine is a `{token}` that lost its braces or changed its name: those are the sentence's moving parts and the tests check them. **Credit is part of the deal**, in the README's translator list and in the release notes of the version a translation first ships in.

*Exit: somebody who does not read English gets from the installer to a first delivery, and the only file they had to touch to make that possible for their language was one JSON file.*

### M6 · Optional, later: macOS

The core is portable already, and the Node sidecar becomes a second target triple rather than a rewrite. Tray becomes a menu bar item, template images finally apply, autostart uses a LaunchAgent, and `ActivationPolicy::Accessory` keeps the app out of the Dock. Notarisation is a separate cost and a separate decision, and unlike Windows there is no More info button behind which an unsigned app can hide.

---

## 7. What the tray must never do

A short list, because it is easier to check than a long one.

- Ship a client id or a secret, in any form, encoded or otherwise.
- Request a scope wider than `photoslibrary.appendonly`.
- Render Google's consent page in a `WebviewWindow`.
- Write to the ledger, the token, the quota counter or the album cache. Only the core process writes.
- Add a rescan on a timer.
- Kill the child process without asking it to drain first.
- Delete user data on uninstall without an explicit, unticked-by-default choice.
- Toast per file.
- **Bundle a private browser runtime.** Use the platform's own webview and nothing else: WebView2 on Windows, WKWebView on macOS. No Electron, no CEF, no bundled Chromium, no headless browser pulled in as a dependency for rendering, for a screenshot, or for anything else. This is the general form of the law behind section 1: a background tool does not get to carry its own browser.
- Apply an update while a delivery is in flight. Download in the background, install from the quit path after the drain, never in between.
- Send the core a word it does not answer. The vocabulary is the six lines in section 2's table plus the one setup form in `docs/ASK-PROTOCOL.md`, and a swallowed command is how a shell ends up timing out and reaching for a kill.
- **Let anything other than a user gesture send `rescan`.** It is Deliver now. A timer that sends it is law 2 broken by a different spelling.
- **Write an unquoted path into the Run key.** The installed path contains a space on every machine, so an unquoted value is not a rare failure, it is a tool that silently never starts.
- Claim in a menu label or a toast that the core keeps working after the shell leaves, unless the shell actually sent `detach` and saw `{"type":"detached"}` come back.
- **Guess which watched folder somebody meant.** One folder opens. More than one hands over to the status window, where they all have rows. A silent guess is worse than a handover because it looks like an answer.
- **Report a config change as done before the core has been restarted onto it.** A watch set is read once, at start. Until the restart, the new folder is a line in a file and not a folder anybody is watching.

---

## 8. Decision log

The decisions the design turned on, what each one answered, and where the design that came out of it lives. Entries keep their numbers, because code comments cite them by number.

**1. Shell technology.** Electron at 150 to 250 MB resident, versus Tauri 2, versus a headless core with a native tray helper. **Tauri 2, tray-first, no window at idle, and Electron is out.** Resident memory is a design constraint rather than a tuning parameter, and a Tauri app with zero windows has no webview process at all. Budget: shell idle **15 MB target, 25 MB reopens the decision**, with the Node core budgeted separately at 40 to 80 MB while watching. The fallback above 25 MB is the native tray helper, never Electron. Section 1.

**2. Process shape.** In-process library, or the core as a child process. **Child process, running the CLI's own code path. One pipeline in this repo.** A sidecar over NDJSON on stdout and bare words on stdin. Section 2.

**3. First run.** Terminal wizard, or the tray's own window. **Its own window**, which is why `steps.ts` puts its prompts behind an injectable `ask` seam. Section 3, and `docs/ASK-PROTOCOL.md`.

**4. Versioning.** Lockstep, or decoupled CLI and app versions. **Lockstep. One tag, one number.** The "consumer apps start at 1.0" instinct was heard and set aside, because decoupling later is easy and re-merging two version lines is not. The version lives in one file and a build fails on drift. Section 5.

**5. Code signing.** Spend money on a certificate, or ship unsigned. **Launch unsigned with the SmartScreen wall documented, and apply to SignPath Foundation as a build step.** SignPath requires the project to already be released in the form to be signed, so shipping unsigned first is a prerequisite and not just a saving. Paid options are recorded in section 5 as future options, not proposals. Section 5.

**6. Start with Windows.** Default on, or ask first. **Default on, one visible line saying so, one-click toggle.** A backup tool that does not run is not a backup tool. Section 4.

**7. Auto-update.** On by default, or opt in. **On by default. Background download, apply on next launch, never mid delivery, never a forced restart.** The mechanism is the Tauri v2 updater plugin reading a static manifest on GitHub Releases, and the v2 split between `download()` and `install()` is what makes the never-mid-delivery rule implementable rather than aspirational. Section 5.

**8. Rehash on every start.** Does the path plus size plus mtime side index ship, given that a tray makes every logon a start? **Yes.** The side index skips re-hashing unchanged files; the content hash stays authoritative for anything new or changed, and a missing or corrupt index falls back to a full pass rather than trusting itself. Section 6, M1.

**9. The display name.** Does a consumer app keep a terminal tool's name? **Humans read "Photo Pigeon", machines keep `photo-pigeon`.** The frozen identifier list, and the one identifier that does move along with its blast radius, are in section 0.

**10. The icon.** Is the mascot final? **Frozen. The committed set ships as it is, and no icon work is in scope.** Measured afterwards, because it removes the one argument that could have reopened it: the recut set costs 0.01 MB of idle memory against the art it replaced, which is noise. Section 6, M3.

**11. Feature-complete outranks polish.** Asked implicitly by every milestone that could be extended instead of finished. **Finish the milestone.** A shell that survives a reboot and tells the user when it needs them is worth more than a prettier one that does not, and this is the tie-breaker for anything a milestone is tempted to add.

**12. The RAM budget's metric.** The shell measures 32 MB of working set after a day of use and 3.9 MB of private working set. Which one did the 15 and the 25 mean? **Private working set. Total working set stays an observation, never a trigger.** The numbers did not move; the column they are read against did. Worst observed against the metric: 3.85 MB. Section 1.

**13. What "first ever" means for the one happy toast.** A flag in the shell's own state file, or an empty ledger? **The ledger was empty before that delivery.** Core-owned truth, so the shell is told rather than remembering. The migration and the ordering trap that comes with it are in section 3's notifications.

**14. How finished the first UI has to be.** The first-run and health windows are the first surfaces a stranger ever sees. Draft, or final? **A designed draft, reshaped afterwards.** Designed means real copy, real states, the laws held exactly, and nothing anywhere that says "TODO" to a user. Draft means no layout choice in it is defended on the grounds that it shipped. It does not soften decision 11.

**15. What the tray is for, now that there is a window.** Is the status window a read-only report with the controls staying in the menu, or is it the main UI? **The main UI, and a full control surface.** The function split it settles is a law at the top of section 3: the tray is the glimpse and the quick hand, the window is the instrument panel. Its first consequence is that a tray click which would have to guess hands over to the window instead.

**16. Whether watched folders can be changed outside setup.** Ship an editor, or leave setup as the only route? **It ships, with the core-restart wiring.** The wiring is not a nicety attached to the feature, it is the feature: **a config change the core has not been restarted onto has not happened**, and the surface may not report success until the restart has. The restart is a stop with a drain, never a kill. Section 6, round 2, and section 7.

**17. When this product learns other languages.** English only and revisit, or start now? **Scaffold now, translate at v0.2.** Putting a string in a table is cheap and constant while finding every string afterwards is the cost that grows, and a switcher with one language in it is a promise that can be kept where a half-translated window is not. Core event prose, the Rust strings, the toasts, the translator guide and RTL are a named v0.2 milestone.

**18. Casing.** How far does a window's Title Case reach into the window? **Two tiers. Branded Title Case for a window's own title, sentence case for everything inside it.** A title bar is the product introducing itself in a taskbar full of other products; the inside of a window is one person being spoken to. Section 0.

**19. A previous-step button in setup.** Build it for v0.1? **Not built, and recorded rather than forgotten.** It is not a button: `docs/ASK-PROTOCOL.md` has no back edge, and its absence is structural rather than an omission, because ids count up and are never reused, exactly one question is open at a time, and a refused answer re-asks the same id. Reopening a settled question means either minting a new id for an old question or breaking rule 1, so it is a protocol change in the core, and whoever wants the button owns it. The narrower case it serves is already served twice over: the core re-asks anything it refuses, and closing the window ends a run that has written nothing.
