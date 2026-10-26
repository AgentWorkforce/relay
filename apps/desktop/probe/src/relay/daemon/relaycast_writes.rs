//! Relaycast write admission and serialized delivery settlement.

use super::*;

impl Core {
    pub(crate) fn observe_relaycast_write_result<T>(
        &self,
        workspace: &WorkspaceScope,
        result: &relaycast::Result<T>,
    ) {
        match result {
            Ok(_) => self.relaycast_backoff.record_write_success(workspace),
            Err(error) => {
                if let Some(notice) = self.relaycast_backoff.record_write_error(workspace, error) {
                    self.report_relaycast_backoff(workspace, &notice);
                }
            }
        }
    }

    /// Settlement retries keep their durable outcome and stay queued at
    /// Relaycast until writes are admitted again. Serialize this lane so
    /// multiple agent queues observe a denial before starting siblings.
    pub(crate) async fn relaycast_ack(
        &self,
        workspace: &WorkspaceScope,
        base: &str,
        token: &Secret,
        id: &str,
    ) -> bool {
        let lock = self
            .agent_locks
            .get(&format!("settlements:{}", workspace.key()));
        let _settling = lock.lock().await;
        if !self.relaycast_write_allowed(workspace) {
            return false;
        }
        let result = client::ack(base, token, id).await;
        self.observe_relaycast_write_result(workspace, &result);
        result.is_ok()
    }

    pub(crate) async fn relaycast_fail(
        &self,
        workspace: &WorkspaceScope,
        base: &str,
        token: &Secret,
        id: &str,
        reason: &str,
        retryable: bool,
    ) -> bool {
        let lock = self
            .agent_locks
            .get(&format!("settlements:{}", workspace.key()));
        let _settling = lock.lock().await;
        if !self.relaycast_write_allowed(workspace) {
            return false;
        }
        let result = client::fail(base, token, id, reason, retryable).await;
        self.observe_relaycast_write_result(workspace, &result);
        result.is_ok()
    }
}
