//! The real hook route must bind consumption to the verified active turn,
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
    process::{FakeProcess, FakeProcesses, ProcessTable},
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
    let sessions = local.codex.home.join("sessions");
    std::fs::create_dir_all(&sessions)?;
    let mut open_files = Vec::new();
    for (thread, turn) in [(PARENT, "parent-turn"), (CHILD, "child-turn")] {
        let rollout = sessions.join(format!("rollout-fixture-{thread}.jsonl"));
        std::fs::write(
            &rollout,
            format!(
                "{}\n{}\n",
                if thread == CHILD {
                    json!({"type":"session_meta","payload":{
                        "id":thread, "parent_thread_id":PARENT, "thread_source":"subagent",
                        "source":{"subagent":{"thread_spawn":{"parent_thread_id":PARENT}}}
                    }})
                } else {
                    json!({"type":"session_meta","payload":{"id":thread}})
                },
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn}})
            ),
        )?;
        open_files.push(
            home.join("thread-writer-locks")
                .join(format!("{thread}.lock")),
        );
        open_files.push(rollout);
    }
    table.insert(
        10,
        FakeProcess {
            parent: 1,
            uid: local.uid,
            start: 10,
            executable: Some(executable),
            arguments: vec!["codex".into(), "app-server".into()],
            open_files,
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
                // Hook session ids and environment may both name the parent.
                // The independent turn id must select the receiving conversation.
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
    let mut fields = Map::from_iter([
        ("session_id".into(), json!(thread)),
        ("hook_event_name".into(), json!(event)),
    ]);
    if event != "SessionStart" {
        fields.insert(
            "turn_id".into(),
            json!(if thread.eq_ignore_ascii_case(PARENT) {
                "parent-turn"
            } else {
                "child-turn"
            }),
        );
    }
    fields
}

fn child_hook_claiming_parent(event: &str) -> Map<String, Value> {
    let mut fields = fields(PARENT, event);
    if event != "SessionStart" {
        fields.insert("turn_id".into(), json!("child-turn"));
    }
    fields
}

/// A child cannot take its parent's offer; neither failure nor repeated hooks
/// consume it, and each matching caller still receives its own queue once.
#[tokio::test]
async fn consuming_hook_thread_affinity_preserves_parent_and_child_offers() {
    for event in ["PostToolUse", "Stop"] {
        let (_temp, outbound, inbox, table) = fixture(false).unwrap();
        inbox
            .turns()
            .offer(PARENT, "parent-message", "parent-only fixture")
            .unwrap();
        inbox
            .turns()
            .offer(CHILD, "child-message", "child-only fixture")
            .unwrap();
        assert!(outbound
            .codex_stop_hook(CHILD_PID, outbound.uid, &child_hook_claiming_parent(event))
            .await
            .is_err());
        // Even the parent's correct active turn cannot contradict the
        // kernel-established caller thread while both locks are held.
        assert!(outbound
            .codex_stop_hook(CHILD_PID, outbound.uid, &fields(PARENT, event))
            .await
            .is_err());
        assert!(inbox.turns().has_offered(PARENT));
        // Hooks can inherit the launcher's parent thread environment too.
        // Their actual child turn must independently prevent consumption.
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&CHILD_PID)
            .unwrap()
            .environment
            .insert("CODEX_THREAD_ID".into(), PARENT.into());
        assert!(outbound
            .codex_stop_hook(CHILD_PID, outbound.uid, &child_hook_claiming_parent(event))
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
        // A valid child turn remains usable with its inherited parent env;
        // its held rollout explicitly proves that parent-child relationship.
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
    let (_temp, outbound, inbox, table) = fixture(true).unwrap();
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&CHILD_PID)
        .unwrap()
        .environment
        .insert("CODEX_THREAD_ID".into(), PARENT.into());
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
        .codex_stop_hook(
            CHILD_PID,
            outbound.uid,
            &child_hook_claiming_parent("PostToolUse")
        )
        .await
        .is_err());
    assert!(inbox.needs_registration_guidance(PARENT));
    for (pid, thread) in [(PARENT_PID, PARENT), (CHILD_PID, CHILD)] {
        assert!(outbound
            .codex_stop_hook(pid, outbound.uid, &fields(thread, "SessionStart"))
            .await
            .is_err());
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

/// An active turn cannot replace the trusted executable, writer lock and
/// held rollout; fresh hooks do not require ambient thread ids.
#[tokio::test]
async fn consuming_hook_thread_affinity_keeps_kernel_writer_checks() {
    for missing in ["trust", "lock", "rollout", "turn"] {
        let (_temp, outbound, inbox, table) = fixture(false).unwrap();
        inbox
            .turns()
            .offer(PARENT, "parent-message", "parent-only fixture")
            .unwrap();
        let mut hook = fields(PARENT, "PostToolUse");
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
            "rollout" => {
                table
                    .processes
                    .lock()
                    .unwrap()
                    .get_mut(&10)
                    .unwrap()
                    .open_files
                    .retain(|path| path.extension().is_some_and(|ext| ext == "lock"));
            }
            _ => {
                hook.insert("turn_id".into(), json!("unproven-turn"));
            }
        }
        assert!(outbound
            .codex_stop_hook(PARENT_PID, outbound.uid, &hook)
            .await
            .is_err());
        assert!(inbox.turns().has_offered(PARENT));
    }

    // An inherited parent id needs a proven held ancestry chain, in addition
    // to the child's correct active turn and its own held writer/rollout.
    for invalid in ["missing", "invalid", "unrelated", "held_parent"] {
        let (temp, outbound, inbox, table) = fixture(false).unwrap();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&CHILD_PID)
            .unwrap()
            .environment
            .insert("CODEX_THREAD_ID".into(), PARENT.into());
        if invalid == "held_parent" {
            let mut files = table.opened_files(10);
            for file in &mut files {
                if file.path.extension().is_some_and(|ext| ext == "jsonl")
                    && file.path.to_string_lossy().contains(PARENT)
                {
                    file.birth_ns = Some(-1);
                }
            }
            table
                .processes
                .lock()
                .unwrap()
                .get_mut(&10)
                .unwrap()
                .opened_files = Some(files);
        } else {
            let other = "550e8400-e29b-41d4-a716-446655440002";
            let payload = match invalid {
                "missing" => json!({"id":CHILD}),
                "invalid" => json!({"id":CHILD,"thread_source":"subagent",
                    "parent_thread_id":PARENT,
                    "source":{"subagent":{"thread_spawn":{"parent_thread_id":other}}}}),
                _ => json!({"id":CHILD,"thread_source":"subagent",
                    "parent_thread_id":other,
                    "source":{"subagent":{"thread_spawn":{"parent_thread_id":other}}}}),
            };
            std::fs::write(temp.path().join(".codex/sessions")
                .join(format!("rollout-fixture-{CHILD}.jsonl")), format!("{}\n{}\n",
                json!({"type":"session_meta","payload":payload}),
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"child-turn"}})
            )).unwrap();
        }
        inbox
            .turns()
            .offer(CHILD, "child-proof", "not delivered")
            .unwrap();
        assert!(
            outbound
                .codex_stop_hook(CHILD_PID, outbound.uid, &fields(CHILD, "PostToolUse"))
                .await
                .is_err(),
            "{invalid}"
        );
        assert!(inbox.turns().has_offered(CHILD));
    }

    // A fresh app-server hook can have no thread environment and no resume
    // argument. Its verified, held target rollout still identifies the turn.
    let (_temp, outbound, inbox, table) = fixture(false).unwrap();
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&PARENT_PID)
        .unwrap()
        .environment
        .remove("CODEX_THREAD_ID");
    inbox
        .turns()
        .offer(PARENT, "fresh-message", "fresh fixture")
        .unwrap();
    let answer = outbound
        .codex_stop_hook(PARENT_PID, outbound.uid, &fields(PARENT, "PostToolUse"))
        .await
        .unwrap();
    assert!(answer.to_string().contains("fresh fixture"));

    // Fresh SessionStart has neither THREAD nor resume arguments. Its sole
    // held lock is enough; exercise the actual Outbound route, not a helper.
    let (_temp, outbound, _inbox, table) = fixture(false).unwrap();
    {
        let mut processes = table.processes.lock().unwrap();
        processes
            .get_mut(&PARENT_PID)
            .unwrap()
            .environment
            .remove("CODEX_THREAD_ID");
        let writer = processes.get_mut(&10).unwrap();
        assert_eq!(writer.arguments, ["codex", "app-server"]);
        writer
            .open_files
            .retain(|path| path.to_string_lossy().contains(PARENT));
    }
    assert!(outbound
        .codex_stop_hook(PARENT_PID, outbound.uid, &fields(PARENT, "SessionStart"))
        .await
        .is_ok());

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
            .retain(|path| path.to_string_lossy().contains(PARENT));
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
    assert!(outbound
        .codex_stop_hook(PARENT_PID, outbound.uid, &fields(PARENT, "SessionStart"))
        .await
        .is_ok());
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
