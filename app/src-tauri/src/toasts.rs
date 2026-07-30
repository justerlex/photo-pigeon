//! Four toasts, and there is no fifth.
//!
//! TRAY-DESIGN section 3: **only attention states, never per file.** A tool
//! that toasts on every photo gets muted within a day, and then the one toast
//! that mattered is muted too. So the list is closed and it is short:
//!
//! | Toast | When |
//! |---|---|
//! | Sign in needed | `auth-needed`, which is terminal: no respawn will fix it |
//! | Today's limit reached | `paused-quota`, once, with the time it comes back |
//! | It stopped | the shell has given up, or is knocking so slowly it may as well have |
//! | First photo delivered | the very first delivery ever, and then never again |
//!
//! The happy one is the exception that proves the rule: new users need proof
//! the thing works, everybody else needs silence. "Ever" is a claim across
//! launches, so it is spent against a flag in `shell_state.rs` rather than a
//! field in memory.
//!
//! ## Two Windows facts a reader will otherwise trip on
//!
//! **The AppUserModelID is what gives a toast its name and its icon.** It is
//! the `identifier` from `tauri.conf.json`, claimed in `lib.rs` before any of
//! this runs, and it is the Start Menu shortcut the installer writes that makes
//! it resolve to Photo Pigeon rather than to whatever launched the process. M0
//! proved that by accident and it is why section 5 forbids suppressing shortcut
//! creation to look tidy.
//!
//! **Nothing here will appear in `tauri dev`.** The notification plugin only
//! claims the AppUserModelID when the exe is not sitting in `target/debug` or
//! `target/release`, so a toast from a build tree is filed under the launching
//! host. That is the plugin's own rule, read out of its source, and it matches
//! the note in section 1. Do not spend an afternoon on it.
//!
//! ## The name in the title
//!
//! Every title says "Photo Pigeon", the display name, never the package name.
//! Project decision: humans read Photo Pigeon everywhere copy is
//! human facing, and machines keep photo-pigeon.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::state::{short_time, DISPLAY_NAME};

/// Everything that may ever raise a toast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Toast {
    /// Google turned the credentials down. Only a person can fix it.
    AuthNeeded,
    /// The day's request budget is spent.
    QuotaPaused { resumes_at: Option<String> },
    /// The engine is not running and the shell is not about to fix it.
    Stopped { why: StoppedWhy },
    /// The one happy one, on the very first delivery ever.
    FirstDelivery { file: Option<String> },
}

/// Why the engine is not running, in the words that change what a person
/// should do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoppedWhy {
    /// It refused to start. Usually another copy holds the lock.
    Refused(String),
    /// Another process took the lock. There is nothing to restart into.
    LockLost { held_by: Option<u32> },
    /// It fell over and keeps falling over.
    Crashed,
}

impl Toast {
    /// The bold first line. Always names the product, because the toast may be
    /// read hours later in the notification centre next to twenty others.
    pub fn title(&self) -> String {
        match self {
            Toast::AuthNeeded => format!("{DISPLAY_NAME} needs you to sign in"),
            Toast::QuotaPaused { .. } => format!("{DISPLAY_NAME} has hit today's Google limit"),
            Toast::Stopped { .. } => format!("{DISPLAY_NAME} has stopped"),
            Toast::FirstDelivery { .. } => format!("{DISPLAY_NAME} delivered its first photo"),
        }
    }

    /// The sentence under it. Plain English, no jargon, and it says what
    /// happens next rather than what went wrong.
    pub fn body(&self) -> String {
        match self {
            Toast::AuthNeeded => {
                "Google turned it down. Nothing is lost: it picks up where it left off as soon \
                 as you sign in again."
                    .into()
            }
            Toast::QuotaPaused { resumes_at } => match resumes_at {
                Some(when) => format!(
                    "Everything else goes {}. Nothing is lost.",
                    short_time(when)
                ),
                None => "Everything else goes tomorrow. Nothing is lost.".into(),
            },
            Toast::Stopped {
                why: StoppedWhy::Refused(reason),
            } => format!("{} Open the menu to try again.", crate::state::first_sentence(reason)),
            Toast::Stopped {
                why: StoppedWhy::LockLost { held_by: Some(pid) },
            } => format!(
                "Another copy took over this folder set, so this one stopped. It is process {pid}."
            ),
            Toast::Stopped {
                why: StoppedWhy::LockLost { held_by: None },
            } => "Another copy took over this folder set, so this one stopped.".into(),
            Toast::Stopped {
                why: StoppedWhy::Crashed,
            } => "It keeps falling over. Open the menu to start it again.".into(),
            Toast::FirstDelivery { file } => match file {
                Some(name) => format!(
                    "{name} is in Google Photos, at original quality. It counts against your \
                     Google storage."
                ),
                None => "It is in Google Photos, at original quality. It counts against your \
                         Google storage."
                    .into(),
            },
        }
    }
}

/// Raise one, off whatever thread asked for it.
///
/// On its own thread because showing a Windows toast crosses into WinRT and the
/// supervisor loop owns the child process, the timers and the state machine. A
/// toast is rare by construction, so a thread each is cheaper than a queue and
/// it cannot make the engine wait for the notification centre.
pub fn show(app: &AppHandle, toast: &Toast) -> Option<std::thread::JoinHandle<()>> {
    let app = app.clone();
    let title = toast.title();
    let body = toast.body();
    std::thread::Builder::new()
        .name("pigeon-toast".into())
        .spawn(move || {
            let _ = app.notification().builder().title(title).body(body).show();
        })
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<Toast> {
        vec![
            Toast::AuthNeeded,
            Toast::QuotaPaused {
                resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
            },
            Toast::QuotaPaused { resumes_at: None },
            Toast::Stopped {
                why: StoppedWhy::Refused(
                    "another copy is already watching. Process 71608 started at 09:12.".into(),
                ),
            },
            Toast::Stopped {
                why: StoppedWhy::LockLost {
                    held_by: Some(71608),
                },
            },
            Toast::Stopped {
                why: StoppedWhy::LockLost { held_by: None },
            },
            Toast::Stopped {
                why: StoppedWhy::Crashed,
            },
            Toast::FirstDelivery {
                file: Some("IMG_0421.jpg".into()),
            },
            Toast::FirstDelivery { file: None },
        ]
    }

    #[test]
    fn every_title_says_photo_pigeon_and_never_the_package_name() {
        for toast in all() {
            let title = toast.title();
            assert!(
                title.starts_with(DISPLAY_NAME),
                "a toast title that does not name the product: {title:?}"
            );
            assert!(
                !title.contains("photo-pigeon"),
                "the package name reached a human: {title:?}"
            );
            assert!(!toast.body().contains("photo-pigeon"), "{:?}", toast.body());
        }
    }

    #[test]
    fn no_em_dashes_and_nothing_empty() {
        for toast in all() {
            for text in [toast.title(), toast.body()] {
                assert!(!text.contains('\u{2014}'), "em dash in {text:?}");
                assert!(!text.trim().is_empty());
                // A toast is two lines on screen. Anything approaching a
                // paragraph is a window, not a notification.
                assert!(text.chars().count() < 200, "{text:?} is too long for a toast");
            }
        }
    }

    #[test]
    fn the_quota_toast_says_when_it_comes_back() {
        let with = Toast::QuotaPaused {
            resumes_at: Some("2026-07-30T00:00:00.000Z".into()),
        };
        assert!(with.body().contains("at 00:00"), "{:?}", with.body());
        assert!(with.body().contains("Nothing is lost"));

        // And it never invents a time it was not given.
        let without = Toast::QuotaPaused { resumes_at: None };
        assert!(!without.body().contains("at "), "{:?}", without.body());
        assert!(without.body().contains("tomorrow"));
    }

    #[test]
    fn the_lock_lost_toast_offers_no_restart_because_there_is_nothing_to_restart_into() {
        // TRAY-DESIGN section 3 says this one specifically has no restart
        // button: another copy owns the folder set now.
        let toast = Toast::Stopped {
            why: StoppedWhy::LockLost {
                held_by: Some(71608),
            },
        };
        let body = toast.body().to_lowercase();
        assert!(!body.contains("try again"));
        assert!(!body.contains("start it again"));
        assert!(toast.body().contains("71608"));
    }

    #[test]
    fn the_happy_toast_carries_the_storage_law_and_the_file_name() {
        let toast = Toast::FirstDelivery {
            file: Some("IMG_0421.jpg".into()),
        };
        assert!(toast.body().contains("IMG_0421.jpg"));
        // The one place a person is told what "delivered" costs them, at the
        // moment they first see it work. TRAY-DESIGN section 0, storage honesty.
        assert!(toast.body().contains("original quality"));
        assert!(toast.body().contains("Google storage"));
    }

    #[test]
    fn the_refusal_toast_quotes_the_core_rather_than_guessing_which_refusal_it_was() {
        let toast = Toast::Stopped {
            why: StoppedWhy::Refused(
                "the config names a folder that is not there: D:\\Gone. Fix it and try again."
                    .into(),
            ),
        };
        assert!(toast.body().contains("folder that is not there"));
        assert!(!toast.body().contains("Another copy"));
    }
}
