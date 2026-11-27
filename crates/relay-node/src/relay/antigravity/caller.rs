//! Caller identification for tool commands running under Antigravity's shared
//! `language_server`.
//!
//! When `language_server` holds a single conversation open, its open
//! `conversations/<uuid>.db` descriptor names the caller directly. When it
//! holds several conversations, the direct child shell's command line is
//! matched against each held conversation's live `transcript_full.jsonl`
//! active-turn `run_command` tool calls (the same transcript-witness pattern
//! Codex's shared stdio app-server uses), so another conversation cannot spoof
//! `ANTIGRAVITY_CONVERSATION_ID` and Apple-signed `/usr/bin/curl` / `/bin/zsh`
//! work on macOS without needing readable process environments.
use super::{proof, AntigravityConfig};
use crate::relay::process::{ProcessInfo, ProcessTable};
use crate::relay::store::is_uuid;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const TAIL_BYTES: u64 = 256 * 1024;
const CONVERSATION_VAR: &str = "ANTIGRAVITY_CONVERSATION_ID";

/// Identify which held Antigravity conversation started the tool process `pid`
/// under the trusted `language_server` `host` (with `direct_child` being the
/// process directly spawned by `host`, e.g. `zsh -c <command>`).
pub fn identify(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    uid: u32,
    pid: i32,
    host: ProcessInfo,
    direct_child: Option<ProcessInfo>,
) -> Option<String> {
    let runtime = proof::runtime(table, host.pid, uid)?;
    if runtime != host {
        return None;
    }
    let held = proof::held(config, table, host.pid, uid);
    if held.is_empty() {
        return None;
    }
    if held.len() == 1 {
        return (table.process(host.pid) == Some(host)).then(|| held[0].clone());
    }
    let child = direct_child?;
    let command = shell_command(table, child.pid)?;
    let matches: Vec<String> = held
        .iter()
        .filter(|sid| transcript_runs_command(config, sid, &command))
        .cloned()
        .collect();
    let chosen = match matches.len() {
        0 => return None,
        1 => matches[0].clone(),
        _ => {
            // Multiple held conversations issued the exact same command string
            // in their current turn (e.g. `agent-relay-probe agents`). Use the
            // caller's own env tag only to break ties among witnessed matches.
            let tagged =
                env_conversation(table, pid).or_else(|| env_conversation(table, child.pid))?;
            matches.into_iter().find(|sid| sid == &tagged)?
        }
    };
    let still_same = table.process(host.pid) == Some(host)
        && table.process(child.pid) == Some(child)
        && proof::held(config, table, host.pid, uid)
            .iter()
            .any(|sid| sid == &chosen);
    still_same.then_some(chosen)
}

fn env_conversation(table: &dyn ProcessTable, pid: i32) -> Option<String> {
    table
        .environment_var(pid, CONVERSATION_VAR)
        .map(|s| s.trim().to_owned())
        .filter(|s| is_uuid(s))
}

fn shell_command(table: &dyn ProcessTable, pid: i32) -> Option<String> {
    let args = table.arguments(pid);
    if args.is_empty() {
        return None;
    }
    let base = Path::new(&args[0])
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let shell = matches!(
        base.trim_start_matches('-'),
        "sh" | "zsh" | "bash" | "dash" | "fish"
    );
    if shell && args.len() >= 3 && matches!(args[1].as_str(), "-c" | "-lc" | "-ic") {
        let script = args[2].as_str();
        if !script.is_empty() {
            return Some(script.to_owned());
        }
    }
    None
}

pub(super) fn transcript_path(config: &AntigravityConfig, sid: &str) -> Option<PathBuf> {
    if !is_uuid(sid) {
        return None;
    }
    let logs = config.brain().join(sid).join(".system_generated/logs");
    let full = logs.join("transcript_full.jsonl");
    if full.is_file() {
        return Some(full);
    }
    let compact = logs.join("transcript.jsonl");
    compact.is_file().then_some(compact)
}

fn transcript_runs_command(config: &AntigravityConfig, sid: &str, command: &str) -> bool {
    let Some(path) = transcript_path(config, sid) else {
        return false;
    };
    let Some(tail) = read_tail(&path, TAIL_BYTES) else {
        return false;
    };
    // Inspect only the current turn (steps after the most recent USER_INPUT).
    let mut rows = Vec::new();
    for line in tail.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<Value>(line) {
            rows.push(row);
        }
    }
    let turn_start = rows
        .iter()
        .rposition(|row| {
            row["source"].as_str() == Some("USER_EXPLICIT")
                && row["type"].as_str() == Some("USER_INPUT")
        })
        .map_or(0, |idx| idx + 1);
    rows[turn_start..].iter().any(|row| {
        row["type"].as_str() == Some("PLANNER_RESPONSE")
            && row["tool_calls"].as_array().is_some_and(|calls| {
                calls.iter().any(|call| {
                    call["name"].as_str() == Some("run_command")
                        && call["args"]["CommandLine"].as_str() == Some(command)
                })
            })
    })
}

pub(super) fn read_tail(path: &Path, limit: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let offset = len.saturating_sub(limit);
    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).ok()?;
    }
    let mut buf = Vec::new();
    file.take(limit).read_to_end(&mut buf).ok()?;
    let slice = if offset > 0 {
        match buf.iter().position(|b| *b == b'\n') {
            Some(pos) => &buf[pos + 1..],
            None => return None,
        }
    } else {
        &buf[..]
    };
    Some(String::from_utf8_lossy(slice).into_owned())
}
