//! Native answers go back to the verified owner of an engaged mobile
//! conversation. Neither the plugin nor a peer supplies a recipient.

use super::{Outbound, OutboundError};
use crate::relay::client;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::links::Endpoint;
use serde_json::{json, Map, Value};

const MAX_TEXT: usize = 96 * 1024;

fn invalid() -> OutboundError {
    OutboundError::new(
        400,
        "invalid_mobile_result",
        "Use a control_token, turn_id, bounded text, and a native turn reason only.",
    )
}

fn owner_unavailable() -> OutboundError {
    OutboundError::new(503, "mobile_owner_unconfirmed",
        "The current owner could not be verified. Keep this answer queued and retry after reconnection.")
}

fn result_fields(fields: &Map<String, Value>) -> Result<(&str, &str, &str), OutboundError> {
    if fields.len() != 4 {
        return Err(invalid());
    }
    let control_token = fields
        .get("control_token")
        .and_then(Value::as_str)
        .filter(|value| crate::relay::store::is_uuid(value))
        .ok_or_else(invalid)?;
    let turn = fields
        .get("turn_id")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .ok_or_else(invalid)?;
    let text = fields
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty() && text.len() <= MAX_TEXT)
        .ok_or_else(invalid)?;
    if !matches!(
        fields.get("reason").and_then(Value::as_str),
        Some("answer" | "aborted" | "refusal" | "error")
    ) {
        return Err(invalid());
    }
    Ok((turn, text, control_token))
}

impl Outbound {
    pub(super) async fn mobile_handoff_result(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        let (turn, text, control_token) = result_fields(fields)?;
        let (_, initial, _) = self.authorize(pid, uid).await?;
        let _delivery = self.core.agent_locks.get(&initial.name).lock_owned().await;
        let (session, registration, token) = self.authorize(pid, uid).await?;
        if registration.agent_id != initial.agent_id || registration.target != initial.target {
            return Err(OutboundError::new(
                409,
                "session_changed",
                "The session changed while its answer was being sent.",
            ));
        }
        let runtime = self.mobile_runtime(&registration.target, pid).await?;
        if !self.core.mobile_handoff_enabled(&registration) {
            return Ok(json!({"accepted": false}));
        }
        // Owner verification includes a remote identity lookup. An unavailable
        // lookup is not evidence that this answer belongs to a different owner.
        let binding = self
            .core
            .mobile_handoff_binding(&registration)
            .await
            .ok_or_else(owner_unavailable)?;
        if !self
            .core
            .mobile_handoff_control_valid(&binding, &runtime, control_token, true)
        {
            return Ok(json!({"accepted": false}));
        }
        let Some((owner, owner_id)) = self
            .core
            .verified_owner(&registration)
            .await
            .filter(|(_, id)| id == &binding.owner)
        else {
            return Err(owner_unavailable());
        };
        self.admit(&session.target.key())?;
        let key = format!(
            "mobile-answer-{}",
            MessageRef::of(&format!("{}\n{owner_id}\n{turn}", binding.scope))
        );
        client::send_dm(
            &registration.base_url,
            &registration.sender_token(token),
            &Endpoint::Name(owner),
            text,
            Some(key),
        )
        .await
        .map_err(|_| {
            OutboundError::new(
                502,
                "mobile_result_unconfirmed",
                "The mobile answer was not confirmed; retry with the same turn_id.",
            )
        })?;
        Ok(json!({"accepted": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_cannot_choose_a_recipient_or_forge_a_sender() {
        for extra in ["to", "sender", "session_id", "approved"] {
            let mut fields = json!({"control_token":"00000000-0000-4000-8000-000000000001", "turn_id": "turn-1", "text": "Answer", "reason": "answer"})
                .as_object()
                .unwrap()
                .clone();
            fields.insert(extra.into(), json!("someone-else"));
            assert!(result_fields(&fields).is_err());
        }
    }

    #[test]
    fn valid_result_requires_control_generation() {
        let fields = json!({"control_token":"00000000-0000-4000-8000-000000000001", "turn_id":"turn-1", "text":"Answer", "reason":"answer"});
        assert!(result_fields(fields.as_object().unwrap()).is_ok());
        let mut absent = fields.as_object().unwrap().clone();
        absent.remove("control_token");
        assert!(result_fields(&absent).is_err());
    }

    #[test]
    fn malformed_and_oversized_answers_are_refused() {
        for value in [
            json!({"control_token":"00000000-0000-4000-8000-000000000001", "turn_id": "../other", "text": "Answer", "reason": "answer"}),
            json!({"control_token":"00000000-0000-4000-8000-000000000001", "turn_id": "turn-1", "text": " ", "reason": "answer"}),
            json!({"control_token":"00000000-0000-4000-8000-000000000001", "turn_id": "turn-1", "text": "x".repeat(MAX_TEXT + 1), "reason": "answer"}),
            json!({"control_token":"00000000-0000-4000-8000-000000000001", "turn_id": "turn-1", "text": "Answer", "reason": "peer"}),
        ] {
            assert!(result_fields(value.as_object().unwrap()).is_err());
        }
    }
}
