//! The routes the turn-end hooks that run outside the core ask
//! (`turn_end_advisories`): Devin's, Cursor CLI's and Claude Code's.
//!
//! ```text
//! POST /turn-end/take   {"kind", "session_id"}          -> {"text": string|null, "ids": [..]}
//! POST /turn-end/shown  {"kind", "session_id", "ids"}   -> {}
//! ```
//!
//! Both answer only this user. What is verified beyond that:
//! - `claude-terminal`: the caller must identify (its process ancestry, as
//!   `GET /setup/status` reads it) as exactly that Claude Code session;
//!   anything else is told nothing.
//! - `devin` and `cursor-cli`: their hooks prove the session in the hook
//!   process itself (Devin reads its own inbox; Cursor's `hook_caller` walks
//!   to the `cursor-agent` or editor host holding the conversation). Here a
//!   core must also verify the caller against exactly the named session.
//!   Cursor editor hooks use payload-aware hook proof, since the editor
//!   supplies their conversation only in the payload, not the environment.
//!   An unidentified process is told nothing.
//!
//! Every other kind, and a kind the core does not know, is answered
//! `{"text": null, "ids": []}`: Codex and Copilot are answered in the core.
use super::{payload, Outbound, OutboundError, Purpose, Request};
use crate::relay::sessions::CallerMiss;
use crate::relay::store::{SessionKind, Target};
use crate::relay::turn_end_advisories::{valid_ids, MAX_IDS, MAX_ID_BYTES};
use serde_json::{json, Map, Value};

impl Outbound {
    pub(in crate::relay::outbound) async fn turn_end_route(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        if uid != self.uid {
            return Err(OutboundError::not_this_user());
        }
        let fields = payload(request, Purpose::Json)?;
        let target = self.turn_end_caller(pid, &fields).await;
        if request.path == "/turn-end/shown" {
            let ids = shown_ids(&fields)?;
            if let Some(target) = target.filter(|_| !ids.is_empty()) {
                self.core.turn_end_advisory_shown(&target, &ids);
            }
            return Ok(json!({}));
        }
        Ok(
            match target.and_then(|t| self.core.take_turn_end_advisory(&t)) {
                Some(advisory) => json!({"text": advisory.text, "ids": advisory.ids}),
                None => json!({"text": null, "ids": []}),
            },
        )
    }

    /// The session a turn-end request names, once the caller is allowed to
    /// speak for it (see the module's notes); `None` otherwise.
    async fn turn_end_caller(&self, pid: i32, fields: &Map<String, Value>) -> Option<Target> {
        let kind: SessionKind = serde_json::from_value(fields.get("kind")?.clone()).ok()?;
        if !crate::relay::turn_end_advisories::served_over_socket(kind) {
            return None;
        }
        let id = fields
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= MAX_ID_BYTES)?;
        let target = Target::new(kind, id);
        let directory = self.core.plugins.sessions.clone();
        if kind == SessionKind::CursorCli {
            return tokio::task::spawn_blocking(move || {
                directory
                    .cursor_hook_matches(pid, &target.id)
                    .then_some(target)
            })
            .await
            .unwrap_or(None);
        }
        let caller = tokio::task::spawn_blocking(move || directory.caller(pid))
            .await
            .unwrap_or(Err(CallerMiss::NotASession));
        match caller {
            Ok(session) if session.target == target => Some(target),
            _ => None,
        }
    }
}

fn shown_ids(fields: &Map<String, Value>) -> Result<Vec<String>, OutboundError> {
    let invalid = || OutboundError::new(400, "invalid_ids", "ids must be a list of advisory ids.");
    let ids = fields
        .get("ids")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if ids.len() > MAX_IDS {
        return Err(invalid());
    }
    let ids: Vec<String> = ids
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| !id.is_empty() && id.len() <= MAX_ID_BYTES)
                .map(str::to_string)
                .ok_or_else(invalid)
        })
        .collect::<Result<_, _>>()?;
    if !valid_ids(&ids) {
        return Err(invalid());
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::{
        daemon::{Config, Core, Plugins},
        delivery::DeliveryTiming,
        paths::CorePaths,
        push::PushTiming,
        sessions::{DiscoveredSession, SessionDirectory},
        setup::DirectDelivery,
        turn_end_advisories::fake::Queue,
    };
    use std::{collections::BTreeMap, sync::Arc, time::Duration};

    const CLAUDE: &str = "6f1c2a7e-1111-4222-8333-944455556666";
    const DEVIN: &str = "devin-session-1";

    /// pid 10 is inside the Claude Code session `CLAUDE`, pid 20 inside the
    /// Devin session `DEVIN`, pid 30 inside no session.
    /// Also answers Copilot's hook `{}`, recording each payload it saw.
    #[derive(Default)]
    struct Sessions(std::sync::Mutex<Vec<Value>>, std::sync::atomic::AtomicBool);
    impl SessionDirectory for Sessions {
        fn sessions(&self) -> Vec<DiscoveredSession> {
            Vec::new()
        }
        fn copilot_hook(&self, _pid: i32, payload: &Value) -> Option<Value> {
            self.0.lock().unwrap().push(payload.clone());
            if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                return None;
            }
            Some(json!({}))
        }
        fn caller(&self, pid: i32) -> Result<DiscoveredSession, CallerMiss> {
            let target = match pid {
                10 => Target::new(SessionKind::ClaudeTerminal, CLAUDE),
                20 => Target::new(SessionKind::Devin, DEVIN),
                25 => Target::new(SessionKind::CursorCli, "conv"),
                _ => return Err(CallerMiss::NotASession),
            };
            Ok(DiscoveredSession {
                target,
                title: "t".into(),
                directory: None,
                updated_at_ms: None,
                host: None,
                live: true,
                holder: None,
            })
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

    fn fixture(queue: Option<Arc<Queue>>) -> (tempfile::TempDir, Outbound) {
        let (temp, outbound, _) = fixture_with(queue);
        (temp, outbound)
    }

    fn fixture_with(queue: Option<Arc<Queue>>) -> (tempfile::TempDir, Outbound, Arc<Sessions>) {
        let sessions = Arc::new(Sessions::default());
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.clone(),
            app_data_dir: home.join("data"),
            env: BTreeMap::new(),
            version: "test".into(),
            host_name: "Test Desk".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let plugins = Plugins {
            sessions: sessions.clone(),
            turn_end_advisories: queue
                .map(|q| q as Arc<dyn crate::relay::daemon::TurnEndAdvisories>),
            ..Plugins::default()
        };
        let (core, _) = Core::with_plugins(config, plugins);
        (temp, Outbound::new(core, Arc::new(Direct)), sessions)
    }

    fn request(path: &str, body: Value) -> Request {
        Request {
            method: "POST".into(),
            path: path.into(),
            query: Vec::new(),
            headers: Default::default(),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    async fn take(outbound: &Outbound, pid: i32, kind: &str, id: &str) -> Value {
        outbound
            .handle(
                pid,
                outbound.uid,
                &request("/turn-end/take", json!({"kind": kind, "session_id": id})),
            )
            .await
            .unwrap()
    }

    const NOTHING: fn() -> Value = || json!({"text": null, "ids": []});

    #[cfg(unix)]
    #[tokio::test]
    async fn cursor_editor_hook_uses_payload_proof_without_lending_other_chats_its_identity() {
        use crate::relay::{
            cursor_cli,
            local::{LocalConfig, LocalSessions},
            process::{FakeProcess, FakeProcesses},
        };
        let own = "9daab59d-0f1f-4c29-9f5d-717d3ecca68f";
        let other = "97d763c9-121c-4438-a6c8-596ba4288c37";
        let target = Target::new(SessionKind::CursorCli, own);
        let queue = Arc::new(Queue::with(target.clone(), "Heads up.", &["c"]));
        let (temp, original) = fixture(None);
        let config = original.core.config.clone();
        let local = LocalConfig::from_env(&|_| None, temp.path());
        let table = Arc::new(FakeProcesses::default());
        let main = std::path::PathBuf::from("/Applications/Cursor.app/Contents/MacOS/Cursor");
        let helper=std::path::PathBuf::from("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)");
        table.trust_cursor(main.clone());
        table.trust_cursor(helper.clone());
        table.insert(
            600,
            FakeProcess {
                parent: 1,
                uid: original.uid,
                start: 10,
                executable: Some(main.clone()),
                arguments: vec![main.to_string_lossy().into()],
                ..Default::default()
            },
        );
        for (host, pid, session) in [(650, 700, own), (660, 710, other)] {
            table.insert(
                host,
                FakeProcess {
                    parent: 600,
                    uid: original.uid,
                    start: 20,
                    executable: Some(helper.clone()),
                    arguments: vec!["Cursor Helper (Plugin): extension-host api [1-2]".into()],
                    ..Default::default()
                },
            );
            table.insert(
                pid,
                FakeProcess {
                    parent: host,
                    uid: original.uid,
                    start: 100,
                    executable: Some("/bin/zsh".into()),
                    arguments: vec!["/bin/zsh".into()],
                    cwd: Some("/work/api".into()),
                    ..Default::default()
                },
            );
            let path = local
                .cursor
                .data_dir
                .join("projects/work-api/agent-transcripts")
                .join(session)
                .join(format!("{session}.jsonl"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
            assert!(cursor_cli::record_editor_hook(
                &local.cursor,
                &*table,
                pid,
                host,
                &json!({"conversation_id":session,"workspace_roots":["/work/api"]})
            ));
        }
        table.insert(
            800,
            FakeProcess {
                parent: 1,
                uid: original.uid,
                start: 100,
                ..Default::default()
            },
        );
        let sessions = Arc::new(LocalSessions::new(local, table.clone()));
        assert!(
            sessions.caller(700).is_err(),
            "ordinary tool identity still requires its environment"
        );
        let (core, _) = Core::with_plugins(
            config,
            Plugins {
                sessions,
                turn_end_advisories: Some(queue.clone()),
                ..Default::default()
            },
        );
        let outbound = Outbound::new(core, Arc::new(Direct));
        assert_eq!(take(&outbound, 710, "cursor-cli", own).await, NOTHING());
        assert_eq!(take(&outbound, 800, "cursor-cli", own).await, NOTHING());
        assert_eq!(take(&outbound, 700, "cursor-cli", other).await, NOTHING());
        let answer = take(&outbound, 700, "cursor-cli", own).await;
        assert_eq!(answer, json!({"text":"Heads up.","ids":["c"]}));
        let shown = request(
            "/turn-end/shown",
            json!({"kind":"cursor-cli","session_id":own,"ids":["c"]}),
        );
        outbound.handle(710, outbound.uid, &shown).await.unwrap();
        assert!(queue.shown().is_empty());
        outbound.handle(700, outbound.uid, &shown).await.unwrap();
        assert_eq!(queue.shown(), vec![(target, vec!["c".into()])]);
        // A caller explicitly naming another conversation cannot use the
        // payload to override that independent ancestry evidence.
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&700)
            .unwrap()
            .environment
            .insert(cursor_cli::editor::CONVERSATION_VAR.into(), other.into());
        assert!(!outbound.core.plugins.sessions.cursor_hook_matches(700, own));
    }

    #[tokio::test]
    async fn claude_takes_only_its_own_advisory_once_and_acks_it() {
        let target = Target::new(SessionKind::ClaudeTerminal, CLAUDE);
        let queue = Arc::new(Queue::with(target.clone(), "Heads up.", &["x"]));
        let (_temp, outbound) = fixture(Some(queue.clone()));
        // Not inside that session, or inside no session: nothing, and the
        // advisory stays queued.
        assert_eq!(
            take(&outbound, 20, "claude-terminal", CLAUDE).await,
            NOTHING()
        );
        assert_eq!(
            take(&outbound, 30, "claude-terminal", CLAUDE).await,
            NOTHING()
        );
        assert_eq!(
            take(&outbound, 10, "claude-terminal", "other").await,
            NOTHING()
        );
        assert_eq!(
            take(&outbound, 10, "claude-terminal", CLAUDE).await,
            json!({"text": "Heads up.", "ids": ["x"]})
        );
        assert_eq!(
            take(&outbound, 10, "claude-terminal", CLAUDE).await,
            NOTHING()
        );
        let shown = |pid, ids: Value| {
            let request = request(
                "/turn-end/shown",
                json!({"kind": "claude-terminal", "session_id": CLAUDE, "ids": ids}),
            );
            let outbound = &outbound;
            async move { outbound.handle(pid, outbound.uid, &request).await }
        };
        assert_eq!(shown(30, json!(["x"])).await.unwrap(), json!({}));
        assert!(queue.shown().is_empty());
        assert_eq!(shown(10, json!(["x"])).await.unwrap(), json!({}));
        assert_eq!(queue.shown(), vec![(target, vec!["x".to_string()])]);
        assert!(shown(10, json!("x")).await.is_err());
        assert!(shown(10, json!([1])).await.is_err());
        assert!(shown(10, json!(vec!["x"; MAX_IDS + 1])).await.is_err());
    }

    #[tokio::test]
    async fn invalid_plugin_ids_are_withheld_instead_of_displayed_without_an_ack() {
        for ids in [
            vec!["x".into(); 65],
            vec![String::new()],
            vec!["x".repeat(257)],
        ] {
            let target = Target::new(SessionKind::ClaudeTerminal, CLAUDE);
            let queue = Arc::new(Queue::default());
            queue.pending.lock().unwrap().push((
                target,
                crate::relay::daemon::TurnEndAdvisory {
                    text: "Heads up.".into(),
                    ids,
                },
            ));
            let (_temp, outbound) = fixture(Some(queue.clone()));
            assert_eq!(
                take(&outbound, 10, "claude-terminal", CLAUDE).await,
                NOTHING()
            );
            assert!(queue.shown().is_empty());
        }
    }

    #[tokio::test]
    async fn devin_and_cursor_require_the_exact_identified_caller() {
        let devin = Target::new(SessionKind::Devin, DEVIN);
        let cursor = Target::new(SessionKind::CursorCli, "conv");
        let queue = Arc::new(Queue::with(devin.clone(), "D", &["d"]));
        queue.pending.lock().unwrap().push((
            cursor.clone(),
            crate::relay::daemon::TurnEndAdvisory {
                text: "C".into(),
                ids: vec!["c".into()],
            },
        ));
        queue.pending.lock().unwrap().push((
            Target::new(SessionKind::Devin, "other"),
            crate::relay::daemon::TurnEndAdvisory {
                text: "O".into(),
                ids: vec!["o".into()],
            },
        ));
        let (_temp, outbound) = fixture(Some(queue.clone()));
        // pid 20 is Devin session DEVIN: it cannot take another Devin's.
        assert_eq!(take(&outbound, 20, "devin", "other").await, NOTHING());
        assert_eq!(
            take(&outbound, 20, "devin", DEVIN).await,
            json!({"text": "D", "ids": ["d"]})
        );
        // Unidentified callers and another provider cannot consume the cache.
        assert_eq!(take(&outbound, 30, "cursor-cli", "conv").await, NOTHING());
        assert_eq!(take(&outbound, 10, "cursor-cli", "conv").await, NOTHING());
        assert_eq!(
            take(&outbound, 25, "cursor-cli", "conv").await,
            json!({"text": "C", "ids": ["c"]})
        );
    }

    #[tokio::test]
    async fn other_kinds_unknown_kinds_another_user_and_no_plugin_get_nothing() {
        let codex = Target::new(SessionKind::Codex, CLAUDE);
        let queue = Arc::new(Queue::with(codex, "X", &["x"]));
        let (_temp, outbound) = fixture(Some(queue.clone()));
        for kind in ["codex", "copilot", "pi", "nonsense"] {
            assert_eq!(take(&outbound, 10, kind, CLAUDE).await, NOTHING(), "{kind}");
        }
        assert_eq!(
            outbound
                .handle(10, outbound.uid, &request("/turn-end/take", json!({})))
                .await
                .unwrap(),
            NOTHING()
        );
        assert!(outbound
            .handle(
                10,
                outbound.uid + 1,
                &request(
                    "/turn-end/take",
                    json!({"kind": "claude-terminal", "session_id": CLAUDE})
                )
            )
            .await
            .is_err());
        assert_eq!(queue.pending.lock().unwrap().len(), 1);
        let (_temp, outbound) = fixture(None);
        assert_eq!(
            take(&outbound, 10, "claude-terminal", CLAUDE).await,
            NOTHING()
        );
    }

    #[tokio::test]
    async fn a_copilot_end_turn_stop_carries_the_advisory_once_after_full_proof() {
        const SID: &str = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
        let target = Target::new(SessionKind::Copilot, SID);
        let queue = Arc::new(Queue::with(target.clone(), "Heads up.", &["k"]));
        let (_temp, outbound, sessions) = fixture_with(Some(queue.clone()));
        let hook = |reason: &str| {
            json!({"sessionId": SID, "relayEvent": "stop", "stopReason": reason,
                "relayTurnEndAdvisory": true})
        };
        let ask = |fields: Value| {
            let outbound = &outbound;
            let request = request("/copilot/hook", fields);
            async move { outbound.handle(10, outbound.uid, &request).await.unwrap() }
        };
        // A turn the person cancelled takes nothing, whatever the input says.
        assert_eq!(ask(hook("cancelled")).await, json!({}));
        assert_eq!(sessions.0.lock().unwrap()[0]["relayTurnEndAdvisory"], false);
        assert_eq!(queue.pending.lock().unwrap().len(), 1);
        assert_eq!(
            ask(hook("end_turn")).await,
            json!({"decision": "block", "reason": "Heads up."})
        );
        assert_eq!(sessions.0.lock().unwrap()[1]["relayTurnEndAdvisory"], true);
        assert_eq!(queue.shown(), vec![(target, vec!["k".to_string()])]);
        // The hook's client asks again every second: the advisory is gone,
        // and the idle check is cheap again.
        assert_eq!(ask(hook("end_turn")).await, json!({}));
        assert_eq!(sessions.0.lock().unwrap()[2]["relayTurnEndAdvisory"], false);
        assert_eq!(queue.shown().len(), 1);
    }

    #[tokio::test]
    async fn a_rejected_copilot_stop_keeps_its_one_shot_advisory() {
        const SID: &str = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
        let target = Target::new(SessionKind::Copilot, SID);
        let queue = Arc::new(Queue::with(target, "Heads up.", &["k"]));
        let (_temp, outbound, sessions) = fixture_with(Some(queue.clone()));
        let request = request(
            "/copilot/hook",
            json!({"sessionId":SID,"relayEvent":"stop","stopReason":"end_turn"}),
        );
        sessions.1.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(outbound.handle(10, outbound.uid, &request).await.is_err());
        assert!(queue.taken.lock().unwrap().is_empty());
        assert_eq!(queue.pending.lock().unwrap().len(), 1);
        sessions.1.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            outbound.handle(10, outbound.uid, &request).await.unwrap(),
            json!({"decision":"block","reason":"Heads up."})
        );
        assert_eq!(queue.shown().len(), 1);
    }
}
