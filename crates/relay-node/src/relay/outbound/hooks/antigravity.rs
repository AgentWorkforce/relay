//! Antigravity lifecycle hook requests are kernel-authenticated against the
//! live `language_server` process and its held conversation database before
//! observing session state or handing over relay messages.
use super::{Outbound, OutboundError};
use crate::relay::store::{SessionKind, Target};
use serde_json::{json, Map, Value};

impl Outbound {
    pub(super) async fn antigravity_hook(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        if uid != self.uid {
            return Err(OutboundError::not_this_user());
        }
        let workspace = self.core.workspace();
        let generation = self.core.plugins.cloud.identity_sync_generation();
        let directory = self.core.plugins.sessions.clone();
        let mut payload = Value::Object(fields.clone());
        let binding = fields
            .get("conversationId")
            .and_then(Value::as_str)
            .and_then(|sid| {
                let workspace = workspace.as_ref()?;
                self.core.store.read(|store| {
                    store
                        .registration_for(&Target::new(SessionKind::Antigravity, sid))
                        .filter(|r| {
                            r.base_url == workspace.base_url
                                && self.core.key_for(r).as_ref() == Some(&workspace.key)
                        })
                        .map(|r| format!("{}:{}", r.agent_id, r.registered_at))
                })
            });
        payload["relayBinding"] = json!(binding);
        let advisory_target = fields
            .get("conversationId")
            .and_then(Value::as_str)
            .filter(|sid| crate::relay::store::is_uuid(sid))
            .filter(|_| {
                fields.get("relayEvent").and_then(Value::as_str) == Some("stop")
                    && fields.get("terminationReason").and_then(Value::as_str)
                        == Some("NO_TOOL_CALL")
            })
            .map(|sid| Target::new(SessionKind::Antigravity, sid))
            .filter(|target| self.core.has_turn_end_advisory(target));
        let core = self.core.clone();
        let expected_workspace = workspace.clone();
        let still_current = move || {
            core.workspace() == expected_workspace
                && core.plugins.cloud.identity_sync_generation() == generation
        };
        let answer = tokio::task::spawn_blocking(move || {
            directory.antigravity_hook(pid, &payload, &still_current)
        })
        .await
        .ok()
        .flatten()
        .ok_or_else(OutboundError::not_a_session)?;
        let claimed = answer.get("decision").is_some() || answer.get("injectSteps").is_some();
        let unchanged = self.core.workspace() == workspace
            && self.core.plugins.cloud.identity_sync_generation() == generation;
        if !claimed && !unchanged {
            return Err(OutboundError::not_a_session());
        }
        let answer = match advisory_target
            .filter(|_| unchanged)
            .and_then(|target| Some((self.core.take_turn_end_advisory(&target)?, target)))
        {
            Some((advisory, target)) => {
                let reason = match answer["reason"].as_str().filter(|s| !s.is_empty()) {
                    Some(existing) => format!("{existing}\n\n{}", advisory.text),
                    None => advisory.text.clone(),
                };
                self.core.turn_end_advisory_shown(&target, &advisory.ids);
                json!({
                    "decision": "continue",
                    "reason": reason,
                })
            }
            None => answer,
        };
        let Some(sid) = fields.get("conversationId").and_then(Value::as_str) else {
            return Ok(answer);
        };
        if fields.get("relayEvent").and_then(Value::as_str) != Some("start") {
            return Ok(answer);
        }
        let target = Target::new(SessionKind::Antigravity, sid);
        let sessions = self.core.plugins.sessions.clone();
        let lookup = target.clone();
        let session = tokio::task::spawn_blocking(move || sessions.find_session(&lookup))
            .await
            .ok()
            .flatten();
        if let Some(session) = session {
            if self.setup.auto_activates(&session).await {
                let core = self.core.clone();
                tokio::spawn(async move {
                    core.activate_new_sessions().await;
                });
                let until = tokio::time::Instant::now() + std::time::Duration::from_secs(4);
                while self
                    .core
                    .store
                    .read(|store| store.registration_for(&target).is_none())
                    && tokio::time::Instant::now() < until
                {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
        if self.core.workspace() != workspace
            || self.core.plugins.cloud.identity_sync_generation() != generation
        {
            return Err(OutboundError::not_a_session());
        }
        Ok(answer)
    }
}
