//! The bridge methods every core answers about this computer and its Cloud
//! chat and contractors, then whatever its account plugin answers.

use crate::relay::contract::platform::LoginItemState;
use crate::relay::contract::{answer, method, Done};
use crate::relay::daemon::Core;
use crate::relay::protocol::RpcError;
use crate::relay::{cloud_chat, contractor_access, login_item};
use serde_json::Value;
use std::sync::Arc;

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    if let Some(result) = cloud_chat::call(core, method, raw.clone()).await {
        return Some(result);
    }
    if let Some(result) = contractor_access::call(core, method, raw.clone()).await {
        return Some(result);
    }
    let config = core.config();
    match method {
        method::LoginItemSet::NAME => {
            return Some(
                answer::<method::LoginItemSet, _>(raw, |request| async move {
                    login_item::set(&config.home, &config.env, request.enabled).map(|_| Done {})
                })
                .await,
            )
        }
        method::LoginItemStatus::NAME => {
            return Some(
                answer::<method::LoginItemStatus, _>(raw, |_| async {
                    login_item::status(&config.home, &config.env)
                        .map(|enabled| LoginItemState { enabled })
                })
                .await,
            )
        }
        _ => {}
    }
    let account = core.plugins.account.clone()?;
    account.call(core, method, raw).await
}
