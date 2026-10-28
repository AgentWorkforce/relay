//! App-server and window hosts used after the router checks turn ordering.

use super::*;

pub(super) fn window_owner(socket: &Path, thread: &str) -> Option<String> {
    let mut session = ipc::Session::connect(socket).ok()?;
    session.owners(&[thread.to_string()]).ok()?.remove(thread)
}

/// The existing window starts the normal user turn and retains its approval
/// connection. A loaded app-server alone can have no subscribers: never use
/// it as fallback or attach a new approval driver here.
pub(super) fn window_native_turn(
    socket: &Path,
    thread: &str,
    text: &str,
    message_id: &str,
    expected_owner: &str,
    admit: &(dyn Fn() -> bool + Send + Sync),
) -> Result<bool, TurnError> {
    let mut session = match ipc::Session::connect(socket) {
        Ok(session) => session,
        Err(_) => return Ok(false),
    };
    let owners = match session.owners(&[thread.to_string()]) {
        Ok(owners) => owners,
        Err(_) => return Ok(false),
    };
    if owners.get(thread).map(String::as_str) != Some(expected_owner) || !admit() {
        return Ok(false);
    }
    match session.start_turn(thread, text, message_id, expected_owner, None) {
        Ok(_) => Ok(true),
        Err(ipc::IpcError::Rejected(reason)) => Err(TurnError::Refused(reason)),
        Err(error) => Err(TurnError::InDoubt(error.to_string())),
    }
}

impl SystemCodexRoutes {
    pub(super) fn recover_turn(
        &self,
        thread: &str,
        turn: &str,
        steer: Option<&str>,
        message_id: &str,
        interrupt: bool,
    ) -> Result<app_server::recovery::Recovery, TurnError> {
        // Never steal a terminal's queue or interrupt a pending approval.
        if self.terminal_live(thread) || app_server::drive::awaiting_input(thread) {
            return Ok(app_server::recovery::Recovery::Unavailable);
        }
        let Some(executable) = processes::running_executable(self.table.as_ref(), self.uid) else {
            return Ok(app_server::recovery::Recovery::Unavailable);
        };
        let Ok(mut stream) =
            self.runner
                .proxy_in_home(&executable, &self.config.home, &self.config.sqlite_home)
        else {
            return Ok(app_server::recovery::Recovery::Unavailable);
        };
        app_server::recovery::recover(
            stream.as_mut(),
            thread,
            turn,
            steer,
            message_id,
            interrupt,
            app_server::SEND_TIMEOUT,
        )
    }

    pub(super) fn turn_progress(&self, thread: &str) -> Option<crate::relay::codex::stall::Progress> {
        let path = rollout::rollout_path(&self.config, thread)?;
        let summary = rollout::RolloutSummary::read(&path)?;
        let turn = summary.active_turn?;
        let modified = std::fs::metadata(path).ok()?.modified().ok()?;
        let at_ms = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64;
        Some(crate::relay::codex::stall::Progress {
            turn,
            at_ms: at_ms.max(app_server::drive::last_progress(thread).unwrap_or(0)),
        })
    }

    /// A turn through the shared app-server, as `hide` says: `Ok(false)`
    /// when none is running, it cannot be reached, or it does not host
    /// the thread.
    pub(super) fn app_server_turn(
        &self,
        thread: &str,
        text: &str,
        message_id: &str,
        hide: app_server::Hide,
        resume: bool,
    ) -> Result<bool, TurnError> {
        if resume
            && crate::relay::codex::threads::contains_unarchived(&self.config, thread) != Some(true)
        {
            return Ok(false);
        }
        let Some(executable) = processes::running_executable(self.table.as_ref(), self.uid) else {
            return Ok(false);
        };
        let home = (&self.config.home, &self.config.sqlite_home);
        let Ok(mut stream) = self.runner.proxy_in_home(&executable, home.0, home.1) else {
            return Ok(false);
        };
        let timeout = app_server::SEND_TIMEOUT;
        let send = if resume {
            app_server::send_to_spawned
        } else {
            app_server::send_if_loaded
        };
        send(stream.as_mut(), thread, text, message_id, hide, timeout)
    }
}

/// A turn through the Codex app window that owns `thread`. Not running, or
/// no window owning it, is `Ok(false)`; a refusal is `Refused`; any other
/// failure after the turn was asked for is in doubt.
pub fn window_turn(
    socket: &Path,
    thread: &str,
    text: &str,
    message_id: &str,
) -> Result<bool, TurnError> {
    let mut attempted = false;
    let result = (|| {
        let mut session = ipc::Session::connect(socket)?;
        let owners = session.owners(&[thread.to_string()])?;
        let Some(owner) = owners.get(thread) else {
            return Ok(false);
        };
        attempted = true;
        session.start_relay_turn(thread, text, message_id, owner)?;
        Ok(true)
    })();
    match result {
        Ok(sent) => Ok(sent),
        Err(ipc::IpcError::Rejected(reason)) => Err(TurnError::Refused(reason)),
        Err(error) if attempted => Err(TurnError::InDoubt(error.to_string())),
        Err(_) => Ok(false),
    }
}
