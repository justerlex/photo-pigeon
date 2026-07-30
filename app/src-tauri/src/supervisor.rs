//! The core's life, from the shell's side.
//!
//! One thread owns the child, the state machine and the timers. Everything
//! else (menu clicks, pipe readers, the reaper) posts messages to it. That is
//! why nothing in here needs a lock: there is exactly one place the state is
//! touched, and it is single threaded.
//!
//! ## The stop protocol, which is the part that must not be improvised
//!
//! The Windows signal bench in the header of `src/commands/watch.ts` settled
//! this by measurement: **there is no signal delivery to another process on
//! Windows.** Every `kill` is `TerminateProcess` wearing a signal's name, the
//! child never runs a handler, and a batch in flight is abandoned. A file that
//! was uploaded but not yet written to the ledger gets uploaded again next
//! time, which is the one failure this whole design exists to prevent.
//!
//! So the shell never kills. It writes one bare line, `stop\n`, and waits for
//! `{"type":"stopped"}` and then the exit. If the drain outruns the window,
//! the answer is an attention state and a sentence, not a kill: TRAY-DESIGN
//! section 7.
//!
//! ## What leaving costs, and the word M3 bought to change it
//!
//! At M2 this header said the second Quit press was the terminal's second
//! ctrl+c, with the same cost, because the shell holds the only write handle on
//! the child's stdin and that handle dies with the process. An end of file
//! reaching a core that is already stopping was a *second* stop, and the second
//! stop is `impatient` in `waitForStop`: `queue.leaveNow()`, exit 130, whatever
//! was on the wire dropped. The menu said so rather than promising a drain the
//! shell could not deliver.
//!
//! M3 changes the core rather than the copy. `detach` means "I am leaving,
//! finish the drain without me and then exit yourself", and after it the end of
//! file the shell's exit produces is not a stop request at all. So the second
//! press writes `detach`, waits briefly for `{"type":"detached"}` so the log can
//! say the word landed, and goes. The batch survives the shell.
//!
//! ## The rest of the M3 vocabulary
//!
//! | Word | What it is for | What the shell does with it |
//! |---|---|---|
//! | `pause` | close intake, hold the queue, stay alive | the child is **not** stopped and **not** respawned on resume |
//! | `resume` | open intake again | ditto |
//! | `rescan` | one reconciliation pass | written by Deliver now, which is a gesture and never a timer |
//! | `detach` | the shell is leaving | written by the second Quit press |
//!
//! Pause used to be a stop and a respawn. That was honest and free in the core
//! and it cost a full re-hash of the library on resume, which on a 100 GB
//! library means reading 100 GB to undo a click. It is gone.
//!
//! Every one of these is written and then waited for, because a core one
//! version behind answers an unknown word on stderr and carries on. Without the
//! wait, a shell talking to such a core would sit on "Pausing" forever while the
//! engine kept uploading. [`WORD_TIMEOUT`] is what stops that being silent.
//!
//! ## Restart policy
//!
//! | How the run ended | What happens |
//! |---|---|
//! | We asked (quit or detach) | the shell exits |
//! | Refused before `started`, with a run level `failed` | attention, no respawn: a respawn walks into the same lock |
//! | `lock-lost` with `stopping` | attention with the pid, no respawn, same reason |
//! | Anything else | attention, then a respawn on a widening backoff |
//!
//! Pause is not in that table any more, because pausing no longer ends a run.
//!
//! The backoff widens to five minutes and stops widening. It never becomes a
//! tight loop and it never gives up entirely, because a background uploader
//! that has quietly stopped forever is worse than one that keeps knocking. When
//! it reaches the ceiling it toasts once, which is the honest reading of
//! "after the respawns exhaust" for a policy that never formally does.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::autostart::{self, Autostart, Reassert};
use crate::events::{Framed, LineAssembler, ParsedLine};
use crate::paths::{self, ConfigChoice, CoreLaunch};
use crate::shell_log::ShellLog;
use crate::shell_state::ShellState;
use crate::state::{
    self, AppState, CoreStatus, Effect, EngineControl, ExitVerdict, RecentEvent, RestartReason,
    RestartStage, StopIntent, QUIET_WINDOW_MS,
};
use crate::toasts::{self, Toast};
use crate::tray::{self, Render};
use crate::updater::{self, ReadyUpdate, Updates};
use crate::windows::{self, Page};

/// How long the core may say nothing at all during a drain before the shell
/// says so out loud.
///
/// It was one minute, and one minute was a number written against the wrong
/// clock. `API_LIMITS.MIN_BACKOFF_MS` in `src/contracts.ts` is **thirty
/// seconds** and the ladder is exponential from there, so an ordinary 429 on an
/// ordinary upload parks the queue for longer than the old window on the first
/// retry and several times over on the second. The result was that a perfectly
/// healthy drain raised [`crate::state::Attention::StopUnconfirmed`] and offered
/// the user the one action that really does abandon the batch. A window that
/// routinely fires on healthy behaviour is not a safety net, it is a nudge
/// towards the failure it was built to prevent.
///
/// Five minutes, and any event at all from the core restarts it, so this is
/// reached only by a core that has gone genuinely silent. Nothing is killed
/// when it is reached: it raises a sentence, and the user decides.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a word written to stdin may go unanswered before the shell says so.
///
/// Generous against a healthy core, which answers `pause` in about as long as
/// it takes to read the line, and short enough that a core which does not know
/// the word cannot leave the menu claiming something the engine is not doing.
/// The one real case is a shell of this build against a core one version
/// behind, which answers an unknown word on stderr and carries on watching.
const WORD_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for `{"type":"detached"}` before leaving anyway.
///
/// Deliberately short. The user has already said they want to go, and the wait
/// buys one thing only: a line in the log saying the word landed. If it does not
/// land the shell leaves regardless, which is exactly the M2 behaviour and no
/// worse than it.
const DETACH_CONFIRM: Duration = Duration::from_secs(3);

/// Widening, bounded, never zero.
const BACKOFF_SECS: [u64; 7] = [2, 5, 15, 30, 60, 120, 300];

/// A run that lasted this long was healthy, whatever ended it, so the next
/// failure starts the backoff from the beginning.
const HEALTHY_RUN: Duration = Duration::from_secs(60);

/// The shortest gap between two menu updates.
///
/// A delivered event per file means a status line per file, and a scan over a
/// large library would otherwise post thousands of tasks to the main thread to
/// redraw text nobody is reading. Icon changes ignore this and go through at
/// once, because the icon is the part a person is actually looking at.
const RENDER_MIN_GAP: Duration = Duration::from_millis(200);

/// What a menu click asks for.
///
/// Not `Copy` any more: `OpenWatchedAt` carries the path its row was showing, so
/// one of these owns a `String`. Every send is a move down the channel anyway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiCommand {
    /// The one item that is Pause, Resume, Try again or Start again now.
    Action,
    /// One reconciliation pass, asked for by a person. TRAY-DESIGN law 2: a
    /// gesture, never a schedule.
    DeliverNow,
    Quit,
    OpenLog,
    /// The menu item. One watched folder opens it; several open the status
    /// window, where each one has its own row.
    OpenWatchedFolder,
    /// One watched folder, by its index in the list the shell published, plus
    /// the path that row was showing when it was drawn.
    ///
    /// The status window's per-folder rows, added on the status-window
    /// reshape. The index is still the address and the shell still resolves it
    /// against its own list before anything is opened; the path is the row's own
    /// account of itself, and all it can do is turn the answer into a refusal.
    /// See [`watched_row`] for why a row that only knows where it is opens the
    /// wrong folder inside the poll lag.
    OpenWatchedAt { index: usize, path: String },
    /// Start with Windows was clicked. The registry decides what happens, not
    /// whatever the checkbox happened to be showing.
    ToggleAutostart,
    /// The user looked at the menu, which clears the failure flavour and is
    /// also when the autostart tick is re-read from the registry.
    MenuOpened,
    /// Start with Windows, set to a stated value rather than flipped.
    ///
    /// M4's windows have a real toggle rather than a tick that has already
    /// moved, so they say what they want and the registry still decides. The
    /// menu keeps `ToggleAutostart`, because a check item genuinely is a flip.
    SetAutostart(bool),
    /// Show one of the two windows, created on demand and destroyed on close.
    ShowWindow(Page),
    /// A setup sidecar exited. Sent by `setup_host`'s reaper, which knows a run
    /// ended and deliberately knows nothing else: whether it left a config is a
    /// question for the disk, and the supervisor is the thing that asks it.
    SetupEnded,
    /// The watched folder list in the config is not the one the running core
    /// loaded.
    ///
    /// Sent by `ipc::add_watched_folder` and `ipc::remove_watched_folder`, and
    /// only when the core said it really rewrote the file. A running watch loaded
    /// its config at start and holds it in memory, so without this the window
    /// shows one list, the engine walks another, and nothing says so: the
    /// divergence the M4 review banked as a minor, with a second door into it.
    WatchDirsChanged,
}

/// What the menu handlers and the IPC commands hold. Cheap to clone, safe to
/// drop.
#[derive(Clone)]
pub struct SupervisorHandle {
    tx: Sender<Msg>,
    /// The last published picture of the run.
    ///
    /// A copy rather than a channel round trip, because `status_snapshot()` is
    /// called from a window's render path and a page must never be able to
    /// block on the supervisor thread: a supervisor busy draining a batch would
    /// otherwise freeze the status window. It is refreshed on every render, so
    /// it is at most one event stale, which is the same freshness the tray menu
    /// has.
    snapshot: Arc<Mutex<StatusSnapshot>>,
}

impl SupervisorHandle {
    pub fn send(&self, command: UiCommand) {
        let _ = self.tx.send(Msg::Ui(command));
    }

    /// What the status window renders. Never blocks on the supervisor.
    pub fn snapshot(&self) -> StatusSnapshot {
        self.snapshot
            .lock()
            .map(|held| held.clone())
            .unwrap_or_default()
    }
}

/// Everything a window shows about the run, in one shape.
///
/// Serialized straight across the IPC boundary, so this struct is the contract
/// with `health.html` and the field names are the ones the page reads.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    /// The menu's own status line, so the window and the tray cannot disagree.
    pub status_line: String,
    /// The storage honesty line. TRAY-DESIGN section 0 puts it in the status
    /// window as well as the menu, and this is how it gets there.
    pub storage_line: String,
    /// The full storage sentence, which the 127 unit tooltip can never fit.
    pub storage_honesty: String,
    pub icon: String,
    /// The one thing worth looking at, when there is one.
    pub attention: Option<String>,
    /// The status window's Pause or Resume button, as the shell's own label and
    /// the word behind it.
    ///
    /// The window is the main UI as of the status-window reshape, so it carries
    /// these actions itself and the menu's copies are duplicates of this. It
    /// travels as a shape rather than as a label because a page must never work
    /// out which word it meant by reading its own button: see
    /// [`crate::state::EngineControl`].
    ///
    /// **This is deliberately not the [`Render`]'s `action_label`.** The menu's
    /// one item is also Start watching, Try again, Start again now and Set up
    /// Photo Pigeon, and a window's pause button may not silently become any of
    /// those: the doors those four open are elsewhere on the page. So the two
    /// surfaces are one truth by a pinned parity rather than by a copied field,
    /// and the pin is `state.rs`'s
    /// `the_windows_control_and_the_menus_item_never_disagree_about_a_pause`.
    pub engine_control: EngineControl,
    /// Whether one more pass is worth offering. Read off the [`Render`] the menu
    /// is drawn from, because Deliver now really is the same item on both
    /// surfaces: one computation, two readers.
    pub deliver_now_enabled: bool,
    pub watch_dirs: Vec<String>,
    pub delivered: u64,
    pub skipped: u64,
    pub failed: u64,
    pub bytes: u64,
    pub last_delivery: Option<String>,
    pub core_pid: Option<u32>,
    pub core_version: Option<String>,
    pub dry_run: bool,
    /// What the registry says, never what this process would like it to say.
    pub autostart_on: bool,
    /// False where the mechanism itself is unavailable, so a page can render
    /// the toggle as absent rather than as off.
    pub autostart_available: bool,
    /// The last thing the shell did to the engine on the user's behalf, when it
    /// has done anything at all. One sentence, and never a state: see
    /// [`crate::state::restart_notice`].
    pub notice: Option<String>,
    pub core_log_path: Option<String>,
    pub shell_log_path: String,
    /// A bounded ring of what the core said lately, newest last.
    pub recent: Vec<RecentEvent>,
}

enum Msg {
    Ui(UiCommand),
    Stdout(Framed),
    Stderr(Framed),
    /// The child is gone, and both pipes have already been drained.
    Exited(Option<i32>),
    /// The updater task finished a round trip.
    ///
    /// It comes back on this channel rather than touching anything directly
    /// because the check and the download are futures on Tauri's async runtime
    /// and this loop is a blocking thread. One message, one owner of the
    /// decision, and no lock between them.
    Update(UpdateNews),
}

/// What one updater round trip found.
///
/// Three outcomes rather than four: finding an update and downloading it are one
/// task, so "found" is a line in the log rather than a state anybody acts on.
enum UpdateNews {
    /// The endpoint answered and this is already the newest version.
    Newest,
    /// The check or the download did not finish. One line for the log, never a
    /// toast: an update the user did not ask for cannot fail in their face.
    Failed(String),
    /// The bytes are down and verified against the public key.
    Ready {
        version: String,
        ready: Box<ReadyUpdate>,
    },
}

/// A running child, minus the handle the reaper took.
struct Live {
    pid: u32,
    stdin: Option<ChildStdin>,
    started_at: Instant,
}

#[derive(Default)]
struct Timers {
    /// Two seconds of nothing means the queue is empty.
    quiet: Option<Instant>,
    /// A stop was asked for at this moment plus the window.
    drain: Option<Instant>,
    /// When to try spawning again.
    respawn: Option<Instant>,
    /// A render was held back by the coalescing gap and is owed.
    render: Option<Instant>,
    /// A word went to stdin and is waiting to be answered. Carries the word,
    /// so the complaint can name it.
    word: Option<(Instant, &'static str)>,
    /// A detach is waiting to be confirmed. When this fires the shell leaves
    /// anyway: the user already asked to go.
    detach: Option<Instant>,
    /// When the next update check may go out. Armed once at launch and again
    /// after every check that came back, and deliberately not armed while an
    /// update is in hand: `updater::may_check` is the rule and this is only the
    /// alarm clock.
    update_check: Option<Instant>,
}

impl Timers {
    fn wait(&self, now: Instant) -> Option<Duration> {
        [
            self.quiet,
            self.drain,
            self.respawn,
            self.render,
            self.word.map(|(at, _)| at),
            self.detach,
            self.update_check,
        ]
        .into_iter()
        .flatten()
        .map(|at| at.saturating_duration_since(now))
        .min()
    }
}

struct Supervisor {
    app: AppHandle,
    log: Arc<ShellLog>,
    state: AppState,
    child: Option<Live>,
    launch: Option<CoreLaunch>,
    config: Option<String>,
    timers: Timers,
    backoff_step: usize,
    last_render: Option<Render>,
    last_render_at: Option<Instant>,
    /// The Run value this build is allowed to touch, and what it last read
    /// back out of the registry.
    autostart: Autostart,
    autostart_on: bool,
    /// The flag that outlives a launch.
    shell_state: ShellState,
    /// A restart the user's own pause is holding up, waiting for their resume.
    ///
    /// The one gesture the shell may not undo behind somebody's back is a pause
    /// they asked for, and a fresh run comes up running. So the restart waits and
    /// the resume performs it: the new run is both unpaused, which is what resume
    /// means, and on the new config, which is what the edit asked for.
    restart_pending: Option<RestartReason>,
    /// A restart whose replacement run has not said `started` yet.
    ///
    /// Held so the sentence on the status surface can move from "starting again"
    /// to "running on the new list" when it is really true, rather than claiming
    /// it the moment a spawn was asked for.
    restart_note_owed: Option<RestartReason>,
    /// What a window sees, refreshed on every render.
    snapshot: Arc<Mutex<StatusSnapshot>>,
    tx: Sender<Msg>,
    /// The shell's whole memory of the updater: what stage it is at, when it
    /// last asked, the bytes it is holding and whether the run that is ending
    /// confirmed its drain. Every rule about it is in `updater.rs`.
    updates: Updates,
}

/// Start the supervisor thread and hand back the way to talk to it.
///
/// The first spawn happens on that thread, not here, so a slow or refused
/// start cannot hold up the tray appearing. The registry read and the state
/// file read are on that thread too, for the same reason.
pub fn start(
    app: AppHandle,
    log: Arc<ShellLog>,
    autostart: Autostart,
    shell_state: ShellState,
) -> SupervisorHandle {
    let (tx, rx) = mpsc::channel::<Msg>();
    let snapshot = Arc::new(Mutex::new(StatusSnapshot::default()));
    let handle = SupervisorHandle {
        tx: tx.clone(),
        snapshot: snapshot.clone(),
    };

    thread::Builder::new()
        .name("pigeon-supervisor".into())
        .spawn(move || {
            let state = AppState::new();
            let mut supervisor = Supervisor {
                app,
                log,
                state,
                child: None,
                launch: None,
                config: None,
                timers: Timers::default(),
                backoff_step: 0,
                last_render: None,
                last_render_at: None,
                autostart,
                autostart_on: false,
                shell_state,
                restart_pending: None,
                restart_note_owed: None,
                snapshot,
                tx,
                updates: Updates::default(),
            };
            supervisor.prepare();
            supervisor.settle_autostart();
            supervisor.spawn_core();
            supervisor.arm_first_update_check();
            supervisor.render();
            supervisor.run(rx);
        })
        .expect("the supervisor thread could not be started");

    handle
}

impl Supervisor {
    /// Work out what to run and which config to point it at, once.
    fn prepare(&mut self) {
        // Written down every run, because the one thing a support question
        // most needs to establish is that the shell is using the bare line
        // protocol and not a JSON envelope it invented.
        self.log.line(&format!(
            "stop protocol: write {:?} to stdin, wait for a {:?} event, never a signal",
            paths::stop_line(),
            paths::stopped_event_type()
        ));
        // The rest of the vocabulary, written down every run for the same
        // reason: the first thing a support question has to establish is which
        // words this build speaks, and a core that does not know one of them
        // answers on stderr, which lands two lines below this one.
        self.log.line(&format!(
            "stdin vocabulary: {:?} {:?} {:?} {:?}, detach is confirmed by a {:?} event",
            paths::pause_line(),
            paths::resume_line(),
            paths::rescan_line(),
            paths::detach_line(),
            paths::detached_event_type()
        ));

        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(PathBuf::from));
        let resource_dir = self.app.path().resource_dir().ok();
        self.log.line(&format!(
            "exe dir {:?}, resource dir {:?}",
            exe_dir, resource_dir
        ));

        match paths::resolve_core(exe_dir.as_deref(), resource_dir.as_deref()) {
            Ok(launch) => {
                self.log.line(&format!(
                    "core resolved by {}: {} {}",
                    launch.source,
                    launch.program.display(),
                    launch.core_js.display()
                ));
                self.launch = Some(launch);
            }
            Err(why) => {
                self.log.line(&format!("no core to run: {why}"));
                self.state.on_spawn_failed(why);
            }
        }

        match paths::config_choice() {
            ConfigChoice::Explicit(path) => {
                self.log.line(&format!("config override: {path}"));
                self.config = Some(path);
            }
            ConfigChoice::CoreDefault => {
                self.log.line("no config override, the core uses its own default");
            }
            ConfigChoice::Refuse(why) => {
                self.log.line(&format!("refusing to spawn: {why}"));
                self.state.on_spawn_failed(why);
                self.launch = None;
            }
        }

        self.settle_first_run();
    }

    /// Where the config really is, whether it came from the override or from
    /// the core's own default. `None` means the question cannot be answered on
    /// this machine, and an unanswerable question is not a first run.
    fn config_file(&self) -> Option<PathBuf> {
        match self.config.as_deref() {
            Some(path) => Some(PathBuf::from(path)),
            None => self
                .app
                .path()
                .home_dir()
                .ok()
                .map(|home| home.join(".photo-pigeon").join("config.json")),
        }
    }

    /// Is this a machine that has never been set up, and if so, say so and open
    /// the window.
    ///
    /// **This is the whole of the M4 exit criterion's first sentence.** A tray
    /// icon and no window is a dead end for the person the window exists for:
    /// they installed a thing, it appeared next to the clock, and nothing
    /// happened. The window opens by itself exactly once, on the launch that
    /// finds no config, and never again.
    fn settle_first_run(&mut self) {
        let Some(config) = self.config_file() else {
            return;
        };
        if config.exists() {
            return;
        }
        self.log.line(&format!(
            "no config at {}: first run, opening the setup window and spawning no core",
            config.display()
        ));
        self.state.set_needs_setup(true);
        self.show_window(Page::Setup);
    }

    /// A setup sidecar ended. If it wrote a config, this machine is set up now.
    ///
    /// Read off the disk rather than off the exit code, because the exit code
    /// says the run finished and the file says what it left behind: a run
    /// cancelled halfway exits cleanly on `stop` and writes nothing.
    fn on_setup_ended(&mut self) {
        let Some(config) = self.config_file() else {
            return;
        };
        let Some(reason) = setup_ended_plan(config.exists()) else {
            self.log
                .line("setup ended and left no config, so there is still nothing to watch");
            return;
        };
        self.log
            .line("setup left a config behind, so the engine runs on that one");
        self.restart_core(reason);
        self.render();
    }

    /// Start the core again on a config that has changed under it.
    ///
    /// The stop word, the wait, the respawn: the same three steps the quit path
    /// uses, because they are the only three that keep a batch. A running core
    /// loaded its config once and holds it in memory, so a config that changed and
    /// a core still on the old one is a divergence, and the sentence this leaves on
    /// the status surface is the difference between a restart and a mystery.
    ///
    /// **Nothing is killed and nothing is abandoned.** `stop` closes intake and
    /// drains, so every file already in the queue is uploaded and written to the
    /// ledger before the run ends, including files from a folder that is being
    /// dropped from the list. That is deliberate: the ledger entry is written after
    /// the upload, so a dropped batch is a file uploaded twice, and no folder
    /// leaving a list is worth that. What changes is only which folders the next
    /// run walks. Nothing already delivered is ever touched.
    fn restart_core(&mut self, reason: RestartReason) {
        // Both reasons mean the core has just read and rewritten a config file, so
        // a belief that this machine has nothing to watch is stale by the time we
        // get here. Left standing it is a dead end: `spawn_core` declines while
        // that belief holds, so the sentence would promise a run that never
        // started. This is the same correction `on_setup_ended` makes, applied to
        // the other door into the same place.
        self.state.set_needs_setup(false);
        match restart_plan(self.state.status, self.child.is_some()) {
            RestartPlan::Refuse => {
                // A shell on its way out does not start a run it cannot look
                // after, and the core it is leaving behind was already told what
                // to do.
                self.log
                    .line("a restart was asked for while the shell is leaving, ignored");
            }
            RestartPlan::Wait => {
                // One stop, never two. A second `stop` line is `impatient` in the
                // core's own `waitForStop`, which means `queue.leaveNow()` and the
                // batch in flight dropped.
                self.log
                    .line("a restart is already on the wire, so this one waits for it");
                self.state
                    .note(state::restart_notice(reason, RestartStage::Asked));
            }
            RestartPlan::WhenResumed => {
                // The queue is held because a person asked for it to be held. A
                // fresh run comes up running, so restarting now would answer
                // "change my folder list" with "and your pause is gone", which is
                // the shell undoing a gesture nobody withdrew.
                self.log
                    .line("the engine is paused, so the new config waits for the resume");
                self.restart_pending = Some(reason);
                self.state
                    .note(state::restart_notice(reason, RestartStage::WhenResumed));
            }
            RestartPlan::Spawn => {
                self.log.line("nothing is running, so the new config starts fresh");
                self.restart_note_owed = Some(reason);
                self.backoff_step = 0;
                self.timers.respawn = None;
                self.state
                    .note(state::restart_notice(reason, RestartStage::Asked));
                self.spawn_core();
            }
            RestartPlan::StopFirst => {
                self.log
                    .line("the config changed under the running core, draining it and starting again");
                self.restart_note_owed = Some(reason);
                self.state
                    .note(state::restart_notice(reason, RestartStage::Asked));
                self.request_stop(StopIntent::Restart);
            }
        }
    }

    /// Everything about the Run value that happens once per launch.
    ///
    /// Three separate jobs, in the order they have to happen:
    ///
    /// 1. **The default.** Start with Windows is on, with one visible line
    ///    saying so. It
    ///    is applied once ever, against a flag on disk, because a default that
    ///    reapplied itself every launch would not be a default, it would undo
    ///    the user's choice every morning.
    /// 2. **The re-assertion.** TRAY-DESIGN section 4's second failure mode: an
    ///    installed app that moves leaves the value pointing at nothing and boot
    ///    silently fails. The rename this project has already done once is an
    ///    instance of exactly that, and the only reason no machine is stranded
    ///    today is that M0 left the value absent, which is luck.
    /// 3. **The read back**, which is what the checkbox renders. Never a
    ///    remembered preference.
    fn settle_autostart(&mut self) {
        self.log.line(&format!(
            "autostart value name {:?}, scope {:?}, would write {:?}",
            self.autostart.name(),
            self.autostart.scope(),
            self.autostart.value_data()
        ));
        // Written on every launch, whichever way it went, because "the log says
        // nothing" and "the flag was ignored" look identical from the outside
        // and the whole disagreement M3 had to settle was which word the boot
        // path really parses. One line makes it evidence.
        self.log.line(&format!(
            "boot flag {}: this launch {} the Run key",
            autostart::BOOT_FLAG,
            if autostart::launched_by_windows() {
                "came from"
            } else {
                "did not come from"
            }
        ));

        match autostart_plan(
            self.shell_state.autostart_decided(),
            self.shell_state.autostart_off_chosen(),
            autostart::recorded_value(self.autostart.name()).is_some(),
            self.autostart.may_default_on(),
        ) {
            AutostartPlan::DefaultOn => match self.autostart.enable() {
                Ok(()) => {
                    self.log
                        .line("start with Windows was turned on by default, first run");
                    // Only a run that could really decide gets to record that
                    // the question is settled. A development build must not
                    // answer it on the installed copy's behalf, and the two
                    // share this file's directory.
                    self.shell_state.note_autostart_decided();
                }
                Err(why) => self
                    .log
                    .line(&format!("could not turn start with Windows on: {why}")),
            },
            AutostartPlan::NoDefault => self.log.line(
                "not turning start with Windows on by default: this build does not own \
                 the shipped Run value",
            ),
            AutostartPlan::ReArm => match self.autostart.enable() {
                Ok(()) => self.log.line(
                    "the Run value was gone and nobody had turned start with Windows off, \
                     so it has been written again",
                ),
                Err(why) => self.log.line(&format!(
                    "the Run value was gone and could not be written again: {why}"
                )),
            },
            AutostartPlan::Reassert => match self.autostart.reassert() {
                Reassert::Off => self.log.line("start with Windows is off"),
                Reassert::Correct => self
                    .log
                    .line("start with Windows is on and points at this exe"),
                Reassert::Rewritten(previous) => self.log.line(&format!(
                    "start with Windows pointed at {previous:?}, rewritten to this exe"
                )),
                Reassert::Failed(why) => self
                    .log
                    .line(&format!("start with Windows has a stale path and {why}")),
            },
        }

        self.read_autostart();
    }

    /// What the registry says, right now.
    fn read_autostart(&mut self) {
        self.autostart_on = self.autostart.is_enabled();
    }

    fn toggle_autostart(&mut self) {
        // Decide from the registry rather than from the checkbox: the value may
        // have been removed by a cleanup tool or switched off in Task Manager
        // since the menu was last drawn.
        let on_now = self.autostart.is_enabled();
        let result = if on_now {
            self.autostart.disable()
        } else {
            self.autostart.enable()
        };
        match result {
            Ok(()) => self.log.line(&format!(
                "start with Windows turned {}",
                if on_now { "off" } else { "on" }
            )),
            Err(why) => self.log.line(&format!(
                "start with Windows could not be turned {}: {why}",
                if on_now { "off" } else { "on" }
            )),
        }
        // Read back either way, so a failed write shows as the state that
        // really exists rather than as the one that was asked for.
        self.read_autostart();

        // And make sure a render is really posted, even when the registry ends
        // up where it started. Clicking a check item makes muda flip it on
        // screen before this code runs, so a write that failed leaves the menu
        // showing the opposite of the truth, and `render` posts nothing when
        // the picture it computes equals the last one it sent.
        //
        // **This is one of two halves and the M3 review found it working
        // alone**, which is to say not working: there are two caches, this one
        // and `TrayUi::applied` on the main thread, and forging a difference
        // here only got as far as the second one, which then compared the tick
        // away for having not changed. So the correction never reached the
        // item, in exactly the case it exists for. The other half is
        // `tray::writes`, which writes the tick on every render for this
        // reason. Neither half is enough by itself: this one buys a render, that
        // one gets the tick onto the item.
        if let Some(last) = self.last_render.as_mut() {
            last.autostart_checked = !self.autostart_on;
        }
    }

    /// Start with Windows, set to a stated value.
    ///
    /// A window's toggle says what it wants rather than flipping what it last
    /// saw, which is a real difference and not a nicety: a page's picture of
    /// the registry may be seconds old, and a cleanup tool or Task Manager can
    /// have moved the value since. The registry is still what decides, so the
    /// value is read back either way and the snapshot the page re-reads carries
    /// what really happened rather than what was asked for.
    fn set_autostart(&mut self, want: bool) {
        let on_now = self.autostart.is_enabled();
        if on_now == want {
            self.log
                .line(&format!("start with Windows is already {want}, nothing written"));
            self.read_autostart();
            // No render: nothing about the tray changed. The page that asked
            // still needs the answer, and it re-reads the snapshot.
            let render = tray_render(&self.state, self.autostart_on, self.updates.waiting());
            self.publish(&render);
            return;
        }
        let result = if want {
            self.autostart.enable()
        } else {
            self.autostart.disable()
        };
        match result {
            Ok(()) => self
                .log
                .line(&format!("start with Windows set to {want} from a window")),
            Err(why) => self
                .log
                .line(&format!("start with Windows could not be set to {want}: {why}")),
        }
        self.read_autostart();
        self.shell_state.note_autostart_decided();
        // The same forged difference the menu path needs, for the same reason:
        // a render that computes equal to the last one is never posted, and the
        // menu tick has to follow a change a window made.
        if let Some(last) = self.last_render.as_mut() {
            last.autostart_checked = !self.autostart_on;
        }
        self.render();
    }

    /// Do what one effect asks for.
    fn apply_effects(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::BumpQuiet => {
                    self.timers.quiet =
                        Some(Instant::now() + Duration::from_millis(QUIET_WINDOW_MS));
                }
                Effect::Toast(toast) => self.raise(toast),
            }
        }
    }

    fn raise(&mut self, toast: Toast) {
        self.log
            .line(&format!("toast: {} / {}", toast.title(), toast.body()));
        // Nothing is written down here any more. The happy toast used to be
        // spent into the shell's own state file at this exact line; the project
        // rule makes "the ledger was empty before this
        // delivery" the definition of first ever, which is core-owned, so the
        // shell keeps no second opinion about it and there is no flag to spend.
        //
        // The handle is deliberately dropped: a toast is fire and forget, and
        // nothing in the engine's life may wait on the notification centre.
        let _ = toasts::show(&self.app, &toast);
    }

    fn run(&mut self, rx: Receiver<Msg>) {
        loop {
            let now = Instant::now();
            let msg = match self.timers.wait(now) {
                Some(wait) => match rx.recv_timeout(wait) {
                    Ok(msg) => Some(msg),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(msg) => Some(msg),
                    Err(_) => break,
                },
            };

            match msg {
                Some(msg) => self.handle(msg),
                None => self.fire_timers(),
            }
            self.render();
        }
    }

    // -- messages ----------------------------------------------------------

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Ui(command) => self.on_ui(command),
            Msg::Stdout(Framed::Line(line)) => self.on_line(&line),
            Msg::Stdout(Framed::Dropped(bytes)) => self
                .log
                .line(&format!("dropped an overlong stdout line of {bytes} bytes")),
            Msg::Stderr(Framed::Line(line)) => self.log.core_line(&line),
            Msg::Stderr(Framed::Dropped(bytes)) => self
                .log
                .line(&format!("dropped an overlong stderr line of {bytes} bytes")),
            Msg::Exited(code) => self.on_exit(code),
            Msg::Update(news) => self.on_update_news(news),
        }
    }

    fn on_line(&mut self, line: &str) {
        let Some(parsed) = crate::events::parse_line(line) else {
            return;
        };
        let parsed = match parsed {
            ParsedLine::Event(event) => event,
            ParsedLine::Rejected(why) => {
                // Never fatal. The core promises stdout carries events only,
                // so a rejection is worth recording and worth surviving.
                self.log
                    .line(&format!("unparseable line on the machine channel: {why}"));
                return;
            }
        };

        if matches!(parsed.event, crate::events::CoreEvent::Unknown) {
            self.log
                .line(&format!("ignoring an event this build does not know: {}", parsed.kind));
            return;
        }

        self.log.line(&format!(
            "event {} {}",
            parsed.kind,
            parsed.at.as_deref().unwrap_or("")
        ));

        // A word that was waiting for an answer has one. Cleared before the
        // event is folded in, so the answer clears the timer whichever state it
        // lands the machine in.
        if answers_a_word(&parsed.event, self.timers.word.map(|(_, word)| word)) {
            self.timers.word = None;
        }

        // The status window's recent list. Kept beside the state transition
        // rather than inside it, because it is a record of what was said and
        // not a fact about the run: the ring holds events this build knows and
        // events it merely logged alike.
        self.state
            .note_recent(parsed.at.clone(), &parsed.kind, &parsed.event);

        let effects = self.state.apply(&parsed.event);
        self.apply_effects(effects);

        // The drain's own receipt, kept because the install gate needs it and
        // nothing else does. TRAY-DESIGN section 5 puts `install()` after the
        // core "has drained and reported `{\"type\":\"stopped\"}`", so the
        // receipt is recorded where the word arrives rather than inferred from
        // an exit code: `state.rs` clears the attention that would have stood in
        // for it, which is right for the menu and useless as evidence.
        if matches!(parsed.event, crate::events::CoreEvent::Stopped { .. }) {
            self.updates.note_core_stopped();
        }

        // A run we started because the config moved has said it is up, so the
        // sentence on the status surface can stop promising and start reporting.
        // Owed until `started` and not until the spawn, because a spawn that
        // cannot start is exactly the case where claiming success would be a lie.
        if matches!(parsed.event, crate::events::CoreEvent::Started { .. }) {
            if let Some(reason) = self.restart_note_owed.take() {
                self.state
                    .note(state::restart_notice(reason, RestartStage::Done));
            }
        }

        if matches!(parsed.event, crate::events::CoreEvent::Detached) {
            if self.timers.detach.is_some() {
                // The word landed, so the promise the second Quit press makes
                // is now the core's to keep. Nothing else to wait for.
                self.timers.detach = None;
                self.log
                    .line("the core confirmed the detach: it finishes the drain without us");
                self.exit_shell();
                return;
            }
            // Nobody asked. Worth a line and worth surviving: a shell that let
            // itself be closed by a line from its own child would be a
            // background tool anybody could turn off.
            self.log
                .line("a detached event arrived with no detach asked for, ignored");
        }

        // Proof of life. A core that is still talking is still draining, so it
        // does not get accused of having gone quiet and the user is not offered
        // the one action that abandons the batch.
        if matches!(self.state.status, CoreStatus::Stopping(_)) {
            renew_drain(&mut self.timers, Instant::now());
        }
    }

    fn on_ui(&mut self, command: UiCommand) {
        match command {
            UiCommand::MenuOpened => {
                self.state.on_menu_opened();
                // The checkbox is a view of the registry and not of a
                // preference, so it is re-read every time somebody looks at it.
                // A value a cleanup tool removed behind our back shows unticked
                // without anybody having to notice.
                self.read_autostart();
            }
            UiCommand::Action => self.on_action(),
            UiCommand::DeliverNow => self.on_deliver_now(),
            UiCommand::Quit => self.on_quit(),
            UiCommand::OpenLog => self.open_log(),
            UiCommand::OpenWatchedFolder => self.open_watched_folder(),
            UiCommand::OpenWatchedAt { index, path } => self.open_watched_at(index, &path),
            UiCommand::ToggleAutostart => self.toggle_autostart(),
            UiCommand::SetAutostart(on) => self.set_autostart(on),
            UiCommand::ShowWindow(page) => self.show_window(page),
            UiCommand::SetupEnded => self.on_setup_ended(),
            UiCommand::WatchDirsChanged => self.restart_core(RestartReason::WatchDirs),
        }
    }

    /// Open one of the two windows, on the main thread where Tauri needs it.
    fn show_window(&mut self, page: Page) {
        let app = self.app.clone();
        let log = self.log.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Err(why) = windows::show(&app, page) {
                log.line(&format!("could not open the {} window: {why}", page.label()));
            }
        });
    }

    /// The one action item, doing whatever its label says.
    fn on_action(&mut self) {
        // The label says "Set up Photo Pigeon" and the click has to do that.
        // One place decides which item this is, and it is `action_is_setup`.
        if self.state.action_is_setup() {
            self.log.line("action: set up, opening the setup window");
            self.show_window(Page::Setup);
            return;
        }
        match self.state.status {
            CoreStatus::Starting | CoreStatus::Running => {
                self.log.line("pause requested");
                self.state.on_pause_requested();
                self.write_word(paths::pause_line(), "pause");
            }
            CoreStatus::Paused => {
                // A resume with a restart waiting on it is the restart. The run
                // that comes up is unpaused, which is what resume means, and it is
                // on the config that changed, which is what the edit asked for.
                // Doing both with one word would need the core to reload a config
                // it read once at start, and it does not.
                if let Some(reason) = self.restart_pending.take() {
                    self.log
                        .line("resume requested with a config change waiting, starting again instead");
                    self.restart_note_owed = Some(reason);
                    self.state
                        .note(state::restart_notice(reason, RestartStage::Asked));
                    self.request_stop(StopIntent::Restart);
                    return;
                }
                // The child is alive: resuming is a word, not a spawn. That is
                // the whole point of the M3 pause. The M2 version stopped the
                // core and started a new one, and the new one re-hashed the
                // library, so a click cost a full pass over every watched file.
                self.log.line("resume requested");
                self.state.on_resume_requested();
                self.write_word(paths::resume_line(), "resume");
            }
            CoreStatus::Halted | CoreStatus::Backoff | CoreStatus::Cold => {
                self.log.line("start requested from the menu");
                self.timers.respawn = None;
                self.backoff_step = 0;
                // "Try again" after a resolution failure has to actually try
                // again: the staging script may have run since, or a build may
                // have landed, so the lookup is redone rather than remembered.
                if self.launch.is_none() {
                    self.prepare();
                }
                self.spawn_core();
            }
            CoreStatus::Pausing
            | CoreStatus::Resuming
            | CoreStatus::Stopping(_)
            | CoreStatus::Quitting => {}
        }
    }

    /// Deliver now: one reconciliation pass, because a person asked for one.
    ///
    /// The manual escape hatch for network drives and for the user who does not
    /// trust it yet. TRAY-DESIGN law 2 stands: this is the only thing in the
    /// shell that can cause a scan, and it needs a click every time.
    fn on_deliver_now(&mut self) {
        if !self.state.deliver_now_enabled() {
            self.log
                .line("deliver now asked for with no running core, ignored");
            return;
        }
        self.log.line("deliver now requested");
        // No confirmation timer. A rescan announces itself as `scanning` and
        // then `delivering`, so the tray shows the answer rather than waiting
        // for one, and there is no state to get stuck in if the word is not
        // understood.
        self.write_word(paths::rescan_line(), "rescan");
    }

    /// Quit drains first and says so. A second press detaches and goes.
    ///
    /// The first press writes `stop` and waits, exactly as at M2. The second
    /// press writes `detach`, which is the word M3 adds precisely so that the
    /// end of file the shell's exit produces is not read as a second stop. At
    /// M2 the second press really did abandon whatever was mid flight, and the
    /// label said so because a menu may not say the opposite of what a process
    /// does. Now the process does the thing the label always wanted to promise.
    ///
    /// A third press is the escape hatch for a core that answers nothing: leave
    /// immediately, with the M2 cost, rather than trapping the user in a wait.
    fn on_quit(&mut self) {
        let second_press = self.state.on_quit_pressed();

        if self.child.is_none() {
            self.log.line("quit with no core running, leaving now");
            self.exit_shell();
            return;
        }

        if second_press {
            if matches!(self.state.status, CoreStatus::Stopping(StopIntent::Detach)) {
                // Asked already and nothing came back. The user is pressing it
                // again because they want to go, so go.
                self.log.line(
                    "quit pressed again with a detach already asked for and unconfirmed, \
                     leaving now",
                );
                self.exit_shell();
                return;
            }
            self.log
                .line("quit pressed again, detaching so the core finishes the drain on its own");
            self.state.on_detach_requested();
            // Its own short timer rather than the general word timer, because
            // the answer to an unanswered detach is to leave, not to complain
            // about it in a menu the user is already walking away from.
            self.write_line(paths::detach_line(), "detach");
            self.timers.word = None;
            self.timers.detach = Some(Instant::now() + DETACH_CONFIRM);
            return;
        }

        if takes_over_the_stop(self.state.status) {
            // A stop is already on the wire, for a restart. Asking again would be
            // a *second* stop, which is `impatient` in the core's own
            // `waitForStop`: `queue.leaveNow()`, exit 130, and whatever was mid
            // flight dropped. This is the M2 review's second finding, which was
            // Quit pressed during a pause when a pause was still a stop. So the
            // intent moves and no second line is written: the drain that is
            // already running now ends in the shell leaving rather than in a new
            // run being started.
            self.log
                .line("quit requested during a restart, taking over the stop already in flight");
            self.restart_pending = None;
            self.restart_note_owed = None;
            self.state.on_stop_requested(StopIntent::Quit);
            return;
        }

        self.log.line("quit requested, draining first");
        self.request_stop(StopIntent::Quit);
    }

    fn on_exit(&mut self, code: Option<i32>) {
        let (pid, ran_for) = self
            .child
            .as_ref()
            .map(|live| (live.pid, live.started_at.elapsed()))
            .unwrap_or((0, Duration::ZERO));
        self.child = None;
        self.timers.drain = None;
        self.timers.quiet = None;
        self.timers.word = None;
        self.timers.detach = None;
        // Whatever ended this run, the next spawn reads the config off the disk,
        // so a restart that was waiting for a resume has nothing left to do.
        if self.restart_pending.take().is_some() {
            self.log
                .line("the run that was holding a config change has gone, so the next start has it anyway");
        }

        let verdict = self.state.on_child_exit(code);
        self.log.line(&format!(
            "core pid {pid} exited with {code:?} after {}s, verdict {verdict:?}, attention {:?}",
            ran_for.as_secs(),
            self.state.attention()
        ));

        // Whether this is a stretch the user should be told about depends on
        // how long the shell is about to wait before knocking again, which is
        // this loop's business and not the state machine's.
        let giving_ground = matches!(verdict, ExitVerdict::Unexpected)
            && ran_for < HEALTHY_RUN
            && self.backoff_step >= BACKOFF_SECS.len() - 1;
        // The icon reads the same fact, and it is told before the toast is asked
        // for: the toast is spent once per unhealthy stretch and the red badge has
        // to be up for the whole of it.
        if giving_ground {
            self.state.note_giving_ground();
        }
        if let Some(toast) = self.state.exit_toast(&verdict, giving_ground) {
            self.raise(toast);
        }

        match verdict {
            ExitVerdict::Expected(StopIntent::Quit | StopIntent::Detach) => {
                self.exit_shell();
            }
            ExitVerdict::Expected(StopIntent::Restart) => {
                // The drain finished and the point of asking for it was to start
                // again on the config that changed. Straight away and off the
                // backoff ladder: this run ended because we asked, so it is no
                // evidence at all about how healthy the next one will be.
                self.backoff_step = 0;
                self.timers.respawn = None;
                self.log.line("the run we replaced has gone, starting the new one");
                self.spawn_core();
            }
            ExitVerdict::Refused | ExitVerdict::StoodDown | ExitVerdict::NeedsUser => {
                // A respawn walks straight into the same wall. TRAY-DESIGN
                // section 2 is explicit: no silent retry loop. NeedsUser is
                // the same rule for the same reason, found by running it: a
                // config with no client file produced started, auth-needed,
                // failed, stopped, exit 1, and then did it again every two
                // seconds. Nothing about signing in gets easier by retrying.
                self.timers.respawn = None;
            }
            ExitVerdict::Unexpected => {
                if ran_for >= HEALTHY_RUN {
                    self.backoff_step = 0;
                }
                let delay = BACKOFF_SECS[self.backoff_step.min(BACKOFF_SECS.len() - 1)];
                self.backoff_step = (self.backoff_step + 1).min(BACKOFF_SECS.len() - 1);
                self.log.line(&format!("respawning in {delay}s"));
                self.timers.respawn = Some(Instant::now() + Duration::from_secs(delay));
            }
        }
    }

    fn fire_timers(&mut self) {
        let now = Instant::now();

        if matches!(self.timers.quiet, Some(at) if at <= now) {
            self.timers.quiet = None;
            self.state.quiet_expired();
        }

        if matches!(self.timers.drain, Some(at) if at <= now) {
            self.timers.drain = None;
            self.log
                .line("the drain window passed with no stopped event. Not killing it.");
            // The restart still owed, so the sentence about it can stop promising
            // a new run beside the line saying the old one went quiet. Passed
            // rather than taken, because this file owns the restart and `state.rs`
            // owns every sentence.
            self.state.on_drain_timeout(self.restart_note_owed);
        }

        if matches!(self.timers.respawn, Some(at) if at <= now) {
            self.timers.respawn = None;
            self.spawn_core();
        }

        if let Some((at, word)) = self.timers.word {
            if at <= now {
                self.timers.word = None;
                self.log.line(&format!(
                    "wrote {word} to the core's stdin and nothing came back. \
                     Not killing it and not respawning: the run is still healthy, \
                     it just does not know the word."
                ));
                self.state.on_word_unanswered(word);
            }
        }

        if matches!(self.timers.detach, Some(at) if at <= now) {
            self.timers.detach = None;
            self.log.line(
                "the core did not confirm the detach inside the window. Leaving anyway, \
                 which is what the second click asked for.",
            );
            self.exit_shell();
        }

        if matches!(self.timers.update_check, Some(at) if at <= now) {
            self.timers.update_check = None;
            self.start_update_check(now);
        }

        // Nothing to do here but let it lapse: the render at the end of the
        // loop is the thing this timer exists to wake up for.
        if matches!(self.timers.render, Some(at) if at <= now) {
            self.timers.render = None;
        }
    }

    // -- the updater -------------------------------------------------------

    /// The launch check, armed once.
    ///
    /// TRAY-DESIGN section 5 says "check for an update on launch and once every
    /// 24 hours after", and [`updater::FIRST_CHECK_AFTER`] carries the reason the
    /// launch one waits twenty seconds rather than firing inside `setup`.
    ///
    /// One env seam, and it is the same shape as `PHOTO_PIGEON_CORE_JS`: setting
    /// [`paths::env_names::UPDATE_CHECK`] to `off` means no check ever goes out
    /// of this process. The e2e rig and any run on a machine that must not talk
    /// to GitHub use it, and it is a read of the environment rather than a
    /// `cfg!(debug_assertions)` so that a release build can be held back too.
    fn arm_first_update_check(&mut self) {
        if updater::checks_are_off() {
            self.log.line(&format!(
                "update checks are off: {}=off",
                paths::env_names::UPDATE_CHECK
            ));
            return;
        }
        self.log.line(&format!(
            "update checks are on: the first goes out in {}s and then every {}h",
            updater::FIRST_CHECK_AFTER.as_secs(),
            updater::CHECK_EVERY.as_secs() / 3600
        ));
        self.timers.update_check = Some(Instant::now() + updater::FIRST_CHECK_AFTER);
    }

    /// Ask the endpoint, and download whatever it turns up.
    ///
    /// Quiet by construction: no toast, no window, no menu item beyond the one
    /// word the Quit label gains when the bytes are in. A check that fails is a
    /// line in the log, because an update nobody asked for may not fail in
    /// somebody's face.
    fn start_update_check(&mut self, now: Instant) {
        if !self.updates.may_check_now(now) {
            // Reachable only if the timer and the rule ever disagree, which is
            // worth a line rather than a silent skip.
            self.log.line(&format!(
                "an update check was due and the policy declined it, stage {:?}",
                self.updates.stage()
            ));
            return;
        }
        self.updates.note_check_started();
        self.log.line("checking for an update");

        let app = self.app.clone();
        let log = self.log.clone();
        let tx = self.tx.clone();
        // Tauri's async runtime rather than a thread of our own, because the
        // plugin's `check` and `download` are futures. The result comes back on
        // the supervisor's own channel, so every decision about it is still made
        // on this thread and there is no lock between the two.
        tauri::async_runtime::spawn(async move {
            let news = look_for_an_update(&app, &log).await;
            let _ = tx.send(Msg::Update(news));
        });
    }

    fn on_update_news(&mut self, news: UpdateNews) {
        let now = Instant::now();
        match news {
            UpdateNews::Newest => {
                self.log
                    .line("checked for an update: this is already the newest version");
                self.updates.note_check_done(now);
                self.arm_next_update_check(now);
            }
            UpdateNews::Failed(why) => {
                // Never a toast and never an attention state. A background
                // check that could not reach GitHub is not the user's problem
                // and there is nothing for them to do about it.
                self.log
                    .line(&format!("the update check did not finish: {why}"));
                self.updates.note_check_done(now);
                self.arm_next_update_check(now);
            }
            UpdateNews::Ready { version, ready } => {
                self.log.line(&format!(
                    "update {version} is downloaded, verified and waiting for a clean quit, \
                     {} bytes held",
                    ready.bytes.len()
                ));
                self.updates.note_ready(now, version, *ready);
                // No next check is armed. One update at a time:
                // `updater::may_check` would refuse anyway, and an alarm clock
                // for a call that cannot be made is just a wakeup.
            }
        }
    }

    fn arm_next_update_check(&mut self, from: Instant) {
        if updater::checks_are_off() {
            return;
        }
        self.timers.update_check = Some(from + updater::CHECK_EVERY);
    }

    /// Hand the bytes to the installer, if this exit is one that may.
    ///
    /// Returns true when the installer has been dispatched, which means this
    /// process is on its way out through `std::process::exit(0)` inside the
    /// plugin and the caller must do nothing else at all.
    ///
    /// **This is the only caller of `install()` and `exit_shell` is the only
    /// caller of this.** Both halves matter: `updater::Updates` will not hand
    /// the payload over except on the verdict, and the verdict is only ever
    /// asked at the moment the shell is already leaving.
    fn hand_over_to_the_installer(&mut self) -> bool {
        // Read before the verdict is asked, because asking it takes the payload.
        // It is the line the mid-delivery proof is read out of: a run that
        // refused has to be able to name the version it was holding, or a
        // passing run looks exactly like a run where nothing was ever wired.
        let waiting = self.updates.held_version().map(str::to_string);
        let way_out = updater::leaving(
            self.child.is_some(),
            self.state.detached(),
            matches!(
                self.state.status,
                CoreStatus::Stopping(_) | CoreStatus::Quitting
            ),
            self.updates.drain_confirmed(),
        );
        let held = match self.updates.take_for_install(way_out) {
            Ok(held) => held,
            Err(hold) => {
                // Only worth a line when there was something to install. Every
                // other quit of every up to date copy would otherwise say so.
                if hold != updater::Hold::NothingWaiting {
                    self.log.line(&format!(
                        "not installing update {} on this exit, {:?}: {}",
                        waiting.as_deref().unwrap_or("(none held)"),
                        way_out,
                        hold.why()
                    ));
                }
                return false;
            }
        };

        self.log.line(&format!(
            "installing update {} on the way out, {:?}. This is the last thing this process does.",
            held.version, way_out
        ));

        let app = self.app.clone();
        let log = self.log.clone();
        let ReadyUpdate { update, bytes } = held.payload;
        // On the main thread, because the plugin's own `on_before_exit` hook is
        // Tauri's `cleanup_before_exit` and the exit it performs is the app's.
        // One hop, and after it either the installer has replaced this process
        // or the app exits without it: never both, and never neither.
        let dispatched = self.app.run_on_main_thread(move || {
            if let Err(why) = update.install(&bytes) {
                // On Windows a successful install never returns: the plugin
                // hands the file to the shell and calls `std::process::exit(0)`.
                // So reaching this line means the installer did not start, and
                // the honest answer is to quit as the user asked and try again
                // on the next launch.
                log.line(&format!(
                    "the installer would not start: {why}. Leaving without it."
                ));
            }
            app.exit(0);
        });
        if dispatched.is_err() {
            self.log
                .line("could not reach the main thread to install, exiting instead");
            return false;
        }
        true
    }

    // -- the child ---------------------------------------------------------

    fn request_stop(&mut self, intent: StopIntent) {
        self.state.on_stop_requested(intent);
        self.timers.drain = Some(Instant::now() + DRAIN_TIMEOUT);

        // One bare line, from the layout contract, never a JSON envelope: the
        // core's stdin parser takes `stop` and `quit` and answers anything
        // else on stderr by name.
        //
        // And stdin stays open afterwards. This is not tidiness, it is a trap
        // found by running it: the core reads EOF as a stop request too, so a
        // shell that writes `stop` and then closes stdin has asked twice, and
        // a second stop means "stop being patient". Measured on this machine,
        // 28 July 2026: `"stop" | node dist/cli.js watch --events ndjson ...`
        // emitted `stopping reason=stdin`, then `stopping reason=impatient`,
        // and exited 130 with the drain cut short. Exactly the abandoned batch
        // the bench exists to prevent, arrived at by being helpful.
        if !self.write_line(paths::stop_line(), "stop") {
            // The next best thing, and the same request in the core's eyes.
            self.log
                .line("could not write stop, closing stdin so the core reads EOF");
            if let Some(live) = self.child.as_mut() {
                live.stdin = None;
            }
        }
    }

    /// Write one of the M3 words and start waiting for it to be answered.
    ///
    /// The wait is the part that matters. A core one version behind answers an
    /// unknown word on stderr and carries on watching, so a shell that wrote
    /// `pause` and simply believed it would show a paused menu over a running
    /// upload. [`WORD_TIMEOUT`] turns that into a sentence instead.
    fn write_word(&mut self, line: &str, word: &'static str) {
        if self.write_line(line, word) {
            self.timers.word = Some((Instant::now() + WORD_TIMEOUT, word));
        } else {
            self.state.on_word_unanswered(word);
        }
    }

    /// One bare line onto the child's stdin, and stdin stays open afterwards.
    ///
    /// Never a JSON envelope: the core's stdin parser is eight lines long and
    /// takes bare words, and it answers anything else on stderr by name.
    fn write_line(&mut self, line: &str, label: &str) -> bool {
        let wrote = match self.child.as_mut().and_then(|live| live.stdin.as_mut()) {
            Some(stdin) => stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.flush())
                .is_ok(),
            None => false,
        };
        if wrote {
            self.log.line(&format!("wrote {label} to the core's stdin"));
        } else {
            self.log
                .line(&format!("could not write {label} to the core's stdin"));
        }
        wrote
    }

    fn spawn_core(&mut self) {
        if self.child.is_some() {
            self.log.line("spawn asked for while a core is already running, ignored");
            return;
        }
        if self.state.action_is_setup() {
            // A watch against a config that does not exist exits, is respawned
            // by the backoff ladder, exits again, and toasts that the engine
            // stopped. None of that is news on a machine nobody has set up yet.
            self.log
                .line("no config yet, so no core is spawned: the setup window is the way in");
            return;
        }
        let Some(launch) = self.launch.clone() else {
            // prepare() already put the reason on the state and in the log.
            return;
        };

        self.state.on_spawn();
        // Nothing said to the last child is owed an answer by this one.
        self.timers.word = None;
        self.timers.detach = None;
        // And nothing the last child confirmed vouches for this one. Without
        // this line a restart's clean drain would still be on the record when a
        // later run went quiet, and the install would happen on evidence about a
        // process that has been gone for hours.
        self.updates.forget_core_stopped();

        let args = launch.watch_args(self.config.as_deref());
        let mut command = Command::new(&launch.program);
        command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // A tray app must never flash a console. This is also why the release
        // build sets windows_subsystem = "windows" in main.rs.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        self.log.line(&format!(
            "spawning {} {:?}",
            launch.program.display(),
            args
        ));

        let mut child: Child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let why = format!("{err}");
                self.log.line(&format!("spawn failed: {why}"));
                self.state.on_spawn_failed(why);
                return;
            }
        };

        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stdout_thread = stdout.map(|pipe| pump(pipe, self.tx.clone(), Stream::Out));
        let stderr_thread = stderr.map(|pipe| pump(pipe, self.tx.clone(), Stream::Err));

        let tx = self.tx.clone();
        thread::Builder::new()
            .name("pigeon-reaper".into())
            .spawn(move || {
                let code = child.wait().ok().and_then(|status| status.code());
                // Both pipes are drained before the exit is announced, so the
                // last `stopped` event can never lose a race with it.
                if let Some(handle) = stdout_thread {
                    let _ = handle.join();
                }
                if let Some(handle) = stderr_thread {
                    let _ = handle.join();
                }
                let _ = tx.send(Msg::Exited(code));
            })
            .expect("the reaper thread could not be started");

        self.log.line(&format!("core started, pid {pid}"));
        self.child = Some(Live {
            pid,
            stdin,
            started_at: Instant::now(),
        });
    }

    // -- the menu's two openers --------------------------------------------

    /// The core's rotating log, named by the core itself in `started`.
    ///
    /// The file when there is one, its folder when there is not. A person who
    /// clicks "Open log" wants to read the log, not to go looking for it in
    /// Explorer, and the folder is only useful when the file has not been
    /// written yet or the run never got far enough to name it. The shell's own
    /// log is the last resort, because a run that never reached `started` is
    /// exactly the run whose story is only in the shell log.
    fn open_log(&mut self) {
        let core_log = self.state.core_log_path.as_ref().map(PathBuf::from);
        let target = core_log
            .clone()
            .filter(|path| path.is_file())
            .or_else(|| core_log.and_then(|path| path.parent().map(PathBuf::from)))
            .filter(|path| path.exists())
            .or_else(|| Some(self.log.path().to_path_buf()));

        match target {
            Some(path) => self.open_path(path),
            None => self.log.line("open log: nothing to open yet"),
        }
    }

    /// The menu item, which opens a folder when there is one to open and hands
    /// the click to the status window when there is a list. See
    /// [`watched_menu_click`] for why it stopped opening the first one.
    fn open_watched_folder(&mut self) {
        match watched_menu_click(&self.state.watch_dirs) {
            OpenWatched::Folder(dir) => {
                let dir = PathBuf::from(dir);
                self.open_path(dir);
            }
            OpenWatched::StatusWindow => {
                self.log.line(&format!(
                    "open watched folder with {} of them, opening the status window instead",
                    self.state.watch_dirs.len()
                ));
                self.show_window(Page::Status);
            }
            OpenWatched::Nothing => self
                .log
                .line("open watched folder: the core has not said what it watches yet"),
        }
    }

    /// One watched folder, by its index in the list the shell published and by
    /// what that row said it was. The status window's per-folder rows, and the
    /// only thing that reaches this.
    ///
    /// Resolved here against the live list rather than trusting the index that
    /// arrived: `ipc::open_watched` has already answered the page off the
    /// published copy, and between that answer and this line a new config could
    /// have landed. The shell never reads the config file, so the list is
    /// whatever the core last said in `started`. This is the check that matters
    /// of the two, because this is the one that runs immediately before the
    /// folder opens.
    fn open_watched_at(&mut self, index: usize, named: &str) {
        match watched_row(&self.state.watch_dirs, index, named) {
            Ok(dir) => {
                let dir = PathBuf::from(dir);
                self.open_path(dir);
            }
            Err(why) => self.log.line(&format!("open watched folder: {why}")),
        }
    }

    fn open_path(&self, path: PathBuf) {
        self.log.line(&format!("opening {}", path.display()));
        let app = self.app.clone();
        let log = self.log.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Err(err) = app.opener().open_path(path.to_string_lossy(), None::<&str>) {
                log.line(&format!("could not open {}: {err}", path.display()));
            }
        });
    }

    // -- output ------------------------------------------------------------

    /// Publish what a window would show. Cheap, and done on every render so a
    /// page is never more than one event behind the menu.
    fn publish(&mut self, render: &Render) {
        let snapshot = window_snapshot(&self.state, render, self.autostart_on, self.log.path());
        if let Ok(mut held) = self.snapshot.lock() {
            *held = snapshot;
        }
    }

    fn render(&mut self) {
        let render = tray_render(&self.state, self.autostart_on, self.updates.waiting());
        self.publish(&render);

        if self.last_render.as_ref() == Some(&render) {
            return;
        }

        // The icon is what a person watches, so it never waits. Text can.
        let icon_changed = self.last_render.as_ref().map(|last| last.icon) != Some(render.icon);
        if !icon_changed {
            if let Some(last_at) = self.last_render_at {
                let since = last_at.elapsed();
                if since < RENDER_MIN_GAP {
                    self.timers.render = Some(last_at + RENDER_MIN_GAP);
                    return;
                }
            }
        }

        self.timers.render = None;
        self.last_render = Some(render.clone());
        self.last_render_at = Some(Instant::now());

        let app = self.app.clone();
        let _ = self
            .app
            .run_on_main_thread(move || tray::apply(&app, &render));
    }

    fn exit_shell(&mut self) {
        // Whether the batch survives this exit is the one thing worth recording
        // about it, and it is exactly the thing M2 could not say.
        self.log.line(if self.state.detached() {
            "shell exiting, detached: the core finishes the drain on its own"
        } else {
            "shell exiting"
        });
        // The quit path's last decision, and the only place in this program that
        // can reach an installer. TRAY-DESIGN section 5: "`install()` must be the
        // last thing the quit path ever does", because on Windows the app is
        // exited automatically when install runs. So it goes after the log line
        // and instead of the exit, never before either.
        if self.hand_over_to_the_installer() {
            return;
        }
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || app.exit(0));
    }
}

/// What the menu's "Open watched folder" means, which depends on how many
/// folders there are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenWatched<'a> {
    /// Exactly one watched folder, so the click can only mean that one.
    Folder(&'a str),
    /// Several, so the click means "show me them", and the status window is
    /// where each one has its own row. A menu cannot draw a list.
    StatusWindow,
    /// The core has not said what it watches yet. The shell never reads the
    /// config file: that is the core's, and it announces the answer in
    /// `started`.
    Nothing,
}

/// Which of the three a click on the menu item is.
///
/// **This used to be `watch_dirs[0]`, unconditionally**, which is a guess the
/// menu is not entitled to make: a person watching Camera Roll and Screenshots
/// clicked one item and got one of them, with nothing on screen to say the other
/// existed. The status-window reshape gives every watched
/// folder its own row in the status window, so the click has somewhere honest to
/// go.
fn watched_menu_click(dirs: &[String]) -> OpenWatched<'_> {
    match dirs {
        [] => OpenWatched::Nothing,
        [only] => OpenWatched::Folder(only.as_str()),
        _ => OpenWatched::StatusWindow,
    }
}

/// The row a page clicked: where it is, and what it said it was.
///
/// **An index alone is not an address, and that is the independent pass's banked
/// finding.** The page's list is up to one poll old, so a folder removed from the
/// front of it shifts every row below by one while the window still shows the old
/// order: row 1 said Screenshots when it was drawn, index 1 is Videos by the time
/// the click lands, and both are in range, so nothing out of range catches it. The
/// click opens a folder the person did not press. It is bounded (only ever another
/// folder they chose to watch, and nothing moves, uploads or is deleted) and it is
/// still the sort of thing that teaches somebody not to trust a window.
///
/// **The path is not the address.** [`watched_at`] still resolves the index, on
/// this side, against a list this process owns; the string a page sends can only
/// ever turn the answer into a refusal. So no new privilege arrives with it: a
/// page still cannot name a folder for this process to open, and the seam is the
/// one `remove_watched_folder` already crosses. Compared exactly, because the
/// string is the one the shell published and the page renders it verbatim: a page
/// that prettified a path would be a page whose Open button opened something else.
///
/// The refusal is a sentence for the same reason every other refusal here is one:
/// a click that quietly does nothing is a dead button, and the person is holding
/// a list that has already changed under them.
pub fn watched_row<'a>(dirs: &'a [String], index: usize, named: &str) -> Result<&'a str, String> {
    let at = watched_at(dirs, index)?;
    if at != named {
        // Displayed rather than debugged, because a Windows path written with
        // escapes reads as a second, wrong path: `C:\\Photos` is what a person
        // sees and not what is on their disk.
        return Err(format!(
            "that row is not the folder it was when the window drew it, so nothing was opened. \
             It said \"{named}\" and folder {index} is \"{at}\" now."
        ));
    }
    Ok(at)
}

/// One watched folder out of the list the shell itself published.
///
/// The index comes from a page, which got the list from a snapshot, so it can be
/// stale by one config change: the page's row three may be gone. Both callers of
/// [`watched_row`] reach this through it, and they are deliberately two.
/// `ipc::open_watched` checks against the published snapshot so the page gets a
/// sentence back on the same call, and the supervisor checks again against its own
/// live list before it opens anything, because the published copy is a copy and
/// the live list is the truth. Out of range is a refusal both times and never a
/// panic: a panic here is on the supervisor thread, and that thread owns the child
/// process.
fn watched_at(dirs: &[String], index: usize) -> Result<&str, String> {
    dirs.get(index)
        .map(String::as_str)
        .ok_or_else(|| match dirs.len() {
            0 => format!(
                "there is no watched folder {index} to open: \
                 the core has not said what it watches yet."
            ),
            len => format!(
                "there is no watched folder {index} to open. This copy is watching {len} of \
                 them, so the last one is {}.",
                len - 1
            ),
        })
}

/// One complete picture of the tray, computed from the state and from the
/// registry read, and from nothing else.
///
/// A free function rather than a method because everything it needs is in its
/// arguments, and because a [`Supervisor`] cannot be built in a test: it owns an
/// `AppHandle`. The rule below is the reason that matters.
fn tray_render(state: &AppState, autostart_on: bool, update_waiting: bool) -> Render {
    let (action_label, action_enabled) = state.action_item();
    Render {
        icon: state.icon(),
        status_line: state.status_line(),
        storage_line: state.storage_line(),
        tooltip: state.tooltip(),
        action_label,
        action_enabled,
        deliver_now_enabled: state.deliver_now_enabled(),
        // The one thing an update is allowed to say out loud, and it says it on
        // the item that performs it. `updater::quit_label` owns the rule that it
        // is never offered on a press that installs nothing.
        quit_label: updater::quit_label(state.quit_item(), update_waiting, state.status),
        open_folder_enabled: state.first_watch_dir().is_some(),
        open_log_enabled: true,
        autostart_checked: autostart_on,
        autostart_enabled: cfg!(windows),
    }
}

/// What a window sees, derived from the tray's own picture.
///
/// **Everything the two surfaces share is copied off the [`Render`] rather than
/// worked out again, and that is the whole reason this function exists.** The
/// status-window reshape puts Pause, Resume and Deliver now
/// on the status window as well as in the menu, so there are two surfaces
/// offering the same three actions. Two surfaces that each decide for themselves
/// whether Deliver now is available are two surfaces that will eventually
/// disagree in front of a person, and the one that is wrong will be whichever one
/// they are looking at. One computation, two readers: `state.rs` decides,
/// [`tray_render`] asks it once, and this copies the answer.
///
/// The engine button is the one field that is asked for again rather than
/// copied, because it is the one thing the two surfaces do not share: the menu's
/// action item is also Start watching, Try again and Set up Photo Pigeon, and a
/// window's Pause button is only ever a pause or a resume. `state.rs` still owns
/// both answers and a test pins them equal wherever they mean the same thing, so
/// this is still one decision in one file. See [`StatusSnapshot::engine_control`].
fn window_snapshot(
    state: &AppState,
    render: &Render,
    autostart_on: bool,
    shell_log_path: &std::path::Path,
) -> StatusSnapshot {
    StatusSnapshot {
        status_line: render.status_line.clone(),
        storage_line: render.storage_line.clone(),
        storage_honesty: state::STORAGE_HONESTY.to_string(),
        icon: format!("{:?}", render.icon).to_lowercase(),
        attention: state.attention().map(|a| a.line()),
        engine_control: state.engine_control(),
        deliver_now_enabled: render.deliver_now_enabled,
        watch_dirs: state.watch_dirs.clone(),
        delivered: state.delivered,
        skipped: state.skipped,
        failed: state.failed,
        bytes: state.bytes,
        last_delivery: state.last_delivery.clone(),
        core_pid: state.core_pid,
        core_version: state.core_version.clone(),
        dry_run: state.dry_run,
        autostart_on,
        autostart_available: cfg!(windows),
        notice: state.notice().map(str::to_string),
        core_log_path: state.core_log_path.clone(),
        shell_log_path: shell_log_path.display().to_string(),
        recent: state.recent(),
    }
}

#[derive(Clone, Copy)]
enum Stream {
    Out,
    Err,
}

/// Read a pipe to the end, framing as we go.
///
/// The framing is ours rather than a library's, which is the fallback
/// TRAY-DESIGN section 2 note 2 named for the case where a plugin's line
/// splitting has a ceiling. Taking it up front means the 64 KB line the M0
/// table never got to measure arrives whole by construction.
fn pump<R: Read + Send + 'static>(
    mut pipe: R,
    tx: Sender<Msg>,
    stream: Stream,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name(match stream {
            Stream::Out => "pigeon-stdout".into(),
            Stream::Err => "pigeon-stderr".to_string(),
        })
        .spawn(move || {
            let mut assembler = LineAssembler::new();
            let mut buffer = [0u8; 8192];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        for framed in assembler.push(&buffer[..read]) {
                            if tx.send(wrap(stream, framed)).is_err() {
                                return;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            if let Some(framed) = assembler.finish() {
                let _ = tx.send(wrap(stream, framed));
            }
        })
        .expect("a pipe reader thread could not be started")
}

/// What a restart request has to do, given where the core is.
///
/// A pure function because the M3 review's third critical made the argument for
/// it: reaching the real thing needs an `AppHandle`, and a decision that cannot
/// be tested is a decision that ships whatever it happens to do. Every branch
/// here is a case that would otherwise be found by somebody clicking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestartPlan {
    /// The shell is on its way out. It does not start a run it cannot look after.
    Refuse,
    /// A stop is already on the wire for a restart. One stop, never two.
    Wait,
    /// The user is holding the queue. Their resume performs the restart.
    WhenResumed,
    /// Nothing is running, so there is nothing to drain first.
    Spawn,
    /// Ask for the drain, and start again when the child is really gone.
    StopFirst,
}

/// What one launch does about the Run value, from the four facts that decide it.
///
/// Pure for the same reason [`RestartPlan`] is pure: reaching the real thing
/// needs an `AppHandle`, and a decision that cannot be tested is a decision that
/// ships whatever it happens to do. The case that made this one worth pulling
/// out is uninstall then reinstall, where every fact is ordinary and the answer
/// used to be silently wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutostartPlan {
    /// Nobody has been asked yet and this build owns the shipped value. Apply
    /// the default.
    DefaultOn,
    /// Nobody has been asked yet and the name belongs to a build tree. Nothing
    /// is written without a click.
    NoDefault,
    /// The recorded choice is on and there is no value. Something outside the
    /// app took it, so it goes back.
    ReArm,
    /// Keep whatever is really in the key true, and leave an off switch off.
    Reassert,
}

fn autostart_plan(
    decided: bool,
    off_chosen: bool,
    value_present: bool,
    may_default_on: bool,
) -> AutostartPlan {
    let _ = (off_chosen, value_present);
    if !decided {
        return if may_default_on {
            AutostartPlan::DefaultOn
        } else {
            AutostartPlan::NoDefault
        };
    }
    AutostartPlan::Reassert
}

fn restart_plan(status: CoreStatus, has_child: bool) -> RestartPlan {
    match status {
        CoreStatus::Stopping(StopIntent::Quit | StopIntent::Detach) | CoreStatus::Quitting => {
            RestartPlan::Refuse
        }
        CoreStatus::Stopping(StopIntent::Restart) => RestartPlan::Wait,
        // Before the pause arms on purpose: with no child there is nothing
        // holding a queue, and a `stop` written to a process that is not there
        // would leave the shell waiting for an exit that cannot come.
        _ if !has_child => RestartPlan::Spawn,
        CoreStatus::Pausing | CoreStatus::Paused => RestartPlan::WhenResumed,
        _ => RestartPlan::StopFirst,
    }
}

/// One updater round trip: ask the endpoint, and download whatever it turns up.
///
/// Async, and therefore on Tauri's runtime rather than on the supervisor thread.
/// It decides nothing: it comes back with one of three facts and the supervisor
/// owns every rule about what to do with them.
///
/// `check()` and `download()` are two calls rather than
/// `download_and_install()` on purpose, and it is the reason TRAY-DESIGN section
/// 5 says Tauri v2 is comfortable here rather than merely acceptable: v1 only
/// had the combined call, and the combined call installs. Nothing in this
/// process may install except the quit path.
///
/// The download's own progress is deliberately unreported. There is no progress
/// bar to feed, the user did not ask for this and must not be told a number
/// about it, and a callback per chunk on a background download is exactly the
/// kind of churn the render coalescing exists to avoid.
async fn look_for_an_update(app: &AppHandle, log: &ShellLog) -> UpdateNews {
    let updater = match app.updater() {
        Ok(updater) => updater,
        // Reachable for a real reason rather than a theoretical one: the plugin
        // refuses to build with no endpoints, so a config that lost its
        // `plugins.updater` block lands here rather than crashing a launch.
        Err(why) => return UpdateNews::Failed(format!("the updater could not be built: {why}")),
    };

    let found = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return UpdateNews::Newest,
        Err(why) => return UpdateNews::Failed(format!("{why}")),
    };

    let version = found.version.clone();
    log.line(&format!(
        "update {version} is available, this copy is {}. Downloading quietly.",
        found.current_version
    ));

    // The signature is checked inside `download` against the public key in
    // `tauri.conf.json`, so bytes that reach the next line are bytes this
    // project signed. That is a minisign signature and not Authenticode: it
    // proves an update came from us and does nothing whatever for SmartScreen.
    match found.download(|_chunk, _total| {}, || {}).await {
        Ok(bytes) => UpdateNews::Ready {
            version,
            ready: Box::new(ReadyUpdate {
                update: Box::new(found),
                bytes,
            }),
        },
        Err(why) => UpdateNews::Failed(format!("downloading {version} failed: {why}")),
    }
}

/// Is a stop already on the wire that Quit must take over rather than repeat?
///
/// A second `stop` line is the impatient path in the core's `waitForStop`:
/// `queue.leaveNow()`, exit 130, and whatever was mid flight dropped. The M2
/// review found exactly this trap when Quit was pressed during a pause, in the
/// milestone where a pause was implemented as a stop. Pause is a word now, so
/// the only stop that can be outstanding for a reason other than quitting is a
/// restart.
fn takes_over_the_stop(status: CoreStatus) -> bool {
    matches!(status, CoreStatus::Stopping(StopIntent::Restart))
}

/// What a finished setup run means for the engine.
///
/// `None` means nothing was written, so nothing changed: a wizard cancelled
/// halfway exits cleanly on `stop` and leaves no config, which is why this reads
/// the disk rather than the exit code.
///
/// **This used to depend on a second fact and that was the defect.** The gate was
/// `action_is_setup()`, true only on a machine that had no config at all, so a
/// setup run that ended over a live config did nothing whatsoever: the file was
/// rewritten, nothing restarted, nothing was said, and the user saw a success
/// screen and no change until the next launch. That is the M4 review's banked
/// minor. A config that exists after a setup run is a config the engine should be
/// running on, whether or not there was one there before.
fn setup_ended_plan(config_exists: bool) -> Option<RestartReason> {
    if !config_exists {
        return None;
    }
    Some(RestartReason::Setup)
}

/// A drain window that is already running is pushed out by one more event.
///
/// Any line from the core is evidence that it is alive and working, which is
/// the only thing the window is trying to establish. It never starts a window:
/// only a stop request does that, so a chatty core outside a drain changes
/// nothing here.
fn renew_drain(timers: &mut Timers, now: Instant) {
    if timers.drain.is_some() {
        timers.drain = Some(now + DRAIN_TIMEOUT);
    }
}

/// Is this event the answer to the word that is being waited on?
///
/// Deliberately generous. A core that answers `pause` with `paused` is the
/// happy path; a core that answers it by stopping, or by losing its lock, has
/// still answered in the only sense the timer cares about, which is that the
/// shell is no longer waiting for something that may never come. The only thing
/// that must not clear the timer is the ordinary chatter of a run that carried
/// on as if nothing had been said, because that is precisely the case the timer
/// exists to catch.
fn answers_a_word(event: &crate::events::CoreEvent, waiting_for: Option<&'static str>) -> bool {
    use crate::events::CoreEvent;
    let Some(word) = waiting_for else {
        return false;
    };
    match event {
        // Any way of ending the run answers everything outstanding.
        CoreEvent::Stopping { .. } | CoreEvent::Stopped { .. } | CoreEvent::Detached => true,
        // A run that stood down or needs a person is not going to answer, and
        // saying so twice helps nobody.
        CoreEvent::LockLost { .. } | CoreEvent::AuthNeeded { .. } => true,
        CoreEvent::Paused { .. } => word == "pause",
        CoreEvent::Resumed { .. } => word == "resume",
        // Work flowing again is an answer to a resume whether or not the core
        // also said so in words.
        CoreEvent::Delivering { found, .. } => word == "resume" && *found > 0,
        CoreEvent::Delivered { .. } => word == "resume",
        _ => false,
    }
}

fn wrap(stream: Stream, framed: Framed) -> Msg {
    match stream {
        Stream::Out => Msg::Stdout(framed),
        Stream::Err => Msg::Stderr(framed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backoff_widens_and_then_stops_widening() {
        // No tight loop at the start, no giving up at the end.
        assert_eq!(BACKOFF_SECS[0], 2);
        assert!(BACKOFF_SECS.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(*BACKOFF_SECS.last().unwrap(), 300);
    }

    #[test]
    fn timers_wait_for_the_nearest_one() {
        let now = Instant::now();
        let timers = Timers {
            quiet: Some(now + Duration::from_secs(2)),
            drain: Some(now + Duration::from_secs(60)),
            ..Timers::default()
        };
        let wait = timers.wait(now).expect("something to wait for");
        assert!(wait <= Duration::from_secs(2));
        assert_eq!(Timers::default().wait(now), None);
    }

    #[test]
    fn proof_of_life_pushes_the_drain_window_out_and_never_starts_one() {
        let now = Instant::now();
        let mut draining = Timers {
            drain: Some(now + Duration::from_secs(1)),
            ..Timers::default()
        };
        renew_drain(&mut draining, now);
        assert_eq!(draining.drain, Some(now + DRAIN_TIMEOUT));

        // Nothing was asked to stop, so nothing is waiting on a drain.
        let mut idle = Timers::default();
        renew_drain(&mut idle, now);
        assert_eq!(idle.drain, None);
    }

    #[test]
    fn the_drain_window_outlasts_the_cores_own_retry_ladder() {
        // `API_LIMITS.MIN_BACKOFF_MS` in src/contracts.ts: a 429 parks the
        // queue for thirty seconds before it tries again, and the ladder is
        // exponential from there. A window shorter than several rungs turns the
        // ordinary weather of a busy upload into an attention state and an
        // offer to abandon the batch, which is the opposite of the job.
        const MIN_BACKOFF: Duration = Duration::from_secs(30);
        assert!(
            DRAIN_TIMEOUT >= MIN_BACKOFF * 4,
            "a drain window of {DRAIN_TIMEOUT:?} expires inside the core's own retry ladder"
        );
    }

    /// The confirmation timer's whole job: notice a core that did not answer.
    ///
    /// The failure it exists for is concrete rather than theoretical. A shell
    /// of this build against a core that predates the M3 vocabulary gets its
    /// `pause` answered on stderr and watched right past, so without this the
    /// menu would show a paused engine that was still uploading.
    #[test]
    fn ordinary_chatter_is_never_mistaken_for_an_answer() {
        use crate::events::CoreEvent;
        // Exactly what an old core does with a word it does not know: nothing
        // at all, and then carries on saying what it was already saying.
        let ignored = [
            CoreEvent::Scanning { dirs: vec![] },
            CoreEvent::Delivering {
                found: 0,
                reason: Some("scan".into()),
            },
            CoreEvent::Skipped {
                path: "a.jpg".into(),
                reason: None,
            },
            CoreEvent::Failed {
                path: Some("a.mov".into()),
                error: "too big".into(),
            },
            CoreEvent::Started {
                pid: Some(1),
                version: None,
                watch_dirs: vec![],
                album: None,
                dry_run: false,
                once: false,
                ledger_path: None,
                lock_path: None,
                log_path: None,
            },
        ];
        for event in ignored {
            assert!(
                !answers_a_word(&event, Some("pause")),
                "{event:?} was taken as an answer to pause"
            );
        }
    }

    #[test]
    fn the_answer_to_a_word_is_the_word_coming_back() {
        use crate::events::CoreEvent;
        assert!(answers_a_word(
            &CoreEvent::Paused {
                reason: Some("user".into()),
                resumes_at: None
            },
            Some("pause")
        ));
        assert!(answers_a_word(
            &CoreEvent::Resumed {
                reason: Some("user".into())
            },
            Some("resume")
        ));
        // Crossed wires are not answers: a `resumed` does not settle a pause.
        assert!(!answers_a_word(
            &CoreEvent::Resumed { reason: None },
            Some("pause")
        ));
        // Anything that ends the run answers everything outstanding, because
        // there will be no further answer and complaining after the fact helps
        // nobody.
        for word in ["pause", "resume"] {
            assert!(answers_a_word(
                &CoreEvent::Stopped {
                    exit_code: 0,
                    totals: None
                },
                Some(word)
            ));
            assert!(answers_a_word(
                &CoreEvent::AuthNeeded {
                    reason: "invalid_grant".into()
                },
                Some(word)
            ));
        }
        // And with nothing outstanding, nothing is an answer.
        assert!(!answers_a_word(&CoreEvent::Detached, None));
    }

    /// Work flowing is an answer to a resume and never to a pause, which is
    /// the one asymmetry in that function worth a test of its own.
    #[test]
    fn photos_going_out_close_a_resume_and_leave_a_pause_open() {
        use crate::events::CoreEvent;
        let delivering = CoreEvent::Delivering {
            found: 3,
            reason: Some("resumed".into()),
        };
        assert!(answers_a_word(&delivering, Some("resume")));
        assert!(!answers_a_word(&delivering, Some("pause")));
    }

    /// The status window's buttons and the tray's menu items are one decision.
    ///
    /// The status-window reshape: the status window is the
    /// main UI and Pause, Resume and Deliver now live on it, with the menu
    /// keeping the same items as duplicates. So there are two surfaces offering
    /// three actions, and the failure this pins is a page that works out for
    /// itself whether Pause is available. A page cannot see the state machine;
    /// it would have to guess from a status line, and it would guess wrong in
    /// exactly the states that matter, which are the ones where an action is
    /// spelled differently or is not there at all.
    ///
    /// The field names are asserted through the serialized form on purpose. They
    /// are the contract with `status.js`, and camelCase is what the page reads.
    #[test]
    fn a_page_reads_the_menus_own_controls_and_never_its_own_opinion() {
        let log = std::path::Path::new("tray.log");
        let mut state = AppState::new();
        state.on_spawn();
        state.apply(&crate::events::CoreEvent::Started {
            pid: Some(4321),
            version: None,
            watch_dirs: vec!["C:\\Photos".into()],
            album: None,
            dry_run: false,
            once: false,
            ledger_path: None,
            lock_path: None,
            log_path: None,
        });

        let render = tray_render(&state, false, false);
        let snapshot = window_snapshot(&state, &render, false, log);
        let json = serde_json::to_value(&snapshot).expect("the snapshot serializes");

        // A running engine: the menu says Pause and so does the page, and the
        // page is told it may ask for a delivery.
        assert_eq!(json["engineControl"]["label"], "Pause");
        assert_eq!(json["engineControl"]["word"], "pause");
        assert_eq!(json["engineControl"]["enabled"], true);
        assert_eq!(json["deliverNowEnabled"], true);
        // Deliver now is the same item on both surfaces, so it is the Render's
        // own answer and not a second computation. The engine button is not the
        // Render's action item, on purpose, and where the two really do mean the
        // same thing they are pinned equal in `state.rs`; here the pin is that
        // the words the menu is drawn from are the words the page is given.
        assert_eq!(json["deliverNowEnabled"], render.deliver_now_enabled);
        assert_eq!(json["engineControl"]["label"], render.action_label);
        assert_eq!(json["engineControl"]["enabled"], render.action_enabled);

        // Mid pause is the state a page would get wrong: the word has been
        // written and not answered yet, so the one action is neither Pause nor
        // Resume and nothing may be asked for at all.
        state.on_pause_requested();
        let render = tray_render(&state, false, false);
        let json = serde_json::to_value(window_snapshot(&state, &render, false, log))
            .expect("the snapshot serializes");
        assert_eq!(
            json["engineControl"]["label"],
            "Pausing, finishing what is in flight"
        );
        assert_eq!(json["engineControl"]["word"], serde_json::Value::Null);
        assert_eq!(json["engineControl"]["enabled"], false);
        assert_eq!(json["deliverNowEnabled"], false);

        // And parked: Resume, and still no delivery, because a rescan asked of
        // a held queue fills a queue nobody is draining.
        state.apply(&crate::events::CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        let render = tray_render(&state, false, false);
        let json = serde_json::to_value(window_snapshot(&state, &render, false, log))
            .expect("the snapshot serializes");
        assert_eq!(json["engineControl"]["label"], "Resume");
        assert_eq!(json["engineControl"]["word"], "resume");
        assert_eq!(json["engineControl"]["enabled"], true);
        assert_eq!(json["deliverNowEnabled"], false);

        // The watched folders were already here, and they are what the window's
        // per-folder rows are drawn from.
        assert_eq!(json["watchDirs"][0], "C:\\Photos");
    }

    /// The fifth icon state reaches a page under its own name, and the sentence
    /// beside it is the tray's sentence.
    ///
    /// Project decision: the red badge is only worth having if the
    /// three surfaces agree about it, and they agree here by being one
    /// computation: the tooltip, the menu row and the window all come off the
    /// [`Render`] this function copies. A page that had to work out from a status
    /// line whether the engine was broken would get it wrong in exactly the state
    /// where being wrong costs the most.
    #[test]
    fn a_page_is_told_the_engine_is_broken_in_the_trays_own_words() {
        let log = std::path::Path::new("tray.log");
        let mut state = AppState::new();
        state.on_spawn();
        state.apply(&crate::events::CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        state.on_child_exit(Some(1));
        assert_eq!(state.status, CoreStatus::Halted);

        let render = tray_render(&state, false, false);
        let json = serde_json::to_value(window_snapshot(&state, &render, false, log))
            .expect("the snapshot serializes");

        // The name the page receives, which is the enum's own name lowercased and
        // therefore cannot drift from it.
        assert_eq!(json["icon"], "broken");
        // One sentence, three readers.
        assert_eq!(json["statusLine"], render.status_line);
        assert!(render.tooltip.contains("needs you"), "{:?}", render.tooltip);
        assert_eq!(json["attention"], state.attention().expect("a line").line());

        // And the crash loop, which is the other way in and the one whose words
        // had to change: "will retry" was true of a wobble and is a promise
        // nobody keeps at the top of the ladder.
        let mut looping = AppState::new();
        looping.on_spawn();
        looping.apply(&crate::events::CoreEvent::Started {
            pid: Some(9),
            version: None,
            watch_dirs: vec!["C:\\Photos".into()],
            album: None,
            dry_run: false,
            once: false,
            ledger_path: None,
            lock_path: None,
            log_path: None,
        });
        looping.on_child_exit(Some(1));
        looping.note_giving_ground();
        let render = tray_render(&looping, false, false);
        let json = serde_json::to_value(window_snapshot(&looping, &render, false, log))
            .expect("the snapshot serializes");
        assert_eq!(json["icon"], "broken");
        assert_eq!(json["statusLine"], render.status_line);
        assert!(
            !render.status_line.contains("shortly"),
            "{:?}",
            render.status_line
        );
    }

    /// One watched folder is a folder. Several are a list, and a list has a
    /// place to live now.
    ///
    /// The status-window reshape: each watched folder opens
    /// from its own row in the status window, and the menu item stops guessing.
    /// It used to open `watch_dirs[0]` whatever the config said, so a person
    /// watching Camera Roll and Screenshots clicked "Open watched folder" and
    /// got one of them, with nothing on screen to say the other existed. The
    /// menu cannot draw a list, so it hands the click to the surface that can.
    #[test]
    fn the_menus_open_watched_folder_stops_guessing_when_there_are_several() {
        let one = vec!["C:\\Photos".to_string()];
        assert_eq!(watched_menu_click(&one), OpenWatched::Folder("C:\\Photos"));

        let several = vec!["C:\\Camera Roll".to_string(), "C:\\Screenshots".to_string()];
        assert_eq!(watched_menu_click(&several), OpenWatched::StatusWindow);

        // And with nothing yet, nothing happens: the shell never reads the
        // config file, so before the core's `started` event it does not know
        // what is watched and will not pretend to.
        assert_eq!(watched_menu_click(&[]), OpenWatched::Nothing);
    }

    /// A page names an index into a list the shell gave it, and the shell
    /// resolves it. Never a path.
    #[test]
    fn a_watched_folder_is_reached_by_index_and_out_of_range_is_a_sentence() {
        let dirs = vec!["C:\\Camera Roll".to_string(), "C:\\Screenshots".to_string()];
        assert_eq!(watched_at(&dirs, 0), Ok("C:\\Camera Roll"));
        assert_eq!(watched_at(&dirs, 1), Ok("C:\\Screenshots"));

        // The click that matters here is a stale one: the page's list is from
        // the last snapshot, a new config has landed, and row three no longer
        // exists. A refusal that says how many there are, never a panic on the
        // supervisor thread, which would take the tray icon with it.
        let why = watched_at(&dirs, 2).expect_err("refused");
        assert!(why.contains("watching 2 of them"), "{why}");
        assert!(!why.contains('\u{2014}'), "em dash in {why}");

        // And before the core has said anything, the sentence says that rather
        // than counting to zero at the user.
        let why = watched_at(&[], 0).expect_err("refused");
        assert!(why.contains("has not said what it watches"), "{why}");
    }

    /// A list that shrinks from the front inside the poll lag opens the folder
    /// the row named, or it opens nothing.
    ///
    /// The independent pass's banked finding, and the state it needs is the
    /// ordinary one: three folders on screen, the first one removed, the page one
    /// second behind. Row 1 said Screenshots when it was drawn and index 1 is
    /// Videos by the time the click lands, and both are in range, so nothing
    /// out-of-range catches it. Bounded (it can only ever be another folder the
    /// user chose to watch, and nothing moves or uploads) and still wrong: the row
    /// a person pressed is not the folder that opened, which is the kind of thing
    /// that teaches somebody not to trust the window.
    ///
    /// So the row carries what it says as well as where it is. The path is not the
    /// address and never becomes one: `watched_at` still resolves the index, and
    /// the string is only ever able to make the answer a refusal.
    #[test]
    fn a_row_never_opens_a_folder_it_did_not_name() {
        let published = vec![
            "C:\\Camera Roll".to_string(),
            "C:\\Screenshots".to_string(),
            "C:\\Videos".to_string(),
        ];
        let named = watched_at(&published, 1).expect("the row the page drew");

        // One poll later, the front of the list is gone.
        let live = vec!["C:\\Screenshots".to_string(), "C:\\Videos".to_string()];
        // The index alone still resolves, to the wrong folder, which is the whole
        // defect and is why the index alone is not an address any more.
        assert_eq!(watched_at(&live, 1), Ok("C:\\Videos"));

        let why = watched_row(&live, 1, named).expect_err("refused");
        assert!(why.contains("C:\\Screenshots"), "{why}");
        assert!(why.contains("C:\\Videos"), "{why}");
        assert!(!why.contains('\u{2014}'), "em dash in {why}");

        // And the row that still says what it said opens, so the check is not
        // simply a refusal generator: this is the ordinary case, every time.
        assert_eq!(watched_row(&live, 0, "C:\\Screenshots"), Ok("C:\\Screenshots"));
        assert_eq!(watched_row(&published, 2, "C:\\Videos"), Ok("C:\\Videos"));
    }

    /// Out of range is still out of range, and it is still a sentence.
    #[test]
    fn a_row_that_is_gone_altogether_says_so_rather_than_comparing_nothing() {
        // The check the fix adds runs after the resolution, so a row that no
        // longer exists keeps the answer it already had: how many there are, and
        // never a panic on the thread that owns the child process.
        let live = vec!["C:\\Screenshots".to_string()];
        let why = watched_row(&live, 2, "C:\\Videos").expect_err("refused");
        assert!(why.contains("watching 1 of them"), "{why}");
        assert!(!why.contains('\u{2014}'), "em dash in {why}");
    }

    /// A config that changed means one stop and one new run, never two stops.
    ///
    /// The failure this holds off is the one the bench in `src/commands/watch.ts`
    /// exists to forbid: a second `stop` line is `impatient` in the core's own
    /// `waitForStop`, which calls `queue.leaveNow()` and exits 130 with the batch
    /// in flight dropped. A file that was uploaded but not yet written to the
    /// ledger then goes again on the next start. Two clicks on Remove in a row is
    /// the ordinary way to get here.
    #[test]
    fn a_second_config_change_waits_for_the_stop_that_is_already_going() {
        assert_eq!(
            restart_plan(CoreStatus::Stopping(StopIntent::Restart), true),
            RestartPlan::Wait
        );
    }

    #[test]
    fn a_config_change_drains_a_running_core_before_starting_the_new_one() {
        for status in [CoreStatus::Starting, CoreStatus::Running, CoreStatus::Resuming] {
            assert_eq!(restart_plan(status, true), RestartPlan::StopFirst, "{status:?}");
        }
    }

    #[test]
    fn a_config_change_with_nothing_running_just_starts_something() {
        // Including the states a first run and a refused start leave behind. This
        // arm is checked before the pause arm on purpose: a `stop` written to a
        // process that is not there leaves the shell waiting for an exit that
        // cannot arrive.
        for status in [
            CoreStatus::Cold,
            CoreStatus::Halted,
            CoreStatus::Backoff,
            CoreStatus::Paused,
        ] {
            assert_eq!(restart_plan(status, false), RestartPlan::Spawn, "{status:?}");
        }
    }

    /// A pause the user asked for is not the shell's to lift.
    ///
    /// A fresh run comes up running, so restarting a paused core would answer
    /// "change my folder list" with "and your pause is gone", which is the shell
    /// undoing a gesture nobody withdrew. The resume performs the restart instead,
    /// and the run that comes up is both unpaused and on the new list.
    #[test]
    fn a_config_change_under_a_pause_waits_for_the_resume() {
        for status in [CoreStatus::Pausing, CoreStatus::Paused] {
            assert_eq!(
                restart_plan(status, true),
                RestartPlan::WhenResumed,
                "{status:?}"
            );
        }
    }

    #[test]
    fn a_shell_on_its_way_out_starts_nothing() {
        // Every one of these means the shell is leaving. A run started now would
        // be orphaned by the exit a moment later, and the core that is draining
        // was already told what to do.
        for status in [
            CoreStatus::Stopping(StopIntent::Quit),
            CoreStatus::Stopping(StopIntent::Detach),
            CoreStatus::Quitting,
        ] {
            assert_eq!(restart_plan(status, true), RestartPlan::Refuse, "{status:?}");
        }
    }

    #[test]
    fn quit_takes_over_a_restarts_stop_rather_than_asking_twice() {
        assert!(takes_over_the_stop(CoreStatus::Stopping(StopIntent::Restart)));
        // And it does not take over anything else. A quit with no stop on the
        // wire has to write one, and a quit during a quit is the second press,
        // which is the detach and is decided before this is asked.
        for status in [
            CoreStatus::Running,
            CoreStatus::Paused,
            CoreStatus::Stopping(StopIntent::Quit),
            CoreStatus::Stopping(StopIntent::Detach),
            CoreStatus::Quitting,
            CoreStatus::Cold,
        ] {
            assert!(!takes_over_the_stop(status), "{status:?}");
        }
    }

    /// The M4 review's banked minor, closed.
    ///
    /// Re-running setup from the tray on a configured, running machine wrote a
    /// new config, restarted nothing and said nothing: the user saw a success
    /// screen and no change at all until the next launch. The gate was
    /// `action_is_setup()`, which is only true on a machine that had nothing,
    /// so the one case where a config was being *replaced* was the one case that
    /// did nothing about it.
    #[test]
    fn a_setup_over_a_live_config_starts_the_engine_again() {
        assert_eq!(setup_ended_plan(true), Some(RestartReason::Setup));
    }

    #[test]
    fn a_setup_that_was_cancelled_changes_nothing() {
        // Read off the disk and not off the exit code: a wizard cancelled halfway
        // exits cleanly on `stop` and leaves no config behind.
        assert_eq!(setup_ended_plan(false), None);
    }

    /// The reinstall failure the sandbox rig caught on 30 July 2026.
    ///
    /// Install, uninstall, reinstall, and the relaunched shell left nothing
    /// under HKCU Run at all. Every fact here is ordinary: the uninstaller
    /// deletes the Run value by design and spares the shell's state file by
    /// design, so the launch after the reinstall reads the question as settled,
    /// finds no value, and used to call that absence an off click.
    #[test]
    fn a_run_value_that_is_gone_with_no_off_click_behind_it_is_written_again() {
        assert_eq!(
            autostart_plan(true, false, false, true),
            AutostartPlan::ReArm
        );
    }

    #[test]
    fn an_off_click_outlives_the_value_it_removed() {
        // The same three facts with the click recorded. Writing the value again
        // here would undo a gesture nobody withdrew, which is the whole reason
        // an absent value could not simply be written back unconditionally.
        assert_eq!(
            autostart_plan(true, true, false, true),
            AutostartPlan::Reassert
        );
    }

    #[test]
    fn a_value_that_is_present_is_left_to_the_reassertion() {
        // Task Manager's off switch leaves the value in the key and marks it
        // off in StartupApproved. Writing it again would set that record back
        // to enabled and undo the switch, so a value that exists keeps this
        // branch out of it whichever way the off record reads. The rule that an
        // off switch outranks a stale path stays where it already lives.
        for off_chosen in [false, true] {
            assert_eq!(
                autostart_plan(true, off_chosen, true, true),
                AutostartPlan::Reassert,
                "off_chosen {off_chosen}"
            );
        }
    }

    #[test]
    fn a_build_tree_writes_nothing_it_was_not_asked_for() {
        // The rail in autostart.rs, checked at the branch that would otherwise
        // walk around it: a working tree with no value in the key is exactly
        // the shape the re-arm fires on.
        assert_eq!(
            autostart_plan(false, false, false, false),
            AutostartPlan::NoDefault
        );
        assert_eq!(
            autostart_plan(true, false, false, false),
            AutostartPlan::Reassert
        );
    }

    #[test]
    fn the_first_run_default_reads_nothing_but_the_question_being_open() {
        // Nobody has been asked, so there is no click to have recorded and no
        // value to have kept. Pinned anyway, because an unanswered question and
        // a recorded on click look identical in the off flag alone, and a plan
        // that consulted it here would make the two indistinguishable.
        for value_present in [false, true] {
            assert_eq!(
                autostart_plan(false, false, value_present, true),
                AutostartPlan::DefaultOn,
                "value_present {value_present}"
            );
        }
    }

    /// The same failure against the real Run key, rather than against booleans.
    ///
    /// Everything above is a table. This one puts a value in the key, deletes
    /// it the way the uninstaller does, asks the plan what the next launch
    /// makes of that, and checks the bytes come back.
    ///
    /// Safety: the name carries this process id and the word selftest, so it
    /// cannot collide with the value an installed copy owns. It asserts the
    /// name is not the product's before it writes anything, and it removes both
    /// the Run value and the StartupApproved companion afterwards.
    #[cfg(windows)]
    #[test]
    fn a_wiped_run_value_is_really_written_again_at_the_next_launch() {
        let name = format!("photo-pigeon-rearm-selftest-{}", std::process::id());
        assert!(
            !name.eq_ignore_ascii_case("photo-pigeon") && !name.eq_ignore_ascii_case("Photo Pigeon"),
            "a test may never write the value an installed copy owns"
        );
        assert_eq!(
            autostart::recorded_value(&name),
            None,
            "{name} was already in the Run key"
        );

        let exe = std::path::Path::new(
            "C:\\Users\\Test Person\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe",
        );
        let auto = Autostart::scoped(&name, exe);

        // The install: the default fires and the value lands.
        if let Err(why) = auto.enable() {
            let _ = auto.disable();
            eprintln!("skipped: this machine would not take a Run value ({why})");
            return;
        }
        assert!(autostart::recorded_value(&name).is_some());

        // The uninstall: one DeleteRegValue, and the shell's own state file is
        // outside everything the uninstaller reaches, so the flags stand.
        auto.disable().expect("the value comes back out");
        assert_eq!(autostart::recorded_value(&name), None);
        let decided = true;
        let off_chosen = false;

        // The launch after the reinstall.
        let plan = autostart_plan(
            decided,
            off_chosen,
            autostart::recorded_value(&name).is_some(),
            auto.may_default_on(),
        );
        assert_eq!(plan, AutostartPlan::ReArm);
        assert!(!auto.is_enabled(), "nothing is on before the launch acts");
        auto.enable().expect("the launch writes the value again");

        assert_eq!(
            autostart::recorded_value(&name).as_deref(),
            Some(
                "\"C:\\Users\\Test Person\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe\" --autostart"
            ),
            "start with Windows is still dead after the reinstall"
        );
        assert!(auto.is_enabled());

        auto.disable().expect("the value comes back out");
        assert_eq!(
            autostart::recorded_value(&name),
            None,
            "the test left a Run value behind"
        );
        autostart::clean_startup_approved(&name);
    }

    #[test]
    fn an_expired_timer_waits_for_nothing_rather_than_underflowing() {
        let now = Instant::now();
        let timers = Timers {
            quiet: Some(now - Duration::from_secs(5)),
            ..Timers::default()
        };
        assert_eq!(timers.wait(now), Some(Duration::ZERO));
    }

    /// The repo's own build output, if this is a dev checkout that has run
    /// `npm run build`. `None` means the process test below skips itself.
    fn dev_cli() -> Option<PathBuf> {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let candidate = manifest.parent()?.parent()?.join("dist").join("cli.js");
        candidate.is_file().then_some(candidate)
    }

    /// Everything this shell promises about the core, checked against the core
    /// rather than against this file's opinion of it.
    ///
    /// Three claims are on trial and all three broke somebody at M1: the
    /// argument vector really is what the CLI accepts, stdout under
    /// `--events ndjson` really is strict JSON with no prose in it, and a bare
    /// `stop` line really does produce `stopping` then `stopped` then an exit.
    /// A shell that got any of them wrong would time out and reach for a kill,
    /// which is the abandoned half batch this whole design exists to prevent.
    ///
    /// Safety: the run is pointed at a temp config with `-c`, which gives it a
    /// temp ledger and therefore a lock of its own, so it cannot contend with
    /// a production watch. `--dry-run` is added on top so no credential is
    /// needed and nothing is uploaded. Skips itself when there is no built
    /// `dist/cli.js` or no `node`, so it never fails a machine that simply is
    /// not a dev checkout.
    #[test]
    fn the_real_core_answers_the_argument_vector_and_the_stop_line() {
        let Some(cli) = dev_cli() else {
            eprintln!("skipped: no dist/cli.js, run npm run build in the repo root");
            return;
        };

        let scratch = std::env::temp_dir().join(format!(
            "photo-pigeon-tray-e2e-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(scratch.join("photos")).expect("scratch dirs");
        let config = scratch.join("config.json");
        std::fs::write(
            &config,
            format!(
                r#"{{"watchDirs":[{:?}],"extensions":[".jpg"]}}"#,
                scratch.join("photos").to_string_lossy()
            ),
        )
        .expect("scratch config");

        let launch = crate::paths::CoreLaunch {
            program: "node".into(),
            core_js: cli,
            source: "test".into(),
        };
        let mut args = launch.watch_args(Some(&config.to_string_lossy()));
        // Not part of the shipped vector. It is here so the run needs no
        // Google credentials and can send nothing anywhere.
        args.push("--dry-run".into());

        let mut command = Command::new(&launch.program);
        command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                eprintln!("skipped: could not run node ({err})");
                let _ = std::fs::remove_dir_all(&scratch);
                return;
            }
        };

        let mut stdin = child.stdin.take().expect("piped stdin");
        let (tx, rx) = mpsc::channel::<Msg>();
        let out = pump(child.stdout.take().expect("piped stdout"), tx.clone(), Stream::Out);
        let err = pump(child.stderr.take().expect("piped stderr"), tx.clone(), Stream::Err);
        drop(tx);

        let mut state = AppState::new();
        state.on_spawn();
        let mut kinds: Vec<String> = Vec::new();
        let mut stderr_lines: Vec<String> = Vec::new();
        let mut sent_stop = false;
        let deadline = Instant::now() + Duration::from_secs(60);

        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "the core never finished. saw {kinds:?}");
            match rx.recv_timeout(left.min(Duration::from_millis(250))) {
                Ok(Msg::Stdout(Framed::Line(line))) => {
                    let parsed = crate::events::parse_line(&line)
                        .unwrap_or_else(|| panic!("a blank line on the machine channel"));
                    let parsed = match parsed {
                        ParsedLine::Event(event) => event,
                        // The M1 stage 2 review's second critical: English
                        // prose reaching stdout. It is a hard failure here.
                        ParsedLine::Rejected(why) => {
                            panic!("stdout carried something that is not an event: {why}\n{line}")
                        }
                    };
                    kinds.push(parsed.kind.clone());
                    state.apply(&parsed.event);

                    if !sent_stop && parsed.kind == "delivering" {
                        state.on_stop_requested(StopIntent::Quit);
                        stdin
                            .write_all(paths::stop_line().as_bytes())
                            .and_then(|_| stdin.flush())
                            .expect("the stop line was written");
                        sent_stop = true;
                    }
                }
                Ok(Msg::Stderr(Framed::Line(line))) => stderr_lines.push(line),
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        let _ = out.join();
        let _ = err.join();
        let status = child.wait().expect("the core exited");

        assert!(sent_stop, "never reached a delivering event. saw {kinds:?}");
        assert_eq!(kinds.first().map(String::as_str), Some("started"));
        assert_eq!(
            kinds.last().map(String::as_str),
            Some(paths::stopped_event_type()),
            "stopped is always the last line of a run. saw {kinds:?}"
        );
        assert!(kinds.iter().any(|k| k == "stopping"), "saw {kinds:?}");
        // This exit code is the guard on the stdin-stays-open rule in
        // request_stop. Close stdin after writing the stop line and the core
        // reads a second stop, cuts the drain short and exits 130 instead.
        assert_eq!(status.code(), Some(0));
        assert_eq!(
            kinds.iter().filter(|k| *k == "stopping").count(),
            1,
            "the core was asked to stop more than once. saw {kinds:?}"
        );

        // The state machine agrees with the process: a stop we asked for.
        assert_eq!(
            state.on_child_exit(status.code()),
            ExitVerdict::Expected(StopIntent::Quit)
        );
        assert_eq!(state.status, CoreStatus::Quitting);
        assert_eq!(state.first_watch_dir(), Some(scratch.join("photos").to_string_lossy().as_ref()));

        // The human channel is where the prose lives, and it is not empty:
        // that is the other half of the split working.
        assert!(!stderr_lines.is_empty(), "stderr said nothing at all");

        let _ = std::fs::remove_dir_all(&scratch);
    }
}
