//! Verifying discovered workspaces and recovering refused account keys.

use super::*;

impl Core {
    /// The Relaycast workspace id (`rw_…`) of the current key: the one its
    /// source records, else the one Relaycast reported when this key was
    /// verified. `None` until a verified id is known. Probe-owned bindings
    /// are minted for and checked against this id.
    pub fn verified_workspace_id(&self) -> Option<String> {
        let workspace = self.workspace()?;
        if let Some(id) = workspace.workspace_id {
            return Some(id);
        }
        let status = self.status().workspace;
        (status.verification == Verification::Verified
            && status.base_url.as_deref() == Some(workspace.base_url.as_str()))
        .then_some(status.workspace_id)
        .flatten()
    }

    /// Asks Relaycast which workspace the key belongs to.
    pub async fn verify_workspace(&self) -> Result<WorkspaceStatus, RpcError> {
        let mut workspace = self.workspace.lock().unwrap().clone().ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotSignedIn,
                "No Agent Relay workspace key was found.",
            )
        })?;
        if workspace.is_gate_only() {
            return self.verify_gate_workspace(&workspace).await;
        }
        let scope = self.relaycast_scope(&workspace.base_url, &workspace.key);
        if !self.relaycast_poll_allowed(&scope) {
            return Err(RpcError::new(
                ErrorKind::RateLimited,
                "Agent Relay workspace checks are paused while its request limit recovers.",
            ));
        }
        let mut result = client::workspace_info(&workspace).await;
        self.observe_relaycast_result(&scope, &result);
        // A refused node credential is revoked or expired at Control; it is
        // not an account key, so there is nothing to recover.
        if !workspace.node_scoped()
            && result
                .as_ref()
                .err()
                .is_some_and(crate::relay::node_credential::rejects_credential)
        {
            let expected_id = self
                .status()
                .workspace
                .workspace_id
                .or_else(|| workspace.workspace_id.clone());
            if let (Some(account), Some(expected_id)) = (&self.plugins.account, expected_id) {
                if let Some((replacement, info)) = account
                    .recover_workspace_key(&workspace, &expected_id)
                    .await
                {
                    workspace = replacement;
                    result = Ok(info);
                }
            }
        }
        // The workspace may have changed while Relaycast answered; only the
        // answer for the current key is recorded.
        if self.workspace.lock().unwrap().as_ref() != Some(&workspace) {
            return Ok(self.status().workspace);
        }
        let checked_at_ms = Some(now_ms());
        match result {
            Ok(info) => {
                let status = self.hub.update(|status| {
                    status.workspace.verification = Verification::Verified;
                    status.workspace.workspace_id = Some(info.id.clone());
                    status.workspace.workspace_name = Some(info.name.clone());
                    status.workspace.workspace_plan = info.plan.clone();
                    status.workspace.checked_at_ms = checked_at_ms;
                });
                Ok(status.workspace)
            }
            Err(error) => {
                let mapped = RpcError::from_relaycast_for(workspace.kind(), &error);
                let verification = verification_after(workspace.kind(), &error);
                self.hub.update(|status| {
                    status.workspace.verification = verification;
                    status.workspace.checked_at_ms = checked_at_ms;
                });
                self.hub.activity(Level::Warning, mapped.message.clone());
                Err(mapped)
            }
        }
    }

    /// A gate-only workspace has no key to check: relaygate serves no
    /// workspace read, and its agents enrol with the desktop's device token
    /// instead. Control named the gate and the workspace when it resolved
    /// the account, so the workspace is verified while that device token is
    /// at hand, and not signed in without it. Nothing is sent, and no
    /// account key is recovered.
    async fn verify_gate_workspace(
        &self,
        workspace: &crate::relay::workspace::Workspace,
    ) -> Result<WorkspaceStatus, RpcError> {
        let signed_in = self.device_token().await;
        if self.workspace.lock().unwrap().as_ref() != Some(workspace) {
            return Ok(self.status().workspace);
        }
        let checked_at_ms = Some(now_ms());
        // Decided in the same update as it is written: a rediscovery (a
        // sign-out) published since is never overwritten with this answer.
        let still_shown = |status: &crate::relay::state::Status| {
            status.workspace.base_url.as_deref() == Some(workspace.base_url.as_str())
        };
        match signed_in {
            Ok(_) => {
                let status = self.hub.update(|status| {
                    if !still_shown(status) {
                        return;
                    }
                    status.workspace.verification = Verification::Verified;
                    if let Some(id) = &workspace.workspace_id {
                        status.workspace.workspace_id = Some(id.clone());
                    }
                    status.workspace.checked_at_ms = checked_at_ms;
                });
                Ok(status.workspace)
            }
            Err(error) => {
                self.hub.update(|status| {
                    if !still_shown(status) {
                        return;
                    }
                    status.workspace.verification = Verification::Pending;
                    status.workspace.checked_at_ms = checked_at_ms;
                });
                self.hub.activity(Level::Warning, error.message.clone());
                Err(error)
            }
        }
    }

    /// Records the workspace discovery found now, keeping the plan Cloud
    /// reported when it is still this workspace's.
    pub(crate) fn publish_rediscovered_workspace(&self, found: Option<&Workspace>) {
        self.hub.update(|status| {
            status.workspace = WorkspaceStatus::discovered(found).keeping_plan_of(&status.workspace)
        });
    }

    /// When Relaycast refuses the current workspace key (a read or a
    /// write), marks it for a safe verification on the next refresh pass,
    /// which recovers a rotated account key. Never replays the failed call
    /// and never recovers a different source or credential.
    pub(crate) fn schedule_verification_after_refusal(
        &self,
        workspace: &WorkspaceScope,
        error: &relaycast::RelayError,
    ) {
        if !crate::relay::node_credential::rejects_credential(error) {
            return;
        }
        let Some(current) = self.workspace().filter(|current| {
            self.relaycast_scope(&current.base_url, &current.key)
                .same_credentials(workspace)
        }) else {
            return;
        };
        self.hub.update(|status| {
            if status.workspace.base_url.as_deref() == Some(&current.base_url) {
                status.workspace.verification = Verification::Pending;
            }
        });
    }
}

/// What a failed workspace check says of a credential of `kind`. Rejected
/// when the credential itself was refused ([`rejects`]), so the operator is
/// asked for another. A 403 that does not reject a node-scoped credential (a
/// suspended workspace, a node another owner holds, as Relaycast judged
/// them) leaves it `Pending`: neither a credential to replace nor an
/// unreachable Relaycast; the activity log and the error carry Relaycast's
/// status, code and message ([`RpcError::from_relaycast_for`]), and the next
/// refresh asks again. Anything else is `Unreachable`.
///
/// [`rejects`]: crate::relay::node_credential::rejects
fn verification_after(
    kind: crate::relay::workspace::KeyKind,
    error: &relaycast::RelayError,
) -> Verification {
    if crate::relay::node_credential::rejects(kind, error) {
        Verification::Rejected
    } else if kind == crate::relay::workspace::KeyKind::NodeScoped && error.status() == Some(403) {
        Verification::Pending
    } else {
        Verification::Unreachable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::workspace::KeyKind;
    use relaycast::RelayError;

    fn api(status: u16, code: &str) -> RelayError {
        RelayError::api(code, "synthetic", status)
    }

    /// A workspace key in a suspended workspace is rejected, as today.
    #[test]
    fn a_suspended_workspace_rejects_a_workspace_key() {
        let kind = KeyKind::Workspace;
        let suspended = api(403, "workspace_suspended");
        assert_eq!(verification_after(kind, &suspended), Verification::Rejected);
        assert_eq!(
            verification_after(kind, &api(401, "unauthorized")),
            Verification::Rejected
        );
        assert_eq!(
            verification_after(kind, &api(502, "bad_gateway")),
            Verification::Unreachable
        );
    }

    /// A node credential in a suspended workspace is not rejected: the
    /// broker passed Relaycast's 403 through, which judges the workspace.
    #[test]
    fn a_suspended_workspace_leaves_a_node_credential_pending() {
        let kind = KeyKind::NodeScoped;
        let suspended = api(403, "workspace_suspended");
        assert_eq!(verification_after(kind, &suspended), Verification::Pending);
        assert_eq!(
            verification_after(kind, &api(403, "node_mismatch")),
            Verification::Pending
        );
        assert_eq!(
            verification_after(kind, &api(401, "token_invalid")),
            Verification::Rejected
        );
        assert_eq!(
            verification_after(kind, &api(502, "relaycast_unavailable")),
            Verification::Unreachable
        );
    }
}
