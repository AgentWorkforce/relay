//! Cached account state for nonblocking setup status reads.

use super::*;

impl Setup {
    /// The account as `account.status` reports it; without the account
    /// methods, signed in exactly when a workspace is known.
    pub(super) async fn account(&self) -> Value {
        if let Some(account) = &self.core.plugins.account {
            return account.report();
        }
        match self.method("account.status", json!({})).await {
            Ok(account) => account,
            Err(_) => {
                let workspace = self.core.status().workspace;
                let signed_in = self.core.workspace().is_some();
                json!({
                    "state": if signed_in { "signed_in" } else { "signed_out" },
                    "workspace_id": workspace.workspace_id,
                    "workspace_name": workspace.workspace_name,
                })
            }
        }
    }
}
