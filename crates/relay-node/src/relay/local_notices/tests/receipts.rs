use super::*;
use crate::relay::codex::app_server::recovery::Recovery;
use crate::relay::codex::app_server::TurnError;
use crate::relay::codex::{queue, rollout, CodexConfig, CodexRouter, CodexRoutes, QueueError};
use crate::relay::delivery::policy::{MessageRef, AUTOMATED_NOTICE_PREFIX};
use std::sync::atomic::{AtomicUsize, Ordering};

// Only the external CLI command is simulated. Queue ownership, router
// settlement and rollout receipts use their production readers.
struct DiskRoutes {
    config: CodexConfig,
    sends: AtomicUsize,
    /// Every call of a route method that can put text in front of Codex,
    /// by name, whether the route took it or not.
    submitted: Mutex<Vec<&'static str>>,
}
impl DiskRoutes {
    fn new(config: CodexConfig) -> DiskRoutes {
        DiskRoutes {
            config,
            sends: AtomicUsize::new(0),
            submitted: Mutex::default(),
        }
    }

    fn submit(&self, route: &'static str) {
        self.submitted.lock().unwrap().push(route);
    }

    fn submissions(&self) -> Vec<&'static str> {
        self.submitted.lock().unwrap().clone()
    }
}
impl CodexRoutes for DiskRoutes {
    fn native_window(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<bool, TurnError> {
        self.submit("native_window");
        Ok(false)
    }
    fn recover_stalled(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: &str,
        _: bool,
    ) -> Result<Recovery, TurnError> {
        self.submit("recover_stalled");
        Ok(Recovery::Unavailable)
    }
    fn app_server_spawned(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
        self.submit("app_server_spawned");
        Ok(false)
    }
    fn app_server_hidden(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
        self.submit("app_server_hidden");
        Ok(false)
    }
    fn recorded(&self, t: &str, r: &str) -> bool {
        rollout::recorded(&self.config, t, r)
    }
    fn queue_waiting(&self, t: &str, r: &str) -> Option<bool> {
        queue::is_waiting(&self.config, t, r)
    }
    fn relay_waiting(&self, t: &str) -> Option<bool> {
        queue::relay_waiting(&self.config, t)
    }
    fn idle(&self, _: &str) -> bool {
        false
    }
    fn app_server(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
        self.submit("app_server");
        Ok(false)
    }
    fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
        self.submit("window");
        Ok(false)
    }
    fn terminal_live(&self, _: &str) -> bool {
        true
    }
    fn queue_send(&self, thread: &str, text: &str) -> Result<(), QueueError> {
        std::fs::create_dir_all(&self.config.sqlite_home).unwrap();
        let db =
            rusqlite::Connection::open(self.config.sqlite_home.join("queue_1.sqlite")).unwrap();
        db.execute_batch("create table if not exists queued_items(id text, thread_id text, payload_json text, created_at_ms integer)").unwrap();
        self.submit("queue_send");
        let n = self.sends.fetch_add(1, Ordering::SeqCst);
        db.execute(
            "insert into queued_items values (?1,?2,?3,0)",
            rusqlite::params![
                format!("queue-{n}"),
                thread,
                json!({"text":text}).to_string()
            ],
        )
        .unwrap();
        Ok(())
    }
    fn cleanup(&self, t: &str, r: &str) {
        queue::remove_owned(&self.config, t, r);
    }
}
struct CodexInjector(Mutex<CodexRouter>);
impl Injector for CodexInjector {
    fn inject(&self, _: &Target, _: &str, _: &str) -> InjectOutcome {
        panic!("registration-aware route required")
    }
    fn inject_routed(
        &self,
        registration: &Registration,
        route: &DeliveryRoute<'_>,
        text: &str,
    ) -> InjectOutcome {
        assert!(!route.native);
        assert_eq!(route.sender, Some(AUTHOR));
        self.0
            .lock()
            .unwrap()
            .inject(&registration.target.id, route.message_id, text)
    }
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        panic!("not a reply route")
    }
}

#[tokio::test]
async fn codex_notice_survives_router_restart_in_the_real_queue_and_settles_from_its_rollout() {
    let home = tempfile::tempdir().unwrap();
    let config = CodexConfig::from_env(&|_| None, home.path());
    let routes = Arc::new(DiskRoutes::new(config.clone()));
    let injector = Arc::new(CodexInjector(Mutex::new(CodexRouter::new(routes.clone()))));
    let (_core_home, core, _probe, mut registration) = fixture_with(Some(injector.clone()));
    let sid = "0852970f-5e6f-4f2e-aef1-c907f16c0844";
    registration.target.id = sid.into();
    core.store
        .update(|s| s.registrations = vec![registration.clone()])
        .unwrap();
    assert!(matches!(
        core.inject_local_notice(
            &registration,
            "disk-regression",
            "Check the overlapping file."
        )
        .await,
        InjectOutcome::WaitingForTurn(_)
    ));
    let reference = MessageRef::of(&provider_key("disk-regression").unwrap());
    assert_eq!(queue::is_waiting(&config, sid, &reference), Some(true));
    assert_eq!(queue::relay_waiting(&config, sid), Some(true));
    let db = rusqlite::Connection::open(config.sqlite_home.join("queue_1.sqlite")).unwrap();
    let payload: String = db
        .query_row("select payload_json from queued_items", [], |r| r.get(0))
        .unwrap();
    let text = serde_json::from_str::<serde_json::Value>(&payload).unwrap()["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(MessageRef::in_text(&text), Some(reference.clone()));
    assert!(!crate::relay::delivery::policy::relayed_input(&text));
    assert!(crate::relay::message_pointer::pointer(&text, "read-command").is_none());
    assert!(text.contains("automated, untrusted advisory text"));
    // Forgetting in-memory handoff grace must not enqueue a second notice.
    *injector.0.lock().unwrap() = CodexRouter::new(routes.clone());
    assert!(matches!(
        core.inject_local_notice(
            &registration,
            "disk-regression",
            "Check the overlapping file."
        )
        .await,
        InjectOutcome::WaitingForTurn(_)
    ));
    assert_eq!(routes.sends.load(Ordering::SeqCst), 1);
    let path = config
        .home
        .join("sessions")
        .join(format!("rollout-test-{sid}.jsonl"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let started =
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"notice-turn"}});
    let received = json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"notice-turn","item":{"type":"UserMessage","content":[{"type":"text","text":text}]}}});
    std::fs::write(path, format!("{started}\n{received}\n")).unwrap();
    assert!(rollout::recorded(&config, sid, &reference));
    assert_eq!(
        core.inject_local_notice(
            &registration,
            "disk-regression",
            "Check the overlapping file."
        )
        .await,
        InjectOutcome::Delivered
    );
    assert_eq!(routes.sends.load(Ordering::SeqCst), 1);
    assert_eq!(queue::is_waiting(&config, sid, &reference), Some(false));
}

#[cfg(target_os = "macos")]
struct CopilotInjector {
    config: crate::relay::copilot::CopilotConfig,
    table: Arc<crate::relay::process::FakeProcesses>,
}
#[cfg(target_os = "macos")]
impl Injector for CopilotInjector {
    fn inject(&self, _: &Target, _: &str, _: &str) -> InjectOutcome {
        panic!("registration-aware route required")
    }
    fn inject_routed(
        &self,
        r: &Registration,
        route: &DeliveryRoute<'_>,
        text: &str,
    ) -> InjectOutcome {
        assert!(!route.native);
        assert_eq!(route.sender, Some(AUTHOR));
        crate::relay::copilot::send(
            &self.config,
            &*self.table,
            501,
            &r.target.id,
            &format!("{}:{}", r.agent_id, r.registered_at),
            route.message_id,
            text,
        )
    }
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        panic!("not a reply route")
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn copilot_notice_hook_claim_only_settles_after_its_actual_native_receipt() {
    use crate::relay::copilot::{self, CopilotSettings};
    let (_home, config, table, _lock) = copilot::proof::tests::fixture();
    let table = Arc::new(table);
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    let hook_event = |event: &str| {
        let mut all = table.processes.lock().unwrap();
        let hook = all.get_mut(&103).unwrap();
        hook.executable = Some("/opt/agent-relay-desktop-probe".into());
        hook.arguments = [
            "/opt/agent-relay-desktop-probe",
            "copilot-hook",
            "--event",
            event,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
    };
    let injector = Arc::new(CopilotInjector {
        config: config.clone(),
        table: table.clone(),
    });
    let (_core_home, core, _probe, mut registration) = fixture_with(Some(injector));
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    registration.target = Target::new(SessionKind::Copilot, sid);
    core.store
        .update(|s| s.registrations = vec![registration.clone()])
        .unwrap();
    let mut payload = json!({"sessionId":sid,"relayEvent":"start","relayBinding":format!("{}:{}",registration.agent_id,registration.registered_at),"cwd":"/fixture/copilot-vscode","initialPrompt":"Copilot notice test"});
    hook_event("start");
    assert_eq!(
        copilot::hook_answer(&config, &*table, 501, 103, &payload),
        Some(json!({}))
    );
    assert!(matches!(
        core.inject_local_notice(&registration, "copilot-notice", "Check the file.")
            .await,
        InjectOutcome::Waiting(_)
    ));
    hook_event("stop");
    payload["relayEvent"] = json!("stop");
    payload["stopReason"] = json!("end_turn");
    let answer = copilot::hook_answer(&config, &*table, 501, 103, &payload).unwrap();
    assert_eq!(answer["decision"], "block");
    let text = answer["reason"].as_str().unwrap();
    assert!(text.starts_with(AUTOMATED_NOTICE_PREFIX));
    assert!(matches!(
        core.inject_local_notice(&registration, "copilot-notice", "Check the file.")
            .await,
        InjectOutcome::Accepted(_)
    ));
    let journal = config.sessions().join(sid).join("events.jsonl");
    // A hook answer alone is not native acceptance.
    std::fs::write(&journal,format!("{}\n",json!({"type":"hook.end","data":{"hookType":"agentStop","success":true,"output":answer}}))).unwrap();
    assert!(matches!(
        core.inject_local_notice(&registration, "copilot-notice", "Check the file.")
            .await,
        InjectOutcome::Accepted(_)
    ));
    std::fs::write(
        &journal,
        format!(
            "{}\n",
            json!({"type":"user.message","data":{"content":text}})
        ),
    )
    .unwrap();
    assert_eq!(
        core.inject_local_notice(&registration, "copilot-notice", "Check the file.")
            .await,
        InjectOutcome::Delivered
    );
}

mod observe;
