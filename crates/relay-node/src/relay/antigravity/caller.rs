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

/// Identify which held Antigravity conversation started the tool process `pid`
/// under the trusted `language_server` `host` (with `direct_child` being the
/// process directly spawned by `host`, e.g. `zsh -c <command>`).
pub fn identify(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    uid: u32,
    _pid: i32,
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
    let mut matches = Vec::new();
    let mut uncertain = false;
    for sid in &held {
        match active_turn_commands(config, sid) {
            Some(commands) => {
                if commands.iter().any(|c| c == &command) {
                    matches.push(sid.clone());
                }
            }
            None => uncertain = true,
        }
    }
    if uncertain || matches.len() != 1 {
        return None;
    }
    let chosen = matches.into_iter().next()?;
    let still_same = table.process(host.pid) == Some(host)
        && table.process(child.pid) == Some(child)
        && proof::held(config, table, host.pid, uid)
            .iter()
            .any(|sid| sid == &chosen);
    still_same.then_some(chosen)
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

enum TranscriptFile {
    Absent,
    Readable(PathBuf),
    Unreadable,
}

fn transcript_file(config: &AntigravityConfig, sid: &str) -> TranscriptFile {
    if !is_uuid(sid) {
        return TranscriptFile::Unreadable;
    }
    let logs = config.brain().join(sid).join(".system_generated/logs");
    for name in ["transcript_full.jsonl", "transcript.jsonl"] {
        let path = logs.join(name);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => return TranscriptFile::Readable(path),
            Ok(_) => return TranscriptFile::Unreadable,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return TranscriptFile::Unreadable,
        }
    }
    TranscriptFile::Absent
}

pub(super) fn transcript_path(config: &AntigravityConfig, sid: &str) -> Option<PathBuf> {
    match transcript_file(config, sid) {
        TranscriptFile::Readable(path) => Some(path),
        TranscriptFile::Absent | TranscriptFile::Unreadable => None,
    }
}

/// Returns `Some(rows)` for the active turn (empty when no transcript file
/// exists yet), or `None` when the transcript exists but is unreadable or
/// truncated past `TAIL_BYTES` without a visible turn boundary.
fn active_turn_rows(config: &AntigravityConfig, sid: &str) -> Option<Vec<Value>> {
    let path = match transcript_file(config, sid) {
        TranscriptFile::Absent => return Some(Vec::new()),
        TranscriptFile::Unreadable => return None,
        TranscriptFile::Readable(path) => path,
    };
    let (tail, truncated) = read_tail_checked(&path, TAIL_BYTES)?;
    let mut rows = Vec::new();
    for line in tail.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            return None;
        };
        rows.push(row);
    }
    let user_idx = rows.iter().rposition(|row| {
        row["source"].as_str() == Some("USER_EXPLICIT")
            && row["type"].as_str() == Some("USER_INPUT")
    });
    if truncated && user_idx.is_none() {
        return None;
    }
    let turn_start = user_idx.map_or(0, |idx| idx + 1);
    Some(rows.split_off(turn_start))
}

fn active_turn_commands(config: &AntigravityConfig, sid: &str) -> Option<Vec<String>> {
    let rows = active_turn_rows(config, sid)?;
    let mut commands = Vec::new();
    for row in &rows {
        if row["type"].as_str() != Some("PLANNER_RESPONSE") {
            continue;
        }
        if let Some(calls) = row["tool_calls"].as_array() {
            for call in calls {
                if call["name"].as_str() == Some("run_command") {
                    if let Some(cmd) = call["args"]["CommandLine"].as_str() {
                        commands.push(cmd.to_owned());
                    }
                }
            }
        }
    }
    Some(commands)
}

/// Parse the tail rows of `sid`'s transcript for the in-flight hook check.
/// Returns `Some(rows)` (empty when no transcript file exists yet), or `None`
/// when an existing transcript cannot be read or contains invalid JSON.
fn recent_turn_rows(config: &AntigravityConfig, sid: &str) -> Option<Vec<Value>> {
    let path = match transcript_file(config, sid) {
        TranscriptFile::Absent => return Some(Vec::new()),
        TranscriptFile::Unreadable => return None,
        TranscriptFile::Readable(path) => path,
    };
    let (tail, _truncated) = read_tail_checked(&path, TAIL_BYTES)?;
    let mut rows = Vec::new();
    for line in tail.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            return None;
        };
        rows.push(row);
    }
    let user_idx = rows.iter().rposition(|row| {
        row["source"].as_str() == Some("USER_EXPLICIT")
            && row["type"].as_str() == Some("USER_INPUT")
    });
    let turn_start = user_idx.map_or(0, |idx| idx + 1);
    Some(rows.split_off(turn_start))
}

/// Whether `sid` currently has an in-flight `run_command` tool call that could
/// invoke the managed hook helper directly under `language_server` (either by
/// invoking the helper for `antigravity-hook`, or by replacing its shell via
/// `exec`), or has an unreadable/corrupt transcript (fail closed). Harmless
/// commands like `rg antigravity-hook` and completed commands return `false`.
pub(super) fn inflight_hook_invocation(
    config: &AntigravityConfig,
    sid: &str,
    helper: &Path,
    event: &str,
) -> bool {
    let Some(rows) = recent_turn_rows(config, sid) else {
        return true;
    };
    let Some(last_planner_idx) = rows
        .iter()
        .rposition(|row| row["type"].as_str() == Some("PLANNER_RESPONSE"))
    else {
        return false;
    };
    let Some(calls) = rows[last_planner_idx]["tool_calls"].as_array() else {
        return false;
    };
    let run_commands: Vec<&str> = calls
        .iter()
        .filter(|call| call["name"].as_str() == Some("run_command"))
        .filter_map(|call| call["args"]["CommandLine"].as_str())
        .collect();
    if run_commands.is_empty() {
        return false;
    }
    let done_after = rows[last_planner_idx + 1..]
        .iter()
        .filter(|row| {
            matches!(row["type"].as_str(), Some("RUN_COMMAND" | "TOOL_RESULT"))
                && row["status"].as_str() == Some("DONE")
        })
        .count();
    if done_after >= run_commands.len() {
        return false;
    }
    let helper_name = helper
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    run_commands
        .into_iter()
        .any(|cmd| command_invokes_hook_helper(cmd, helper_name, event))
}

fn is_redirection_prefix(word: &str) -> bool {
    let trimmed = word.trim_start_matches(|c: char| c.is_ascii_digit());
    trimmed.starts_with('<') || trimmed.starts_with('>')
}

fn command_invokes_hook_helper(cmd: &str, helper_name: &str, event: &str) -> bool {
    if helper_name.is_empty() {
        return false;
    }
    for segment in cmd.split([';', '|', '&', '\n']) {
        let Ok(words) = shell_words::split(segment) else {
            // Unparseable shell syntax mentioning exec or the hook subcommand fails closed.
            if segment.contains("antigravity-hook") || segment.contains("exec") {
                return true;
            }
            continue;
        };
        let mut idx = 0;
        while idx < words.len() {
            let word = words[idx].as_str();
            if is_redirection_prefix(word) {
                // Skip `<file` or `< file` leading redirections before the command word.
                let op = word.trim_start_matches(|c: char| c.is_ascii_digit());
                if matches!(op, "<" | ">" | ">>" | "<<<" | "<>" | "<&" | ">&") {
                    idx += 2;
                } else {
                    idx += 1;
                }
                continue;
            }
            if word == "exec" {
                // Any in-flight `exec ...` in a sibling shell can replace the
                // shell so the spawned helper's direct parent is language_server.
                return true;
            }
            if word == "command" || word == "env" {
                idx += 1;
                if word == "env" {
                    while idx < words.len() {
                        let w = words[idx].as_str();
                        if w == "-u" && idx + 1 < words.len() {
                            idx += 2;
                        } else if w.starts_with('-') || w.contains('=') {
                            idx += 1;
                        } else {
                            break;
                        }
                    }
                }
                continue;
            }
            if word.contains('=') && !word.starts_with('/') {
                idx += 1;
                continue;
            }
            break;
        }
        let Some(prog) = words.get(idx) else {
            continue;
        };
        let prog_name = Path::new(prog)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let rest = &words[idx + 1..];
        let invokes_subcommand = rest.first().map(String::as_str) == Some("antigravity-hook")
            && rest.windows(2).any(|w| w[0] == "--event" && w[1] == event);
        if invokes_subcommand && (prog_name == helper_name || prog.starts_with('$')) {
            return true;
        }
    }
    false
}

fn read_tail_checked(path: &Path, limit: u64) -> Option<(String, bool)> {
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
    Some((String::from_utf8_lossy(slice).into_owned(), offset > 0))
}

pub(super) fn read_tail(path: &Path, limit: u64) -> Option<String> {
    read_tail_checked(path, limit).map(|(text, _)| text)
}
