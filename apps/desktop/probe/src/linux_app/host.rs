//! The core this app hosts when no other answers: `agent-relay-probe relay
//! serve` as the app's child. Like the Mac's LaunchAgent it can outlive the
//! app: quitting leaves it running unless the person chose otherwise, and the
//! next launch connects to it. The bridge stops it with `daemon.shutdown`.

use super::bridge::CoreError;
use crate::relay::transport::CoreStream;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::time::Instant;

/// `CREATE_NEW_PROCESS_GROUP` and `CREATE_NO_WINDOW` (`processthreadsapi.h`).
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long a started core has to answer on its socket.
pub const HOST_WAIT: Duration = Duration::from_secs(10);
/// Longer than the core's own bounded shutdown.
pub const SHUTDOWN_WAIT: Duration = Duration::from_secs(20);

/// What hosting a core needs.
#[derive(Clone, Debug, Default)]
pub struct HostOptions {
    /// The core program; `None` when this install has none.
    pub probe: Option<PathBuf>,
    pub site_url: Option<String>,
    pub app_data_dir: Option<PathBuf>,
    /// The version this app carries. A core an earlier run left running on
    /// another version is stopped, so this one is hosted. `None`: any.
    pub version: Option<String>,
}

/// The hosted child, if any.
#[derive(Default)]
pub struct Hosted {
    child: Mutex<Option<Child>>,
}

impl Hosted {
    /// Whether a hosted core is running.
    pub fn running(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    /// Starts the core serving `socket`, unless a hosted one runs.
    pub fn spawn(&self, options: &HostOptions, socket: &Path) -> Result<(), CoreError> {
        let mut child = self.child.lock().unwrap();
        if child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
        {
            return Ok(());
        }
        let probe = options.probe.as_ref().ok_or_else(|| {
            CoreError::unavailable_because(
                "Agent Relay could not find its helper program. Reinstall the app or set RELAY_DESKTOP_PROBE.",
            )
        })?;
        let mut command = Command::new(probe);
        command.args(["relay", "serve", "--socket"]).arg(socket);
        if let Some(site_url) = &options.site_url {
            command.args(["--site-url", site_url]);
        }
        if let Some(directory) = &options.app_data_dir {
            command.arg("--app-data-dir").arg(directory);
        }
        // Its own process group: a terminal's Ctrl-C reaches the app, which
        // decides whether the core stops with it.
        command.stdin(Stdio::null()).stdout(Stdio::null());
        #[cfg(unix)]
        command.process_group(0);
        // On Windows, a new process group for the same reason, and no
        // console window for the core.
        #[cfg(windows)]
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        *child = Some(command.spawn().map_err(|error| {
            CoreError::unavailable_because(&format!(
                "Agent Relay could not start its helper program: {}.",
                sentence(&error)
            ))
        })?);
        Ok(())
    }

    /// Waits for a core to answer at `socket`. A hosted child that exits
    /// first fails the wait, unless another core took the socket (the
    /// child's "already running").
    pub async fn wait_for_socket(
        &self,
        socket: &Path,
        stopping: impl Fn() -> bool,
    ) -> Result<(), CoreError> {
        let deadline = Instant::now() + HOST_WAIT;
        while Instant::now() < deadline && !stopping() {
            if CoreStream::connect(socket).await.is_ok() {
                return Ok(());
            }
            let exited = {
                let mut child = self.child.lock().unwrap();
                let status = child.as_mut().and_then(|child| child.try_wait().ok()?);
                if status.is_some() {
                    *child = None;
                }
                status
            };
            if let Some(status) = exited {
                if CoreStream::connect(socket).await.is_ok() {
                    return Ok(());
                }
                #[cfg(unix)]
                let code = {
                    use std::os::unix::process::ExitStatusExt;
                    status
                        .code()
                        .or_else(|| status.signal().map(|signal| -signal))
                        .unwrap_or_default()
                };
                // Windows has no signals: every exit has a code.
                #[cfg(not(unix))]
                let code = status.code().unwrap_or_default();
                return Err(CoreError::unavailable_because(&format!(
                    "Agent Relay's helper program stopped (exit status {code})."
                )));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if stopping() {
            return Err(CoreError::unavailable());
        }
        Err(CoreError::unavailable_because(
            "Agent Relay's helper program did not start in time.",
        ))
    }

    /// Waits for the hosted core, asked to stop, to exit. The core bounds
    /// its own shutdown (an answer being sent, a delivery being recorded)
    /// and is never killed in the middle of it.
    pub async fn release(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = tokio::time::timeout(SHUTDOWN_WAIT, child.wait()).await;
        }
    }

    /// Lets the hosted core run on after the app: it is no longer this
    /// app's child to wait for. Its process id is recorded beside `socket`,
    /// so a later run can tell it from a core started some other way.
    pub fn detach(&self, socket: &Path) {
        let child = self
            .child
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(pid) = child.as_ref().and_then(Child::id) {
            let _ = std::fs::write(left_running_record(socket), pid.to_string());
        }
    }

    /// Kills a hosted core that never reached its socket, so it has nothing
    /// in flight and could not be asked to stop.
    pub fn kill(&self) {
        if let Some(child) = self
            .child
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            let _ = child.start_kill();
        }
    }

    /// The hosted child's process id, while one runs.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().unwrap().as_ref().and_then(Child::id)
    }
}

/// The process id of the core an earlier run of the app left serving
/// `socket`, as [`Hosted::detach`] recorded it.
pub fn left_running(socket: &Path) -> Option<i32> {
    std::fs::read_to_string(left_running_record(socket))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Forgets the core recorded as left running: it stopped, or another
/// serves the socket now.
pub fn forget_left_running(socket: &Path) {
    let _ = std::fs::remove_file(left_running_record(socket));
}

fn left_running_record(socket: &Path) -> PathBuf {
    socket.with_extension("left-running")
}

/// An OS error as a sentence fragment: "No such file or directory".
fn sentence(error: &std::io::Error) -> String {
    let text = error.to_string();
    match text.find(" (os error") {
        Some(end) => text[..end].to_string(),
        None => text,
    }
}
