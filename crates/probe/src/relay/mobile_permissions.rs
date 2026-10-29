//! One-action approvals for a native Claude mobile turn. References are
//! scoped to one owner, workspace, native process incarnation and request.

use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::harness::claude::requests;
use crate::relay::mobile_handoff::{Binding, Runtime};
use crate::relay::spawn::drive::{direct_from, parse_reply, OwnerReply, ReplyDecision};
use crate::relay::store::{random_uuid, Registration, Target};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct Context {
    namespace: String,
    request: String,
    binding: Binding,
    target: Target,
    runtime: Runtime,
    control_token: String,
    expires: Instant,
}

fn pending() -> MutexGuard<'static, HashMap<String, Context>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Context>>> = OnceLock::new();
    PENDING
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn same_process(left: &Runtime, right: &Runtime) -> bool {
    left.pid == right.pid && left.start == right.start
}

/// Dropping a permission ticket withdraws only its own reference. A socket
/// disconnect leaves the ticket intact for a retry.
pub(crate) struct Permission {
    context: Context,
    pub notice: requests::Notice,
}

impl Permission {
    pub(crate) fn new(
        binding: Binding,
        target: Target,
        runtime: Runtime,
        control_token: &str,
        tool: &str,
        input: Value,
    ) -> Option<Self> {
        let request = random_uuid();
        let namespace = format!(
            "mobile-permission-{}",
            MessageRef::of(&format!(
                "{}\n{}\n{}\n{}\n{control_token}\n{request}",
                binding.scope, binding.owner, runtime.pid, runtime.start
            ))
        );
        let event = json!({"type":"control_request", "request_id": request,
            "request": {"subtype":"can_use_tool", "tool_name":tool, "input":input}});
        if requests::register(&namespace, &event).is_some() {
            return None;
        }
        let notice = requests::unforwarded(&namespace).into_iter().next()?;
        let context = Context {
            namespace,
            request,
            binding,
            target,
            runtime,
            control_token: control_token.into(),
            expires: Instant::now() + Duration::from_secs(300),
        };
        pending().insert(notice.reference.clone(), context.clone());
        Some(Self { context, notice })
    }

    pub(crate) fn decision(&self) -> Option<Value> {
        let (_, line) = requests::due(&self.context.namespace)
            .into_iter()
            .find(|(reference, _)| reference == &self.notice.reference)?;
        let response: Value = serde_json::from_str(&line).ok()?;
        Some(response["response"]["response"].clone())
    }
}

impl Drop for Permission {
    fn drop(&mut self) {
        pending().remove(&self.notice.reference);
        requests::cancel(&self.context.namespace, &self.context.request);
    }
}

impl Core {
    /// Checked before the spawned-harness reply path records a delivery.
    /// Peer replies and expired/replaced process references cannot act.
    pub(crate) async fn mobile_permission_reply(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Option<OwnerReply> {
        let (decision, reference) = parse_reply(delivery.text.as_deref().unwrap_or_default())?;
        let context = pending().get(reference).cloned()?;
        if Instant::now() >= context.expires
            || !direct_from(delivery, Some(&context.binding.owner))
            || registration.target != context.target
            || !requests::has_pending(&context.namespace, reference)
        {
            return Some(OwnerReply::NotOne);
        }
        let binding = self.mobile_handoff_binding(registration).await?;
        if binding != context.binding
            || !self.mobile_handoff_control_valid(
                &binding,
                &context.runtime,
                &context.control_token,
                false,
            )
        {
            return Some(OwnerReply::NotOne);
        }
        let directory = self.plugins.sessions.clone();
        let target = context.target.clone();
        let pid = context.runtime.pid;
        let runtime =
            tokio::task::spawn_blocking(move || directory.mobile_claude_runtime(&target, pid))
                .await
                .ok()
                .flatten()?;
        if !same_process(&runtime, &context.runtime) {
            return Some(OwnerReply::NotOne);
        }
        if self
            .store
            .remember(|store| store.record_injected(&delivery.id))
            .is_err()
        {
            return Some(OwnerReply::Unsaved);
        }
        let result = match decision {
            ReplyDecision::Choose(_) => {
                crate::relay::codex::app_server::drive::ReplyResult::InvalidChoice
            }
            decision => requests::answer(
                &context.namespace,
                reference,
                delivery.sender_id.as_deref(),
                Some(&binding.owner),
                matches!(decision, ReplyDecision::Approve),
            ),
        };
        Some(OwnerReply::Settled(format!(
            "Claude mobile approval reply: {result:?}"
        )))
    }
}

#[cfg(test)]
mod tests;
