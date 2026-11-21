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
        let questions = text::claude_questions(input);
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
            via: Via::Claude,
        };
        Ok(self
            .core
            .escalate_question_within(&registration, asked, question::ROUTE_LIMIT)
            .await
            .response())
    }
}

/// The registration of the Claude Code session that sent `fields`: it must
/// be an `AskUserQuestion` from the caller's own session.
fn question_registration(
    fields: &Map<String, Value>,
    target: &crate::relay::store::Target,
    registration_for: impl FnOnce(
        &crate::relay::store::Target,
    ) -> Option<crate::relay::store::Registration>,
) -> Result<crate::relay::store::Registration, OutboundError> {
    if fields.get("tool_name").and_then(Value::as_str) != Some("AskUserQuestion") {
        return Err(OutboundError::new(
            400,
            "question_invalid",
            "tool_name must be AskUserQuestion",
        ));
    }
    let unknown = || {
        OutboundError::new(
            404,
            "question_session_unknown",
            "this Claude Code session is not registered with Agent Relay",
        )
    };
    let claude = matches!(
        target.kind,
        SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud
    );
    let same = fields
        .get("session_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.eq_ignore_ascii_case(&target.id));
    if !claude || !same {
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
