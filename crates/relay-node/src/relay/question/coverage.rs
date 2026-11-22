//! Which kinds of session question escalation reaches: one row per
//! `SessionKind`, the only place that says so. `settings.get` serves the
//! table as `question_escalation_coverage` (a state the apps switch on and
//! a reason they may show) and writes `question_escalation_status` from it.
//!
//! A kind is `covered` only where a question's path is tested against the
//! harness's own wire shape. Every path fails open: a question that cannot
//! be taken over is asked in the session as it would be with escalation
//! off.

use crate::relay::contract::agents::{QuestionCoverage, QuestionCoverageState};
use crate::relay::store::SessionKind;
use serde_json::{Map, Value};

use QuestionCoverageState::{Covered, NotApplicable, NotCovered, Partial};

/// Every kind of session, in the order the table lists them.
pub const KINDS: [SessionKind; 16] = [
    SessionKind::ClaudeTerminal,
    SessionKind::ClaudeCloud,
    SessionKind::Codex,
    SessionKind::CursorCli,
    SessionKind::Copilot,
    SessionKind::OpenCode,
    SessionKind::OpenCodeOpen,
    SessionKind::Grok,
    SessionKind::GrokOpen,
    SessionKind::Devin,
    SessionKind::Droid,
    SessionKind::Pi,
    SessionKind::Omp,
    SessionKind::MuseOpen,
    SessionKind::OpenClaw,
    SessionKind::Hermes,
];

/// One kind's row: its name as people know it, its state and why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Row {
    pub label: &'static str,
    pub state: QuestionCoverageState,
    pub reason: &'static str,
}

/// The row for `kind`. A new kind does not compile until it has one.
pub fn row(kind: SessionKind) -> Row {
    let row = |label, state, reason| Row {
        label,
        state,
        reason,
    };
    match kind {
        SessionKind::ClaudeTerminal => row(
            "Claude Code",
            Covered,
            "AskUserQuestion, in sessions you start and sessions Agent Relay starts, through \
Agent Relay's Claude Code hook (claude_session_hook).",
        ),
        SessionKind::ClaudeCloud => row(
            "Claude Code in the cloud",
            NotCovered,
            "Claude app and claude.ai/code sessions run in the cloud, where Agent Relay's Claude \
Code hook does not run.",
        ),
        SessionKind::Codex => row(
            "Codex",
            Partial,
            "Questions Codex 0.135 or later asks with request_user_input (Plan mode), in a \
terminal Codex and in sessions Agent Relay starts, through Agent Relay's Codex hook \
(codex_stop_hook). An older Codex asks in its dialog. Not verified yet in the Codex app.",
        ),
        SessionKind::CursorCli => row(
            "Cursor CLI",
            NotCovered,
            "Cursor's AskQuestion is asked through Cursor's servers, not as a tool its hooks see, \
so no Cursor hook can take it over.",
        ),
        SessionKind::Copilot => row(
            "Copilot",
            Partial,
            "ask_user, through Agent Relay's Copilot hooks (VS Code on macOS). Its argument names \
are from Copilot's user-input handler, not yet checked against the hook's own payload or in a \
live session.",
        ),
        SessionKind::OpenCode => row(
            "OpenCode",
            NotCovered,
            "Not yet: Agent Relay does not read the question events of the OpenCode server it \
runs.",
        ),
        SessionKind::OpenCodeOpen => row(
            "OpenCode",
            NotCovered,
            "Not yet: Agent Relay's OpenCode plugin does not hand questions over.",
        ),
        SessionKind::Grok | SessionKind::GrokOpen => row(
            "Grok",
            NotCovered,
            "Not yet: Agent Relay's Claude Code hook may reach Grok's ask_user_question, but that \
Grok runs it for that tool and honours its refusal is not yet proven, so Grok asks as usual.",
        ),
        SessionKind::Devin => row(
            "Devin",
            Partial,
            "ask_user_question, through Agent Relay's Devin hooks (devin_direct_delivery), which \
are off until turned on; not where Devin's config holds a PreToolUse value that is not a list. \
Its argument names are read from the Devin CLI itself; not yet proven in a live session.",
        ),
        SessionKind::Droid => row(
            "Droid",
            NotCovered,
            "Not yet: Agent Relay answers droid.ask_user as unsupported, so Droid asks as usual.",
        ),
        SessionKind::Pi => row(
            "Pi",
            NotCovered,
            "Not yet. Pi has no built-in ask tool; a question tool comes from an extension.",
        ),
        SessionKind::Omp => row(
            "Oh My Pi",
            NotCovered,
            "Not yet: Agent Relay's extension does not hand omp's ask tool over.",
        ),
        SessionKind::MuseOpen => row(
            "Muse",
            NotApplicable,
            "Muse has no tool that asks its person a question.",
        ),
        SessionKind::OpenClaw => row(
            "OpenClaw",
            NotApplicable,
            "Agent Relay reaches OpenClaw through sessions of each sender's own, with no dialog \
for the person, and OpenClaw sends no question Agent Relay can see.",
        ),
        SessionKind::Hermes => row(
            "Hermes",
            NotApplicable,
            "Agent Relay reaches Hermes through sessions of each sender's own, with no dialog \
for the person, and Hermes's runs have no waiting-for-input state.",
        ),
    }
}

/// `question_escalation_coverage`: each kind's state and reason, by kind.
pub fn value() -> Value {
    let map: Map<String, Value> = KINDS
        .iter()
        .map(|kind| {
            let row = row(*kind);
            let entry = QuestionCoverage {
                state: row.state,
                reason: row.reason.to_string(),
            };
            (
                kind.as_str().to_string(),
                serde_json::to_value(entry).unwrap_or(Value::Null),
            )
        })
        .collect();
    Value::Object(map)
}

/// The labels of the kinds in `state`, once each, in table order.
fn labels(state: QuestionCoverageState) -> Vec<&'static str> {
    let mut labels = Vec::new();
    for kind in KINDS {
        let row = row(kind);
        if row.state == state && !labels.contains(&row.label) {
            labels.push(row.label);
        }
    }
    labels
}

/// `question_escalation_status`: the table in one sentence per state.
pub fn status_text() -> String {
    let mut parts = Vec::new();
    for (state, lead) in [
        (Covered, "Available for"),
        (Partial, "Partly available for"),
        (NotCovered, "Unavailable for"),
        (NotApplicable, "Not applicable to"),
    ] {
        let labels = labels(state);
        if !labels.is_empty() {
            parts.push(format!("{lead} {}.", labels.join(", ")));
        }
    }
    parts.push(
        "Where it is unavailable, a question is asked in the session as usual; \
question_escalation_coverage says why for each kind of session."
            .into(),
    );
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Its place in `KINDS`: a new kind does not compile until it is
    /// placed, and the test below then fails until `KINDS` lists it.
    fn place(kind: SessionKind) -> usize {
        match kind {
            SessionKind::ClaudeTerminal => 0,
            SessionKind::ClaudeCloud => 1,
            SessionKind::Codex => 2,
            SessionKind::CursorCli => 3,
            SessionKind::Copilot => 4,
            SessionKind::OpenCode => 5,
            SessionKind::OpenCodeOpen => 6,
            SessionKind::Grok => 7,
            SessionKind::GrokOpen => 8,
            SessionKind::Devin => 9,
            SessionKind::Droid => 10,
            SessionKind::Pi => 11,
            SessionKind::Omp => 12,
            SessionKind::MuseOpen => 13,
            SessionKind::OpenClaw => 14,
            SessionKind::Hermes => 15,
        }
    }

    #[test]
    fn every_kind_has_one_row() {
        for (i, kind) in KINDS.iter().enumerate() {
            assert_eq!(place(*kind), i, "{kind:?}");
            let row = row(*kind);
            assert!(!row.label.is_empty() && !row.reason.is_empty());
        }
        let value = value();
        let map = value.as_object().unwrap();
        assert_eq!(map.len(), KINDS.len());
        for kind in KINDS {
            let entry = &map[kind.as_str()];
            assert!(entry["state"].is_string(), "{entry}");
            assert!(entry["reason"].is_string(), "{entry}");
        }
    }

    /// The states the apps switch on are stable codes.
    #[test]
    fn states_are_stable_codes() {
        let value = value();
        let state = |kind: SessionKind| value[kind.as_str()]["state"].clone();
        assert_eq!(state(SessionKind::ClaudeTerminal), "covered");
        assert_eq!(state(SessionKind::Codex), "partial");
        assert_eq!(state(SessionKind::ClaudeCloud), "not_covered");
        for kind in [
            SessionKind::MuseOpen,
            SessionKind::OpenClaw,
            SessionKind::Hermes,
        ] {
            assert_eq!(state(kind), "not_applicable", "{kind:?}");
        }
        for code in value.as_object().unwrap().values() {
            assert!(
                ["covered", "partial", "not_covered", "not_applicable"]
                    .contains(&code["state"].as_str().unwrap()),
                "{code}"
            );
        }
    }

    #[test]
    fn the_status_text_is_written_from_the_table() {
        let text = status_text();
        assert!(text.starts_with("Available for Claude Code."), "{text}");
        assert!(
            text.contains("Partly available for Codex, Copilot, Devin."),
            "{text}"
        );
        assert!(
            text.contains("Unavailable for Claude Code in the cloud,"),
            "{text}"
        );
        assert!(
            text.contains("Not applicable to Muse, OpenClaw, Hermes."),
            "{text}"
        );
        // A label shared by two kinds is named once.
        assert_eq!(text.matches("Grok").count(), 1, "{text}");
        assert!(
            text.ends_with("says why for each kind of session."),
            "{text}"
        );
    }
}
