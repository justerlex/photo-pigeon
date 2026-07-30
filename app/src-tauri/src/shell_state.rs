//! The facts the shell has to remember between launches, and nowhere else to
//! put them.
//!
//! Both are about the shell and not about deliveries, so neither belongs in the
//! core's state directory. TRAY-DESIGN section 0: **only the core process
//! writes to `~/.photo-pigeon`**, and that law does not have an exception for
//! small files. So this is the shell's own file, in the shell's own directory,
//! inside the footprint the uninstaller already owns.
//!
//! What it holds:
//!
//! * **`firstDeliveryToastShown`.** Exactly one happy toast, on the very first
//!   delivery ever, and then never again (TRAY-DESIGN section 3). "Ever" is a
//!   claim across launches, so it needs a disk.
//! * **`autostartDecided`.** Start with Windows is default on, and a default is
//!   applied once. Without this flag, turning it off would be undone by the next
//!   launch, which is not a default, it is a nag.
//! * **`autostartOffChosen`.** Whether an off state is somebody's click or
//!   somebody else's deletion. The two look identical in the registry, and they
//!   want opposite answers: a click is respected forever, and a Run value the
//!   uninstaller took goes back at the next launch.
//!
//! Where it lives: beside the shell's own log. One rule, so
//! `PHOTO_PIGEON_SHELL_LOG` redirects both files at once and a test run can
//! never read or write the flags an installed copy owns.
//!
//! A build running out of a cargo target directory gets a different file name
//! for the same reason the autostart value name is scoped there: the app
//! identifier is shared between a development build and the installed one, so
//! without this a `cargo run` would eat the installed copy's first-delivery
//! toast and answer the autostart question on its behalf.
//!
//! Every failure here is survivable and none of them is worth stopping for. A
//! file that cannot be read is a fresh file; a file that cannot be written
//! means one extra toast some day. Nothing in this module returns an error.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The installed name, and the development name that must never collide with
/// it.
const FILE_NAME: &str = "shell-state.json";
const DEV_FILE_NAME: &str = "shell-state.dev.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Flags {
    // `first_delivery_toast_shown` was here and is gone at M4. Project rule:
    // "first ever" means the ledger was empty before that
    // delivery, which is a fact only the core can know, so the shell stopped
    // keeping its own answer to the same question. The flag was wrong in both
    // directions on the states nobody constructs: a state file lost with a
    // profile made every photo the first one again, and a state file that
    // outlived a deleted ledger made none of them ever again.
    //
    // The file itself stays, because `autostart_decided` is a genuinely
    // shell-owned fact: nothing in the core knows or cares whether somebody has
    // been asked about starting with Windows. An old file carrying the retired
    // key still loads: `#[serde(default)]` on the struct means an unknown
    // member is ignored rather than fatal, so nobody's autostart decision is
    // forgotten by the upgrade.
    /// Has "start with Windows" been decided once, either way?
    autostart_decided: bool,
    /// Did a person turn it off on purpose?
    ///
    /// `autostart_decided` cannot carry this on its own, and the gap is what
    /// made autostart die on a reinstall. The NSIS uninstaller deletes the Run
    /// value by design and spares this file by design, so the relaunched shell
    /// came up with the question settled, nothing in the key, and no way to
    /// tell an uninstaller's wipe from a click. It read the absence as the
    /// click, respected it, and never wrote the value again.
    ///
    /// So the click is written down where the wipe cannot reach it. An absent
    /// value with nothing recorded behind it is a value to write again; an
    /// absent value with this flag set is somebody's choice and stays absent.
    ///
    /// One honest trade, and it is worth naming rather than hiding: a machine
    /// that turned the checkbox off before this flag existed has no click
    /// recorded, so its first launch after the upgrade turns start with Windows
    /// back on once, and the next off click sticks for good. Acceptable because
    /// there is no such machine: 0.1.0 was never published.
    autostart_off_chosen: bool,
}

/// The file, loaded once and written through on every change.
#[derive(Debug)]
pub struct ShellState {
    path: PathBuf,
    flags: Flags,
}

/// The file that goes with a given shell log. Pure, so the rule can be
/// checked against a path that exists on nobody's disk.
pub fn beside_log(log_path: &Path, scoped: bool) -> PathBuf {
    let dir = log_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    dir.join(if scoped { DEV_FILE_NAME } else { FILE_NAME })
}

impl ShellState {
    /// Pick the file that goes with a given shell log, and load it.
    pub fn open_beside_log(log_path: &Path, scoped: bool) -> Self {
        Self::open(beside_log(log_path, scoped))
    }

    pub fn open(path: PathBuf) -> Self {
        let flags = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Flags>(&text).ok())
            .unwrap_or_default();
        Self { path, flags }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn autostart_decided(&self) -> bool {
        self.flags.autostart_decided
    }

    pub fn note_autostart_decided(&mut self) {
        if !self.flags.autostart_decided {
            self.flags.autostart_decided = true;
            self.save();
        }
    }

    pub fn autostart_off_chosen(&self) -> bool {
        self.flags.autostart_off_chosen
    }

    /// Record which way somebody just set the switch.
    ///
    /// Called after a write that landed, never after one that was asked for:
    /// a refused write leaves the registry where it was, and a record of a
    /// choice the machine never took is worse than no record at all.
    pub fn note_autostart_choice(&mut self, on: bool) {
        if self.flags.autostart_off_chosen == !on {
            return;
        }
        self.flags.autostart_off_chosen = !on;
        self.save();
    }

    fn save(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(&self.flags) {
            let _ = std::fs::write(&self.path, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "photo-pigeon-shell-state-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_missing_file_is_a_fresh_start_and_the_flag_is_off() {
        let dir = scratch("fresh");
        let state = ShellState::open(dir.join(FILE_NAME));
        assert!(!state.autostart_decided());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deciding_about_autostart_survives_a_restart_so_off_stays_off() {
        let dir = scratch("autostart");
        let path = dir.join(FILE_NAME);
        let mut state = ShellState::open(path.clone());
        state.note_autostart_decided();
        assert!(ShellState::open(path).autostart_decided());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_is_a_fresh_start_rather_than_a_crash() {
        let dir = scratch("corrupt");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "{ this is not json").expect("write");
        let state = ShellState::open(path.clone());
        assert!(!state.autostart_decided());

        // And it heals: the next write replaces the rubbish.
        let mut state = state;
        state.note_autostart_decided();
        assert!(ShellState::open(path).autostart_decided());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_written_before_the_happy_toast_flag_was_retired_still_loads() {
        // The upgrade path for the flag M4 deleted. A machine that has been
        // running M3 has `firstDeliveryToastShown` in this file and may also
        // have answered the autostart question. Deserializing must ignore the
        // retired key rather than fail, or the upgrade would forget a decision
        // the user really made and ask again.
        let dir = scratch("retired");
        let path = dir.join(FILE_NAME);
        std::fs::write(
            &path,
            r#"{"firstDeliveryToastShown":true,"autostartDecided":true}"#,
        )
        .expect("write");
        let state = ShellState::open(path);
        assert!(state.autostart_decided());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_off_click_is_written_down_and_survives_a_restart() {
        // The half `autostart_decided` cannot carry. Without it an absent Run
        // value reads the same whether a person cleared it or an uninstaller
        // did, and those two want opposite answers.
        let dir = scratch("off-chosen");
        let path = dir.join(FILE_NAME);
        let mut state = ShellState::open(path.clone());
        assert!(!state.autostart_off_chosen());

        state.note_autostart_choice(false);
        assert!(ShellState::open(path.clone()).autostart_off_chosen());

        // And turning it back on clears it, so one off click does not follow
        // somebody around for the life of the install.
        let mut state = ShellState::open(path.clone());
        state.note_autostart_choice(true);
        assert!(!ShellState::open(path).autostart_off_chosen());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_written_before_the_off_click_was_recorded_still_loads() {
        // Every state file that exists predates this flag. A missing member has
        // to read as "nobody has clicked it off", because that is the reading
        // that puts a wiped value back rather than the one that treats an
        // upgraded machine as having chosen off.
        let dir = scratch("no-off-key");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, r#"{"autostartDecided":true}"#).expect("write");
        let state = ShellState::open(path);
        assert!(state.autostart_decided());
        assert!(!state.autostart_off_chosen());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_build_tree_never_reads_or_writes_the_installed_copys_flags() {
        // The whole reason the dev name exists: one identifier, one app log
        // directory, two builds. A cargo run must not answer the autostart
        // question for the installed copy.
        let dir = scratch("scoped");
        let log = dir.join("tray.log");

        let mut installed = ShellState::open_beside_log(&log, false);
        installed.note_autostart_decided();

        let development = ShellState::open_beside_log(&log, true);
        assert_ne!(development.path(), installed.path());
        assert!(!development.autostart_decided());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_state_file_sits_beside_the_log_and_never_in_the_cores_directory() {
        // A path computation only: nothing here opens or creates anything, so
        // it can name the shape an installed copy has without going near one.
        let log = Path::new(
            "C:\\Users\\somebody\\AppData\\Local\\io.github.justerlex.photopigeon\\logs\\tray.log",
        );
        assert_eq!(
            beside_log(log, false),
            Path::new("C:\\Users\\somebody\\AppData\\Local\\io.github.justerlex.photopigeon\\logs\\shell-state.json")
        );
        // TRAY-DESIGN section 0: only the core writes there.
        assert!(!beside_log(log, false).to_string_lossy().contains(".photo-pigeon"));
        assert!(!beside_log(log, true).to_string_lossy().contains(".photo-pigeon"));
    }
}
