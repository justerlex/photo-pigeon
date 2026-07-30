//! Start with Windows: one HKCU Run value, written correctly.
//!
//! Default on, one visible line saying so, one click to turn it off. The start
//! with Windows rule in TRAY-DESIGN section 8, and the reason it is a default
//! rather than a question is that a backup tool which does not run is not a
//! backup tool.
//!
//! ## Why this is not `tauri-plugin-autostart`
//!
//! The plugin cannot write a correct value and no published version can. The
//! blocker note at the end of TRAY-DESIGN section 6's M3 records the read that
//! settled it: `tauri-plugin-autostart` 2.5.1 computes the path itself inside
//! its own `setup` (`set_app_path(&current_exe()?.display().to_string())`) and
//! exposes nothing that influences it, while `auto-launch` 0.5.0 underneath
//! writes `format!("{app_path} {args}")` into the key. **`auto-launch` 0.6.0
//! writes the identical line**, so this is not a stale dependency waiting for a
//! bump. The quotes have to wrap the path, and under the plugin the path is not
//! ours to supply.
//!
//! Unquoted, Windows parses
//! `C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe --autostart`
//! left to right, looks for `C:\Users\John.exe`, finds nothing, and boot
//! silently does nothing at all. The user sees a backup tool that quietly
//! stopped backing up.
//!
//! **That case stopped being somebody else's problem at M3.** The install
//! directory is `$LOCALAPPDATA\${PRODUCTNAME}` in Tauri's NSIS template, and
//! productName is now the display name "Photo Pigeon". So every install
//! directory contains a space, on every machine, whatever the account is
//! called. What was a bug for a large minority is now a bug for everyone, and
//! the whole fix is the two quotes in [`Autostart::value_data`].
//!
//! So this module takes option A from the blocker note: drive `auto-launch`
//! directly with the quotes baked into the path it is handed. Pinned to 0.5,
//! never 0.6, whose `WindowsEnableMode::Dynamic` default tries `HKEY_LOCAL_MACHINE`
//! first and falls back to the user hive on access denied, which is the
//! opposite of this project's no-elevation rule. Nothing new is fetched or
//! compiled: `auto-launch` 0.5.0 was already in `Cargo.lock` as the plugin's
//! own dependency.
//!
//! What the plugin contributed and is not missed: three IPC commands.
//! `capabilities/default.json` deliberately exposed none of them, because every
//! privileged action in this app runs in Rust off a tray click.
//!
//! ## The exact registry shape
//!
//! ```text
//! Key    HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
//! Name   Photo Pigeon        productName, which is also package_info().name
//! Type   REG_SZ              not REG_EXPAND_SZ, so the path is already expanded
//! Data   "C:\Users\John Smith\AppData\Local\Photo Pigeon\photo-pigeon.exe" --autostart
//!        quotes wrap the path only, arguments sit outside the closing quote
//!
//! Key    HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run
//! Name   Photo Pigeon
//! Type   REG_BINARY
//! Data   02 00 00 00 00 00 00 00 00 00 00 00   enabled
//!        03 .. plus a non zero 8 byte FILETIME  switched off in Task Manager
//! ```
//!
//! **The value name must equal productName exactly**, and that is a hard
//! constraint rather than a convention: Tauri's NSIS uninstaller runs
//! `DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"`.
//! A value under any other name survives the uninstall, points at a deleted
//! exe forever, and boot quietly fails on a machine where the app is no longer
//! installed. Read out of the generated `installer.nsi` rather than assumed.
//!
//! ## The rail that keeps a build off this machine's real Run value
//!
//! A production tray is installed on the machine this code is written on. A
//! development build that helpfully turned autostart on by default would write
//! a Run value pointing into a working tree, and that value would start a
//! *development* build at the next login, against the production config, which
//! is the one thing nothing here may ever do.
//!
//! So the rail is on the *unasked* case rather than on writing at all: a build
//! running out of a cargo target directory, with nobody having said otherwise,
//! never turns autostart on for anybody. Setting `PHOTO_PIGEON_AUTOSTART_NAME`
//! moves the value name aside and lifts the rail, which is what a test wants,
//! because a default nobody can watch fire is a default nobody has tested. See
//! [`NameScope`].

use std::path::PathBuf;
#[cfg(test)]
use std::path::Path;

use crate::paths::{env_names, running_from_build_dir};

/// The single boot flag, settled here because two words were in the document
/// and only one can be the word the boot path parses.
///
/// TRAY-DESIGN section 4's example passed `--hidden` and the M0 spike's
/// `lib.rs` passed `--autostart`, and section 6's M3 note says M3 has to settle
/// it. It is `--autostart`, for a reason rather than a coin toss:
///
/// * There is no window at any launch, so there is nothing for `--hidden` to
///   hide. The word would describe an effect the app cannot have, and a flag
///   that lies is worse than no flag.
/// * What the marker is actually for, in section 4's own words, is "this launch
///   came from the Run key". `--autostart` says that and `--hidden` does not.
/// * It is the word already written into the value data by every build so far,
///   so no machine carrying an old value needs anything rewritten.
///
/// Nothing branches on it yet by design: a boot launch and a hand launch do the
/// same thing, because the app has no splash to suppress and no window to skip.
/// It is parsed and recorded so the log can say where a run came from, and so
/// the value data has the shape section 4 describes.
pub const BOOT_FLAG: &str = "--autostart";

/// Where the Run value name came from, and therefore what may be done with it.
///
/// The distinction that matters is not "is this the real name" but **"did
/// somebody choose this name on purpose"**. A test that moves the name aside
/// and then watches the shell write one is doing exactly what it should, and
/// refusing to write for it would make the default-on behaviour unobservable,
/// which is the same as untested. What must never happen is the *unasked* case:
/// a build run out of a working tree, with nobody having said anything, quietly
/// writing the shipped value so that the next login starts a development build
/// against the production config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameScope {
    /// The product's own name. The value an installed copy owns and the one the
    /// NSIS uninstaller deletes.
    Shipped,
    /// A name a test asked for by setting `PHOTO_PIGEON_AUTOSTART_NAME`. It may
    /// be written freely, because being written is the whole reason it exists,
    /// and it cannot collide with the shipped value by construction.
    Chosen,
    /// A build tree's name, chosen by nobody. Never turned on without a click.
    /// This is the branch that keeps a `cargo run` off a real machine's login.
    BuildTree,
}

impl NameScope {
    /// May this name be written without a person clicking anything?
    fn may_default_on(&self) -> bool {
        match self {
            NameScope::Shipped | NameScope::Chosen => true,
            NameScope::BuildTree => false,
        }
    }
}

/// What the re-assertion found. TRAY-DESIGN section 4's second failure mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reassert {
    /// Not switched on, so there is nothing to keep true.
    Off,
    /// The recorded value already points at this exe, quoted.
    Correct,
    /// It pointed somewhere else and has been rewritten. Carries what was there.
    Rewritten(String),
    /// It pointed somewhere else and could not be rewritten.
    Failed(String),
}

/// The Run value this build is allowed to touch.
#[derive(Debug, Clone)]
pub struct Autostart {
    name: String,
    exe: PathBuf,
    scope: NameScope,
}

impl Autostart {
    /// Work out the value name and the target, once, at startup.
    pub fn resolve(product_name: &str) -> Self {
        let exe = std::env::current_exe().unwrap_or_default();
        let (name, scope) = match std::env::var(env_names::AUTOSTART_NAME) {
            Ok(explicit) if !explicit.trim().is_empty() => {
                (explicit.trim().to_string(), NameScope::Chosen)
            }
            _ if running_from_build_dir() => {
                (format!("{product_name} (dev)"), NameScope::BuildTree)
            }
            _ => (product_name.to_string(), NameScope::Shipped),
        };
        Self { name, exe, scope }
    }

    /// For tests, and for nothing else: an instance pointed at a name and an
    /// exe of the caller's choosing.
    #[cfg(test)]
    fn scoped(name: &str, exe: &Path) -> Self {
        Self {
            name: name.to_string(),
            exe: exe.to_path_buf(),
            scope: NameScope::Chosen,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn scope(&self) -> &NameScope {
        &self.scope
    }

    /// Exactly what belongs in the value, and the entire fix is the two quotes.
    ///
    /// `auto-launch` writes `format!("{app_path} {args}")`, so handing it a
    /// pre-quoted path puts the quotes around the path and leaves the argument
    /// outside the closing quote, which is what Windows needs and what a hand
    /// repair of a broken machine should produce.
    pub fn value_data(&self) -> String {
        format!("\"{}\" {BOOT_FLAG}", self.exe.display())
    }

    /// The path with the quotes on, which is the form `auto-launch` is given.
    fn quoted_exe(&self) -> String {
        format!("\"{}\"", self.exe.display())
    }

    /// Is the checkbox ticked, according to the registry rather than to
    /// anything this process remembers?
    ///
    /// Both halves have to agree: the Run value has to exist, and Task Manager's
    /// Startup tab must not have switched it off. `auto-launch` reads the second
    /// half as "the last eight bytes of the StartupApproved record are zero",
    /// which is what Windows writes when the user turns it back on.
    pub fn is_enabled(&self) -> bool {
        self.driver()
            .and_then(|driver| driver.is_enabled().ok())
            .unwrap_or(false)
    }

    /// Turn it on, then read the raw value back and check that what landed is
    /// what was meant.
    ///
    /// The read-back is not belt and braces. It is the only runtime evidence
    /// that the quoting fix is in force, and it is cheap.
    pub fn enable(&self) -> Result<(), String> {
        let driver = self.driver().ok_or_else(|| self.unsupported())?;
        driver.enable().map_err(|err| format!("{err}"))?;
        match recorded_value(&self.name) {
            Some(landed) if landed == self.value_data() => Ok(()),
            Some(landed) => Err(format!(
                "the Run value was written but reads back as {landed:?} instead of {:?}",
                self.value_data()
            )),
            None => Err("the Run value was written and is not there when read back".into()),
        }
    }

    /// Turn it off. A value that is already gone is not a failure: somebody
    /// else removing it is one of the two failure modes section 4 names, and
    /// the honest answer to it is a clear checkbox rather than an error.
    pub fn disable(&self) -> Result<(), String> {
        let driver = self.driver().ok_or_else(|| self.unsupported())?;
        if recorded_value(&self.name).is_none() {
            return Ok(());
        }
        driver.disable().map_err(|err| format!("{err}"))?;
        match recorded_value(&self.name) {
            None => Ok(()),
            Some(left) => Err(format!("the Run value is still there, reading {left:?}")),
        }
    }

    /// TRAY-DESIGN section 4's second failure mode: the value records the exe
    /// path as it was when autostart was enabled, so a reinstall somewhere else
    /// leaves it pointing at nothing and boot silently fails.
    ///
    /// `is_enabled()` never compares anything (it only asks whether the value
    /// exists), so this comparison is ours to write. It runs on every launch.
    ///
    /// One case is deliberately left alone: a value that exists but which the
    /// user switched off in Task Manager. Rewriting it through `auto-launch`
    /// would set the StartupApproved record back to enabled, so repairing the
    /// path would silently undo the user's off switch. An off switch outranks a
    /// stale path, so a value that is off stays exactly as it is.
    pub fn reassert(&self) -> Reassert {
        if !self.is_enabled() {
            return Reassert::Off;
        }
        let want = self.value_data();
        match recorded_value(&self.name) {
            Some(current) if current == want => Reassert::Correct,
            Some(current) => match self.enable() {
                Ok(()) => Reassert::Rewritten(current),
                Err(why) => Reassert::Failed(why),
            },
            // is_enabled() said yes, so this is a race with something else
            // editing the key. Writing it is the right answer either way.
            None => match self.enable() {
                Ok(()) => Reassert::Rewritten(String::new()),
                Err(why) => Reassert::Failed(why),
            },
        }
    }

    /// May this build turn autostart on without anybody asking for it?
    ///
    /// Under the shipped name, which is where the default belongs, and
    /// under a name a test deliberately moved aside, which is the only way that
    /// default is ever observed. Never under a build tree's own name, because
    /// nobody chose it and the value it would write starts a development build
    /// at the next login, against the production config.
    pub fn may_default_on(&self) -> bool {
        self.scope.may_default_on() && !self.exe.as_os_str().is_empty()
    }

    #[cfg(windows)]
    fn driver(&self) -> Option<auto_launch::AutoLaunch> {
        Some(auto_launch::AutoLaunch::new(
            &self.name,
            &self.quoted_exe(),
            &[BOOT_FLAG],
        ))
    }

    #[cfg(not(windows))]
    fn driver(&self) -> Option<auto_launch::AutoLaunch> {
        let _ = self.quoted_exe();
        None
    }

    fn unsupported(&self) -> String {
        "start with Windows is only wired for Windows in this build".into()
    }
}

/// Read the raw `REG_SZ` back out of the Run key.
///
/// `auto-launch` has no reader, so this is the one place the shell talks to the
/// registry itself. `windows-sys` is already a dependency for the
/// AppUserModelID call, so this is one feature flag rather than a crate.
#[cfg(windows)]
pub fn recorded_value(name: &str) -> Option<String> {
    use std::ptr;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    let key = wide(RUN_KEY);
    let value = wide(name);

    // Once for the size, once for the bytes. The first call writes the byte
    // count including the terminator.
    let mut bytes: u32 = 0;
    // SAFETY: both strings are NUL terminated and outlive the call; passing a
    // null data pointer with a zero length is the documented way to ask for the
    // size.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut bytes,
        )
    };
    if status != 0 || bytes == 0 {
        return None;
    }

    let mut buffer: Vec<u16> = vec![0; (bytes as usize).div_ceil(2) + 1];
    let mut size = (buffer.len() * 2) as u32;
    // SAFETY: `buffer` has `size` bytes of room and is not aliased.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }

    let units = (size as usize / 2).min(buffer.len());
    let end = buffer[..units]
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(units);
    Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(not(windows))]
pub fn recorded_value(_name: &str) -> Option<String> {
    None
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Did this launch come from the Run key?
///
/// Recorded rather than branched on: there is no window to suppress, so a boot
/// launch and a hand launch do exactly the same thing. It goes in the log so a
/// support question can tell the two apart.
pub fn launched_by_windows() -> bool {
    std::env::args().skip(1).any(|arg| arg == BOOT_FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one thing the whole module exists for.
    #[test]
    fn the_value_data_wraps_the_path_and_only_the_path() {
        let auto = Autostart::scoped(
            "test",
            Path::new("C:\\Users\\John Smith\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe"),
        );
        assert_eq!(
            auto.value_data(),
            "\"C:\\Users\\John Smith\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe\" --autostart"
        );

        let data = auto.value_data();
        // The quotes wrap the path. The argument sits outside the closing one,
        // which is the half that is easy to get wrong by quoting the lot.
        assert!(data.starts_with('"'));
        assert!(data.ends_with(" --autostart"));
        assert_eq!(data.matches('"').count(), 2);
        let closing = data.rfind('"').expect("a closing quote");
        assert!(
            data[closing + 1..].trim() == BOOT_FLAG,
            "the argument must sit outside the quoted path"
        );
        // And the path inside the quotes is the whole path, spaces and all.
        assert!(data[1..closing].ends_with("photo-pigeon.exe"));
        assert!(data[1..closing].contains("John Smith"));
    }

    /// The unquoted form is the bug, written down so it cannot come back by
    /// somebody tidying the format string.
    #[test]
    fn the_unquoted_form_is_what_this_module_refuses_to_write() {
        let exe = Path::new("C:\\Users\\John Smith\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe");
        let broken = format!("{} {BOOT_FLAG}", exe.display());
        let auto = Autostart::scoped("test", exe);
        assert_ne!(auto.value_data(), broken);
        // Windows would take everything up to the first space as the program.
        assert_eq!(
            broken.split(' ').next(),
            Some("C:\\Users\\John"),
            "this is exactly what boot would try to run without the quotes"
        );
    }

    #[test]
    fn a_path_with_no_space_in_it_is_quoted_anyway() {
        // Quoting is unconditional on purpose. A value that is only correct on
        // the machine that wrote it is the failure this replaces.
        let auto = Autostart::scoped("test", Path::new("C:\\tools\\photo-pigeon.exe"));
        assert_eq!(auto.value_data(), "\"C:\\tools\\photo-pigeon.exe\" --autostart");
    }

    #[test]
    fn a_build_tree_never_switches_autostart_on_by_itself() {
        // The one case the rail exists for, and the reason it is a property of
        // where the exe sits rather than of debug_assertions: a
        // `cargo build --release` run out of target\release would otherwise
        // write a real Run value pointing into a working tree, and the next
        // login would start a development build against the production config.
        let build_tree = Autostart {
            name: "Photo Pigeon (dev)".into(),
            exe: PathBuf::from("D:\\Dev\\photo-pigeon\\app\\src-tauri\\target\\release\\photo-pigeon.exe"),
            scope: NameScope::BuildTree,
        };
        assert!(!build_tree.may_default_on());
        assert!(!matches!(build_tree.scope(), NameScope::Shipped));
        // The toggle still works there, so the mechanism is exercisable by
        // hand. What is refused is turning it on for somebody.
        assert!(build_tree.value_data().starts_with('"'));
    }

    #[test]
    fn the_shipped_name_and_a_name_a_test_chose_may_both_be_written() {
        // The default is a decided rule and it has to fire, and a test
        // that moves the name aside has to be able to watch it fire. Refusing
        // the second makes the first unobservable, which is the same as
        // untested, and the name it writes cannot collide with the real one.
        let shipped = Autostart {
            name: "Photo Pigeon".into(),
            exe: PathBuf::from("C:\\Users\\casey\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe"),
            scope: NameScope::Shipped,
        };
        assert!(shipped.may_default_on());

        let chosen = Autostart::scoped("photo-pigeon-rig-1234", Path::new("C:\\x\\y.exe"));
        assert!(chosen.may_default_on());
        assert!(!matches!(chosen.scope(), NameScope::Shipped));
    }

    #[test]
    fn an_exe_that_could_not_be_found_is_never_written_anywhere() {
        let nameless = Autostart {
            name: "Photo Pigeon".into(),
            exe: PathBuf::new(),
            scope: NameScope::Shipped,
        };
        assert!(!nameless.may_default_on());
    }

    #[test]
    fn the_boot_flag_is_one_word_and_it_is_the_one_the_launch_path_parses() {
        // The document had two candidates. This is the guard on there being
        // one, since a flag written into a Run value and not parsed on the way
        // back in is a value that boots into an argument error.
        assert_eq!(BOOT_FLAG, "--autostart");
        assert!(BOOT_FLAG.starts_with("--"));
        assert!(!BOOT_FLAG.contains(' '));
    }

    /// The real Run key of the machine running the tests, under a name that
    /// belongs to this test and to nothing else, deleted on the way out.
    ///
    /// This is the only proof that matters. Everything above is a string
    /// comparison; this writes a value through `auto-launch`, reads the raw
    /// `REG_SZ` back through the Windows API, and asserts the bytes on disk are
    /// the quoted form. It is what the blocker note asked for.
    ///
    /// Safety: the name carries this process id and the word selftest, so it
    /// cannot collide with the value an installed copy owns. It asserts the
    /// name is not the product's before it writes anything, and it removes both
    /// the Run value and the StartupApproved companion afterwards.
    #[cfg(windows)]
    #[test]
    fn the_real_run_key_round_trips_with_the_quotes_on() {
        let name = format!("photo-pigeon-m3-selftest-{}", std::process::id());
        assert!(
            !name.eq_ignore_ascii_case("photo-pigeon") && !name.eq_ignore_ascii_case("Photo Pigeon"),
            "a test may never write the value an installed copy owns"
        );
        // Nothing may already be there under this name.
        assert_eq!(recorded_value(&name), None, "{name} was already in the Run key");

        let exe = Path::new("C:\\Users\\Test Person\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe");
        let auto = Autostart::scoped(&name, exe);

        let enabled = auto.enable();
        // A locked down machine can refuse the write. That is not this test's
        // subject, so it says so and stops rather than failing.
        if let Err(why) = &enabled {
            let _ = auto.disable();
            eprintln!("skipped: this machine would not take a Run value ({why})");
            return;
        }

        let landed = recorded_value(&name).expect("the value is in the key");
        assert_eq!(
            landed, "\"C:\\Users\\Test Person\\AppData\\Local\\Photo Pigeon\\photo-pigeon.exe\" --autostart",
            "the bytes in the registry are not the quoted form"
        );
        assert!(auto.is_enabled(), "it was written and does not read back as on");

        // The stale path re-assertion, against the same key: a value that
        // names a different exe is rewritten, and one that already agrees is
        // left alone.
        assert_eq!(auto.reassert(), Reassert::Correct);
        let moved = Autostart::scoped(&name, Path::new("C:\\Somewhere Else\\photo-pigeon.exe"));
        match moved.reassert() {
            Reassert::Rewritten(previous) => assert_eq!(previous, landed),
            other => panic!("a stale path was not repaired: {other:?}"),
        }
        assert_eq!(
            recorded_value(&name).as_deref(),
            Some("\"C:\\Somewhere Else\\photo-pigeon.exe\" --autostart")
        );

        auto.disable().expect("the value comes back out");
        assert_eq!(recorded_value(&name), None, "the test left a Run value behind");
        assert!(!auto.is_enabled());
        // Disabling twice is not an error: a value somebody else removed reads
        // as off rather than as a failure.
        assert!(auto.disable().is_ok());

        // The StartupApproved companion is auto-launch's to write and not ours
        // to read, but leaving it would leave litter under a test name, so it
        // goes too.
        clean_startup_approved(&name);
    }

    /// `auto-launch` writes a StartupApproved record on enable and does not
    /// remove it on disable. Under a test name that is litter, so the test
    /// takes it out itself.
    #[cfg(windows)]
    fn clean_startup_approved(name: &str) {
        use std::ptr;
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        };
        let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run");
        let value = wide(name);
        let mut handle: HKEY = ptr::null_mut();
        // SAFETY: both strings are NUL terminated and outlive the calls.
        unsafe {
            if RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_SET_VALUE, &mut handle) == 0 {
                RegDeleteValueW(handle, value.as_ptr());
                RegCloseKey(handle);
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_name_that_is_not_in_the_key_reads_as_absent_rather_than_as_a_guess() {
        let name = format!("photo-pigeon-m3-absent-{}", std::process::id());
        assert_eq!(recorded_value(&name), None);
        let auto = Autostart::scoped(&name, Path::new("C:\\x\\y.exe"));
        assert!(!auto.is_enabled());
        assert_eq!(auto.reassert(), Reassert::Off);
    }
}
