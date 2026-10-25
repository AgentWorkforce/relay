//! App-server and window hosts used after the router checks turn ordering.

use super::*;

impl SystemCodexRoutes {
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
