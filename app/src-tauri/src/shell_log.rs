//! The shell's own log. Small, plain text, and never a console.
//!
//! A tray app has no terminal, so `eprintln!` in a release build writes to a
//! handle nobody owns. Everything the shell wants to say about spawning,
//! stopping and respawning goes here instead, plus every line the core writes
//! to stderr, which is the human channel under `--events ndjson`.
//!
//! Where it lives, and why not next to the core's log. The core's log path
//! arrives in the `started` event, which means it is not known during exactly
//! the runs worth logging: a refused start, a missing core, a spawn that
//! failed. So the shell log goes to the app's own log directory, which exists
//! before anything is spawned and is inside the footprint the uninstaller
//! already owns. The core's log path is written into the first lines of this
//! file the moment it is known, so one file always points at the other.
//!
//! Writes are synchronous for the same reason the core's are: the interesting
//! run is the one that ended badly, and a buffered stream loses the tail.
//!
//! Redaction is a second lock on a door the core already locks. The core
//! redacts what goes into its own file; this file also carries the core's
//! stderr, which is a different channel, so it is scanned again here. Cheap,
//! and the cost of being wrong once is a token on a disk forever.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Roll at a quarter megabyte and keep one backup. The shell says very little.
const MAX_BYTES: u64 = 256 * 1024;
const BACKUP_SUFFIX: &str = ".1";

/// A size rotating text file that never panics and never blocks on a lock it
/// cannot get.
pub struct ShellLog {
    path: PathBuf,
    file: Mutex<Option<File>>,
}

impl ShellLog {
    /// Open, creating the directory if it is not there. A log that cannot be
    /// opened is not an error worth stopping for: the shell keeps running and
    /// simply says nothing.
    pub fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        let log = Self {
            path,
            file: Mutex::new(file),
        };
        log.line("shell log opened");
        log
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// One line, stamped and redacted.
    pub fn line(&self, message: &str) {
        let stamped = format!("{} {}\n", stamp(), redact(message.trim_end()));
        self.write(&stamped);
    }

    /// A line the core wrote to stderr, marked so the two voices stay apart.
    pub fn core_line(&self, message: &str) {
        let stamped = format!("{} core: {}\n", stamp(), redact(message.trim_end()));
        self.write(&stamped);
    }

    fn write(&self, text: &str) {
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        if guard.is_none() {
            *guard = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .ok();
        }
        let Some(file) = guard.as_mut() else {
            return;
        };
        let _ = file.write_all(text.as_bytes());
        let _ = file.flush();

        if file.metadata().map(|m| m.len()).unwrap_or(0) >= MAX_BYTES {
            *guard = None;
            let backup = with_suffix(&self.path, BACKUP_SUFFIX);
            let _ = fs::remove_file(&backup);
            let _ = fs::rename(&self.path, &backup);
            *guard = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .ok();
        }
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Seconds since the unix epoch, which is enough to order lines and needs no
/// date library. The core's own log carries the readable timestamps.
fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("[{secs}]")
}

/// Things that must never reach the disk.
///
/// The same list the core keeps in `src/commands/logfile.ts`, expressed
/// without a regex engine: whitespace separated tokens are inspected, and a
/// token that carries a Google credential marker or an upload session URL is
/// replaced whole. Hashes and file paths are kept, because a log with the
/// evidence removed answers no questions.
pub fn redact(text: &str) -> String {
    const MARKERS: [&str; 6] = [
        "ya29.",
        "GOCSPX-",
        "upload_id=",
        "/upload/v1/",
        "/v1/uploads",
        "refresh_token",
    ];
    const NAMED: [&str; 7] = [
        "access_token",
        "refresh_token",
        "id_token",
        "client_secret",
        "upload_token",
        "uploadToken",
        "code_verifier",
    ];

    let mut out = String::with_capacity(text.len());
    let mut previous_was_bearer = false;
    for (index, token) in text.split_inclusive(char::is_whitespace).enumerate() {
        let trimmed = token.trim_end();
        let trailing = &token[trimmed.len()..];

        if previous_was_bearer && !trimmed.is_empty() {
            out.push_str("[token removed]");
            out.push_str(trailing);
            previous_was_bearer = false;
            continue;
        }
        previous_was_bearer = trimmed.eq_ignore_ascii_case("bearer");

        let lowered = trimmed.to_ascii_lowercase();
        let hit_marker = MARKERS.iter().any(|m| lowered.contains(&m.to_ascii_lowercase()));
        let hit_named = NAMED.iter().any(|name| {
            let name = name.to_ascii_lowercase();
            lowered.starts_with(&format!("{name}="))
                || lowered.starts_with(&format!("\"{name}\":"))
                || lowered.starts_with(&format!("{name}:"))
        });
        // A bare "1//" prefixed refresh token, which has no other marker.
        let hit_refresh = trimmed.len() > 12 && trimmed.starts_with("1//");

        if hit_marker || hit_named || hit_refresh {
            let _ = index;
            out.push_str("[removed]");
            out.push_str(trailing);
        } else {
            out.push_str(token);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_evidence_and_drops_the_credentials() {
        let redacted = redact("delivered D:\\Photos\\a.jpg hash 9f2c17ab bytes 4194304");
        assert!(redacted.contains("D:\\Photos\\a.jpg"));
        assert!(redacted.contains("9f2c17ab"));

        assert!(!redact("token ya29.a0AfH6SM_long_value_here").contains("ya29."));
        assert!(!redact("secret GOCSPX-abcdefghijklmnop").contains("GOCSPX-"));
        assert!(!redact("refresh 1//0gLongRefreshTokenValue").contains("1//0gLong"));
        assert!(!redact("Authorization: Bearer abcdefghijklmnop").contains("abcdefghij"));
        assert!(
            !redact("POST https://photoslibrary.googleapis.com/v1/uploads?upload_id=AEnB2U")
                .contains("upload_id=AEnB2U")
        );
        assert!(!redact("{\"refresh_token\":\"1//0gsomething\"}").contains("0gsomething"));
    }

    #[test]
    fn redaction_leaves_ordinary_prose_alone() {
        let line = "another copy is already watching. Process 71608 started at 09:12.";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn writes_and_rotates() {
        let dir = std::env::temp_dir().join(format!(
            "photo-pigeon-shell-log-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("tray.log");
        let log = ShellLog::open(path.clone());
        log.line("hello");
        assert!(path.is_file());
        assert!(fs::read_to_string(&path).unwrap().contains("hello"));

        let filler = "x".repeat(1024);
        for _ in 0..(MAX_BYTES / 1024 + 2) {
            log.line(&filler);
        }
        assert!(with_suffix(&path, BACKUP_SUFFIX).is_file());
        assert!(fs::metadata(&path).unwrap().len() < MAX_BYTES);

        let _ = fs::remove_dir_all(&dir);
    }
}
