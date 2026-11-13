//! Advisories a build of the core hands a session as its turn ends
//! ([`TurnEndAdvisories`]): where the core's own stop hook answers, the
//! advisory is added to that answer, once. The core decides nothing about
//! the text; it only carries it, bounded, and says which providers it
//! cannot reach.
//!
//! Hooks the core answers itself (Codex's stop hook, Copilot's stop hook)
//! take and acknowledge the advisory in the core. Hooks that run outside it
//! (Devin's, Cursor CLI's and Claude Code's) ask the session socket:
//!
//! ```text
//! POST /turn-end/take   {"kind", "session_id"}          -> {"text": string|null, "ids": [..]}
//! POST /turn-end/shown  {"kind", "session_id", "ids"}   -> {}
//! ```
//!
//! and acknowledge only once their answer is written.
//!
//! [`TurnEndAdvisories`]: crate::relay::daemon::TurnEndAdvisories
use crate::relay::daemon::{Core, TurnEndAdvisory};
use crate::relay::store::{SessionKind, Target};
use serde_json::{json, Value};

/// The most an advisory's text may be, in bytes; longer text is cut at a
/// char boundary.
pub const MAX_BYTES: usize = 4096;

impl Core {
    /// The advisory `target`'s session should see as its turn ends: the
    /// build's [`TurnEndAdvisories::take`], its text trimmed and bounded, or
    /// `None` (no plugin, nothing to show, or only blank text). Taking is
    /// one-shot; the caller reports a written answer with
    /// [`Core::turn_end_advisory_shown`].
    ///
    /// [`TurnEndAdvisories::take`]: crate::relay::daemon::TurnEndAdvisories::take
    pub fn take_turn_end_advisory(&self, target: &Target) -> Option<TurnEndAdvisory> {
        let advisory = self.plugins.turn_end_advisories.as_deref()?.take(target)?;
        Some(TurnEndAdvisory {
            text: bounded(&advisory.text)?,
            ids: advisory.ids,
        })
    }

    /// The answer carrying `ids` was handed to `target`'s session.
    pub fn turn_end_advisory_shown(&self, target: &Target, ids: &[String]) {
        if let Some(plugin) = self.plugins.turn_end_advisories.as_deref() {
            plugin.shown(target, ids);
        }
    }
}

/// `text` trimmed and cut to [`MAX_BYTES`] at a char boundary; `None` when
/// nothing is left.
pub fn bounded(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut end = text.len().min(MAX_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(text[..end].trim_end().to_string())
}

/// A stop hook's answer with `text` added: a `{"decision":"block"}` answer
/// gets it after its `reason`, as a paragraph of its own; an answer that
/// says nothing (`{}`) becomes `{"decision":"block","reason":text}`. Any
/// other shape is left as it is.
pub fn merge_stop(mut answer: Value, text: &str) -> Value {
    if text.is_empty() {
        return answer;
    }
    if answer.as_object().is_some_and(|object| object.is_empty()) {
        return json!({"decision": "block", "reason": text});
    }
    if answer["decision"] != "block" {
        return answer;
    }
    let reason = match answer["reason"].as_str() {
        Some(reason) if !reason.is_empty() => format!("{reason}\n\n{text}"),
        _ => text.to_string(),
    };
    answer["reason"] = json!(reason);
    answer
}

/// Whether advisories reach a provider's sessions as their turn ends, and
/// how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// Added to the turn's end through the named core hook, while that hook
    /// is on.
    Available(&'static str),
    /// The core has no turn-end hook for this provider.
    Unavailable(&'static str),
}

/// How advisories reach sessions of `kind`. Every kind answers: a provider
/// the core cannot reach says why.
pub fn reach(kind: SessionKind) -> Reach {
    use Reach::{Available, Unavailable};
    match kind {
        SessionKind::Codex => Available("codex_stop_hook (Stop)"),
        SessionKind::Copilot => Available("copilot chat delivery hooks (stop, end_turn)"),
        SessionKind::Devin => Available("devin_direct_delivery (Stop)"),
        SessionKind::CursorCli => Available("cursor_cli hooks (stop, completed)"),
        SessionKind::ClaudeTerminal => Available("claude_session_hook (Stop)"),
        SessionKind::ClaudeCloud => {
            Unavailable("Claude desktop app and claude.ai/code sessions run no local hooks")
        }
        SessionKind::Pi | SessionKind::Omp => {
            Unavailable("the Pi extension delivers only as a new user turn")
        }
        SessionKind::OpenCode | SessionKind::OpenCodeOpen | SessionKind::MuseOpen => {
            Unavailable("the OpenCode plugin delivers only as a new user turn")
        }
        SessionKind::Grok | SessionKind::GrokOpen => {
            Unavailable("Grok ACP sessions deliver only as a new user turn")
        }
        SessionKind::OpenClaw => {
            Unavailable("OpenClaw relay sessions are per sender, not a person's sessions")
        }
        SessionKind::Hermes => {
            Unavailable("Hermes relay sessions are per sender, not a person's sessions")
        }
    }
}

/// Every session kind, for [`reach_report`]. [`reach`] matches each one by
/// name, so a new kind cannot be added without deciding its reach.
pub const KINDS: [SessionKind; 15] = [
    SessionKind::ClaudeTerminal,
    SessionKind::ClaudeCloud,
    SessionKind::Codex,
    SessionKind::Copilot,
    SessionKind::Devin,
    SessionKind::CursorCli,
    SessionKind::Pi,
    SessionKind::Omp,
    SessionKind::OpenCode,
    SessionKind::OpenCodeOpen,
    SessionKind::MuseOpen,
    SessionKind::Grok,
    SessionKind::GrokOpen,
    SessionKind::OpenClaw,
    SessionKind::Hermes,
];

/// [`reach`] for every kind, as `status.get`-style JSON: `{kind:
/// {"available": bool, "via"|"reason": text}}`.
pub fn reach_report() -> Value {
    let mut report = serde_json::Map::new();
    for kind in KINDS {
        report.insert(
            kind.as_str().to_string(),
            match reach(kind) {
                Reach::Available(via) => json!({"available": true, "via": via}),
                Reach::Unavailable(reason) => json!({"available": false, "reason": reason}),
            },
        );
    }
    Value::Object(report)
}

/// The kinds whose hooks run outside the core and ask the session socket
/// (`POST /turn-end/take`). Codex and Copilot are answered in the core.
pub fn served_over_socket(kind: SessionKind) -> bool {
    matches!(
        kind,
        SessionKind::ClaudeTerminal | SessionKind::Devin | SessionKind::CursorCli
    )
}

/// The advisory in a `POST /turn-end/take` answer (`{"data":{"text","ids"}}`),
/// bounded as the core bounds it; `None` when there is none.
pub fn read_take(body: &[u8]) -> Option<TurnEndAdvisory> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    let text = bounded(value["data"]["text"].as_str()?)?;
    let ids = value["data"]["ids"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(TurnEndAdvisory { text, ids })
}

/// A test plugin that hands each queued advisory once and records what was
/// shown.
#[cfg(test)]
pub mod fake {
    use super::*;
    use crate::relay::daemon::TurnEndAdvisories;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Queue {
        pub pending: Mutex<Vec<(Target, TurnEndAdvisory)>>,
        pub taken: Mutex<Vec<Target>>,
        pub shown: Mutex<Vec<(Target, Vec<String>)>>,
    }

    impl Queue {
        pub fn with(target: Target, text: &str, ids: &[&str]) -> Queue {
            let queue = Queue::default();
            queue.pending.lock().unwrap().push((
                target,
                TurnEndAdvisory {
                    text: text.into(),
                    ids: ids.iter().map(|id| id.to_string()).collect(),
                },
            ));
            queue
        }

        pub fn shown(&self) -> Vec<(Target, Vec<String>)> {
            self.shown.lock().unwrap().clone()
        }
    }

    impl TurnEndAdvisories for Queue {
        fn take(&self, target: &Target) -> Option<TurnEndAdvisory> {
            self.taken.lock().unwrap().push(target.clone());
            let mut pending = self.pending.lock().unwrap();
            let at = pending.iter().position(|(t, _)| t == target)?;
            Some(pending.remove(at).1)
        }
        fn shown(&self, target: &Target, ids: &[String]) {
            self.shown
                .lock()
                .unwrap()
                .push((target.clone(), ids.to_vec()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_stop_appends_to_a_block_or_makes_one() {
        assert_eq!(
            merge_stop(json!({}), "Heads up."),
            json!({"decision": "block", "reason": "Heads up."})
        );
        assert_eq!(
            merge_stop(json!({"decision": "block", "reason": "From @a: hi"}), "Heads up."),
            json!({"decision": "block", "reason": "From @a: hi\n\nHeads up."})
        );
        assert_eq!(
            merge_stop(json!({"decision": "block"}), "Heads up."),
            json!({"decision": "block", "reason": "Heads up."})
        );
    }

    #[test]
    fn merge_stop_leaves_other_shapes_and_empty_text_alone() {
        let context = json!({"hookSpecificOutput": {"additionalContext": "x"}});
        assert_eq!(merge_stop(context.clone(), "y"), context);
        let approve = json!({"decision": "approve"});
        assert_eq!(merge_stop(approve.clone(), "y"), approve);
        assert_eq!(merge_stop(json!({}), ""), json!({}));
        assert_eq!(merge_stop(json!(null), "y"), json!(null));
    }

    #[test]
    fn the_text_is_trimmed_and_bounded() {
        assert_eq!(bounded("  \n "), None);
        assert_eq!(bounded(" hi \n").as_deref(), Some("hi"));
        let long = "é".repeat(MAX_BYTES);
        let cut = bounded(&long).unwrap();
        assert!(cut.len() <= MAX_BYTES && cut.chars().all(|c| c == 'é'));
        assert_eq!(cut.len(), MAX_BYTES);
        let odd = format!("a{}", "é".repeat(MAX_BYTES));
        let cut = bounded(&odd).unwrap();
        assert_eq!(cut.len(), MAX_BYTES - 1);
    }

    #[test]
    fn every_kind_reports_its_reach() {
        let report = reach_report();
        assert_eq!(report.as_object().unwrap().len(), KINDS.len());
        for kind in KINDS {
            let row = &report[kind.as_str()];
            let available = row["available"].as_bool().unwrap();
            assert_eq!(available, matches!(reach(kind), Reach::Available(_)));
            let text = if available { &row["via"] } else { &row["reason"] };
            assert!(!text.as_str().unwrap().is_empty(), "{kind:?}");
        }
        for available in ["codex", "copilot", "devin", "cursor-cli", "claude-terminal"] {
            assert_eq!(report[available]["available"], true, "{available}");
        }
        for unavailable in [
            "claude-cloud",
            "pi",
            "omp",
            "opencode",
            "opencode-open",
            "muse-open",
            "grok",
            "grok-open",
            "openclaw",
            "hermes",
        ] {
            assert_eq!(report[unavailable]["available"], false, "{unavailable}");
        }
        // The socket serves exactly the kinds whose hooks run outside the
        // core.
        for kind in KINDS {
            assert_eq!(
                served_over_socket(kind),
                matches!(
                    kind,
                    SessionKind::ClaudeTerminal | SessionKind::Devin | SessionKind::CursorCli
                )
            );
        }
    }

    #[test]
    fn a_take_answer_is_read_and_bounded() {
        assert_eq!(
            read_take(br#"{"data":{"text":" Heads up. ","ids":["a","b"]}}"#),
            Some(TurnEndAdvisory {
                text: "Heads up.".into(),
                ids: vec!["a".into(), "b".into()]
            })
        );
        assert_eq!(read_take(br#"{"data":{"text":null,"ids":[]}}"#), None);
        assert_eq!(read_take(br#"{"data":{"text":"  ","ids":["a"]}}"#), None);
        assert_eq!(read_take(b"not json"), None);
    }
}
