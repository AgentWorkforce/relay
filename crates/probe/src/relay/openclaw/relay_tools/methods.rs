//! The bridge methods `openclaw.relay_tools.status` and `.connect`. Both
//! run OpenClaw's command-line tool, so they run off the async runtime.

use super::RelayTools;
use crate::relay::contract::openclaw::{OpenClawToolsState, OpenClawToolsStatus};
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use serde_json::Value;
use std::sync::Arc;

/// The site whose hosted MCP OpenClaw signs in to: the signed-in account's.
fn site(core: &Core) -> String {
    core.plugins
        .account
        .as_ref()
        .map(|account| account.site_url().to_string())
        .unwrap_or_else(|| crate::relay::links::DEFAULT_SITE_URL.into())
}

fn not_set_up() -> String {
    super::super::Unavailable::NotInstalled.reason()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, RpcError> {
    tokio::task::spawn_blocking(work).await.map_err(|_| {
        RpcError::new(
            ErrorKind::Internal,
            "OpenClaw's command-line tool stopped unexpectedly.",
        )
    })
}

async fn status(
    tools: Option<Arc<RelayTools>>,
    site: String,
) -> Result<OpenClawToolsStatus, RpcError> {
    match tools {
        Some(tools) => blocking(move || tools.status(&site)).await,
        None => Ok(OpenClawToolsStatus {
            state: OpenClawToolsState::Unavailable,
            detail: Some(not_set_up()),
        }),
    }
}

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    let tools = core
        .plugins
        .settings
        .iter()
        .find_map(|extension| extension.openclaw_tools());
    match method {
        method::OpenclawRelayToolsStatus::NAME => Some(
            answer::<method::OpenclawRelayToolsStatus, _>(raw, |_| status(tools, site(core))).await,
        ),
        method::OpenclawRelayToolsConnect::NAME => Some(
            answer::<method::OpenclawRelayToolsConnect, _>(raw, |_| async move {
                let tools = tools.ok_or_else(|| RpcError::new(ErrorKind::Refused, not_set_up()))?;
                let site = site(core);
                blocking(move || tools.connect(&site))
                    .await?
                    .map_err(|reason| RpcError::new(ErrorKind::Refused, reason))
            })
            .await,
        ),
        _ => None,
    }
}
