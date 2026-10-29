//! Explicit agent registration and messaging with shared usage outcomes.
use super::recipient_endpoint;
use crate::relay::contract::directory::SentMessage;
use crate::relay::daemon::Core;
use crate::relay::protocol::RpcError;
use crate::relay::telemetry::{
    self, TelemetryEvent, TelemetryOperation as Op, TelemetryOutcome as Outcome,
};
use std::sync::Arc;

pub(super) async fn register(
    core: &Arc<Core>,
    request: crate::relay::contract::agents::RegisterParams,
) -> Result<crate::relay::agents::Registered, RpcError> {
    let mut event = TelemetryEvent::new(Op::AgentRegister, Outcome::Started);
    event.agent_kind = Some(request.target.kind);
    telemetry::record_for(core, event);
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
    telemetry::record_for(core, event.completed(&result));
    result
}

pub(super) async fn send(
    core: &Arc<Core>,
    request: crate::relay::contract::directory::SendParams,
) -> Result<crate::relay::contract::directory::SentMessage, RpcError> {
    let mut event = TelemetryEvent::new(Op::MessageSend, Outcome::Started);
    event.is_reply = Some(request.reply_to.is_some());
    telemetry::action(core, event, async {
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

pub(super) async fn unregister(
    core: &Arc<Core>,
    name: &str,
) -> Result<crate::relay::contract::Done, RpcError> {
    telemetry::action(
        core,
        TelemetryEvent::new(Op::AgentUnregister, Outcome::Started),
        async {
            core.unregister(name)
                .await
                .map(|_| crate::relay::contract::Done {})
        },
    )
    .await
}
