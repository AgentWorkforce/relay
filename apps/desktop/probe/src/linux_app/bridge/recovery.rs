//! Repeatable reads recover across a brief core interruption, and which
//! failures mean a command never reached the core.

use super::*;

const READ_RECOVERY_WINDOW: Duration = Duration::from_secs(5);
const READ_RECOVERY_BACKOFF: Duration = Duration::from_millis(200);

pub(super) fn is_read(method: &str) -> bool {
    // Mirror CoreClient.repeatableReads on macOS. Unknown methods are
    // commands until audited, even when their names end in .get or .status.
    matches!(
        method,
        "diagnostics.requests"
            | "status.get"
            | "account.status"
            | "uploader.status"
            | "uploader.sessions.list"
            | "uploader.sessions.preview"
            | "sessions.transcript"
            | "sessions.list"
            | "spawn.targets"
            | "spawn.status"
            | "agents.list"
            | "agents.transcript"
            | "settings.get"
            | "activity.list"
            | "claude_delivery.status"
            | "openclaw.relay_tools.status"
            | "roster.list"
            | "roster.get"
            | "fleet.list"
            | "cursor_cloud.models.list"
            | "cursor_cloud.repositories.list"
            | "cursor_cloud.environments.list"
            | "cursor_cloud.agents.list"
            | "cursor_cloud.agents.get"
            | "cursor_cloud.runs.list"
            | "cursor_cloud.runs.get"
            | "replicas.environments.list"
            | "replicas.spawn.get"
            | "capy.projects.list"
            | "capy.threads.get"
            | "messages.conversations"
            | "messages.history"
            | "sessions.overview.get"
            | "sessions.overview.events"
            | "people.list"
            | "links.parse"
            | "login_item.status"
            | "incoming.status"
            | "chat.conversation"
            | "chat.history"
            | "chat.projects"
            | "contractors.status"
    )
}

pub(super) fn call_timeout(method: &str) -> Duration {
    if is_read(method) {
        READ_TIMEOUT
    } else {
        CALL_TIMEOUT
    }
}

fn should_retry(
    error: &ConnectionError,
    read: bool,
    recover_until: &mut Option<Instant>,
    during_request: bool,
) -> bool {
    if !read {
        return false;
    }
    let interrupted = match error {
        ConnectionError::Transport(error) => {
            !during_request || error.kind() != io::ErrorKind::TimedOut
        }
        ConnectionError::Core(error) => error.kind() == Some(ErrorKind::ShuttingDown),
    };
    if !interrupted {
        return false;
    }
    let until = recover_until.get_or_insert_with(|| Instant::now() + READ_RECOVERY_WINDOW);
    Instant::now() < *until
}

impl Bridge {
    async fn greeted_with_deadline(
        &self,
        recover_until: Option<Instant>,
    ) -> Result<Connection, ConnectionError> {
        if let Some(until) = recover_until {
            tokio::time::timeout_at(until, self.greeted())
                .await
                .unwrap_or_else(|_| Err(io::Error::from(io::ErrorKind::TimedOut).into()))
        } else {
            self.greeted().await
        }
    }

    fn recovery_error(&self) -> CoreError {
        if self.daemon_version().is_some() {
            CoreError::reconnecting()
        } else {
            CoreError::unavailable()
        }
    }

    /// Calls `method` by name, for a method this build may not know.
    pub async fn call_value(&self, method: &str, params: Value) -> Result<Value, CoreError> {
        let read = is_read(method);
        let mut recover_until = None;
        loop {
            if self.stopping() {
                return Err(CoreError::unavailable());
            }
            let (pooled, generation) = {
                let mut shared = self
                    .inner
                    .shared
                    .lock()
                    .map_err(|_| CoreError::unavailable())?;
                (shared.idle.pop(), shared.generation)
            };
            let mut connection = match pooled {
                Some(connection) => connection,
                None => match self.greeted_with_deadline(recover_until).await {
                    Ok(connection) => connection,
                    Err(error) if should_retry(&error, read, &mut recover_until, false) => {
                        tokio::time::sleep(READ_RECOVERY_BACKOFF).await;
                        continue;
                    }
                    Err(ConnectionError::Core(error))
                        if read && error.kind() == Some(ErrorKind::ShuttingDown) =>
                    {
                        return Err(self.recovery_error());
                    }
                    Err(ConnectionError::Core(error)) => return Err(error),
                    Err(ConnectionError::Transport(_)) if read => return Err(self.recovery_error()),
                    Err(ConnectionError::Transport(_)) => return Err(CoreError::unavailable()),
                },
            };
            let timeout = recover_until
                .map(|until| {
                    call_timeout(method).min(until.saturating_duration_since(Instant::now()))
                })
                .unwrap_or_else(|| call_timeout(method));
            if timeout.is_zero() {
                return Err(self.recovery_error());
            }
            match connection.request(method, params.clone(), timeout).await {
                Ok(value) => {
                    self.release(connection, generation);
                    return Ok(value);
                }
                Err(error) if should_retry(&error, read, &mut recover_until, true) => {
                    tokio::time::sleep(READ_RECOVERY_BACKOFF).await;
                }
                Err(ConnectionError::Transport(error))
                    if error.kind() == io::ErrorKind::TimedOut =>
                {
                    if recover_until.is_some_and(|until| Instant::now() >= until) {
                        return Err(self.recovery_error());
                    }
                    return Err(CoreError {
                        failure: Failure::Unavailable,
                        message: "The background service took too long to respond. Try again."
                            .into(),
                        retryable: true,
                    });
                }
                Err(ConnectionError::Transport(_)) if read => return Err(self.recovery_error()),
                Err(ConnectionError::Transport(_)) => return Err(CoreError::interrupted()),
                Err(ConnectionError::Core(error))
                    if read && error.kind() == Some(ErrorKind::ShuttingDown) =>
                {
                    return Err(self.recovery_error());
                }
                Err(ConnectionError::Core(error))
                    if !read && error.kind() == Some(ErrorKind::ShuttingDown) =>
                {
                    return Err(CoreError::interrupted());
                }
                Err(ConnectionError::Core(error)) => {
                    if error.kind() != Some(ErrorKind::ShuttingDown) {
                        self.release(connection, generation);
                    }
                    return Err(error);
                }
            }
        }
    }
}

impl CoreError {
    /// Whether this failure is the bridge not reaching the core at all, as
    /// the Mac's `CoreError.neverSent`. A command fails this way only when no
    /// connection to the core could be opened or greeted, so it was never
    /// sent; once the core answers again, the sentence is no longer true.
    /// `interrupted` is not included: that command may have run.
    pub fn never_sent(&self) -> bool {
        self.failure == Failure::Unavailable && CoreError::never_sent_message(&self.message)
    }

    /// `never_sent`, for a failure kept only as its sentence.
    pub fn never_sent_message(message: &str) -> bool {
        message == CoreError::unavailable().message || message == CoreError::reconnecting().message
    }
}
