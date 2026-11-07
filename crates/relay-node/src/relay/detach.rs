//! Starting a process as the leader of a process session of its own, so it
//! outlives a core restart: reparenting alone leaves it in the core's
//! session, where a supervisor can still tear it down with the core.
//!
//! Windows has no sessions or reparenting, and a child is not stopped with
//! its parent: the process is started directly (never through a shell)
//! with its own console process group and no window, out of the core's job
//! when that job allows it (see `platform::process`).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

/// Makes the child `command` starts call `setsid(2)` before it runs; one
/// that cannot is not started, and the spawn reports the OS error. On
/// Windows: its own console process group and no window.
pub(crate) fn new_session(command: &mut Command) -> &mut Command {
    crate::platform::process::new_session(command)
}

/// Records `status` as the exit evidence at `path` (`<log>.exit`): written
/// to a temporary file beside it and renamed into place, so a reader that
/// sees the file sees the whole status, never an empty or partial one.
pub(crate) fn record_exit(path: &Path, status: &str) -> std::io::Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = std::path::PathBuf::from(temporary);
    std::fs::write(&temporary, status)?;
    std::fs::rename(&temporary, path)
}

/// Starts `executable arguments` in `directory` with exactly `environment`,
/// in a new process session through a short-lived shell, so it is
/// reparented before this returns, and returns its pid. Its input is empty
/// and its output goes to `log` (`/dev/null` for none). With `scope` (the
/// `systemd-run` path and a unit name) the shell, and so the process, run
/// in that transient scope, outside the core's cgroup. Arguments are passed
/// through `"$@"`, never interpolated into shell text.
#[cfg(unix)]
pub(crate) fn start(
    scope: Option<(&Path, &str)>,
    executable: &Path,
    arguments: &[OsString],
    log: &Path,
    directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<i32, String> {
    const SCRIPT: &str = r#"umask 077
log=$1; exit_file=$2; shift 2
(
  "$@" </dev/null >"$log" 2>&1 &
  agent=$!
  printf '%s\n' "$agent"
  exec >/dev/null 2>&1
  wait "$agent"
  status=$?
  if [ "$log" != /dev/null ]; then
    printf '%s\n' "$status" >"$exit_file.tmp" && command -p mv -f "$exit_file.tmp" "$exit_file"
  fi
) &"#;
    let mut command = match scope {
        Some((systemd_run, unit)) => {
            let mut command = Command::new(systemd_run);
            command
                .args(crate::relay::spawn::launch::scope_arguments(unit))
                .arg("/bin/sh");
            command
        }
        None => Command::new("/bin/sh"),
    };
    new_session(&mut command);
    let output = command
        .args(["-c", SCRIPT, "agent-relay-managed"])
        .arg(log)
        .arg(log.with_extension("exit"))
        .arg(executable)
        .args(arguments)
        .current_dir(directory)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(crate::relay::harness::diagnostics::redact(&format!(
            "its launcher failed: exit_status={}; stderr_tail={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|text| text.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 1)
        .ok_or_else(|| "its launcher did not report it".into())
}

/// Starts `executable arguments` in `directory` with exactly `environment`
/// and returns its pid. Its input is empty and its output goes to `log`
/// (`NUL` for none). There is no shell: the executable runs directly, a
/// `.cmd` through `cmd.exe` with its arguments escaped by Rust. Its exit
/// status is written beside the log (`.exit`) by a thread of this core, so
/// it is recorded only while the core still runs. `scope` is a `systemd-run`
/// scope, which Windows has no counterpart for; it is ignored.
#[cfg(windows)]
pub(crate) fn start(
    scope: Option<(&Path, &str)>,
    executable: &Path,
    arguments: &[OsString],
    log: &Path,
    directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<i32, String> {
    use crate::platform::process::{CREATE_BREAKAWAY_FROM_JOB, NULL_DEVICE};
    use std::os::windows::process::CommandExt;
    let _ = scope;
    let discard = log.as_os_str().eq_ignore_ascii_case(NULL_DEVICE);
    let output = |error: std::io::Error| format!("could not open its log: {error}");
    let spawn = |breakaway: bool| -> Result<std::process::Child, String> {
        let (stdout, stderr) = if discard {
            (Stdio::null(), Stdio::null())
        } else {
            let file = std::fs::File::create(log).map_err(output)?;
            let copy = file.try_clone().map_err(output)?;
            (Stdio::from(file), Stdio::from(copy))
        };
        let mut command = Command::new(executable);
        new_session(&mut command);
        if breakaway {
            // `creation_flags` replaces the flags, so `new_session`'s are
            // carried over by asking for them again with breakaway added.
            command.creation_flags(
                windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP
                    | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                    | CREATE_BREAKAWAY_FROM_JOB,
            );
        }
        command
            .args(arguments)
            .current_dir(directory)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|error| error.to_string())
    };
    let child = match spawn(true) {
        // The core's job forbids breaking away: start it inside the job.
        Err(_) => spawn(false),
        started => started,
    };
    let mut child = child.map_err(|error| {
        crate::relay::harness::diagnostics::redact(&format!("it could not be started: {error}"))
    })?;
    let pid =
        i32::try_from(child.id()).map_err(|_| "its launcher did not report it".to_string())?;
    let exit_file = log.with_extension("exit");
    let _ = std::thread::Builder::new()
        .name("detached-exit".into())
        .spawn(move || {
            let status = child.wait();
            if let (false, Ok(status)) = (discard, status) {
                let code = status.code().unwrap_or(-1);
                let _ = record_exit(&exit_file, &format!("{code}\n"));
            }
        });
    Ok(pid)
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn a_detached_process_writes_its_log_with_only_the_environment_given() {
        let folder = tempfile::tempdir().unwrap();
        let log = folder.path().join("out.log");
        let environment = BTreeMap::from([("RELAY_TEST_VALUE".to_string(), "x y".to_string())]);
        let pid = start(
            None,
            Path::new("/bin/sh"),
            &[
                "-c".into(),
                "printf '%s|%s|%s' \"$RELAY_TEST_VALUE\" \"$HOME\" \"$1\"".into(),
                "sh".into(),
                "it's \"quoted\"".into(),
            ],
            &log,
            folder.path(),
            &environment,
        )
        .unwrap();
        assert!(pid > 1);
        let deadline = Instant::now() + Duration::from_secs(5);
        let expected = "x y||it's \"quoted\"";
        while std::fs::read_to_string(&log).unwrap_or_default() != expected {
            assert!(Instant::now() < deadline, "the process wrote its log");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_detached_failure_records_its_real_exit_status_and_stderr() {
        let folder = tempfile::tempdir().unwrap();
        let log = folder.path().join("failure.log");
        start(
            None,
            Path::new("/bin/sh"),
            &["-c".into(), "echo credentials-rejected >&2; exit 42".into()],
            &log,
            folder.path(),
            &BTreeMap::new(),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !log.with_extension("exit").exists() {
            assert!(Instant::now() < deadline, "exit evidence was never written");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            std::fs::read_to_string(log.with_extension("exit"))
                .unwrap()
                .trim(),
            "42"
        );
        assert!(!folder.path().join("failure.exit.tmp").exists());
        assert!(std::fs::read_to_string(log)
            .unwrap()
            .contains("credentials-rejected"));
    }

    #[test]
    fn recorded_exit_evidence_replaces_the_old_and_leaves_no_temporary_file() {
        let folder = tempfile::tempdir().unwrap();
        let exit = folder.path().join("agent.exit");
        std::fs::write(&exit, "stale\n").unwrap();
        record_exit(&exit, "7\n").unwrap();
        assert_eq!(std::fs::read_to_string(&exit).unwrap(), "7\n");
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_launcher_that_cannot_start_says_so() {
        let folder = tempfile::tempdir().unwrap();
        let missing = folder.path().join("missing");
        let error = start(
            None,
            Path::new("/bin/true"),
            &[],
            Path::new("/dev/null"),
            &missing,
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(!error.is_empty());
    }
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn cmd() -> std::path::PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        Path::new(&root).join(r"System32\cmd.exe")
    }

    /// What `cmd.exe` needs to run at all.
    fn environment() -> BTreeMap<String, String> {
        BTreeMap::from([(
            "SystemRoot".to_string(),
            std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()),
        )])
    }

    fn wait_for(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "{} was never written",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_detached_process_writes_its_log_with_only_the_environment_given() {
        let folder = tempfile::tempdir().unwrap();
        let log = folder.path().join("out.log");
        let mut environment = environment();
        environment.insert("RELAY_TEST_VALUE".into(), "x y".into());
        let pid = start(
            None,
            &cmd(),
            // HOME was not given, so a defined HOME exits 3.
            &[
                "/D".into(),
                "/C".into(),
                "if defined HOME (exit 3) else (echo %RELAY_TEST_VALUE%)".into(),
            ],
            &log,
            folder.path(),
            &environment,
        )
        .unwrap();
        assert!(pid > 0);
        wait_for(&log.with_extension("exit"));
        assert_eq!(
            std::fs::read_to_string(log.with_extension("exit"))
                .unwrap()
                .trim(),
            "0"
        );
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "x y");
    }

    #[test]
    fn a_detached_failure_records_its_real_exit_status_and_stderr() {
        let folder = tempfile::tempdir().unwrap();
        let log = folder.path().join("failure.log");
        start(
            None,
            &cmd(),
            &[
                "/D".into(),
                "/C".into(),
                "echo credentials-rejected 1>&2 & exit 42".into(),
            ],
            &log,
            folder.path(),
            &environment(),
        )
        .unwrap();
        wait_for(&log.with_extension("exit"));
        assert_eq!(
            std::fs::read_to_string(log.with_extension("exit"))
                .unwrap()
                .trim(),
            "42"
        );
        assert!(std::fs::read_to_string(log)
            .unwrap()
            .contains("credentials-rejected"));
    }

    #[test]
    fn a_launcher_that_cannot_start_says_so() {
        let folder = tempfile::tempdir().unwrap();
        let missing = folder.path().join("missing");
        let error = start(
            None,
            &cmd(),
            &[],
            Path::new("NUL"),
            &missing,
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert!(!error.is_empty());
    }
}
