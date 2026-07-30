//! The fourteen commands a window may call, and nothing else.
//!
//! This is the whole surface between a page and this process. It is small on
//! purpose and it is the *only* privileged thing a page can reach: no plugin
//! command is granted to any webview, so every capability below is a Rust
//! function that decides for itself.
//!
//! ## Why these fourteen and no fifteenth
//!
//! TRAY-DESIGN section 4 records the rule for `capabilities/default.json`: it
//! grows one permission at a time, each with a written reason. The same rule
//! applies here, in the direction that matters more. A command is the thing a
//! compromised or merely buggy page can call, so the list is an allowlist of
//! *actions*, not of *resources*:
//!
//! * nothing takes a path from the page and acts on it *here*. `open_path`
//!   takes a kind, and the path comes from the core's own `started` event or
//!   from the shell's log path. `open_watched` takes an index into a list this
//!   shell itself published, resolved on this side; it also takes the path that
//!   row was showing, and that string cannot open anything, it can only refuse.
//!   A page cannot name a file for this process to open, read or write.
//! * the two exceptions take a path and *do nothing with it except hand it to
//!   the core to validate*, which is the same trade `pick_folder` and the setup
//!   page have made since M4 and is written out at
//!   [`add_watched_folder`]. Nothing in this process reads, writes, opens or
//!   stats the string; it becomes one element of an argument vector, and the
//!   core applies the rule it applies to a path a terminal user typed.
//! * nothing takes a URL from the page. There is no command that opens one,
//!   and window creation is a closed enum of two local files
//!   (`windows.rs`), which is where the OAuth law is enforced structurally.
//! * nothing writes the ledger, the token, the quota counter or the album
//!   cache. Only the core writes those, and the core is not reachable from a
//!   page except through `setup_answer`, which is a line on a pipe the shell
//!   framed itself.
//! * nothing can delete or mutate anything at Google. There is no code in this
//!   app that could: the scope is `photoslibrary.appendonly`.
//!
//! ## The four of round two, and the reasons they are allowed to exist
//!
//! All four arrived with the status-window reshape, which makes the
//! status window the main UI and a full control surface rather than a pair of
//! read-only views. The first two do not grow the *kind* of thing a page can do
//! at all; the second two are the exception above and carry their own argument
//! at [`add_watched_folder`].
//!
//! * **`engine_action`** takes one of exactly three words and maps them onto the
//!   supervisor paths the tray menu's own items already send. The page can only
//!   press buttons the tray already has, and it presses them through the same
//!   wire: the supervisor still decides what a press means, and `state.rs` still
//!   owns every label and every enabled flag, so neither surface can offer
//!   something the other would refuse. What it deliberately cannot say: `stop`,
//!   `detach`, `quit`, or the core's own words. A page may not end the run or
//!   make this process leave, and `EngineAction::parse` refuses those by name.
//! * **`open_watched`** takes an index into the watched folder list the shell
//!   published in its own snapshot, and the folder is resolved on this side. It
//!   is the same privilege `open_path("watched")` already had, minus the guess:
//!   the menu item could only ever open the first folder, and each folder has
//!   its own row in the window now. A page still cannot name a path: the path it
//!   sends beside the index is the row's account of itself, checked against the
//!   resolution and never used as one, because an index alone opens the wrong
//!   folder when the list shrinks from the front inside the poll lag. An index
//!   that no longer exists, and a row that no longer says what it said, are both
//!   a sentence rather than a panic.
//! * **`add_watched_folder`** and **`remove_watched_folder`** are the two
//!   exceptions to the first bullet, and they carry their own decision:
//!   editing the watched list stopped being a first-run-only privilege. Each
//!   runs the core's own `folders add|remove --json`, hands the core's answer
//!   back to the page unchanged, and restarts the engine only when the core says
//!   the file really moved. The written argument for why a path may cross this
//!   seam at all is at [`add_watched_folder`], and the reason it can never be a
//!   delete at Google is at [`remove_watched_folder`].
//!
//! ## The one that is not obvious
//!
//! `doctor_report` runs the core rather than reimplementing it. `DoctorReport`
//! has carried `checks` with a level each since the first version of
//! `src/wizard/doctor.ts`; only the command layer ever flattened it into a
//! block of terminal text. So this is a passthrough past the flattening, which
//! is why the health window and `photo-pigeon doctor` can never disagree about
//! what is wrong.
//!
//! The same shape covers the two folder editors: they run
//! `photo-pigeon folders add|remove --json`, which is the core's own editor for
//! the file the core owns, so the window and `photo-pigeon folders` can never
//! disagree about what a folder is or about how many have to stay.

use std::process::{Command, Output, Stdio};

use tauri::{AppHandle, Manager, State};

use crate::paths::{self, CoreLaunch};
use crate::setup_host;
use crate::supervisor::{watched_row, StatusSnapshot, SupervisorHandle, UiCommand};
use crate::windows::Page;

/// What `open_path` is allowed to open. A kind, never a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenKind {
    Log,
    Watched,
}

impl OpenKind {
    /// Parse the one string a page may send. Anything else is refused by name.
    pub fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "log" => Ok(OpenKind::Log),
            "watched" => Ok(OpenKind::Watched),
            other => Err(format!(
                "{other:?} is not something this app opens. The kinds are \"log\" and \"watched\"."
            )),
        }
    }

    fn command(self) -> UiCommand {
        match self {
            OpenKind::Log => UiCommand::OpenLog,
            OpenKind::Watched => UiCommand::OpenWatchedFolder,
        }
    }
}

/// What a page may ask the engine to do. A word, and one of exactly three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineAction {
    Pause,
    Resume,
    Deliver,
}

impl EngineAction {
    /// Parse the three words a page may send. Anything else is refused by name.
    ///
    /// The list is short because it is the tray menu's own list. What is missing
    /// from it is the point: `stop`, `detach` and `quit` are not here, so a page
    /// cannot end the run or make this process leave, and neither are the core's
    /// own stdin words, because a page does not talk to the core.
    pub fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "pause" => Ok(EngineAction::Pause),
            "resume" => Ok(EngineAction::Resume),
            "deliver" => Ok(EngineAction::Deliver),
            other => Err(format!(
                "{other:?} is not something this app asks the engine to do. \
                 The actions are \"pause\", \"resume\" and \"deliver\"."
            )),
        }
    }

    /// The supervisor path this word takes, which is the tray menu's path.
    ///
    /// **Pause and resume are one command and that is deliberate.** The tray has
    /// a single action item wearing several labels, and the supervisor decides
    /// from the state which of them a press means: pause a running engine, resume
    /// a paused one, retry a halted one. The status window renders one button off
    /// the same label, so the two surfaces show the same word. Forking that
    /// decision so a page could name the branch would let a page's picture, which
    /// is up to one event stale, pause an engine that is already paused. Two
    /// words rather than one because the page says the thing its button said,
    /// which is legible in a log; one path because there is one decision.
    ///
    /// Deliver is its own item in the menu and its own path here, and it is the
    /// one that writes a core word: `rescan`, once, because somebody pressed a
    /// button. TRAY-DESIGN law 2 stands, and this command is a gesture on a
    /// window rather than a timer, exactly as the menu item is.
    fn command(self) -> UiCommand {
        match self {
            EngineAction::Pause | EngineAction::Resume => UiCommand::Action,
            EngineAction::Deliver => UiCommand::DeliverNow,
        }
    }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

/// Spawn the wizard on the machine channel. Every line it says is forwarded
/// raw to this window on the `setup-event` channel.
#[tauri::command]
pub fn setup_start(app: AppHandle) -> Result<u32, String> {
    setup_host::start(&app)
}

/// Answer the open question. The one payload-carrying form in this project.
#[tauri::command]
pub fn setup_answer(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    setup_host::answer(&app, payload)
}

// ---------------------------------------------------------------------------
// the folder picker
// ---------------------------------------------------------------------------

/// The native folder dialog. Returns an absolute path, or null if cancelled.
///
/// This is the one command that hands a page something it did not already
/// know, and it is safe for the reason the whole design rests on: the path
/// goes back to the page, which sends it to the core as an ordinary answer,
/// and the core validates it exactly as it validates a path a terminal user
/// typed. Nothing here reads or writes it.
///
/// `tauri-plugin-dialog` is a new dependency at M4 and the first one added
/// since M2. Its IPC permissions stay ungranted: the page cannot call the
/// plugin, it calls this, which is a Rust function that takes no arguments.
///
/// **It is `async` for a reason that has nothing to do with Google.** A
/// synchronous command runs inline on the thread that handled the IPC request,
/// which on Windows is the WebView2 UI thread, and waiting for a dialog there
/// parks the main thread for as long as the picker is open: no deadlock,
/// because the dialog is drawn on a thread of its own, but tray renders and
/// every `run_on_main_thread` wait sit behind a folder chooser somebody may
/// leave open for a minute. Async hands the wait to the async runtime instead,
/// which is what the plugin's own documentation asks for.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Which folder should the pigeon watch?")
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.display().to_string())
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/// The health check, as the core's own structured report.
///
/// **`async` for the same reason [`pick_folder`] is**, and with more at stake: a
/// synchronous command runs inline on the thread that handled the IPC request,
/// which on Windows is the WebView2 UI thread, and this one waits for a whole
/// core run to finish. That is a Node start plus every check the doctor makes, a
/// fifth of a second when nothing is wrong, and while it lasts the tray icon, the
/// menu and every `run_on_main_thread` wait behind a health check. Async hands
/// the wait to the async runtime instead. It is not shorter, it is elsewhere.
///
/// And [`run_core_off_thread`] is where "elsewhere" is: the blocking pool, not a
/// runtime worker. See its own note.
#[tauri::command]
pub async fn doctor_report(app: AppHandle) -> Result<serde_json::Value, String> {
    let (launch, config) = core_and_config(&app)?;
    let args = launch.doctor_args(config.as_deref());
    let output = run_core_off_thread(launch, args).await?;
    // Exit code 1 means "something needs fixing", which is a report and not a
    // failure: the report is on stdout either way and the page renders it.
    // Only an unparseable stdout is a failure here.
    parse_doctor(&String::from_utf8_lossy(&output.stdout))
}

/// Where the core is and which config it may touch.
///
/// The same rail the watch spawn and the setup spawn run on, and the reason is
/// the same one: a build under a config override must not be able to read or
/// rewrite the real install, and a window that reports on a folder set this tray
/// is not watching is answering a question nobody asked.
fn core_and_config(app: &AppHandle) -> Result<(CoreLaunch, Option<String>), String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::PathBuf::from));
    let resource_dir = app.path().resource_dir().ok();
    let launch = paths::resolve_core(exe_dir.as_deref(), resource_dir.as_deref())?;
    let config = match paths::config_choice() {
        paths::ConfigChoice::Explicit(path) => Some(path),
        paths::ConfigChoice::CoreDefault => None,
        paths::ConfigChoice::Refuse(why) => return Err(why),
    };
    Ok((launch, config))
}

/// Run the core once from the pool that exists for waiting, and hand back what
/// it said.
///
/// **The one place [`run_core`] is called from, and the reason is the difference
/// between two kinds of "not on the drawing thread".** Round two's fourth defect
/// was these commands blocking the WebView2 UI thread, and `async` closed it: the
/// tray icon and the menu no longer queue behind a health check. But the body of
/// an `async fn` runs on a tokio worker, and `Command::output()` parks whichever
/// worker it landed on for the whole run. The multi-thread runtime has one worker
/// per core, not one per waiting command, so on a small machine a health check
/// and a folder edit can hold every worker there is, and what queues behind them
/// is every other async thing this process does. Nothing visibly breaks, which is
/// what makes it worth a rule rather than a comment.
///
/// `spawn_blocking` is the primitive for a wait that is not a future: its own
/// pool, grown on demand. The wait is no shorter. It is somewhere that expects it.
///
/// Owned arguments rather than borrowed, because the closure outlives this call
/// and a `State<'_, _>` borrow could not have crossed into it anyway: the two
/// folder editors keep their supervisor handle on this side of the await and use
/// it after the core has answered.
async fn run_core_off_thread(
    launch: CoreLaunch,
    args: Vec<std::ffi::OsString>,
) -> Result<Output, String> {
    tauri::async_runtime::spawn_blocking(move || run_core(&launch, args))
        .await
        // A join error is the pool itself failing, which is not something a page
        // can act on, so it says what happened rather than pretending the core
        // answered.
        .map_err(|err| format!("the engine run could not be waited for: {err}"))?
}

/// Run the core once and wait for it. No stdin, no console window, no shell.
///
/// Blocking, and called only from [`run_core_off_thread`], which is what puts the
/// block on a thread that is allowed to have one.
fn run_core(launch: &CoreLaunch, args: Vec<std::ffi::OsString>) -> Result<Output, String> {
    let mut command = Command::new(&launch.program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // A tray app must never flash a console, and these are the two spawns a
    // person triggers by clicking something in a window.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.output().map_err(|err| format!("{err}"))
}

/// The last non-empty line of stdout, parsed.
///
/// A line rather than the whole buffer, and the last rather than the first,
/// because the core writes exactly one JSON line under `--json` and anything
/// else that reached stdout would be a bug worth surviving rather than a
/// reason to show a page with nothing on it.
pub fn parse_doctor(stdout: &str) -> Result<serde_json::Value, String> {
    last_json_line(stdout, "the health check")
}

/// The one JSON line a `--json` run leaves on stdout, whoever asked for it.
fn last_json_line(stdout: &str, what: &str) -> Result<serde_json::Value, String> {
    let line = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .ok_or_else(|| format!("{what} said nothing"))?;
    serde_json::from_str(line).map_err(|err| format!("{what} was unreadable: {err}"))
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/// Session counters, the watched folders, and a bounded ring of recent events.
///
/// Read out of a published copy rather than by asking the supervisor, so a page
/// can never block on a thread that is busy draining a batch.
#[tauri::command]
pub fn status_snapshot(supervisor: State<'_, SupervisorHandle>) -> StatusSnapshot {
    supervisor.snapshot()
}

// ---------------------------------------------------------------------------
// start with Windows
// ---------------------------------------------------------------------------

/// What the registry says, never what this process would like it to say.
///
/// A live read rather than the supervisor's snapshot. The snapshot refreshes
/// on the render after a write lands, so a page reading it immediately after
/// `autostart_set` sees the world from before its own click, which is the M4
/// review's second critical. The registry has no such lag, and
/// `Autostart::resolve` here is the same resolution `lib.rs` hands the
/// supervisor, so the two can never read different value names.
#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    crate::autostart::Autostart::resolve(&app.package_info().name).is_enabled()
}

/// Ask for a value. The registry still decides, and the next snapshot says
/// what really happened.
///
/// Routed through the supervisor rather than writing here, because the
/// supervisor owns the `Autostart` and the menu tick has to follow: the tick
/// lives behind two caches and correcting it is what the M3 review's third
/// critical was about. One owner, one correction path.
#[tauri::command]
pub fn autostart_set(supervisor: State<'_, SupervisorHandle>, on: bool) {
    supervisor.send(UiCommand::SetAutostart(on));
}

// ---------------------------------------------------------------------------
// opening things
// ---------------------------------------------------------------------------

/// Open the log, or the watched folder. A kind, never a path.
#[tauri::command]
pub fn open_path(supervisor: State<'_, SupervisorHandle>, kind: String) -> Result<(), String> {
    let kind = OpenKind::parse(&kind)?;
    supervisor.send(kind.command());
    Ok(())
}

/// Open one watched folder, named by its row in the shell's own list.
///
/// Project decision: each watched folder opens from
/// its own row, because a single button had to guess which folder it meant and
/// it guessed the first one. That guess is only invisible on a machine watching
/// exactly one folder.
///
/// An index and not a path: the page is pointing at a line of a list this
/// process published, which came from the core's own `started` event, and this
/// process is what turns that line back into a folder. A `usize` cannot be a
/// traversal, a URL, or a file on another drive.
///
/// **The path comes too, and it is not the address.** An index alone is stale by
/// one poll, so a folder removed from the front of the list shifts every row
/// below it while the window still shows the old order, and the click opens a
/// folder the person did not press: the independent pass's banked finding, and
/// [`crate::supervisor::watched_row`] carries the whole argument. The row says
/// what it was showing, this side resolves the index against its own list as it
/// always did, and a disagreement is a refusal. The string cannot become a
/// folder to open: the only thing it can do is stop one from opening.
///
/// Refused here as well as on the supervisor thread, and the two are not the same
/// check. This one reads the published snapshot, which never blocks, so the page
/// gets a sentence back on its own call rather than silence. The supervisor checks
/// again against its live list before anything opens, because a snapshot is a copy
/// and a new config can land between the two.
#[tauri::command]
pub fn open_watched(
    supervisor: State<'_, SupervisorHandle>,
    index: usize,
    path: String,
) -> Result<(), String> {
    let snapshot = supervisor.snapshot();
    watched_row(&snapshot.watch_dirs, index, &path)?;
    supervisor.send(UiCommand::OpenWatchedAt { index, path });
    Ok(())
}

// ---------------------------------------------------------------------------
// the three actions the window shares with the menu
// ---------------------------------------------------------------------------

/// Pause, resume, or ask for one delivery pass. A word, and one of three.
///
/// The status-window reshape: the status window is the main
/// UI and these three live on it. They are the tray menu's own items reached
/// through the same supervisor commands, which is the whole reason this is one
/// command and not three: the page presses what the tray presses, and the
/// supervisor is still the only thing that decides what a press does. See
/// [`EngineAction::command`].
#[tauri::command]
pub fn engine_action(supervisor: State<'_, SupervisorHandle>, kind: String) -> Result<(), String> {
    let action = EngineAction::parse(&kind)?;
    supervisor.send(action.command());
    Ok(())
}

// ---------------------------------------------------------------------------
// cross-navigation between the two windows (the status-window reshape)
// ---------------------------------------------------------------------------

/// The Finish button on setup's done screen: open the status window, close
/// this one. Grown under the one-at-a-time rule: it takes nothing from the
/// page, names no resource, and does what the tray's own menu item does plus
/// a close of the window the click came from. The close goes through the
/// window's own CloseRequested path, so destroy-on-close stays the one exit.
#[tauri::command]
pub fn finish_setup(app: AppHandle, supervisor: State<'_, SupervisorHandle>) {
    supervisor.send(UiCommand::ShowWindow(Page::Status));
    if let Some(setup) = app.get_webview_window(Page::Setup.label()) {
        let _ = setup.close();
    }
}

/// The status window's way into first run when no config exists yet. Same
/// argument as `finish_setup`: nothing taken from the page, the target is a
/// variant of the closed `Page` enum, and the supervisor stays the one owner
/// of window creation.
#[tauri::command]
pub fn open_setup(supervisor: State<'_, SupervisorHandle>) {
    supervisor.send(UiCommand::ShowWindow(Page::Setup));
}

// ---------------------------------------------------------------------------
// the Watching list (the folders lane)
// ---------------------------------------------------------------------------

/// What the two folder editors do to the list. A word, from this side, always.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FolderEdit {
    Add,
    Remove,
}

impl FolderEdit {
    /// The word the core's own command takes. Never taken from a page: a page
    /// calls one of two named commands and this side decides what that means.
    const fn word(self) -> &'static str {
        match self {
            FolderEdit::Add => "add",
            FolderEdit::Remove => "remove",
        }
    }
}

/// Add one folder to the watched list.
///
/// **Why a command may take a path here when nothing else does.** The rule at the
/// top of this module is that nothing takes a path from a page *and acts on it*.
/// This does not act on it. The string is one the page received from
/// [`pick_folder`], which is a native dialog opened from Rust, and it is handed
/// straight back to the core as one element of an argument vector. Nothing in this
/// process opens it, reads it, writes it or stats it, and the core applies exactly
/// the validation it applies to a path a terminal user typed: the folder has to
/// exist, it has to be a folder, and it must not already be on the list. That is
/// the same trade the setup page has made since M4, where the picked path travels
/// back as an ordinary `answer` and the core decides.
///
/// The answer is the core's own JSON line, handed to the page so it can render the
/// core's sentence rather than invent one. Only a line that says the file really
/// moved restarts the engine: a request that changed nothing must not cost a
/// drain and a re-scan.
///
/// **`async`, like [`doctor_report`] and for the same reason**: this waits for a
/// core run, and a synchronous command does its waiting on the thread that draws
/// the app. Both editors are async so that clicking Add or Remove cannot stop the
/// tray for as long as a Node start takes, and both hand the wait itself to
/// [`run_core_off_thread`] so it does not sit on a runtime worker either.
#[tauri::command]
pub async fn add_watched_folder(
    app: AppHandle,
    supervisor: State<'_, SupervisorHandle>,
    path: String,
) -> Result<serde_json::Value, String> {
    edit_watched_folders(&app, &supervisor, FolderEdit::Add, &path).await
}

/// Take one folder off the watched list.
///
/// Same argument as [`add_watched_folder`], with the string coming from the
/// core's own `started` event by way of the status snapshot rather than from the
/// picker, which is the other kind of value a page is allowed to hand back.
///
/// **Nothing already uploaded is touched.** This command cannot reach Google and
/// there is no code in this app that could: the scope is
/// `photoslibrary.appendonly`. It cannot reach the ledger either. A folder leaving
/// the list stops being walked, and everything ever delivered out of it stays
/// delivered and stays recorded. A batch in flight when this lands is finished by
/// the drain the restart asks for, because the ledger entry is written after the
/// upload and an abandoned batch is a file uploaded twice.
#[tauri::command]
pub async fn remove_watched_folder(
    app: AppHandle,
    supervisor: State<'_, SupervisorHandle>,
    path: String,
) -> Result<serde_json::Value, String> {
    edit_watched_folders(&app, &supervisor, FolderEdit::Remove, &path).await
}

async fn edit_watched_folders(
    app: &AppHandle,
    supervisor: &SupervisorHandle,
    edit: FolderEdit,
    folder: &str,
) -> Result<serde_json::Value, String> {
    let (launch, config) = core_and_config(app)?;
    let args = launch.folders_args(edit.word(), folder, config.as_deref());
    let output = run_core_off_thread(launch, args).await?;
    // Exit code 3 means the request changed nothing, which is an answer and not
    // a failure: the sentence is on stdout either way and the page shows it.
    let answer = last_json_line(&String::from_utf8_lossy(&output.stdout), "the folder list")?;
    if rewrote_the_config(&answer) {
        supervisor.send(UiCommand::WatchDirsChanged);
    }
    Ok(answer)
}

/// Did that answer say the file on disk really moved?
///
/// The one decision this side makes about the core's answer, so it is a function
/// with a test rather than a condition inside a spawn. Anything else, including a
/// refusal, a shape this build does not know and a line that is not an object,
/// means the config is what it was: a restart on any of those would cost a drain
/// and a full re-scan for nothing, and the M3 review's second critical is the
/// standing lesson about clearing or spending state on evidence that is not
/// evidence.
fn rewrote_the_config(answer: &serde_json::Value) -> bool {
    answer.get("type").and_then(|kind| kind.as_str()) == Some("folders-changed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_path_takes_a_kind_and_never_a_path() {
        // The rule that makes this command safe: a page names an intention and
        // the shell decides what that means. If it took a path, a page would be
        // an arbitrary file opener wearing a scoped permission.
        assert_eq!(OpenKind::parse("log"), Ok(OpenKind::Log));
        assert_eq!(OpenKind::parse("watched"), Ok(OpenKind::Watched));
        for attempt in [
            "C:\\Windows\\System32\\cmd.exe",
            "..\\..\\token.json",
            "https://accounts.google.com/o/oauth2/auth",
            "LOG",
            "",
        ] {
            assert!(
                OpenKind::parse(attempt).is_err(),
                "{attempt:?} was accepted as a kind"
            );
        }
    }

    #[test]
    fn a_refused_kind_says_what_the_kinds_are() {
        // Answered by name rather than swallowed, which is the same rule the
        // core follows for a word it does not know on stdin.
        let why = OpenKind::parse("desktop").expect_err("refused");
        assert!(why.contains("\"log\""), "{why}");
        assert!(why.contains("\"watched\""), "{why}");
        assert!(!why.contains('\u{2014}'), "em dash in {why}");
    }

    #[test]
    fn nothing_waits_on_a_native_dialog_inside_a_synchronous_command() {
        // tauri-macros runs a synchronous command inline on the thread that
        // handled the IPC request, which on Windows is the WebView2 UI thread.
        // `blocking_pick_folder` then parks that thread in `rx.recv()` for as
        // long as the picker is open. Nothing deadlocks, because rfd draws the
        // dialog on a thread of its own, but tray renders and every
        // `run_on_main_thread` wait queue up behind a folder chooser somebody
        // left open, and the plugin's own documentation says not to do it. An
        // `async` command is handed to the async runtime instead, which costs
        // nothing and removes the class rather than the instance.
        //
        // Read off the source rather than exercised, because what is being
        // asserted is the *declaration*: calling the command for real needs a
        // running app with a webview attached, and the wrapper the macro
        // generates is the only other thing that knows the difference. The
        // sweep is over the module above these tests, so the sentence you are
        // reading cannot answer for itself.
        let source = include_str!("ipc.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("the module above these tests");
        let inline: Vec<&str> = production
            .match_indices("blocking_")
            .map(|(at, _)| {
                let (before, _) = production.split_at(at);
                let (start, _) = before
                    .rmatch_indices("\npub ")
                    .next()
                    .expect("a dialog call inside a command");
                production[start + 1..].lines().next().unwrap_or_default()
            })
            .filter(|signature| !signature.contains("async fn"))
            .collect();
        assert!(inline.is_empty(), "these commands wait on a dialog inline: {inline:?}");
        // The control, so a sweep that found nothing at all cannot pass.
        assert!(
            production.contains("pub async fn pick_folder("),
            "the folder picker is not an async command"
        );
    }

    /// Every command in this file is registered once, and nothing else is.
    ///
    /// The list in `lib.rs` is what this module's doc calls the complete set of
    /// privileged things a page can ask for, and until now nothing checked that
    /// claim. Two ways it can be false and they fail in opposite directions: a
    /// command that exists here and is missing there is a button that silently
    /// does nothing, and a name listed twice is a list nobody has read, which is
    /// how a fifteenth command arrives without the written reason the
    /// one-at-a-time rule asks for. `open_watched` was listed twice.
    ///
    /// Read off the two sources rather than exercised, for the reason the dialog
    /// sweep above gives: reaching the generated handler needs a running app with
    /// a webview attached, and the audit surface is the text either way.
    #[test]
    fn every_command_is_registered_exactly_once_and_nothing_else_is() {
        let ipc = include_str!("ipc.rs");
        let production = ipc
            .split("#[cfg(test)]")
            .next()
            .expect("the module above these tests");
        let mut commands: Vec<&str> = production
            .split("#[tauri::command]")
            .skip(1)
            .map(|after| {
                let signature = after
                    .lines()
                    .find(|line| line.starts_with("pub "))
                    .expect("a command is a pub fn");
                signature
                    .trim_start_matches("pub ")
                    .trim_start_matches("async ")
                    .trim_start_matches("fn ")
                    .split('(')
                    .next()
                    .expect("a name before the arguments")
            })
            .collect();
        commands.sort_unstable();
        assert_eq!(commands.len(), 14, "{commands:?}");

        let lib = include_str!("lib.rs");
        let list = lib
            .split_once("tauri::generate_handler![")
            .expect("the handler list")
            .1
            .split_once(']')
            .expect("a closed handler list")
            .0;
        let mut registered: Vec<&str> = list
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.trim_start_matches("ipc::"))
            .collect();
        registered.sort_unstable();

        // Named as one comparison rather than as two counts, so a failure says
        // which command is missing or which one is there twice.
        assert_eq!(registered, commands);
    }

    /// The same rule as the dialog sweep, for the other thing a command waits on.
    ///
    /// `run_core` spawns the core and blocks in `Command::output()` until it has
    /// exited, which is a Node start plus a config read and write: a fifth of a
    /// second on this machine, measured, and more on a cold disk. Inside a
    /// synchronous command that wait happens on the thread that handled the IPC
    /// request, so every health check and every folder edit stops the tray icon,
    /// the menu and every `run_on_main_thread` for as long as the child runs. It
    /// is the minor that was closed for `pick_folder` at the M4 review's second
    /// pass, arriving again in three commands that wait on something slower than a
    /// dialog nobody left open.
    ///
    /// Async does not make the wait shorter. It moves it off the thread that draws
    /// the app, which is the whole of the fix and is what the plugin's own
    /// documentation asks for. Where the wait went instead is the next test's
    /// property, and the two are deliberately separate: one is about the thread
    /// that draws, the other about the pool that waits.
    #[test]
    fn nothing_waits_on_the_core_inside_a_synchronous_command() {
        let source = include_str!("ipc.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("the module above these tests");
        // The command's own body and nothing past its closing brace. This used to
        // cut at the next attribute, which let a chunk run on through the free
        // functions that follow and through the *next* command's doc comment: a
        // sentence naming the core run read as a wait for it, and the control
        // below counted four commands where there are three.
        fn body_of(after: &str) -> &str {
            match after.find("\n}") {
                Some(end) => &after[..end],
                None => after,
            }
        }
        // `run_core` without its bracket, so the hand-off to the blocking pool
        // counts as reaching the core: a command that called
        // `run_core_off_thread` would otherwise fall out of this sweep entirely
        // and the control below would be the only thing left to notice.
        fn reaches_the_core(body: &str) -> bool {
            body.contains("run_core") || body.contains("edit_watched_folders(")
        }
        let blocking: Vec<&str> = production
            .split("#[tauri::command]")
            .skip(1)
            .filter_map(|after| {
                let body = body_of(after);
                let signature = body.lines().find(|line| line.starts_with("pub "))?;
                (reaches_the_core(body) && !signature.contains("async fn")).then_some(signature)
            })
            .collect();
        assert!(
            blocking.is_empty(),
            "these commands wait on a core run inline: {blocking:?}"
        );
        // The control, so a sweep that matched nothing at all cannot pass: three
        // commands do run the core, and all three are async.
        let running = production
            .split("#[tauri::command]")
            .skip(1)
            .filter(|after| reaches_the_core(body_of(after)))
            .count();
        assert_eq!(running, 3, "the commands that run the core are not three");
    }

    /// The other half of the same property: where the wait actually happens.
    ///
    /// `async` moved these three off the thread that draws the app, which was
    /// round two's fourth defect and is the test above. It did not move the
    /// *block*. The body of an `async fn` runs on a tokio worker, and
    /// `Command::output()` parks whichever worker it landed on for the whole
    /// run: a Node start plus the work, a fifth of a second measured on this
    /// machine and longer on a cold disk. The multi-thread runtime has one
    /// worker per core, not one per waiting command, so on a two core machine a
    /// health check and one folder edit can hold every worker there is, and what
    /// queues behind them is every other async thing this process does.
    ///
    /// `spawn_blocking` is the primitive for a wait that is not a future: its own
    /// pool, grown on demand, sized for exactly this. So the rule is that no
    /// `run_core` call may sit anywhere but inside a `spawn_blocking`, and the
    /// count control keeps the sweep honest from the other side: there is exactly
    /// one such call site, because one function does the handing over and every
    /// command goes through it.
    #[test]
    fn every_core_run_waits_on_the_blocking_pool() {
        let source = include_str!("ipc.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("the module above these tests");

        // The signature this call is written inside, back to its own `fn` word.
        let enclosing = |at: usize| -> &str {
            let before = &production[..at];
            let start = ["\nfn ", "\nasync fn ", "\npub fn ", "\npub async fn "]
                .iter()
                .filter_map(|opener| before.rfind(opener))
                .max()
                .expect("a core run inside a function");
            // Past the newline the opener matched, so the first line of the
            // region is the signature a failure has to name.
            &production[start + 1..at]
        };

        let sites: Vec<&str> = production
            .match_indices("run_core(")
            // Not the definition itself, which is the one place the words
            // `fn run_core(` are allowed to appear.
            .filter(|(at, _)| !production[..*at].ends_with("fn "))
            .map(|(at, _)| enclosing(at))
            .collect();
        let on_a_runtime_thread: Vec<&str> = sites
            .iter()
            .filter(|region| !region.contains("spawn_blocking("))
            .map(|region| region.lines().next().unwrap_or_default())
            .collect();
        assert!(
            on_a_runtime_thread.is_empty(),
            "these wait for the core on a runtime thread: {on_a_runtime_thread:?}"
        );
        // The control, so a sweep that matched nothing at all cannot pass, and a
        // second hand-off written beside the first is a red test rather than a
        // second place to get this wrong.
        assert_eq!(sites.len(), 1, "the core is run from {} places", sites.len());
    }

    #[test]
    fn the_engine_takes_three_words_from_a_page_and_no_others() {
        assert_eq!(EngineAction::parse("pause"), Ok(EngineAction::Pause));
        assert_eq!(EngineAction::parse("resume"), Ok(EngineAction::Resume));
        assert_eq!(EngineAction::parse("deliver"), Ok(EngineAction::Deliver));
    }

    #[test]
    fn a_page_cannot_end_the_run_or_make_the_shell_leave() {
        // The refusals that matter, named one at a time rather than left to a
        // catch-all. `stop`, `detach` and `quit` are real supervisor paths with
        // real consequences, and the whole reason `engine_action` is a closed
        // list of three is that a page must not be able to reach them: leaving
        // is a menu item a person picks, and a drain nobody asked for is a
        // background tool turning itself off.
        for forbidden in ["stop", "detach", "quit", "rescan", "setup", "autostart"] {
            assert!(
                EngineAction::parse(forbidden).is_err(),
                "{forbidden:?} was accepted as an action"
            );
        }
        // And the same shapes `open_path` refuses, for the same reason: this
        // takes a word, so nothing that looks like a resource can be one.
        for attempt in [
            "C:\\Windows\\System32\\cmd.exe",
            "https://accounts.google.com/o/oauth2/auth",
            "PAUSE",
            "pause ",
            "",
        ] {
            assert!(
                EngineAction::parse(attempt).is_err(),
                "{attempt:?} was accepted as an action"
            );
        }
    }

    #[test]
    fn a_refused_action_says_what_the_actions_are() {
        let why = EngineAction::parse("stop").expect_err("refused");
        assert!(why.contains("\"pause\""), "{why}");
        assert!(why.contains("\"resume\""), "{why}");
        assert!(why.contains("\"deliver\""), "{why}");
        assert!(!why.contains('\u{2014}'), "em dash in {why}");
    }

    #[test]
    fn the_windows_buttons_are_the_menus_own_commands() {
        // One truth, two surfaces, at the level of the wire. Pause and resume
        // are the tray's single action item, which is why they are one command
        // here: the supervisor reads the state and decides which of the two a
        // press means, and a page whose picture is one event stale cannot get
        // that decision wrong because it never makes it.
        assert_eq!(EngineAction::Pause.command(), UiCommand::Action);
        assert_eq!(EngineAction::Resume.command(), UiCommand::Action);
        assert_eq!(EngineAction::Deliver.command(), UiCommand::DeliverNow);
    }

    #[test]
    fn a_doctor_report_is_read_off_the_last_json_line() {
        let report = parse_doctor("{\"ok\":true,\"checks\":[]}\n").expect("parsed");
        assert_eq!(report["ok"], true);
    }

    #[test]
    fn a_stray_line_before_the_report_does_not_lose_the_report() {
        // The M1 stage 2 review's finding, in the one place it could still
        // happen: prose reaching stdout from a layer above the run. Surviving
        // it beats showing a page with nothing on it.
        let report =
            parse_doctor("some prose nobody meant to print\n{\"ok\":false,\"checks\":[]}\n")
                .expect("parsed");
        assert_eq!(report["ok"], false);
    }

    #[test]
    fn a_silent_doctor_is_an_error_and_not_an_empty_report() {
        // An empty page reads as "nothing is wrong", which is the one wrong
        // answer a health check can give.
        assert!(parse_doctor("   \n\n").is_err());
    }

    #[test]
    fn the_folder_edit_word_comes_from_this_side_and_not_from_a_page() {
        // A page calls one of two named commands. It cannot name the action, so
        // there is no third thing it can ask the core to do to the list.
        assert_eq!(FolderEdit::Add.word(), "add");
        assert_eq!(FolderEdit::Remove.word(), "remove");
        assert_ne!(FolderEdit::Add.word(), FolderEdit::Remove.word());
    }

    #[test]
    fn only_a_config_that_really_moved_restarts_the_engine() {
        // A restart costs a drain and a full reconciliation walk. Spending that
        // on an answer that said nothing changed would make every refused click
        // a re-scan of the whole library.
        let changed = serde_json::json!({
            "type": "folders-changed",
            "watchDirs": ["D:\\Photos"],
            "added": "D:\\Photos",
        });
        assert!(rewrote_the_config(&changed));

        for answer in [
            serde_json::json!({ "type": "folders-unchanged", "why": "That one is already on the list." }),
            serde_json::json!({ "type": "failed", "error": "no config" }),
            // A shape this build does not know, and a line that is not an object
            // at all. Both mean the config is what it was.
            serde_json::json!({ "type": "something-a-newer-core-says" }),
            serde_json::json!({}),
            serde_json::json!("folders-changed"),
            serde_json::json!(null),
        ] {
            assert!(!rewrote_the_config(&answer), "{answer} restarted the engine");
        }
    }

    #[test]
    fn a_folder_list_that_said_nothing_is_an_error_and_not_a_silent_no_op() {
        // The core answers every request, including the ones that change nothing,
        // so silence here means the run never got as far as answering. A page told
        // nothing would show a list that no longer matches the file.
        let why = last_json_line("  \n\n", "the folder list").expect_err("refused");
        assert!(why.contains("the folder list"), "{why}");
        assert!(!why.contains('\u{2014}'), "em dash in {why}");
    }

    #[test]
    fn a_stray_line_before_the_answer_does_not_lose_the_answer() {
        let answer = last_json_line(
            "some prose nobody meant to print\n{\"type\":\"folders-changed\"}\n",
            "the folder list",
        )
        .expect("parsed");
        assert!(rewrote_the_config(&answer));
    }

    /// The repo's own build output, if this is a dev checkout that has run
    /// `npm run build`. `None` means the process test below skips itself.
    fn dev_cli() -> Option<std::path::PathBuf> {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let candidate = manifest.parent()?.parent()?.join("dist").join("cli.js");
        candidate.is_file().then_some(candidate)
    }

    /// The folder editor's argument vector, checked against the core rather than
    /// against this file's opinion of it.
    ///
    /// The same trial the watch vector gets in `supervisor.rs`, and for the same
    /// reason: at M4 `setup --events ndjson` did not exist, so the first IPC call
    /// in the exit criterion spawned a process that died on an unknown option
    /// before it created a single file. A subcommand name, a flag or a placeholder
    /// that the core does not answer would fail here in exactly that way.
    ///
    /// Both answers are on trial, because both are load bearing: the one that says
    /// the file moved is the only one that may cost a drain and a full
    /// reconciliation walk, and the one that says nothing changed has to be an
    /// answer rather than a silence.
    ///
    /// Safety: a throwaway config under TEMP, holding a folder under the same
    /// TEMP directory. Nothing is watched, nothing is uploaded, no credential is
    /// needed, and the production install is never named.
    #[test]
    fn the_real_core_answers_the_folder_vector_and_both_of_its_answers() {
        let Some(cli) = dev_cli() else {
            eprintln!("skipped: no dist/cli.js, run npm run build in the repo root");
            return;
        };

        let scratch = std::env::temp_dir().join(format!(
            "photo-pigeon-folders-ipc-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(scratch.join("first")).expect("scratch dirs");
        std::fs::create_dir_all(scratch.join("second")).expect("scratch dirs");
        let config = scratch.join("config.json");
        std::fs::write(
            &config,
            format!(
                r#"{{"watchDirs":[{:?}],"extensions":[".jpg"]}}"#,
                scratch.join("first").to_string_lossy()
            ),
        )
        .expect("scratch config");

        let launch = CoreLaunch {
            program: "node".into(),
            core_js: cli,
            source: "test".into(),
        };
        let second = scratch.join("second").to_string_lossy().into_owned();
        let config_arg = config.to_string_lossy().into_owned();

        let once = match run_core(
            &launch,
            launch.folders_args(FolderEdit::Add.word(), &second, Some(&config_arg)),
        ) {
            Ok(output) => output,
            Err(why) => {
                eprintln!("skipped: could not run node ({why})");
                let _ = std::fs::remove_dir_all(&scratch);
                return;
            }
        };
        let answer = last_json_line(&String::from_utf8_lossy(&once.stdout), "the folder list")
            .expect("the core answered with one JSON line");
        assert!(rewrote_the_config(&answer), "{answer}");
        assert_eq!(once.status.code(), Some(0));

        // The same request again changes nothing, and the core still answers: a
        // shell that heard silence would read it as a word the core did not
        // understand and act on that reading.
        let twice = run_core(
            &launch,
            launch.folders_args(FolderEdit::Add.word(), &second, Some(&config_arg)),
        )
        .expect("the core ran a second time");
        let answer = last_json_line(&String::from_utf8_lossy(&twice.stdout), "the folder list")
            .expect("the core answered with one JSON line");
        assert_eq!(answer["type"], "folders-unchanged");
        assert!(!rewrote_the_config(&answer), "{answer}");

        // And the file really has the second folder in it, once.
        let written = std::fs::read_to_string(&config).expect("the config was rewritten");
        let parsed: serde_json::Value = serde_json::from_str(&written).expect("still JSON");
        let dirs = parsed["watchDirs"].as_array().expect("an array");
        assert_eq!(dirs.len(), 2, "{written}");

        let _ = std::fs::remove_dir_all(&scratch);
    }
}
