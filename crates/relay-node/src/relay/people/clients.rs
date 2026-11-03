//! The workspace-key client the roster reads with.

use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::sdk_gaps;

impl Core {
    /// The workspace and a client for its roster, with the workspace key.
    pub(crate) fn roster_client(
        &self,
    ) -> Result<
        (
            crate::relay::workspace::Workspace,
            crate::relay::diagnostic_http::HttpClient,
        ),
        RpcError,
    > {
        let workspace = self.workspace().ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotSignedIn,
                "No Agent Relay workspace key was found.",
            )
        })?;
        let http = sdk_gaps::http(&workspace.base_url, &workspace.key)
            .map_err(|e| RpcError::from_relaycast(&e))?;
        Ok((workspace, http))
    }
}
