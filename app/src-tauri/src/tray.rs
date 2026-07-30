//! The tray icon and its menu: the whole user interface at M3.
//!
//! Menu first, no window. TRAY-DESIGN section 1 makes that a memory law rather
//! than a preference: the M0 spike measured one static page costing 306 MB
//! across seven processes, against 9.87 MB for the shell with nothing open. So
//! there are still no windows at all. There is nothing here to hide or destroy,
//! which is the cheapest way to keep a promise.
//!
//! The menu is the one from TRAY-DESIGN section 3. M3 fills in the two rows M2
//! left out because their stdin words did not exist yet: **Deliver now**, which
//! writes `rescan`, and **Start with Windows**, which is a real checkbox over a
//! real registry value read back on every open. What is still absent is M4's:
//! no setup, no status window, no health window.
//!
//! The checkbox is read from the registry rather than remembered, on startup
//! and again every time the menu opens. A value a cleanup tool removed behind
//! our back shows unticked, which is TRAY-DESIGN section 4's first failure mode
//! answered by never storing an opinion in the first place.
//!
//! Everything that mutates a menu item or the icon runs on the main thread.
//! The supervisor lives on its own thread and posts a [`Render`] across.

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::icons::Icons;
use crate::state::{IconState, DISPLAY_NAME};

/// The tray's own handle, which no user ever sees. A machine identifier, so it
/// keeps the machine name.
pub const TRAY_ID: &str = "photo-pigeon";

pub mod ids {
    pub const STATUS: &str = "status";
    pub const STORAGE: &str = "storage";
    pub const ACTION: &str = "action";
    pub const DELIVER_NOW: &str = "deliver_now";
    pub const OPEN_FOLDER: &str = "open_folder";
    pub const OPEN_LOG: &str = "open_log";
    pub const AUTOSTART: &str = "autostart";
    /// M4: Status and history..., which opens the main window.
    pub const STATUS_WINDOW: &str = "status_window";
    /// M4: Initial setup..., which opens the first-run window.
    ///
    /// It replaces the temporary console path. TRAY-DESIGN section 3 says
    /// option A "must not be in the 1.0 installer's happy path", and this is
    /// the milestone that deletes it rather than relabelling it: with a real
    /// window there is nothing a terminal could do that this cannot.
    pub const SETUP_WINDOW: &str = "setup_window";
    pub const QUIT: &str = "quit";
}

/// The two labels that never change, out here where a test can read them.
///
/// Every other row's text is computed by `state.rs` and arrives on a [`Render`],
/// which is why those have tests and these had none: a string literal inside
/// [`build`] is unreachable without an `AppHandle`. Same argument as
/// [`writes`]: extract the decision rather than leave it unguarded.
pub mod labels {
    /// Opens the main window. Says "history" because that is what the tab it
    /// lands on is called, and the window is the same one either way.
    pub const STATUS_WINDOW: &str = "Status and history...";
    /// Opens first run. **"Initial" is load bearing** as of the status-window
    /// reshape: watched folders can be changed from the status window
    /// now, so this item is the full walk and not the way to edit a setting. It
    /// said "Setup and health..." until then, which named two things and did one
    /// of them: health has been a tab of the status window since M4.
    pub const SETUP_WINDOW: &str = "Initial setup...";
}

/// One complete picture of the tray, computed off the main thread and applied
/// on it. Compared before it is applied, so a quiet watch costs nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Render {
    pub icon: IconState,
    pub status_line: String,
    pub storage_line: String,
    pub tooltip: String,
    pub action_label: String,
    pub action_enabled: bool,
    pub deliver_now_enabled: bool,
    pub quit_label: String,
    pub open_folder_enabled: bool,
    pub open_log_enabled: bool,
    /// What the registry says right now, never what this process would like it
    /// to say.
    pub autostart_checked: bool,
    /// False only where the mechanism itself is unavailable, which is every
    /// platform except Windows in this build.
    pub autostart_enabled: bool,
}

/// The live handles, kept in Tauri's managed state so the main thread can find
/// them again without the supervisor holding anything it should not.
pub struct TrayUi {
    pub icons: Icons,
    status: MenuItem<Wry>,
    storage: MenuItem<Wry>,
    action: MenuItem<Wry>,
    deliver_now: MenuItem<Wry>,
    open_folder: MenuItem<Wry>,
    open_log: MenuItem<Wry>,
    /// Held so the items are not dropped, which would take them off the menu.
    /// Neither label nor enabled state ever changes, so `apply` never touches
    /// them.
    #[allow(dead_code)]
    status_window: MenuItem<Wry>,
    #[allow(dead_code)]
    setup_window: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    quit: MenuItem<Wry>,
    /// What is on screen now, so [`apply`] only touches what actually changed.
    /// Rebuilding an HICON per delivered file is visible as a flicker and is
    /// pure waste on a machine that is busy uploading.
    applied: Mutex<Option<Render>>,
}

/// Build the icon and the menu. Called once, from `setup`, on the main thread.
pub fn build(app: &AppHandle, icons: Icons) -> tauri::Result<TrayIcon<Wry>> {
    let status = MenuItem::with_id(app, ids::STATUS, "Starting up", false, None::<&str>)?;
    let storage = MenuItem::with_id(
        app,
        ids::STORAGE,
        "Nothing sent yet, original quality when it goes",
        false,
        None::<&str>,
    )?;
    let action = MenuItem::with_id(app, ids::ACTION, "Pause", false, None::<&str>)?;
    let deliver_now = MenuItem::with_id(app, ids::DELIVER_NOW, "Deliver now", false, None::<&str>)?;
    let open_folder = MenuItem::with_id(
        app,
        ids::OPEN_FOLDER,
        "Open watched folder",
        false,
        None::<&str>,
    )?;
    let open_log = MenuItem::with_id(app, ids::OPEN_LOG, "Open log", true, None::<&str>)?;
    // Starts unticked and is corrected by the first render, which reads the
    // real value. Guessing here and correcting later would show a tick for a
    // few milliseconds on a machine where it is off, and the whole point of
    // this item is that it never claims anything the registry does not say.
    let autostart = CheckMenuItem::with_id(
        app,
        ids::AUTOSTART,
        "Start with Windows",
        true,
        false,
        None::<&str>,
    )?;
    // The two windows. Enabled always: a machine with no config at all is
    // exactly the machine that needs Setup, and a health check is worth reading
    // when nothing is running as much as when something is.
    let status_window = MenuItem::with_id(
        app,
        ids::STATUS_WINDOW,
        labels::STATUS_WINDOW,
        true,
        None::<&str>,
    )?;
    let setup_window = MenuItem::with_id(
        app,
        ids::SETUP_WINDOW,
        labels::SETUP_WINDOW,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        ids::QUIT,
        format!("Quit {DISPLAY_NAME}"),
        true,
        None::<&str>,
    )?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &storage,
            &PredefinedMenuItem::separator(app)?,
            &action,
            &deliver_now,
            &PredefinedMenuItem::separator(app)?,
            &open_folder,
            &open_log,
            &status_window,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &setup_window,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let start_icon = icons.for_state(IconState::Idle).clone();

    app.manage(TrayUi {
        icons,
        status,
        storage,
        action,
        deliver_now,
        open_folder,
        open_log,
        status_window,
        setup_window,
        autostart,
        quit,
        applied: Mutex::new(None),
    });

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(start_icon)
        .tooltip(format!("{DISPLAY_NAME}: starting up"))
        .menu(&menu)
        // A left click opens the status window (the status-window reshape:
        // the ready-to-use UI should not hide behind a menu
        // item). The menu stays on the right button, which is where Windows
        // puts it anyway; lib.rs owns the click handler.
        .show_menu_on_left_click(false)
        .build(app)
}

/// Push one render onto the tray, touching only what changed. Main thread only.
///
/// One row is written on every render rather than only when it changes, and
/// [`writes`] is where that lives and why.
pub fn apply(app: &AppHandle, render: &Render) {
    let Some(ui) = app.try_state::<TrayUi>() else {
        return;
    };
    let Ok(mut applied) = ui.applied.lock() else {
        return;
    };
    let previous = applied.as_ref();

    if writes(previous, render).autostart_checked {
        let _ = ui.autostart.set_checked(render.autostart_checked);
    }

    if changed(previous, |p| &p.status_line, &render.status_line) {
        let _ = ui.status.set_text(&render.status_line);
    }
    if changed(previous, |p| &p.storage_line, &render.storage_line) {
        let _ = ui.storage.set_text(&render.storage_line);
    }
    if changed(previous, |p| &p.action_label, &render.action_label) {
        let _ = ui.action.set_text(&render.action_label);
    }
    if changed(previous, |p| &p.action_enabled, &render.action_enabled) {
        let _ = ui.action.set_enabled(render.action_enabled);
    }
    if changed(previous, |p| &p.deliver_now_enabled, &render.deliver_now_enabled) {
        let _ = ui.deliver_now.set_enabled(render.deliver_now_enabled);
    }
    if changed(previous, |p| &p.open_folder_enabled, &render.open_folder_enabled) {
        let _ = ui.open_folder.set_enabled(render.open_folder_enabled);
    }
    if changed(previous, |p| &p.open_log_enabled, &render.open_log_enabled) {
        let _ = ui.open_log.set_enabled(render.open_log_enabled);
    }
    if changed(previous, |p| &p.autostart_enabled, &render.autostart_enabled) {
        let _ = ui.autostart.set_enabled(render.autostart_enabled);
    }
    if changed(previous, |p| &p.quit_label, &render.quit_label) {
        let _ = ui.quit.set_text(&render.quit_label);
    }

    let icon_changed = changed(previous, |p| &p.icon, &render.icon);
    let tooltip_changed = changed(previous, |p| &p.tooltip, &render.tooltip);
    if icon_changed || tooltip_changed {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            if icon_changed {
                let _ = tray.set_icon(Some(ui.icons.for_state(render.icon).clone()));
            }
            if tooltip_changed {
                let _ = tray.set_tooltip(Some(&render.tooltip));
            }
        }
    }

    *applied = Some(render.clone());
}

fn changed<T: PartialEq>(
    previous: Option<&Render>,
    field: impl Fn(&Render) -> &T,
    now: &T,
) -> bool {
    previous.map(|p| field(p) != now).unwrap_or(true)
}

/// Which of the rows that cannot be compared away have to be written.
///
/// There is one of them, and it is pure and named so the rule can be tested
/// without an `AppHandle`, which is why the M3 review found this hole with no
/// test standing in front of it.
///
/// **The tick is written on every render.** Every other row in [`apply`] is
/// this function's alone: nothing but `apply` can change the text of a menu
/// item, so what was last written is a true picture of what is on screen, and
/// skipping the unchanged ones is free. The check item is not ours alone. muda
/// flips the tick the moment it is clicked, on screen, before any of this code
/// runs. So between a click and the next render the tick shows what the user
/// asked for rather than what the registry says, and when the write fails, the
/// registry ends exactly where it started: the computed render equals the
/// applied one on this field, and a "nothing changed" gate preserves precisely
/// the lie the read-back exists to correct. The single failure the whole
/// mechanism was written for is not the one it may sleep through.
///
/// The supervisor forges a difference in its own cache after a toggle so that a
/// render is posted at all. Both halves are needed and neither is enough: that
/// one gets a render here, this one gets the tick onto the item.
///
/// Cost: one win32 call per render, and a render only happens when something
/// else changed anyway.
fn writes(_previous: Option<&Render>, _render: &Render) -> Writes {
    Writes {
        autostart_checked: true,
    }
}

/// What [`writes`] decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Writes {
    autostart_checked: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::IconState;

    fn render() -> Render {
        Render {
            icon: IconState::Idle,
            status_line: "Watching 1 folder".into(),
            storage_line: "Nothing sent yet, original quality when it goes".into(),
            tooltip: "Photo Pigeon: watching".into(),
            action_label: "Pause".into(),
            action_enabled: true,
            deliver_now_enabled: true,
            quit_label: "Quit Photo Pigeon".into(),
            open_folder_enabled: true,
            open_log_enabled: true,
            autostart_checked: true,
            autostart_enabled: true,
        }
    }

    #[test]
    fn the_tick_is_written_even_when_nothing_about_it_changed() {
        // The M3 review's third critical, reduced to the one assertion that
        // fails against the old code. A toggle whose registry write failed
        // produces a render identical to the applied one on this field, and the
        // item is sitting on the value muda flipped it to when it was clicked.
        // If this render can be compared away, the checkbox reports the
        // opposite of the registry until something else happens to change.
        let same = render();
        assert!(writes(Some(&same), &same).autostart_checked);
        assert!(writes(None, &same).autostart_checked);

        // And it holds in both directions, because a failed disable strands the
        // tick on exactly the same argument as a failed enable.
        let mut off = render();
        off.autostart_checked = false;
        assert!(writes(Some(&off), &off).autostart_checked);
    }

    #[test]
    fn the_setup_item_says_initial_setup_and_keeps_its_frozen_id() {
        // The status-window reshape. "Setup and health..." named
        // two things and did one of them: health has been a tab of the status
        // window since M4, so the label promised a door that is not there.
        // "Initial setup..." says which setup it is, which matters now that
        // watched folders can be changed from the status window.
        assert_eq!(labels::SETUP_WINDOW, "Initial setup...");
        // The id is a machine identifier, frozen: `lib.rs` matches on it and a
        // rename would silently route the click to the unhandled arm.
        assert_eq!(ids::SETUP_WINDOW, "setup_window");
        assert_eq!(ids::STATUS_WINDOW, "status_window");
    }

    #[test]
    fn the_static_labels_are_sentence_case_and_carry_no_em_dash() {
        // The copy law on the two rows nothing else checks: `state.rs` owns the
        // labels that change and has its own sweep, and these two are string
        // literals that no test could reach while they lived inside `build`.
        for label in [labels::STATUS_WINDOW, labels::SETUP_WINDOW] {
            assert!(!label.contains('\u{2014}'), "em dash in {label:?}");
            assert!(
                label.ends_with("..."),
                "{label:?} opens a window and should say so"
            );
            let rest = &label[1..label.len() - 3];
            assert_eq!(rest, rest.to_lowercase(), "{label:?} is not sentence case");
        }
    }

    #[test]
    fn the_ordinary_rows_are_still_compared_away() {
        // The other half of the bargain, and the reason this is not just
        // "write everything every time": rebuilding an HICON per delivered file
        // is a visible flicker on a machine that is busy uploading.
        let same = render();
        assert!(!changed(Some(&same), |p| &p.status_line, &same.status_line));
        assert!(!changed(Some(&same), |p| &p.icon, &same.icon));
        assert!(changed(None, |p| &p.status_line, &same.status_line));

        let mut busy = render();
        busy.icon = IconState::Delivering;
        assert!(changed(Some(&same), |p| &p.icon, &busy.icon));
    }
}
