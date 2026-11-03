//! Uploader status: the install's status read in process, on a blocking thread
//! holding the history reader lease while the store is open, and the snapshot
//! presentation reads.
use super::*;

/// The sentence for a status read that failed, whatever its cause.
pub(super) const STATUS_FAILED: &str =
    "Agent Relay could not read upload status. Try refreshing again.";

/// A core without the `history` feature keeps no install to read.
#[cfg(not(feature = "history"))]
pub(super) fn read(
    _directory: Option<PathBuf>,
    _lease: HistoryReader,
) -> BoxFuture<'static, Result<Value, UploaderError>> {
    Box::pin(async {
        Err(UploaderError::new(
            crate::relay::protocol::HISTORY_UNAVAILABLE,
        ))
    })
}

/// [`crate::delivery_status::status`] of `directory`, bounded by `timeouts::STATUS`.
#[cfg(feature = "history")]
pub(super) fn read(
    directory: Option<PathBuf>,
    lease: HistoryReader,
) -> BoxFuture<'static, Result<Value, UploaderError>> {
    Box::pin(async move {
        let directory = directory.ok_or_else(|| UploaderError::new(STATUS_FAILED))?;
        read_holding(lease, timeouts::STATUS, move || {
            crate::delivery_status::status(&directory)
        })
        .await
    })
}

/// Runs `read` on a blocking thread that holds `lease` until `read` returns,
/// whatever its caller does: past `timeout` the caller is answered with the
/// timeout sentence while the thread finishes, and a session reset waits for
/// the store to close.
#[cfg_attr(not(any(test, feature = "history")), allow(dead_code))]
pub(super) async fn read_holding<T: Send + 'static>(
    lease: HistoryReader,
    timeout: Duration,
    read: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, UploaderError> {
    let read = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        read()
    });
    match tokio::time::timeout(timeout, read).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(error))) => {
            crate::relay::diagnostics::write(format_args!(
                "relay uploader status failed cause={error:#}"
            ));
            Err(UploaderError::new(STATUS_FAILED))
        }
        Ok(Err(error)) => {
            crate::relay::diagnostics::write(format_args!(
                "relay uploader status helper exited cause={error}"
            ));
            Err(UploaderError::new(STATUS_FAILED))
        }
        Err(_) => {
            let message = timeout_message("status");
            crate::relay::diagnostics::write(format_args!(
                "relay uploader status failed cause={message}"
            ));
            Err(UploaderError::new(message))
        }
    }
}

impl Uploader {
    fn log_claude_health(&self, status: &Value) {
        let health = &status["claude_cloud"];
        if health.is_null() {
            return;
        }
        let mut logged = self
            .claude_health_logged
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if logged.as_ref() == Some(health) {
            return;
        }
        *logged = Some(health.clone());
        let state = health["state"].as_str().unwrap_or("unknown");
        if !matches!(state, "blocked" | "needs_attention") {
            return;
        }
        let reason = health["reason"]
            .as_str()
            .unwrap_or("Claude Code cloud-session sync failed without a reason.");
        let at_ms = health["at_ms"].as_i64().unwrap_or_default();
        crate::relay::diagnostics::write(format_args!(
            "relay claude cloud sync pass failed state={state} at_ms={at_ms} cause={reason}"
        ));
    }

    /// `status` with `needs_start`, `stage` and the install's `directory`.
    pub async fn status(&self) -> Result<Value, RpcError> {
        // The generation is taken before the target: an attach in between
        // then labels this read with the older generation, so no caller
        // asking after the attach joins a read of the old install.
        let changes = self.changes.load(Ordering::SeqCst);
        self.attached()?;
        let directory = self.install().and_then(|install| install.directory);
        let read = {
            let mut slot = self.status_read.lock().unwrap_or_else(|e| e.into_inner());
            match slot.as_ref() {
                Some((began, read)) if *began == changes && read.peek().is_none() => read.clone(),
                _ => {
                    let runner = self.runner.clone();
                    let reader = self.try_history_reader();
                    let at = directory.clone().map(PathBuf::from);
                    let read = async move {
                        // The reader holds off a session reset until the
                        // store closes.
                        runner.status(at, reader?).await.map_err(RpcError::from)
                    }
                    .boxed()
                    .shared();
                    *slot = Some((changes, read.clone()));
                    read
                }
            }
        };
        let raw = read.await?;
        self.log_claude_health(&raw);
        let mut status = with_derived(raw);
        if let Value::Object(fields) = &mut status {
            fields.insert("directory".into(), json!(directory));
        }
        Ok(status)
    }

    /// Presentation reads the last completed status. Supervision continues
    /// to use `status()` so a cached process state never authorizes a restart.
    pub async fn cached_status(&self) -> Result<Value, RpcError> {
        let generation = self.changes.load(Ordering::SeqCst);
        self.attached()?;
        if let Some((began, value)) = self
            .status_snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            if *began == generation && self.changes.load(Ordering::SeqCst) == generation {
                return Ok(with_derived(value.clone()));
            }
        }
        let (_, value) = self.refresh_status_snapshot().await?;
        Ok(value)
    }

    pub async fn refresh_status_snapshot(&self) -> Result<(bool, Value), RpcError> {
        let generation = self.changes.load(Ordering::SeqCst);
        let value = self.status().await?;
        let mut slot = self
            .status_snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.changes.load(Ordering::SeqCst) != generation {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        // A change is one an app shows: a queue's age or a cycle's timings
        // alone are not, so they invalidate nothing.
        let shown = crate::relay::contract::account::UploaderStatus::from_probe;
        let changed = slot.as_ref().is_none_or(|(began, previous)| {
            *began != generation || shown(previous) != shown(&value)
        });
        *slot = Some((generation, value.clone()));
        Ok((changed, value))
    }
}
