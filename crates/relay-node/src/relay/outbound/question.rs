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
        let arrived = std::time::Instant::now();
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
        // A Pi or omp session asks through the extension, whose process is
        // the caller: its registration must be pinned to that exact live
        // binding (pid, start time and instance), or it is not this one.
        if matches!(session.target.kind, SessionKind::Pi | SessionKind::Omp) {
            let (sessions, target) = (self.core.plugins.sessions.clone(), session.target.clone());
            let live = tokio::task::spawn_blocking(move || sessions.route_binding(&target))
                .await
                .ok()
                .flatten();
            if !pinned_to(&registration, live.as_deref()) {
                return Err(OutboundError::new(
                    404,
                    "question_session_unknown",
                    "this session is not registered with Agent Relay",
                ));
            }
        }
        let input = &fields["tool_input"];
        let questions = route_questions(&fields, session.target.kind);
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
        // A caller that waits less than the route's own limit (the Pi and
        // omp extension, which shares its time across cores) says so: the
        // question is sent only while a full send still fits in what is
        // left of it, caller checks included.
        let Some(limit) = send_limit(&fields, arrived.elapsed()) else {
            return Ok(serde_json::json!({"escalated": false,
                "reason": "too little of the caller's time is left to send the question"}));
        };
        Ok(self
            .core
            .escalate_question_within(&registration, asked, limit)
            .await
            .response())
    }
}

/// The least time a send is given; less is not tried.
const MIN_SEND: std::time::Duration = std::time::Duration::from_secs(2);

/// Time kept back for the answer to reach the caller.
const SEND_MARGIN: std::time::Duration = std::time::Duration::from_secs(1);

/// The send limit for a question whose caller gave `budget_ms` (its own
/// time left when it asked), `elapsed` after it arrived: `ROUTE_LIMIT`, or
/// less when the caller's time is shorter; `None` when too little is left.
fn send_limit(
    fields: &Map<String, Value>,
    elapsed: std::time::Duration,
) -> Option<std::time::Duration> {
    let Some(budget) = fields.get("budget_ms").and_then(Value::as_u64) else {
        return Some(question::ROUTE_LIMIT);
    };
    let left = std::time::Duration::from_millis(budget)
        .checked_sub(elapsed + SEND_MARGIN)?
        .min(question::ROUTE_LIMIT);
    (left >= MIN_SEND).then_some(left)
}

/// Whether `registration` is pinned to the session's `live` route binding
/// (a Pi or omp session's pid, start time and instance).
fn pinned_to(registration: &crate::relay::store::Registration, live: Option<&str>) -> bool {
    live.is_some() && registration.route_binding.as_deref() == live
}

/// The questions in a hook's `fields`. A hook that cut the input short
/// (Grok's `toolInputTruncated`) does not hand over the whole question, so
/// it asks nothing and the harness shows it.
fn route_questions(fields: &Map<String, Value>, kind: SessionKind) -> Vec<text::Question> {
    let truncated = fields.get("toolInputTruncated") == Some(&Value::Bool(true))
        || fields.get("tool_input_truncated") == Some(&Value::Bool(true));
    if truncated {
        return Vec::new();
    }
    match kind {
        SessionKind::Pi | SessionKind::Omp => text::pi_questions(&fields["tool_input"]),
        _ => text::hook_questions(&fields["tool_input"]),
    }
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
        // omp's built-in ask; Pi has none, and its shipped example's is
        // `question`. Agent Relay's extension hands either over.
        SessionKind::Pi => "question",
        SessionKind::Omp => "ask",
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
            | SessionKind::Pi
            | SessionKind::Omp
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

    /// Pi's and omp's own tool names from their own sessions, in the shapes
    /// their extension hands over (`fixtures/questions/pi-1.2.0-...`,
    /// `omp-18.12.6-...`), and only pinned to the live binding.
    #[test]
    fn pi_and_omp_ask_with_their_own_tools_from_their_pinned_session() {
        let read = |name: &str| -> Value {
            serde_json::from_str(
                &std::fs::read_to_string(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("src/relay/fixtures/questions")
                        .join(name),
                )
                .unwrap(),
            )
            .unwrap()
        };
        let session = "12345678-1234-4234-8234-123456789abc";
        for (kind, name, other) in [
            (SessionKind::Pi, "pi-1.2.0-tool-call-question.json", "ask"),
            (
                SessionKind::Omp,
                "omp-18.12.6-tool-call-ask.json",
                "question",
            ),
        ] {
            let event = read(name)["event"].clone();
            let fields = json!({"hook_event_name": "PreToolUse", "session_id": session,
                "tool_name": event["toolName"], "tool_input": event["input"], "cwd": "/work"})
            .as_object()
            .unwrap()
            .clone();
            let target = Target::new(kind, session);
            let mut found = crate::relay::question::tests::registration(
                "asker",
                target.clone(),
                "https://cast.test",
            );
            found.route_binding = Some(format!("{}:42:7:abc", kind.as_str()));
            let registration =
                question_registration(&fields, &target, |_| Some(found.clone())).unwrap();
            assert!(pinned_to(
                &registration,
                Some(&format!("{}:42:7:abc", kind.as_str()))
            ));
            assert!(!pinned_to(
                &registration,
                Some(&format!("{}:42:7:new", kind.as_str()))
            ));
            assert!(!pinned_to(&registration, None));
            let mut wrong = fields.clone();
            wrong.insert("tool_name".into(), json!(other));
            assert_eq!(
                question_registration(&wrong, &target, |_| Some(found.clone()))
                    .unwrap_err()
                    .status,
                400
            );
            let questions = route_questions(&fields, kind);
            assert_eq!(questions.len(), 1, "{kind:?}");
            assert!(questions[0].text.ends_with('?'));
            assert_eq!(questions[0].options.len(), 2);
        }
    }

    /// Pi's shapes (a question at the top level, omp's `multi`) are read
    /// for Pi and omp alone; every other harness keeps the strict shape.
    #[test]
    fn pi_shapes_are_read_for_pi_and_omp_only() {
        let fields = |input: Value| json!({"tool_input": input}).as_object().unwrap().clone();
        let top = fields(json!({"question": "Which?", "options": [{"label": "A"}]}));
        let multi = fields(json!({"questions": [{"question": "Which?", "multi": true,
            "options": [{"label": "A"}, {"label": "B"}]}]}));
        for kind in [SessionKind::Pi, SessionKind::Omp] {
            assert_eq!(route_questions(&top, kind).len(), 1, "{kind:?}");
            assert!(route_questions(&multi, kind)[0].multi, "{kind:?}");
        }
        for kind in [
            SessionKind::ClaudeTerminal,
            SessionKind::Devin,
            SessionKind::Grok,
        ] {
            assert!(route_questions(&top, kind).is_empty(), "{kind:?}");
            assert!(!route_questions(&multi, kind)[0].multi, "{kind:?}");
        }
    }

    /// A caller's own time left bounds the send: a full limit with none
    /// given, the caller's time less the margin and what the checks took,
    /// and nothing when too little is left.
    #[test]
    fn the_callers_time_bounds_the_send() {
        use std::time::Duration;
        let fields = |budget: Option<u64>| {
            let mut fields = Map::new();
            if let Some(budget) = budget {
                fields.insert("budget_ms".into(), json!(budget));
            }
            fields
        };
        assert_eq!(
            send_limit(&fields(None), Duration::ZERO),
            Some(question::ROUTE_LIMIT)
        );
        assert_eq!(
            send_limit(&fields(Some(60_000)), Duration::ZERO),
            Some(question::ROUTE_LIMIT)
        );
        assert_eq!(
            send_limit(&fields(Some(18_000)), Duration::from_secs(5)),
            Some(Duration::from_secs(12))
        );
        assert_eq!(
            send_limit(&fields(Some(3_500)), Duration::from_secs(1)),
            None
        );
        assert_eq!(send_limit(&fields(Some(500)), Duration::ZERO), None);
    }

    #[test]
    fn a_truncated_input_asks_nothing() {
        let mut fields = json!({"tool_input": {"questions": [{"question": "Which?"}]}})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            route_questions(&fields, SessionKind::ClaudeTerminal).len(),
            1
        );
        fields.insert("toolInputTruncated".into(), json!(true));
        assert!(route_questions(&fields, SessionKind::ClaudeTerminal).is_empty());
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

    /// Through the route: a Pi caller whose registration is pinned to
    /// another instance than the live binding gets the unknown-session 404,
    /// and nothing is sent; pinned to it, the question goes out.
    mod route {
        use super::*;
        use crate::relay::{
            daemon::{Config, Core, Plugins},
            delivery::DeliveryTiming,
            outbound::{Outbound, Request},
            paths::CorePaths,
            push::PushTiming,
            sessions::{CallerMiss, DiscoveredSession, SessionDirectory},
            setup::DirectDelivery,
            workspace::{Secret, Workspace},
        };
        use std::{collections::BTreeMap, sync::Arc, time::Duration};

        const SESSION: &str = "12345678-1234-4234-8234-123456789abc";

        struct PiCaller;
        fn listed() -> DiscoveredSession {
            DiscoveredSession {
                target: Target::new(SessionKind::Omp, SESSION),
                title: "Oh My Pi session".into(),
                directory: Some("/work".into()),
                updated_at_ms: None,
                host: None,
                live: true,
                holder: None,
            }
        }
        impl SessionDirectory for PiCaller {
            fn sessions(&self) -> Vec<DiscoveredSession> {
                vec![listed()]
            }
            fn caller(&self, _pid: i32) -> Result<DiscoveredSession, CallerMiss> {
                Ok(DiscoveredSession {
                    target: Target::new(SessionKind::Omp, SESSION),
                    title: "Oh My Pi session".into(),
                    directory: Some("/work".into()),
                    updated_at_ms: None,
                    host: None,
                    live: true,
                    holder: None,
                })
            }
            fn route_binding(&self, _target: &Target) -> Option<String> {
                Some("omp:42:7:live".into())
            }
        }
        struct Direct;
        impl DirectDelivery for Direct {
            fn delivers_directly(&self) -> bool {
                true
            }
            fn managed_value(&self) -> Option<String> {
                None
            }
            fn user_choice(&self) -> Option<String> {
                None
            }
            fn set_direct_delivery(&self, _: bool) -> Result<(), String> {
                Ok(())
            }
        }

        fn outbound(temp: &std::path::Path, base: &str, pinned: &str) -> Outbound {
            let config = Config {
                paths: CorePaths::for_socket(temp.join("core.sock")).unwrap(),
                home: temp.into(),
                app_data_dir: temp.join("data"),
                env: BTreeMap::new(),
                version: "test".into(),
                host_name: "Test Desk".into(),
                rediscover_every: Duration::from_secs(3600),
                push_timing: PushTiming::default(),
                delivery_timing: DeliveryTiming::default(),
            };
            let plugins = Plugins {
                sessions: Arc::new(PiCaller),
                ..Plugins::default()
            };
            let (core, _) = Core::with_plugins(config, plugins);
            *core.workspace.lock().unwrap() = Some(Workspace {
                key: Secret::new("rk_live_test"),
                base_url: base.into(),
                workspace_id: Some("workspace".into()),
                source: crate::relay::workspace::WorkspaceSource::Cloud,
                control_url: None,
                gate_url: None,
            });
            let mut asker = crate::relay::question::tests::registration(
                "asker-omp-route",
                Target::new(SessionKind::Omp, SESSION),
                base,
            );
            asker.route_binding = Some(pinned.into());
            core.store
                .remember(|store| {
                    store
                        .tokens
                        .insert(asker.name.clone(), Secret::new("at_live_asker"));
                    store.registrations.push(asker);
                    store.extras.question_escalation_inbox = Some("triage".into());
                })
                .unwrap();
            Outbound::new(core, Arc::new(Direct))
        }

        fn ask(question: &str) -> Request {
            Request {
                method: "POST".into(),
                path: "/claude/question".into(),
                query: Vec::new(),
                headers: Default::default(),
                body: serde_json::to_vec(&json!({"hook_event_name": "PreToolUse",
                    "session_id": SESSION, "tool_name": "ask", "cwd": "/work",
                    "tool_input": {"questions": [{"id": "q", "question": question,
                        "options": [{"label": "A"}, {"label": "B"}]}]}}))
                .unwrap(),
            }
        }

        #[tokio::test]
        async fn a_pi_caller_not_on_the_live_binding_is_unknown_and_nothing_is_sent() {
            let (base, hits) = crate::relay::question::tests::relaycast(false);
            let dms = || {
                hits.lock()
                    .unwrap()
                    .iter()
                    .filter(|hit| hit.starts_with("POST /v1/dm"))
                    .count()
            };
            let temp = tempfile::tempdir().unwrap();
            let stale = outbound(temp.path(), &base, "omp:42:7:old");
            let error = stale
                .question_route(42, stale.uid, &ask("Which store for the stale route?"))
                .await
                .unwrap_err();
            assert_eq!(
                (error.status, error.code.as_str()),
                (404, "question_session_unknown")
            );
            assert_eq!(dms(), 0);
            let temp = tempfile::tempdir().unwrap();
            let live = outbound(temp.path(), &base, "omp:42:7:live");
            let answer = live
                .question_route(42, live.uid, &ask("Which store for the live route?"))
                .await
                .unwrap();
            assert_eq!(answer["escalated"], true, "{answer}");
            assert_eq!(dms(), 1);
        }
    }
}
