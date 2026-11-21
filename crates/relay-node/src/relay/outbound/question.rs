//! `POST /claude/question`: Claude Code's PreToolUse hook for
//! `AskUserQuestion` hands the question over before it is shown. With
//! question escalation on, it goes to the question inbox
//! (`crate::relay::question`) and the hook refuses the tool call with the
//! reason this returns, so the session keeps working; otherwise the hook
//! lets the dialog through. An error also lets it through.
//!
//! The hook waits for this route at most its own timeout, which Agent Relay
//! installs as 30 s (`claude::session_hook::QUESTION_HOOK_TIMEOUT`); a
//! Claude Code that gave up on the hook would show the dialog while the
//! question was also sent. So the route answers within `question::ROUTE_LIMIT`
//! (20 s): past it, it answers `{"escalated":false,"reason":…}`, the dialog
//! is shown, and a message that may have gone out is kept unsent, so a late
//! answer to it is refused.

use super::{payload, Outbound, OutboundError, Purpose};
use crate::relay::question::{self, text, Asked, Via};
use crate::relay::store::SessionKind;
use serde_json::{Map, Value};

impl Outbound {
    pub(super) async fn question_route(
        &self,
        pid: i32,
        uid: u32,
        request: &super::Request,
    ) -> Result<Value, OutboundError> {
        let fields = payload(request, Purpose::Json)?;
        let session = self.identify(pid, uid).await?;
        self.admit(&session.target.key())?;
        let cwd = fields["cwd"]
            .as_str()
            .map(str::to_string)
            .or(session.directory.clone())
            .unwrap_or_default();
        let registration = question_registration(&fields, &session.target, |target| {
            self.core
                .store
                .read(|store| store.registration_for(target).cloned())
        })?;
        let input = &fields["tool_input"];
        let questions = route_questions(&fields);
        if questions.is_empty() {
            return Err(OutboundError::new(
                400,
                "question_invalid",
                "tool_input.questions holds no question",
            ));
        }
        let asked = Asked {
            questions,
            input,
            cwd: &cwd,
            via: Via::Session,
        };
        Ok(self
            .core
            .escalate_question_within(&registration, asked, question::ROUTE_LIMIT)
            .await
            .response())
    }
}

/// The questions in a hook's `fields`. A hook that cut the input short
/// (Grok's `toolInputTruncated`) does not hand over the whole question, so
/// it asks nothing and the harness shows it.
fn route_questions(fields: &Map<String, Value>) -> Vec<text::Question> {
    let truncated = fields.get("toolInputTruncated") == Some(&Value::Bool(true))
        || fields.get("tool_input_truncated") == Some(&Value::Bool(true));
    if truncated {
        return Vec::new();
    }
    text::hook_questions(&fields["tool_input"])
}

/// Grok's ask-the-user tool, as its hooks name it (Grok 1.0.77).
const GROK_QUESTION_TOOL: &str = "ask_user_question";

/// The registration of the session that sent `fields`: it must be its
/// harness's own ask-the-user tool (Claude Code's `AskUserQuestion`,
/// Devin's and Grok's `ask_user_question`), from the caller's own session.
fn question_registration(
    fields: &Map<String, Value>,
    target: &crate::relay::store::Target,
    registration_for: impl FnOnce(
        &crate::relay::store::Target,
    ) -> Option<crate::relay::store::Registration>,
) -> Result<crate::relay::store::Registration, OutboundError> {
    // Each harness's own ask-the-user tool, from its own kind of session.
    let tool = match target.kind {
        SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud => "AskUserQuestion",
        SessionKind::Devin => crate::relay::devin::QUESTION_TOOL,
        // Grok runs Claude Code's hooks from `~/.claude/settings.json`, and
        // matches `AskUserQuestion` to its own `ask_user_question`, which
        // is the name it gives the hook.
        SessionKind::Grok | SessionKind::GrokOpen => GROK_QUESTION_TOOL,
        _ => "AskUserQuestion",
    };
    if fields.get("tool_name").and_then(Value::as_str) != Some(tool) {
        return Err(OutboundError::new(
            400,
            "question_invalid",
            format!("tool_name must be {tool}"),
        ));
    }
    let unknown = || {
        OutboundError::new(
            404,
            "question_session_unknown",
            "this session is not registered with Agent Relay",
        )
    };
    let covered = matches!(
        target.kind,
        SessionKind::ClaudeTerminal
            | SessionKind::ClaudeCloud
            | SessionKind::Devin
            | SessionKind::Grok
            | SessionKind::GrokOpen
    );
    let same = fields
        .get("session_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.eq_ignore_ascii_case(&target.id));
    if !covered || !same {
        return Err(unknown());
    }
    registration_for(target).ok_or_else(unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::store::Target;
    use serde_json::json;

    fn fields(session: &str, tool: &str) -> Map<String, Value> {
        json!({
            "hook_event_name": "PreToolUse",
            "session_id": session,
            "cwd": "/tmp",
            "tool_name": tool,
            "tool_input": {"questions": [{"question": "Which?", "header": "Pick",
                "options": [{"label": "A", "description": ""}], "multiSelect": false}]},
        })
        .as_object()
        .unwrap()
        .clone()
    }

    /// Devin's own session asking with its own tool, in the shape Devin's
    /// hook gives (`fixtures/questions/devin-3000.12.57-...`); Claude's tool
    /// name from a Devin session, or Devin's from Claude's, is refused.
    #[test]
    fn a_devin_session_asks_with_its_own_tool() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/questions/devin-3000.12.57-pre-tool-use-ask-user-question.json"
        ))
        .unwrap();
        let fields = fixture["input"].as_object().unwrap().clone();
        let devin = Target::new(SessionKind::Devin, "real-gallium");
        let found = |target: &Target| {
            Some(crate::relay::question::tests::registration(
                "asker",
                target.clone(),
                "https://cast.test",
            ))
        };
        assert!(question_registration(&fields, &devin, found).is_ok());
        let questions = text::hook_questions(&fields["tool_input"]);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].text, "Which auth method should the API use?");
        assert_eq!(questions[0].options.len(), 2);
        assert!(!questions[0].multi && questions[0].free);
        let mut claude_tool = fields.clone();
        claude_tool.insert("tool_name".into(), json!("AskUserQuestion"));
        assert_eq!(
            question_registration(&claude_tool, &devin, found)
                .unwrap_err()
                .status,
            400
        );
        let claude = Target::new(SessionKind::ClaudeTerminal, "real-gallium");
        assert_eq!(
            question_registration(&fields, &claude, found)
                .unwrap_err()
                .status,
            400
        );
        // An argument shape Devin's schema does not give asks nothing, so
        // the route refuses it and the hook lets Devin show the question.
        for bad in [
            json!({}),
            json!({"questions": "x"}),
            json!({"questions": [{"prompt": "?"}]}),
        ] {
            assert!(text::hook_questions(&bad).is_empty(), "{bad}");
        }
    }

    /// Grok runs Agent Relay's Claude Code hook and names the tool its own
    /// way (`fixtures/questions/grok-1.0.77-...`): a Grok session, managed
    /// or already open, asks with `ask_user_question`; the hook's deny is
    /// the shape Grok reads.
    #[test]
    fn a_grok_session_asks_through_the_claude_hook() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/questions/grok-1.0.77-pre-tool-use-ask-user-question.json"
        ))
        .unwrap();
        let fields = fixture["input"].as_object().unwrap().clone();
        let session = fields["session_id"].as_str().unwrap();
        let found = |target: &Target| {
            Some(crate::relay::question::tests::registration(
                "asker",
                target.clone(),
                "https://cast.test",
            ))
        };
        for kind in [SessionKind::Grok, SessionKind::GrokOpen] {
            let target = Target::new(kind, session);
            assert!(
                question_registration(&fields, &target, found).is_ok(),
                "{kind:?}"
            );
            let mut claude_tool = fields.clone();
            claude_tool.insert("tool_name".into(), json!("AskUserQuestion"));
            assert_eq!(
                question_registration(&claude_tool, &target, found)
                    .unwrap_err()
                    .status,
                400
            );
        }
        let questions = text::hook_questions(&fields["tool_input"]);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].options[1].label, "Jest");
        let sent = json!({"ok": true, "data": {"escalated": true, "ref": "q1",
            "inbox": "triage", "reason": "Sent to @triage as q1."}});
        let out = crate::relay::claude::session_hook::question_hook_output(
            200,
            sent.to_string().as_bytes(),
        );
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            out["hookSpecificOutput"]["permissionDecisionReason"],
            "Sent to @triage as q1."
        );
    }

    /// The hook's questions are read strictly: options may be labelled
    /// objects or plain labels; any other shape asks nothing, so the route
    /// refuses it and the harness shows its question.
    /// Claude's "Other" choice is its own free text, never a numbered
    /// choice; a question set over the caps asks nothing.
    #[test]
    fn claudes_other_choice_is_not_numbered_and_large_sets_are_not_read() {
        let claude = json!({"questions": [{"question": "Which?", "header": "Pick",
            "options": [{"label": "A", "description": ""},
                        {"label": "Other", "description": "", "isOther": true}],
            "multiSelect": false}]});
        let questions = text::hook_questions(&claude);
        assert_eq!(questions[0].options.len(), 1);
        assert_eq!(questions[0].options[0].label, "A");
        assert!(questions[0].free);
        let many = json!({"questions": (0..=text::MAX_QUESTIONS)
            .map(|i| json!({"question": format!("Q{i}?")}))
            .collect::<Vec<_>>()});
        assert!(text::hook_questions(&many).is_empty());
        let wide = json!({"questions": [{"question": "Which?",
            "options": (0..=text::MAX_OPTIONS).map(|i| format!("o{i}")).collect::<Vec<_>>()}]});
        assert!(text::hook_questions(&wide).is_empty());
        let at_caps = json!({"questions": (0..text::MAX_QUESTIONS)
            .map(|i| json!({"question": format!("Q{i}?"),
                "options": (0..text::MAX_OPTIONS).map(|j| format!("o{j}")).collect::<Vec<_>>()}))
            .collect::<Vec<_>>()});
        assert_eq!(text::hook_questions(&at_caps).len(), text::MAX_QUESTIONS);
    }

    #[test]
    fn a_truncated_input_asks_nothing() {
        let mut fields = json!({"tool_input": {"questions": [{"question": "Which?"}]}})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(route_questions(&fields).len(), 1);
        fields.insert("toolInputTruncated".into(), json!(true));
        assert!(route_questions(&fields).is_empty());
    }

    #[test]
    fn only_a_known_question_shape_is_read() {
        let plain = json!({"questions": [{"question": "Which?", "options": ["A", "B"]}]});
        assert_eq!(text::hook_questions(&plain)[0].options[1].label, "B");
        let open = json!({"questions": [{"question": "Why?"}]});
        assert!(text::hook_questions(&open)[0].options.is_empty());
        for bad in [
            json!({"questions": [{"question": "Which?", "options": [1, 2]}]}),
            json!({"questions": [{"question": "Which?", "options": "A, B"}]}),
            json!({"questions": [{"question": ""}]}),
            json!({"questions": [{"question": "Which?"}, {"prompt": "Then?"}]}),
            json!({"question": "Which?"}),
        ] {
            assert!(text::hook_questions(&bad).is_empty(), "{bad}");
        }
    }

    #[test]
    fn an_unmapped_session_is_refused() {
        let target = Target::new(SessionKind::ClaudeTerminal, "s-1");
        let error = question_registration(&fields("s-1", "AskUserQuestion"), &target, |_| None)
            .unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.code, "question_session_unknown");
        // Another session's id, or a session that is not Claude's, is too.
        let found = |target: &Target| {
            Some(crate::relay::question::tests::registration(
                "asker",
                target.clone(),
                "https://cast.test",
            ))
        };
        let other = question_registration(&fields("s-2", "AskUserQuestion"), &target, found);
        assert_eq!(other.unwrap_err().status, 404);
        let codex = Target::new(SessionKind::Codex, "s-1");
        let codex = question_registration(&fields("s-1", "AskUserQuestion"), &codex, found);
        assert_eq!(codex.unwrap_err().status, 404);
        let tool = question_registration(&fields("s-1", "Bash"), &target, found);
        assert_eq!(tool.unwrap_err().status, 400);
        assert!(question_registration(&fields("S-1", "AskUserQuestion"), &target, found).is_ok());
    }
}
