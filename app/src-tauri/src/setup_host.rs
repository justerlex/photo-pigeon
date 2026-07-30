//! The setup sidecar: the first run window's other half.
//!
//! `setup_start()` spawns the shipped core as `setup --events ndjson` and
//! forwards **every line of its stdout, raw**, to the window on the Tauri event
//! channel `setup-event`. `setup_answer(payload)` writes the one
//! payload-carrying stdin form back. That is the whole of the IPC contract for
//! first run, and `docs/ASK-PROTOCOL.md` is the protocol it carries.
//!
//! ## Raw, on purpose
//!
//! Nothing here parses a setup event. The watch stream is parsed in
//! `events.rs` because the shell acts on it: an icon, a menu, a toast. Setup
//! events are *rendered*, by the page, and a shell that parsed them into a
//! second union would be a third place the wizard's shape is written down and
//! the first place it would drift. So this module frames lines and forwards
//! strings, and the only thing it knows about the payload is that a line is a
//! line.
//!
//! ## What it refuses
//!
//! * **A second start while one is running.** Two setup sidecars would be two
//!   wizards writing one config folder, and the second would find the first's
//!   half-written state. A second `setup_start()` is answered with the pid of
//!   the one that is already up, and the window is told so on the same channel
//!   rather than left waiting for events that will never come.
//! * **An answer with no sidecar.** A window that closed mid ask and reopened
//!   holds an ask id nothing is listening for. Refused by name, never
//!   swallowed: that is the M3 rule about the machine channel and it applies to
//!   this channel too.
//!
//! ## What it does not own
//!
//! The lock. A setup run does not take the watch lock, so setup while a watch
//! is running is safe, and setup that *writes a config* while a watch holds
//! the old one is the core's problem and already handled: the watch is reading
//! a config it loaded at start, and the next start reads the new one.

use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::{AppHandle, Emitter, Manager};

use crate::events::{Framed, LineAssembler};
use crate::paths;
use crate::shell_log::ShellLog;

/// The Tauri event channel the setup window listens on.
pub const CHANNEL: &str = "setup-event";

/// One setup run, or none.
#[derive(Default)]
struct Running {
    pid: Option<u32>,
    stdin: Option<ChildStdin>,
}

/// Managed state: the live setup sidecar, if there is one.
#[derive(Default)]
pub struct SetupHost {
    inner: Mutex<Running>,
}

impl SetupHost {
    pub fn new() -> Self {
        Self::default()
    }
}

/// A line the shell says on the setup channel itself.
///
/// Shaped exactly like a core event so the page has one parser and not two:
/// an object with a `type`. The three types below are the only ones the shell
/// ever invents, and each of them is an answer to something the window asked
/// for that the core never heard.
fn shell_line(kind: &str, message: &str) -> String {
    serde_json::json!({
        "type": kind,
        "error": message,
        "at": null,
        "from": "shell",
    })
    .to_string()
}

/// Spawn the wizard on the machine channel.
///
/// Returns the pid, or the sentence that explains why not. Every failure here
/// is one a person can act on: a core that could not be resolved, a debug build
/// with no config override, a spawn that the OS refused.
pub fn start(app: &AppHandle) -> Result<u32, String> {
    let log = app.state::<Arc<ShellLog>>();
    let host = app.state::<SetupHost>();

    {
        let running = host.inner.lock().map_err(|_| "the setup host is wedged")?;
        if let Some(pid) = running.pid {
            let why = format!("setup is already running, process {pid}");
            log.line(&format!("setup_start refused: {why}"));
            let _ = app.emit(CHANNEL, shell_line("setup-refused", &why));
            return Err(why);
        }
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::PathBuf::from));
    let resource_dir = app.path().resource_dir().ok();
    let launch = paths::resolve_core(exe_dir.as_deref(), resource_dir.as_deref())?;

    // The same safety rail the watch spawn uses, and for the same reason: a
    // development build must not be able to reach the real ~/.photo-pigeon, and
    // setup is the one command that would rewrite it.
    let config = match paths::config_choice() {
        paths::ConfigChoice::Explicit(path) => Some(path),
        paths::ConfigChoice::CoreDefault => None,
        paths::ConfigChoice::Refuse(why) => {
            log.line(&format!("setup_start refused: {why}"));
            let _ = app.emit(CHANNEL, shell_line("setup-refused", &why));
            return Err(why);
        }
    };

    let args = launch.setup_args(config.as_deref());
    let mut command = Command::new(&launch.program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // A tray app must never flash a console, and a setup sidecar is exactly
    // where one would appear: this is the path that used to open a terminal.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    log.line(&format!(
        "spawning setup {} {:?}",
        launch.program.display(),
        args
    ));

    let mut child: Child = command.spawn().map_err(|err| format!("{err}"))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut running = host.inner.lock().map_err(|_| "the setup host is wedged")?;
        running.pid = Some(pid);
        running.stdin = stdin;
    }

    if let Some(pipe) = stdout {
        pump(app.clone(), pipe, true);
    }
    if let Some(pipe) = stderr {
        pump(app.clone(), pipe, false);
    }

    let app_for_reaper = app.clone();
    thread::Builder::new()
        .name("pigeon-setup-reaper".into())
        .spawn(move || {
            let code = child.wait().ok().and_then(|status| status.code());
            if let Some(host) = app_for_reaper.try_state::<SetupHost>() {
                if let Ok(mut running) = host.inner.lock() {
                    running.pid = None;
                    running.stdin = None;
                }
            }
            // The core's own `stopped` line has already gone up the channel by
            // the time this fires. This is the shell's line for the case there
            // was no `stopped`: a sidecar that died on its face still has to
            // close the window's question rather than leave it spinning.
            let _ = app_for_reaper.emit(
                CHANNEL,
                serde_json::json!({
                    "type": "setup-exited",
                    "exitCode": code,
                    "at": null,
                    "from": "shell",
                })
                .to_string(),
            );
            // And the supervisor, which is the only thing that can act on it.
            // Deliberately just "a run ended": whether it left a config behind
            // is a question for the disk, not for an exit code, and a wizard
            // cancelled halfway exits cleanly having written nothing. Without
            // this line a first run finishes into a tray that is still waiting
            // to be set up, and the exit criterion needs a restart to pass.
            if let Some(supervisor) = app_for_reaper.try_state::<crate::supervisor::SupervisorHandle>()
            {
                supervisor.send(crate::supervisor::UiCommand::SetupEnded);
            }
        })
        .map_err(|err| format!("{err}"))?;

    Ok(pid)
}

/// Write one answer to the running sidecar's stdin.
///
/// The payload is passed through verbatim, and validating it is deliberately
/// not this layer's job: the core owns the state machine, so the core owns
/// which answers are acceptable and it says so on the channel. A shell that
/// second-guessed a rule here would be the second place the rule lives.
pub fn answer(app: &AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let host = app.state::<SetupHost>();
    let mut running = host.inner.lock().map_err(|_| "the setup host is wedged")?;
    let Some(stdin) = running.stdin.as_mut() else {
        let why = "there is no setup running to answer".to_string();
        let _ = app.emit(CHANNEL, shell_line("answered", &why));
        return Err(why);
    };
    let line = paths::answer_line(&payload);
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|err| {
            let why = format!("the setup process stopped listening: {err}");
            let _ = app.emit(CHANNEL, shell_line("answered", &why));
            why
        })
}

/// Ask the running setup to stop, by the word it already understands.
///
/// Used when the window closes mid walk. `stop` is one of the six bare words
/// and setup answers it: it emits `stopping` then `stopped` and leaves nothing
/// behind, because a cancelled setup has written no config.
pub fn stop(app: &AppHandle) {
    let Some(host) = app.try_state::<SetupHost>() else {
        return;
    };
    let Ok(mut running) = host.inner.lock() else {
        return;
    };
    if let Some(stdin) = running.stdin.as_mut() {
        let _ = stdin.write_all(paths::stop_line().as_bytes());
        let _ = stdin.flush();
    }
    // stdin is dropped with the struct on the reaper's side. Closing it here
    // would be an EOF, which setup also reads as a stop, so either order is
    // safe: unlike a watch mid drain, there is no batch to abandon.
}

/// One pipe to the window, framed into whole lines.
fn pump<R: std::io::Read + Send + 'static>(app: AppHandle, mut pipe: R, is_stdout: bool) {
    thread::Builder::new()
        .name(if is_stdout {
            "pigeon-setup-out".into()
        } else {
            "pigeon-setup-err".into()
        })
        .spawn(move || {
            let mut assembler = LineAssembler::new();
            let mut buffer = [0u8; 8192];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        for framed in assembler.push(&buffer[..read]) {
                            forward(&app, framed, is_stdout);
                        }
                    }
                }
            }
            if let Some(framed) = assembler.finish() {
                forward(&app, framed, is_stdout);
            }
        })
        .ok();
}

fn forward(app: &AppHandle, framed: Framed, is_stdout: bool) {
    match framed {
        Framed::Line(line) => {
            if is_stdout {
                // Raw, exactly as the core wrote it. The page parses it.
                let _ = app.emit(CHANNEL, line);
            } else if let Some(log) = app.try_state::<Arc<ShellLog>>() {
                // Human prose from the wizard. It never shares a channel with
                // the events, which is the same rule the watch stream follows.
                log.line(&format!("setup stderr: {line}"));
            }
        }
        Framed::Dropped(bytes) => {
            if let Some(log) = app.try_state::<Arc<ShellLog>>() {
                log.line(&format!("setup dropped an overlong line of {bytes} bytes"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_line_is_the_one_payload_form_and_ends_in_a_newline() {
        // The whole of M4's growth to the stdin vocabulary. One word, one JSON
        // object, one line. Not a JSON envelope around the word, because the
        // core's parser splits on the first space and reads the rest as the
        // payload, and not a second bare word, because a bare word cannot carry
        // an ask id.
        let line = paths::answer_line(&serde_json::json!({ "id": "3", "value": true }));
        assert!(line.starts_with("answer "), "{line:?}");
        assert!(line.ends_with('\n'), "{line:?}");
        assert_eq!(line.matches('\n').count(), 1, "{line:?}");
        let payload = line
            .trim_end()
            .strip_prefix("answer ")
            .expect("the word and a space");
        let parsed: serde_json::Value = serde_json::from_str(payload).expect("valid JSON");
        assert_eq!(parsed["id"], "3");
        assert_eq!(parsed["value"], true);
    }

    #[test]
    fn an_answer_carrying_a_newline_cannot_break_the_frame() {
        // A folder path a person pasted, with something odd in it. JSON escapes
        // it, so one answer is still one line, which is what the core's reader
        // frames on.
        let line = paths::answer_line(&serde_json::json!({
            "id": "7",
            "value": "D:\\Photos\nrescan"
        }));
        assert_eq!(line.matches('\n').count(), 1, "{line:?}");
        assert!(!line.trim_end().contains('\n'));
    }

    #[test]
    fn the_shell_never_invents_a_core_event_type() {
        // The page has one parser. Everything the shell says on this channel is
        // marked as the shell's, so a page can tell "the core said this" from
        // "the shell could not reach the core", which are different problems
        // with different next steps.
        for kind in ["setup-refused", "answered"] {
            let line = shell_line(kind, "a reason");
            let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
            assert_eq!(parsed["from"], "shell");
            assert_eq!(parsed["type"], kind);
        }
    }
}
