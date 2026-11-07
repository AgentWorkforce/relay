use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};

fn process(parent: i32, executable: &str) -> FakeProcess {
    FakeProcess {
        parent,
        uid: 501,
        start: 100,
        executable: Some(executable.into()),
        ..FakeProcess::default()
    }
}
fn inherited_tool(table: &FakeProcesses, parent: i32) {
    let mut tool = process(parent, "/trusted/Agent Relay Helper");
    tool.environment.insert(
        "CODEX_THREAD_ID".into(),
        "11111111-1111-4111-8111-111111111111".into(),
    );
    table.insert(400, tool);
}

#[test]
fn versioned_muse_blocks_inherited_codex_identity_without_lending_outer_session() {
    let table = FakeProcesses::default();
    table
        .trusted_codex
        .lock()
        .unwrap()
        .insert(PathBuf::from("/trusted/codex"));
    table.insert(100, process(1, "/trusted/codex"));
    for name in ["muse", "muse-bin-1.4.9-R6297.1", "muse-nightly"] {
        table.insert(200, process(100, &format!("/opt/{name}")));
        table.insert(300, process(200, "/bin/bash"));
        inherited_tool(&table, 300);
        assert!(
            !codex_tag_names_caller(&table, 400, 501, false, false),
            "{name}"
        );
    }
}

#[test]
fn an_actual_nearer_trusted_codex_keeps_its_own_proof_path() {
    let table = FakeProcesses::default();
    table
        .trusted_codex
        .lock()
        .unwrap()
        .insert(PathBuf::from("/trusted/codex"));
    table.insert(100, process(1, "/opt/muse-bin-1.4.9"));
    table.insert(200, process(100, "/trusted/codex"));
    inherited_tool(&table, 200);
    assert!(codex_tag_names_caller(&table, 400, 501, false, false));
}

#[test]
fn versioned_muse_stops_a_grok_claim_at_the_nearest_agent_boundary() {
    let table = FakeProcesses::default();
    let mut leader = process(1, "/opt/grok");
    leader.arguments = vec!["grok".into(), "agent".into(), "leader".into()];
    table.insert(100, leader);
    table.insert(200, process(100, "/opt/muse-bin-1.4.9"));
    inherited_tool(&table, 200);
    assert_eq!(nearest_leader(&table, 400, 501), None);
    assert_eq!(nearest_leader(&table, 100, 501), Some(100));
}
