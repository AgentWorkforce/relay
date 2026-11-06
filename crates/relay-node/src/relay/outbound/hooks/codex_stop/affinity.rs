//! The real hook route must bind consumption to its caller's own thread,
//! even when one trusted app-server owns both parent and subagent locks.

use super::*;
use crate::relay::{
    codex::{
        stop_hook::StopHookInbox,
        turn_hook::{Claimed, TurnInbox},
    },
    daemon::{Config, Core, Plugins},
    delivery::DeliveryTiming,
    local::{LocalConfig, LocalSessions},
    outbound::{RelaySend, ServingPath},
    paths::CorePaths,
    process::{FakeProcess, FakeProcesses},
    push::PushTiming,
    setup::DirectDelivery,
    workspace::{Secret, Workspace, WorkspaceSource},
};
use std::{collections::BTreeMap, sync::Arc};

const PARENT: &str = "550e8400-e29b-41d4-a716-446655440000";
const CHILD: &str = "550e8400-e29b-41d4-a716-446655440001";
const PARENT_PID: i32 = 41;
const CHILD_PID: i32 = 42;

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

fn fixture(
    guidance: bool,
) -> anyhow::Result<(
    tempfile::TempDir,
    Outbound,
    Arc<StopHookInbox>,
    Arc<FakeProcesses>,
)> {
    let temp = tempfile::tempdir()?;
    let home = temp.path().to_path_buf();
    let local = LocalConfig::from_env(&|_| None, &home);
    let table = Arc::new(FakeProcesses::default());
    let executable = home.join("codex");
    table.trust(&executable);
    table.insert(
        10,
        FakeProcess {
            parent: 1,
            uid: local.uid,
            start: 10,
            executable: Some(executable),
            arguments: vec!["codex".into(), "app-server".into()],
            open_files: [PARENT, CHILD]
                .map(|id| home.join("thread-writer-locks").join(format!("{id}.lock")))
                .into(),
            ..FakeProcess::default()
        },
    );
    for (pid, thread) in [(PARENT_PID, PARENT), (CHILD_PID, CHILD)] {
        table.insert(
            pid,
            FakeProcess {
                parent: 10,
                uid: local.uid,
                start: pid as u64,
                // Subagent hooks inherit the root session id while their thread
                // id names the actual conversation receiving additionalContext.
                environment: [
                    ("CODEX_THREAD_ID".into(), thread.into()),
                    ("CODEX_SESSION_ID".into(), PARENT.into()),
                ]
                .into(),
                ..FakeProcess::default()
            },
        );
    }
    let inbox = Arc::new(StopHookInbox::with_turns(TurnInbox::open(
        home.join("turns.json"),
    )));
    inbox.set_ready(true);
    let direct = Arc::new(Direct);
    let config = Config {
        paths: CorePaths::for_socket(home.join("core.sock"))?,
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
        sessions: Arc::new(LocalSessions::new(local, table.clone())),
        codex_stop_hook: Some(inbox.clone()),
        relay_send: Some(RelaySend {
            socket: home.join("relay.sock"),
            pointer: home.join("pointer"),
            direct_delivery: direct.clone(),
            serving: ServingPath::default(),
            agent_led_defaults_at_start: false,
        }),
        ..Plugins::default()
    };
    let (core, _) = Core::with_plugins(config, plugins);
    *core
        .workspace
        .lock()
        .map_err(|_| anyhow::anyhow!("fixture workspace poisoned"))? = Some(Workspace {
        key: Secret::new("rk_fixture"),
        base_url: "https://cast.test".into(),
        workspace_id: Some("workspace".into()),
        source: WorkspaceSource::Cloud,
    });
    core.store
        .update(|store| store.allow_self_registration = Some(guidance))?;
    Ok((temp, Outbound::new(core, direct), inbox, table))
}

fn fields(thread: &str, event: &str) -> Map<String, Value> {
    Map::from_iter([
        ("session_id".into(), json!(thread)),
        ("hook_event_name".into(), json!(event)),
    ])
}

/// A child cannot take its parent's offer; neither failure nor repeated hooks
/// consume it, and each matching caller still receives its own queue once.
#[tokio::test]
async fn consuming_hook_thread_affinity_preserves_parent_and_child_offers() {
    for event in ["PostToolUse", "Stop"] {
        let (_temp, outbound, inbox, _) = fixture(false).unwrap();
        inbox
            .turns()
            .offer(PARENT, "parent-message", "parent-only fixture")
            .unwrap();
        inbox
            .turns()
            .offer(CHILD, "child-message", "child-only fixture")
            .unwrap();
        assert!(outbound
            .codex_stop_hook(CHILD_PID, outbound.uid, &fields(PARENT, event))
            .await
            .is_err());
        assert_eq!(inbox.turns().claimed("parent-message"), Claimed::Offered);
        assert!(inbox.turns().has_offered(PARENT));
        let parent = outbound
            .codex_stop_hook(PARENT_PID, outbound.uid, &fields(PARENT, event))
            .await
            .unwrap();
        assert!(parent.to_string().contains("parent-only fixture"));
        assert!(!parent.to_string().contains("child-only fixture"));
        assert_eq!(
            outbound
                .codex_stop_hook(PARENT_PID, outbound.uid, &fields(PARENT, event))
                .await
                .unwrap(),
            json!({})
        );
        let child = outbound
            .codex_stop_hook(CHILD_PID, outbound.uid, &fields(CHILD, event))
            .await
            .unwrap();
        assert!(child.to_string().contains("child-only fixture"));
        assert!(!child.to_string().contains("parent-only fixture"));
        assert_eq!(
            outbound
                .codex_stop_hook(CHILD_PID, outbound.uid, &fields(CHILD, event))
                .await
                .unwrap(),
            json!({})
        );
    }
}

/// Registration guidance is another consumable per-thread item and must not
/// be spent by a subagent's hook claiming its parent's inherited session id.
#[tokio::test]
async fn consuming_hook_thread_affinity_preserves_registration_guidance() {
    let (_temp, outbound, inbox, _) = fixture(true).unwrap();
    assert!(outbound
        .codex_stop_hook(CHILD_PID, outbound.uid, &fields(PARENT, "SessionStart"))
        .await
        .is_err());
    assert!(inbox.needs_registration_guidance(PARENT));
    assert!(outbound
        .core
        .store
        .read(|store| store.registrations.is_empty()));
    assert!(outbound
        .codex_stop_hook(CHILD_PID, outbound.uid, &fields(PARENT, "PostToolUse"))
        .await
        .is_err());
    assert!(inbox.needs_registration_guidance(PARENT));
    for (pid, thread) in [(PARENT_PID, PARENT), (CHILD_PID, CHILD)] {
        assert!(outbound
            .codex_stop_hook(pid, outbound.uid, &fields(thread, "SessionStart"))
            .await
            .is_ok());
        assert!(inbox.needs_registration_guidance(thread));
        let answer = outbound
            .codex_stop_hook(pid, outbound.uid, &fields(thread, "PostToolUse"))
            .await
            .unwrap();
        assert!(answer.to_string().contains("/register"));
        assert!(!inbox.needs_registration_guidance(thread));
        assert_eq!(
            outbound
                .codex_stop_hook(pid, outbound.uid, &fields(thread, "PostToolUse"))
                .await
                .unwrap(),
            json!({})
        );
    }
}

/// A matching environment string cannot replace the trusted executable and
/// held writer lock that make the caller-thread resolver authoritative.
#[tokio::test]
async fn consuming_hook_thread_affinity_keeps_kernel_writer_checks() {
    for missing in ["trust", "lock", "thread"] {
        let (_temp, outbound, inbox, table) = fixture(false).unwrap();
        inbox
            .turns()
            .offer(PARENT, "parent-message", "parent-only fixture")
            .unwrap();
        match missing {
            "trust" => table.trusted_codex.lock().unwrap().clear(),
            "lock" => table
                .processes
                .lock()
                .unwrap()
                .get_mut(&10)
                .unwrap()
                .open_files
                .clear(),
            _ => {
                table
                    .processes
                    .lock()
                    .unwrap()
                    .get_mut(&PARENT_PID)
                    .unwrap()
                    .environment
                    .remove("CODEX_THREAD_ID");
            }
        }
        assert!(outbound
            .codex_stop_hook(PARENT_PID, outbound.uid, &fields(PARENT, "PostToolUse"))
            .await
            .is_err());
        assert!(inbox.turns().has_offered(PARENT));
    }

    // Older terminal Codex identifies its one thread through `resume`, not
    // CODEX_THREAD_ID. Retain that route and case-insensitive UUID matching,
    // but never accept resume arguments without the held writer lock.
    let (_temp, outbound, inbox, table) = fixture(false).unwrap();
    {
        let mut processes = table.processes.lock().unwrap();
        let codex = processes.get_mut(&10).unwrap();
        codex.arguments = vec!["codex".into(), "resume".into(), PARENT.to_uppercase()];
        codex
            .open_files
            .retain(|path| path.file_stem().unwrap() == PARENT);
        processes
            .get_mut(&PARENT_PID)
            .unwrap()
            .environment
            .remove("CODEX_THREAD_ID");
    }
    inbox
        .turns()
        .offer(PARENT, "legacy-message", "legacy fixture")
        .unwrap();
    let answer = outbound
        .codex_stop_hook(
            PARENT_PID,
            outbound.uid,
            &fields(&PARENT.to_uppercase(), "PostToolUse"),
        )
        .await
        .unwrap();
    assert!(answer.to_string().contains("legacy fixture"));
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&10)
        .unwrap()
        .open_files
        .clear();
    inbox
        .turns()
        .offer(PARENT, "unlocked-message", "not delivered")
        .unwrap();
    assert!(outbound
        .codex_stop_hook(PARENT_PID, outbound.uid, &fields(PARENT, "PostToolUse"))
        .await
        .is_err());
    assert!(inbox.turns().has_offered(PARENT));
}
