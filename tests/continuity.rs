//! Integration tests for broker-centric continuity logic.
//!
//! Tests the continuity file format (JSON written on release, read on spawn)
//! and the context injection format used when continue_from is set.

use serde_json::{json, Value};
use std::fs;
use std::path::Path;

// ==================== continuity_dir derivation ====================

/// Replicates the `continuity_dir` logic from main.rs (which is private)
/// to verify the path derivation independently.
fn continuity_dir(state_path: &Path) -> std::path::PathBuf {
    state_path
        .parent()
        .expect("state_path always has a parent (.agent-relay/)")
        .join("continuity")
}

#[test]
fn continuity_dir_from_state_path() {
    let state_path = Path::new("/project/.agent-relay/state.json");
    let result = continuity_dir(state_path);
    assert_eq!(result, Path::new("/project/.agent-relay/continuity"));
}

#[test]
fn continuity_dir_from_deeply_nested_state_path() {
    let state_path = Path::new("/home/user/work/repo/.agent-relay/state.json");
    let result = continuity_dir(state_path);
    assert_eq!(
        result,
        Path::new("/home/user/work/repo/.agent-relay/continuity")
    );
}

// ==================== continuity file round-trip ====================

#[test]
fn continuity_file_roundtrip_preserves_all_fields() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let continuity_dir = tmp.path().join("continuity");
    fs::create_dir_all(&continuity_dir).expect("failed to create continuity dir");

    let continuity = json!({
        "agent_name": "Worker1",
        "cli": "claude",
        "initial_task": "Build auth module",
        "cwd": "/project",
        "released_at": 1708000000u64,
        "lifetime_seconds": 3600,
        "message_history": [
            {"from": "Lead", "text": "Please add JWT auth"},
            {"from": "Worker1", "text": "DONE: Added JWT auth"}
        ],
        "summary": "completed auth work"
    });

    let file_path = continuity_dir.join("Worker1.json");
    fs::write(
        &file_path,
        serde_json::to_string_pretty(&continuity).expect("failed to serialize"),
    )
    .expect("failed to write continuity file");

    // Read back and validate
    let contents = fs::read_to_string(&file_path).expect("failed to read continuity file");
    let parsed: Value = serde_json::from_str(&contents).expect("failed to parse JSON");

    assert_eq!(parsed["agent_name"], "Worker1");
    assert_eq!(parsed["cli"], "claude");
    assert_eq!(parsed["initial_task"], "Build auth module");
    assert_eq!(parsed["cwd"], "/project");
    assert_eq!(parsed["released_at"], 1708000000u64);
    assert_eq!(parsed["lifetime_seconds"], 3600);
    assert_eq!(parsed["summary"], "completed auth work");
    assert_eq!(parsed["message_history"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["message_history"][0]["from"], "Lead");
    assert_eq!(parsed["message_history"][1]["from"], "Worker1");
}

#[test]
fn continuity_file_roundtrip_with_null_optional_fields() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let continuity_dir = tmp.path().join("continuity");
    fs::create_dir_all(&continuity_dir).expect("failed to create continuity dir");

    // Simulate a release where cli and cwd are None (null in JSON)
    let continuity = json!({
        "agent_name": "Headless1",
        "cli": null,
        "initial_task": null,
        "cwd": null,
        "released_at": 1708000000u64,
        "lifetime_seconds": 120,
        "message_history": [],
        "summary": null
    });

    let file_path = continuity_dir.join("Headless1.json");
    fs::write(
        &file_path,
        serde_json::to_string_pretty(&continuity).expect("failed to serialize"),
    )
    .expect("failed to write continuity file");

    let contents = fs::read_to_string(&file_path).expect("failed to read continuity file");
    let parsed: Value = serde_json::from_str(&contents).expect("failed to parse JSON");

    assert_eq!(parsed["agent_name"], "Headless1");
    assert!(parsed["cli"].is_null());
    assert!(parsed["initial_task"].is_null());
    assert!(parsed["cwd"].is_null());
    assert!(parsed["summary"].is_null());
    assert_eq!(parsed["message_history"].as_array().unwrap().len(), 0);
}

#[test]
fn continuity_file_named_by_agent() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let continuity_dir = tmp.path().join("continuity");
    fs::create_dir_all(&continuity_dir).expect("failed to create continuity dir");

    // Verify the naming convention: {agent_name}.json
    let names = vec!["Worker1", "AuthAgent", "my-worker-2"];
    for name in &names {
        let continuity = json!({ "agent_name": name });
        let file_path = continuity_dir.join(format!("{}.json", name));
        fs::write(
            &file_path,
            serde_json::to_string(&continuity).expect("serialize"),
        )
        .expect("write");
    }

    // All files should exist and be independently readable
    for name in &names {
        let file_path = continuity_dir.join(format!("{}.json", name));
        assert!(file_path.exists(), "continuity file for {} should exist", name);
        let parsed: Value =
            serde_json::from_str(&fs::read_to_string(&file_path).unwrap()).unwrap();
        assert_eq!(parsed["agent_name"], *name);
    }
}

// ==================== continuity context injection format ====================

/// Replicates the context injection logic from main.rs spawn_agent to verify
/// the format independently.
fn build_continuity_context(
    agent_name: &str,
    ctx: &Value,
    new_task: Option<&str>,
) -> String {
    let prev_task = ctx
        .get("initial_task")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let summary = ctx
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("no summary");

    let history_str = ctx
        .get("message_history")
        .and_then(|v| v.as_array())
        .map(|msgs| {
            msgs.iter()
                .filter_map(|m| {
                    let from = m.get("from")?.as_str()?;
                    let text = m.get("text").or_else(|| m.get("body"))?.as_str()?;
                    Some(format!("  - {}: {}", from, text))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    let history_section = if history_str.is_empty() {
        String::new()
    } else {
        format!("\nRecent messages:\n{}", history_str)
    };

    let continuity_block = format!(
        "## Continuity Context (from previous session as '{}')\n\
         Previous task: {}\n\
         Session summary: {}{}",
        agent_name, prev_task, summary, history_section
    );

    match new_task {
        Some(task) => format!("{}\n\n## Current Task\n{}", continuity_block, task),
        None => continuity_block,
    }
}

#[test]
fn continuity_context_includes_all_sections_with_new_task() {
    let ctx = json!({
        "initial_task": "Build auth module",
        "summary": "completed JWT auth",
        "message_history": [
            {"from": "Lead", "text": "Add JWT"},
            {"from": "Worker1", "text": "Done"}
        ]
    });

    let result = build_continuity_context("Worker1", &ctx, Some("Continue the auth work"));

    assert!(
        result.contains("## Continuity Context (from previous session as 'Worker1')"),
        "should contain continuity header"
    );
    assert!(
        result.contains("Previous task: Build auth module"),
        "should contain previous task"
    );
    assert!(
        result.contains("Session summary: completed JWT auth"),
        "should contain session summary"
    );
    assert!(
        result.contains("Recent messages:"),
        "should contain message history header"
    );
    assert!(
        result.contains("Lead: Add JWT"),
        "should contain message from Lead"
    );
    assert!(
        result.contains("Worker1: Done"),
        "should contain message from Worker1"
    );
    assert!(
        result.contains("## Current Task\nContinue the auth work"),
        "should contain current task section"
    );
}

#[test]
fn continuity_context_without_new_task_omits_current_task_section() {
    let ctx = json!({
        "initial_task": "Build auth module",
        "summary": "completed JWT auth",
        "message_history": []
    });

    let result = build_continuity_context("Worker1", &ctx, None);

    assert!(result.contains("## Continuity Context"));
    assert!(result.contains("Build auth module"));
    assert!(result.contains("completed JWT auth"));
    assert!(
        !result.contains("## Current Task"),
        "should not contain current task section when no new task is given"
    );
}

#[test]
fn continuity_context_with_missing_fields_uses_defaults() {
    // Simulate a continuity file with null/missing fields
    let ctx = json!({
        "initial_task": null,
        "summary": null,
        "message_history": null
    });

    let result = build_continuity_context("Agent1", &ctx, Some("Do something"));

    assert!(
        result.contains("Previous task: unknown"),
        "should fall back to 'unknown' for null initial_task"
    );
    assert!(
        result.contains("Session summary: no summary"),
        "should fall back to 'no summary' for null summary"
    );
    assert!(
        !result.contains("Recent messages:"),
        "should not contain message history when null"
    );
}

#[test]
fn continuity_context_with_empty_message_history_omits_messages_section() {
    let ctx = json!({
        "initial_task": "Setup CI",
        "summary": "configured GitHub Actions",
        "message_history": []
    });

    let result = build_continuity_context("CI-Agent", &ctx, Some("Add deploy step"));

    assert!(result.contains("Previous task: Setup CI"));
    assert!(result.contains("Session summary: configured GitHub Actions"));
    assert!(
        !result.contains("Recent messages:"),
        "should not include messages header for empty history"
    );
    assert!(result.contains("## Current Task\nAdd deploy step"));
}

// ==================== edge cases ====================

#[test]
fn continuity_file_missing_returns_none_on_read() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let continuity_dir = tmp.path().join("continuity");
    fs::create_dir_all(&continuity_dir).expect("create dir");

    let file_path = continuity_dir.join("NonExistent.json");
    let result = fs::read_to_string(&file_path);

    assert!(
        result.is_err(),
        "reading a non-existent continuity file should error"
    );
}

#[test]
fn continuity_file_with_malformed_json_fails_parse() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let continuity_dir = tmp.path().join("continuity");
    fs::create_dir_all(&continuity_dir).expect("create dir");

    let file_path = continuity_dir.join("BadAgent.json");
    fs::write(&file_path, "{ not valid json }").expect("write");

    let contents = fs::read_to_string(&file_path).expect("read");
    let result: Result<Value, _> = serde_json::from_str(&contents);

    assert!(
        result.is_err(),
        "malformed JSON should fail to parse"
    );
}

#[test]
fn continuity_overwrites_existing_file_on_re_release() {
    let tmp = tempfile::tempdir().expect("failed to create temp dir");
    let continuity_dir = tmp.path().join("continuity");
    fs::create_dir_all(&continuity_dir).expect("create dir");

    let file_path = continuity_dir.join("Worker1.json");

    // First release
    let first = json!({ "agent_name": "Worker1", "summary": "first session" });
    fs::write(
        &file_path,
        serde_json::to_string_pretty(&first).unwrap(),
    )
    .unwrap();

    // Second release overwrites
    let second = json!({ "agent_name": "Worker1", "summary": "second session" });
    fs::write(
        &file_path,
        serde_json::to_string_pretty(&second).unwrap(),
    )
    .unwrap();

    let parsed: Value =
        serde_json::from_str(&fs::read_to_string(&file_path).unwrap()).unwrap();
    assert_eq!(
        parsed["summary"], "second session",
        "latest release should overwrite previous continuity data"
    );
}
