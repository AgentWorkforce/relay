//! The session-socket routes Agent Relay's own agent hooks ask: the Codex
//! stop hook, native Copilot lifecycle hooks and Claude Code attestation hook.
use super::{payload, Outbound, OutboundError, Purpose, Request};
use serde_json::Value;

mod codex_stop;
mod copilot;

impl Outbound {
    pub(super) async fn hook_route(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        if let Some(account) = &self.core.plugins.account {
            if let Some(answer) = account.session_route(self, pid, uid, request) {
                return answer.await;
            }
        }
        if request.path == "/claude/attestation" {
            return Err(OutboundError::new(
                409,
                "attestation_unavailable",
                "This core does not sign Claude chat proofs.",
            ));
        }
        let fields = payload(request, Purpose::Json)?;
        if request.path == "/copilot/hook" {
            return self.copilot_hook(pid, uid, &fields).await;
        }
        self.codex_stop_hook(pid, uid, &fields).await
    }
}
