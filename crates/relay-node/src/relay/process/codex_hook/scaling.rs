//! The ancestry check takes a constant number of kernel file snapshots.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingFiles {
    files: Vec<OpenedFile>,
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
        self.scans.fetch_add(1, Ordering::Relaxed);
        self.files.clone()
    }
    fn cwd(&self, _: i32) -> Option<PathBuf> {
        None
    }
    fn start_clock(&self) -> StartClock {
        StartClock::Ticks
    }
}

#[test]
fn hook_rollout_file_scan_count_is_bounded() -> anyhow::Result<()> {
    let mut counts = Vec::new();
    for count in [2, 12] {
        let temp = tempfile::tempdir()?;
        let parent = "550e8400-e29b-41d4-a716-000000000000";
        let child = "550e8400-e29b-41d4-a716-000000000001";
        let mut files = Vec::new();
        for index in 0..count {
            let thread = format!("550e8400-e29b-41d4-a716-{index:012}");
            let path = temp.path().join(format!("rollout-fixture-{thread}.jsonl"));
            let payload = if index == 1 {
                serde_json::json!({"id":thread,"thread_source":"subagent",
                    "parent_thread_id":parent,
                    "source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}})
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
            scans: AtomicUsize::new(0),
        };
        assert!(held_descendant_of(&table, 10, child, parent));
        counts.push(table.scans.load(Ordering::Relaxed));
    }
    assert_eq!(
        counts,
        [2, 2],
        "kernel snapshots for 2 and 12 held rollouts"
    );
    Ok(())
}
