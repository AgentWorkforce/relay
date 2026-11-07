//! Explicit agent registration and messaging with shared usage outcomes.
use super::recipient_endpoint;
use crate::relay::contract::directory::SentMessage;
use crate::relay::daemon::Core;
use crate::relay::protocol::RpcError;
use crate::relay::usage::{self, UsageEvent, UsageOperation as Op};
use std::sync::Arc;

pub(super) async fn register(
    core: &Arc<Core>,
    request: crate::relay::contract::agents::RegisterParams,
) -> Result<crate::relay::agents::Registered, RpcError> {
    let mut event = UsageEvent::started(Op::AgentRegister);
    event.agent_kind = Some(request.target.kind);
    usage::record(core, event);
    let result = core
        .register_target(
            &request.target,
            request.name.as_deref(),
            request.description.as_deref(),
        )
        .await;
    event.already_registered = result
        .as_ref()
        .ok()
        .map(|registered| registered.already_registered);
    usage::record(core, event.completed(&result));
    result
}

pub(super) async fn send(
    core: &Arc<Core>,
    request: crate::relay::contract::directory::SendParams,
) -> Result<crate::relay::contract::directory::SentMessage, RpcError> {
    let mut event = UsageEvent::started(Op::MessageSend);
    event.is_reply = Some(request.reply_to.is_some());
    usage::action(core, event, async {
        let target = recipient_endpoint(request.to.as_deref(), request.address.as_deref())?;
        let sent = core
            .send_as_person(&target, &request.text, request.reply_to.as_deref())
            .await?;
        let recipient = core.recipient_after_send(&target, &sent).await;
        Ok(SentMessage {
            message_id: sent.message_id,
            conversation_id: sent.conversation_id,
            to: sent.to,
            recipient,
        })
    })
    .await
}

pub(super) async fn remove(
    core: &Arc<Core>,
    name: &str,
    end_spawned: bool,
) -> Result<crate::relay::contract::Done, RpcError> {
    usage::action(core, UsageEvent::started(Op::AgentUnregister), async {
        let removed = if end_spawned {
            core.end_spawned_agent(name).await
        } else {
            core.unregister(name).await
        };
        removed.map(|_| crate::relay::contract::Done {})
    })
    .await
}
