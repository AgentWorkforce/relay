//! Explicit agent registration and messaging with shared usage outcomes.
use super::recipient_endpoint;
use crate::relay::contract::directory::SentMessage;
use crate::relay::daemon::{CallContext, Core};
use crate::relay::files;
use crate::relay::person_guard::admit_person_send;
use crate::relay::protocol::{ErrorKind, RpcError};
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
    context: &CallContext,
    request: crate::relay::contract::directory::SendParams,
) -> Result<crate::relay::contract::directory::SentMessage, RpcError> {
    let mut event = UsageEvent::started(Op::MessageSend);
    event.is_reply = Some(request.reply_to.is_some());
    usage::action(core, event, async {
        // A session sends as its own agent, through the relay-send socket.
        admit_person_send(core, context).await?;
        let target = recipient_endpoint(request.to.as_deref(), request.address.as_deref())?;
        let files = read_person_files(core, request.files).await?;
        let sent = core
            .send_as_person(&target, &request.text, request.reply_to.as_deref(), &files)
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

/// Reads the files a person's send attaches ([`files::PersonFiles`]): at
/// most [`files::MAX_SEND_FILES`], each at most 25 MB.
async fn read_person_files(
    core: &Arc<Core>,
    paths: Vec<String>,
) -> Result<Vec<files::LocalFile>, RpcError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if paths.len() > files::MAX_SEND_FILES {
        return Err(RpcError::invalid_params(format!(
            "A message can carry at most {} files; this one names {}.",
            files::MAX_SEND_FILES,
            paths.len()
        )));
    }
    let policy = files::PersonFiles::new(&core.config.home, &core.config.app_data_dir);
    let read = tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| files::read_person_file(path, &policy))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| RpcError::new(ErrorKind::Internal, "The files could not be read."))?;
    read.map_err(|error| match error {
        files::LocalFileError::NotAllowed(message) => RpcError::new(ErrorKind::Refused, message),
        files::LocalFileError::TooLarge(message) | files::LocalFileError::Invalid(message) => {
            RpcError::invalid_params(message)
        }
    })
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
