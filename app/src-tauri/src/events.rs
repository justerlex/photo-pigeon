//! The core's NDJSON stream, framed and parsed.
//!
//! Two jobs, kept apart on purpose so both can be tested without a child
//! process anywhere near them:
//!
//!   * [`LineAssembler`] turns whatever bytes arrive on the pipe into whole
//!     lines. TRAY-DESIGN section 2 note 2 left the shell plugin's line
//!     splitting as an open question with a stated fallback ("buffer and split
//!     on the Rust side instead"). This is that fallback, taken up front, so
//!     the 64 KB line the M0 table never got to measure arrives whole by
//!     construction rather than by a library's good manners.
//!   * [`parse_line`] turns one line into a [`CoreEvent`].
//!
//! Strict means the line must be JSON and must be an object carrying a string
//! `type`. It does not mean unknown fields are fatal: the core and the shell
//! ship lockstep, but a shell that dies on a field it has not met yet is a
//! shell that dies on the next release rather than ignoring one word. An
//! unrecognised `type` is reported and dropped, never fatal.
//!
//! The shapes below are copied from `WatchEventBody` in
//! `src/commands/watch.ts`, which is the authority. The envelope key is `type`
//! and every event carries `at`.

use serde::Deserialize;

/// A single event's payload. Unknown members land in [`CoreEvent::Unknown`].
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum CoreEvent {
    /// The run is up. Everything the menu needs, once.
    #[serde(rename_all = "camelCase")]
    Started {
        #[serde(default)]
        pid: Option<u32>,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        watch_dirs: Vec<String>,
        #[serde(default)]
        album: Option<String>,
        #[serde(default)]
        dry_run: bool,
        #[serde(default)]
        once: bool,
        #[serde(default)]
        ledger_path: Option<String>,
        #[serde(default)]
        lock_path: Option<String>,
        #[serde(default)]
        log_path: Option<String>,
    },
    /// The startup reconciliation walk is running.
    Scanning {
        #[serde(default)]
        dirs: Vec<String>,
    },
    /// Work is flowing: after the scan, and again when a quota pause lifts.
    Delivering {
        #[serde(default)]
        found: u64,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Google confirmed a media item. The one event that means a photo arrived.
    ///
    /// `first_ever` is the whole of "the very first photo ever", and the
    /// project rule is that it means the ledger was empty before this
    /// delivery. It arrives on the wire because it cannot be worked out here:
    /// the core writes the ledger entry and *then* reports the delivery, so a
    /// shell reading the ledger on receipt of this event sees a count of one
    /// on a virgin install's first photo and never sees zero again. A
    /// condition written on this side would be false on the first delivery and
    /// false forever after, and the one happy toast would be dead for
    /// everybody.
    ///
    /// `#[serde(default)]` is what makes the field backward compatible in the
    /// direction that matters: a core one version behind omits it, this
    /// deserializes it as `false`, and every delivery reads as an ordinary
    /// one. Absent means "not the first", never "unknown", because the core
    /// omits the field rather than writing `false`.
    #[serde(rename_all = "camelCase")]
    Delivered {
        path: String,
        #[serde(default)]
        bytes: u64,
        #[serde(default)]
        media_item_id: Option<String>,
        #[serde(default)]
        first_ever: bool,
    },
    /// The ledger already had these bytes.
    Skipped {
        path: String,
        #[serde(default)]
        reason: Option<String>,
    },
    /// One file did not make it, or, with no `path`, the run itself did not.
    Failed {
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        error: String,
    },
    // `PausedQuota` was here and is gone at M4, in the same commit that deleted
    // the core's legacy emit and the test that pinned it. It was the M2-era
    // shape for a quota hold, kept for one milestone so an unmigrated shell
    // would not go blind. The M3 integration finding is why it did not get a
    // second milestone: the core said it *and* this side parsed it, each
    // decision right on its own, and together they handed one spent budget to
    // the user as two identical toasts. **A compatibility layer on each side of
    // a seam is not two safety nets, it is a duplicate.** `paused` with
    // `reason: "quota"` is the one shape now, and a line saying `paused-quota`
    // parses as `Unknown` and is logged, which is what should happen to a word
    // this build does not speak.
    /// M3: intake is closed and the queue is held, and the run is still alive.
    ///
    /// `reason` is what tells a quota pause from a user pause, and they are
    /// different states in the tray: amber and worth looking at, against grey
    /// and asked for. A `paused` with no reason is read as a user pause,
    /// because a quota pause always has one to give.
    #[serde(rename_all = "camelCase")]
    Paused {
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        resumes_at: Option<String>,
    },
    /// M3: intake is open again.
    Resumed {
        #[serde(default)]
        reason: Option<String>,
    },
    /// M3: the detach was understood.
    ///
    /// The event that makes the second Quit press honest. It says the core has
    /// accepted that the shell is leaving and will finish the drain as an
    /// orphan, which means the end of file that follows the shell's exit is not
    /// a second stop and does not cut the batch short.
    Detached,
    /// Sign in is needed and cannot be done from here.
    AuthNeeded {
        #[serde(default)]
        reason: String,
    },
    /// The single instance lock is not safely ours any more.
    #[serde(rename_all = "camelCase")]
    LockLost {
        #[serde(default)]
        reason: String,
        #[serde(default)]
        held_by: Option<u32>,
        #[serde(default)]
        stopping: bool,
    },
    /// A stop was asked for. Intake is closed and the drain has begun.
    Stopping {
        #[serde(default)]
        reason: String,
    },
    /// The last event of a run, always.
    #[serde(rename_all = "camelCase")]
    Stopped {
        #[serde(default)]
        exit_code: i32,
        #[serde(default)]
        totals: Option<Totals>,
    },
    /// A `type` this build does not know. Reported once, then ignored.
    #[serde(other)]
    Unknown,
}

/// The counter block a `stopped` event carries.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    #[serde(default)]
    pub seen: u64,
    #[serde(default)]
    pub skipped: u64,
    #[serde(default)]
    pub delivered: u64,
    #[serde(default)]
    pub would_upload: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub requests: u64,
    #[serde(default)]
    pub dropped: u64,
    #[serde(default)]
    pub deferred: u64,
}

/// One parsed line, with the ISO moment the core stamped on it.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreLine {
    pub at: Option<String>,
    pub event: CoreEvent,
    /// The value of `type` exactly as it arrived. Kept for the log, and the
    /// only way to name an [`CoreEvent::Unknown`] in a support question.
    pub kind: String,
}

/// What one line of stdout turned out to be.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedLine {
    /// A well formed event.
    Event(CoreLine),
    /// Valid JSON, wrong shape, or not JSON at all. The string says which.
    Rejected(String),
}

/// Parse one line. `None` means the line was blank and carried nothing.
///
/// The core promises that under `--events ndjson` stdout carries nothing but
/// events, so anything rejected here is either a bug in the core or somebody
/// else writing to the pipe. Either way it is logged and the run continues:
/// a tray that exits because it met a stray line is worse than a tray that
/// notes it.
pub fn parse_line(line: &str) -> Option<ParsedLine> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(err) => return Some(ParsedLine::Rejected(format!("not JSON: {err}"))),
    };

    let object = match value.as_object() {
        Some(object) => object,
        None => return Some(ParsedLine::Rejected("not a JSON object".into())),
    };

    let kind = match object.get("type").and_then(|t| t.as_str()) {
        Some(kind) => kind.to_string(),
        None => return Some(ParsedLine::Rejected("no string \"type\" member".into())),
    };

    let at = object
        .get("at")
        .and_then(|a| a.as_str())
        .map(|a| a.to_string());

    match serde_json::from_value::<CoreEvent>(value) {
        Ok(event) => Some(ParsedLine::Event(CoreLine { at, event, kind })),
        Err(err) => Some(ParsedLine::Rejected(format!("{kind}: {err}"))),
    }
}

/// The largest single line this shell will hold before giving up on it.
///
/// The core's biggest real line today is `started`, around 700 bytes. The
/// worst case the design names is a long path list or a long failure string,
/// which is why the ceiling is a megabyte and not a kilobyte: 64 KB has to
/// pass without a thought.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Bytes in, whole lines out.
///
/// Handles both shapes a pipe can hand over: several lines glued into one
/// chunk, and one line split across chunks. A line longer than
/// [`MAX_LINE_BYTES`] is dropped rather than buffered forever, and the drop is
/// reported so it cannot be silent.
#[derive(Debug, Default)]
pub struct LineAssembler {
    buffer: Vec<u8>,
    overlong: bool,
}

/// One thing an assembler produced.
#[derive(Debug, Clone, PartialEq)]
pub enum Framed {
    Line(String),
    /// A line past the ceiling was thrown away. Carries how many bytes.
    Dropped(usize),
}

impl LineAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk. Returns every line it completed, in order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Framed> {
        let mut out = Vec::new();
        for &byte in chunk {
            if byte == b'\n' {
                if self.overlong {
                    out.push(Framed::Dropped(self.buffer.len()));
                    self.overlong = false;
                } else {
                    out.push(Framed::Line(decode(&self.buffer)));
                }
                self.buffer.clear();
                continue;
            }
            if self.buffer.len() >= MAX_LINE_BYTES {
                self.overlong = true;
                continue;
            }
            self.buffer.push(byte);
        }
        out
    }

    /// Everything still held when the pipe closed, if the core's last line had
    /// no newline on it. Never lose the final `stopped`.
    pub fn finish(&mut self) -> Option<Framed> {
        if self.buffer.is_empty() && !self.overlong {
            return None;
        }
        let out = if self.overlong {
            Framed::Dropped(self.buffer.len())
        } else {
            Framed::Line(decode(&self.buffer))
        };
        self.buffer.clear();
        self.overlong = false;
        Some(out)
    }
}

/// Never assume a line is valid UTF-8 just because a filename usually is.
/// TRAY-DESIGN section 2, note 1.
fn decode(bytes: &[u8]) -> String {
    let end = if bytes.last() == Some(&b'\r') {
        bytes.len() - 1
    } else {
        bytes.len()
    };
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lines copied out of a real run, exactly as TRAY-DESIGN section 2 records
    /// them. If the core changes shape, these are what fail first.
    const STARTED: &str = r#"{"type":"started","pid":81992,"version":"0.1.0","watchDirs":["D:\\Photos"],"album":"Camera","dryRun":false,"once":false,"ledgerPath":"C:\\Users\\casey\\.photo-pigeon\\ledger.jsonl","lockPath":"C:\\Users\\casey\\.photo-pigeon\\watch.lock","logPath":"C:\\Users\\casey\\.photo-pigeon\\watch.log","at":"2026-07-28T18:58:13.730Z"}"#;

    fn event_of(line: &str) -> CoreLine {
        match parse_line(line) {
            Some(ParsedLine::Event(parsed)) => parsed,
            other => panic!("expected an event, got {other:?}"),
        }
    }

    #[test]
    fn parses_started_with_every_member() {
        let parsed = event_of(STARTED);
        assert_eq!(parsed.kind, "started");
        assert_eq!(parsed.at.as_deref(), Some("2026-07-28T18:58:13.730Z"));
        match parsed.event {
            CoreEvent::Started {
                pid,
                watch_dirs,
                ledger_path,
                log_path,
                dry_run,
                once,
                ..
            } => {
                assert_eq!(pid, Some(81992));
                assert_eq!(watch_dirs, vec!["D:\\Photos".to_string()]);
                assert_eq!(
                    ledger_path.as_deref(),
                    Some("C:\\Users\\casey\\.photo-pigeon\\ledger.jsonl")
                );
                assert_eq!(
                    log_path.as_deref(),
                    Some("C:\\Users\\casey\\.photo-pigeon\\watch.log")
                );
                assert!(!dry_run);
                assert!(!once);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn parses_the_rest_of_the_union() {
        assert!(matches!(
            event_of(r#"{"type":"scanning","dirs":["D:\\Photos"],"at":"x"}"#).event,
            CoreEvent::Scanning { .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"delivering","found":12,"reason":"scan","at":"x"}"#).event,
            CoreEvent::Delivering { found: 12, .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"delivered","path":"a.jpg","hash":"9f","bytes":4194304,"mediaItemId":"AF","at":"x"}"#).event,
            CoreEvent::Delivered { bytes: 4194304, .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"skipped","path":"a.jpg","hash":"1a","reason":"already-delivered","at":"x"}"#).event,
            CoreEvent::Skipped { .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"failed","path":"c.mov","error":"too big","at":"x"}"#).event,
            CoreEvent::Failed { path: Some(_), .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"auth-needed","reason":"invalid_grant","at":"x"}"#).event,
            CoreEvent::AuthNeeded { .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"lock-lost","reason":"stolen","heldBy":71608,"stopping":true,"at":"x"}"#).event,
            CoreEvent::LockLost { held_by: Some(71608), stopping: true, .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"stopping","reason":"stdin","at":"x"}"#).event,
            CoreEvent::Stopping { .. }
        ));
    }

    #[test]
    fn parses_stopped_with_its_totals() {
        let parsed = event_of(
            r#"{"type":"stopped","exitCode":0,"totals":{"seen":1,"skipped":0,"delivered":0,"wouldUpload":1,"failed":0,"bytes":0,"requests":0,"dropped":0,"deferred":0},"at":"x"}"#,
        );
        match parsed.event {
            CoreEvent::Stopped { exit_code, totals } => {
                assert_eq!(exit_code, 0);
                assert_eq!(totals.unwrap().would_upload, 1);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn stopped_survives_a_run_that_never_started() {
        // The double start path: failed, then stopped, and nothing else.
        let parsed = event_of(r#"{"type":"stopped","exitCode":1,"at":"x"}"#);
        assert!(matches!(
            parsed.event,
            CoreEvent::Stopped {
                exit_code: 1,
                totals: None
            }
        ));
    }

    #[test]
    fn parses_the_three_words_m3_adds() {
        // The shapes the shell asks the core for. Written against what M3's
        // core is gaining, and permissive on purpose: `reason` and `resumesAt`
        // are optional, so a core that sends less than this still parses.
        match event_of(r#"{"type":"paused","reason":"user","at":"x"}"#).event {
            CoreEvent::Paused { reason, resumes_at } => {
                assert_eq!(reason.as_deref(), Some("user"));
                assert_eq!(resumes_at, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match event_of(
            r#"{"type":"paused","reason":"quota","resumesAt":"2026-07-30T00:00:00.000Z","at":"x"}"#,
        )
        .event
        {
            CoreEvent::Paused { reason, resumes_at } => {
                assert_eq!(reason.as_deref(), Some("quota"));
                assert!(resumes_at.is_some());
            }
            other => panic!("wrong variant: {other:?}"),
        }
        assert!(matches!(
            event_of(r#"{"type":"paused","at":"x"}"#).event,
            CoreEvent::Paused { reason: None, .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"resumed","reason":"user","at":"x"}"#).event,
            CoreEvent::Resumed { .. }
        ));
        assert!(matches!(
            event_of(r#"{"type":"detached","at":"x"}"#).event,
            CoreEvent::Detached
        ));
    }

    #[test]
    fn the_legacy_quota_pause_is_a_word_this_build_no_longer_speaks() {
        // The other half of deleting the core's legacy emit, and it has to land
        // in the same commit. Deleting only one side is how the duplicate toast
        // comes back in one direction or the shell goes blind in the other, and
        // this build is the one that speaks `paused` and only `paused`.
        let parsed = event_of(r#"{"type":"paused-quota","reason":"spent","at":"x"}"#);
        assert_eq!(parsed.kind, "paused-quota");
        assert_eq!(parsed.event, CoreEvent::Unknown);
    }

    #[test]
    fn a_delivery_says_whether_it_was_the_first_ever() {
        // The ndjson contract change verdict (b) needs. Present and true on the
        // one delivery that found an empty ledger.
        assert!(matches!(
            event_of(r#"{"type":"delivered","path":"a.jpg","bytes":1,"firstEver":true,"at":"x"}"#)
                .event,
            CoreEvent::Delivered {
                first_ever: true,
                ..
            }
        ));
    }

    #[test]
    fn a_delivery_from_a_core_that_never_heard_of_first_ever_is_an_ordinary_one() {
        // Absent means not the first, never unknown. This is what keeps an
        // older core readable rather than turning every delivery into a maybe.
        assert!(matches!(
            event_of(r#"{"type":"delivered","path":"a.jpg","bytes":1,"at":"x"}"#).event,
            CoreEvent::Delivered {
                first_ever: false,
                ..
            }
        ));
    }

    #[test]
    fn an_unknown_type_is_reported_not_fatal() {
        let parsed = event_of(r#"{"type":"somethingNobodyHasWrittenYet","at":"x"}"#);
        assert_eq!(parsed.kind, "somethingNobodyHasWrittenYet");
        assert_eq!(parsed.event, CoreEvent::Unknown);
    }

    #[test]
    fn a_field_this_build_has_not_met_is_ignored() {
        let parsed = event_of(r#"{"type":"delivered","path":"a.jpg","bytes":1,"somethingNew":42,"at":"x"}"#);
        assert!(matches!(parsed.event, CoreEvent::Delivered { bytes: 1, .. }));
    }

    #[test]
    fn rejects_prose_and_says_why() {
        // Exactly the failure the M1 stage 2 review found: an English sentence
        // on the machine channel. It must never take the shell down.
        assert!(matches!(
            parse_line("another copy is already watching"),
            Some(ParsedLine::Rejected(_))
        ));
        assert!(matches!(
            parse_line("[1,2,3]"),
            Some(ParsedLine::Rejected(_))
        ));
        assert!(matches!(
            parse_line(r#"{"at":"x"}"#),
            Some(ParsedLine::Rejected(_))
        ));
        assert_eq!(parse_line("   "), None);
    }

    #[test]
    fn assembler_splits_a_glued_chunk() {
        let mut assembler = LineAssembler::new();
        let out = assembler.push(b"{\"type\":\"a\"}\n{\"type\":\"b\"}\n");
        assert_eq!(
            out,
            vec![
                Framed::Line("{\"type\":\"a\"}".into()),
                Framed::Line("{\"type\":\"b\"}".into())
            ]
        );
    }

    #[test]
    fn assembler_joins_a_split_line() {
        let mut assembler = LineAssembler::new();
        assert!(assembler.push(b"{\"type\":\"star").is_empty());
        assert!(assembler.push(b"ted\"").is_empty());
        assert_eq!(
            assembler.push(b"}\n"),
            vec![Framed::Line("{\"type\":\"started\"}".into())]
        );
    }

    #[test]
    fn assembler_carries_sixty_four_kilobytes_whole() {
        // The M0 row that was never measured, settled here instead: the shell
        // does its own framing, so there is no ceiling to discover.
        let long = "x".repeat(64 * 1024);
        let line = format!("{{\"type\":\"failed\",\"error\":\"{long}\"}}");
        let mut assembler = LineAssembler::new();
        let mut out = Vec::new();
        // Fed in 512 byte bites, the way a pipe actually delivers it.
        let bytes = format!("{line}\n").into_bytes();
        for chunk in bytes.chunks(512) {
            out.extend(assembler.push(chunk));
        }
        assert_eq!(out, vec![Framed::Line(line.clone())]);
        assert!(matches!(
            parse_line(&line),
            Some(ParsedLine::Event(CoreLine {
                event: CoreEvent::Failed { .. },
                ..
            }))
        ));
    }

    #[test]
    fn assembler_drops_a_runaway_line_loudly() {
        let mut assembler = LineAssembler::new();
        let huge = vec![b'x'; MAX_LINE_BYTES + 10];
        assert!(assembler.push(&huge).is_empty());
        assert_eq!(assembler.push(b"\n"), vec![Framed::Dropped(MAX_LINE_BYTES)]);
        // And it recovers: the next line is fine.
        assert_eq!(
            assembler.push(b"{\"type\":\"stopped\"}\n"),
            vec![Framed::Line("{\"type\":\"stopped\"}".into())]
        );
    }

    #[test]
    fn assembler_hands_back_a_last_line_with_no_newline() {
        let mut assembler = LineAssembler::new();
        assert!(assembler.push(b"{\"type\":\"stopped\"}").is_empty());
        assert_eq!(
            assembler.finish(),
            Some(Framed::Line("{\"type\":\"stopped\"}".into()))
        );
        assert_eq!(assembler.finish(), None);
    }

    #[test]
    fn assembler_strips_a_carriage_return() {
        let mut assembler = LineAssembler::new();
        assert_eq!(
            assembler.push(b"{\"type\":\"stopped\"}\r\n"),
            vec![Framed::Line("{\"type\":\"stopped\"}".into())]
        );
    }

    #[test]
    fn assembler_survives_bytes_that_are_not_utf8() {
        let mut assembler = LineAssembler::new();
        let mut bytes = b"{\"type\":\"delivered\",\"path\":\"".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe]);
        bytes.extend_from_slice(b".jpg\",\"bytes\":1}\n");
        let out = assembler.push(&bytes);
        assert_eq!(out.len(), 1);
        // Lossy decoding leaves valid JSON with replacement characters in the
        // path, which is exactly what we want: an unreadable name is still a
        // delivery worth counting.
        match &out[0] {
            Framed::Line(line) => assert!(matches!(
                parse_line(line),
                Some(ParsedLine::Event(CoreLine {
                    event: CoreEvent::Delivered { .. },
                    ..
                }))
            )),
            other => panic!("expected a line, got {other:?}"),
        }
    }
}
