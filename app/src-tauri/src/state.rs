//! What the tray knows, and what it therefore shows.
//!
//! Everything in this file is pure: events and user gestures go in, a
//! [`Render`] comes out. No process, no clock, no Tauri handle. The
//! supervisor owns the timers and calls [`AppState::quiet_expired`] when one
//! fires, which keeps the whole state machine testable without waiting for
//! two real seconds.
//!
//! The event to icon mapping is TRAY-DESIGN section 3, with one correction
//! carried in from the M2 brief: `paused-quota` is an attention state with its
//! own tooltip line, not the grey paused icon. The grey icon means a person
//! pressed Pause. That distinction matters, because a quota pause is something
//! the user should look at and a manual pause is not.
//!
//! ## What M3 changed in here, and why the changes are behavioural
//!
//! **Pause is real.** At M2 it was a stop and a respawn, which was honest and
//! free in the core and cost a full re-hash of the library on resume. The core
//! now takes a `pause` line that closes intake and holds the queue, so
//! [`CoreStatus::Paused`] means *the child is alive and still watching*, where
//! at M2 it meant there was no child at all. Every state that used to be
//! reached by killing and re-spawning is now reached by a word, which is why
//! [`StopIntent`] lost its `Pause` arm.
//!
//! **Quit's second press is finally true.** The M2 labels said the engine
//! carried on after the shell left and the code could not keep that promise:
//! the shell holds the only write handle on the child's stdin, so leaving is an
//! end of file, and an end of file reaching a core that is already stopping was
//! a *second* stop, which the core answered with `queue.leaveNow()` and exit
//! 130. M3 adds the word that fixes it. `detach` says "finish without me", and
//! after it the core is required to ignore the EOF that follows. So the label
//! that was retired for lying is back, and it is now a description.

use std::collections::VecDeque;

use serde::Serialize;

use crate::events::{CoreEvent, Totals};
use crate::toasts::{StoppedWhy, Toast};

/// What a person calls this program.
///
/// Project decision: humans read "Photo Pigeon" everywhere copy is
/// human facing (this constant, productName, the installer, the Start Menu
/// entry, the tooltip, the toasts, the menu). Machines keep photo-pigeon: the
/// npm name, `photo-pigeon.exe`, the bundle identifier, `~/.photo-pigeon` and
/// the CLI's own banner, because a terminal product may keep its terminal name.
///
/// A test in this module reads `tauri.conf.json` and fails if productName ever
/// drifts from this string, because the two are the same fact in two files: the
/// Run value name, the install directory and the Start Menu shortcut all come
/// from productName, and the tooltip and the toasts all come from here.
pub const DISPLAY_NAME: &str = "Photo Pigeon";

/// The five tray icons. **Five, and it said four until a walk of the built
/// icons found the fifth.**
///
/// The law that came with the four is not weakened by the fifth, because the law
/// was never the number: **every state here has a trigger and a clearing
/// condition, so the icon cannot get stuck.** That is the entry fee, the fifth
/// pays it in full, and the table below is where it is paid. What that walk
/// found was not a missing colour, it was that amber was
/// carrying two jobs that ask a person for opposite things.
///
/// | State | Trigger | Cleared by |
/// |---|---|---|
/// | `Idle` | a run that is up with nothing in flight | nothing to clear, it is the resting state |
/// | `Delivering` | work, through [`AppState::note_work`], which arms the quiet window in the same breath | that window expiring, and for a scan the `delivering` the core always sends after one |
/// | `Paused` | a `paused` event that is not the quota's | a `resumed` that is not the quota's, and only that one |
/// | `Attention` | anything in [`Attention`] over a live run, or a crash the shell is still retrying | the thing itself going: the menu clears the failure flavour, a `resumed` clears the budget, auth and lock clear when they are really fixed, and a respawn that gets up clears a crash |
/// | `Broken` | [`CoreStatus::Halted`], or the respawn ladder at its ceiling with nothing up. See the variant | a core reaching `started` |
///
/// **Precedence, where two of them are true at once**, pinned by
/// `the_icon_precedence_runs_broken_paused_attention_delivering_idle`: broken,
/// then paused, then attention, then delivering, then idle. Four of those pairs
/// are reachable and the test walks each one. The first pair is not reachable
/// today, because both halves of broken are read off a status that holds one
/// value at a time and a core that has answered `pause` is a core that is up. The
/// arms are in that order anyway, so the precedence is what the code says rather
/// than what today's reachability happens to allow, and red would win the day
/// somebody makes the pair possible.
///
/// Red outranking a pause is the only one of the five worth arguing, and it goes
/// to red: "nothing will deliver until you act" is news, and "nothing is
/// delivering because you said so" is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconState {
    Idle,
    Delivering,
    Paused,
    Attention,
    /// A red badge, and the sentence it stands for is "nothing will deliver until
    /// you act".
    ///
    /// Project decision: amber and red are a severity split and the
    /// split is the point: amber is held and coming back by itself, which is what
    /// a quota hold until midnight is, and red is broken until a person does
    /// something. Before this they were one dot, so a budget that returns at
    /// midnight and an engine that will not start until somebody signs in looked
    /// identical in the only place most people ever look.
    ///
    /// **Scoped to what this side can actually know, and the boundary is written
    /// down rather than implied.** The core does not say whether a crash was a bad
    /// network moment or a config it will never load, and no event has been
    /// invented here to make it. So the trigger is the two things the shell really
    /// knows:
    ///
    ///   * [`CoreStatus::Halted`], which is already the shell's own name for a
    ///     stop no respawn can fix. It is reached by a spawn that failed, a start
    ///     the core refused, a lock another copy took, and a sign in only a person
    ///     can give: [`ExitVerdict::Refused`], [`ExitVerdict::StoodDown`] and
    ///     [`ExitVerdict::NeedsUser`] all mean a respawn walks into the same wall,
    ///     which is why the supervisor does not schedule one.
    ///   * the respawn ladder at its five minute ceiling on runs too short to be
    ///     healthy, with nothing up. Repeated failure to reach `started`, which is
    ///     the honest reading of a crash loop for a policy that never formally
    ///     gives up. See [`AppState::will_not_come_up`].
    ///
    /// What it is deliberately **not** is an ordinary crash with a respawn on a
    /// timer behind it. That stays amber, because it really may come back by
    /// itself, and that is the whole of the split.
    ///
    /// If the core ever marks a config or a token as unloadable on its way out,
    /// that is a third trigger and it is welcome here. Nothing in this file has to
    /// move to accept one.
    Broken,
}

/// Why the shell asked the core to end the run.
///
/// There is no `Pause` arm any more. Pause used to be a stop, and at M3 it is a
/// word that leaves the child alive, so the only reasons to end a run are the
/// two ways of quitting and the one way of starting again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopIntent {
    /// The user pressed Quit. `stop` is written and the shell waits for the
    /// drain to confirm before it goes.
    Quit,
    /// The user pressed Quit again. `detach` is written and the shell goes
    /// without waiting, leaving the core to finish the drain as an orphan.
    Detach,
    /// The config on disk is not the config this run loaded, so this run has to
    /// end and another has to take its place.
    ///
    /// The same `stop` line and therefore the same drain: everything already in
    /// the queue is uploaded and recorded, including files from a folder that is
    /// being dropped from the list. Abandoning a half filed batch is how a file
    /// gets uploaded twice, and a folder leaving the list is not a reason to
    /// spend that. What changes is only which folders the next run walks.
    Restart,
}

/// Where the core is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreStatus {
    /// Nothing spawned yet.
    Cold,
    /// Spawned, no `started` seen yet.
    Starting,
    /// `started` seen. The normal state.
    Running,
    /// `pause` written, not confirmed yet. The child is alive and finishing
    /// whatever was already on the wire.
    Pausing,
    /// The core confirmed the pause. Intake is closed, the queue is held, and
    /// **the child is still running**: at M2 this state meant there was no
    /// child at all, and everything that follows from that changed with it.
    Paused,
    /// `resume` written, not confirmed yet.
    Resuming,
    /// `stop` or `detach` written, waiting for the confirmation and the exit.
    Stopping(StopIntent),
    /// Died unexpectedly. A respawn is scheduled.
    Backoff,
    /// Stopped for a reason a respawn cannot fix. Needs a user gesture.
    Halted,
    /// The drain confirmed, or the detach did, and the shell is on its way out.
    Quitting,
}

/// Why the shell is restarting the engine under the user's feet.
///
/// Both of these are the same fact: the config on disk moved and the running
/// core is still on the one it loaded. They are told apart only so the sentence
/// can name what the person actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartReason {
    /// A folder was added to or removed from the Watching list.
    WatchDirs,
    /// A setup run finished over a config this machine was already running on.
    Setup,
}

/// How far a restart has got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartStage {
    /// Asked for. A drain may be running first.
    Asked,
    /// Held until the user lifts their own pause, which is what performs it.
    WhenResumed,
    /// The drain window ran out and the core has still not confirmed. The
    /// restart is not off, and it is not on its way either.
    ///
    /// The independent pass's banked finding: a core that hangs through the whole
    /// 300 second drain left [`RestartStage::Asked`]'s sentence promising a
    /// restart while [`Attention::StopUnconfirmed`] said, on the same page, that
    /// the engine had gone quiet. Both were true about different moments and the
    /// window showed them together. This stage is the one that agrees with the
    /// amber line: it names the wait and promises nothing about when it ends.
    StillFinishing,
    /// The replacement run has said `started`.
    Done,
}

/// The one plain sentence the status surface shows about a restart.
///
/// It exists because of the M4 review's banked minor: re-running setup on a
/// configured machine rewrote the config, restarted nothing and said nothing, so
/// the user saw a success screen and no change until the next launch. Editing the
/// Watching list would have been the same defect with a second door into it. A
/// config that changed and an engine still on the old one is a divergence, and a
/// divergence nobody is told about is the whole failure.
///
/// Sentence case, warm plain English, no em dash: these are read inside a window.
pub fn restart_notice(reason: RestartReason, stage: RestartStage) -> &'static str {
    match (reason, stage) {
        (RestartReason::WatchDirs, RestartStage::Asked) => {
            "Your watched folders changed, so the engine is finishing what is in flight and then starting again on the new list."
        }
        (RestartReason::WatchDirs, RestartStage::WhenResumed) => {
            "Your watched folders changed. The engine is paused, so the new list starts when you resume."
        }
        (RestartReason::WatchDirs, RestartStage::StillFinishing) => {
            "Your watched folders changed. The engine has not finished what was in flight yet, so the new list is waiting for it."
        }
        (RestartReason::WatchDirs, RestartStage::Done) => {
            "The engine is watching your new folder list."
        }
        (RestartReason::Setup, RestartStage::Asked) => {
            "Setup wrote a new config, so the engine is finishing what is in flight and then starting again on it."
        }
        (RestartReason::Setup, RestartStage::WhenResumed) => {
            "Setup wrote a new config. The engine is paused, so it starts on the new one when you resume."
        }
        (RestartReason::Setup, RestartStage::StillFinishing) => {
            "Setup wrote a new config. The engine has not finished what was in flight yet, so the new config is waiting for it."
        }
        (RestartReason::Setup, RestartStage::Done) => {
            "The engine is running on the config setup just wrote."
        }
    }
}

/// The thing worth telling the user about, most urgent first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attention {
    /// The core refused to start. Usually another copy holds the lock.
    StartRefused(String),
    /// Another process took the lock, so this run stood down.
    LockLost { held_by: Option<u32> },
    /// Sign in is needed, and it cannot be done from a tray menu.
    AuthNeeded(String),
    /// The day's Google budget is spent.
    QuotaPaused {
        reason: String,
        resumes_at: Option<String>,
    },
    /// The child went away without being asked.
    Crashed { code: Option<i32> },
    /// The shell could not spawn the core at all.
    SpawnFailed(String),
    /// A stop was asked for and not confirmed inside the drain window.
    StopUnconfirmed,
    /// A word was written to the core's stdin and nothing came back.
    ///
    /// Reachable in one real case rather than a theoretical one: a shell of
    /// this build talking to a core that predates the M3 vocabulary. That core
    /// answers an unknown word on stderr and carries on watching, so without
    /// this the menu would sit on "Pausing" forever while the engine kept
    /// uploading, which is the worst kind of disagreement between a UI and a
    /// process.
    Unanswered(&'static str),
    /// Files failed since the user last opened the menu.
    Failures(u64),
}

impl Attention {
    /// One line a window can print.
    ///
    /// The menu says this through `halted_line` and the tooltip through
    /// `tooltip_detail`, both of which are shaped by budgets a window does not
    /// have. This is the same news with no budget on it, which is what makes
    /// the status window worth opening when the tooltip has had to cut.
    pub fn line(&self) -> String {
        match self {
            Attention::StartRefused(why) => why.clone(),
            Attention::LockLost { held_by: Some(pid) } => {
                format!("Another copy of Photo Pigeon took over this folder set, so this one stopped. It is process {pid}.")
            }
            Attention::LockLost { held_by: None } => {
                "Another copy of Photo Pigeon took over this folder set, so this one stopped.".into()
            }
            Attention::AuthNeeded(why) => {
                format!("Photo Pigeon needs you to sign in again. {why}")
            }
            Attention::SpawnFailed(why) => format!("The engine could not be started. {why}"),
            Attention::Crashed { code: Some(code) } => {
                format!("The engine stopped on its own, exit code {code}.")
            }
            Attention::Crashed { code: None } => "The engine stopped on its own.".into(),
            Attention::QuotaPaused { resumes_at, .. } => match resumes_at {
                Some(at) => format!(
                    "Today's Google limit is reached. Everything else goes {}, nothing is lost.",
                    short_time(at)
                ),
                None => {
                    "Today's Google limit is reached. Everything else goes tomorrow, nothing is lost."
                        .into()
                }
            },
            Attention::StopUnconfirmed => {
                "The engine went quiet while it was finishing. Nothing has been thrown away.".into()
            }
            Attention::Unanswered(word) => {
                format!("The engine did not answer {word:?}. It may be an older build.")
            }
            Attention::Failures(1) => "One file did not go. The next pass tries again.".into(),
            Attention::Failures(count) => {
                format!("{count} files did not go. The next pass tries them again.")
            }
        }
    }

    /// Lower sorts first. Anything that stops delivery outranks anything that
    /// only slows it down.
    fn rank(&self) -> u8 {
        match self {
            Attention::StartRefused(_) => 0,
            Attention::LockLost { .. } => 1,
            Attention::AuthNeeded(_) => 2,
            Attention::SpawnFailed(_) => 3,
            Attention::Crashed { .. } => 4,
            Attention::QuotaPaused { .. } => 5,
            Attention::StopUnconfirmed => 6,
            Attention::Unanswered(_) => 7,
            Attention::Failures(_) => 8,
        }
    }
}

/// What the supervisor should do about a child that has gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitVerdict {
    /// We asked for this. What we were doing when we asked.
    Expected(StopIntent),
    /// The core refused to start and a respawn walks into the same wall.
    Refused,
    /// The lock was taken from under it. A respawn walks into the same lock.
    StoodDown,
    /// It stopped for something only a person can fix, so respawning is
    /// knocking on a door that will not open until they answer it.
    NeedsUser,
    /// It fell over. Back off and try again.
    Unexpected,
}

/// Side effects one event asks for, handed back rather than performed here.
///
/// This file has no clock, no process and no notification API, which is what
/// makes the whole state machine testable in microseconds. So it says what
/// should happen and the supervisor does it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Work just happened: restart the quiet window that clears the
    /// delivering icon.
    BumpQuiet,
    /// Raise this toast. Every decision about whether a toast is owed, and
    /// whether it has already been spent, is made here rather than at the
    /// notification API, so "never per file" is a property of the state machine
    /// and can be tested without a Windows session.
    Toast(Toast),
}

/// The status window's one engine button, as a shape rather than as a string.
///
/// The status-window reshape made that window the main UI: a left
/// click on the tray opens it, so Pause and Resume live on it and the tray menu
/// keeps its own copies of them. Two surfaces, one truth, and this is the truth.
///
/// It is not [`AppState::action_item`], and the difference is the whole reason
/// this exists. The menu's one item is also Start watching, Try again, Start
/// again now and Set up Photo Pigeon, because a menu is a list of everything a
/// person might want. A window has room for the doors those four open, and it
/// already has them: the setup link sits in the tab row and starting a stopped
/// engine stays a menu action. So this control is only ever a pause or a resume,
/// and where it is neither it is disabled rather than relabelled into something
/// the page would then have to promise.
///
/// [`EngineControl::word`] is what makes that honest. A page renders the label
/// and writes back the word, so the two cannot come apart: nothing on the page
/// reads a label to work out which of `pause` and `resume` it meant, which is
/// the mistake that would put the M3 review's first critical on a new surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineControl {
    /// What the button says. The shell's wording, never the page's.
    pub label: String,
    /// The word a click writes to the core's stdin, when there is one to write.
    /// `None` means there is nothing the core would answer, and then the button
    /// is disabled: a control that offers a refusal is worse than one that is
    /// visibly unavailable.
    pub word: Option<&'static str>,
    /// True exactly when there is a word. Sent as its own field so a page never
    /// has to derive it, and asserted rather than assumed in the tests.
    pub enabled: bool,
}

impl Default for EngineControl {
    /// What a shell that has not published anything yet would say.
    ///
    /// Read off a cold state rather than written out again here, so the empty
    /// snapshot a page may paint before the first poll lands is a real state of
    /// this machine and not a blank button.
    fn default() -> Self {
        AppState::new().engine_control()
    }
}

/// Two seconds of nothing means the queue is empty. TRAY-DESIGN section 3.
pub const QUIET_WINDOW_MS: u64 = 2_000;

/// Windows gives a tray tooltip 128 UTF-16 units including the terminator, so
/// 127 is the real budget and anything past it is silently lost or worse.
pub const TOOLTIP_MAX_UTF16: usize = 127;

/// The storage law, short enough to survive the tooltip budget.
pub const STORAGE_HONESTY_SHORT: &str = "Original quality, counts against your Google storage.";

/// The storage law in full, word for word with `STORAGE_HONESTY` in
/// `src/commands/watch.ts`.
///
/// TRAY-DESIGN section 0 requires this sentence in the first-run window, in the
/// status window and in the tooltip's expanded status, and not buried in an
/// About box. The tooltip can only carry the short form, which is why there are
/// two constants; the windows carry this one, and it is repeated here rather
/// than read from the core because a window may have to say it before any core
/// has ever started.
pub const STORAGE_HONESTY: &str =
    "Uploads are original quality and count against your Google storage. Storage Saver does not apply.";

/// Below this there is no room for a detail line worth reading, so the
/// tooltip carries the state and the law and stops there.
const MIN_DETAIL_UTF16: usize = 16;

/// What the red badge says in words when it is the crash loop that raised it.
///
/// The line for an ordinary crash is "The engine stopped. Starting it again
/// shortly.", and that is still the right thing to say about a wobble. It stops
/// being right at the top of the ladder, where the gap is five minutes and none
/// of the attempts has got in: "shortly" is then a word doing the opposite of its
/// job, and a person reading it has been told to wait for something that is not
/// coming.
///
/// So this says the two things they need, which are that nothing is going out and
/// that it is theirs to look at now. It names no menu item on purpose: this
/// sentence is shown over three statuses and the one action item is not the same
/// word in all three.
const CRASH_LOOP_LINE: &str =
    "The engine keeps stopping, so nothing is going out until you look at it.";

/// Everything the menu and the tooltip are drawn from.
#[derive(Debug, Clone)]
pub struct AppState {
    pub status: CoreStatus,
    /// The reconciliation walk is running. Held until the first `delivering`,
    /// which the core always emits after a scan, so this cannot get stuck.
    scanning: bool,
    /// Set by work, cleared by the quiet window. Only ever set through
    /// [`AppState::note_work`], because a `busy` with no quiet timer behind it
    /// is a delivering icon that never goes out.
    busy: bool,
    pub watch_dirs: Vec<String>,
    pub core_log_path: Option<String>,
    pub core_pid: Option<u32>,
    pub core_version: Option<String>,
    pub dry_run: bool,
    pub delivered: u64,
    pub skipped: u64,
    pub failed: u64,
    pub bytes: u64,
    /// The file name, never the whole path: this goes in a 127 unit tooltip.
    pub last_delivery: Option<String>,
    attention: Option<Attention>,
    /// Per file failures since the user last looked at the menu.
    failures_since_look: u64,
    /// Did this run ever reach `started`.
    saw_started: bool,
    /// A run level `failed`, meaning a `failed` with no path, before `started`.
    run_failure: Option<String>,
    /// A `lock-lost` that said it was standing down.
    stood_down: bool,
    /// This run asked for a sign in. In the shipped core that is always
    /// followed by a throw, so the run is over and a respawn only repeats it.
    auth_needed: bool,
    /// Quit was pressed once already.
    quit_pressed: bool,
    /// There is no config on this machine yet, so there is nothing to watch and
    /// nothing to start.
    ///
    /// Set once at boot by the supervisor, from the file system rather than
    /// from a core that could not start: the core is deliberately never spawned
    /// in this condition, because spawning a watch against a config that does
    /// not exist buys a crash, a backoff timer and a toast saying the engine
    /// stopped, which is a rough way to greet somebody who has not installed
    /// anything yet. Cleared when a setup run writes one.
    needs_setup: bool,
    // `first_delivery_toast_shown` was here and is gone at M4, with the flag
    // it mirrored in `shell_state.rs`. Project rule: "first
    // ever" means the ledger was empty before that delivery, which is
    // core-owned truth, so the shell does not get a second opinion about it.
    // The flag was the shell's own guess at the same question and it could be
    // wrong in both directions: a state file lost with a profile made every
    // photo the first one again, and a state file that outlived a deleted
    // ledger made none of them. The core now says which delivery it was, on
    // the delivery, and this side raises the toast when it is told to.
    /// Has the "it stopped" toast already gone out for this unhealthy stretch?
    /// A run that reaches `started` arms it again, so a core that is dying and
    /// recovering says so once per stretch rather than once per crash.
    stopped_toast_shown: bool,
    /// The respawn backoff has widened as far as it goes and no run has got up.
    ///
    /// Told rather than worked out, through [`AppState::note_giving_ground`],
    /// because the ladder belongs to the supervisor and this file has no clock.
    /// It is the same fact under the same word that already decides whether the
    /// "it stopped" toast is owed, and it is deliberately two readers of one fact
    /// rather than two opinions about it: the toast says it once out loud and the
    /// icon goes red and stays red.
    ///
    /// **It survives the spawn on purpose.** Clearing it when the next attempt
    /// starts would flash a calm pigeon every five minutes for the second or two
    /// before the next death, which is a cheerful lie about a tool that has
    /// stopped working. Only `started` clears it, because only `started` is
    /// evidence that the wall has moved.
    giving_ground: bool,
    /// Has the quota toast gone out for the hold that is on now?
    ///
    /// Its own flag rather than a reading of the attention slot, and the
    /// difference is a real double toast rather than a tidiness. Deduping on
    /// "is the attention slot already QuotaPaused" works only while nothing
    /// outranks it, and four states do: a refused start, a lost lock, auth
    /// needed and a crash. With any of those up, `raise` declines to replace
    /// the slot, a repeat reads as new, and one budget being spent toasts
    /// twice. The M3 integration finding reached that state through the
    /// duplicate `paused-quota` line, which M4 deleted on both sides at once;
    /// the flag stays because a core may still say `paused` more than once for
    /// one hold and the dedup must not depend on what else is on screen.
    quota_toast_shown: bool,
    /// The core confirmed a detach, so leaving now really does leave it
    /// finishing.
    detached: bool,
    /// The last thing the shell did to the engine on the user's behalf.
    ///
    /// One line, and it is the shell's own voice rather than the core's, which is
    /// why it is not in the recent ring: that ring holds what the core said, and a
    /// restart is something the shell decided. Replaced by the next thing the
    /// shell does and never cleared to nothing, because it is an account of what
    /// happened rather than a state that could get stuck. Anything that went
    /// wrong is [`Attention`]'s to say and outranks it on screen.
    notice: Option<String>,
    /// The last few things the core said, newest last.
    ///
    /// This is the whole of what the status window shows under "recent
    /// activity", and it is a ring rather than a log for the reason the RAM
    /// budget exists: a watch over a large library emits an event per file, so
    /// anything unbounded here is a slope on a process that is meant to be
    /// resident forever. [`RECENT_MAX`] is the cap and it is enforced on the
    /// push, so there is no path that grows it.
    ///
    /// It holds rendered strings rather than events on purpose. The window
    /// gets one shape it can print, and nothing about the core's union has to
    /// cross into a page and be parsed there.
    recent: VecDeque<RecentEvent>,
}

/// How many recent events the status window can see.
///
/// Enough to answer "what has it been doing", short enough that the memory is
/// a rounding error: a hundred entries of a few dozen bytes each.
pub const RECENT_MAX: usize = 100;

/// One line of the status window's recent activity list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEvent {
    /// The core's own ISO moment, when it sent one.
    pub at: Option<String>,
    /// The event type, exactly as it arrived.
    pub kind: String,
    /// One line a person can read. Never a path list and never a stack.
    pub detail: String,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            status: CoreStatus::Cold,
            scanning: false,
            busy: false,
            watch_dirs: Vec::new(),
            core_log_path: None,
            core_pid: None,
            core_version: None,
            dry_run: false,
            delivered: 0,
            skipped: 0,
            failed: 0,
            bytes: 0,
            last_delivery: None,
            attention: None,
            failures_since_look: 0,
            saw_started: false,
            run_failure: None,
            stood_down: false,
            auth_needed: false,
            quit_pressed: false,
            // False until the supervisor has looked at the disk, so a state
            // built for a test is an ordinary configured machine.
            needs_setup: false,
            stopped_toast_shown: false,
            giving_ground: false,
            quota_toast_shown: false,
            detached: false,
            notice: None,
            recent: VecDeque::new(),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    // -- transitions driven by the shell -----------------------------------

    /// A child was just spawned. Per run flags reset; the counters do not,
    /// because a user watching "12 delivered" does not want it to fall back to
    /// zero because the engine was restarted underneath them.
    pub fn on_spawn(&mut self) {
        self.status = CoreStatus::Starting;
        self.scanning = false;
        self.busy = false;
        self.saw_started = false;
        self.run_failure = None;
        self.stood_down = false;
        self.auth_needed = false;
        self.core_pid = None;
        // A fresh run reports its own health. Anything the old one was
        // complaining about is now unproven, so it does not get to persist.
        self.attention = None;
        self.failures_since_look = 0;
    }

    /// There is no config, or there is one now. Told to the state rather than
    /// worked out by it: the file system is the supervisor's to read.
    pub fn set_needs_setup(&mut self, needs: bool) {
        self.needs_setup = needs;
    }

    /// Say what the shell just did on the user's behalf.
    pub fn note(&mut self, line: impl Into<String>) {
        self.notice = Some(line.into());
    }

    /// The last thing the shell did, for the status window to print.
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    /// Is the one action item "Set up Photo Pigeon" rather than a pause or a
    /// restart?
    ///
    /// Only while nothing is running. If a core is up against a config that
    /// appeared after boot, the ordinary labels are the true ones and this
    /// would be a stale sentence outranking them.
    pub fn action_is_setup(&self) -> bool {
        self.needs_setup && matches!(self.status, CoreStatus::Cold)
    }

    /// The shell could not even start the process.
    pub fn on_spawn_failed(&mut self, why: impl Into<String>) {
        self.status = CoreStatus::Halted;
        self.raise(Attention::SpawnFailed(why.into()));
    }

    /// The respawn ladder has run out of ways to be patient.
    ///
    /// Called by the supervisor from the one place that can know it, beside the
    /// same computation that decides whether the "it stopped" toast is owed. Two
    /// readers of one fact: that one speaks once per unhealthy stretch, and this
    /// one turns the badge red until a run reaches `started`.
    ///
    /// A separate call rather than a second argument to [`AppState::exit_toast`],
    /// because that method latches and returns early once the toast is spent, and
    /// the badge has to go red on every crash of the stretch rather than only on
    /// the one that got to speak.
    pub fn note_giving_ground(&mut self) {
        self.giving_ground = true;
    }

    /// A stop line has been written and the drain has been asked for.
    pub fn on_stop_requested(&mut self, intent: StopIntent) {
        self.status = CoreStatus::Stopping(intent);
        self.scanning = false;
    }

    /// `pause` has been written. The child stays alive; intake is closing.
    pub fn on_pause_requested(&mut self) {
        self.status = CoreStatus::Pausing;
    }

    /// `resume` has been written.
    pub fn on_resume_requested(&mut self) {
        self.status = CoreStatus::Resuming;
        // A resume is the user saying they have dealt with it, and the run is
        // about to report its own health again.
        if matches!(self.attention, Some(Attention::Unanswered(_))) {
            self.attention = None;
        }
    }

    /// `detach` has been written: the shell is leaving and the core is being
    /// asked to finish the drain on its own.
    pub fn on_detach_requested(&mut self) {
        self.status = CoreStatus::Stopping(StopIntent::Detach);
        self.scanning = false;
    }

    /// The drain window ran out. Never a reason to kill: TRAY-DESIGN section 7.
    ///
    /// `restarting` is the reason of the restart this stop was for, when it was
    /// for one, and it is here so the two things the status window shows at once
    /// can agree. The amber line says the engine went quiet while it was
    /// finishing; the restart's own sentence said, until this call, that the
    /// engine was finishing and then starting again on the new list. Both are
    /// true about different moments and a person reads them together, which is
    /// the independent pass's banked finding. So a restart still owed gets the
    /// stage that names the wait instead of promising the end of it.
    ///
    /// Nothing is cancelled. The restart happens if the core ever confirms, and
    /// two Quit presses are still the way out.
    pub fn on_drain_timeout(&mut self, restarting: Option<RestartReason>) {
        self.raise(Attention::StopUnconfirmed);
        // The status matters as much as the reason: a Quit pressed during a
        // restart takes over the stop that is already on the wire, and a shell
        // that is leaving must not promise a new run at all.
        if let (CoreStatus::Stopping(StopIntent::Restart), Some(reason)) =
            (self.status, restarting)
        {
            self.note(restart_notice(reason, RestartStage::StillFinishing));
        }
    }

    /// A word went to stdin and nothing came back inside the window.
    ///
    /// The status goes back to what it was before the word was written, because
    /// a core that ignored the word is a core that is still doing what it was
    /// doing, and the menu has to agree with the process. Never a kill and
    /// never a respawn: the run is healthy, it simply did not understand.
    pub fn on_word_unanswered(&mut self, word: &'static str) {
        self.status = match self.status {
            CoreStatus::Pausing => CoreStatus::Running,
            CoreStatus::Resuming => CoreStatus::Paused,
            other => other,
        };
        self.raise(Attention::Unanswered(word));
    }

    /// The user pressed Quit. Returns true when this is the second press,
    /// which means detach and go.
    pub fn on_quit_pressed(&mut self) -> bool {
        let again = self.quit_pressed;
        self.quit_pressed = true;
        again
    }

    /// Did the core confirm the detach? The difference between leaving and
    /// leaving in the knowledge that the batch survives.
    pub fn detached(&self) -> bool {
        self.detached
    }

    /// The toast for a core that has gone and is not coming back by itself.
    ///
    /// Called by the supervisor right after [`AppState::on_child_exit`], which
    /// owns the verdict, with `giving_ground` set when the respawn backoff has
    /// widened as far as it goes. That is the honest reading of "after the
    /// respawns exhaust" for a policy that never actually gives up: five
    /// minutes between attempts is a tool that has stopped working, whatever
    /// the code calls it.
    ///
    /// That same flag is now the red badge's second trigger, through
    /// [`AppState::note_giving_ground`], which the supervisor calls on the line
    /// above this one. One fact, two readers, and the latch below is exactly why
    /// they are two calls: the toast is spent once per stretch and the badge has
    /// to stay up for all of it.
    ///
    /// At most once per unhealthy stretch. A run that reaches `started` arms it
    /// again, so a crash loop says so once rather than every two seconds.
    pub fn exit_toast(&mut self, verdict: &ExitVerdict, giving_ground: bool) -> Option<Toast> {
        if self.stopped_toast_shown {
            return None;
        }
        let why = match verdict {
            // Asked for. Nobody needs telling about their own click.
            ExitVerdict::Expected(_) => return None,
            ExitVerdict::Refused => StoppedWhy::Refused(
                self.run_failure
                    .clone()
                    .unwrap_or_else(|| "It could not start.".into()),
            ),
            ExitVerdict::StoodDown => match self.attention {
                Some(Attention::LockLost { held_by }) => StoppedWhy::LockLost { held_by },
                _ => StoppedWhy::LockLost { held_by: None },
            },
            // The sign-in toast has already gone out and says more than a
            // second one about the same thing would.
            ExitVerdict::NeedsUser => return None,
            ExitVerdict::Unexpected if giving_ground => StoppedWhy::Crashed,
            ExitVerdict::Unexpected => return None,
        };
        self.stopped_toast_shown = true;
        Some(Toast::Stopped { why })
    }

    /// The child is gone. Says what the supervisor should do next, and moves
    /// the state to match.
    pub fn on_child_exit(&mut self, code: Option<i32>) -> ExitVerdict {
        self.scanning = false;
        self.busy = false;
        self.core_pid = None;

        let verdict = match self.status {
            CoreStatus::Stopping(intent) => ExitVerdict::Expected(intent),
            // Pause no longer ends a run, so a child that goes while paused
            // went for a reason nobody asked for. At M2 this branch could not
            // exist, because pausing was how the child was made to leave.
            _ if self.stood_down => ExitVerdict::StoodDown,
            // The double start path, and every other refusal: a run level
            // failure and no `started` at all. A respawn walks into the same
            // wall, so it is not attempted. TRAY-DESIGN section 2.
            _ if !self.saw_started && self.run_failure.is_some() => ExitVerdict::Refused,
            // Sign in cannot be done from here and the core throws straight
            // after saying so, so every respawn would reach the same line and
            // say it again. Seen for real on 28 July 2026 against a config
            // with no client file: started, auth-needed, failed, stopped,
            // exit 1, on a two second backoff, forever.
            _ if self.auth_needed => ExitVerdict::NeedsUser,
            _ => ExitVerdict::Unexpected,
        };

        match &verdict {
            ExitVerdict::Expected(StopIntent::Quit | StopIntent::Detach) => {
                self.status = CoreStatus::Quitting;
                // A drain that timed out and then arrived late is not news.
                if matches!(self.attention, Some(Attention::StopUnconfirmed)) {
                    self.attention = None;
                }
            }
            ExitVerdict::Expected(StopIntent::Restart) => {
                // Not `Quitting`: this drain ended so another run could begin,
                // and a status that says "closing" over a shell that is staying
                // would be the menu disagreeing with the process. The spawn that
                // follows moves it on to `Starting`, and until then `Cold` is the
                // true answer: there is no child.
                self.status = CoreStatus::Cold;
                if matches!(self.attention, Some(Attention::StopUnconfirmed)) {
                    self.attention = None;
                }
            }
            ExitVerdict::Refused => {
                self.status = CoreStatus::Halted;
                let why = self
                    .run_failure
                    .clone()
                    .unwrap_or_else(|| "the engine refused to start".into());
                self.raise(Attention::StartRefused(why));
            }
            ExitVerdict::StoodDown | ExitVerdict::NeedsUser => {
                self.status = CoreStatus::Halted;
                // The lock-lost or auth-needed event already raised the
                // attention, and it says more than anything added here would.
            }
            ExitVerdict::Unexpected => {
                self.status = CoreStatus::Backoff;
                self.raise(Attention::Crashed { code });
            }
        }

        verdict
    }

    /// The quiet window expired: nothing has happened for two seconds.
    pub fn quiet_expired(&mut self) {
        self.busy = false;
    }

    /// The user opened the menu. Clears the failure flavour of attention and
    /// nothing else: auth and lock clear only when they are actually fixed.
    /// TRAY-DESIGN section 3.
    pub fn on_menu_opened(&mut self) {
        self.failures_since_look = 0;
        if matches!(self.attention, Some(Attention::Failures(_))) {
            self.attention = None;
        }
    }

    // -- transitions driven by the core ------------------------------------

    /// Fold one event in. Returns whatever the supervisor has to act on.
    /// Every event the core has said lately, newest last.
    pub fn recent(&self) -> Vec<RecentEvent> {
        self.recent.iter().cloned().collect()
    }

    /// Remember one line of what the core said.
    ///
    /// Called with the raw `type` and the moment, so the window shows the
    /// core's own vocabulary rather than a paraphrase invented here. Bounded on
    /// the push: there is no other path into the ring, so the cap cannot be
    /// got round by a busy watch.
    pub fn note_recent(&mut self, at: Option<String>, kind: &str, event: &CoreEvent) {
        let detail = describe(event);
        if self.recent.len() >= RECENT_MAX {
            self.recent.pop_front();
        }
        self.recent.push_back(RecentEvent {
            at,
            kind: kind.to_string(),
            detail,
        });
    }

    pub fn apply(&mut self, event: &CoreEvent) -> Vec<Effect> {
        let mut effects = Vec::new();
        match event {
            CoreEvent::Started {
                pid,
                version,
                watch_dirs,
                dry_run,
                log_path,
                ..
            } => {
                self.status = CoreStatus::Running;
                self.saw_started = true;
                // A run that got up is a healthy stretch, so the toast that
                // says it stopped is armed again for the next unhealthy one.
                self.stopped_toast_shown = false;
                // And it is the clearing condition for the red badge's second
                // trigger. A ladder that finally got somebody in has no verdict
                // left to carry, and this is the only line that may say so:
                // nothing about a spawn, a click or a timer is evidence that a
                // core will run, and `started` is.
                self.giving_ground = false;
                self.core_pid = *pid;
                self.core_version = version.clone();
                self.dry_run = *dry_run;
                if !watch_dirs.is_empty() {
                    self.watch_dirs = watch_dirs.clone();
                }
                if log_path.is_some() {
                    self.core_log_path = log_path.clone();
                }
            }
            CoreEvent::Scanning { dirs } => {
                self.scanning = true;
                // Through `note_work`, so the window that puts the icon out is
                // armed by the same line that lights it. A scan that runs
                // longer than the window keeps the icon anyway, because
                // `scanning` is held until `delivering` arrives.
                self.note_work(&mut effects);
                if !dirs.is_empty() {
                    self.watch_dirs = dirs.clone();
                }
            }
            CoreEvent::Delivering { found, reason } => {
                // The core emits this unconditionally after a scan, which is
                // what makes `scanning` safe to hold rather than time out.
                self.scanning = false;
                if *found > 0 {
                    self.note_work(&mut effects);
                }
                // `found: 0` deliberately arms nothing of its own. It is the
                // ordinary steady state, a healthy watch with nothing new to
                // send, and the window the scan already armed is what takes the
                // icon back to idle.

                // A quota pause lifting arrives as a `resumed` and, for a shell
                // that never learned that word, as the `delivering` the core
                // sends straight after it. Both carry `reason: "resumed"`, and
                // **that word is the whole clearing condition**, which it was
                // not until the M3 review's second critical.
                //
                // What it was: any `delivering` at all. That made "Deliver now"
                // a way of clearing the amber line without a single file moving
                // and without the hold lifting, because the click writes
                // `rescan` and a rescan answers with a `delivering` of its own,
                // reason `"rescan"`, emitted before the core has even looked at
                // whether it is paused. One click took the tray from "Google
                // limit reached, back at 00:00" to "watching" while every file
                // was still held, and nothing could put it back: the core does
                // not re-announce a hold it is already on. An icon state has to
                // be cleared by evidence, and a rescan is not evidence about the
                // budget. The scan reason is not either, for the same reason.
                if reason.as_deref() == Some("resumed") {
                    if matches!(self.attention, Some(Attention::QuotaPaused { .. })) {
                        self.attention = None;
                    }
                    // Armed again inside the same branch but outside the one
                    // above, because that one can be skipped by something
                    // outranking the quota pause in the attention slot, and the
                    // next budget being spent still deserves to be said out
                    // loud.
                    self.quota_toast_shown = false;
                }
                // Work flowing is proof a pause is over, whatever else did or
                // did not arrive.
                if matches!(self.status, CoreStatus::Resuming) && *found > 0 {
                    self.status = CoreStatus::Running;
                }
            }
            CoreEvent::Delivered {
                path,
                bytes,
                first_ever,
                ..
            } => {
                self.delivered += 1;
                self.bytes += *bytes;
                let name = file_name_of(path);
                self.last_delivery = Some(name.clone());
                self.note_work(&mut effects);
                // The one happy toast, on the very first delivery ever.
                //
                // "Ever" is the core's word and not a count kept here. The
                // core samples an empty ledger immediately before it writes
                // the entry, which is the only moment the answer is true: by
                // the time this event exists the ledger already holds the
                // line, so a shell that looked would read one on a virgin
                // install's first photo and never read zero again. Following
                // the core's word is also what makes a twelve photo first
                // batch raise one toast rather than twelve, because only one
                // of those twelve deliveries found the ledger empty.
                //
                // The consequence worth naming rather than discovering: a user
                // who deletes or loses their ledger gets one more. That is the
                // ruling taken literally, and it is the honest answer, because
                // to that install nothing has ever been delivered.
                if *first_ever {
                    effects.push(Effect::Toast(Toast::FirstDelivery { file: Some(name) }));
                }
                if matches!(self.status, CoreStatus::Resuming) {
                    self.status = CoreStatus::Running;
                }
            }
            CoreEvent::Skipped { .. } => {
                self.skipped += 1;
                self.note_work(&mut effects);
            }
            CoreEvent::Failed { path, error } => {
                if path.is_some() {
                    // A per file failure. The file is still on disk and the
                    // next scan finds it, so this is a flavour, not a stop.
                    self.failed += 1;
                    self.failures_since_look += 1;
                    let count = self.failures_since_look;
                    self.raise(Attention::Failures(count));
                    effects.push(Effect::BumpQuiet);
                } else {
                    // A `failed` with no path is the run itself. Held rather
                    // than raised: what it means depends on whether `started`
                    // was ever seen, and that is settled at exit.
                    self.run_failure = Some(error.clone());
                }
            }
            CoreEvent::AuthNeeded { reason } => {
                self.auth_needed = true;
                self.raise(Attention::AuthNeeded(reason.clone()));
                effects.push(Effect::Toast(Toast::AuthNeeded));
            }
            // The M3 pause, from the core's side. Two reasons wearing one
            // event, and they are not the same state: a quota pause is
            // something to look at, a user pause is not.
            CoreEvent::Paused { reason, resumes_at } => {
                if is_quota(reason.as_deref()) {
                    self.raise_quota_pause(
                        reason.clone().unwrap_or_default(),
                        resumes_at.clone(),
                        &mut effects,
                    );
                } else {
                    self.status = CoreStatus::Paused;
                    self.busy = false;
                    self.scanning = false;
                    // The user asked for this, so it is not a complaint.
                    if matches!(self.attention, Some(Attention::Unanswered(_))) {
                        self.attention = None;
                    }
                }
            }
            // One `resumed` per hold that lifts, which is the shape the M3
            // review's first critical bought. Two holds can be on at once and
            // neither lifts the other, so each one clears its own half of the
            // picture here and nothing else: the amber line is the budget's,
            // the grey icon is the person's, and a `resumed` that arrives while
            // the other hold is still on carries `waiting: 0` and is followed
            // by no `delivering` at all.
            CoreEvent::Resumed { reason } => {
                if is_quota(reason.as_deref()) {
                    // The budget is back. The status is deliberately untouched:
                    // a person's pause outlives midnight, and promoting to
                    // Running here would show "watching" over a queue that is
                    // still holding everything.
                    if matches!(self.attention, Some(Attention::QuotaPaused { .. })) {
                        self.attention = None;
                    }
                    // Same reasoning as the `delivering` site: the hold is over,
                    // so the next one may speak, whatever is in the slot.
                    self.quota_toast_shown = false;
                } else {
                    // The person's hold is off, whether or not anything moves
                    // yet. This is the line that ends the M3 review's first
                    // critical: the core answers a resume it could only half
                    // honour instead of answering on stderr alone, so the menu
                    // stops claiming Paused over an engine that is only waiting
                    // for midnight. The quota attention is not touched, because
                    // this event is no evidence about the budget.
                    self.status = CoreStatus::Running;
                    if matches!(self.attention, Some(Attention::Unanswered(_))) {
                        self.attention = None;
                    }
                }
            }
            CoreEvent::Detached => {
                // The word landed. Leaving now really does leave the drain
                // running, which is what the second Quit press promises.
                //
                // The status only moves if a detach was actually asked for. An
                // event nobody asked for is worth recording and is not worth
                // walking out on: a shell that quit itself because a line
                // arrived would be a background tool that can be closed by its
                // own child.
                self.detached = true;
                if self.quit_pressed {
                    self.status = CoreStatus::Stopping(StopIntent::Detach);
                }
            }
            CoreEvent::LockLost {
                held_by, stopping, ..
            } => {
                if *stopping {
                    self.stood_down = true;
                }
                self.raise(Attention::LockLost { held_by: *held_by });
            }
            CoreEvent::Stopping { .. } => {
                self.scanning = false;
                // Not a state change on its own: the shell may not have asked
                // for it (ctrl+c in a console, or a lock loss), and the exit is
                // what settles where we land.
            }
            CoreEvent::Stopped { totals, .. } => {
                self.busy = false;
                self.scanning = false;
                if let Some(totals) = totals {
                    self.absorb(totals);
                }
            }
            CoreEvent::Unknown => {}
        }
        effects
    }

    /// The run's own totals are authoritative for the run, and the shell's
    /// running counters are per session across restarts. Take the larger of
    /// the two so a restart cannot make the number go backwards and a missed
    /// event cannot make it too small.
    fn absorb(&mut self, totals: &Totals) {
        self.delivered = self.delivered.max(totals.delivered);
        self.skipped = self.skipped.max(totals.skipped);
        self.failed = self.failed.max(totals.failed);
        self.bytes = self.bytes.max(totals.bytes);
    }

    /// A quota pause, from either of the two events that can carry one.
    ///
    /// The toast is latched on the attention rather than on a flag: a core that
    /// re-announces the same pause per batch attempt says it once to the user.
    fn raise_quota_pause(
        &mut self,
        reason: String,
        resumes_at: Option<String>,
        effects: &mut Vec<Effect>,
    ) {
        let already = self.quota_toast_shown;
        self.quota_toast_shown = true;
        self.raise(Attention::QuotaPaused {
            reason,
            resumes_at: resumes_at.clone(),
        });
        self.busy = false;
        if !already {
            effects.push(Effect::Toast(Toast::QuotaPaused { resumes_at }));
        }
    }

    /// Work just happened. Lighting the icon and arming the window that puts it
    /// out are one action here, and never two.
    ///
    /// They came apart once and it cost the headline state of this milestone.
    /// `scanning` set `busy` and asked for no timer; `delivering` with
    /// `found: 0` cleared only `scanning`; and since the core emits `delivering`
    /// after every scan whether it found anything or not, the most ordinary
    /// state there is, a healthy watch with nothing new to send, held the
    /// delivering icon and the word "Delivering" for as long as it ran. The
    /// quiet window is armed by exactly one effect, so anything that sets
    /// `busy` without returning that effect can never be cleared by anything.
    fn note_work(&mut self, effects: &mut Vec<Effect>) {
        self.busy = true;
        effects.push(Effect::BumpQuiet);
    }

    fn raise(&mut self, attention: Attention) {
        let replace = match &self.attention {
            None => true,
            Some(current) => attention.rank() <= current.rank(),
        };
        if replace {
            self.attention = Some(attention);
        }
    }

    pub fn attention(&self) -> Option<&Attention> {
        self.attention.as_ref()
    }

    // -- rendering ----------------------------------------------------------

    /// The dimmed icon is driven by the core's `paused` event and by nothing
    /// else.
    ///
    /// Not by the click, and not by [`CoreStatus::Pausing`]. A user who presses
    /// Pause gets their feedback from the menu label immediately; the icon is a
    /// statement about the engine, and it may only be made once the engine has
    /// said so. The gap is milliseconds in a healthy pair and forever against a
    /// core that does not know the word, which is exactly when the icon must
    /// not have lied.
    ///
    /// The order of the arms is the precedence [`IconState`] states, and the two
    /// reds come first. `Halted` used to sit in the amber arm beside `Backoff`,
    /// which is the pair the severity split separated: one is a wall and the
    /// other is a wobble with a timer behind it.
    pub fn icon(&self) -> IconState {
        match self.status {
            // The shell's own name for "a respawn walks into the same wall".
            CoreStatus::Halted => IconState::Broken,
            // And the loop that never gets in, which is the same sentence reached
            // by counting rather than by a verdict.
            _ if self.will_not_come_up() => IconState::Broken,
            CoreStatus::Paused => IconState::Paused,
            // A crash with a respawn already on a timer. Amber, because it really
            // may come back by itself, and that is what amber now means.
            CoreStatus::Backoff => IconState::Attention,
            _ if self.attention.is_some() => IconState::Attention,
            _ if self.busy || self.scanning => IconState::Delivering,
            _ => IconState::Idle,
        }
    }

    /// The respawn ladder is out of patience and nothing has got up: the red
    /// badge's second trigger, and the sentence that goes with it.
    ///
    /// One predicate with two readers, [`AppState::icon`] and
    /// [`AppState::status_line`], so the badge and the words cannot come apart.
    /// That is the same discipline the tooltip and the status line have shared
    /// since M2, applied to the one state where being believed matters most.
    ///
    /// **`Halted` is deliberately not in here.** It is the other trigger, it has
    /// the core's own reason to quote and [`AppState::halted_line`] to quote it
    /// with, and folding the two together would put this sentence over that one.
    /// Every status is named rather than swept up by a wildcard, so a tenth
    /// `CoreStatus` has to be classified here instead of quietly landing on
    /// "delivering fine".
    fn will_not_come_up(&self) -> bool {
        self.giving_ground
            && match self.status {
                // Nothing spawned, spawned and still silent, or dead and waiting
                // out the widest gap the ladder has.
                CoreStatus::Cold | CoreStatus::Starting | CoreStatus::Backoff => true,
                // A child that has answered for itself, or one on its way out
                // with the drain still running. Also `Halted`, which is the other
                // trigger and says more for itself than this would.
                CoreStatus::Halted
                | CoreStatus::Running
                | CoreStatus::Pausing
                | CoreStatus::Paused
                | CoreStatus::Resuming
                | CoreStatus::Stopping(_)
                | CoreStatus::Quitting => false,
            }
    }

    /// The live status line, which is the first thing in the menu.
    pub fn status_line(&self) -> String {
        if self.action_is_setup() {
            return "Not set up yet. The first-run window has the five steps.".into();
        }
        // Before the status, because the ladder's answer outlives the spawn it is
        // about: while the next attempt is in flight the status is `Starting` and
        // its head is "Waking the engine", which under a red badge would be the
        // menu contradicting the icon on the one state a person has to believe.
        if self.will_not_come_up() {
            return CRASH_LOOP_LINE.into();
        }
        let head = match self.status {
            CoreStatus::Cold => "Starting up".to_string(),
            CoreStatus::Starting => "Waking the engine".to_string(),
            CoreStatus::Pausing => return "Pausing, finishing what is in flight".into(),
            CoreStatus::Resuming => return "Starting again".into(),
            CoreStatus::Stopping(StopIntent::Quit) | CoreStatus::Quitting => {
                return "Finishing up, then closing".into()
            }
            CoreStatus::Stopping(StopIntent::Detach) => {
                return "Leaving. It finishes on its own.".into()
            }
            // Nothing about closing: the shell is staying and another run is
            // about to take this one's place.
            CoreStatus::Stopping(StopIntent::Restart) => {
                return "Finishing what is in flight, then starting again".into()
            }
            // The M2 copy said "Nothing is being watched", which was true of a
            // pause that killed the engine and is a lie about this one. The
            // core is alive, the folders are still watched, and what is held is
            // the sending.
            CoreStatus::Paused => return "Paused. New photos are noticed and held.".into(),
            CoreStatus::Halted => return self.halted_line(),
            CoreStatus::Backoff => {
                return "The engine stopped. Starting it again shortly.".into()
            }
            CoreStatus::Running => {
                if self.scanning {
                    "Checking your folders".to_string()
                } else if self.busy {
                    "Delivering".to_string()
                } else {
                    watching_line(&self.watch_dirs)
                }
            }
        };

        let mut parts = vec![head];
        if self.delivered > 0 {
            parts.push(format!("{} delivered", self.delivered));
        }
        if self.skipped > 0 {
            parts.push(format!("{} already there", self.skipped));
        }
        if self.failed > 0 {
            parts.push(format!("{} failed", self.failed));
        }
        if self.dry_run {
            parts.push("dry run, nothing is sent".into());
        }
        parts.join(" \u{b7} ")
    }

    fn halted_line(&self) -> String {
        match self.attention.as_ref() {
            Some(Attention::StartRefused(why)) => first_sentence(why),
            Some(Attention::LockLost { held_by: Some(pid) }) => {
                format!("Another copy took over. It is process {pid}.")
            }
            Some(Attention::LockLost { held_by: None }) => "Another copy took over.".into(),
            Some(Attention::SpawnFailed(why)) => format!("Could not start the engine. {why}"),
            Some(Attention::AuthNeeded(why)) => first_sentence(why),
            _ => "Stopped. Use Try again when you have looked at it.".into(),
        }
    }

    /// The storage law at a glance, second line of the menu.
    pub fn storage_line(&self) -> String {
        if self.bytes == 0 {
            "Nothing sent yet, original quality when it goes".into()
        } else {
            format!("{} sent, original quality", format_bytes(self.bytes))
        }
    }

    /// State, then the last delivery, then the storage law, inside the 127
    /// unit budget Windows gives a tray tooltip.
    ///
    /// The storage line is never what gets dropped. If the budget is tight the
    /// last delivery goes first, because the law is a promise and the file
    /// name is a nicety.
    pub fn tooltip(&self) -> String {
        let head = format!("{DISPLAY_NAME}: {}", self.tooltip_head());
        let detail = self.tooltip_detail();

        let without_detail = format!("{head}\n{STORAGE_HONESTY_SHORT}");
        if utf16_len(&without_detail) > TOOLTIP_MAX_UTF16 {
            // Only a very long head can get here. Cut the head, keep the law.
            let room = TOOLTIP_MAX_UTF16.saturating_sub(utf16_len(STORAGE_HONESTY_SHORT) + 1);
            return format!("{}\n{STORAGE_HONESTY_SHORT}", truncate_utf16(&head, room));
        }

        let Some(detail) = detail else {
            return without_detail;
        };

        // Whatever is left after the head, the law and two newlines. A detail
        // is cut down rather than thrown away, because half a sentence about
        // what went wrong beats no sentence at all.
        let room = TOOLTIP_MAX_UTF16.saturating_sub(utf16_len(&without_detail) + 1);
        if room < MIN_DETAIL_UTF16 {
            return without_detail;
        }
        format!(
            "{head}\n{}\n{STORAGE_HONESTY_SHORT}",
            ellipsise(&detail, room)
        )
    }

    fn tooltip_head(&self) -> String {
        // One word for one badge. "stopped, will retry" is honest about a wobble
        // and wrong about a ladder that has stopped getting in, and the red state
        // asks the same thing of a person however it was reached.
        if self.will_not_come_up() {
            return "needs you".into();
        }
        match self.status {
            CoreStatus::Cold => "starting up".into(),
            CoreStatus::Starting => "waking the engine".into(),
            CoreStatus::Pausing => "pausing".into(),
            CoreStatus::Resuming => "starting again".into(),
            CoreStatus::Stopping(StopIntent::Quit) | CoreStatus::Quitting => "closing".into(),
            CoreStatus::Stopping(StopIntent::Detach) => "leaving it to finish".into(),
            CoreStatus::Stopping(StopIntent::Restart) => "starting again".into(),
            CoreStatus::Paused => "paused".into(),
            CoreStatus::Backoff => "stopped, will retry".into(),
            CoreStatus::Halted => "needs you".into(),
            CoreStatus::Running => {
                if self.attention.is_some() {
                    "needs you".into()
                } else if self.scanning {
                    "checking your folders".into()
                } else if self.busy {
                    "delivering".into()
                } else {
                    "watching".into()
                }
            }
        }
    }

    /// The middle line: whatever is most worth one sentence right now.
    fn tooltip_detail(&self) -> Option<String> {
        if let Some(attention) = &self.attention {
            return Some(match attention {
                // The core's own sentence, never a guess at which refusal it
                // was. The lock is the common cause and it is not the only
                // one, and a tooltip that names the wrong cause is worse than
                // one that names none.
                Attention::StartRefused(why) => first_sentence(why),
                Attention::LockLost { held_by: Some(pid) } => {
                    format!("Another copy took over, process {pid}.")
                }
                Attention::LockLost { held_by: None } => "Another copy took over.".into(),
                Attention::AuthNeeded(_) => "Sign in to Google again.".into(),
                Attention::QuotaPaused { resumes_at, .. } => match resumes_at {
                    Some(when) => format!("Google limit reached, back {}.", short_time(when)),
                    None => "Google limit reached. Nothing is lost.".into(),
                },
                Attention::Crashed { .. } => "The engine stopped on its own.".into(),
                Attention::SpawnFailed(_) => "The engine could not be started.".into(),
                Attention::StopUnconfirmed => "Still finishing. It has not confirmed yet.".into(),
                Attention::Unanswered(word) => {
                    format!("The engine did not answer {word}.")
                }
                Attention::Failures(1) => "1 file did not go.".into(),
                Attention::Failures(n) => format!("{n} files did not go."),
            });
        }
        self.last_delivery
            .as_ref()
            .map(|name| format!("Last: {name}"))
    }

    /// Label and enabled state for the one item that is Pause, Resume, or a
    /// retry depending on where the core is. One item, because three items
    /// that are usually disabled is worse than one that says what it does.
    pub fn action_item(&self) -> (String, bool) {
        // Before anything else, because a machine with no config has nothing to
        // start and "Start watching" would be a button that fails. M4: the one
        // action a fresh install has is the one that makes it an install.
        if self.action_is_setup() {
            return ("Set up Photo Pigeon".into(), true);
        }
        match self.status {
            CoreStatus::Cold => ("Start watching".into(), true),
            CoreStatus::Starting | CoreStatus::Running => ("Pause".into(), true),
            CoreStatus::Pausing => ("Pausing, finishing what is in flight".into(), false),
            CoreStatus::Resuming => ("Starting again".into(), false),
            CoreStatus::Stopping(_) | CoreStatus::Quitting => ("Pause".into(), false),
            CoreStatus::Paused => ("Resume".into(), true),
            CoreStatus::Backoff => ("Start again now".into(), true),
            CoreStatus::Halted => ("Try again".into(), true),
        }
    }

    /// The status window's one engine button: label, word and enabled state.
    ///
    /// The labels are [`AppState::action_item`]'s own, arm for arm, wherever the
    /// two surfaces are talking about the same thing, and the parity is pinned
    /// by a test rather than left to whoever edits one of them next. Where the
    /// menu offers a start, a retry or a first run, this offers a disabled Pause:
    /// see [`EngineControl`] for why a window's control does not become a
    /// different button when the engine is absent.
    pub fn engine_control(&self) -> EngineControl {
        let (label, word) = match self.status {
            // Before the match on status, because a machine with no config has
            // no engine to pause and the menu's item is Set up Photo Pigeon,
            // which this button is not and must not become.
            _ if self.action_is_setup() => ("Pause", None),
            CoreStatus::Starting | CoreStatus::Running => ("Pause", Some("pause")),
            CoreStatus::Pausing => ("Pausing, finishing what is in flight", None),
            CoreStatus::Paused => ("Resume", Some("resume")),
            CoreStatus::Resuming => ("Starting again", None),
            // Nothing to pause, or nothing that would survive being paused. The
            // engine's own doors are elsewhere: Start watching and Try again are
            // menu items, and a run on its way out is not asked to hold a queue.
            CoreStatus::Cold
            | CoreStatus::Backoff
            | CoreStatus::Halted
            | CoreStatus::Stopping(_)
            | CoreStatus::Quitting => ("Pause", None),
        };
        EngineControl {
            label: label.to_string(),
            word,
            enabled: word.is_some(),
        }
    }

    /// Is "Deliver now" worth offering?
    ///
    /// Only against a running core. It writes `rescan`, which is one
    /// reconciliation pass, and a pass asked of a paused engine would fill a
    /// queue that is being held. TRAY-DESIGN law 2: this is a gesture and never
    /// a timer, so the only thing it needs is somebody to press it.
    pub fn deliver_now_enabled(&self) -> bool {
        matches!(self.status, CoreStatus::Running)
    }

    /// Quit says what it is about to do, because it drains first.
    ///
    /// **The second line is the sentence this milestone bought.** At M2 it said
    /// "leave without waiting", and that was the honest thing to say then: the
    /// shell holds the only write handle on the child's stdin, so walking out
    /// was an end of file, and an end of file reaching a core that was already
    /// stopping was a *second* stop, which the core answers with
    /// `queue.leaveNow()` and exit 130. The labels that promised a continuation
    /// were retired for lying about it.
    ///
    /// M3 adds the word rather than the wording. `detach` says "finish without
    /// me", and after it the core ignores the end of file that follows. So the
    /// promise can be made again, and this time the process keeps it.
    pub fn quit_item(&self) -> String {
        match self.status {
            CoreStatus::Stopping(StopIntent::Quit) | CoreStatus::Quitting => {
                "Leave, it finishes on its own".into()
            }
            CoreStatus::Stopping(StopIntent::Detach) => "Leaving, it finishes on its own".into(),
            _ => format!("Quit {DISPLAY_NAME}"),
        }
    }

    /// The folder "Open watched folder" opens: the first watch dir the core
    /// told us about. Never read from disk by the shell.
    pub fn first_watch_dir(&self) -> Option<&str> {
        self.watch_dirs.first().map(|d| d.as_str())
    }
}

/// "Watching 1 folder", the head of the status line when nothing is happening.
fn watching_line(dirs: &[String]) -> String {
    match dirs.len() {
        0 => "Watching".into(),
        1 => "Watching 1 folder".into(),
        n => format!("Watching {n} folders"),
    }
}

/// The file name out of a path, handling both separators because the event
/// carries whatever the core's platform writes.
pub fn file_name_of(path: &str) -> String {
    let cut = path.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
    let name = &path[cut..];
    if name.is_empty() {
        path.to_string()
    } else {
        name.to_string()
    }
}

/// Is this pause the day's Google budget rather than a person?
///
/// The two are different states in this shell: a quota pause is amber and
/// something to look at, a user pause is grey and something the user did on
/// purpose. A `paused` event with no reason at all is read as a user pause,
/// because a quota pause always has one to give.
/// One readable line for one event, for the status window's recent list.
///
/// Deliberately short and deliberately not a paraphrase of the union: the
/// window prints this and nothing else, so nothing about the core's shapes has
/// to cross into a page. Paths are cut to their file name, which is the same
/// rule the tooltip follows and the same reason: this is a list somebody
/// glances at, not a log. "Open log" is one click away for the whole truth.
pub fn describe(event: &CoreEvent) -> String {
    match event {
        CoreEvent::Started { watch_dirs, .. } => match watch_dirs.len() {
            1 => "started, watching 1 folder".to_string(),
            n => format!("started, watching {n} folders"),
        },
        CoreEvent::Scanning { dirs } => match dirs.len() {
            1 => "looking through 1 folder".to_string(),
            n => format!("looking through {n} folders"),
        },
        CoreEvent::Delivering { found, reason } => match reason.as_deref() {
            Some("rescan") => format!("delivering now, {found} to send"),
            Some("resumed") => format!("running again, {found} were waiting"),
            _ => format!("delivering, {found} to send"),
        },
        CoreEvent::Delivered {
            path, first_ever, ..
        } => {
            if *first_ever {
                format!("delivered {}, the first ever", file_name_of(path))
            } else {
                format!("delivered {}", file_name_of(path))
            }
        }
        CoreEvent::Skipped { path, .. } => {
            format!("{} was already delivered", file_name_of(path))
        }
        CoreEvent::Failed { path, error } => match path {
            Some(path) => format!("{} did not go: {}", file_name_of(path), first_sentence(error)),
            None => first_sentence(error),
        },
        CoreEvent::Paused { reason, .. } => {
            if is_quota(reason.as_deref()) {
                "held: today's Google limit is reached".to_string()
            } else {
                "paused, new photos are noticed and held".to_string()
            }
        }
        CoreEvent::Resumed { reason } => {
            if is_quota(reason.as_deref()) {
                "today's Google limit is back".to_string()
            } else {
                "resumed".to_string()
            }
        }
        CoreEvent::Detached => "let go, finishing on its own".to_string(),
        CoreEvent::AuthNeeded { reason } => format!("sign in needed: {}", first_sentence(reason)),
        CoreEvent::LockLost { held_by, .. } => match held_by {
            Some(pid) => format!("another copy took over, process {pid}"),
            None => "the lock on this folder set is no longer ours".to_string(),
        },
        CoreEvent::Stopping { reason } => format!("stopping, {reason}"),
        CoreEvent::Stopped { exit_code, .. } => format!("stopped, code {exit_code}"),
        CoreEvent::Unknown => "something this build does not know".to_string(),
    }
}

fn is_quota(reason: Option<&str>) -> bool {
    reason
        .map(|r| r.to_ascii_lowercase().contains("quota"))
        .unwrap_or(false)
}

/// The core's error strings can be a paragraph. A menu line takes one sentence.
pub fn first_sentence(text: &str) -> String {
    let trimmed = text.trim();
    let end = trimmed
        .find(". ")
        .map(|i| i + 1)
        .unwrap_or_else(|| trimmed.len());
    let mut out = trimmed[..end].trim().to_string();
    if out.len() > 120 {
        out = truncate_chars(&out, 117);
        out.push_str("...");
    }
    out
}

/// "2026-07-29T00:00:00.000Z" is not a sentence. "at 00:00" is.
pub fn short_time(iso: &str) -> String {
    match (iso.find('T'), iso.len() >= 16) {
        (Some(t), true) if iso.len() >= t + 6 => format!("at {}", &iso[t + 1..t + 6]),
        _ => "later".into(),
    }
}

/// Matches `formatBytes` in `src/commands/format.ts`, so the tray and the CLI
/// never quote a different number for the same bytes.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if bytes == 0 {
        return "0 B".into();
    }
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let digits = if unit == 0 || value >= 100.0 { 0 } else { 1 };
    format!("{value:.digits$} {}", UNITS[unit], digits = digits)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn truncate_utf16(text: &str, max: usize) -> String {
    if utf16_len(text) <= max {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if used + width > max {
            break;
        }
        out.push(ch);
        used += width;
    }
    out
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Cut to fit, and say that it was cut.
fn ellipsise(text: &str, max_utf16: usize) -> String {
    if utf16_len(text) <= max_utf16 {
        return text.to_string();
    }
    let mut out = truncate_utf16(text, max_utf16.saturating_sub(3));
    out.push_str("...");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_with_no_config_offers_setup_rather_than_start_watching() {
        // The M4 exit criterion's first sentence, at the one place a person
        // meets it: "Start watching" on a machine with nothing to watch is a
        // button that fails, and the failure looks like the app being broken
        // rather than being new.
        let mut state = AppState::new();
        assert_eq!(state.action_item().0, "Start watching");
        assert!(!state.action_is_setup());

        state.set_needs_setup(true);
        assert!(state.action_is_setup());
        let (label, enabled) = state.action_item();
        assert_eq!(label, "Set up Photo Pigeon");
        assert!(enabled);
        assert!(state.status_line().starts_with("Not set up yet"));
        assert!(!state.status_line().contains('\u{2014}'), "em dash");
    }

    #[test]
    fn a_core_that_started_takes_the_label_back() {
        // A config can appear after boot, either because the wizard wrote one
        // or because somebody dropped a file in. Once a core is up, "Set up
        // Photo Pigeon" is a stale sentence outranking a true one, and the true
        // one is Pause.
        let mut state = AppState::new();
        state.set_needs_setup(true);
        state.on_spawn();
        assert!(!state.action_is_setup());
        assert_eq!(state.action_item().0, "Pause");
    }

    fn started() -> CoreEvent {
        CoreEvent::Started {
            pid: Some(4242),
            version: Some("0.1.0".into()),
            watch_dirs: vec!["D:\\Photos".into()],
            album: Some("Camera".into()),
            dry_run: false,
            once: false,
            ledger_path: Some("C:\\tmp\\pigeon\\ledger.jsonl".into()),
            lock_path: Some("C:\\tmp\\pigeon\\watch.lock".into()),
            log_path: Some("C:\\tmp\\pigeon\\watch.log".into()),
        }
    }

    /// An ordinary delivery: not the first one this ledger ever took.
    fn delivered(path: &str, bytes: u64) -> CoreEvent {
        CoreEvent::Delivered {
            path: path.into(),
            bytes,
            media_item_id: Some("AF1Qip".into()),
            first_ever: false,
        }
    }

    /// The one delivery in the life of a ledger that found it empty.
    fn first_delivery(path: &str, bytes: u64) -> CoreEvent {
        CoreEvent::Delivered {
            path: path.into(),
            bytes,
            media_item_id: Some("AF1Qip".into()),
            first_ever: true,
        }
    }

    fn running() -> AppState {
        let mut state = AppState::new();
        state.on_spawn();
        state.apply(&started());
        state
    }

    /// The supervisor's timer wiring, in miniature.
    ///
    /// It exists because the test that was meant to guard the delivering icon
    /// called [`AppState::quiet_expired`] by hand. Production never does: that
    /// callback runs only when an event asked for it with [`Effect::BumpQuiet`],
    /// and `supervisor::fire_timers` is the only caller. A test that fires an
    /// unarmed timer proves the state machine can be got out of a state, not
    /// that anything will get it out, and the difference was a delivering icon
    /// that stuck forever on every healthy install.
    ///
    /// So this rig fires the quiet window only when an event really armed it.
    struct Rig {
        state: AppState,
        quiet_armed: bool,
        /// Every toast the state machine asked for, in order. The supervisor
        /// shows them; here they are just recorded, which is what makes "never
        /// per file" checkable without a Windows session.
        toasts: Vec<Toast>,
    }

    impl Rig {
        fn running() -> Self {
            let mut rig = Self {
                state: AppState::new(),
                quiet_armed: false,
                toasts: Vec::new(),
            };
            rig.state.on_spawn();
            rig.feed(&started());
            rig
        }

        fn feed(&mut self, event: &CoreEvent) {
            for effect in self.state.apply(event) {
                match effect {
                    Effect::BumpQuiet => self.quiet_armed = true,
                    Effect::Toast(toast) => self.toasts.push(toast),
                }
            }
        }

        /// Two seconds of nothing. Does nothing at all when nothing armed it,
        /// which is the whole point.
        fn quiet_window_passes(&mut self) {
            if self.quiet_armed {
                self.quiet_armed = false;
                self.state.quiet_expired();
            }
        }
    }

    /// One of every event, for the sweeps that have to cover the union rather
    /// than the three shapes somebody remembered.
    fn every_event() -> Vec<CoreEvent> {
        vec![
            started(),
            CoreEvent::Scanning {
                dirs: vec!["D:\\Photos".into()],
            },
            CoreEvent::Delivering {
                found: 0,
                reason: Some("scan".into()),
            },
            CoreEvent::Delivering {
                found: 12,
                reason: Some("scan".into()),
            },
            delivered("D:\\Photos\\IMG_0421.jpg", 4096),
            CoreEvent::Skipped {
                path: "D:\\Photos\\IMG_0420.jpg".into(),
                reason: Some("already-delivered".into()),
            },
            CoreEvent::Failed {
                path: Some("D:\\Photos\\clip.mov".into()),
                error: "over the Google limit of 20 GB".into(),
            },
            CoreEvent::Failed {
                path: None,
                error: "another copy is already watching.".into(),
            },
            CoreEvent::AuthNeeded {
                reason: "invalid_grant".into(),
            },
            // The one delivery in a ledger's life that is news, kept in the
            // union walk so the closed list of toast-raising events is checked
            // over both kinds of delivery rather than over one.
            first_delivery("D:\\Photos\\IMG_0001.jpg", 4096),
            CoreEvent::Paused {
                reason: Some("user".into()),
                resumes_at: None,
            },
            CoreEvent::Paused {
                reason: Some("quota".into()),
                resumes_at: Some("2026-07-29T00:00:00.000Z".into()),
            },
            CoreEvent::Resumed {
                reason: Some("user".into()),
            },
            CoreEvent::Detached,
            CoreEvent::LockLost {
                reason: "stolen".into(),
                held_by: Some(71608),
                stopping: true,
            },
            CoreEvent::Stopping {
                reason: "stdin".into(),
            },
            CoreEvent::Stopped {
                exit_code: 0,
                totals: None,
            },
            CoreEvent::Unknown,
        ]
    }

    #[test]
    fn a_fresh_shell_is_idle_and_says_nothing_it_does_not_know() {
        let state = AppState::new();
        assert_eq!(state.icon(), IconState::Idle);
        assert_eq!(state.first_watch_dir(), None);
        assert!(state.storage_line().starts_with("Nothing sent yet"));
    }

    #[test]
    fn started_populates_the_menu_and_leaves_the_icon_idle() {
        let state = running();
        assert_eq!(state.status, CoreStatus::Running);
        assert_eq!(state.icon(), IconState::Idle);
        assert_eq!(state.first_watch_dir(), Some("D:\\Photos"));
        assert_eq!(state.core_log_path.as_deref(), Some("C:\\tmp\\pigeon\\watch.log"));
        assert_eq!(state.core_pid, Some(4242));
        assert_eq!(state.status_line(), "Watching 1 folder");
    }

    #[test]
    fn scanning_shows_work_and_delivering_always_clears_it() {
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Scanning {
            dirs: vec!["D:\\Photos".into()],
        });
        assert_eq!(rig.state.icon(), IconState::Delivering);
        assert_eq!(rig.state.status_line(), "Checking your folders");

        // The core emits `delivering` after every scan, including an empty one.
        rig.feed(&CoreEvent::Delivering {
            found: 0,
            reason: Some("scan".into()),
        });
        rig.quiet_window_passes();
        assert_eq!(rig.state.icon(), IconState::Idle);
    }

    #[test]
    fn a_scan_that_finds_nothing_settles_back_to_watching_by_itself() {
        // The commonest state this tool is ever in, and the one that was
        // broken: started, one reconcile pass, nothing new to send. The core
        // emits `delivering` with `found: 0` after every scan whether it found
        // anything or not, so this is what a healthy install looks like for the
        // whole rest of the day. Nothing here is nudged by hand: the only timer
        // that fires is the one the scan itself asked for.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Scanning {
            dirs: vec!["D:\\Photos".into()],
        });
        rig.feed(&CoreEvent::Delivering {
            found: 0,
            reason: Some("scan".into()),
        });
        rig.quiet_window_passes();

        assert_eq!(rig.state.icon(), IconState::Idle);
        assert_eq!(rig.state.status_line(), "Watching 1 folder");
        assert_eq!(rig.state.tooltip_head(), "watching");
        assert!(rig.state.tooltip().contains("Photo Pigeon: watching"));
    }

    #[test]
    fn a_long_scan_keeps_the_icon_lit_until_delivering_ends_it() {
        // The other half of the same rule. A reconcile over a large library
        // outruns the quiet window many times over, and the icon may not blink
        // out halfway: `scanning` is cleared by an event, never by the clock.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Scanning {
            dirs: vec!["D:\\Photos".into()],
        });
        for _ in 0..5 {
            rig.quiet_window_passes();
            assert_eq!(rig.state.icon(), IconState::Delivering);
            assert_eq!(rig.state.status_line(), "Checking your folders");
        }
        rig.feed(&CoreEvent::Delivering {
            found: 0,
            reason: Some("scan".into()),
        });
        rig.quiet_window_passes();
        assert_eq!(rig.state.icon(), IconState::Idle);
    }

    #[test]
    fn nothing_lights_the_icon_without_arming_what_puts_it_out() {
        // The structural form of the bug, over the whole union rather than the
        // three shapes somebody remembered. Every icon state must have a
        // clearing condition (TRAY-DESIGN section 3), and for delivering that
        // condition is one effect. An event that sets the icon and returns no
        // effect can never be cleared by anything, so it fails here rather than
        // in a tray a person is watching.
        for event in every_event() {
            let mut rig = Rig::running();
            rig.feed(&event);
            if rig.state.icon() != IconState::Delivering {
                continue;
            }
            assert!(
                rig.quiet_armed,
                "{event:?} lit the delivering icon and armed nothing to clear it"
            );

            rig.quiet_window_passes();
            if matches!(event, CoreEvent::Scanning { .. }) {
                // The one state cleared by an event instead of the clock, and
                // the core always sends that event.
                rig.feed(&CoreEvent::Delivering {
                    found: 0,
                    reason: Some("scan".into()),
                });
                rig.quiet_window_passes();
            }
            assert_ne!(
                rig.state.icon(),
                IconState::Delivering,
                "{event:?} stayed lit after everything that clears it had happened"
            );
        }
    }

    #[test]
    fn a_delivery_lights_the_icon_and_the_quiet_window_puts_it_out() {
        let mut state = running();
        // An ordinary delivery, so it asks for the quiet window and nothing
        // else. The happy toast has its own tests.
        let effects = state.apply(&delivered("D:\\Photos\\IMG_0421.jpg", 4 * 1024 * 1024));
        assert_eq!(effects, vec![Effect::BumpQuiet]);
        assert_eq!(state.icon(), IconState::Delivering);
        assert_eq!(state.delivered, 1);
        assert_eq!(state.last_delivery.as_deref(), Some("IMG_0421.jpg"));
        assert_eq!(state.storage_line(), "4.0 MB sent, original quality");

        state.quiet_expired();
        assert_eq!(state.icon(), IconState::Idle);
        assert_eq!(state.status_line(), "Watching 1 folder \u{b7} 1 delivered");
    }

    #[test]
    fn counts_come_from_delivered_skipped_and_failed() {
        let mut state = running();
        state.apply(&delivered("a.jpg", 1000));
        state.apply(&delivered("b.jpg", 2000));
        state.apply(&CoreEvent::Skipped {
            path: "c.jpg".into(),
            reason: Some("already-delivered".into()),
        });
        state.apply(&CoreEvent::Failed {
            path: Some("d.mov".into()),
            error: "over the Google limit of 20 GB".into(),
        });
        state.quiet_expired();
        assert_eq!(
            state.status_line(),
            "Watching 1 folder \u{b7} 2 delivered \u{b7} 1 already there \u{b7} 1 failed"
        );
    }

    #[test]
    fn a_per_file_failure_is_attention_and_the_menu_clears_it() {
        let mut state = running();
        state.apply(&CoreEvent::Failed {
            path: Some("d.mov".into()),
            error: "too big".into(),
        });
        assert_eq!(state.icon(), IconState::Attention);
        state.on_menu_opened();
        state.quiet_expired();
        assert_eq!(state.icon(), IconState::Idle);
        // The lifetime count survives the clear: it is a fact, not a flavour.
        assert_eq!(state.failed, 1);
    }

    #[test]
    fn auth_needed_does_not_clear_by_looking_at_it() {
        let mut state = running();
        state.apply(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        state.on_menu_opened();
        assert_eq!(state.icon(), IconState::Attention);
        assert!(state.tooltip().contains("Sign in to Google again."));
    }

    #[test]
    fn a_run_that_asked_for_a_sign_in_is_never_respawned() {
        // Reproduced against the real core on 28 July 2026 with a temp config
        // and no client file: started, auth-needed, failed, stopped, exit 1,
        // and the shell knocked again every two seconds. A sign in cannot be
        // done from a tray menu, so retrying is noise with a cost.
        let mut state = running();
        state.apply(&CoreEvent::AuthNeeded {
            reason: "No OAuth client file at C:\\tmp\\pigeon\\credentials.json.\n\nRun setup."
                .into(),
        });
        state.apply(&CoreEvent::Failed {
            path: None,
            error: "No OAuth client file".into(),
        });
        state.apply(&CoreEvent::Stopped {
            exit_code: 1,
            totals: None,
        });
        assert_eq!(state.on_child_exit(Some(1)), ExitVerdict::NeedsUser);
        assert_eq!(state.status, CoreStatus::Halted);
        // Red under the severity split, and this is the case it
        // was decided for: a sign in cannot be given from a tray, so nothing at all
        // is delivered until the person does something.
        assert_eq!(state.icon(), IconState::Broken);
        // The complaint that survives is the useful one, not "it crashed".
        assert!(matches!(state.attention(), Some(Attention::AuthNeeded(_))));
        assert!(state.status_line().starts_with("No OAuth client file"));
        assert_eq!(state.action_item().0, "Try again");
    }

    #[test]
    fn a_fresh_spawn_forgets_that_the_last_run_wanted_a_sign_in() {
        let mut state = running();
        state.apply(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        state.on_child_exit(Some(1));
        state.on_spawn();
        state.apply(&started());
        assert_eq!(state.on_child_exit(Some(1)), ExitVerdict::Unexpected);
    }

    #[test]
    fn quota_pause_is_attention_with_its_own_line_and_lifts_on_the_next_delivering() {
        let mut state = running();
        state.apply(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-29T00:00:00.000Z".into()),
        });
        assert_eq!(state.icon(), IconState::Attention);
        assert!(state.tooltip().contains("Google limit reached, back at 00:00."));

        // There is no `resumed` event. A second `delivering` is the signal.
        state.apply(&CoreEvent::Delivering {
            found: 3,
            reason: Some("resumed".into()),
        });
        assert_eq!(state.icon(), IconState::Delivering);
        assert!(state.attention().is_none());
    }

    #[test]
    fn a_quota_pause_never_wears_the_grey_paused_icon() {
        // The grey icon means a person pressed Pause. That is the whole point
        // of the correction the M2 brief made to section 3's table.
        let mut state = running();
        state.apply(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: None,
        });
        assert_ne!(state.icon(), IconState::Paused);
        assert_eq!(state.icon(), IconState::Attention);
    }

    #[test]
    fn lock_lost_while_stopping_halts_without_a_respawn() {
        let mut state = running();
        state.apply(&CoreEvent::LockLost {
            reason: "stolen".into(),
            held_by: Some(71608),
            stopping: true,
        });
        state.apply(&CoreEvent::Stopping {
            reason: "lock-lost".into(),
        });
        state.apply(&CoreEvent::Stopped {
            exit_code: 0,
            totals: None,
        });
        assert_eq!(state.on_child_exit(Some(0)), ExitVerdict::StoodDown);
        assert_eq!(state.status, CoreStatus::Halted);
        // There is nothing to restart into, so nothing delivers from this copy
        // until a person decides what they want. Red.
        assert_eq!(state.icon(), IconState::Broken);
        assert!(state.status_line().contains("71608"));
        assert_eq!(state.action_item().0, "Try again");
    }

    #[test]
    fn lock_lost_that_is_not_stopping_is_a_state_to_show_not_a_reason_to_stop() {
        let mut state = running();
        state.apply(&CoreEvent::LockLost {
            reason: "unverifiable".into(),
            held_by: None,
            stopping: false,
        });
        assert_eq!(state.status, CoreStatus::Running);
        assert_eq!(state.icon(), IconState::Attention);
        assert_eq!(state.on_child_exit(Some(1)), ExitVerdict::Unexpected);
    }

    #[test]
    fn a_refused_start_is_not_respawned() {
        // The double start path: `failed` with no path, then `stopped`, and
        // nothing else. `started` never arrives.
        let mut state = AppState::new();
        state.on_spawn();
        state.apply(&CoreEvent::Failed {
            path: None,
            error: "another copy is already watching. Process 71608 started at 09:12.".into(),
        });
        state.apply(&CoreEvent::Stopped {
            exit_code: 1,
            totals: None,
        });
        assert_eq!(state.on_child_exit(Some(1)), ExitVerdict::Refused);
        assert_eq!(state.status, CoreStatus::Halted);
        assert_eq!(state.status_line(), "another copy is already watching.");
        // The core's own sentence, not the shell guessing which refusal it was.
        assert!(state.tooltip().contains("another copy is already watching."));
    }

    #[test]
    fn a_refusal_that_is_not_the_lock_is_not_described_as_the_lock() {
        let mut state = AppState::new();
        state.on_spawn();
        state.apply(&CoreEvent::Failed {
            path: None,
            error: "the config names a folder that is not there: D:\\Gone".into(),
        });
        state.on_child_exit(Some(1));
        let tip = state.tooltip();
        assert!(!tip.contains("Another copy"), "{tip:?}");
        assert!(tip.contains("folder that is not there") || tip.contains("the config names"));
    }

    #[test]
    fn a_run_level_failure_after_a_good_start_is_still_a_crash_to_retry() {
        let mut state = running();
        state.apply(&CoreEvent::Failed {
            path: None,
            error: "the watcher fell over".into(),
        });
        assert_eq!(state.on_child_exit(Some(1)), ExitVerdict::Unexpected);
        assert_eq!(state.status, CoreStatus::Backoff);
        assert_eq!(state.action_item().0, "Start again now");
    }

    #[test]
    fn a_halt_no_respawn_can_fix_does_not_wear_the_icon_a_wobble_wears() {
        // The severity split, reduced to the one assertion that
        // fails against four states. Both of these are the engine not delivering
        // and they ask a person for opposite things: the first is a sign in only
        // they can give, and the second is a respawn already on a timer. One
        // colour for both means the amber dot cannot be believed either way.
        let mut halted = running();
        halted.apply(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        halted.on_child_exit(Some(1));
        assert_eq!(halted.status, CoreStatus::Halted);

        let mut wobbled = running();
        wobbled.on_child_exit(Some(1));
        assert_eq!(wobbled.status, CoreStatus::Backoff);

        assert_ne!(
            halted.icon(),
            wobbled.icon(),
            "a stop only a person can clear and a crash the shell is retrying \
             are wearing one badge"
        );
        assert_eq!(halted.icon(), IconState::Broken);
        assert_eq!(wobbled.icon(), IconState::Attention);
    }

    #[test]
    fn a_crash_loop_at_the_top_of_the_ladder_goes_red_and_one_crash_does_not() {
        // The red badge's second trigger, and the whole of the severity split in
        // one test. A crash with a respawn on a two second timer really may come
        // back by itself, so it is amber. The same crash at the top of the ladder
        // is a tool knocking every five minutes and never getting in, and calling
        // that "will retry" is a promise nobody is keeping.
        let mut state = running();
        state.on_child_exit(Some(1));
        assert_eq!(state.status, CoreStatus::Backoff);
        assert_eq!(state.icon(), IconState::Attention);
        assert!(state.status_line().contains("shortly"));

        state.note_giving_ground();
        assert_eq!(state.icon(), IconState::Broken);
        assert!(!state.status_line().contains("shortly"));

        // The badge survives the next attempt, which is the point of the flag
        // outliving the spawn: an idle pigeon for the second before the next death
        // is a cheerful lie, and it would repeat every five minutes.
        state.on_spawn();
        assert_eq!(state.status, CoreStatus::Starting);
        assert_eq!(
            state.icon(),
            IconState::Broken,
            "a spawn is not evidence that a core will run"
        );

        // And `started` is, so it is the one thing that takes the badge off.
        state.apply(&started());
        assert_eq!(state.icon(), IconState::Idle);
        assert_eq!(state.status_line(), "Watching 1 folder");
    }

    #[test]
    fn the_icon_precedence_runs_broken_paused_attention_delivering_idle() {
        // The order the enum's doc states, walked pair by pair over states where
        // both halves are really true at once. Broken over paused is the one pair
        // that is not reachable, and the doc says why rather than this test
        // pretending to reach it: both halves of broken are read off a status that
        // holds one value at a time, and a core that has answered `pause` is a
        // core that is up.

        // Broken over attention. A halt always has a complaint in the slot beside
        // it, and the badge is about the halt.
        let mut halted = running();
        halted.apply(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        halted.on_child_exit(Some(1));
        assert!(halted.attention().is_some());
        assert_eq!(halted.icon(), IconState::Broken);

        // Broken over delivering. The ladder is out of patience and the attempt
        // in flight is already talking about a scan, which would otherwise light
        // the busy icon over an engine that has never got up.
        let mut knocking = Rig::running();
        knocking.state.on_child_exit(Some(1));
        knocking.state.note_giving_ground();
        knocking.state.on_spawn();
        knocking.feed(&CoreEvent::Scanning {
            dirs: vec!["D:\\Photos".into()],
        });
        assert_eq!(knocking.state.icon(), IconState::Broken);

        // Paused over attention. The budget's hold underneath the person's own,
        // which is the state the M3 review's first critical was found in.
        let mut paused = Rig::running();
        paused.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: None,
        });
        paused.state.on_pause_requested();
        paused.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert!(matches!(
            paused.state.attention(),
            Some(Attention::QuotaPaused { .. })
        ));
        assert_eq!(paused.state.icon(), IconState::Paused);

        // Attention over delivering. One file failed in the middle of a batch.
        let mut failing = Rig::running();
        failing.feed(&delivered("a.jpg", 10));
        failing.feed(&CoreEvent::Failed {
            path: Some("b.mov".into()),
            error: "too big".into(),
        });
        assert_eq!(failing.state.icon(), IconState::Attention);

        // Delivering over idle, the pair with nothing to argue about.
        let mut busy = Rig::running();
        busy.feed(&delivered("a.jpg", 10));
        assert_eq!(busy.state.icon(), IconState::Delivering);
    }

    #[test]
    fn every_icon_state_has_a_trigger_and_a_clearing_condition() {
        // The law the enum's doc carries, and the reason a fifth state was allowed
        // in at all: the law was never the number. Five triggers, five ways out,
        // and every way out here is the one production really takes.
        let mut rig = Rig::running();
        // Idle is the resting state, which is what the other four clear to.
        assert_eq!(rig.state.icon(), IconState::Idle);

        // Delivering: work lights it and the window that same work armed puts it
        // out.
        rig.feed(&delivered("a.jpg", 10));
        assert_eq!(rig.state.icon(), IconState::Delivering);
        rig.quiet_window_passes();
        assert_eq!(rig.state.icon(), IconState::Idle);

        // Attention: a per file failure raises it, opening the menu clears it.
        rig.feed(&CoreEvent::Failed {
            path: Some("b.mov".into()),
            error: "too big".into(),
        });
        assert_eq!(rig.state.icon(), IconState::Attention);
        rig.state.on_menu_opened();
        rig.quiet_window_passes();
        assert_eq!(rig.state.icon(), IconState::Idle);

        // Paused: the core's own word, and only the resume that matches it.
        rig.state.on_pause_requested();
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert_eq!(rig.state.icon(), IconState::Paused);
        rig.state.on_resume_requested();
        rig.feed(&CoreEvent::Resumed {
            reason: Some("user".into()),
        });
        assert_ne!(rig.state.icon(), IconState::Paused);

        // Broken, first trigger: a halt no respawn can fix. Cleared by a run that
        // gets up, which is where "Try again" leads.
        let mut halted = Rig::running();
        halted.feed(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        halted.state.on_child_exit(Some(1));
        assert_eq!(halted.state.icon(), IconState::Broken);
        halted.state.on_spawn();
        halted.feed(&started());
        assert_eq!(halted.state.icon(), IconState::Idle);

        // Broken, second trigger: the ladder at its ceiling. Same clearing
        // condition, and for this half it is the only one there is, which is why
        // the spawn in the middle changes nothing.
        let mut looping = Rig::running();
        looping.state.on_child_exit(Some(1));
        looping.state.note_giving_ground();
        assert_eq!(looping.state.icon(), IconState::Broken);
        looping.state.on_spawn();
        assert_eq!(looping.state.icon(), IconState::Broken);
        looping.feed(&started());
        assert_eq!(looping.state.icon(), IconState::Idle);
    }

    #[test]
    fn the_red_state_says_the_same_thing_wherever_it_is_read() {
        // The copy law on the sentence the fifth state brought with it. It travels
        // the paths every other sentence travels, `status_line` for the menu row
        // and the status window and `tooltip` for the hover, so the three surfaces
        // cannot disagree about the one state a person is being asked to act on.
        let mut state = running();
        state.on_child_exit(Some(1));
        state.note_giving_ground();
        assert_eq!(state.icon(), IconState::Broken);

        let line = state.status_line();
        assert_eq!(line, CRASH_LOOP_LINE);
        assert!(
            !line.contains("shortly"),
            "the gap is five minutes and none of them got in: {line:?}"
        );
        assert!(!line.contains('\u{2014}'), "em dash in {line:?}");
        assert!(!line.contains("photo-pigeon"), "package name in {line:?}");
        assert!(line.ends_with('.'), "{line:?} is not a sentence");
        assert!(line.starts_with(|c: char| c.is_uppercase()), "{line:?}");

        assert_eq!(state.tooltip_head(), "needs you");
        let tip = state.tooltip();
        assert!(utf16_len(&tip) <= TOOLTIP_MAX_UTF16, "{tip:?}");
        assert!(tip.contains("needs you"), "{tip:?}");
        assert!(tip.contains(STORAGE_HONESTY_SHORT), "{tip:?}");

        // The status window's own line is the same news, off the same slot.
        assert!(matches!(state.attention(), Some(Attention::Crashed { .. })));

        // And the attempt still to come promises nothing while the badge is red.
        state.on_spawn();
        assert_eq!(state.status, CoreStatus::Starting);
        assert_eq!(state.status_line(), CRASH_LOOP_LINE);
        assert_eq!(state.tooltip_head(), "needs you");
    }

    #[test]
    fn an_unexpected_exit_backs_off_and_shows_attention() {
        let mut state = running();
        assert_eq!(state.on_child_exit(None), ExitVerdict::Unexpected);
        assert_eq!(state.status, CoreStatus::Backoff);
        assert_eq!(state.icon(), IconState::Attention);
    }

    // -- the M3 pause, which is a word and not a stop -----------------------

    #[test]
    fn pause_holds_the_queue_and_the_core_keeps_running() {
        // The headline change of this milestone. At M2 a pause was a stop and
        // a resume was a respawn, which meant a click cost a full re-hash of
        // the library. Nothing here ends the run.
        let mut rig = Rig::running();
        rig.feed(&delivered("a.jpg", 10));

        rig.state.on_pause_requested();
        assert_eq!(rig.state.status, CoreStatus::Pausing);
        assert_eq!(
            rig.state.action_item(),
            ("Pausing, finishing what is in flight".into(), false)
        );

        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert_eq!(rig.state.status, CoreStatus::Paused);
        assert_eq!(rig.state.icon(), IconState::Paused);
        assert_eq!(rig.state.action_item().0, "Resume");
        // The counters survive, and so does the fact that the folders are
        // still being watched. The M2 copy said "Nothing is being watched",
        // which was true of a pause that killed the engine and is a lie here.
        assert_eq!(rig.state.delivered, 1);
        assert!(rig.state.status_line().contains("held"));
        assert!(!rig.state.status_line().contains("Nothing is being watched"));
        assert!(rig.toasts.is_empty(), "a pause is not worth a toast");
    }

    #[test]
    fn the_dimmed_icon_waits_for_the_core_to_say_so() {
        // The click is not the evidence, the event is. Against a core that does
        // not know the word, an icon that dimmed on the click would be a grey
        // pigeon over a running upload, which is the exact disagreement between
        // a menu and a process that this milestone is trying to remove.
        let mut rig = Rig::running();
        rig.state.on_pause_requested();
        assert_ne!(rig.state.icon(), IconState::Paused);
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert_eq!(rig.state.icon(), IconState::Paused);
    }

    #[test]
    fn resume_is_a_word_and_never_a_respawn() {
        let mut rig = Rig::running();
        rig.state.on_pause_requested();
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });

        rig.state.on_resume_requested();
        assert_eq!(rig.state.status, CoreStatus::Resuming);
        assert_eq!(rig.state.action_item(), ("Starting again".into(), false));

        rig.feed(&CoreEvent::Resumed {
            reason: Some("user".into()),
        });
        assert_eq!(rig.state.status, CoreStatus::Running);
        assert_ne!(rig.state.icon(), IconState::Paused);
        // Nothing was spawned, so nothing reset. on_spawn is the only thing
        // that clears the per-run flags and it was never called.
        assert!(rig.state.saw_started);
    }

    #[test]
    fn work_flowing_again_resumes_even_if_the_word_never_comes_back() {
        // Belt and braces against a core that closes the pause by simply
        // getting on with it. The tray must not sit on "Starting again" while
        // photos are visibly going.
        let mut rig = Rig::running();
        rig.state.on_pause_requested();
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        rig.state.on_resume_requested();
        rig.feed(&CoreEvent::Delivering {
            found: 3,
            reason: Some("resumed".into()),
        });
        assert_eq!(rig.state.status, CoreStatus::Running);
    }

    #[test]
    fn a_pause_the_core_never_answers_goes_back_to_running_and_says_so() {
        // The one case this really happens in: a shell of this build against a
        // core that predates the M3 vocabulary. That core answers an unknown
        // word on stderr and carries on watching, so the menu must not sit on
        // "Pausing" over a running upload.
        let mut state = running();
        state.on_pause_requested();
        state.on_word_unanswered("pause");
        assert_eq!(state.status, CoreStatus::Running);
        assert_eq!(state.icon(), IconState::Attention);
        assert!(state.tooltip().contains("did not answer pause"));
        // And it is recoverable: the action item is Pause again, not a dead end.
        assert_eq!(state.action_item(), ("Pause".into(), true));
    }

    #[test]
    fn a_resume_the_core_never_answers_goes_back_to_paused() {
        let mut rig = Rig::running();
        rig.state.on_pause_requested();
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        rig.state.on_resume_requested();
        rig.state.on_word_unanswered("resume");
        assert_eq!(rig.state.status, CoreStatus::Paused);
        assert_eq!(rig.state.action_item().0, "Resume");
    }

    #[test]
    fn a_resume_the_budget_will_not_honour_still_takes_the_menu_off_paused() {
        // The M3 review's first critical, end to end, in the state the core's
        // own test constructs: held for both reasons, and the person changes
        // their mind. Their hold really lifts. Nothing moves, because nobody
        // un-spends a spent budget by clicking a menu, and the core says both
        // halves rather than answering on stderr and leaving the shell to read
        // silence. Before this, silence was read as "it does not know the word",
        // which set Paused and left it there: the engine was delivering at
        // midnight while the menu said "Paused. New photos are noticed and
        // held.", Deliver now was disabled, and the only way out was to quit and
        // start again.
        let mut rig = Rig::running();
        rig.state.on_pause_requested();
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });
        assert_eq!(rig.state.status, CoreStatus::Paused);

        rig.state.on_resume_requested();
        rig.feed(&CoreEvent::Resumed {
            reason: Some("user".into()),
        });

        assert_eq!(rig.state.status, CoreStatus::Running);
        assert_eq!(rig.state.action_item(), ("Pause".into(), true));
        // And the budget's hold is untouched by it: still amber, still saying
        // when it comes back, because this event is no evidence about the
        // budget.
        assert!(matches!(
            rig.state.attention(),
            Some(Attention::QuotaPaused { .. })
        ));
        assert_eq!(rig.state.icon(), IconState::Attention);
        assert!(rig.state.tooltip().contains("Google limit reached"));
    }

    #[test]
    fn midnight_lifts_the_amber_line_without_lifting_a_pause_a_person_asked_for() {
        // The mirror, and the other lift the core used to make silently. The
        // budget comes back under somebody's pause: the queue is still held, so
        // the icon stays grey and the menu still offers Resume, and the amber
        // sentence has to go because it has stopped being true.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });
        rig.state.on_pause_requested();
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert_eq!(rig.state.status, CoreStatus::Paused);

        rig.feed(&CoreEvent::Resumed {
            reason: Some("quota".into()),
        });

        assert!(rig.state.attention().is_none());
        assert_eq!(rig.state.status, CoreStatus::Paused);
        assert_eq!(rig.state.icon(), IconState::Paused);
        assert_eq!(rig.state.action_item(), ("Resume".into(), true));
    }

    #[test]
    fn deliver_now_is_no_evidence_that_the_days_budget_came_back() {
        // The M3 review's second critical. "Deliver now" writes `rescan`, and
        // the core answers every rescan with a `delivering` of its own before it
        // has even looked at whether it is paused. Clearing the amber state on
        // any `delivering` therefore made the click itself the clearing
        // condition: one press took the tray from "Google limit reached, back at
        // 00:00" to "watching" with every file still held, and nothing could put
        // it back, because a core does not re-announce a hold it is already on.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });

        rig.feed(&CoreEvent::Delivering {
            found: 2,
            reason: Some("rescan".into()),
        });

        assert!(matches!(
            rig.state.attention(),
            Some(Attention::QuotaPaused { .. })
        ));
        assert!(rig.state.tooltip().contains("Google limit reached"));

        // A scan is not evidence either, and it is the one that arrives by
        // itself on the next respawn.
        rig.feed(&CoreEvent::Delivering {
            found: 2,
            reason: Some("scan".into()),
        });
        assert!(matches!(
            rig.state.attention(),
            Some(Attention::QuotaPaused { .. })
        ));

        // The hold lifting is. Either way of hearing it: the word, or the
        // `delivering` that follows the word for a shell that never learned it.
        rig.feed(&CoreEvent::Delivering {
            found: 2,
            reason: Some("resumed".into()),
        });
        assert!(rig.state.attention().is_none());
    }

    #[test]
    fn a_rescan_during_a_quota_pause_does_not_re_arm_the_toast() {
        // The half of the same branch that is not about the icon. The toast is
        // latched so a core re-announcing one pause per batch attempt says it
        // once, and a `delivering` used to unlatch it. So Deliver now, pressed
        // twice against a spent budget, was two toasts for one pause.
        let mut rig = Rig::running();
        for _ in 0..3 {
            rig.feed(&CoreEvent::Paused {
                reason: Some("quota".into()),
                resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
            });
            rig.feed(&CoreEvent::Delivering {
                found: 0,
                reason: Some("rescan".into()),
            });
        }
        let quota = rig
            .toasts
            .iter()
            .filter(|t| matches!(t, Toast::QuotaPaused { .. }))
            .count();
        assert_eq!(quota, 1, "{:?}", rig.toasts);
    }

    #[test]
    fn a_quota_pause_and_a_user_pause_are_not_the_same_state() {
        // Same event, two reasons, and the difference is the whole point:
        // amber and worth looking at, against grey and asked for.
        let mut quota = Rig::running();
        quota.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-29T00:00:00.000Z".into()),
        });
        assert_eq!(quota.state.icon(), IconState::Attention);
        assert_ne!(quota.state.status, CoreStatus::Paused);
        assert_eq!(quota.toasts.len(), 1);

        let mut user = Rig::running();
        user.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert_eq!(user.state.icon(), IconState::Paused);
        assert_eq!(user.state.status, CoreStatus::Paused);
        assert!(user.toasts.is_empty());
    }

    #[test]
    fn a_paused_event_with_no_reason_at_all_is_read_as_a_person() {
        // A quota pause always has a reason to give, so the ambiguous case is
        // the human one. Getting it the other way round would show an amber
        // attention state for something the user did on purpose.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Paused {
            reason: None,
            resumes_at: None,
        });
        assert_eq!(rig.state.status, CoreStatus::Paused);
        assert_eq!(rig.state.icon(), IconState::Paused);
    }

    #[test]
    fn a_child_that_dies_while_paused_is_a_crash_and_not_a_pause() {
        // At M2 this branch could not exist: pausing was how the child was made
        // to leave, so an exit while paused was expected. It is now a crash.
        let mut rig = Rig::running();
        rig.state.on_pause_requested();
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert_eq!(rig.state.on_child_exit(None), ExitVerdict::Unexpected);
        assert_eq!(rig.state.status, CoreStatus::Backoff);
    }

    #[test]
    fn deliver_now_is_offered_only_against_a_running_core() {
        let mut rig = Rig::running();
        assert!(rig.state.deliver_now_enabled());

        rig.state.on_pause_requested();
        assert!(!rig.state.deliver_now_enabled());
        rig.feed(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert!(!rig.state.deliver_now_enabled());

        let cold = AppState::new();
        assert!(!cold.deliver_now_enabled());
    }

    // -- the status window's own controls (the status-window reshape) --------

    #[test]
    fn the_windows_engine_control_never_promises_what_the_core_would_refuse() {
        // The window carries Pause and Resume itself now, and a button is a
        // worse place to be wrong than a menu item is: it is the first thing on
        // the page and it is the thing a person reaches for. So the control is a
        // label, a word and an enabled flag computed together, and the word is
        // absent wherever there is nothing the core would answer.
        let cold = AppState::new();
        assert_eq!(cold.engine_control().word, None);
        assert!(!cold.engine_control().enabled);

        let mut needs_setup = AppState::new();
        needs_setup.set_needs_setup(true);
        // The menu's one item is "Set up Photo Pigeon" in this state. The
        // window's pause button may not quietly become a setup button: the door
        // into setup is the link in the tab row, one line above it, and this
        // control stays the one thing it says it is.
        assert_eq!(needs_setup.action_item().0, "Set up Photo Pigeon");
        assert_eq!(needs_setup.engine_control().word, None);
        assert!(!needs_setup.engine_control().enabled);

        let mut state = running();
        assert_eq!(state.engine_control().word, Some("pause"));
        assert_eq!(state.engine_control().label, "Pause");
        assert!(state.engine_control().enabled);

        state.on_pause_requested();
        assert_eq!(state.engine_control().word, None);
        assert!(!state.engine_control().enabled);
        assert_eq!(
            state.engine_control().label,
            "Pausing, finishing what is in flight"
        );

        state.apply(&CoreEvent::Paused {
            reason: Some("user".into()),
            resumes_at: None,
        });
        assert_eq!(state.engine_control().word, Some("resume"));
        assert_eq!(state.engine_control().label, "Resume");
        assert!(state.engine_control().enabled);

        state.on_resume_requested();
        assert_eq!(state.engine_control().word, None);
        assert_eq!(state.engine_control().label, "Starting again");

        // And the two invariants that hold in every state there is: a button
        // always has a label, and it is enabled exactly when there is a word to
        // write. Anything else is a control that promises a refusal.
        let mut sweep = running();
        for status in [
            CoreStatus::Cold,
            CoreStatus::Starting,
            CoreStatus::Running,
            CoreStatus::Pausing,
            CoreStatus::Paused,
            CoreStatus::Resuming,
            CoreStatus::Stopping(StopIntent::Quit),
            CoreStatus::Stopping(StopIntent::Detach),
            CoreStatus::Backoff,
            CoreStatus::Halted,
            CoreStatus::Quitting,
        ] {
            sweep.status = status;
            let control = sweep.engine_control();
            assert!(!control.label.is_empty(), "{status:?} has an empty label");
            assert!(
                !control.label.contains('\u{2014}'),
                "em dash in {:?}",
                control.label
            );
            assert_eq!(
                control.enabled,
                control.word.is_some(),
                "{status:?}: enabled {} against word {:?}",
                control.enabled,
                control.word
            );
        }
    }

    #[test]
    fn a_quota_hold_leaves_both_controls_live_because_the_engine_really_is_running() {
        // The M3 review's two criticals, asked again as a question about a
        // window. A spent budget is an amber line over a *running* engine, so
        // pausing it is a real thing to offer and so is one more pass. The
        // failure this guards is the mirror of M3's: a page that read a red line
        // as "nothing works" and disabled the two controls that do work.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });
        assert!(matches!(
            rig.state.attention(),
            Some(Attention::QuotaPaused { .. })
        ));
        assert_eq!(rig.state.status, CoreStatus::Running);

        let control = rig.state.engine_control();
        assert_eq!(control.label, "Pause");
        assert_eq!(control.word, Some("pause"));
        assert!(control.enabled);
        assert!(rig.state.deliver_now_enabled());
    }

    #[test]
    fn the_windows_control_and_the_menus_item_never_disagree_about_a_pause() {
        // The menu keeps its copies of these actions, which is deliberate
        // and not an oversight: two surfaces, one truth. So wherever the
        // menu's one item really is a pause or a resume, the window's button is
        // the same words in the same state, because both are computed here.
        let mut sweep = running();
        for status in [
            CoreStatus::Starting,
            CoreStatus::Running,
            CoreStatus::Pausing,
            CoreStatus::Paused,
            CoreStatus::Resuming,
        ] {
            sweep.status = status;
            let (label, enabled) = sweep.action_item();
            let control = sweep.engine_control();
            assert_eq!(control.label, label, "{status:?}");
            assert_eq!(control.enabled, enabled, "{status:?}");
        }
    }

    // -- quit, and the detach that finally makes its label true --------------

    #[test]
    fn a_drain_that_times_out_never_becomes_a_kill() {
        let mut state = running();
        state.on_quit_pressed();
        state.on_stop_requested(StopIntent::Quit);
        state.on_drain_timeout(None);
        assert_eq!(state.icon(), IconState::Attention);
        assert!(state.tooltip().contains("Still finishing"));
        // The second press is what leaves. Nothing here kills anything.
        assert!(state.on_quit_pressed());
    }

    #[test]
    fn quit_says_what_it_is_doing_and_what_the_second_press_will_do() {
        let mut state = running();
        assert_eq!(state.quit_item(), "Quit Photo Pigeon");
        assert!(!state.on_quit_pressed());
        state.on_stop_requested(StopIntent::Quit);
        assert_eq!(state.quit_item(), "Leave, it finishes on its own");
        assert_eq!(state.status_line(), "Finishing up, then closing");
    }

    #[test]
    fn the_quit_label_promises_a_continuation_and_the_detach_word_is_what_pays_for_it() {
        // This assertion is the inverse of the M2 one, and the inversion is the
        // milestone. At M2 the label was forbidden from promising the engine
        // carried on, because the shell's exit closed stdin, an end of file
        // reaching a stopping core was a second stop, and the core answered it
        // with queue.leaveNow() and exit 130. The promise was a lie and the
        // test existed to keep it out of the menu.
        //
        // M3 adds `detach`, after which the core ignores that end of file. So
        // the promise may be made, and this test holds the two halves together:
        // the label says it, and the state machine really does ask for the word
        // that makes it true.
        let mut state = running();
        state.on_quit_pressed();
        state.on_stop_requested(StopIntent::Quit);
        let offer = state.quit_item();
        assert!(
            offer.to_lowercase().contains("finishes on its own"),
            "the second press no longer costs the batch, and the label should say so: {offer:?}"
        );

        // Second press: the word, not a closed pipe.
        assert!(state.on_quit_pressed());
        state.on_detach_requested();
        assert_eq!(state.status, CoreStatus::Stopping(StopIntent::Detach));
        assert!(!state.detached(), "not until the core says so");

        state.apply(&CoreEvent::Detached);
        assert!(state.detached());
        assert_eq!(
            state.on_child_exit(Some(0)),
            ExitVerdict::Expected(StopIntent::Detach)
        );
        assert_eq!(state.status, CoreStatus::Quitting);
    }

    #[test]
    fn a_detach_is_an_expected_exit_and_never_a_crash_to_respawn() {
        // The core exiting after a detach is the drain finishing, which is the
        // best possible outcome. Respawning into it would be absurd.
        let mut state = running();
        state.on_quit_pressed();
        state.on_detach_requested();
        state.apply(&CoreEvent::Detached);
        assert_eq!(
            state.on_child_exit(Some(0)),
            ExitVerdict::Expected(StopIntent::Detach)
        );
    }

    #[test]
    fn a_detached_event_nobody_asked_for_does_not_close_the_shell() {
        // A tray that walked out because a line arrived on a pipe would be a
        // background tool that its own child could switch off.
        let mut state = running();
        state.apply(&CoreEvent::Detached);
        assert_eq!(state.status, CoreStatus::Running);
        assert_eq!(state.on_child_exit(None), ExitVerdict::Unexpected);
    }

    #[test]
    fn a_late_drain_that_arrives_is_no_longer_news() {
        let mut state = running();
        state.on_stop_requested(StopIntent::Quit);
        state.on_drain_timeout(None);
        assert_eq!(state.icon(), IconState::Attention);
        state.on_child_exit(Some(0));
        assert!(state.attention().is_none());
    }

    // -- toasts: four, and never one per file --------------------------------

    #[test]
    fn the_happy_toast_goes_out_once_ever_and_not_once_per_file() {
        let mut rig = Rig::running();
        rig.feed(&first_delivery("IMG_0421.jpg", 10));
        assert_eq!(
            rig.toasts,
            vec![Toast::FirstDelivery {
                file: Some("IMG_0421.jpg".into())
            }]
        );

        // Ninety-nine more photos, and silence.
        for n in 0..99 {
            rig.feed(&delivered(&format!("IMG_{n}.jpg"), 10));
        }
        assert_eq!(rig.toasts.len(), 1, "a toast per file is how a tool gets muted");

        // And a later launch says nothing at all, because the core does not
        // call any of those the first either. This is the "ever" half of the
        // promise, and it now rests on a ledger rather than on a flag file
        // that could be lost with a profile.
        let mut later = Rig::running();
        later.feed(&delivered("IMG_9999.jpg", 10));
        assert!(later.toasts.is_empty());
    }

    #[test]
    fn a_brand_new_shell_stays_quiet_for_a_delivery_the_core_did_not_call_the_first() {
        // The test that fails against a shell keeping its own count. Nothing
        // here has ever seen a delivery, no state file was ever loaded, and the
        // core says this is an ordinary photo: the veteran CLI user's ledger
        // installing the tray for the first time. Silence is the right answer
        // and a shell with its own latch would toast.
        let mut rig = Rig::running();
        rig.feed(&delivered("IMG_0421.jpg", 10));
        assert!(
            rig.toasts.is_empty(),
            "the shell invented a first delivery the core never claimed"
        );
    }

    #[test]
    fn a_virgin_ledger_taking_a_twelve_photo_first_batch_toasts_once() {
        // The state the rig cannot construct and the reviewer named: a brand
        // new install whose user's first action is dropping twelve photos in.
        // The core marks exactly one of the twelve, so this is a test that the
        // shell adds no counting of its own in either direction.
        let mut rig = Rig::running();
        rig.feed(&first_delivery("IMG_0001.jpg", 10));
        for n in 1..12 {
            rig.feed(&delivered(&format!("IMG_{n:04}.jpg"), 10));
        }
        assert_eq!(
            rig.toasts,
            vec![Toast::FirstDelivery {
                file: Some("IMG_0001.jpg".into())
            }]
        );
    }

    // -- the status window's recent activity ring ---------------------------

    #[test]
    fn the_recent_ring_is_bounded_and_keeps_the_newest() {
        // The RAM budget, as a test. A watch over a large library says
        // something per file, so an unbounded list here is a slope on a process
        // that is meant to sit resident forever. The cap is on the push and
        // there is no other way in.
        let mut state = running();
        for n in 0..(RECENT_MAX * 3) {
            state.note_recent(
                Some(format!("2026-07-29T00:00:{n:02}.000Z")),
                "delivered",
                &delivered(&format!("IMG_{n:04}.jpg"), 10),
            );
        }
        let recent = state.recent();
        assert_eq!(recent.len(), RECENT_MAX);
        // Newest last, oldest dropped.
        assert!(recent
            .last()
            .expect("a last entry")
            .detail
            .contains(&format!("IMG_{:04}.jpg", RECENT_MAX * 3 - 1)));
        assert!(!recent[0].detail.contains("IMG_0000.jpg"));
    }

    #[test]
    fn every_event_in_the_union_has_a_line_a_person_can_read() {
        // The window prints these and nothing else, so an event with no
        // sentence is a blank row rather than a crash, which is worse.
        for event in every_event() {
            let line = describe(&event);
            assert!(!line.trim().is_empty(), "{event:?} has no line");
            assert!(!line.contains('\u{2014}'), "em dash in {line:?}");
            // Never a whole path: this is a glanceable list, and Open log is
            // one click away for the truth.
            assert!(!line.contains("D:\\Photos\\"), "a full path in {line:?}");
        }
    }

    #[test]
    fn the_first_photo_ever_is_named_as_such_in_the_recent_list() {
        assert!(describe(&first_delivery("IMG_0001.jpg", 10)).contains("the first ever"));
        assert!(!describe(&delivered("IMG_0002.jpg", 10)).contains("first ever"));
    }

    #[test]
    fn nothing_ordinary_ever_raises_a_toast() {
        // The closed list, checked over the union rather than over the three
        // events somebody remembered. A skip, a scan, a delivering with nothing
        // found, a stopping: none of them is news.
        for event in every_event() {
            let mut rig = Rig::running();
            rig.feed(&event);
            let noisy = matches!(event, CoreEvent::AuthNeeded { .. })
                || matches!(event, CoreEvent::Delivered { first_ever: true, .. })
                || matches!(&event, CoreEvent::Paused { reason, .. } if is_quota(reason.as_deref()));
            assert_eq!(
                rig.toasts.is_empty(),
                !noisy,
                "{event:?} raised {:?}",
                rig.toasts
            );
        }
    }

    #[test]
    fn the_quota_toast_goes_out_once_however_often_the_core_says_it() {
        let mut rig = Rig::running();
        for _ in 0..5 {
            rig.feed(&CoreEvent::Paused {
                reason: Some("quota".into()),
                resumes_at: Some("2026-07-29T00:00:00.000Z".into()),
            });
        }
        assert_eq!(rig.toasts.len(), 1);
        assert_eq!(
            rig.toasts[0],
            Toast::QuotaPaused {
                resumes_at: Some("2026-07-29T00:00:00.000Z".into())
            }
        );
    }

    #[test]
    fn one_quota_pause_repeated_is_still_one_toast() {
        // This was "the core's two ways of saying one quota pause". There is
        // only one way now: M4 deleted the legacy `paused-quota` line from the
        // core and this shell's arm for it in the same commit, because a
        // compatibility layer on each side of a seam is a duplicate rather than
        // two safety nets. The dedup stays, because a core may still repeat a
        // `paused` for one hold and one budget being spent is one piece of
        // news however many times it arrives.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });
        assert_eq!(rig.toasts.len(), 1, "{:?}", rig.toasts);
    }

    #[test]
    fn one_quota_pause_is_one_toast_even_with_a_louder_problem_already_up() {
        // The case that made the dedup its own flag. Four attention states
        // outrank a quota pause, so with one of them up the slot never becomes
        // QuotaPaused, and a dedup that reads the slot sees both lines as new.
        // Sign in first, then the budget runs out, then the core says so twice.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        });
        let quota: Vec<_> = rig
            .toasts
            .iter()
            .filter(|t| matches!(t, Toast::QuotaPaused { .. }))
            .collect();
        assert_eq!(quota.len(), 1, "{:?}", rig.toasts);
        // And the louder problem is still the one the icon is about.
        assert!(matches!(rig.state.attention(), Some(Attention::AuthNeeded(_))));
    }

    #[test]
    fn tomorrows_quota_pause_can_still_speak_after_todays_lifted() {
        // The other half of moving the dedup off the attention slot: a flag
        // that is never armed again would silence every later pause.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: None,
        });
        rig.feed(&CoreEvent::Delivering {
            found: 3,
            reason: Some("resumed".into()),
        });
        rig.feed(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: None,
        });
        let quota = rig
            .toasts
            .iter()
            .filter(|t| matches!(t, Toast::QuotaPaused { .. }))
            .count();
        assert_eq!(quota, 2, "{:?}", rig.toasts);
    }

    #[test]
    fn a_sign_in_raises_exactly_one_toast_and_the_exit_after_it_adds_nothing() {
        // Two events for one problem, and the user gets told once. The exit
        // that follows an auth-needed is the same news arriving again.
        let mut rig = Rig::running();
        rig.feed(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        assert_eq!(rig.toasts, vec![Toast::AuthNeeded]);

        let verdict = rig.state.on_child_exit(Some(1));
        assert_eq!(verdict, ExitVerdict::NeedsUser);
        assert_eq!(rig.state.exit_toast(&verdict, false), None);
    }

    #[test]
    fn a_refusal_toasts_with_the_cores_own_sentence() {
        let mut state = AppState::new();
        state.on_spawn();
        state.apply(&CoreEvent::Failed {
            path: None,
            error: "another copy is already watching. Process 71608 started at 09:12.".into(),
        });
        let verdict = state.on_child_exit(Some(1));
        assert_eq!(verdict, ExitVerdict::Refused);
        let toast = state.exit_toast(&verdict, false).expect("a toast");
        assert!(toast.body().contains("another copy is already watching"));
        // And only once.
        assert_eq!(state.exit_toast(&verdict, false), None);
    }

    #[test]
    fn standing_down_toasts_with_the_pid_that_took_over() {
        let mut state = running();
        state.apply(&CoreEvent::LockLost {
            reason: "stolen".into(),
            held_by: Some(71608),
            stopping: true,
        });
        let verdict = state.on_child_exit(Some(0));
        assert_eq!(verdict, ExitVerdict::StoodDown);
        let toast = state.exit_toast(&verdict, false).expect("a toast");
        assert!(toast.body().contains("71608"));
    }

    #[test]
    fn an_ordinary_crash_is_silent_until_the_backoff_has_given_up_on_being_quick() {
        // A background uploader that toasts on every wobble gets muted. One
        // that says nothing while it quietly retries every five minutes is
        // worse. So: silence while it is still trying hard, one toast when it
        // is not, and nothing more until a run gets up again.
        let mut state = running();
        let verdict = state.on_child_exit(Some(1));
        assert_eq!(verdict, ExitVerdict::Unexpected);
        assert_eq!(state.exit_toast(&verdict, false), None);
        assert!(state.exit_toast(&verdict, true).is_some());
        assert_eq!(state.exit_toast(&verdict, true), None, "once per stretch");

        // A healthy start arms it again for the next bad stretch.
        state.on_spawn();
        state.apply(&started());
        let verdict = state.on_child_exit(Some(1));
        assert!(state.exit_toast(&verdict, true).is_some());
    }

    #[test]
    fn a_quit_is_never_toasted_because_the_user_already_knows() {
        let mut state = running();
        state.on_stop_requested(StopIntent::Quit);
        let verdict = state.on_child_exit(Some(0));
        assert_eq!(state.exit_toast(&verdict, true), None);
    }

    // -- the restart, which is a stop that is not a goodbye -------------------

    #[test]
    fn a_restart_never_tells_the_user_the_app_is_closing() {
        // The one thing this state must not borrow from the quit path. A person
        // who edited their folder list and read "Finishing up, then closing"
        // would reasonably think they had just shut the tool down.
        let mut state = running();
        state.on_stop_requested(StopIntent::Restart);
        let line = state.status_line();
        assert!(line.contains("starting again"), "{line:?}");
        assert!(!line.to_lowercase().contains("clos"), "{line:?}");
        assert!(!line.to_lowercase().contains("leav"), "{line:?}");
        assert!(!line.contains('\u{2014}'), "em dash in {line:?}");
        // And Quit still offers to quit, because a first press during a restart
        // takes over the stop that is already on the wire.
        assert_eq!(state.quit_item(), format!("Quit {DISPLAY_NAME}"));
    }

    #[test]
    fn a_restarts_exit_leaves_the_state_ready_to_start_rather_than_quitting() {
        // `Quitting` is what the shell reads to know it may leave. A restart that
        // landed there would take the tray down every time somebody edited a
        // folder.
        let mut state = running();
        state.on_stop_requested(StopIntent::Restart);
        let verdict = state.on_child_exit(Some(0));
        assert_eq!(verdict, ExitVerdict::Expected(StopIntent::Restart));
        assert_eq!(state.status, CoreStatus::Cold);
        // And nobody is toasted about a run the shell itself asked to end.
        assert_eq!(state.exit_toast(&verdict, false), None);
    }

    #[test]
    fn a_restart_is_never_read_as_a_crash_to_back_off_from() {
        // The backoff ladder exists for a core that fell over. A run that ended
        // because we asked is no evidence at all about the next one, and reading
        // it as a crash would put a two second wait between an edit and the list
        // taking effect, then five, then fifteen.
        let mut state = running();
        state.on_stop_requested(StopIntent::Restart);
        assert_ne!(state.on_child_exit(Some(0)), ExitVerdict::Unexpected);
        assert!(state.attention().is_none(), "{:?}", state.attention());
    }

    #[test]
    fn the_restart_sentences_are_plain_english_a_person_can_read() {
        for reason in [RestartReason::WatchDirs, RestartReason::Setup] {
            for stage in [
                RestartStage::Asked,
                RestartStage::WhenResumed,
                RestartStage::StillFinishing,
                RestartStage::Done,
            ] {
                let line = restart_notice(reason, stage);
                assert!(!line.contains('\u{2014}'), "em dash in {line:?}");
                assert!(!line.contains("photo-pigeon"), "package name in {line:?}");
                assert!(!line.contains("config.json"), "a file path in {line:?}");
                assert!(line.ends_with('.'), "{line:?} is not a sentence");
                // Sentence case inside a window: the first word is capitalised
                // and nothing shouts.
                assert!(line.starts_with(|c: char| c.is_uppercase()), "{line:?}");
            }
            // The waiting sentence is the only one that may promise later, and it
            // has to name the thing the user has to do.
            assert!(restart_notice(reason, RestartStage::WhenResumed).contains("resume"));
            // And the still-finishing one may not put a time on anything, because
            // it is the sentence that shares a page with "the engine went quiet".
            // It says what is waiting; the drain decides when.
            let stalled = restart_notice(reason, RestartStage::StillFinishing);
            assert!(stalled.contains("waiting"), "{stalled:?}");
            for promise in ["then starting", "starts when", "now", "shortly"] {
                assert!(!stalled.contains(promise), "{stalled:?} promises {promise:?}");
            }
        }
    }

    /// The two things the status window shows at once do not contradict each
    /// other when a core hangs through the whole drain.
    ///
    /// The independent pass's banked finding, and the state is reachable without
    /// anything exotic: edit the watched list, and the core never answers the
    /// `stop`. Five minutes later the window carries the amber line saying the
    /// engine went quiet while it was finishing, and, right beside it, the
    /// restart's own sentence still saying the engine is finishing and then
    /// starting again on the new list. Both were true when they were written. A
    /// person reads them together and one of them is a promise nothing is keeping.
    ///
    /// Nothing is cancelled by this. The restart still happens if the core ever
    /// confirms, the batch is still not abandoned, and two Quit presses are still
    /// the way out. What changes is only which sentence is on screen.
    #[test]
    fn a_drain_that_ran_out_stops_promising_the_restart_it_cannot_time() {
        let mut state = running();
        state.on_stop_requested(StopIntent::Restart);
        state.note(restart_notice(RestartReason::WatchDirs, RestartStage::Asked));

        state.on_drain_timeout(Some(RestartReason::WatchDirs));

        let amber = state.attention().expect("the timeout was raised").line();
        let notice = state.notice().expect("the restart said something").to_string();
        assert!(amber.contains("went quiet"), "{amber}");
        assert_eq!(
            notice,
            restart_notice(RestartReason::WatchDirs, RestartStage::StillFinishing)
        );
        // The sentence that was wrong is gone rather than joined by a second one:
        // the notice is one line, and a page shows the one it has.
        assert!(
            !notice.contains("then starting again"),
            "the window says {notice:?} beside {amber:?}"
        );
        // And the restart is still a restart: the status is untouched, so the
        // exit that finally arrives is still expected and is still not a crash.
        assert_eq!(state.status, CoreStatus::Stopping(StopIntent::Restart));
        assert_eq!(
            state.on_child_exit(Some(0)),
            ExitVerdict::Expected(StopIntent::Restart)
        );
    }

    #[test]
    fn a_quit_that_took_over_the_restart_is_not_told_about_a_new_list() {
        // A first Quit press during a restart moves that stop's intent rather
        // than writing a second one, which is the M2 review's second finding in
        // its M3 clothes. The reason is still owed at that point, because nothing
        // has said `started`, so the reason alone would put "the new list is
        // waiting for it" on the screen of somebody who has just asked the app to
        // leave. The status is the other half of the guard for exactly that.
        let mut state = running();
        state.on_stop_requested(StopIntent::Restart);
        state.note(restart_notice(RestartReason::WatchDirs, RestartStage::Asked));
        state.on_quit_pressed();
        state.on_stop_requested(StopIntent::Quit);

        state.on_drain_timeout(Some(RestartReason::WatchDirs));

        assert_eq!(
            state.notice(),
            Some(restart_notice(RestartReason::WatchDirs, RestartStage::Asked)),
            "a leaving shell was told about the new list"
        );
        assert!(state.tooltip().contains("Still finishing"), "{}", state.tooltip());
    }

    #[test]
    fn the_notice_is_an_account_of_what_happened_and_not_a_state() {
        // It is replaced rather than cleared, which is what stops it being a
        // fourth thing that can get stuck showing something untrue.
        let mut state = AppState::new();
        assert_eq!(state.notice(), None);
        state.note(restart_notice(RestartReason::WatchDirs, RestartStage::Asked));
        assert_eq!(
            state.notice(),
            Some(restart_notice(RestartReason::WatchDirs, RestartStage::Asked))
        );
        state.note(restart_notice(RestartReason::WatchDirs, RestartStage::Done));
        assert_eq!(
            state.notice(),
            Some(restart_notice(RestartReason::WatchDirs, RestartStage::Done))
        );
    }

    #[test]
    fn the_more_urgent_complaint_wins() {
        let mut state = running();
        state.apply(&CoreEvent::Failed {
            path: Some("d.mov".into()),
            error: "too big".into(),
        });
        state.apply(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        assert!(matches!(state.attention(), Some(Attention::AuthNeeded(_))));
        // And a lesser one does not push it back out.
        state.apply(&CoreEvent::Failed {
            path: Some("e.mov".into()),
            error: "too big".into(),
        });
        assert!(matches!(state.attention(), Some(Attention::AuthNeeded(_))));
    }

    #[test]
    fn the_tooltip_fits_the_windows_budget_in_every_state() {
        let mut state = running();
        let mut seen = Vec::new();
        let check = |state: &AppState, label: &str| {
            let tip = state.tooltip();
            assert!(
                utf16_len(&tip) <= TOOLTIP_MAX_UTF16,
                "{label}: {} units, {tip:?}",
                utf16_len(&tip)
            );
            assert!(
                tip.contains("Original quality"),
                "{label} dropped the storage line: {tip:?}"
            );
        };
        check(&state, "watching");
        seen.push(state.tooltip());

        state.apply(&delivered(
            "D:\\Photos\\a-really-quite-long-file-name-from-a-camera-2026-07-28.jpg",
            1,
        ));
        check(&state, "delivering with a long name");

        state.apply(&CoreEvent::AuthNeeded {
            reason: "invalid_grant".into(),
        });
        check(&state, "auth");

        state.apply(&CoreEvent::Paused {
            reason: Some("x".repeat(400)),
            resumes_at: Some("2026-07-29T00:00:00.000Z".into()),
        });
        check(&state, "quota");

        let mut refused = AppState::new();
        refused.on_spawn();
        refused.apply(&CoreEvent::Failed {
            path: None,
            error: "another copy is already watching ".repeat(20),
        });
        refused.on_child_exit(Some(1));
        check(&refused, "refused");

        // The fifth state, which brought a sentence of its own and therefore a
        // new way to overrun a 127 unit budget.
        let mut red = running();
        red.on_child_exit(Some(1));
        red.note_giving_ground();
        check(&red, "the ladder has given up");
    }

    #[test]
    fn the_tooltip_cuts_the_file_name_and_never_the_law() {
        let mut state = running();
        state.apply(&delivered(&format!("D:\\Photos\\{}.jpg", "n".repeat(300)), 1));
        let tip = state.tooltip();
        assert!(utf16_len(&tip) <= TOOLTIP_MAX_UTF16, "{tip:?}");
        // The law is a promise and survives whole.
        assert!(tip.contains(STORAGE_HONESTY_SHORT));
        // The name is a nicety and survives cut, with the cut shown.
        assert!(tip.contains("Last: nnn"));
        assert!(tip.contains("..."));
    }

    #[test]
    fn the_tooltip_drops_the_detail_when_there_is_no_room_worth_using() {
        let mut state = running();
        // A head long enough to leave fewer than a readable handful of units.
        state.apply(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: None,
        });
        state.watch_dirs = vec!["a".into(); 3];
        let tip = state.tooltip();
        assert!(utf16_len(&tip) <= TOOLTIP_MAX_UTF16, "{tip:?}");
        assert!(tip.contains(STORAGE_HONESTY_SHORT));
    }

    #[test]
    fn totals_never_walk_the_counters_backwards() {
        let mut state = running();
        state.apply(&delivered("a.jpg", 5000));
        state.apply(&delivered("b.jpg", 5000));
        state.apply(&CoreEvent::Stopped {
            exit_code: 0,
            // A run whose totals block lost an event still cannot shrink the
            // number the user has been watching.
            totals: Some(Totals {
                delivered: 1,
                bytes: 5000,
                ..Totals::default()
            }),
        });
        assert_eq!(state.delivered, 2);
        assert_eq!(state.bytes, 10000);
    }

    #[test]
    fn a_dry_run_says_so_in_the_status_line() {
        let mut state = AppState::new();
        state.on_spawn();
        state.apply(&CoreEvent::Started {
            pid: Some(1),
            version: None,
            watch_dirs: vec!["D:\\Photos".into()],
            album: None,
            dry_run: true,
            once: false,
            ledger_path: None,
            lock_path: None,
            log_path: None,
        });
        assert!(state.status_line().contains("dry run, nothing is sent"));
    }

    #[test]
    fn spawn_failure_halts_and_explains() {
        let mut state = AppState::new();
        state.on_spawn();
        state.on_spawn_failed("node is not on PATH");
        assert_eq!(state.status, CoreStatus::Halted);
        // No process was ever started, so no respawn changes anything about it.
        assert_eq!(state.icon(), IconState::Broken);
        assert!(state.status_line().contains("node is not on PATH"));
        assert_eq!(state.action_item().0, "Try again");
    }

    #[test]
    fn file_names_come_out_of_both_separators() {
        assert_eq!(file_name_of("D:\\Photos\\IMG_1.jpg"), "IMG_1.jpg");
        assert_eq!(file_name_of("/home/casey/pics/IMG_1.jpg"), "IMG_1.jpg");
        assert_eq!(file_name_of("IMG_1.jpg"), "IMG_1.jpg");
        assert_eq!(file_name_of(""), "");
    }

    #[test]
    fn bytes_read_the_way_the_cli_reads_them() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(999), "999 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(4 * 1024 * 1024), "4.0 MB");
        assert_eq!(format_bytes(150 * 1024 * 1024), "150 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }

    /// The display name is the same fact in two files, so it gets a join.
    ///
    /// `DISPLAY_NAME` drives the tooltip, the toast titles and the Quit label.
    /// productName drives the Start Menu entry, the install directory
    /// (`$LOCALAPPDATA\${PRODUCTNAME}`) and the HKCU Run value name the
    /// uninstaller deletes. If the two ever disagree, the tray calls itself one
    /// thing while Windows files it under another, and the autostart value ends
    /// up under a name the uninstaller will not remove.
    #[test]
    fn the_display_name_and_product_name_are_the_same_string() {
        const CONF: &str = include_str!("../tauri.conf.json");
        let conf: serde_json::Value = serde_json::from_str(CONF).expect("tauri.conf.json parses");
        assert_eq!(
            conf["productName"].as_str(),
            Some(DISPLAY_NAME),
            "productName and DISPLAY_NAME have drifted apart"
        );
        // And the machine identifiers are frozen, in the same read, because
        // they are the half of the naming decision that must not follow.
        assert_eq!(
            conf["mainBinaryName"].as_str(),
            Some("photo-pigeon"),
            "mainBinaryName is a machine identifier and does not follow the display name"
        );
        assert_eq!(
            conf["identifier"].as_str(),
            Some("io.github.justerlex.photopigeon"),
            "the identifier is the AppUserModelID and every toast ever sent is filed under it"
        );
    }

    /// The sweep: nothing a person reads may say the package name.
    #[test]
    fn nothing_a_person_reads_says_the_package_name() {
        let mut state = running();
        state.apply(&delivered("a.jpg", 1));
        let mut human = vec![
            state.status_line(),
            state.storage_line(),
            state.tooltip(),
            state.action_item().0,
            state.quit_item(),
            STORAGE_HONESTY_SHORT.to_string(),
        ];
        // Every state the quit label and the action item can be in, since the
        // one that says the product's name is the one that only appears in a
        // state a sweep by hand would miss.
        for status in [
            CoreStatus::Cold,
            CoreStatus::Starting,
            CoreStatus::Running,
            CoreStatus::Pausing,
            CoreStatus::Paused,
            CoreStatus::Resuming,
            CoreStatus::Stopping(StopIntent::Quit),
            CoreStatus::Stopping(StopIntent::Detach),
            CoreStatus::Stopping(StopIntent::Restart),
            CoreStatus::Backoff,
            CoreStatus::Halted,
            CoreStatus::Quitting,
        ] {
            state.status = status;
            human.push(state.quit_item());
            human.push(state.action_item().0);
            human.push(state.status_line());
            human.push(state.tooltip());
        }
        // And the red state, which no status reaches on its own: its sentence is
        // shown over three of them and only once the ladder has given up.
        let mut red = running();
        red.on_child_exit(Some(1));
        red.note_giving_ground();
        for status in [CoreStatus::Cold, CoreStatus::Starting, CoreStatus::Backoff] {
            red.status = status;
            human.push(red.status_line());
            human.push(red.tooltip());
        }

        for text in human {
            assert!(
                !text.contains("photo-pigeon"),
                "the package name reached a human: {text:?}"
            );
        }
        // And the one that does name the product names it properly.
        let fresh = AppState::new();
        assert_eq!(fresh.quit_item(), "Quit Photo Pigeon");
        assert!(fresh.tooltip().starts_with("Photo Pigeon: "));
    }

    #[test]
    fn no_em_dashes_anywhere_in_the_copy() {
        let mut state = running();
        state.apply(&delivered("a.jpg", 1));
        state.apply(&CoreEvent::Paused {
            reason: Some("quota".into()),
            resumes_at: None,
        });
        let mut red = running();
        red.on_child_exit(Some(1));
        red.note_giving_ground();
        for text in [
            state.status_line(),
            state.storage_line(),
            state.tooltip(),
            state.action_item().0,
            state.quit_item(),
            STORAGE_HONESTY_SHORT.to_string(),
            CRASH_LOOP_LINE.to_string(),
            red.status_line(),
            red.tooltip(),
        ] {
            assert!(!text.contains('\u{2014}'), "em dash in {text:?}");
        }
    }
}
