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
        let questions = text::hook_questions(input);
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

/// The registration of the session that sent `fields`: it must be its
/// harness's own ask-the-user tool (Claude Code's `AskUserQuestion`,
/// Devin's `ask_user_question`), from the caller's own session.
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
            "this Claude Code session is not registered with Agent Relay",
        )
    };
    let covered = matches!(
        target.kind,
        SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud | SessionKind::Devin
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
