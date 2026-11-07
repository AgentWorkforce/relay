use super::*;
use crate::relay::claude::ClaudeConfig;
use crate::relay::process::{FakeProcess, FakeProcesses, StartClock};
use crate::relay::store::SessionKind;
use serde_json::json;
use std::sync::Arc;

const SESSION: &str = "5f7c1f64-8f53-4c33-9d2f-7c1d2f1f0a11";

fn adapter(home: &Path, table: Arc<FakeProcesses>) -> ClaudeAdapter {
    let env =
        |key: &str| (key == "CLAUDE_CONFIG_DIR").then(|| home.join("claude").display().to_string());
    ClaudeAdapter {
        claude: ClaudeConfig::resolve(&env, home, &[]),
        table,
        environment: None,
        logs: home.join("logs"),
        systemd_run: None,
    }
}

fn target() -> Target {
    Target::new(SessionKind::ClaudeTerminal, SESSION)
}

fn at(offset: i64) -> LocalTranscriptCursor {
    LocalTranscriptCursor {
        ts_ms: 0,
        id: offset,
    }
}

fn lines(events: &[Value]) -> String {
    events.iter().map(|event| format!("{event}\n")).collect()
}

#[test]
fn a_claude_not_started_yet_has_an_empty_transcript_to_follow_from_the_start() {
    let home = tempfile::tempdir().unwrap();
    let claude = adapter(home.path(), Arc::new(FakeProcesses::default()));
    let page = claude.transcript(&target(), None).unwrap();
    assert!(page.entries.is_empty());
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.follow_cursor, Some(at(0)));
}

#[test]
fn what_it_was_asked_said_and_ran_is_its_transcript() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("logs")).unwrap();
    let log = lines(&[
        json!({"type": "system", "subtype": "init", "cwd": "/repo"}),
        json!({"type": "user", "message": {"role": "user", "content": "Fix CI"}}),
        json!({"type": "assistant", "message": {"content": [
            {"type": "thinking", "thinking": "Look at the logs"},
            {"type": "text", "text": "Reading the workflow."},
            {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
        ]}}),
        json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "content": [{"type": "text", "text": "ci.yml"}]},
        ]}}),
        json!({"type": "result", "subtype": "success", "result": "Done."}),
        json!({"type": "result", "is_error": true, "subtype": "error_max_turns"}),
    ]);
    std::fs::write(home.path().join(format!("logs/{SESSION}.jsonl")), &log).unwrap();
    let claude = adapter(home.path(), Arc::new(FakeProcesses::default()));
    let page = claude.transcript(&target(), None).unwrap();
    let shown: Vec<(&str, &str, &str)> = page
        .entries
        .iter()
        .map(|entry| {
            (
                entry.role.as_str(),
                entry.kind.as_str(),
                entry.text.as_str(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("user", "text", "Fix CI"),
            ("assistant", "thinking", "Look at the logs"),
            ("assistant", "text", "Reading the workflow."),
            ("assistant", "tool_use", "Bash {\"command\":\"ls\"}"),
            ("user", "tool_result", "ci.yml"),
            (
                "assistant",
                "context",
                "The turn ended with an error: error_max_turns"
            ),
        ]
    );
    let ids: std::collections::HashSet<&str> =
        page.entries.iter().map(|entry| entry.id.as_str()).collect();
    assert_eq!(ids.len(), page.entries.len(), "ids are unique");
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.follow_cursor, Some(at(log.len() as i64)));

    // Following from there reads only what is written next, and never a
    // line still being written.
    let follow = page.follow_cursor.clone();
    let mut grown = log.clone();
    grown.push_str(&lines(&[
        json!({"type": "assistant", "message": {"content": "Next."}}),
    ]));
    grown.push_str("{\"type\":\"assistant\",\"mess");
    std::fs::write(home.path().join(format!("logs/{SESSION}.jsonl")), &grown).unwrap();
    let next = claude.transcript(&target(), follow.as_ref()).unwrap();
    assert_eq!(next.entries.len(), 1);
    assert_eq!(next.entries[0].text, "Next.");
    assert_eq!(next.entries[0].id, format!("{}.0", log.len()));
    let complete = grown.rfind('\n').unwrap() as i64 + 1;
    assert_eq!(next.follow_cursor, Some(at(complete)));
    let again = claude.transcript(&target(), Some(&at(complete))).unwrap();
    assert!(again.entries.is_empty());
}

#[test]
fn a_long_log_is_read_a_page_at_a_time_and_long_text_is_cut() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("log.jsonl");
    let big = "x".repeat(ENTRY_CHARS + 10);
    let event = json!({"type": "assistant", "message": {"content": big}});
    let count = (PAGE_BYTES as usize / big.len()) + 2;
    std::fs::write(&path, lines(&vec![event; count])).unwrap();
    let first = read_page(&path, None).unwrap();
    assert!(first.entries[0].truncated);
    assert_eq!(first.entries[0].text.chars().count(), ENTRY_CHARS);
    let next = first.next_cursor.clone().expect("more to read");
    assert_eq!(first.follow_cursor, Some(next.clone()));
    let mut read = first.entries.len();
    let mut cursor = Some(next);
    while let Some(from) = cursor {
        let page = read_page(&path, Some(&from)).unwrap();
        read += page.entries.len();
        assert_ne!(page.next_cursor, Some(from));
        cursor = page.next_cursor;
    }
    assert_eq!(read, count);
}

#[test]
fn an_event_of_many_blocks_is_split_across_pages_that_fit_the_bridge() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("log.jsonl");
    // Small blocks make entries larger serialized than the log they come
    // from, and these are not even a page of the log.
    let blocks: Vec<Value> = (0..3_000)
        .map(|n| json!({"type": "text", "text": format!("b{n}")}))
        .chain([json!({"type": "text", "text": "\u{1}".repeat(ENTRY_CHARS + 1)})])
        .collect();
    let count = blocks.len();
    let event = json!({"type": "assistant", "message": {"content": blocks}});
    let tail = json!({"type": "user", "message": {"content": "after"}});
    let log = lines(&[event, tail]);
    assert!((log.len() as u64) < PAGE_BYTES);
    std::fs::write(&path, &log).unwrap();
    let (mut cursor, mut ids, mut cursors) = (None, Vec::new(), Vec::new());
    loop {
        let page = read_page(&path, cursor.as_ref()).unwrap();
        let size = serde_json::to_vec(&page).unwrap().len() as u64;
        assert!(size <= PAGE_BYTES + 1024, "{size} bytes");
        ids.extend(page.entries.into_iter().map(|entry| entry.id));
        assert_ne!(page.next_cursor, cursor, "every page moves on");
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
        cursors.extend(cursor.clone());
    }
    assert!(
        cursors.iter().any(|at| at.id == 0 && at.ts_ms > 0),
        "a page ends within the event: {cursors:?}"
    );
    let expected: Vec<String> = (0..count)
        .map(|n| format!("0.{n}"))
        .chain([format!("{}", log.find('\n').unwrap() + 1) + ".0"])
        .collect();
    assert_eq!(ids, expected, "every entry once, in order");
}

#[test]
fn unreadable_lines_and_blocks_it_does_not_show_are_skipped() {
    let entries = event_entries(
        7,
        &json!({"type": "assistant", "timestamp": "2026-10-15T10:00:00Z",
                "message": {"content": [{"type": "image"}, {"type": "text", "text": "hi"}]}}),
        5,
    );
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].0, 1);
    assert_eq!(entries[0].1.id, "7.1");
    assert_eq!(entries[0].1.timestamp_ms, 1_792_058_400_000);
    assert!(event_entries(0, &json!({"type": "system"}), 5).is_empty());
    assert!(event_entries(0, &json!({"type": "result", "result": "ok"}), 5).is_empty());
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("log.jsonl");
    std::fs::write(
        &path,
        "not json\n{\"type\":\"user\",\"message\":{\"content\":\"a\"}}\n",
    )
    .unwrap();
    let page = read_page(&path, None).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(
        page.entries[0].timestamp_ms > 0,
        "the write time of the log"
    );
}

#[test]
fn its_session_is_whichever_process_claude_code_lists_for_it() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses {
        clock: Some(StartClock::Ticks),
        ..FakeProcesses::default()
    });
    let claude = adapter(home.path(), table.clone());
    assert_eq!(claude.session(&target()), None);
    let registry = home.path().join("claude/sessions");
    std::fs::create_dir_all(&registry).unwrap();
    std::fs::write(
        registry.join("300.json"),
        json!({"sessionId": SESSION, "pid": 300, "procStart": "100", "peerProtocol": 1,
               "messagingSocketPath": "/tmp/peer.sock", "cwd": "/work/api"})
        .to_string(),
    )
    .unwrap();
    assert_eq!(claude.session(&target()), None, "its process is gone");
    table.insert(
        300,
        FakeProcess {
            start: 100,
            ..FakeProcess::default()
        },
    );
    assert_eq!(
        claude.session(&target()),
        Some(RunningSession {
            process: SpawnedProcess {
                pid: 300,
                start: 100
            },
            directory: Some(PathBuf::from("/work/api")),
        })
    );
    let other = Target::new(
        SessionKind::ClaudeTerminal,
        "11111111-2222-3333-4444-555555555555",
    );
    assert_eq!(claude.session(&other), None);
}
