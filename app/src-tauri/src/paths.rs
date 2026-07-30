//! Where the core lives, and which config it is pointed at.
//!
//! Every path literal in this file comes from `app/scripts/sidecar-layout.json`,
//! which is the contract between the staging script and this shell and says so
//! in its own `$comment`. It is embedded with `include_str!` and parsed once,
//! so the two sides cannot drift: rename the bundle there and the shell follows
//! without anybody remembering to.
//!
//! The environment variable names go the other way. This module owns them, the
//! layout file repeats them, and [`tests::the_layout_and_this_module_agree`]
//! fails the build if the two copies ever disagree.
//!
//! ## Resolution order, from the layout file's own `resolution.order`
//!
//! 1. `PHOTO_PIGEON_CORE_JS`, verbatim. The seam that lets a test, or a dev
//!    iterating on the core, point the tray at `dist/cli.js` with no rebuild.
//! 2. The installed layout: the sidecar next to the exe, the bundle under the
//!    resource dir. On Windows those are the same directory and `tauri dev`
//!    stages both into the cargo target dir, so dev exercises the shipped
//!    shape rather than a second one.
//! 3. The dev fallback: system `node` over `<repo>/dist/cli.js`.
//!
//! ## The config, and the production watch
//!
//! `PHOTO_PIGEON_CONFIG` becomes `-c <path>` on the child's command line. It
//! exists so nothing under test ever has to aim at the real config.
//!
//! In a debug build the shell refuses to spawn without it. That is the safety
//! rail, not a convenience: a live production watch runs on this machine
//! against the tool's real state directory, and a dev run that quietly
//! inherited the default config would be a second watcher over the real
//! ledger. The core's lock would refuse it, which is the belt; this is the
//! braces, and it costs one environment variable.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

/// The contract, embedded. Not read from disk at runtime: an installed app has
/// no `scripts/` directory and this has to be true in both shapes.
const LAYOUT_JSON: &str = include_str!("../../scripts/sidecar-layout.json");

/// Env var names, owned here. The layout file repeats them and a test below
/// asserts the two copies match.
pub mod env_names {
    /// Config file handed to the core as `-c`. Required in debug builds.
    pub const CONFIG: &str = "PHOTO_PIGEON_CONFIG";
    /// Path to the JS the core runs. Overrides every other lookup.
    pub const CORE_JS: &str = "PHOTO_PIGEON_CORE_JS";
    /// Node executable to run it with, when the bundled runner is not in play.
    pub const NODE: &str = "PHOTO_PIGEON_NODE";
    /// Where the shell writes its own log. Tests point this at a temp dir.
    pub const SHELL_LOG: &str = "PHOTO_PIGEON_SHELL_LOG";
    /// The HKCU Run value name the autostart toggle writes.
    ///
    /// The only env name here that the layout file does not repeat, because it
    /// never crosses the seam the layout file describes: the build script never
    /// sees it and the core never sees it. It exists so a test can write and
    /// delete a Run value of its own without going anywhere near the value the
    /// installed app owns. See `autostart.rs`.
    pub const AUTOSTART_NAME: &str = "PHOTO_PIGEON_AUTOSTART_NAME";
    /// Set to `off` and this process never asks GitHub whether there is a newer
    /// version.
    ///
    /// The second env name the layout file does not repeat, for the same reason
    /// as [`AUTOSTART_NAME`]: it never crosses the seam that file describes. The
    /// build script never sees it and the core never sees it.
    ///
    /// It exists because the e2e rig and any bench run has to be able to hold
    /// the network call back, and it is a read of the environment rather than a
    /// `cfg!(debug_assertions)` so that a release build can be held back too:
    /// the run worth holding back is a real installed copy on a machine that
    /// must not phone home in the middle of a measurement. See `updater.rs`.
    pub const UPDATE_CHECK: &str = "PHOTO_PIGEON_UPDATE_CHECK";
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layout {
    /// Relative to the resource dir, for example `resources/core.mjs`.
    core_bundle: String,
    /// The sidecar's name with the target triple stripped, for example
    /// `pigeon-core`. It is `node.exe` renamed, so the core bundle is its
    /// first argument.
    sidecar_name: String,
    /// Read only by the drift test below, which is the whole point of it
    /// being in the file at all.
    #[allow(dead_code)]
    env: LayoutEnv,
    spawn: LayoutSpawn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct LayoutEnv {
    config: String,
    core_js: String,
    node: String,
    shell_log: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutSpawn {
    /// The argument vector, with `{coreBundleAbsPath}` and `{configPath}`
    /// still in it.
    watch_args: Vec<String>,
    watch_args_no_config: Vec<String>,
    /// What a stop request looks like on the child's stdin. One bare line.
    stop_line: String,
    /// The event that confirms the drain finished.
    stopped_event_type: String,

    // -- the four words M3 adds to the core's stdin vocabulary --------------
    //
    // These carry defaults, and the defaults are not laziness. The layout file
    // is written by `app/scripts/build-sidecar.mjs`, which is not this
    // milestone's to edit, so the words are declared here with the shapes the
    // core is gaining and picked up from the file the moment it names them.
    // Adding them there later changes nothing here and needs no code change,
    // which is the whole point of the placeholder.
    /// Close intake and hold the queue. No respawn, the child stays alive.
    #[serde(default = "default_pause_line")]
    pause_line: String,
    /// Open intake again and let the held queue go.
    #[serde(default = "default_resume_line")]
    resume_line: String,
    /// One reconciliation pass on demand. A gesture, never a timer.
    #[serde(default = "default_rescan_line")]
    rescan_line: String,
    /// The shell is leaving; finish the drain as an orphan and then exit.
    /// Distinct from `stop` precisely so the EOF that follows is not read as a
    /// second stop, which is what cut a drain short at M2.
    #[serde(default = "default_detach_line")]
    detach_line: String,
    /// The event that confirms a detach was understood.
    #[serde(default = "default_detached_event_type")]
    detached_event_type: String,

    // -- M4: the first run window's own sidecar ------------------------------
    //
    // Same defaults-with-a-file-override shape as the M3 words above and for
    // the same reason: the layout file is the contract between the staging
    // script and the shell, and a flag that lives in one place cannot drift
    // from the other.
    /// The wizard, speaking NDJSON, pointed at a config folder.
    #[serde(default = "default_setup_args")]
    setup_args: Vec<String>,
    /// The same, letting the core pick its own folder. Release builds only.
    #[serde(default = "default_setup_args_no_config")]
    setup_args_no_config: Vec<String>,
    /// The health check, as one JSON line, pointed at a config folder.
    #[serde(default = "default_doctor_args")]
    doctor_args: Vec<String>,
    /// The same, letting the core pick its own folder. Release builds only.
    #[serde(default = "default_doctor_args_no_config")]
    doctor_args_no_config: Vec<String>,
    /// The one payload-carrying stdin form in this project.
    #[serde(default = "default_answer_word")]
    answer_word: String,

    // -- the status window's Watching list ----------------------------------
    //
    // One request, one JSON line, which is `doctor --json`'s shape rather than
    // the ndjson stream: there is no run to narrate here and no `stopped` to end
    // it with. Same defaults-with-a-file-override shape as everything above.
    /// Add or remove one watched folder, against a named config file.
    #[serde(default = "default_folders_args")]
    folders_args: Vec<String>,
    /// The same, letting the core pick its own folder. Release builds only.
    #[serde(default = "default_folders_args_no_config")]
    folders_args_no_config: Vec<String>,
}

fn default_pause_line() -> String {
    "pause\n".into()
}
fn default_resume_line() -> String {
    "resume\n".into()
}
fn default_rescan_line() -> String {
    "rescan\n".into()
}
fn default_detach_line() -> String {
    "detach\n".into()
}
fn default_detached_event_type() -> String {
    "detached".into()
}
fn default_setup_args() -> Vec<String> {
    ["{coreBundleAbsPath}", "setup", "--events", "ndjson", "-c", "{configPath}"]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}
fn default_setup_args_no_config() -> Vec<String> {
    ["{coreBundleAbsPath}", "setup", "--events", "ndjson"]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}
fn default_doctor_args() -> Vec<String> {
    ["{coreBundleAbsPath}", "doctor", "--json", "-c", "{configPath}"]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}
fn default_doctor_args_no_config() -> Vec<String> {
    ["{coreBundleAbsPath}", "doctor", "--json"]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}
fn default_answer_word() -> String {
    "answer".into()
}
fn default_folders_args() -> Vec<String> {
    [
        "{coreBundleAbsPath}",
        "folders",
        "{foldersAction}",
        "{folderPath}",
        "--json",
        "-c",
        "{configPath}",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}
fn default_folders_args_no_config() -> Vec<String> {
    ["{coreBundleAbsPath}", "folders", "{foldersAction}", "{folderPath}", "--json"]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

fn layout() -> &'static Layout {
    static LAYOUT: OnceLock<Layout> = OnceLock::new();
    LAYOUT.get_or_init(|| {
        serde_json::from_str(LAYOUT_JSON)
            .expect("app/scripts/sidecar-layout.json is embedded at compile time and must parse")
    })
}

/// The bare line the core's stdin parser accepts. Never a JSON envelope: the
/// parser is eight lines long and it is the contract.
pub fn stop_line() -> &'static str {
    &layout().spawn.stop_line
}

/// The event type that confirms a drain finished.
pub fn stopped_event_type() -> &'static str {
    &layout().spawn.stopped_event_type
}

/// Close intake and hold the queue, without ending the run.
pub fn pause_line() -> &'static str {
    &layout().spawn.pause_line
}

/// Open intake again.
pub fn resume_line() -> &'static str {
    &layout().spawn.resume_line
}

/// One reconciliation pass, asked for by a person.
pub fn rescan_line() -> &'static str {
    &layout().spawn.rescan_line
}

/// "I am leaving, finish without me." The word that makes the second Quit
/// press honest: after it, the EOF the shell's exit produces is not a second
/// stop and the drain is not cut short.
pub fn detach_line() -> &'static str {
    &layout().spawn.detach_line
}

/// The event type that confirms a detach was understood.
pub fn detached_event_type() -> &'static str {
    &layout().spawn.detached_event_type
}

/// The one word in this project that carries a payload.
///
/// `answer {"id":"...","value":...}`, written to a setup sidecar's stdin. The
/// six bare words are unchanged and this is not a seventh: it is a form, and
/// it is the only one M4 was allowed to add. docs/ASK-PROTOCOL.md is the
/// contract and `src/commands/setup-channel.ts` is the parser.
pub fn answer_word() -> &'static str {
    &layout().spawn.answer_word
}

/// One answer line, ready for a setup sidecar's stdin.
pub fn answer_line(payload: &serde_json::Value) -> String {
    format!("{} {}
", answer_word(), payload)
}

/// Is this binary running out of a cargo target directory rather than an
/// install?
///
/// Used by two places that must not touch what an installed copy owns: the
/// autostart value name and the shell's own state file. The test is the same
/// one `tauri-plugin-notification` uses to decide whether to claim the
/// AppUserModelID, which is a good sign it is the test Windows tooling expects
/// rather than one invented here.
///
/// It is deliberately a property of where the exe sits and not of
/// `debug_assertions`: a `cargo build --release` run out of `target/release` is
/// exactly the case that would otherwise write a real Run value pointing at a
/// developer's working tree.
pub fn running_from_build_dir() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
        .map(|dir| in_a_build_dir(&dir))
        .unwrap_or(false)
}

fn in_a_build_dir(exe_dir: &Path) -> bool {
    exe_dir.ends_with("target/debug")
        || exe_dir.ends_with("target/release")
        || exe_dir.ends_with("target/debug/deps")
        || exe_dir.ends_with("target/release/deps")
}

/// How to start the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreLaunch {
    /// The program to run: the bundled runner, or `node`.
    pub program: PathBuf,
    /// The core bundle, absolute, which is the runner's first argument.
    pub core_js: PathBuf,
    /// One line for the shell log saying which layout won.
    pub source: String,
}

impl CoreLaunch {
    /// The full argument list, built from the layout file's own template so
    /// the flags cannot drift away from what the staging script verified.
    pub fn watch_args(&self, config: Option<&str>) -> Vec<OsString> {
        let spawn = &layout().spawn;
        self.fill(
            match config {
                Some(_) => &spawn.watch_args,
                None => &spawn.watch_args_no_config,
            },
            config,
        )
    }

    /// The wizard, on the machine channel. What `setup_start()` spawns.
    pub fn setup_args(&self, config: Option<&str>) -> Vec<OsString> {
        let spawn = &layout().spawn;
        self.fill(
            match config {
                Some(_) => &spawn.setup_args,
                None => &spawn.setup_args_no_config,
            },
            config,
        )
    }

    /// The health check, as one JSON line. What `doctor_report()` spawns.
    ///
    /// Takes the config the same way the other two do, and for a reason worth
    /// stating: a health check that reports on a different folder than the one
    /// this tray is watching answers a question nobody asked. Under a config
    /// override that folder is the override's, and on a development machine
    /// the alternative is reading the machine's real install.
    pub fn doctor_args(&self, config: Option<&str>) -> Vec<OsString> {
        let spawn = &layout().spawn;
        self.fill(
            match config {
                Some(_) => &spawn.doctor_args,
                None => &spawn.doctor_args_no_config,
            },
            config,
        )
    }

    /// Add or remove one watched folder. What the status window's list spawns.
    ///
    /// `folder` is a string the page received from `ipc::pick_folder` or out of
    /// the core's own `started` event, handed straight back for the core to
    /// validate exactly as it validates a path a terminal user typed. It travels
    /// as one element of an argument vector, which is not a shell command line
    /// and is not parsed by one, and nothing in this process reads or writes it.
    pub fn folders_args(&self, action: &str, folder: &str, config: Option<&str>) -> Vec<OsString> {
        let spawn = &layout().spawn;
        self.fill_all(
            match config {
                Some(_) => &spawn.folders_args,
                None => &spawn.folders_args_no_config,
            },
            &[
                ("{configPath}", config.unwrap_or_default()),
                ("{foldersAction}", action),
                ("{folderPath}", folder),
            ],
        )
    }

    fn fill(&self, template: &[String], config: Option<&str>) -> Vec<OsString> {
        self.fill_all(template, &[("{configPath}", config.unwrap_or_default())])
    }

    /// The layout file's template with the placeholders filled in.
    ///
    /// The core bundle is always the first substitution and is never taken from
    /// a caller: it is where this shell resolved the core to, and a template
    /// that could name something else would be a template that runs something
    /// else.
    fn fill_all(&self, template: &[String], values: &[(&str, &str)]) -> Vec<OsString> {
        template
            .iter()
            .map(|arg| {
                if arg == "{coreBundleAbsPath}" {
                    return self.core_js.clone().into_os_string();
                }
                for (placeholder, value) in values {
                    if arg == placeholder {
                        return OsString::from(*value);
                    }
                }
                OsString::from(arg.as_str())
            })
            .collect()
    }
}

/// The config path this shell will hand the core, and whether it is allowed to
/// run without one.
pub enum ConfigChoice {
    /// Use this file.
    Explicit(String),
    /// Let the core use its own default. Release builds only.
    CoreDefault,
    /// Refuse to start, and say this.
    Refuse(String),
}

/// Read the config override, and apply the debug build safety rail.
pub fn config_choice() -> ConfigChoice {
    match env::var(env_names::CONFIG) {
        Ok(path) if !path.trim().is_empty() => ConfigChoice::Explicit(path),
        _ if cfg!(debug_assertions) => ConfigChoice::Refuse(format!(
            "a development build will not start the engine without {}. \
             Point it at a temp config so it cannot reach the real one.",
            env_names::CONFIG
        )),
        _ => ConfigChoice::CoreDefault,
    }
}

/// Work out how to start the core from the two directories Tauri can name.
///
/// Both are passed in rather than read here, so this is testable without an
/// app handle and so the caller decides what "here" means.
pub fn resolve_core(
    exe_dir: Option<&Path>,
    resource_dir: Option<&Path>,
) -> Result<CoreLaunch, String> {
    let node_override = non_empty(env::var(env_names::NODE).ok());
    let js_override = non_empty(env::var(env_names::CORE_JS).ok());
    let sidecar = find_sidecar(exe_dir);

    // 1. Told explicitly, verbatim, skipping everything else.
    if let Some(js) = js_override {
        let program = node_override
            .map(PathBuf::from)
            .or_else(|| sidecar.clone())
            .unwrap_or_else(|| PathBuf::from("node"));
        return Ok(CoreLaunch {
            program,
            core_js: PathBuf::from(js),
            source: format!("{} override", env_names::CORE_JS),
        });
    }

    // 2. The installed layout, which tauri dev also stages.
    let bundle = find_core_bundle(exe_dir, resource_dir);
    if let (Some(program), Some(core_js)) = (sidecar.clone(), bundle.clone()) {
        return Ok(CoreLaunch {
            program,
            core_js,
            source: "installed layout".into(),
        });
    }

    // 3. Dev fallback: system node over the repo's own build output.
    if let Some(core_js) = find_dev_core() {
        return Ok(CoreLaunch {
            program: node_override
                .map(PathBuf::from)
                .unwrap_or_else(|| "node".into()),
            core_js,
            source: "dev fallback, system node over dist/cli.js".into(),
        });
    }

    Err(match (sidecar.is_some(), bundle.is_some()) {
        (true, false) => format!(
            "the sidecar is here but {} is not. Looked under {}. Run the staging script.",
            layout().core_bundle,
            describe(resource_dir)
        ),
        (false, true) => format!(
            "{} is here but the sidecar is not. Looked under {}. Run the staging script.",
            layout().core_bundle,
            describe(exe_dir)
        ),
        _ => format!(
            "no core found. Run the staging script, or set {} to a built dist/cli.js.",
            env_names::CORE_JS
        ),
    })
}

/// The sidecar: the pinned `node.exe` under the name the layout gives it.
/// Tauri strips the target triple when it stages an `externalBin`, so the
/// stripped name is checked first and the triple form only as a courtesy.
fn find_sidecar(exe_dir: Option<&Path>) -> Option<PathBuf> {
    let dir = exe_dir?;
    let name = &layout().sidecar_name;
    for candidate in [
        dir.join(format!("{name}{}", env::consts::EXE_SUFFIX)),
        dir.join(name),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let prefix = format!("{name}-");
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        (file_name.starts_with(&prefix) && entry.path().is_file()).then(|| entry.path())
    })
}

/// The core bundle, at the relative path the layout file names.
///
/// On Windows `resource_dir()` and the exe directory are the same directory in
/// both the dev and the installed shape, so one join covers both. The exe dir
/// is tried as well because that costs nothing and makes this correct on a
/// platform where they differ.
fn find_core_bundle(exe_dir: Option<&Path>, resource_dir: Option<&Path>) -> Option<PathBuf> {
    let relative = &layout().core_bundle;
    [resource_dir, exe_dir]
        .into_iter()
        .flatten()
        .map(|root| root.join(relative))
        .find(|path| path.is_file())
}

/// The repo's own build output, for a dev session with no staged sidecar.
///
/// `CARGO_MANIFEST_DIR` is `app/src-tauri`, so the repo root is two levels up.
/// Baked at compile time, which is right: it is only ever correct on the
/// machine that compiled the binary, and that is exactly the dev case.
fn find_dev_core() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.parent()?.parent()?.join("dist").join("cli.js");
    candidate.is_file().then_some(candidate)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

fn describe(dir: Option<&Path>) -> String {
    dir.map(|d| d.display().to_string())
        .unwrap_or_else(|| "an unknown directory".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_file_parses_and_carries_what_the_shell_needs() {
        let layout = layout();
        assert!(layout.core_bundle.ends_with(".mjs") || layout.core_bundle.ends_with(".cjs"));
        assert!(!layout.sidecar_name.is_empty());
        assert_eq!(layout.spawn.stop_line, "stop\n");
        assert_eq!(layout.spawn.stopped_event_type, "stopped");
    }

    /// The M3 vocabulary, as bare lines, one word to a line, newline
    /// terminated. The core's parser is case insensitive and takes nothing
    /// else, so a word with a space in it or a JSON envelope is answered on
    /// stderr and ignored, which is how a shell ends up waiting for something
    /// that was never asked for.
    #[test]
    fn the_m3_words_are_single_bare_lines() {
        for (label, word) in [
            ("stop", stop_line()),
            ("pause", pause_line()),
            ("resume", resume_line()),
            ("rescan", rescan_line()),
            ("detach", detach_line()),
        ] {
            assert!(word.ends_with('\n'), "{label} is not newline terminated");
            let body = word.trim_end_matches('\n');
            assert!(!body.is_empty(), "{label} is empty");
            assert!(
                body.chars().all(|c| c.is_ascii_lowercase()),
                "{label} is {body:?}, which is not one bare lowercase word"
            );
        }
        assert_eq!(pause_line(), "pause\n");
        assert_eq!(resume_line(), "resume\n");
        assert_eq!(rescan_line(), "rescan\n");
        assert_eq!(detach_line(), "detach\n");
        assert_eq!(detached_event_type(), "detached");
    }

    /// Every word has to be its own word. Two that collide would mean a menu
    /// item silently doing something else.
    #[test]
    fn no_two_stdin_words_are_the_same() {
        let words = [
            stop_line(),
            pause_line(),
            resume_line(),
            rescan_line(),
            detach_line(),
        ];
        for (i, a) in words.iter().enumerate() {
            for b in words.iter().skip(i + 1) {
                assert_ne!(a, b, "two stdin words are the same line");
            }
        }
        // And detach is not stop, which is the whole reason it exists.
        assert_ne!(detach_line(), stop_line());
        assert_ne!(detached_event_type(), stopped_event_type());
    }

    #[test]
    fn a_build_directory_is_recognised_by_where_the_exe_sits() {
        assert!(in_a_build_dir(Path::new(
            "D:\\Dev\\photo-pigeon\\app\\src-tauri\\target\\release"
        )));
        assert!(in_a_build_dir(Path::new(
            "D:\\Dev\\photo-pigeon\\app\\src-tauri\\target\\debug"
        )));
        assert!(in_a_build_dir(Path::new(
            "D:\\Dev\\photo-pigeon\\app\\src-tauri\\target\\debug\\deps"
        )));
        // The shape that must never be mistaken for a build tree, because it
        // is the one that owns the real Run value and the real state file.
        assert!(!in_a_build_dir(Path::new(
            "C:\\Users\\casey\\AppData\\Local\\Photo Pigeon"
        )));
        assert!(!in_a_build_dir(Path::new("C:\\Program Files\\Photo Pigeon")));
    }

    /// The layout file says the env names are owned here and repeated there.
    /// This is the mechanism that makes "cannot drift" true rather than hoped.
    #[test]
    fn the_layout_and_this_module_agree_on_the_env_names() {
        let env = &layout().env;
        assert_eq!(env.config, env_names::CONFIG);
        assert_eq!(env.core_js, env_names::CORE_JS);
        assert_eq!(env.node, env_names::NODE);
        assert_eq!(env.shell_log, env_names::SHELL_LOG);
    }

    #[test]
    fn watch_args_are_the_contract_with_the_placeholders_filled_in() {
        let launch = CoreLaunch {
            program: "C:\\App\\pigeon-core.exe".into(),
            core_js: "C:\\App\\resources\\core.mjs".into(),
            source: "test".into(),
        };
        let args: Vec<String> = launch
            .watch_args(Some("C:\\tmp\\pigeon\\config.json"))
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "C:\\App\\resources\\core.mjs",
                "watch",
                "--events",
                "ndjson",
                "-c",
                "C:\\tmp\\pigeon\\config.json",
            ]
        );
        // The machine channel is not optional: without it stdout carries prose
        // and the stop protocol is not wired at all.
        assert!(args.iter().any(|a| a == "--events"));
        assert!(args.iter().any(|a| a == "ndjson"));
    }

    #[test]
    fn watch_args_without_a_config_leave_the_core_to_its_default() {
        let launch = CoreLaunch {
            program: "node".into(),
            core_js: "D:\\Dev\\photo-pigeon\\dist\\cli.js".into(),
            source: "test".into(),
        };
        let args: Vec<String> = launch
            .watch_args(None)
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "D:\\Dev\\photo-pigeon\\dist\\cli.js",
                "watch",
                "--events",
                "ndjson"
            ]
        );
        // And never an empty -c, which the core would read as a config file
        // called "".
        assert!(!args.iter().any(|a| a.is_empty()));
    }

    #[test]
    fn folders_args_carry_the_action_and_the_folder_and_nothing_else() {
        let launch = CoreLaunch {
            program: "C:\\App\\pigeon-core.exe".into(),
            core_js: "C:\\App\\resources\\core.mjs".into(),
            source: "test".into(),
        };
        let args: Vec<String> = launch
            .folders_args("add", "D:\\Photos\\2026", Some("C:\\tmp\\pigeon\\config.json"))
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "C:\\App\\resources\\core.mjs",
                "folders",
                "add",
                "D:\\Photos\\2026",
                "--json",
                "-c",
                "C:\\tmp\\pigeon\\config.json",
            ]
        );
        // No placeholder may survive into the vector: the core would read
        // "{folderPath}" as a relative path and refuse it with a sentence about
        // a folder nobody typed.
        assert!(!args.iter().any(|a| a.starts_with('{')), "{args:?}");
    }

    /// The page's string is one argument, whatever is in it.
    ///
    /// This is an argument vector and not a command line: `std::process::Command`
    /// passes it to the OS, no shell parses it, and a folder called
    /// `Photos & Videos` or one with a quote in its name is one element either
    /// way. The test exists because the alternative reading, that a path from a
    /// page could become two arguments, is the one worth being able to point at.
    #[test]
    fn an_awkward_folder_name_is_still_one_argument() {
        let launch = CoreLaunch {
            program: "node".into(),
            core_js: "D:\\Dev\\photo-pigeon\\dist\\cli.js".into(),
            source: "test".into(),
        };
        let awkward = "D:\\Photos & \"Videos\" --json";
        let args = launch.folders_args("remove", awkward, Some("C:\\tmp\\config.json"));
        assert_eq!(args.iter().filter(|a| *a == awkward).count(), 1, "{args:?}");
        assert_eq!(args.len(), 7);
    }

    #[test]
    fn folders_args_without_a_config_leave_the_core_to_its_default() {
        let launch = CoreLaunch {
            program: "node".into(),
            core_js: "D:\\Dev\\photo-pigeon\\dist\\cli.js".into(),
            source: "test".into(),
        };
        let args: Vec<String> = launch
            .folders_args("remove", "D:\\Photos", None)
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "D:\\Dev\\photo-pigeon\\dist\\cli.js",
                "folders",
                "remove",
                "D:\\Photos",
                "--json"
            ]
        );
        // And never an empty -c, which the core would read as a config file
        // called "".
        assert!(!args.iter().any(|a| a.is_empty()));
    }

    /// A scratch directory that cleans itself up.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = env::temp_dir().join(format!(
                "photo-pigeon-paths-{label}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }
        fn put(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("scratch subdir");
            }
            std::fs::write(&path, b"// scratch").expect("scratch file");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The layout file's own rule: "Nothing else may hardcode these names."
    /// Proved by behaviour rather than by grepping this file, because a test
    /// that greps its own source counts its own literals.
    #[test]
    fn the_core_bundle_is_found_at_exactly_the_layout_path_and_nowhere_else() {
        let scratch = Scratch::new("bundle");
        assert_eq!(find_core_bundle(None, Some(&scratch.0)), None);

        // A plausible near miss, which is what a drifted contract looks like.
        scratch.put("resources/core.cjs");
        scratch.put("core.mjs");
        assert_eq!(
            find_core_bundle(None, Some(&scratch.0)),
            None,
            "only the path the layout file names may satisfy the lookup"
        );

        let expected = scratch.put(&layout().core_bundle);
        assert_eq!(find_core_bundle(None, Some(&scratch.0)), Some(expected));
    }

    #[test]
    fn the_sidecar_is_found_under_the_name_the_layout_gives_it() {
        let scratch = Scratch::new("sidecar");
        assert_eq!(find_sidecar(Some(&scratch.0)), None);

        scratch.put("node.exe");
        assert_eq!(
            find_sidecar(Some(&scratch.0)),
            None,
            "the sidecar is recognised by its shipped name, not by being node"
        );

        let expected = scratch.put(&format!(
            "{}{}",
            layout().sidecar_name,
            env::consts::EXE_SUFFIX
        ));
        assert_eq!(find_sidecar(Some(&scratch.0)), Some(expected));
    }

    #[test]
    fn the_shell_never_invents_a_config_path() {
        // Whatever the shell hands the core is exactly what it was given, and
        // when it was given nothing it says nothing. There is no default here
        // to accidentally aim at the real one.
        match config_choice() {
            ConfigChoice::Explicit(path) => {
                assert_eq!(path, env::var(env_names::CONFIG).unwrap())
            }
            ConfigChoice::Refuse(why) => {
                assert!(env::var(env_names::CONFIG).is_err());
                assert!(why.contains(env_names::CONFIG));
            }
            ConfigChoice::CoreDefault => assert!(!cfg!(debug_assertions)),
        }
    }

    #[test]
    fn a_resolved_launch_never_points_into_the_tools_real_state_directory() {
        let scratch = Scratch::new("resolve");
        scratch.put(&format!(
            "{}{}",
            layout().sidecar_name,
            env::consts::EXE_SUFFIX
        ));
        scratch.put(&layout().core_bundle);
        if env::var(env_names::CORE_JS).is_ok() {
            return;
        }
        let launch = resolve_core(Some(&scratch.0), Some(&scratch.0)).expect("staged layout");
        for path in [&launch.program, &launch.core_js] {
            assert!(
                !path.to_string_lossy().contains(".photo-pigeon"),
                "the shell resolved something inside the real state directory: {}",
                path.display()
            );
        }
    }

    #[test]
    fn a_missing_layout_on_disk_explains_itself_rather_than_panicking() {
        if env::var(env_names::CORE_JS).is_ok() {
            return; // The override legitimately short circuits everything.
        }
        let nowhere = env::temp_dir().join("photo-pigeon-no-such-dir-for-tests");
        match resolve_core(Some(&nowhere), Some(&nowhere)) {
            Err(message) => {
                assert!(message.contains("staging script") || message.contains(env_names::CORE_JS))
            }
            // A dev checkout with dist/ built resolves through the fallback,
            // which is correct rather than a failure.
            Ok(launch) => assert!(launch.source.starts_with("dev fallback")),
        }
    }
}
