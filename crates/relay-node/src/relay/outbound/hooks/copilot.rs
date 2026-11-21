//! Copilot hook requests are kernel-authenticated before exposing any chat data.
use super::{Outbound, OutboundError};
use crate::relay::store::{SessionKind, Target};
use serde_json::{json, Map, Value};
impl Outbound {
    pub(super) async fn copilot_hook(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        if uid != self.uid {
            return Err(OutboundError::not_this_user());
        }
        let arrived = std::time::Instant::now();
        let workspace = self.core.workspace();
        let generation = self.core.plugins.cloud.identity_sync_generation();
        let directory = self.core.plugins.sessions.clone();
        let mut payload = Value::Object(fields.clone());
        // The registration binding is chosen by the core, never by hook input.
        // Offers from a previous account or registration cannot cross over.
        let binding = fields
            .get("sessionId")
            .and_then(Value::as_str)
            .and_then(|sid| {
                let workspace = workspace.as_ref()?;
                self.core.store.read(|store| {
                    store
                        .registration_for(&Target::new(SessionKind::Copilot, sid))
                        .filter(|r| {
                            r.base_url == workspace.base_url
                                && self.core.key_for(r).as_ref() == Some(&workspace.key)
                        })
                        .map(|r| format!("{}:{}", r.agent_id, r.registered_at))
                })
            });
        payload["relayBinding"] = json!(binding);
        // The build's turn-end advisory (`TurnEndAdvisories`), for a turn
        // that ended on its own. The hook's client re-asks every second while
        // a stop waits and Copilot sends no `stop_hook_active`, so this
        // uses a non-consuming cache check: only a pending advisory forces
        // full native proof. Take it only after that proof and the account
        // generation check succeed, so rejected stops cannot consume it.
        let advisory_target = fields
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|sid| crate::relay::store::is_uuid(sid))
            .filter(|_| {
                fields.get("relayEvent").and_then(Value::as_str) == Some("stop")
                    && fields.get("stopReason").and_then(Value::as_str) == Some("end_turn")
            })
            .map(|sid| Target::new(SessionKind::Copilot, sid))
            .filter(|target| self.core.has_turn_end_advisory(target));
        payload["relayTurnEndAdvisory"] = json!(advisory_target.is_some());
        let answer = tokio::task::spawn_blocking(move || directory.copilot_hook(pid, &payload))
            .await
            .ok()
            .flatten()
            .ok_or_else(OutboundError::not_a_session)?;
        if self.core.workspace() != workspace
            || self.core.plugins.cloud.identity_sync_generation() != generation
        {
            return Err(OutboundError::not_a_session());
        }
        let advisory = advisory_target
            .and_then(|target| Some((self.core.take_turn_end_advisory(&target)?, target)));
        let answer = match advisory {
            Some((advisory, target)) => {
                let merged =
                    crate::relay::turn_end_advisories::merge_stop(answer.clone(), &advisory.text);
                if merged != answer {
                    self.core.turn_end_advisory_shown(&target, &advisory.ids);
                }
                merged
            }
            None => answer,
        };
        let Some(sid) = fields.get("sessionId").and_then(Value::as_str) else {
            return Ok(json!({}));
        };
        let target = Target::new(SessionKind::Copilot, sid);
        match fields.get("relayEvent").and_then(Value::as_str) {
            Some("start") => {
                self.copilot_identities
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(sid);
            }
            Some("tool") => {
                let answer = self.copilot_identity(&target, answer).await;
                if self.core.workspace() != workspace
                    || self.core.plugins.cloud.identity_sync_generation() != generation
                {
                    return Err(OutboundError::not_a_session());
                }
                return Ok(answer);
            }
            Some("before")
                if fields.get("toolName").and_then(Value::as_str)
                    == Some(crate::relay::copilot::QUESTION_TOOL) =>
            {
                // The native proof above took part of the time Copilot
                // waits for this hook: a question that might not be sent
                // before Copilot gives up is not sent at all.
                if !question_time_left(arrived.elapsed()) {
                    return Ok(json!({}));
                }
                return Ok(self.copilot_question(&target, fields).await);
            }
            _ => return Ok(answer),
        }
        // The same normal auto-activation consent and excluded-directory rules
        // apply; a hook never silently opts a chat into a workspace.
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
        let answer = self.copilot_identity(&target, answer).await;
        if self.core.workspace() != workspace
            || self.core.plugins.cloud.identity_sync_generation() != generation
        {
            return Err(OutboundError::not_a_session());
        }
        Ok(answer)
    }

    /// Copilot's `ask_user`, from a session whose native proof just passed:
    /// with question escalation on, the question goes to the question inbox
    /// and the tool call is denied with the reason, so the session keeps
    /// working and the answer arrives as a message. Anything else (a session
    /// not on the relay, escalation off, arguments of another shape, a
    /// question not sent within `question::ROUTE_LIMIT`) answers `{}`, and
    /// Copilot asks as usual.
    async fn copilot_question(&self, target: &Target, fields: &Map<String, Value>) -> Value {
        let Some(registration) = self
            .core
            .store
            .read(|store| store.registration_for(target).cloned())
        else {
            return json!({});
        };
        let args = fields.get("toolArgs").cloned().unwrap_or(Value::Null);
        let cwd = fields
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let reason = self
            .core
            .escalate_copilot_question(&registration, &args, cwd)
            .await;
        copilot_question_answer(reason.as_deref())
    }

    // Registration can finish after SessionStart's bounded wait. The next
    // verified tool hook supplies the identity once it exists, without repeating
    // the preamble on every tool result or releasing a waiting stop hook.
    async fn copilot_identity(&self, target: &Target, mut answer: Value) -> Value {
        let Some(workspace) = self.core.workspace() else {
            return answer;
        };
        let (identity, active) = self.core.store.read(|store| {
            let active: std::collections::HashSet<_> = store
                .registrations
                .iter()
                .filter(|r| r.target.kind == SessionKind::Copilot && r.missing_since.is_none())
                .map(|r| r.target.id.clone())
                .collect();
            let identity = store
                .registration_for(target)
                .filter(|r| {
                    r.missing_since.is_none()
                        && r.base_url == workspace.base_url
                        && self.core.key_for(r).as_ref() == Some(&workspace.key)
                })
                .map(|r| {
                    (
                        r.display_name().to_owned(),
                        r.current_address(&self.core.machine_prefix),
                        r.link_address(&self.core.machine_prefix),
                        format!("{}:{}", r.agent_id, r.registered_at),
                    )
                });
            (identity, active)
        });
        let Some((name, address, link, binding)) = identity else {
            return answer;
        };
        let key = format!("{binding}:{address}:{link}:{name}");
        let context = format!(
            "This Copilot chat is on Agent Relay as @{name}, desktop address {address}. Use the agent-relay MCP tools for messaging. First call join_relay with desktop_address=\"{link}\" and no hosted participant name. Then use send_relay_message and the other Relay tools as this chat. The runtime serves multiple chats: do not borrow another chat's address or use a separate terminal's identity. {}",
            crate::relay::hosted_mcp::NORM
        );
        let cached = {
            let mut seen = self
                .copilot_identities
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            seen.retain(|sid, _| active.contains(sid));
            if seen.len() >= 512 && !seen.contains_key(&target.id) {
                seen.clear();
            }
            seen.get(&target.id) == Some(&key)
        };
        if cached {
            return answer;
        }
        let directory = self.core.plugins.sessions.clone();
        let sid = target.id.clone();
        let expected = context.clone();
        let accepted = tokio::task::spawn_blocking(move || {
            directory.copilot_context_accepted(&sid, &expected)
        })
        .await
        .unwrap_or(false);
        if self.core.workspace().as_ref() != Some(&workspace) {
            return json!({});
        }
        let current = self.core.store.read(|store| {
            store
                .registration_for(target)
                .filter(|r| {
                    r.missing_since.is_none()
                        && r.base_url == workspace.base_url
                        && self.core.key_for(r).as_ref() == Some(&workspace.key)
                })
                .map(|r| {
                    (
                        r.display_name().to_owned(),
                        r.current_address(&self.core.machine_prefix),
                        r.link_address(&self.core.machine_prefix),
                        format!("{}:{}", r.agent_id, r.registered_at),
                    )
                })
        });
        if current != Some((name, address, link, binding)) {
            // The native hook already claimed this answer. A registration or
            // display change cannot undo that handoff. Keep the message and
            // let the next verified hook supply the current identity, without
            // caching or appending the identity observed before the wait.
            return answer;
        }
        if accepted {
            self.copilot_identities
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(target.id.clone(), key);
            return answer;
        }
        let message = answer["additionalContext"].as_str().unwrap_or("");
        answer["additionalContext"] = json!(format!("{context}\n{message}"));
        answer
    }
}

/// How long a Copilot `preToolUse` for `ask_user` may take in all, from the
/// request's arrival: inside the hook client's own wait (58 s,
/// `cli::copilot_hook`) and Copilot's hook timeout (60 s,
/// `copilot::settings`).
const QUESTION_BUDGET: std::time::Duration = std::time::Duration::from_secs(55);

/// Time kept back for answering once the question was sent.
const QUESTION_MARGIN: std::time::Duration = std::time::Duration::from_secs(3);

/// Whether a full `question::ROUTE_LIMIT` (and the margin) still fits in
/// the budget after `elapsed` was spent proving the caller. Otherwise the
/// question is not sent, so Copilot never shows a dialog for a question the
/// core also sends.
fn question_time_left(elapsed: std::time::Duration) -> bool {
    elapsed + crate::relay::question::ROUTE_LIMIT + QUESTION_MARGIN <= QUESTION_BUDGET
}

/// Copilot's `preToolUse` answer for `ask_user`: denied with `reason` once
/// the question went to the inbox (`permissionDecision`, as VS Code's and
/// GitHub's hook references give it), otherwise `{}`.
fn copilot_question_answer(reason: Option<&str>) -> Value {
    match reason {
        Some(reason) => json!({"permissionDecision": "deny", "permissionDecisionReason": reason}),
        None => json!({}),
    }
}

#[cfg(test)]
mod question_tests {
    use super::*;

    /// A slow native proof leaves no time to send the question: it is
    /// asked in Copilot as usual instead of both.
    #[test]
    fn a_slow_proof_leaves_the_question_to_copilot() {
        use std::time::Duration;
        assert!(question_time_left(Duration::ZERO));
        assert!(question_time_left(Duration::from_secs(32)));
        assert!(!question_time_left(Duration::from_secs(33)));
        assert!(!question_time_left(Duration::from_secs(50)));
        assert!(
            QUESTION_BUDGET < Duration::from_secs(58),
            "inside the client's wait"
        );
    }

    #[test]
    fn only_a_sent_question_denies_ask_user() {
        assert_eq!(copilot_question_answer(None), json!({}));
        assert_eq!(
            copilot_question_answer(Some("Sent to @triage.")),
            json!({"permissionDecision": "deny", "permissionDecisionReason": "Sent to @triage."})
        );
    }
}
