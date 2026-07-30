//! Auto update: the decisions, which is the half of it a test can reach.
//!
//! TRAY-DESIGN section 5's auto-update part is the decided design and this file
//! implements it rather than re-deciding it. The update policy: on by
//! default, background download, apply on next launch, never mid delivery,
//! never a forced restart. The mechanism is `tauri-plugin-updater`, and the
//! reason Tauri v2 is comfortable here rather than merely acceptable is that it
//! splits `download()` from `install()`, which is exactly the shape this policy
//! needs.
//!
//! ## What is here and what is next door
//!
//! Everything in this file is pure. No clock, no network, no process, no
//! `AppHandle`, in the same spirit as `state.rs`: the file that decides is the
//! file that can be tested in microseconds, and `supervisor.rs` is the one with
//! the timer and the async task. So the three decisions live here:
//!
//! | Decision | Function |
//! |---|---|
//! | may the shell ask GitHub whether there is a newer version | [`may_check`] |
//! | what is this shell walking away from | [`leaving`] |
//! | may the installer run now | [`install_now`] |
//!
//! And [`Updates`] is the bookkeeper that holds them together, including the
//! one door the bytes can leave through: [`Updates::take_for_install`] consults
//! [`install_now`] and hands the payload over only on [`Install::Now`]. That is
//! deliberately a type and not a comment. There is no other accessor for the
//! held bytes, so a future edit cannot install by forgetting to ask.
//!
//! ## The install is the sensitive step, and these are the five ways out
//!
//! `install()` on Windows calls `std::process::exit(0)` after handing the
//! installer to the shell, which is a documented Windows installer limitation
//! and not a Tauri quirk. So it must be the last thing this process ever does,
//! and it must not happen while anything is uploading. The shell has five ways
//! of leaving and only one of them is safe, which is what [`Leaving`] is:
//!
//! | Way out | Installs |
//! |---|---|
//! | no engine was running under this shell | yes |
//! | the engine drained, said `stopped`, and its process is gone | yes |
//! | the engine's process is gone but it never said `stopped` | no |
//! | the engine is still alive under this shell | no |
//! | the engine was told to finish on its own and we are walking away | no |
//!
//! The last one is the one worth reading twice, because it is the one a
//! reasonable person would get wrong. The second Quit press writes `detach`,
//! which means the core keeps uploading as an orphan while the shell leaves. An
//! installer started on that path would run over a live upload in another
//! process, which is the exact failure TRAY-DESIGN section 5 forbids by name.
//! So a detached exit installs nothing and the update waits for a clean quit.
//!
//! The third is the honest reading of the doc's own words, "after the sidecar
//! has drained and reported `{"type":"stopped"}`". A core whose process went
//! away without the receipt may have finished and may not, and this shell has
//! no way to tell. Nothing is uploading either way, so the refusal costs the
//! user one more quit rather than anything real, and it keeps the rule the doc
//! wrote rather than the rule that happens to be safe.

use std::time::{Duration, Instant};

use crate::state::{CoreStatus, DISPLAY_NAME};

/// How often the check may run after the one at launch.
///
/// TRAY-DESIGN section 5: "Check for an update on launch and once every 24
/// hours after. Never on a user gesture, never with a modal."
pub const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// How long after launch the launch check waits.
///
/// Still "on launch" and deliberately not "during startup". The first seconds
/// of a launch are the tray appearing, the Run value being re-asserted, the
/// core being spawned and the reconciliation walk taking its first bite, and a
/// TLS handshake competing with all of that buys nothing: an update that is
/// twenty seconds late is not late. It also keeps the check off the critical
/// path of the one thing a user is watching for, which is the pigeon showing up
/// in the tray.
pub const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);

/// Has this process been told not to check at all?
///
/// The one env seam in the whole updater, read fresh rather than cached so a
/// test can set it after the shell is up. `off` is the only word that turns it
/// off: anything else, including an empty value, leaves the checks on, because a
/// variable somebody set to `0` or `false` while meaning `off` should not
/// silently disable the thing that keeps a background uploader patchable.
///
/// It is deliberately not a user setting. The policy is "on by default" and there
/// is no menu item, no toggle and no config key for it: the reason this exists is
/// a rig and a bench, and TRAY-DESIGN section 5 is explicit that a background
/// uploader which cannot be patched is a liability.
pub fn checks_are_off() -> bool {
    std::env::var(crate::paths::env_names::UPDATE_CHECK)
        .map(|value| value.trim().eq_ignore_ascii_case("off"))
        .unwrap_or(false)
}

/// The label the Quit item wears while an update is waiting.
///
/// TRAY-DESIGN section 5 allows "at most a quiet `an update is ready` line in
/// the menu". This is the quieter form of that: no new row, and the sentence
/// sits on the item that performs the thing rather than beside it. See
/// [`quit_label`] for the one path it is deliberately not offered on.
pub fn quit_and_update() -> String {
    format!("Quit and update {DISPLAY_NAME}")
}

/// Where the shell is with the next version.
///
/// Four arms rather than five: the check and the download are one background
/// task, because there is nothing for the shell to decide between finding an
/// update and having its bytes, and a stage nobody can act on is a stage that
/// only exists to be logged. The task writes its own lines for that.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Stage {
    /// Nothing known, or the last check found nothing, or it failed.
    #[default]
    Nothing,
    /// A check is on the wire, and so is the download if it found one.
    Asking,
    /// The bytes are down, verified against the public key, and held.
    Waiting,
    /// `install()` has been called. Nothing else may ever happen.
    HandedOver,
}

/// What this shell is walking away from, at the moment it decides to leave.
///
/// The table in this module's header is the whole of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leaving {
    /// No engine is running under this shell. It was never spawned (a machine
    /// with no config), or it is halted, or it crashed and a respawn is still
    /// on the ladder. Nothing can be in flight, because there is no process to
    /// have it in flight.
    NothingRunning,
    /// The engine was asked to stop, said `stopped`, and its process is gone.
    /// The batch is finished and the ledger has the lines.
    Drained,
    /// The engine's process is gone and it never said `stopped`, so this shell
    /// cannot claim the drain finished.
    WentQuiet,
    /// The engine is still alive under this shell, which on any path that
    /// reaches an exit is a bug rather than a state. It refuses, loudly, in the
    /// log.
    StillRunning,
    /// The engine was told to finish the drain on its own and this shell is
    /// leaving it to it. A live upload in another process.
    Detached,
}

/// Why the installer is not running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    /// No update is waiting. The ordinary case, on every quit of every version
    /// that is already the newest.
    NothingWaiting,
    /// A check or a download is still on the wire. The bytes are not here, so
    /// there is nothing to install and nothing to wait for either: the task
    /// dies with the process.
    StillAsking,
    /// `install()` has already been called once.
    AlreadyHandedOver,
    /// The engine is still running under this shell.
    EngineRunning,
    /// The engine is finishing on its own in another process.
    EngineDetached,
    /// The engine went without confirming its drain.
    DrainUnconfirmed,
}

impl Hold {
    /// One line for the shell log. Never seen by a user: the whole point of
    /// this policy is that a held update is invisible until it installs.
    pub fn why(self) -> &'static str {
        match self {
            Self::NothingWaiting => "no update is waiting",
            Self::StillAsking => "the update check had not finished",
            Self::AlreadyHandedOver => "the installer was already handed the bytes",
            Self::EngineRunning => "the engine is still running, so a batch may be in flight",
            Self::EngineDetached => {
                "the engine was left to finish on its own, so a batch is in flight elsewhere"
            }
            Self::DrainUnconfirmed => "the engine went without confirming its drain",
        }
    }
}

/// The one decision the install is allowed to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Install {
    /// Run it. It is the last thing this process does.
    Now,
    /// Not now, and why.
    Not(Hold),
}

/// May the shell ask GitHub whether there is a newer version?
///
/// `since_last` is how long ago the last check finished, whatever it found.
/// `None` is the launch check, which is the only one that does not have to wait
/// for anything.
///
/// **One update at a time, on purpose.** A stage that is not [`Stage::Nothing`]
/// refuses, so a shell holding one version's bytes for a fortnight does not go
/// looking for a third. It installs the one it has on the next clean quit and
/// the launch after that finds anything newer. The cost is being one version
/// behind for one launch; the thing it buys is that the held bytes and the
/// version the menu is promising can never be two different answers.
pub fn may_check(stage: Stage, since_last: Option<Duration>) -> bool {
    if stage != Stage::Nothing {
        return false;
    }
    match since_last {
        None => true,
        Some(since) => since >= CHECK_EVERY,
    }
}

/// Work out what the shell is leaving behind, from the four facts the supervisor
/// has when it decides to exit.
///
/// One function rather than five call sites choosing an arm, because the arm is
/// the decision and a call site that picks the wrong one is a silent installer
/// over a live upload. `exit_shell` is reachable five ways in `supervisor.rs` and
/// every one of them arrives here, because the classification happens inside
/// `exit_shell` and not at any of them.
///
/// `stop_was_asked` is the fact that keeps the receipt rule honest. Without it a
/// missing `stopped` event would refuse on a machine that never ran a core at
/// all, which is the machine least able to go and fetch an installer by hand: a
/// person who has not finished setup yet.
pub fn leaving(
    core_running: bool,
    detached: bool,
    stop_was_asked: bool,
    drain_confirmed: bool,
) -> Leaving {
    if core_running {
        // Detached is checked inside rather than before, because a live child we
        // have not detached is a different bug from one we have, and the log
        // should say which. It also means the detach that was written and never
        // confirmed reads as `StillRunning`, which is the true answer: this shell
        // does not know the core heard it.
        return if detached {
            Leaving::Detached
        } else {
            Leaving::StillRunning
        };
    }
    if detached {
        // The core confirmed a detach and then its process ended before the
        // shell got out of the door. Nothing is uploading. It is still read as
        // detached rather than drained, because the receipt this shell holds is
        // for a drain it asked the core to finish without supervision, and
        // "finished it while we watched" is a claim it cannot make.
        return Leaving::Detached;
    }
    if !stop_was_asked {
        // Nothing was ever asked to drain, so there is no receipt to want.
        // Three real shapes: a machine with no config where the core is
        // deliberately never spawned, a run that halted for something only a
        // person can fix, and a run that fell over with a respawn still on the
        // backoff ladder. In all three the child is gone and whatever it was
        // carrying was dropped by the thing that ended it, not by this exit.
        return Leaving::NothingRunning;
    }
    if drain_confirmed {
        Leaving::Drained
    } else {
        Leaving::WentQuiet
    }
}

/// May the installer run?
///
/// Exactly one of the twenty combinations of [`Stage`] and [`Leaving`] says yes
/// twice over, and the test at the bottom of this file walks all twenty.
pub fn install_now(stage: Stage, leaving: Leaving) -> Install {
    match stage {
        Stage::Nothing => return Install::Not(Hold::NothingWaiting),
        Stage::Asking => return Install::Not(Hold::StillAsking),
        Stage::HandedOver => return Install::Not(Hold::AlreadyHandedOver),
        Stage::Waiting => {}
    }
    match leaving {
        Leaving::StillRunning => Install::Not(Hold::EngineRunning),
        Leaving::Detached => Install::Not(Hold::EngineDetached),
        Leaving::WentQuiet => Install::Not(Hold::DrainUnconfirmed),
        Leaving::NothingRunning | Leaving::Drained => Install::Now,
    }
}

/// The Quit item's label, given what the engine is doing and whether an update
/// is waiting.
///
/// **It never promises an install on a path that does not install.** A shell
/// that is already draining or already detaching keeps the label it has: the
/// detach path installs nothing at all, and a drain that is already running has
/// a label of its own that is telling the user something more useful. So the
/// promise is only made on the press that starts a clean quit, which is the
/// press that keeps it.
///
/// The one softness, written down rather than hidden: a clean quit whose core
/// never confirms the drain shows this label and then does not install. That is
/// [`Leaving::WentQuiet`], the core is already raising
/// [`crate::state::Attention::StopUnconfirmed`] about it, and the user's next
/// quit installs. A label cannot know the future and this one does not pretend
/// to.
pub fn quit_label(base: String, waiting: bool, status: CoreStatus) -> String {
    if !waiting {
        return base;
    }
    match status {
        CoreStatus::Stopping(_) | CoreStatus::Quitting => base,
        _ => quit_and_update(),
    }
}

/// The update the plugin verified, and the bytes it handed back.
///
/// Held in memory from the moment the download finishes until the quit path,
/// because TRAY-DESIGN section 5 says to: "`download()` in the background
/// whenever one exists. Hold the bytes."
///
/// **Measured, and worth a second look before anybody trusts it.** The release build
/// of this project produces a 23.4 MB installer, because the bundled `node.exe`
/// is 81 MB before NSIS compresses it. So an update in hand costs 23.4 MB of
/// resident memory for as long as the app goes unquit, against the 9.87 MB the
/// whole shell measured at idle at M0. Two rules of the same document meet here:
/// section 5 says hold the bytes, and section 1 makes resident memory a stated
/// budget rather than a preference, and neither was written knowing this number.
///
/// It is implemented the way the document says and the number is written down
/// rather than quietly worked around, which is the only honest order for those
/// two things. The alternative, if that cost is ever refused, is to spill the verified
/// bytes to a file in the app's own cache directory and read them back at the
/// quit, which keeps the whole shape of the policy and costs a path to own, a
/// sweep on the next launch and one more refusal for a file that went away. The
/// plugin writes its own temp file at install time regardless, so the bytes reach
/// a disk either way.
pub struct ReadyUpdate {
    /// Boxed because the plugin's `Update` is a wide struct and this one sits
    /// inside the supervisor for the life of the process.
    pub update: Box<tauri_plugin_updater::Update>,
    pub bytes: Vec<u8>,
}

/// One held update: the version it installs and the payload that installs it.
pub struct Held<P> {
    pub version: String,
    pub payload: P,
}

/// The shell's whole memory of the updater.
///
/// Generic over the payload for one reason and it is a test reason: the shipped
/// path holds a [`ReadyUpdate`], which cannot be built without a running Tauri
/// app, and the bookkeeping rules (a ready update stops further checks, handing
/// over happens once, a receipt does not outlive its run) are worth proving
/// against the same code the shipped path runs rather than against a second
/// copy of it. The tests use `Updates<&str>`.
pub struct Updates<P = ReadyUpdate> {
    stage: Stage,
    /// When the last check finished, whatever it found. `None` until one has.
    last_check: Option<Instant>,
    held: Option<Held<P>>,
    /// Did the run that is ending say `stopped`?
    ///
    /// It lives here rather than in `state.rs` because the install gate is its
    /// only reader and `state.rs` clears the fact it would have to read: a
    /// drain that timed out and then arrived late has its
    /// [`crate::state::Attention::StopUnconfirmed`] wiped by the exit, which is
    /// right for the menu and useless as evidence.
    ///
    /// **Cleared on every spawn.** A receipt from the previous run is not
    /// evidence about this one, and without the clearing a restart's clean drain
    /// would vouch for a later run that went quiet.
    core_reported_stopped: bool,
}

impl<P> Default for Updates<P> {
    fn default() -> Self {
        Self {
            stage: Stage::default(),
            last_check: None,
            held: None,
            core_reported_stopped: false,
        }
    }
}

impl<P> Updates<P> {
    pub fn stage(&self) -> Stage {
        self.stage
    }

    /// Is there an update sitting here waiting for a quit?
    pub fn waiting(&self) -> bool {
        self.stage == Stage::Waiting
    }

    /// The version the held bytes install, for the log.
    pub fn held_version(&self) -> Option<&str> {
        self.held.as_ref().map(|held| held.version.as_str())
    }

    /// A check has gone out.
    pub fn note_check_started(&mut self) {
        self.stage = Stage::Asking;
    }

    /// The check came back with nothing, or it failed. Either way the clock
    /// restarts: a failed check is not a reason to hammer GitHub.
    pub fn note_check_done(&mut self, at: Instant) {
        self.stage = Stage::Nothing;
        self.last_check = Some(at);
    }

    /// The bytes are here.
    pub fn note_ready(&mut self, at: Instant, version: String, payload: P) {
        self.stage = Stage::Waiting;
        self.last_check = Some(at);
        self.held = Some(Held { version, payload });
    }

    /// The core said `stopped`, so the drain it was asked for is on the record.
    pub fn note_core_stopped(&mut self) {
        self.core_reported_stopped = true;
    }

    /// A new run is starting, so the previous run's receipt stops counting.
    pub fn forget_core_stopped(&mut self) {
        self.core_reported_stopped = false;
    }

    pub fn drain_confirmed(&self) -> bool {
        self.core_reported_stopped
    }

    /// May a check go out now?
    pub fn may_check_now(&self, now: Instant) -> bool {
        may_check(
            self.stage,
            self.last_check
                .map(|last| now.saturating_duration_since(last)),
        )
    }

    /// **The only door the bytes leave through.**
    ///
    /// It asks [`install_now`] and hands the payload over only on
    /// [`Install::Now`], moving the stage to [`Stage::HandedOver`] in the same
    /// breath so a second call refuses. There is no other accessor for the
    /// payload, which is what makes "the installer can only be reached through
    /// the verdict" a property of this type rather than a promise in a comment.
    pub fn take_for_install(&mut self, leaving: Leaving) -> Result<Held<P>, Hold> {
        match install_now(self.stage, leaving) {
            Install::Not(hold) => Err(hold),
            Install::Now => match self.held.take() {
                Some(held) => {
                    self.stage = Stage::HandedOver;
                    Ok(held)
                }
                // Unreachable while `note_ready` is the only thing that sets
                // `Stage::Waiting`, and a refusal rather than a panic because
                // this runs on the thread that owns the child process.
                None => Err(Hold::NothingWaiting),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped config, read rather than described. Same technique as
    /// `paths.rs` uses on `sidecar-layout.json`: the test holds the real file, so
    /// a key that gets renamed or dropped fails here rather than on a release
    /// day.
    fn conf() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is not valid JSON")
    }

    #[test]
    fn the_updater_is_configured_the_way_section_five_decided() {
        let conf = conf();
        let updater = &conf["plugins"]["updater"];

        // The static URL of TRAY-DESIGN section 5, which works because job 3
        // uploads latest.json to the same Release as the installer.
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([
                "https://github.com/justerlex/photo-pigeon/releases/latest/download/latest.json"
            ])
        );
        // https, always. The plugin refuses anything else in a release build and
        // only warns in a debug one, so the guard belongs here too.
        let endpoint = updater["endpoints"][0].as_str().unwrap();
        assert!(endpoint.starts_with("https://"));
        // The repository name is a machine identifier and the manifest already
        // commits to it in three fields.
        assert!(endpoint.contains("justerlex/photo-pigeon"));

        // A progress bar, no wizard, no clicks.
        assert_eq!(updater["windows"]["installMode"], "passive");

        // Without this there is a Release with an installer in it and no way for
        // any installed copy to ever move again.
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
    }

    /// Base64, by hand, because this crate has no base64 dependency and adding
    /// one for a test is a dependency for a test.
    fn base64_decode(text: &str) -> Option<Vec<u8>> {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits: u32 = 0;
        let mut held = 0u32;
        let mut out = Vec::new();
        for byte in text.bytes() {
            if byte == b'=' || byte.is_ascii_whitespace() {
                continue;
            }
            let value = ALPHABET.iter().position(|c| *c == byte)? as u32;
            bits = (bits << 6) | value;
            held += 6;
            if held >= 8 {
                held -= 8;
                out.push((bits >> held) as u8);
            }
        }
        Some(out)
    }

    const EVERY_STAGE: [Stage; 4] = [
        Stage::Nothing,
        Stage::Asking,
        Stage::Waiting,
        Stage::HandedOver,
    ];

    const EVERY_WAY_OUT: [Leaving; 5] = [
        Leaving::NothingRunning,
        Leaving::Drained,
        Leaving::WentQuiet,
        Leaving::StillRunning,
        Leaving::Detached,
    ];

    #[test]
    fn the_launch_check_is_the_only_one_that_waits_for_nothing() {
        assert!(may_check(Stage::Nothing, None));
        // A minute after the launch check is not a day later.
        assert!(!may_check(Stage::Nothing, Some(Duration::from_secs(60))));
        assert!(!may_check(
            Stage::Nothing,
            Some(CHECK_EVERY - Duration::from_secs(1))
        ));
        assert!(may_check(Stage::Nothing, Some(CHECK_EVERY)));
        // TRAY-DESIGN section 5 says once every 24 hours, so the constant is
        // part of the contract and not a tuning knob.
        assert_eq!(CHECK_EVERY, Duration::from_secs(86_400));
    }

    #[test]
    fn nothing_else_checks_while_one_update_is_in_hand() {
        for stage in [Stage::Asking, Stage::Waiting, Stage::HandedOver] {
            assert!(
                !may_check(stage, None),
                "{stage:?} let a second check out at launch"
            );
            assert!(
                !may_check(stage, Some(CHECK_EVERY * 10)),
                "{stage:?} let a second check out after ten days"
            );
        }
    }

    #[test]
    fn exactly_one_pair_of_facts_lets_the_installer_run() {
        // The whole policy in one table. If a future edit loosens a rule, the
        // count moves and this names the cell that changed.
        let mut allowed: Vec<(Stage, Leaving)> = Vec::new();
        for stage in EVERY_STAGE {
            for way in EVERY_WAY_OUT {
                if install_now(stage, way) == Install::Now {
                    allowed.push((stage, way));
                }
            }
        }
        assert_eq!(
            allowed,
            vec![
                (Stage::Waiting, Leaving::NothingRunning),
                (Stage::Waiting, Leaving::Drained),
            ],
            "the set of exits that install has changed"
        );
    }

    #[test]
    fn a_detached_exit_installs_nothing() {
        // The falsifier of the whole design, and the one a reasonable person
        // gets wrong: the second Quit press leaves the core uploading as an
        // orphan, so an installer here runs over a live upload in another
        // process. TRAY-DESIGN section 5 forbids it by name.
        assert_eq!(
            install_now(Stage::Waiting, Leaving::Detached),
            Install::Not(Hold::EngineDetached)
        );
        // And the classifier gets there from both shapes a detach can have: the
        // child still alive as the shell walks out, and the child gone after
        // confirming.
        assert_eq!(leaving(true, true, true, false), Leaving::Detached);
        assert_eq!(leaving(false, true, true, true), Leaving::Detached);
    }

    #[test]
    fn a_detach_that_was_never_confirmed_reads_as_a_live_engine() {
        // The detach timer's own path: `detach` was written, the core said
        // nothing, and the shell leaves because the second press asked it to.
        // `state.detached()` is false because only the event sets it, so the
        // honest reading is that a core is still running and this shell does not
        // know it heard anything. It refuses either way, and the log says which.
        assert_eq!(leaving(true, false, true, false), Leaving::StillRunning);
        assert_eq!(
            install_now(Stage::Waiting, Leaving::StillRunning),
            Install::Not(Hold::EngineRunning)
        );
    }

    #[test]
    fn a_batch_in_flight_under_this_shell_installs_nothing() {
        // The mid-delivery wait, at the only altitude a unit test can hold it:
        // an update is downloaded and ready, the engine is running, and the
        // verdict is a refusal that names why.
        let verdict = install_now(Stage::Waiting, leaving(true, false, false, false));
        assert_eq!(verdict, Install::Not(Hold::EngineRunning));
        assert_eq!(
            Hold::EngineRunning.why(),
            "the engine is still running, so a batch may be in flight"
        );
    }

    #[test]
    fn a_drain_that_was_never_confirmed_does_not_install() {
        // TRAY-DESIGN section 5 puts the install after the core "has drained and
        // reported {\"type\":\"stopped\"}", so a process that went away without
        // the receipt is not a drain this shell can vouch for.
        assert_eq!(
            install_now(Stage::Waiting, leaving(false, false, true, false)),
            Install::Not(Hold::DrainUnconfirmed)
        );
        assert_eq!(
            install_now(Stage::Waiting, leaving(false, false, true, true)),
            Install::Now
        );
    }

    #[test]
    fn a_machine_with_no_engine_running_still_gets_its_update() {
        // The case a receipt-only rule gets wrong, and it got it wrong on the
        // first pass of this file: a machine nobody has set up never spawns a
        // core, so it has no `stopped` to show, and a gate that demanded one
        // would strand exactly the user least able to fix it by hand. The fact
        // that separates the two is whether a stop was ever asked for.
        assert_eq!(leaving(false, false, false, false), Leaving::NothingRunning);
        assert_eq!(
            install_now(Stage::Waiting, Leaving::NothingRunning),
            Install::Now
        );
    }

    #[test]
    fn the_bytes_can_only_leave_through_the_verdict_and_only_once() {
        let mut updates: Updates<&str> = Updates::default();
        let now = Instant::now();

        // Nothing held: every way out refuses.
        for way in EVERY_WAY_OUT {
            assert!(updates.take_for_install(way).is_err(), "{way:?} took bytes");
        }

        updates.note_check_started();
        assert_eq!(
            updates.take_for_install(Leaving::Drained).err(),
            Some(Hold::StillAsking)
        );

        updates.note_ready(now, "0.1.1".into(), "the installer bytes");
        assert!(updates.waiting());
        assert_eq!(updates.held_version(), Some("0.1.1"));

        // A refused way out leaves the bytes where they were, so the next clean
        // quit still has them.
        assert!(updates.take_for_install(Leaving::Detached).is_err());
        assert!(updates.waiting());

        let held = updates
            .take_for_install(Leaving::Drained)
            .expect("a drained exit installs");
        assert_eq!(held.version, "0.1.1");
        assert_eq!(held.payload, "the installer bytes");

        // Handed over, once and for ever.
        assert_eq!(updates.stage(), Stage::HandedOver);
        assert_eq!(
            updates.take_for_install(Leaving::Drained).err(),
            Some(Hold::AlreadyHandedOver)
        );
        assert!(!updates.may_check_now(now + CHECK_EVERY * 10));
    }

    #[test]
    fn a_ready_update_stops_the_daily_check() {
        let mut updates: Updates<&str> = Updates::default();
        let start = Instant::now();
        assert!(updates.may_check_now(start));

        updates.note_check_started();
        updates.note_check_done(start);
        assert!(!updates.may_check_now(start + Duration::from_secs(60)));
        assert!(updates.may_check_now(start + CHECK_EVERY));

        updates.note_check_started();
        updates.note_ready(start + CHECK_EVERY, "0.1.1".into(), "bytes");
        assert!(!updates.may_check_now(start + CHECK_EVERY * 5));
    }

    #[test]
    fn a_receipt_does_not_outlive_the_run_that_earned_it() {
        // Without the clearing, a restart's clean drain would vouch for a later
        // run that went quiet, and the install would happen on evidence about a
        // different process.
        let mut updates: Updates<&str> = Updates::default();
        assert!(!updates.drain_confirmed());
        updates.note_core_stopped();
        assert!(updates.drain_confirmed());
        updates.forget_core_stopped();
        assert!(!updates.drain_confirmed());
        assert_eq!(
            leaving(false, false, true, updates.drain_confirmed()),
            Leaving::WentQuiet
        );
    }

    #[test]
    fn the_quit_label_only_promises_an_update_on_the_press_that_delivers_one() {
        let base = || format!("Quit {DISPLAY_NAME}");

        // Nothing waiting: the label is untouched, on every status.
        for status in [
            CoreStatus::Cold,
            CoreStatus::Running,
            CoreStatus::Paused,
            CoreStatus::Backoff,
            CoreStatus::Halted,
        ] {
            assert_eq!(quit_label(base(), false, status), base());
        }

        // Waiting: the press that starts a clean quit says so.
        assert_eq!(
            quit_label(base(), true, CoreStatus::Running),
            "Quit and update Photo Pigeon"
        );

        // And the presses that do not install say nothing new. A drain already
        // running has its own label, and the detach path installs nothing at
        // all, so decorating either would be the menu promising something the
        // process refuses.
        let leaving_label = "Leave, it finishes on its own".to_string();
        assert_eq!(
            quit_label(
                leaving_label.clone(),
                true,
                CoreStatus::Stopping(crate::state::StopIntent::Quit)
            ),
            leaving_label
        );
        assert_eq!(
            quit_label(
                leaving_label.clone(),
                true,
                CoreStatus::Stopping(crate::state::StopIntent::Detach)
            ),
            leaving_label
        );
        assert_eq!(
            quit_label(leaving_label.clone(), true, CoreStatus::Quitting),
            leaving_label
        );
    }

    #[test]
    fn the_only_new_menu_words_carry_no_em_dash_and_are_sentence_case() {
        // The copy law of TRAY-DESIGN section 0, on the one string this module
        // adds to a surface a person reads. `copy-law.test.ts` sweeps this file
        // too, so this is the render-level half of the same rule.
        let label = quit_and_update();
        assert!(!label.contains('\u{2014}'));
        assert!(label.starts_with("Quit "));
        assert!(label.ends_with(DISPLAY_NAME));
        let words: Vec<&str> = label.split(' ').collect();
        assert_eq!(&words[..3], &["Quit", "and", "update"]);
    }

    #[test]
    fn every_refusal_can_say_why_in_one_lowercase_line() {
        for hold in [
            Hold::NothingWaiting,
            Hold::StillAsking,
            Hold::AlreadyHandedOver,
            Hold::EngineRunning,
            Hold::EngineDetached,
            Hold::DrainUnconfirmed,
        ] {
            let why = hold.why();
            assert!(!why.is_empty(), "{hold:?} has nothing to say");
            assert!(!why.contains('\u{2014}'), "em dash in {why:?}");
            assert!(!why.ends_with('.'), "{why:?} is a clause, not a sentence");
            assert!(
                why.chars().next().is_some_and(char::is_lowercase),
                "{why:?} does not read as the tail of a log line"
            );
        }
    }
}
