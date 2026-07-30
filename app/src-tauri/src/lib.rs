//! photo-pigeon tray shell, M3: it survives a reboot and it tells you when it
//! needs you.
//!
//! What this milestone was, in current terms: start with Windows (driven
//! through `auto-launch` directly), default on, with the visible line, plus the
//! boot flag and the stale-path re-assertion. Attention states wired to
//! `auth-needed`, `paused` with `reason: "quota"` and child exit. The three
//! attention toasts plus the single first-delivery toast. Deliver now.
//! Core-side real pause replacing stop-and-respawn.
//!
//! So this file wires six things: the icons, the tray, the notification plugin,
//! the Run value, the supervisor thread, and the exit rule that keeps a
//! windowless app alive.
//!
//! ## The two decisions in here that a reader will want the reason for
//!
//! **`tauri-plugin-autostart` is gone and `auto-launch` is used directly.** Not
//! a preference. The plugin cannot write a quoted Run value and no published
//! version can, which is the blocker note at the end of TRAY-DESIGN section
//! 6's M3, and `autostart.rs` carries the full read. The plugin's only
//! contribution was three IPC commands that `capabilities/default.json`
//! deliberately never exposed, because every privileged action in this app runs
//! in Rust off a tray click.
//!
//! **The display name is "Photo Pigeon" and the machine name is
//! photo-pigeon.** Project decision. Everything a person reads says
//! Photo Pigeon: productName, the installer, the Start Menu entry, the tooltip,
//! the toasts, the menu. Everything a machine reads stays photo-pigeon: the npm
//! name, `photo-pigeon.exe`, the bundle identifier, `~/.photo-pigeon`, and the
//! CLI's own banner, on the grounds that a terminal product may keep its
//! terminal name.
//!
//! ## What is still deliberately absent
//!
//! * **No windows.** None are created and none are declared. The M0 spike
//!   measured one static page at 306 MB across seven processes against 9.87 MB
//!   for the shell alone, which is why "no window at idle" is a law rather
//!   than tidiness. M4 builds the first one, on demand, destroyed on close.
//! * **No shell plugin.** The core is spawned with `std::process::Command`
//!   from Rust, so nothing at all is exposed to a webview, which is a stronger
//!   guarantee than a scoped `shell:allow-execute` and costs a dependency
//!   less.
//! * **No setup and no health window.** Both are M4.

mod autostart;
mod events;
mod icons;
mod ipc;
mod paths;
mod setup_host;
mod shell_log;
mod shell_state;
mod state;
mod supervisor;
mod toasts;
mod tray;
mod updater;
mod windows;

use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent};

use setup_host::SetupHost;
use shell_log::ShellLog;
use shell_state::ShellState;
use supervisor::{SupervisorHandle, UiCommand};
use windows::Page;

/// Windows attributes a toast to whichever AppUserModelID the process claims,
/// and the Start Menu shortcut the installer writes is what makes ours resolve
/// to Photo Pigeon rather than to the launching host.
///
/// It has to happen before the notification plugin is used, which is why it is
/// the first thing `setup` does. M0 settled it by accident and the accident is
/// worth keeping: a toast from the uninstalled binary was filed under "Windows
/// PowerShell", the launching host, while the installed one was filed under the
/// product. That is why TRAY-DESIGN section 5 forbids suppressing shortcut
/// creation to look tidy.
#[cfg(windows)]
fn claim_app_user_model_id(id: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = OsStr::new(id)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a NUL terminated UTF-16 buffer that outlives the call.
    unsafe {
        windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

#[cfg(not(windows))]
fn claim_app_user_model_id(_id: &str) {}

/// The shell's own log lives in the app log directory rather than beside the
/// core's, because the core's path arrives in the `started` event and the runs
/// most worth logging are the ones that never get there.
fn shell_log_path(app: &AppHandle) -> std::path::PathBuf {
    if let Ok(explicit) = std::env::var(paths::env_names::SHELL_LOG) {
        if !explicit.trim().is_empty() {
            return std::path::PathBuf::from(explicit);
        }
    }
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("photo-pigeon"))
        .join("tray.log")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // M4's one new plugin. The first-run window needs a native folder
        // picker and a webview cannot draw one without file system access,
        // which section 0 forbids. Reachable from `ipc::pick_folder` and from
        // nowhere else: the capability file grants the page no `dialog:*`.
        .plugin(tauri_plugin_dialog::init())
        // The four toasts of TRAY-DESIGN section 3, and nothing more: the
        // capability file grants the webview none of this plugin's commands,
        // so the only thing that can raise one is `toasts.rs` off a core event.
        .plugin(tauri_plugin_notification::init())
        // M5's one new plugin, and the update policy is why it is here
        // at all: Google moves furniture, and a background uploader that cannot
        // be patched is a liability. Section 5 names this plugin specifically,
        // correcting an earlier draft that named an Electron tool for a job
        // that no longer has an Electron in it.
        //
        // `Builder::new()` and nothing else: the endpoint, the public key and
        // the passive install mode all come from `plugins.updater` in
        // tauri.conf.json, which is the one place they can be read back off a
        // shipped build. Nothing is configured in code that a user could not
        // verify by opening the installer.
        //
        // The plugin ships four IPC commands (check, download, install,
        // downloadAndInstall) and `capabilities/default.json` grants a webview
        // none of them, which is the same shape every other privileged thing in
        // this app has. `install` in particular replaces this process and starts
        // an installer, so a page that could reach it could restart the machine's
        // uploader at will. The policy lives in `updater.rs` and the only call
        // site is the quit path in `supervisor.rs`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The fourteen commands of the IPC contract, and nothing else. Every
        // one of them is a Rust function that decides for itself: no plugin
        // command is exposed to any webview, so this list is the complete set
        // of privileged things a page can ask for. The last four arrived with
        // the status-window reshape, which makes the status window a
        // control surface and lets it edit the watched list; `ipc.rs` carries
        // the written reason for each.
        .invoke_handler(tauri::generate_handler![
            ipc::setup_start,
            ipc::setup_answer,
            ipc::pick_folder,
            ipc::doctor_report,
            ipc::status_snapshot,
            ipc::autostart_get,
            ipc::autostart_set,
            ipc::open_path,
            ipc::open_watched,
            ipc::finish_setup,
            ipc::open_setup,
            ipc::engine_action,
            ipc::add_watched_folder,
            ipc::remove_watched_folder,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            claim_app_user_model_id(&app.config().identifier);

            let log_path = shell_log_path(&handle);
            let log = Arc::new(ShellLog::open(log_path.clone()));
            log.line(&format!(
                "photo-pigeon tray {} starting, pid {}",
                app.package_info().version,
                std::process::id()
            ));

            // `package_info().name` is productName, which is also the name the
            // NSIS uninstaller deletes out of the Run key and the name of the
            // install directory. One string, three places, so it is read from
            // the one that owns it rather than written down again here.
            let product = app.package_info().name.clone();
            let scoped = paths::running_from_build_dir();
            let autostart = autostart::Autostart::resolve(&product);
            let shell_state = ShellState::open_beside_log(&log_path, scoped);
            log.line(&format!(
                "display name {product:?}, shell state {}",
                shell_state.path().display()
            ));

            // The setup sidecar's home. Empty until somebody opens first run,
            // and it holds at most one child: two wizards writing one config
            // folder is the failure this refuses by name.
            app.manage(SetupHost::new());
            app.manage(log.clone());

            let icons = match icons::Icons::build() {
                Ok(icons) => icons,
                Err(why) => {
                    log.line(&format!("icons failed to build: {why}"));
                    return Err(why.into());
                }
            };

            // The tray is built before the supervisor starts, on purpose. The
            // supervisor renders as soon as it has a state, and a render that
            // lands before TrayUi is managed would be dropped while the
            // supervisor still recorded it as sent, leaving a quiet watch
            // showing "Starting up" forever.
            let tray = tray::build(&handle, icons)?;
            app.manage(supervisor::start(
                handle.clone(),
                log.clone(),
                autostart,
                shell_state,
            ));

            tray.on_menu_event(move |app, event| {
                let Some(supervisor) = app.try_state::<SupervisorHandle>() else {
                    return;
                };
                match event.id().as_ref() {
                    tray::ids::ACTION => supervisor.send(UiCommand::Action),
                    tray::ids::DELIVER_NOW => supervisor.send(UiCommand::DeliverNow),
                    tray::ids::OPEN_LOG => supervisor.send(UiCommand::OpenLog),
                    tray::ids::OPEN_FOLDER => supervisor.send(UiCommand::OpenWatchedFolder),
                    // The tick that Tauri has already flipped on screen is not
                    // the answer. The supervisor reads the registry, does the
                    // write, reads it back, and the next render corrects the
                    // item if the two disagree.
                    tray::ids::AUTOSTART => supervisor.send(UiCommand::ToggleAutostart),
                    // The two windows M4 builds. Created on demand and
                    // destroyed on close, never declared in tauri.conf.json:
                    // a declared window exists at startup and lives forever,
                    // and M0 measured one static page at 306 MB across seven
                    // processes against 9.87 MB for the shell alone.
                    tray::ids::STATUS_WINDOW => supervisor.send(UiCommand::ShowWindow(Page::Status)),
                    tray::ids::SETUP_WINDOW => supervisor.send(UiCommand::ShowWindow(Page::Setup)),
                    tray::ids::QUIT => supervisor.send(UiCommand::Quit),
                    // The status and storage lines are disabled and cannot be
                    // clicked. Anything else is a menu item somebody added
                    // without wiring it, which is worth a line in the log.
                    other => log.line(&format!("unhandled menu id: {other}")),
                }
            });
            tray.on_tray_icon_event(|tray, event| {
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                // Any click is how a user says they have looked. It clears the
                // failure flavour of the attention state and nothing else:
                // auth and lock clear only when they are fixed.
                if let TrayIconEvent::Click {
                    button_state: MouseButtonState::Down,
                    ..
                } = event
                {
                    if let Some(supervisor) = tray.app_handle().try_state::<SupervisorHandle>() {
                        supervisor.send(UiCommand::MenuOpened);
                    }
                }
                // A left click opens the status window, per the
                // status-window reshape: the tray icon's first job is showing the UI,
                // and the menu lives on the right button. Fires on Up, so a
                // press-and-drag of the icon does not spawn a window.
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if let Some(supervisor) = tray.app_handle().try_state::<SupervisorHandle>() {
                        supervisor.send(UiCommand::ShowWindow(Page::Status));
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the photo-pigeon tray shell")
        .run(|_app, event| {
            // A tray first app has no windows, so nothing should be able to
            // ask it to exit except an explicit app.exit, which carries a code.
            if let RunEvent::ExitRequested { code, api, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
