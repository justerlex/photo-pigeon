//! The two windows, created on demand and destroyed on close.
//!
//! M0 measured one static page at **306.70 MB across seven processes** against
//! 9.87 MB for the shell alone. That number is the hardest evidence in
//! TRAY-DESIGN for the no-window-at-idle law, and it is why this module exists
//! rather than a `windows` array in `tauri.conf.json`: a declared window is
//! created at startup and lives forever, and this app must have zero WebView2
//! processes in its tree while it is watching.
//!
//! So: `tauri.conf.json` still says `"windows": []`. Nothing is created until
//! somebody clicks a menu item, and closing really destroys rather than hides.
//! `RunEvent::ExitRequested` already prevents the exit that closing the last
//! window would otherwise cause.
//!
//! ## The frozen page list, and why it is a list
//!
//! [`Page`] is a closed enum of two local files, and window creation cannot
//! take a URL from anywhere else. That is the strongest available form of two
//! laws at once:
//!
//! * **OAuth consent never renders in a `WebviewWindow`.** Google blocks
//!   embedded webviews for OAuth, it is against their policy, and the loopback
//!   flow already works. The core hands the consent URL to the system browser
//!   from its own process, which is where it has always happened. Here the
//!   guarantee is structural: there is no `WebviewUrl::External` anywhere in
//!   this crate and no code path that builds one, so an auth URL has nothing to
//!   arrive on. `no_page_is_a_remote_url` is the test.
//! * **The webview never touches the file system.** `tauri-plugin-fs` *is*
//!   compiled in as of M4, transitively: `tauri-plugin-dialog` depends on it,
//!   and `cargo tree -i tauri-plugin-fs` says so. So the guarantee is not the
//!   absent crate it used to be, and saying otherwise would be a comfortable
//!   sentence that is false. It is the ungranted permission:
//!   `capabilities/default.json` grants no `fs:` permission to any window, and
//!   an ungranted plugin command is unreachable from a page.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// One of the two pages this app can show. Closed on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    /// First run: the five step walk, and the only path that talks to setup.
    Setup,
    /// The main window, and as of the status-window reshape the whole
    /// control surface: status, history, the watched folders one
    /// row each, and the same Pause, Resume and Deliver now the tray menu
    /// carries. The tray item that opens it says "Status and history...", so it
    /// lands on the page with that name on it, and `health.html` is reached by
    /// an ordinary link inside the same window: no second window, no second
    /// label, and nothing new to grant.
    Status,
}

impl Page {
    /// The window label, which is also how a second click finds the first
    /// window instead of building another one.
    pub const fn label(self) -> &'static str {
        match self {
            Page::Setup => "setup",
            Page::Status => "status",
        }
    }

    /// The file inside the bundled frontend. Relative, always.
    pub const fn path(self) -> &'static str {
        match self {
            Page::Setup => "setup.html",
            Page::Status => "status.html",
        }
    }

    /// The window title. Every human surface says Photo Pigeon, and the
    /// status-window reshape asked for title case with the
    /// brand up front.
    ///
    /// The casing law has two tiers and this is the outer one: a **window
    /// title** is branded title case, and everything inside a window (tabs,
    /// buttons, headings) is sentence case. "Photo Pigeon: Status & Health"
    /// became plain "Photo Pigeon: Status" on the second reshape pass, because
    /// the window is one control surface with tabs in it rather than two views
    /// sharing a frame, and a title that lists its own tabs is wrong the day a
    /// third one lands.
    ///
    /// **Navigating between the tabs does not change this title, and that was
    /// read out of the dependencies rather than assumed.** `health.html` is
    /// reached by an ordinary link, so the window shows a second document
    /// without being rebuilt, and the question is whether the OS title follows
    /// the document. It does not:
    /// wry exposes the WebView2 `DocumentTitleChanged` event as an opt-in
    /// handler (`wry` 0.55.1, `webview2/mod.rs`), Tauri surfaces it as an opt-in
    /// builder method that defaults to `None` (`tauri` 2.11.5,
    /// `webview/mod.rs`), and this crate installs no such handler and never
    /// calls `set_title`. So the title is written once, here, at build time.
    /// `both_tabs_of_the_status_window_carry_the_windows_own_title` is the belt
    /// beside that braces: both documents already say the same words, so a build
    /// that did start syncing could not change what a person reads either. That
    /// is also the test that pins the three `<title>` tags in `app/ui` to these
    /// strings, because a title tag and a Rust title are one fact in two files,
    /// and nothing pinned them on the night the old one drifted.
    pub const fn title(self) -> &'static str {
        match self {
            Page::Setup => "Photo Pigeon: Setup",
            Page::Status => "Photo Pigeon: Status",
        }
    }

    /// Logical pixels. Big enough to read a console walkthrough without
    /// scrolling every paragraph.
    pub const fn size(self) -> (f64, f64) {
        match self {
            Page::Setup => (760.0, 720.0),
            Page::Status => (720.0, 680.0),
        }
    }

    /// Every page, for the tests that have to check all of them rather than
    /// the one somebody remembered. Production reaches pages by name, so this
    /// is only ever read by the laws below, and that is the point of it.
    #[allow(dead_code)]
    pub const ALL: [Page; 2] = [Page::Setup, Page::Status];
}

/// Show a page: focus the one that is open, or build it.
///
/// Must run on the main thread. The supervisor reaches it through
/// `run_on_main_thread`, exactly as it does for the tray render.
pub fn show(app: &AppHandle, page: Page) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(page.label()) {
        // Already up. Raise it rather than building a second one: two setup
        // windows would be two sidecars racing for one config folder.
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let (width, height) = page.size();
    let window = WebviewWindowBuilder::new(app, page.label(), WebviewUrl::App(page.path().into()))
        .title(page.title())
        .inner_size(width, height)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        // Where the user is already looking. The M4 default let Windows place
        // the window, which on a desk with three monitors is a window somebody
        // has to go and find.
        .center()
        .visible(true)
        .build()?;

    // Destroyed, never hidden. A hidden window keeps its WebView2 processes
    // alive, which is the whole cost the create-on-demand design exists to
    // avoid, and the M0 table's "returns to the idle figure" row is how a
    // regression here would be caught.
    let label = page.label().to_string();
    window.on_window_event({
        let app = app.clone();
        move |event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                // Closing the first-run window takes the wizard with it. The
                // word is `stop`, which setup already answers, and a cancelled
                // setup has written nothing, so there is no batch to abandon
                // and no half-written config to inherit. Leaving the sidecar
                // running would be a process nobody can see, holding a question
                // nobody can answer.
                if page == Page::Setup {
                    crate::setup_host::stop(&app);
                }
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.destroy();
                }
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_page_is_a_remote_url() {
        // The OAuth law, pinned rather than left to vigilance. It is the law
        // with the worst failure mode in this project and it had no test at
        // all: rendering Google's consent screen in a WebviewWindow is against
        // Google's policy, is blocked by them, and would put the user's
        // password inside this app's process.
        //
        // Every page is a relative file in the bundled frontend. No scheme, no
        // host, no leading slash, nothing that could be an absolute URL. Since
        // `show` is the only way a window is created here and it only ever
        // builds `WebviewUrl::App(page.path())`, an auth URL has no wire to
        // arrive on.
        for page in Page::ALL {
            let path = page.path();
            assert!(!path.contains("://"), "{path} looks like a URL");
            assert!(!path.starts_with('/'), "{path} is not relative");
            assert!(!path.contains("google"), "{path} names Google");
            assert!(path.ends_with(".html"), "{path} is not a page");
        }
    }

    #[test]
    fn every_page_label_is_named_in_the_capability_file() {
        // A capability applies to a window by label. A page whose label is not
        // in that list builds a window with no permissions at all, so its
        // listener never attaches and the page sits there rendering nothing:
        // a failure with no error message, at runtime, on somebody else's
        // machine. The two files are pinned to each other here rather than
        // left to whoever renames a page next.
        let capabilities = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value =
            serde_json::from_str(capabilities).expect("the capability file is JSON");
        let declared: Vec<String> = parsed["windows"]
            .as_array()
            .expect("windows is an array")
            .iter()
            .map(|value| value.as_str().expect("a label").to_string())
            .collect();
        for page in Page::ALL {
            assert!(
                declared.iter().any(|label| label == page.label()),
                "{} is not in capabilities/default.json's windows list: {declared:?}",
                page.label()
            );
        }
        assert_eq!(declared.len(), Page::ALL.len(), "{declared:?}");
    }

    #[test]
    fn the_status_page_is_the_one_the_status_menu_item_names() {
        // The tray item says "Status and history..." and it opened health.html,
        // which is the health tab. Nothing was stranded, because the two pages
        // cross-link in place inside one window, but a menu item that lands on
        // a different page than its label promises is a small lie the first
        // user meets.
        assert_eq!(Page::Status.path(), "status.html");
    }

    #[test]
    fn the_page_list_is_closed_and_labels_are_unique() {
        // A second window under the same label would be Tauri refusing to
        // build; two labels for one page would be two setup sidecars racing for
        // one config folder.
        let labels: Vec<&str> = Page::ALL.iter().map(|page| page.label()).collect();
        assert_eq!(labels.len(), 2);
        assert_ne!(labels[0], labels[1]);
    }

    #[test]
    fn the_status_window_is_called_status_and_nothing_longer() {
        // The status-window reshape: the main window is
        // "Photo Pigeon: Status", not "Status & Health". It is the whole control
        // surface now rather than a pair of read-only views, and a title that
        // lists the tabs inside it goes stale the moment a third one arrives.
        assert_eq!(Page::Status.title(), "Photo Pigeon: Status");
        assert_eq!(Page::Setup.title(), "Photo Pigeon: Setup");
        // The outer tier of the casing law, swept and not spot-checked: every
        // window title is branded title case, and none of them carries an
        // ampersand, which is the shape the old one had in the task switcher.
        for page in Page::ALL {
            let title = page.title();
            assert!(title.starts_with("Photo Pigeon: "), "{title:?}");
            assert!(!title.contains('&'), "{title:?} carries an ampersand");
        }
    }

    #[test]
    fn both_tabs_of_the_status_window_carry_the_windows_own_title() {
        // The tab strip navigates in place, so one OS window shows two
        // documents, and the title a person reads must not change halfway
        // through. The observation this test stands on is recorded on `title`:
        // nothing syncs a document title onto the window here, so the visible
        // title is `title()` and stays there. This is the belt beside it, so
        // that a future build which does sync one cannot change what the user
        // reads either: both documents already say the same words as the
        // window.
        for (page, html) in [
            ("status.html", include_str!("../../ui/status.html")),
            ("health.html", include_str!("../../ui/health.html")),
        ] {
            assert_eq!(title_of(html), Page::Status.title(), "{page}");
        }
        assert_eq!(
            title_of(include_str!("../../ui/setup.html")),
            Page::Setup.title()
        );
    }

    /// The one `<title>` of a page, so a test can compare it with the window's.
    fn title_of(html: &str) -> &str {
        let (_, rest) = html.split_once("<title>").expect("a title tag");
        let (title, _) = rest.split_once("</title>").expect("a closed title tag");
        title
    }

    #[test]
    fn windows_open_centered() {
        // Centering is the one property of
        // window creation that no test on this machine can observe: a window
        // has to exist to have a position, and a window needs a display. So the
        // builder chain is read instead. Weaker than a measurement and stronger
        // than nothing: the M4 default put both windows wherever Windows felt
        // like putting them, which on a multi-monitor desk is a window the user
        // has to go looking for.
        let source = include_str!("windows.rs");
        let chain = source
            .split_once("WebviewWindowBuilder::new")
            .expect("the builder chain")
            .1;
        let chain = chain.split_once(".build()").expect("the built window").0;
        assert!(chain.contains(".center()"), "the builder does not centre");
    }

    #[test]
    fn every_window_title_says_photo_pigeon_and_carries_no_em_dash() {
        // The naming law: humans read "Photo Pigeon" on every surface, and a
        // window title is as human a surface as there is.
        for page in Page::ALL {
            let title = page.title();
            assert!(title.contains("Photo Pigeon"), "{title:?}");
            assert!(!title.contains("photo-pigeon"), "{title:?} uses the machine name");
            assert!(!title.contains('\u{2014}'), "em dash in {title:?}");
        }
    }
}
