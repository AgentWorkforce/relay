//! Production routes share the same configured Codex home and exact thread spelling.
use super::*;

impl CodexRoutes for SystemCodexRoutes {
    fn progress(&self, thread: &str) -> Option<super::super::stall::Progress> {
        self.turn_progress(thread)
    }

    fn recover_stalled(
        &self,
        thread: &str,
        turn: &str,
        steer: Option<&str>,
        message_id: &str,
        interrupt: bool,
    ) -> Result<app_server::recovery::Recovery, TurnError> {
        self.recover_turn(thread, turn, steer, message_id, interrupt)
    }

    fn native_window_owner(&self, thread: &str) -> Option<String> {
        hosts::window_owner(&self.config.ipc_socket, &self.spelled(thread))
    }

    fn native_recorded(&self, thread: &str, message_id: &str) -> bool {
        native::recorded(&self.config, thread, message_id)
    }

    fn native_receipts(&self) -> Option<PathBuf> {
        Some(native::receipts(&self.config))
    }

    fn native_window(
        &self,
        thread: &str,
        text: &str,
        message_id: &str,
        owner: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<bool, TurnError> {
        hosts::window_native_turn(
            &self.config.ipc_socket,
            &self.spelled(thread),
            text,
            message_id,
            owner,
            admit,
        )
    }
    fn recorded(&self, thread: &str, message_ref: &str) -> bool {
        rollout::recorded(&self.config, thread, message_ref)
    }

    fn hidden_waiting(&self, thread: &str, message_ref: &str) -> bool {
        rollout::hidden_waiting(&self.config, thread, message_ref)
    }

    fn hidden_refs(&self, thread: &str) -> Vec<String> {
        rollout::hidden_refs(&self.config, thread)
    }

    fn queue_waiting(&self, thread: &str, message_ref: &str) -> Option<bool> {
        queue::is_waiting(&self.config, thread, message_ref)
    }

    fn relay_waiting(&self, thread: &str) -> Option<bool> {
        queue::relay_waiting(&self.config, thread)
    }

    fn idle(&self, thread: &str) -> bool {
        rollout::idle(&self.config, thread)
    }

    fn app_server(&self, thread: &str, text: &str, message_id: &str) -> Result<bool, TurnError> {
        let hide = match crate::relay::codex::compact::enabled() {
            true => app_server::Hide::IfAble,
            false => app_server::Hide::Never,
        };
        self.app_server_turn(thread, text, message_id, hide, false)
    }

    fn app_server_spawned(
        &self,
        thread: &str,
        text: &str,
        message_id: &str,
    ) -> Result<bool, TurnError> {
        let hide = if crate::relay::codex::compact::enabled() {
            app_server::Hide::IfAble
        } else {
            app_server::Hide::Never
        };
        self.app_server_turn(thread, text, message_id, hide, true)
    }

    fn app_server_hidden(
        &self,
        thread: &str,
        text: &str,
        message_id: &str,
    ) -> Result<bool, TurnError> {
        self.app_server_turn(thread, text, message_id, app_server::Hide::Only, false)
    }

    fn window(&self, thread: &str, text: &str, message_id: &str) -> Result<bool, TurnError> {
        window_turn(
            &self.config.ipc_socket,
            &self.spelled(thread),
            text,
            message_id,
        )
    }

    fn terminal_live(&self, thread: &str) -> bool {
        processes::terminal_thread_is_live(self.table.as_ref(), self.uid, thread)
    }

    fn thread_live(&self, thread: &str) -> bool {
        processes::thread_is_live(self.table.as_ref(), self.uid, thread)
    }

    fn conductor_owned(&self, thread: &str) -> bool {
        processes::conductor_executable(self.table.as_ref(), self.uid, thread).is_some()
    }

    fn queue_send(&self, thread: &str, text: &str) -> Result<(), QueueError> {
        if !queue::is_thread_id(thread) {
            return Err(QueueError::Failed("not a Codex thread id".into()));
        }
        // A Conductor session's thread is queued with Conductor's own Codex,
        // the one draining it, which may be the only Codex installed.
        let conductor = processes::conductor_executable(self.table.as_ref(), self.uid, thread);
        let Some(executable) = conductor
            .as_deref()
            .filter(|executable| self.supports_queue(executable))
            .or(self.config.executable.as_deref())
        else {
            return Err(QueueError::NotInstalled);
        };
        if !self.supports_queue(executable) {
            return Err(QueueError::NotInstalled);
        }
        match self.runner.run_in_home(
            executable,
            &queue::arguments(&self.spelled(thread), text),
            QUEUE_TIMEOUT,
            &self.config.home,
            &self.config.sqlite_home,
        ) {
            RunOutcome::Exited {
                code,
                stdout,
                stderr,
            } => match queue::outcome(code, &stdout, &stderr) {
                queue::Outcome::Queued { .. } => Ok(()),
                queue::Outcome::Failed(reason) => Err(QueueError::Failed(reason)),
            },
            RunOutcome::TimedOut => Err(QueueError::TimedOut),
            RunOutcome::NotStarted(_) => Err(QueueError::NotInstalled),
        }
    }

    fn cleanup(&self, thread: &str, message_ref: &str) {
        queue::remove_owned(&self.config, thread, message_ref);
    }
}
