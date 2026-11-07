//! The ancestry check takes a constant number of kernel file snapshots.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingFiles {
    files: Vec<OpenedFile>,
    after: Option<Vec<OpenedFile>>,
    scans: AtomicUsize,
}

impl ProcessTable for CountingFiles {
    fn process(&self, _: i32) -> Option<ProcessInfo> {
        None
    }
    fn all_pids(&self) -> Vec<i32> {
        Vec::new()
    }
    fn executable(&self, _: i32) -> Option<PathBuf> {
        None
    }
    fn is_trusted_codex(&self, _: &Path) -> bool {
        false
    }
    fn command_line(&self, _: i32) -> CommandLine {
        CommandLine::default()
    }
    fn open_files(&self, _: i32) -> Vec<PathBuf> {
        self.files.iter().map(|file| file.path.clone()).collect()
    }
    fn opened_files(&self, _: i32) -> Vec<OpenedFile> {
        let scan = self.scans.fetch_add(1, Ordering::Relaxed);
        if scan == 0 {
            self.files.clone()
        } else {
            self.after.as_ref().unwrap_or(&self.files).clone()
        }
    }
    fn cwd(&self, _: i32) -> Option<PathBuf> {
        None
    }
    fn start_clock(&self) -> StartClock {
        StartClock::Ticks
    }
}

const PARENT: &str = "550e8400-e29b-41d4-a716-000000000000";
const CHILD: &str = "550e8400-e29b-41d4-a716-000000000001";

/// Build real rollout headers with captured file births for the snapshot tests.
fn fixture(count: usize) -> anyhow::Result<(tempfile::TempDir, CountingFiles)> {
    let temp = tempfile::tempdir()?;

    let mut files = Vec::new();
    for index in 0..count {
        let thread = format!("550e8400-e29b-41d4-a716-{index:012}");
        let path = temp.path().join(format!("rollout-fixture-{thread}.jsonl"));
        let payload = if index == 1 {
            serde_json::json!({"id":thread,"thread_source":"subagent",
                    "parent_thread_id":PARENT,
                    "source":{"subagent":{"thread_spawn":{"parent_thread_id":PARENT}}}})
        } else {
            serde_json::json!({"id":thread})
        };
        std::fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::json!({
                    "type":"session_meta","payload":payload
                })
            ),
        )?;
        files.push(OpenedFile {
            birth_ns: file_birth_ns(&path),
            path,
        });
        files.push(OpenedFile {
            path: temp
                .path()
                .join("thread-writer-locks")
                .join(format!("{thread}.lock")),
            birth_ns: None,
        });
    }
    let table = CountingFiles {
        files,
        after: None,
        scans: AtomicUsize::new(0),
    };
    Ok((temp, table))
}

#[test]
fn hook_rollout_file_scan_count_is_bounded() -> anyhow::Result<()> {
    let mut counts = Vec::new();
    for count in [2, 12] {
        let (_temp, table) = fixture(count)?;
        assert!(held_descendant_of(&table, 10, CHILD, PARENT));
        counts.push(table.scans.load(Ordering::Relaxed));
    }
    assert_eq!(
        counts,
        [2, 2],
        "kernel snapshots for 2 and 12 held rollouts"
    );
    Ok(())
}

#[test]
fn hook_rollout_second_snapshot_changes_deny() -> anyhow::Result<()> {
    for change in ["parent_lock", "rollout", "birth"] {
        let (_temp, mut table) = fixture(2)?;
        let mut after = table.files.clone();
        match change {
            "parent_lock" => {
                after.retain(|file| codex_thread_of_lock(&file.path).as_deref() != Some(PARENT))
            }
            "rollout" => {
                after.retain(|file| rollout_thread_of_path(&file.path).as_deref() != Some(CHILD))
            }
            _ => {
                for file in &mut after {
                    if rollout_thread_of_path(&file.path).as_deref() == Some(PARENT) {
                        file.birth_ns = file.birth_ns.map(|birth| birth + 1);
                    }
                }
            }
        }
        table.after = Some(after);
        assert!(!held_descendant_of(&table, 10, CHILD, PARENT), "{change}");
        assert_eq!(table.scans.load(Ordering::Relaxed), 2, "{change}");
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn hook_rollout_reader_uses_verified_canonical_path() -> anyhow::Result<()> {
    use crate::relay::codex::rollout::RolloutSummary;
    let temp = tempfile::tempdir()?;
    let rollout = temp.path().join(format!("rollout-fixture-{PARENT}.jsonl"));
    let other = temp.path().join("other.jsonl");
    let alias = temp.path().join("alias.jsonl");
    for (path, turn) in [(&rollout, "verified-turn"), (&other, "other-turn")] {
        std::fs::write(
            path,
            format!(
                "{}\n",
                serde_json::json!({
                    "type":"event_msg","payload":{"type":"task_started","turn_id":turn}
                })
            ),
        )?;
    }
    std::os::unix::fs::symlink(&rollout, &alias)?;
    let canonical = rollout.canonicalize()?;
    let table = FakeProcesses::default();
    let executable = temp.path().join("codex");
    table.trust(&executable);
    table.insert(
        10,
        FakeProcess {
            parent: 1,
            uid: 501,
            start: 10,
            executable: Some(executable),
            arguments: vec!["codex".into(), "app-server".into()],
            open_files: vec![
                rollout,
                temp.path()
                    .join("thread-writer-locks")
                    .join(format!("{PARENT}.lock")),
            ],
            ..FakeProcess::default()
        },
    );
    table.insert(
        20,
        FakeProcess {
            parent: 10,
            uid: 501,
            start: 20,
            ..FakeProcess::default()
        },
    );
    assert!(with_codex_hook_rollout(
        &table,
        20,
        501,
        PARENT,
        &alias,
        |verified_path| {
            assert_eq!(verified_path, canonical);
            std::fs::remove_file(&alias).unwrap();
            std::os::unix::fs::symlink(&other, &alias).unwrap();
            assert_eq!(
                RolloutSummary::read(&alias).unwrap().active_turn.as_deref(),
                Some("other-turn")
            );
            RolloutSummary::read(verified_path)
                .is_some_and(|summary| summary.active_turn.as_deref() == Some("verified-turn"))
        }
    ));
    Ok(())
}
