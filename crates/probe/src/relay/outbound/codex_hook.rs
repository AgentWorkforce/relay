//! The route Agent Relay's Codex hook asks (`codex::stop_hook`):
//!
//! ```text
//! POST /codex/stop-hook   {"session_id", "turn_id", "hook_event_name", "stop_hook_active"}
//! ```

use super::{Outbound, OutboundError};
use crate::relay::store::SessionKind;
use serde_json::{json, Map, Value};

impl Outbound {
    /// Agent Relay's Codex hook (`codex::stop_hook`), from a Codex turn after
    /// a tool call (PostToolUse) or as it ends (Stop): the next relayed
    /// message waiting for that turn (`codex::turn_hook`), or at a stop for
    /// that thread's Conductor chat, else a recap of those delivered while
    /// the chat was idle, else `{}`. Only a hook below the Codex that holds
    /// the thread's writer lock gets its messages; one for a thread nothing
    /// waits for is answered before the slower check, so a tool call is not
    /// held up.
    pub(super) async fn codex_stop_hook(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        use crate::relay::codex::turn_hook::HookEvent;
        if uid != self.uid {
            return Err(OutboundError::not_this_user());
        }
        let Some(inbox) = self.core.plugins.codex_stop_hook.clone() else {
            return Ok(json!({}));
        };
        let thread = fields
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .filter(|thread| crate::relay::store::is_uuid(thread))
            .ok_or_else(|| {
                OutboundError::new(
                    400,
                    "invalid_session_id",
                    "session_id must be a Codex thread id.",
                )
            })?;
        let Some(event) = HookEvent::named(fields.get("hook_event_name").and_then(Value::as_str))
        else {
            return Ok(json!({}));
        };
        if event == HookEvent::PostToolUse && !inbox.turns().has_offered(&thread) {
            return Ok(json!({}));
        }
        let stop_hook_active = fields
            .get("stop_hook_active")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let turn = fields
            .get("turn_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let directory = self.core.plugins.sessions.clone();
        let injector = self.core.plugins.injector.clone();
        tokio::task::spawn_blocking(move || {
            if !directory.holds_codex_thread(pid, &thread) {
                return Err(OutboundError::not_a_session());
            }
            if event == HookEvent::PostToolUse {
                return Ok(inbox.turns().answer(&thread, event));
            }
            let target = crate::relay::store::Target::new(SessionKind::Codex, thread.clone());
            let shown = !turn.is_empty() && !injector.relay_started_turn(&target, &turn);
            let conductor = inbox.answer(
                &thread,
                stop_hook_active,
                shown,
                &|message_ref| injector.codex_recorded(&target, message_ref),
                &|message_ref| injector.final_answer(&target, message_ref),
            );
            if conductor != json!({}) {
                return Ok(conductor);
            }
            Ok(inbox.turns().answer(&thread, event))
        })
        .await
        .unwrap_or_else(|_| Ok(json!({})))
    }
}
