//! Native tool prompts wait for one verified-owner decision. There is no
//! endpoint for installing permission rules or supplying a trusted sender.

use super::{CoreStream, Outbound, OutboundError, Request};
use crate::relay::client;
use crate::relay::harness::claude::requests;
use crate::relay::links::Endpoint;
use crate::relay::mobile_handoff::{Binding, Runtime};
use crate::relay::mobile_permissions::{same_process, Permission};
use crate::relay::spawn::drive::claude::approval_text;
use crate::relay::store::Registration;
use serde_json::{json, Map, Value};
use std::time::Duration;
use tokio::time::Instant;

mod tickets;
pub(super) use tickets::Tickets;
use tickets::{Ticket, TicketState};
use tokio::io::AsyncReadExt;

const PATH: &str = "/claude/mobile-handoff/permission";
const WAIT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_secs(15);

fn fields(fields: &Map<String, Value>) -> Result<(&str, &Value, &str, &str), OutboundError> {
    let tool = fields
        .get("tool_name")
        .and_then(Value::as_str)
        .filter(|tool| {
            !tool.is_empty() && tool.len() <= 128 && !tool.chars().any(char::is_control)
        });
    let token = fields
        .get("control_token")
        .and_then(Value::as_str)
        .filter(|token| crate::relay::store::is_uuid(token));
    let request = fields
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 160
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
        });
    match (fields.len(), tool, fields.get("tool_input"), token, request) {
        (4, Some(tool), Some(input), Some(token), Some(request)) if input.is_object() => {
            Ok((tool, input, token, request))
        }
        _ => Err(OutboundError::new(
            400,
            "invalid_mobile_permission",
            "Use request_id, control_token, tool_name and tool_input only.",
        )),
    }
}

fn denied() -> Value {
    json!({"handled":true, "decision":{"behavior":"deny", "message":"The mobile permission request ended without a current owner approval."}})
}

impl Outbound {
    /// Ordinary routes keep their established disconnect semantics; a
    /// permission socket closing cancels only this poll; its ticket survives.
    pub(super) async fn handle_connection(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
        stream: &mut CoreStream,
    ) -> Option<Result<Value, OutboundError>> {
        if request.method != "POST" || request.path != PATH {
            return Some(self.handle(pid, uid, request).await);
        }
        let mut closed = [0u8; 1];
        tokio::select! {
            result = self.handle(pid, uid, request) => Some(result),
            _ = stream.read(&mut closed) => None,
        }
    }

    pub(super) async fn mobile_handoff_permission(
        &self,
        pid: i32,
        uid: u32,
        values: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        tokio::time::timeout(POLL, self.poll_permission(pid, uid, values))
            .await
            .unwrap_or_else(|_| Ok(json!({"handled":true,"pending":true})))
    }

    async fn poll_permission(
        &self,
        pid: i32,
        uid: u32,
        values: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        let (tool, input, control_token, request_id) = fields(values)?;
        let (session, registration, _) = self.authorize(pid, uid).await?;
        let runtime = self.mobile_runtime(&registration.target, pid).await?;
        let Some(binding) = self.core.mobile_handoff_binding(&registration).await else {
            return Ok(json!({"handled":false}));
        };
        if !self
            .core
            .mobile_handoff_control_valid(&binding, &runtime, control_token, false)
            || tool == "AskUserQuestion"
        {
            return Ok(json!({"handled":false}));
        }
        let core = self.core.clone();
        let guard_binding = binding.clone();
        let guard_runtime = runtime.clone();
        let guard_registration = registration.clone();
        let guard_token = control_token.to_owned();
        let ticket = self.mobile_permissions.open(
            &binding,
            &runtime,
            request_id,
            control_token,
            tool,
            input,
            || {
                self.admit(&session.target.key())?;
                Permission::new(
                    binding.clone(),
                    registration.target.clone(),
                    runtime.clone(),
                    control_token,
                    tool,
                    input.clone(),
                )
                .ok_or_else(|| {
                    OutboundError::new(
                        400,
                        "unsupported_mobile_permission",
                        "This native permission cannot be forwarded.",
                    )
                })
            },
            move || {
                !core.stopping()
                    && core.mobile_handoff_enabled(&guard_registration)
                    && core.mobile_handoff_control_valid(
                        &guard_binding,
                        &guard_runtime,
                        &guard_token,
                        false,
                    )
            },
        )?;
        // Include mutex acquisition in the bound: concurrent retries cannot
        // extend a socket past the provider's complete-response deadline.
        Ok(tokio::time::timeout(POLL, async {
            let mut state = ticket.state.lock().await;
            self.wait_permission(pid, &registration, &binding, &runtime, &ticket, &mut state)
                .await
        })
        .await
        .unwrap_or_else(|_| json!({"handled":true,"pending":true})))
    }

    async fn permission_current(
        &self,
        pid: i32,
        registration: &Registration,
        binding: &Binding,
        runtime: &Runtime,
        control_token: &str,
    ) -> bool {
        let Some((current, _)) =
            self.core
                .agent_credential(&registration.name)
                .filter(|(current, _)| {
                    current.agent_id == registration.agent_id
                        && current.target == registration.target
                        && current.base_url == registration.base_url
                        && current.workspace_key == registration.workspace_key
                })
        else {
            return false;
        };
        if self.core.mobile_handoff_binding(&current).await.as_ref() != Some(binding)
            || !self
                .core
                .mobile_handoff_control_valid(binding, runtime, control_token, false)
        {
            return false;
        }
        self.mobile_runtime(&current.target, pid)
            .await
            .ok()
            .is_some_and(|now| same_process(&now, runtime))
    }

    async fn forward_permission(
        &self,
        registration: &Registration,
        binding: &Binding,
        permission: &Permission,
    ) {
        let Some((owner, id)) = self
            .core
            .verified_owner(registration)
            .await
            .filter(|(_, id)| id == &binding.owner)
        else {
            return;
        };
        let Some((current, token)) =
            self.core
                .agent_credential(&registration.name)
                .filter(|(current, _)| {
                    current.agent_id == registration.agent_id
                        && current.target == registration.target
                        && current.base_url == registration.base_url
                        && current.workspace_key == registration.workspace_key
                })
        else {
            return;
        };
        let text = approval_text(current.display_name(), &permission.notice);
        let key = format!(
            "mobile-approval-{}-{}",
            permission.notice.reference,
            crate::relay::delivery::policy::MessageRef::of(&id)
        );
        if client::send_dm(
            &current.base_url,
            &current.sender_token(token),
            &Endpoint::Name(owner),
            &text,
            Some(key),
        )
        .await
        .is_ok()
        {
            requests::mark_forwarded(&permission.notice.reference);
        }
    }

    async fn wait_permission(
        &self,
        pid: i32,
        registration: &Registration,
        binding: &Binding,
        runtime: &Runtime,
        ticket: &Ticket,
        state: &mut TicketState,
    ) -> Value {
        let mut checked = Instant::now() - Duration::from_secs(5);
        loop {
            if ticket.expired(Instant::now())
                || !self.core.mobile_handoff_enabled(registration)
                || self.core.stopping()
            {
                return state.finish(denied());
            }
            // Every poll (including a cached allow) verifies the same owner,
            // generation and native process before returning a decision.
            if checked.elapsed() >= Duration::from_secs(5) || state.result.is_some() {
                if !self
                    .permission_current(pid, registration, binding, runtime, &ticket.token)
                    .await
                {
                    return state.finish(denied());
                }
                checked = Instant::now();
            }
            if let Some(result) = &state.result {
                return result.clone();
            }
            let Some(permission) = state.permission.as_ref() else {
                return state.finish(denied());
            };
            if let Some(decision) = permission.decision() {
                let result = if decision["behavior"] == "allow"
                    && self
                        .permission_current(pid, registration, binding, runtime, &ticket.token)
                        .await
                {
                    json!({"handled":true,"decision":{"behavior":"allow","updatedInput":ticket.input}})
                } else {
                    denied()
                };
                return state.finish(result);
            }
            if state.retry.due(Instant::now())
                && requests::unforwarded(&permission.notice.session)
                    .iter()
                    .any(|notice| notice.reference == permission.notice.reference)
            {
                // Advance before the await: disconnect cannot reset backoff.
                state.retry.attempted(Instant::now());
                self.forward_permission(registration, binding, permission)
                    .await;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

#[cfg(test)]
mod tests;
