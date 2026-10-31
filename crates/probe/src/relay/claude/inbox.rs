//! Relay messages a terminal Claude Code session holds in its inbox without
//! reading them.
//!
//! A message written to a session's inbox socket (`send_to_terminal`) is
//! delivered: Claude Code has it. It reads it only at a turn boundary, so a
//! session whose turn never ends keeps every later message queued while the
//! roster still shows it active. Claude Code records its queue in the
//! session's transcript:
//!
//! ```text
//! {"type":"queue-operation","operation":"enqueue","timestamp":"…","sessionId":"…","content":"[via Agent Relay — from @x · ref <ref>]…"}
//! {"type":"queue-operation","operation":"dequeue","timestamp":"…","sessionId":"…"}
//! {"type":"queue-operation","operation":"remove","timestamp":"…","sessionId":"…","content":"…","reason":"absorbed_mid_turn"}
//! ```
//!
//! An enqueue carries the message; a dequeue carries nothing, so it cannot
//! be paired with one message. A `dequeue` or `remove` after a message's
//! enqueue therefore counts as the queue draining past it, and any `user` or
//! `assistant` entry counts as the session making progress. A message still
//! queued after the session has made no progress for the threshold leaves
//! the session stalled. Only the transcript's tail is read; delivery itself
//! is unchanged.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

/// How much of a transcript's end is read. Transcripts run to many
/// megabytes; the queue operations that matter are the latest ones.
pub const TAIL_BYTES: u64 = 256 * 1024;

/// How long a session may hold a relay message without any progress before
/// it is reported stalled.
pub const DEFAULT_THRESHOLD: Duration = Duration::from_secs(10 * 60);

/// The environment variable that changes the threshold, in seconds.
pub const THRESHOLD_ENV: &str = "RELAY_DESKTOP_CLAUDE_INBOX_STALL_SECS";

/// The most injections remembered per session; later ones are not tracked,
/// and the oldest, which decide the stall, are kept.
pub const MAX_TRACKED: usize = 256;

/// One message written to a session's inbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Injection {
    /// The twelve-hex reference its attribution line carries.
    pub reference: String,
    pub injected_at_ms: i64,
}

/// A session holding relay messages it has not read, as `agents.list` and
/// the session socket's `GET /agents` report it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InboxStall {
    /// Relay messages still waiting for the session to consume them.
    pub undrained_count: u32,
    /// How long the oldest of them has waited.
    pub oldest_undrained_age_ms: i64,
}

/// What a transcript's tail says about the injections still tracked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assessment {
    /// The injections the queue has not drained past, oldest first.
    pub undrained: Vec<Injection>,
    /// The latest progress the session recorded: a dequeue, a removal, or a
    /// `user` or `assistant` entry.
    pub last_progress_ms: Option<i64>,
}

/// The last `max` bytes of `path`, and whether the read began past the
/// file's start (so its first line may be partial).
pub fn read_tail(path: &Path, max: u64) -> std::io::Result<(Vec<u8>, bool)> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.take(max).read_to_end(&mut bytes)?;
    Ok((bytes, start > 0))
}

enum Kind {
    Enqueue(String),
    Drain,
    Activity,
    Other,
}

struct Entry {
    kind: Kind,
    at_ms: Option<i64>,
}

fn entries(tail: &[u8], truncated: bool) -> Vec<Entry> {
    let mut lines = tail.split(|b| *b == b'\n');
    if truncated {
        // The read began mid-file: the first line is likely a fragment.
        lines.next();
    }
    lines
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .map(|entry| {
            let at_ms = entry["timestamp"].as_str().and_then(crate::parse_iso_ms);
            let kind = match (entry["type"].as_str(), entry["operation"].as_str()) {
                (Some("queue-operation"), Some("enqueue")) => {
                    Kind::Enqueue(entry["content"].as_str().unwrap_or_default().to_string())
                }
                (Some("queue-operation"), Some("dequeue" | "remove")) => Kind::Drain,
                (Some("user" | "assistant"), _) => Kind::Activity,
                _ => Kind::Other,
            };
            Entry { kind, at_ms }
        })
        .collect()
}

/// Which of `pending` the transcript tail shows drained. An injection whose
/// enqueue is in the tail is drained by a later dequeue or removal; one whose
/// enqueue is not (not yet written, or already past the tail) by a dequeue
/// or removal recorded at or after it was injected. Lines that do not parse,
/// such as one still being written, are skipped.
pub fn assess(tail: &[u8], truncated: bool, pending: &[Injection]) -> Assessment {
    let entries = entries(tail, truncated);
    let last_progress_ms = entries
        .iter()
        .filter(|e| matches!(e.kind, Kind::Drain | Kind::Activity))
        .filter_map(|e| e.at_ms)
        .max();
    let undrained = pending
        .iter()
        .filter(|injection| {
            let marker = format!("ref {}", injection.reference);
            let enqueued = entries.iter().rposition(
                |e| matches!(&e.kind, Kind::Enqueue(content) if content.contains(&marker)),
            );
            let drained = match enqueued {
                Some(at) => entries[at + 1..]
                    .iter()
                    .any(|e| matches!(e.kind, Kind::Drain)),
                None => entries.iter().any(|e| {
                    matches!(e.kind, Kind::Drain)
                        && e.at_ms.is_some_and(|at| at >= injection.injected_at_ms)
                }),
            };
            !drained
        })
        .cloned()
        .collect();
    Assessment {
        undrained,
        last_progress_ms,
    }
}

/// Those of `refs` whose message the transcript tail shows reached Claude:
/// queued for it or recorded as a prompt. A held message's preview in Claude
/// Code's own notice does not count.
pub fn reached(tail: &[u8], truncated: bool, refs: &[String]) -> Vec<String> {
    let mut lines = tail.split(|b| *b == b'\n');
    if truncated {
        lines.next();
    }
    let contents: Vec<String> = lines
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter_map(|entry| match entry["type"].as_str() {
            Some("queue-operation") => entry["content"].as_str().map(str::to_string),
            Some("user") => Some(entry["message"]["content"].to_string()),
            _ => None,
        })
        .collect();
    refs.iter()
        .filter(|reference| {
            let marker = format!("ref {reference}");
            contents.iter().any(|content| content.contains(&marker))
        })
        .cloned()
        .collect()
}

/// The session's latest permission mode in the transcript tail. Claude Code
/// records each change as its own entry and each typed prompt's mode on the
/// prompt:
///
/// ```text
/// {"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"…"}
/// {"type":"user","permissionMode":"default","message":{…},…}
/// ```
pub fn permission_mode(tail: &[u8], truncated: bool) -> Option<String> {
    let mut lines = tail.split(|b| *b == b'\n');
    if truncated {
        lines.next();
    }
    lines
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|entry| matches!(entry["type"].as_str(), Some("permission-mode" | "user")))
        .filter_map(|entry| entry["permissionMode"].as_str().map(str::to_string))
        .last()
}

/// Whether the session is stalled at `now_ms`: a message is still queued
/// and nothing has progressed for `threshold` since the later of its
/// injection and the session's last progress.
pub fn evaluate(assessment: &Assessment, now_ms: i64, threshold: Duration) -> Option<InboxStall> {
    let oldest = assessment
        .undrained
        .iter()
        .map(|i| i.injected_at_ms)
        .min()?;
    let quiet_since = assessment
        .last_progress_ms
        .map_or(oldest, |p| p.max(oldest));
    let threshold_ms = i64::try_from(threshold.as_millis()).unwrap_or(i64::MAX);
    (now_ms.saturating_sub(quiet_since) >= threshold_ms).then(|| InboxStall {
        undrained_count: u32::try_from(assessment.undrained.len()).unwrap_or(u32::MAX),
        oldest_undrained_age_ms: now_ms.saturating_sub(oldest),
    })
}

/// What the core remembers of one session's inbox: the injections not yet
/// seen drained and the stall last found.
#[derive(Clone, Debug, Default)]
pub struct Watch {
    pub session_id: String,
    /// Oldest first.
    pub pending: Vec<Injection>,
    /// The stall the last check found, and when it checked.
    pub stall: Option<(InboxStall, i64)>,
    /// Checked on the next pass whatever its schedule.
    pub due: bool,
    pub checked_at: Option<std::time::Instant>,
}

impl Watch {
    /// Records a message just written to `session_id`'s inbox. A session
    /// other than the one watched starts the watch over.
    pub fn injected(&mut self, session_id: &str, injection: Injection) {
        if self.session_id != session_id {
            *self = Watch {
                session_id: session_id.to_string(),
                ..Watch::default()
            };
        }
        if self.pending.len() < MAX_TRACKED {
            self.pending.push(injection);
        }
        self.due = true;
    }

    /// Applies a check of `checked` (the pending injections when it began):
    /// those it found drained are dropped, injections recorded meanwhile are
    /// kept. Returns the stall before and after.
    pub fn settle(
        &mut self,
        checked: &[Injection],
        undrained: &[Injection],
        stall: Option<InboxStall>,
        now_ms: i64,
    ) -> (Option<InboxStall>, Option<InboxStall>) {
        self.pending
            .retain(|i| !checked.contains(i) || undrained.contains(i));
        let before = self.stall.take().map(|(stall, _)| stall);
        self.stall = stall.clone().map(|stall| (stall, now_ms));
        (before, stall)
    }

    /// The stall as of `now_ms`, its age carried forward from the check.
    pub fn report(&self, now_ms: i64) -> Option<InboxStall> {
        self.stall.as_ref().map(|(stall, at)| InboxStall {
            undrained_count: stall.undrained_count,
            oldest_undrained_age_ms: stall.oldest_undrained_age_ms + (now_ms - at).max(0),
        })
    }
}

/// The threshold `THRESHOLD_ENV` sets, else the default. Zero or a value
/// that is not a whole number of seconds keeps the default.
pub fn threshold_from_env(env: &dyn Fn(&str) -> Option<String>) -> Duration {
    env(THRESHOLD_ENV)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_THRESHOLD)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "cdc14b45-4caf-4f46-8928-2bc320683bce";
    const REF: &str = "490b1d296e45";
    // 2026-10-19T06:20:00.000Z
    const ENQUEUED_MS: i64 = 1_792_390_800_000;
    const MINUTE: i64 = 60_000;
    const THRESHOLD: Duration = DEFAULT_THRESHOLD;

    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }

    fn enqueue(reference: &str, at: i64) -> String {
        serde_json::json!({
            "type": "queue-operation",
            "operation": "enqueue",
            "timestamp": iso(at),
            "sessionId": SESSION,
            "content": format!(
                "[via Agent Relay — from @claude-agentrelay-com-efef42 (claude-agentrelay-com-efef42@adas-laptop-233452575984484352) to @claude-fathom-833f26 · message 233850713280172032 · ref {reference}]\n[reply: curl -s …]\nhello"
            ),
        })
        .to_string()
    }

    fn dequeue(at: i64) -> String {
        format!(
            r#"{{"type":"queue-operation","operation":"dequeue","timestamp":"{}","sessionId":"{SESSION}"}}"#,
            iso(at)
        )
    }

    fn remove(at: i64) -> String {
        format!(
            r#"{{"type":"queue-operation","operation":"remove","timestamp":"{}","sessionId":"{SESSION}","content":"astra -- is codex","reason":"absorbed_mid_turn"}}"#,
            iso(at)
        )
    }

    fn entry(kind: &str, at: i64) -> String {
        format!(
            r#"{{"type":"{kind}","timestamp":"{}","sessionId":"{SESSION}","message":{{"role":"{kind}","content":"working"}}}}"#,
            iso(at)
        )
    }

    fn transcript(lines: &[String]) -> Vec<u8> {
        let mut text = lines.join("\n");
        text.push('\n');
        text.into_bytes()
    }

    fn injected(reference: &str, at: i64) -> Injection {
        Injection {
            reference: reference.into(),
            injected_at_ms: at,
        }
    }

    fn stall_at(tail: &[u8], pending: &[Injection], now: i64) -> Option<InboxStall> {
        evaluate(&assess(tail, false, pending), now, THRESHOLD)
    }

    #[test]
    fn an_undrained_enqueue_past_the_threshold_is_stalled() {
        let tail = transcript(&[
            entry("assistant", ENQUEUED_MS - 5 * MINUTE),
            enqueue(REF, ENQUEUED_MS + 20),
            enqueue("0123456789ab", ENQUEUED_MS + 3 * MINUTE),
        ]);
        let pending = [
            injected(REF, ENQUEUED_MS),
            injected("0123456789ab", ENQUEUED_MS + 3 * MINUTE),
        ];
        assert_eq!(stall_at(&tail, &pending, ENQUEUED_MS + 9 * MINUTE), None);
        assert_eq!(
            stall_at(&tail, &pending, ENQUEUED_MS + 12 * 60 * MINUTE),
            Some(InboxStall {
                undrained_count: 2,
                oldest_undrained_age_ms: 12 * 60 * MINUTE,
            })
        );
    }

    #[test]
    fn a_dequeue_after_the_enqueue_drains_it() {
        let tail = transcript(&[
            enqueue(REF, ENQUEUED_MS + 20),
            dequeue(ENQUEUED_MS + 40),
            entry("user", ENQUEUED_MS + 60),
        ]);
        let pending = [injected(REF, ENQUEUED_MS)];
        let assessment = assess(&tail, false, &pending);
        assert!(assessment.undrained.is_empty());
        assert_eq!(
            evaluate(&assessment, ENQUEUED_MS + 60 * MINUTE, THRESHOLD),
            None
        );
    }

    #[test]
    fn a_removal_after_the_enqueue_drains_it() {
        let tail = transcript(&[enqueue(REF, ENQUEUED_MS + 20), remove(ENQUEUED_MS + 40)]);
        let pending = [injected(REF, ENQUEUED_MS)];
        assert!(assess(&tail, false, &pending).undrained.is_empty());
    }

    #[test]
    fn a_dequeue_before_the_enqueue_does_not_drain_it() {
        // Claude Code can record a dequeue in the same millisecond as an
        // earlier enqueue: order in the file decides, not the timestamp.
        let tail = transcript(&[dequeue(ENQUEUED_MS + 20), enqueue(REF, ENQUEUED_MS + 20)]);
        let pending = [injected(REF, ENQUEUED_MS)];
        assert_eq!(assess(&tail, false, &pending).undrained, pending);
    }

    #[test]
    fn recent_assistant_activity_is_not_a_stall() {
        // A long turn still working: the message waits, but the session
        // is making progress.
        let tail = transcript(&[
            enqueue(REF, ENQUEUED_MS + 20),
            entry("assistant", ENQUEUED_MS + 25 * MINUTE),
            entry("user", ENQUEUED_MS + 28 * MINUTE),
        ]);
        let pending = [injected(REF, ENQUEUED_MS)];
        assert_eq!(stall_at(&tail, &pending, ENQUEUED_MS + 30 * MINUTE), None);
        // The same turn, silent for the threshold since, is stalled.
        let stall = stall_at(&tail, &pending, ENQUEUED_MS + 38 * MINUTE).unwrap();
        assert_eq!(stall.undrained_count, 1);
        assert_eq!(stall.oldest_undrained_age_ms, 38 * MINUTE);
    }

    #[test]
    fn a_malformed_or_partial_last_line_is_tolerated() {
        let mut tail = transcript(&[
            "not json at all".to_string(),
            enqueue(REF, ENQUEUED_MS + 20),
        ]);
        tail.extend_from_slice(br#"{"type":"queue-operation","operation":"deq"#);
        let pending = [injected(REF, ENQUEUED_MS)];
        let stall = stall_at(&tail, &pending, ENQUEUED_MS + 11 * MINUTE).unwrap();
        assert_eq!(stall.undrained_count, 1);

        let mut drained = transcript(&[enqueue(REF, ENQUEUED_MS + 20), dequeue(ENQUEUED_MS + 30)]);
        drained.extend_from_slice(br#"{"type":"assistant","timest"#);
        assert_eq!(
            stall_at(&drained, &pending, ENQUEUED_MS + 11 * MINUTE),
            None
        );
    }

    #[test]
    fn a_truncated_tail_skips_its_first_fragment() {
        let line = dequeue(ENQUEUED_MS + 30);
        // The fragment, parsed whole, would be the dequeue after injection.
        let mut tail = line.as_bytes()[line.len() / 2..].to_vec();
        tail.push(b'\n');
        tail.extend(transcript(std::slice::from_ref(&line)));
        let pending = [injected(REF, ENQUEUED_MS)];
        assert!(assess(&tail, true, &pending).undrained.is_empty());
        let only_fragment = format!("{line}\n");
        assert_eq!(
            assess(only_fragment.as_bytes(), true, &pending).undrained,
            pending
        );
    }

    #[test]
    fn an_enqueue_past_the_tail_is_drained_by_a_later_dequeue() {
        let tail = transcript(&[dequeue(ENQUEUED_MS - MINUTE), dequeue(ENQUEUED_MS + MINUTE)]);
        let pending = [injected(REF, ENQUEUED_MS)];
        assert!(assess(&tail, false, &pending).undrained.is_empty());
        let earlier = transcript(&[dequeue(ENQUEUED_MS - MINUTE)]);
        assert_eq!(assess(&earlier, false, &pending).undrained, pending);
    }

    #[test]
    fn a_missing_transcript_is_not_a_stall() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join(format!("{SESSION}.jsonl"));
        assert!(read_tail(&missing, TAIL_BYTES).is_err());
        // With nothing to assess there is nothing to report.
        let nothing = Assessment {
            undrained: Vec::new(),
            last_progress_ms: None,
        };
        assert_eq!(
            evaluate(&nothing, ENQUEUED_MS + 600 * MINUTE, THRESHOLD),
            None
        );
    }

    #[test]
    fn the_tail_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{SESSION}.jsonl"));
        let filler = entry("assistant", ENQUEUED_MS - 60 * MINUTE);
        let mut lines: Vec<String> = std::iter::repeat_n(filler, 2000).collect();
        lines.push(enqueue(REF, ENQUEUED_MS + 20));
        std::fs::write(&path, transcript(&lines)).unwrap();
        let (tail, truncated) = read_tail(&path, 4096).unwrap();
        assert_eq!(tail.len(), 4096);
        assert!(truncated);
        let pending = [injected(REF, ENQUEUED_MS)];
        let stall = evaluate(
            &assess(&tail, truncated, &pending),
            ENQUEUED_MS + 11 * MINUTE,
            THRESHOLD,
        );
        assert_eq!(stall.map(|s| s.undrained_count), Some(1));
        let (whole, truncated) = read_tail(&path, u64::MAX).unwrap();
        assert!(!truncated);
        assert_eq!(whole.len() as u64, std::fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn a_watch_keeps_injections_recorded_during_a_check() {
        let mut watch = Watch::default();
        let first = injected(REF, ENQUEUED_MS);
        let second = injected("0123456789ab", ENQUEUED_MS + MINUTE);
        watch.injected(SESSION, first.clone());
        let checked = watch.pending.clone();
        watch.injected(SESSION, second.clone());
        let stall = InboxStall {
            undrained_count: 1,
            oldest_undrained_age_ms: 11 * MINUTE,
        };
        let now = ENQUEUED_MS + 11 * MINUTE;
        let (before, after) = watch.settle(
            &checked,
            std::slice::from_ref(&first),
            Some(stall.clone()),
            now,
        );
        assert_eq!((before, after), (None, Some(stall)));
        assert_eq!(watch.pending, vec![first.clone(), second.clone()]);
        assert_eq!(
            watch.report(now + MINUTE).unwrap().oldest_undrained_age_ms,
            12 * MINUTE
        );
        // Drained: the flag clears.
        let checked = watch.pending.clone();
        let (before, after) = watch.settle(&checked, &[], None, now + 2 * MINUTE);
        assert!(before.is_some() && after.is_none());
        assert!(watch.pending.is_empty() && watch.report(now).is_none());
        // Another session starts over.
        watch.injected(SESSION, second.clone());
        watch.injected("8f1c1a52-0c55-4a59-9d55-6d2d3c8b1f00", first.clone());
        assert_eq!(watch.pending, vec![first]);
    }

    #[test]
    fn a_held_message_reaches_claude_once_queued_or_prompted() {
        let held = r#"{"type":"system","subtype":"informational","content":"Held peer message — preview: «[via Agent Relay — from @x · ref 490b1d296e45]» — not delivered to Claude"}"#;
        let refs = vec![REF.to_string()];
        assert!(reached(&transcript(&[held.to_string()]), false, &refs).is_empty());
        let queued = transcript(&[held.to_string(), enqueue(REF, ENQUEUED_MS)]);
        assert_eq!(reached(&queued, false, &refs), refs);
        let prompt = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"Another Claude session sent a message:\n[via Agent Relay — from @x · ref {REF}]\nhi"}}}}"#
        );
        assert_eq!(reached(&transcript(&[prompt]), false, &refs), refs);
    }

    #[test]
    fn the_latest_recorded_permission_mode_is_read() {
        let tail = transcript(&[
            r#"{"type":"permission-mode","permissionMode":"default","sessionId":"s"}"#.to_string(),
            r#"{"type":"user","permissionMode":"bypassPermissions","message":{"role":"user","content":"go"}}"#.to_string(),
            r#"{"type":"assistant","permissionMode":"plan","message":{"role":"assistant","content":"ok"}}"#.to_string(),
            enqueue(REF, ENQUEUED_MS),
        ]);
        assert_eq!(
            permission_mode(&tail, false).as_deref(),
            Some("bypassPermissions")
        );
        let changed = transcript(&[
            r#"{"type":"user","permissionMode":"bypassPermissions","message":{"role":"user","content":"go"}}"#.to_string(),
            r#"{"type":"permission-mode","permissionMode":"acceptEdits","sessionId":"s"}"#.to_string(),
        ]);
        assert_eq!(
            permission_mode(&changed, false).as_deref(),
            Some("acceptEdits")
        );
        // The fragment a truncated read starts with is skipped.
        let fragment = br#"{"type":"permission-mode","permissionMode":"bypassPermissions"}
"#;
        assert_eq!(permission_mode(fragment, true), None);
        assert_eq!(
            permission_mode(&transcript(&[dequeue(ENQUEUED_MS)]), false),
            None
        );
    }

    #[test]
    fn the_threshold_comes_from_the_environment() {
        let set =
            |value: &'static str| move |key: &str| (key == THRESHOLD_ENV).then(|| value.into());
        assert_eq!(threshold_from_env(&|_| None), DEFAULT_THRESHOLD);
        assert_eq!(threshold_from_env(&set("90")), Duration::from_secs(90));
        assert_eq!(threshold_from_env(&set("0")), DEFAULT_THRESHOLD);
        assert_eq!(threshold_from_env(&set("ten")), DEFAULT_THRESHOLD);
    }
}
