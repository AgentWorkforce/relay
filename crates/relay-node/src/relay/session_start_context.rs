//! Extra session-start guidance a build of the core adds for every provider
//! ([`SessionStartContext`]): where the core's own session-start text goes,
//! the paragraph is appended, so one setting reaches every provider whose
//! session start the core answers. The core decides nothing about the text;
//! it only carries it, bounded, and says which providers it cannot reach.
use crate::relay::daemon::Core;
use crate::relay::store::SessionKind;
use serde_json::{json, Value};

/// The most the paragraph may be, in bytes; longer text is cut at a char
/// boundary. It is read at the start of every session.
pub const MAX_BYTES: usize = 4096;

impl Core {
    /// The extra paragraph for a session of `kind` that is starting: the
    /// build's [`SessionStartContext`], trimmed and bounded, or `None`.
    pub fn session_start_context(&self, kind: SessionKind) -> Option<String> {
        bounded(
            self.plugins
                .session_start_context
                .as_deref()?
                .context(kind)?,
        )
    }
}

fn bounded(text: String) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut end = text.len().min(MAX_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(text[..end].to_string())
}

/// `answer` (a hook's JSON answer) with `extra` appended to its
/// `hookSpecificOutput.additionalContext`, as a paragraph of its own. An
/// answer that tells the session nothing (`{}`) gets `extra` alone under
/// `event`. An answer of another shape (a stop hook's `decision`, say) is
/// left as it is.
pub fn append(mut answer: Value, event: &str, extra: Option<&str>) -> Value {
    let Some(extra) = extra.filter(|extra| !extra.is_empty()) else {
        return answer;
    };
    if answer.as_object().is_some_and(|object| object.is_empty()) {
        return json!({"hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": extra,
        }});
    }
    let Some(output) = answer
        .get_mut("hookSpecificOutput")
        .and_then(Value::as_object_mut)
    else {
        return answer;
    };
    let joined = match output.get("additionalContext").and_then(Value::as_str) {
        Some(text) if !text.is_empty() => format!("{text}\n\n{extra}"),
        _ => extra.to_string(),
    };
    output.insert("additionalContext".into(), json!(joined));
    answer
}

/// [`append`] for a hook whose answer carries `additionalContext` at its
/// top level (Copilot's): `extra` follows any existing context as a
/// paragraph of its own. A non-object answer is left as it is.
pub fn append_flat(mut answer: Value, extra: Option<&str>) -> Value {
    let Some(extra) = extra.filter(|extra| !extra.is_empty()) else {
        return answer;
    };
    let Some(object) = answer.as_object_mut() else {
        return answer;
    };
    let joined = match object.get("additionalContext").and_then(Value::as_str) {
        Some(text) if !text.is_empty() => format!("{text}\n\n{extra}"),
        _ => extra.to_string(),
    };
    object.insert("additionalContext".into(), json!(joined));
    answer
}

/// Whether the extra paragraph reaches a provider's sessions, and how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// Added to the session's start through the named core hook, while
    /// that hook is on.
    Available(&'static str),
    /// The core gives this provider no session-start text to add it to.
    Unavailable(&'static str),
}

/// How the extra paragraph reaches sessions of `kind`. Every kind answers:
/// a provider the core cannot reach says why, so a setting that turns the
/// guidance on can say where it does not apply.
pub fn reach(kind: SessionKind) -> Reach {
    use Reach::{Available, Unavailable};
    match kind {
        SessionKind::ClaudeTerminal => Available("claude_session_hook"),
        SessionKind::Codex => Available("codex_stop_hook"),
        SessionKind::Copilot => Available("copilot chat delivery hooks"),
        SessionKind::Devin => Available("devin_direct_delivery"),
        SessionKind::ClaudeCloud => {
            Unavailable("Claude desktop app and claude.ai/code sessions run no local hooks")
        }
        SessionKind::CursorCli => Available("cursor_direct_delivery sessionStart hook"),
        SessionKind::Pi => Available("pi_extension before_agent_start, once per session"),
        SessionKind::Omp => Available("Oh My Pi extension before_agent_start, once per session"),
        SessionKind::OpenCode | SessionKind::OpenCodeOpen => {
            Available("opencode_plugin system prompt transform (OpenCode 1.x)")
        }
        SessionKind::MuseOpen => Unavailable(
            "Muse runs session-start hooks only from a plugin bundle the person installs and \
             approves, and Agent Relay installs none",
        ),
        SessionKind::Grok | SessionKind::GrokOpen => {
            Unavailable("Grok ACP sessions take prompts only, with no session-start context")
        }
        SessionKind::OpenClaw => {
            Unavailable("OpenClaw relay sessions are per sender, not a person's sessions")
        }
        SessionKind::Hermes => {
            Unavailable("Hermes relay sessions are per sender, not a person's sessions")
        }
    }
}

/// Every session kind, for [`reach_report`]. [`reach`] matches each one
/// by name, so a new kind cannot be added without deciding its reach.
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

/// [`reach`] for every kind, as `status.get`-style JSON: `{kind: {"available":
/// bool, "via"|"reason": text}}`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::daemon::SessionStartContext;

    struct Fixed(&'static str);
    impl SessionStartContext for Fixed {
        fn context(&self, _kind: SessionKind) -> Option<String> {
            Some(self.0.to_string())
        }
    }

    #[test]
    fn the_paragraph_follows_the_existing_context() {
        let answer = json!({"hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "On Agent Relay as @a.",
        }, "systemMessage": "kept"});
        let out = append(answer, "SessionStart", Some("Check teammates."));
        assert_eq!(
            out["hookSpecificOutput"]["additionalContext"],
            "On Agent Relay as @a.\n\nCheck teammates."
        );
        assert_eq!(out["systemMessage"], "kept");
    }

    #[test]
    fn an_empty_answer_gets_the_paragraph_alone() {
        let out = append(json!({}), "SessionStart", Some("Check teammates."));
        assert_eq!(
            out,
            json!({"hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": "Check teammates.",
            }})
        );
    }

    #[test]
    fn without_a_paragraph_or_with_another_shape_nothing_changes() {
        let answer = json!({"hookSpecificOutput": {"additionalContext": "x"}});
        assert_eq!(append(answer.clone(), "SessionStart", None), answer);
        assert_eq!(append(answer.clone(), "SessionStart", Some("")), answer);
        let stop = json!({"decision": "block", "reason": "r"});
        assert_eq!(append(stop.clone(), "Stop", Some("y")), stop);
    }

    #[test]
    fn a_flat_answer_gets_the_paragraph_at_its_top_level() {
        assert_eq!(
            append_flat(json!({}), Some("Check teammates.")),
            json!({"additionalContext": "Check teammates."})
        );
        assert_eq!(
            append_flat(json!({"additionalContext": "On relay."}), Some("Check.")),
            json!({"additionalContext": "On relay.\n\nCheck."})
        );
        assert_eq!(append_flat(json!({"a": 1}), None), json!({"a": 1}));
    }

    #[test]
    fn the_paragraph_is_trimmed_and_bounded() {
        assert_eq!(bounded("  \n ".into()), None);
        assert_eq!(bounded(" hi \n".into()).as_deref(), Some("hi"));
        let long = "é".repeat(MAX_BYTES);
        let cut = bounded(long).unwrap();
        assert!(cut.len() <= MAX_BYTES && cut.chars().all(|c| c == 'é'));
        assert!(Fixed("x").context(SessionKind::Codex).is_some());
    }

    #[test]
    fn every_kind_reports_its_reach() {
        let report = reach_report();
        assert_eq!(report.as_object().unwrap().len(), KINDS.len());
        assert_eq!(report["claude-terminal"]["available"], true);
        assert_eq!(report["codex"]["via"], "codex_stop_hook");
        for kind in ["cursor-cli", "pi", "omp", "opencode", "opencode-open"] {
            assert_eq!(report[kind]["available"], true, "{kind}");
        }
        assert_eq!(report["muse-open"]["available"], false);
        assert!(report["muse-open"]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("plugin bundle")));
    }
}
