//! Read-only detection of the automatic push jobs installed by legacy ai-hist.
//! No auth, history cursor, scheduler, or service configuration is modified.
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LABEL: &str = "com.ai-hist.push";
const CRON_MARKER: &str = "# ai-hist push (managed)";
const OUTPUT_CAP: u64 = 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub state: &'static str,
    /// Fixed labels only: scheduler output may contain private commands.
    pub jobs: Vec<&'static str>,
}

struct Inspection {
    success: bool,
    stdout: String,
    stderr: String,
}

enum CommandInspection {
    Output(Inspection),
    Missing,
    Failed,
}

/// Check the current user's legacy scheduler registrations. A stored launchd
/// plist counts as active even when unloaded: it can restart at the next login.
/// This cannot discover arbitrary schedules installed manually under other names.
pub fn status() -> MigrationStatus {
    if !matches!(std::env::consts::OS, "macos" | "linux") {
        return MigrationStatus {
            state: "clear",
            jobs: vec!["legacy-installer-unsupported"],
        };
    }
    let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) else {
        return MigrationStatus {
            state: "unknown",
            jobs: vec!["home-unavailable"],
        };
    };
    inspect(Path::new(&home), std::env::consts::OS, bounded_command)
}

fn inspect(
    home: &Path,
    os: &str,
    mut run: impl FnMut(&str, &[&str]) -> CommandInspection,
) -> MigrationStatus {
    let mut active = false;
    let mut unknown = false;
    let mut jobs = Vec::new();
    if os == "macos" {
        match fs::symlink_metadata(home.join("Library/LaunchAgents/com.ai-hist.push.plist")) {
            Ok(_) => {
                active = true;
                jobs.push("launchd-plist");
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                unknown = true;
                jobs.push("launchd-plist-status-unknown");
            }
        }
        match run("/bin/launchctl", &["list"]) {
            CommandInspection::Output(output) if output.success => {
                if output
                    .stdout
                    .lines()
                    .any(|line| line.split_whitespace().last() == Some(LABEL))
                {
                    active = true;
                    jobs.push("launchd-loaded");
                }
            }
            _ => {
                unknown = true;
                jobs.push("launchd-status-unknown");
            }
        }
    }
    if matches!(os, "macos" | "linux") {
        match run("/usr/bin/crontab", &["-l"]) {
            CommandInspection::Output(output) if output.success => {
                if output.stdout.lines().any(|line| {
                    let line = line.trim_start();
                    !line.starts_with('#') && line.contains(CRON_MARKER)
                }) {
                    active = true;
                    jobs.push("managed-cron");
                }
            }
            // LC_ALL=C below makes this empty-table diagnostic stable on the
            // supported cron implementations. Every other failure is unknown.
            CommandInspection::Output(output)
                if output.stdout.trim().is_empty() && empty_crontab(&output.stderr) => {}
            // cron is optional on supported hosts. If its program is absent,
            // it cannot have installed the managed per-user job this guard is
            // looking for. Execution and read failures remain unknown below.
            CommandInspection::Missing => {}
            _ => {
                unknown = true;
                jobs.push("cron-status-unknown");
            }
        }
    } else {
        // The legacy automatic installer never supported other platforms.
        // This says nothing about arbitrary schedules created by users.
        jobs.push("legacy-installer-unsupported");
    }
    MigrationStatus {
        state: if active {
            "active"
        } else if unknown {
            "unknown"
        } else {
            "clear"
        },
        jobs,
    }
}

fn empty_crontab(stderr: &str) -> bool {
    let stderr = stderr.trim();
    let no_table = stderr
        .strip_prefix("crontab: ")
        .unwrap_or(stderr)
        .starts_with("no crontab for ");
    let missing_store = stderr.contains("No such file or directory")
        && ["/var/spool/cron", "/usr/lib/cron/tabs"]
            .iter()
            .any(|path| stderr.contains(path));
    no_table || missing_store
}

fn bounded_command(program: &str, args: &[&str]) -> CommandInspection {
    // Temporary files avoid pipe deadlocks; bounds and deadline are checked while
    // the subprocess runs. Nothing from these files is returned to the caller.
    let Ok(stdout) = tempfile::tempfile() else {
        return CommandInspection::Failed;
    };
    let Ok(stderr) = tempfile::tempfile() else {
        return CommandInspection::Failed;
    };
    let child = Command::new(program)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(match stdout.try_clone() {
            Ok(file) => file,
            Err(_) => return CommandInspection::Failed,
        })
        .stderr(match stderr.try_clone() {
            Ok(file) => file,
            Err(_) => return CommandInspection::Failed,
        })
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return CommandInspection::Missing;
        }
        Err(_) => return CommandInspection::Failed,
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        let bounded = stdout.metadata().is_ok_and(|m| m.len() <= OUTPUT_CAP)
            && stderr.metadata().is_ok_and(|m| m.len() <= OUTPUT_CAP);
        if !bounded || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return CommandInspection::Failed;
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return CommandInspection::Failed;
            }
        }
    };
    fn read(mut file: fs::File) -> Option<String> {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).ok()?;
        let mut bytes = Vec::new();
        file.take(OUTPUT_CAP + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > OUTPUT_CAP {
            return None;
        }
        String::from_utf8(bytes).ok()
    }
    let Some(stdout) = read(stdout) else {
        return CommandInspection::Failed;
    };
    let Some(stderr) = read(stderr) else {
        return CommandInspection::Failed;
    };
    CommandInspection::Output(Inspection {
        success: status.success(),
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output(success: bool, stdout: &str, stderr: &str) -> CommandInspection {
        CommandInspection::Output(Inspection {
            success,
            stdout: stdout.into(),
            stderr: stderr.into(),
        })
    }
    #[test]
    fn clear_when_no_plist_loaded_label_or_active_managed_cron() {
        let home = tempfile::tempdir().unwrap();
        let status = inspect(home.path(), "macos", |program, _| {
            if program.contains("launchctl") {
                output(true, "PID Status Label\n- 0 com.ai-hist.sync\n", "")
            } else {
                output(true, "# * * * * * ai-hist push # ai-hist push (managed)\n* * * * * ai-hist sync # ai-hist sync (managed)", "")
            }
        });
        assert_eq!(
            status,
            MigrationStatus {
                state: "clear",
                jobs: vec![]
            }
        );
        assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
    }
    #[test]
    fn loaded_launchd_remains_active_after_plist_removed() {
        let home = tempfile::tempdir().unwrap();
        let status = inspect(home.path(), "macos", |program, _| {
            if program.contains("launchctl") {
                output(true, "- 0 com.ai-hist.push\n", "")
            } else {
                output(false, "", "crontab: no crontab for fixture")
            }
        });
        assert_eq!(
            status,
            MigrationStatus {
                state: "active",
                jobs: vec!["launchd-loaded"]
            }
        );
    }
    #[test]
    fn plist_and_cron_block_without_returning_private_contents() {
        let home = tempfile::tempdir().unwrap();
        let plist = home
            .path()
            .join("Library/LaunchAgents/com.ai-hist.push.plist");
        fs::create_dir_all(plist.parent().unwrap()).unwrap();
        fs::write(&plist, "private-fixture").unwrap();
        let status = inspect(home.path(), "macos", |program, _| {
            if program.contains("launchctl") {
                output(true, "", "")
            } else {
                output(
                    true,
                    "* * * * * private-fixture # ai-hist push (managed)",
                    "",
                )
            }
        });
        assert_eq!(status.state, "active");
        assert_eq!(status.jobs, ["launchd-plist", "managed-cron"]);
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains("private-fixture"));
        assert_eq!(fs::read_to_string(plist).unwrap(), "private-fixture");
    }
    #[test]
    fn failures_are_unknown_but_positive_evidence_is_active() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            inspect(home.path(), "linux", |_, _| CommandInspection::Failed).state,
            "unknown"
        );
        assert_eq!(
            inspect(home.path(), "linux", |_, _| output(
                false,
                "",
                "permission denied"
            ))
            .state,
            "unknown"
        );
        assert_eq!(
            inspect(home.path(), "linux", |_, _| output(
                false,
                "",
                "crontab: no crontab for fixture"
            ))
            .state,
            "clear"
        );
        assert_eq!(
            inspect(home.path(), "linux", |_, _| output(
                false,
                "",
                "crontab: cannot open /var/spool/cron/crontabs/fixture: No such file or directory"
            ))
            .state,
            "clear"
        );
        let status = inspect(home.path(), "macos", |program, _| {
            if program.contains("launchctl") {
                CommandInspection::Failed
            } else {
                output(true, "* * * * * ai-hist push # ai-hist push (managed)", "")
            }
        });
        assert_eq!(status.state, "active");
        assert_eq!(
            inspect(home.path(), "windows", |_, _| panic!("no command expected")).state,
            "clear"
        );
    }
    #[test]
    fn missing_crontab_program_means_no_managed_cron_job() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            inspect(home.path(), "linux", |_, _| CommandInspection::Missing),
            MigrationStatus {
                state: "clear",
                jobs: vec![]
            }
        );
        let mac = inspect(home.path(), "macos", |program, _| {
            if program.contains("launchctl") {
                output(true, "", "")
            } else {
                CommandInspection::Missing
            }
        });
        assert_eq!(mac.state, "clear");
    }
    #[cfg(unix)]
    #[test]
    fn command_capture_has_output_cap_deadline_and_no_stdin() {
        let CommandInspection::Output(captured) =
            bounded_command("/bin/sh", &["-c", "read ignored || printf 'closed'"])
        else {
            panic!("command did not run")
        };
        assert_eq!(captured.stdout, "closed");
        assert!(matches!(
            bounded_command(
                "/bin/sh",
                &[
                    "-c",
                    "while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done"
                ]
            ),
            CommandInspection::Failed
        ));
        assert!(matches!(
            bounded_command("/bin/sleep", &["3"]),
            CommandInspection::Failed
        ));
        assert!(matches!(
            bounded_command("/definitely/missing/crontab", &["-l"]),
            CommandInspection::Missing
        ));
    }
}
