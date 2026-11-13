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
//!   caller that identifies as another session of the same kind is told
//!   nothing; one the core cannot identify is answered on its user alone.
//!
//! Every other kind, and a kind the core does not know, is answered
//! `{"text": null, "ids": []}`: Codex and Copilot are answered in the core.
use super::{payload, Outbound, OutboundError, Purpose, Request};
use crate::relay::sessions::CallerMiss;
use crate::relay::store::{SessionKind, Target};
use serde_json::{json, Map, Value};

/// The most ids one `shown` names, and the longest id.
const MAX_IDS: usize = 64;
const MAX_ID_BYTES: usize = 256;

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
        Ok(match target.and_then(|t| self.core.take_turn_end_advisory(&t)) {
            Some(advisory) => json!({"text": advisory.text, "ids": advisory.ids}),
            None => json!({"text": null, "ids": []}),
        })
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
        let caller = tokio::task::spawn_blocking(move || directory.caller(pid))
            .await
            .unwrap_or(Err(CallerMiss::NotASession));
        match caller {
            Ok(session) if session.target == target => Some(target),
            Ok(session) if session.target.kind == kind => None,
            _ if kind == SessionKind::ClaudeTerminal => None,
            _ => Some(target),
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
    ids.iter()
        .map(|id| {
            id.as_str()
                .filter(|id| !id.is_empty() && id.len() <= MAX_ID_BYTES)
                .map(str::to_string)
                .ok_or_else(invalid)
        })
        .collect()
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
    struct Sessions(std::sync::Mutex<Vec<Value>>);
    impl SessionDirectory for Sessions {
        fn sessions(&self) -> Vec<DiscoveredSession> {
            Vec::new()
        }
        fn copilot_hook(&self, _pid: i32, payload: &Value) -> Option<Value> {
            self.0.lock().unwrap().push(payload.clone());
            Some(json!({}))
        }
        fn caller(&self, pid: i32) -> Result<DiscoveredSession, CallerMiss> {
            let target = match pid {
                10 => Target::new(SessionKind::ClaudeTerminal, CLAUDE),
                20 => Target::new(SessionKind::Devin, DEVIN),
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

    #[tokio::test]
    async fn claude_takes_only_its_own_advisory_once_and_acks_it() {
        let target = Target::new(SessionKind::ClaudeTerminal, CLAUDE);
        let queue = Arc::new(Queue::with(target.clone(), "Heads up.", &["x"]));
        let (_temp, outbound) = fixture(Some(queue.clone()));
        // Not inside that session, or inside no session: nothing, and the
        // advisory stays queued.
        assert_eq!(take(&outbound, 20, "claude-terminal", CLAUDE).await, NOTHING());
        assert_eq!(take(&outbound, 30, "claude-terminal", CLAUDE).await, NOTHING());
        assert_eq!(take(&outbound, 10, "claude-terminal", "other").await, NOTHING());
        assert_eq!(
            take(&outbound, 10, "claude-terminal", CLAUDE).await,
            json!({"text": "Heads up.", "ids": ["x"]})
        );
        assert_eq!(take(&outbound, 10, "claude-terminal", CLAUDE).await, NOTHING());
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
    }

    #[tokio::test]
    async fn devin_and_cursor_are_refused_only_when_the_caller_is_another_session() {
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
        // A caller the core cannot place is answered on its user alone.
        assert_eq!(
            take(&outbound, 30, "cursor-cli", "conv").await,
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
        assert_eq!(take(&outbound, 10, "claude-terminal", CLAUDE).await, NOTHING());
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
}
