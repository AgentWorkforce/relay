//! The bridge methods for agents, messaging, people, links and settings:
//! parameters in, results out. Every type is the registry's
//! (`relay::contract`); see `docs/relay-core.md` for the contract.

mod addressing;
use addressing::{endpoint, recipient_endpoint};
mod usage;

use crate::relay::contract::agents::{
    ActivityLog, CreatedWebhook, IntegrationChange, IntegrationParams, RevokedWebhook,
    SettingsValues, TestMessageSent,
};
use crate::relay::contract::claude_delivery::ClaudeDeliveryChanged;
use crate::relay::contract::directory::People;
use crate::relay::contract::{answer, method, Done};
use crate::relay::daemon::Core;
use crate::relay::links::{self, Endpoint};
use crate::relay::people::RosterQuery;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::usage::{action, UsageEvent, UsageOperation as Op};
use serde_json::{Map, Value};
use std::sync::Arc;

/// `settings.get`'s shape, read from the store's and the extensions'
/// settings; a key the contract does not name is a defect here.
/// The app's own `settings.set`: the person's change, which the account
/// hears about. Agents' changes and their rollbacks go through `set_settings`
/// alone.
fn app_set_settings(
    core: &Core,
    changes: &Map<String, Value>,
) -> Result<Map<String, Value>, RpcError> {
    let settings = core.set_settings(changes)?;
    if let Some(account) = &core.plugins.account {
        account.person_changed_settings(changes);
    }
    Ok(settings)
}

fn settings_values(settings: Map<String, Value>) -> Result<SettingsValues, RpcError> {
    serde_json::from_value(Value::Object(settings)).map_err(|_| {
        RpcError::new(
            ErrorKind::Internal,
            "A setting this core holds is not in the bridge contract.",
        )
    })
}

async fn unsubscribe(
    core: &Arc<Core>,
    request: IntegrationParams,
) -> Result<IntegrationChange, RpcError> {
    core.unsubscribe_integration(&request.name, &request.provider, &request.resource)
        .await
}

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    Some(match method {
        method::AgentsList::NAME => {
            answer::<method::AgentsList, _>(raw, |_| async { Ok(core.agents_list()) }).await
        }
        method::AgentsRegister::NAME => {
            answer::<method::AgentsRegister, _>(raw, |request| async move {
                usage::register(core, request).await
            })
            .await
        }
        method::AgentsUnregister::NAME | method::AgentsEnd::NAME => {
            let end_spawned = method == method::AgentsEnd::NAME;
            answer::<method::AgentsUnregister, _>(raw, |request| async move {
                usage::remove(core, &request.name, end_spawned).await
            })
            .await
        }
        method::AgentsRename::NAME => {
            answer::<method::AgentsRename, _>(raw, |request| async move {
                core.rename(&request.name, &request.new_name).await
            })
            .await
        }
        method::AgentsTestMessage::NAME => {
            answer::<method::AgentsTestMessage, _>(raw, |request| async move {
                action(core, UsageEvent::started(Op::MessageTest), async {
                    core.test_message(&request.name, request.text.as_deref())
                        .await
                        .map(|message_id| TestMessageSent { message_id })
                })
                .await
            })
            .await
        }
        method::AgentsReplySetting::NAME => {
            answer::<method::AgentsReplySetting, _>(raw, |request| async move {
                core.set_reply_setting(&request.name, request.enabled)
                    .await
                    .map(|_| Done {})
            })
            .await
        }
        method::AgentsWebhookCreate::NAME => {
            answer::<method::AgentsWebhookCreate, _>(raw, |request| async move {
                core.create_webhook(&request.name)
                    .await
                    .map(|hook| CreatedWebhook {
                        id: hook.id,
                        url: hook.url,
                        secret: hook.secret.as_ref().map(|s| s.expose().to_string()),
                        created: hook.created,
                    })
            })
            .await
        }
        method::AgentsWebhookRevoke::NAME => {
            answer::<method::AgentsWebhookRevoke, _>(raw, |request| async move {
                core.revoke_webhook(&request.name)
                    .await
                    .map(|already_deleted| RevokedWebhook { already_deleted })
            })
            .await
        }
        method::AgentsIntegrationsSubscribe::NAME => {
            answer::<method::AgentsIntegrationsSubscribe, _>(raw, |r| async move {
                core.subscribe_integration(&r.name, &r.provider, &r.resource)
                    .await
            })
            .await
        }
        method::AgentsIntegrationsUnsubscribe::NAME => {
            answer::<method::AgentsIntegrationsUnsubscribe, _>(raw, |r| unsubscribe(core, r)).await
        }
        method::AgentsIntegrationsCleanUp::NAME => {
            answer::<method::AgentsIntegrationsCleanUp, _>(raw, |r| unsubscribe(core, r)).await
        }
        method::SettingsGet::NAME => {
            answer::<method::SettingsGet, _>(raw, |_| async { settings_values(core.settings()) })
                .await
        }
        method::SettingsSet::NAME => {
            answer::<method::SettingsSet, _>(raw, |changes| async move {
                let _writing = crate::relay::settings_registry::writing();
                let changes = match serde_json::to_value(changes) {
                    Ok(Value::Object(changes)) => changes,
                    _ => Map::new(),
                };
                settings_values(app_set_settings(core, &changes)?)
            })
            .await
        }
        method::ActivityList::NAME => {
            answer::<method::ActivityList, _>(raw, |request| async move {
                Ok(ActivityLog {
                    activity: core.activity_list(request.limit),
                })
            })
            .await
        }
        method::ClaudeDeliveryStatus::NAME => {
            answer::<method::ClaudeDeliveryStatus, _>(raw, |_| async {
                Ok(core.claude_delivery_status())
            })
            .await
        }
        method::ClaudeDeliveryRestrict::NAME => {
            answer::<method::ClaudeDeliveryRestrict, _>(raw, |request| async move {
                core.set_claude_delivery_restricted(request.restricted)?;
                Ok(Done {})
            })
            .await
        }
        method::ClaudeDeliverySession::NAME => {
            answer::<method::ClaudeDeliverySession, _>(raw, |request| async move {
                core.set_claude_session_delivery(&request.session_id, request.direct)?;
                Ok(Done {})
            })
            .await
        }
        method::ClaudeDeliverySender::NAME => {
            answer::<method::ClaudeDeliverySender, _>(raw, |request| async move {
                core.set_claude_sender_delivery(&request.sender, &request.name, request.allowed)?;
                Ok(Done {})
            })
            .await
        }
        method::ClaudeDeliveryApprove::NAME => {
            answer::<method::ClaudeDeliveryApprove, _>(raw, |request| async move {
                Ok(ClaudeDeliveryChanged {
                    changed: core.approve_claude_delivery(&request.id)?,
                })
            })
            .await
        }
        method::ClaudeDeliveryDismiss::NAME => {
            answer::<method::ClaudeDeliveryDismiss, _>(raw, |request| async move {
                Ok(ClaudeDeliveryChanged {
                    changed: core.dismiss_claude_delivery(&request.id)?,
                })
            })
            .await
        }
        method::RosterList::NAME => {
            answer::<method::RosterList, _>(raw, |request| async move {
                core.roster_list(&RosterQuery {
                    where_runs: request.where_runs,
                    include_idle: request.include_idle,
                    q: request.q,
                })
                .await
            })
            .await
        }
        method::RosterGet::NAME => {
            answer::<method::RosterGet, _>(raw, |request| async move {
                let target = recipient_endpoint(request.to.as_deref(), request.address.as_deref())?;
                core.recipient(&target, request.message_id.as_deref()).await
            })
            .await
        }
        method::MessagesConversations::NAME => {
            answer::<method::MessagesConversations, _>(raw, |_| core.conversations()).await
        }
        method::MessagesHistory::NAME => {
            answer::<method::MessagesHistory, _>(raw, |request| async move {
                let peer = endpoint(&request.endpoint)?;
                core.history(&peer, request.before.as_deref()).await
            })
            .await
        }
        method::MessagesSend::NAME => {
            answer::<method::MessagesSend, _>(raw, |request| async move {
                usage::send(core, request).await
            })
            .await
        }
        method::PeopleList::NAME => {
            answer::<method::PeopleList, _>(raw, |_| async {
                core.people().await.map(|people| People { people })
            })
            .await
        }
        method::LinksParse::NAME => {
            answer::<method::LinksParse, _>(raw, |request| async move {
                links::parse_link(&request.url)
                    .map_err(|error| RpcError::new(ErrorKind::InvalidParams, error.to_string()))
            })
            .await
        }
        _ => return None,
    })
}
