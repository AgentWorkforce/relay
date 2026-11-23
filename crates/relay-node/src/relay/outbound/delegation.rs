//! `POST /send` with `owner_approval` (see [`requested_owner_approval`]),
//! `POST /delegation/withdraw?approval=<id>` (a delegate withdraws an
//! approval it sent),
//! and `POST /delegation/redeem?approval=<id>&class=<class>&target=<target>`:
//! the calling session redeems a single-use delegate approval, as its own
//! agent, right before it acts on it (`relay::delegation`). The answer is
//! `{"ok":true,"consumed":…}` or `{"ok":false,"reason":…}` with Cloud's
//! reason code (with `condition_unmet`, also `unmet`: the conditions that do
//! not hold yet; the approval is not consumed, so redeem again later), or
//! `unavailable` when Cloud cannot be asked (a gate-only install, no
//! sign-in, Cloud unreachable). A `prompt_approval` is never redeemed here:
//! Agent Relay applies it to the pending request itself.

use super::{Outbound, OutboundError};
use crate::relay::delegation::{is_approval_id, Action, CLASSES, MAX_TARGET, PROMPT_APPROVAL};
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use serde_json::Value;

/// The last value of `key` in `query`.
fn last<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// The approval id and action a redeem names, or why it is refused.
pub(super) fn redeem_query(query: &[(String, String)]) -> Result<(String, Action), OutboundError> {
    let invalid = |message: &str| OutboundError::new(400, "invalid_redeem", message);
    let approval = last(query, "approval")
        .filter(|id| is_approval_id(id))
        .ok_or_else(|| {
            invalid("Name the approval: ?approval=apv_… from the delegate approval line.")
        })?;
    let class = last(query, "class")
        .filter(|class| CLASSES.contains(class))
        .filter(|class| *class != PROMPT_APPROVAL)
        .ok_or_else(|| {
            invalid("Name the action's class: ?class= one of merge, pr_ops, deploy, release, secret_change, destructive, spend, external_comms. A prompt_approval is applied by Agent Relay itself.")
        })?;
    let target = last(query, "target")
        .map(str::trim)
        .filter(|target| {
            !target.is_empty()
                && target.chars().count() <= MAX_TARGET
                && !target.chars().any(char::is_control)
        })
        .ok_or_else(|| {
            invalid("Name the action's target: ?target= as the delegate approval line lists it.")
        })?;
    Ok((
        approval.to_string(),
        Action {
            class: class.to_string(),
            target: target.to_string(),
            conditions: Vec::new(),
            note: None,
        },
    ))
}

/// The `owner_approval` a send carries, as given: a JSON object in a JSON
/// body, or one JSON object as the `owner_approval` query value (the probe's
/// `send --owner-approval`). Never altered here; Relaycast validates it.
pub(super) fn requested_owner_approval(
    request: &serde_json::Map<String, Value>,
) -> Result<Option<serde_json::Map<String, Value>>, OutboundError> {
    let invalid = |message: String| OutboundError::new(400, "invalid_owner_approval", message);
    match request.get("owner_approval") {
        None => Ok(None),
        Some(Value::String(raw)) => crate::relay::delegation::owner_approval_json(raw)
            .map(Some)
            .map_err(invalid),
        Some(Value::Object(object)) => {
            let raw = serde_json::to_string(object).unwrap_or_default();
            crate::relay::delegation::owner_approval_json(&raw)
                .map(|_| Some(object.clone()))
                .map_err(invalid)
        }
        Some(_) => Err(invalid("owner_approval must be a JSON object.".into())),
    }
}

/// The session's identity among `received_by` (the agents an approval was
/// delivered to, across sessions): its registered agent, its current alias
/// or a replaced alias still held, with its token; when none of them is
/// this session's, the identity the session now sends as.
pub(super) fn identity(
    registration: Registration,
    token: Secret,
    received_by: &[String],
) -> (Registration, Secret) {
    let received = |id: &str| received_by.iter().any(|seen| seen == id);
    let current = registration.alias_credential();
    let matching = if received(&registration.agent_id) {
        Some((registration.clone(), token.clone()))
    } else {
        current
            .clone()
            .filter(|(alias, _)| received(&alias.agent_id))
            .or_else(|| {
                registration
                    .retired_credentials()
                    .find(|(retired, _)| received(&retired.agent_id))
            })
    };
    matching.or(current).unwrap_or((registration, token))
}

impl Outbound {
    /// `POST /delegation/withdraw?approval=<id>`: withdraws an approval the
    /// calling session's own agent sent as a delegate.
    pub async fn withdraw_delegation_route(
        &self,
        pid: i32,
        uid: u32,
        query: &[(String, String)],
    ) -> Result<Value, OutboundError> {
        let approval = last(query, "approval")
            .filter(|id| is_approval_id(id))
            .ok_or_else(|| {
                OutboundError::new(
                    400,
                    "invalid_withdraw",
                    "Name the approval: ?approval=apv_… that this session sent.",
                )
            })?
            .to_string();
        // As the identity the session sends with (`/send`): its current name.
        let (session, registration, token) = self.authorize_sender(pid, uid).await?;
        self.admit(&session.target.key())?;
        Ok(self
            .core
            .withdraw_delegation(&registration, &token, &approval)
            .await)
    }

    /// `POST /delegation/redeem`: redeems as the calling session's own agent.
    pub async fn redeem_delegation_route(
        &self,
        pid: i32,
        uid: u32,
        query: &[(String, String)],
    ) -> Result<Value, OutboundError> {
        let (approval, action) = redeem_query(query)?;
        let (session, registration, token) = self.authorize(pid, uid).await?;
        self.admit(&session.target.key())?;
        // As the identity the approval was delivered to: a renamed session
        // has its registered agent and its aliases, each with its own id.
        let received_by = self.core.delegation_recipients.of(&approval);
        let (registration, token) = identity(registration, token, &received_by);
        Ok(self
            .core
            .redeem_delegation(&registration, &token, &approval, &action)
            .await
            .to_value())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A renamed session redeems as the identity the approval was delivered
    /// to: its registered agent, its current alias or a replaced alias.
    #[test]
    fn a_renamed_session_redeems_as_the_identity_that_received_it() {
        let registration: Registration = serde_json::from_value(serde_json::json!({
            "name": "relay", "agentID": "agent_registered",
            "target": {"kind": "codex", "id": "thread"},
            "title": "relay", "baseURL": "https://api.relaycast.dev", "registeredAt": "now",
            "alias": {"name": "relay-new", "agentID": "agent_alias", "token": "at_alias",
                "registeredAt": "2026-11-23T00:00:00Z"},
            "retiredAliases": [{"alias": {"name": "relay-old", "agentID": "agent_retired",
                "token": "at_retired", "registeredAt": "2026-11-22T00:00:00Z"},
                "retiredAt": "2026-11-23T00:00:00Z"}]
        }))
        .unwrap();
        let token = Secret::new("at_registered");
        let pick = |ids: &[&str]| {
            let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            let (who, token) = identity(registration.clone(), token.clone(), &ids);
            (who.agent_id, token.expose().to_string())
        };
        assert_eq!(
            pick(&["agent_registered"]),
            ("agent_registered".into(), "at_registered".into())
        );
        assert_eq!(
            pick(&["agent_alias"]),
            ("agent_alias".into(), "at_alias".into())
        );
        assert_eq!(
            pick(&["agent_retired"]),
            ("agent_retired".into(), "at_retired".into())
        );
        // Another session's identity beside this one's: this one's.
        assert_eq!(
            pick(&["agent_other_session", "agent_registered"]),
            ("agent_registered".into(), "at_registered".into())
        );
        // Unknown or unseen: the name the session now sends as.
        assert_eq!(pick(&[]), ("agent_alias".into(), "at_alias".into()));
        assert_eq!(
            pick(&["agent_other"]),
            ("agent_alias".into(), "at_alias".into())
        );
    }

    #[test]
    fn recipients_are_remembered_by_approval() {
        let recipients = crate::relay::delegation::Recipients::default();
        assert!(recipients.of("apv_7Q2abcdEF").is_empty());
        // A channel approval reaches several sessions under one id: each is
        // kept, none overwrites another.
        recipients.remember("apv_7Q2abcdEF", "agent_registered");
        recipients.remember("apv_7Q2abcdEF", "agent_other_session");
        recipients.remember("apv_7Q2abcdEF", "agent_registered");
        assert_eq!(
            recipients.of("apv_7Q2abcdEF"),
            vec![
                "agent_other_session".to_string(),
                "agent_registered".to_string()
            ]
        );
    }

    fn query(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_redeem_names_an_approval_a_class_and_a_target() {
        let (approval, action) = redeem_query(&query(&[
            ("approval", "apv_7Q2abcdEF"),
            ("class", "release"),
            ("target", " @agent-relay/sdk "),
        ]))
        .unwrap();
        assert_eq!(approval, "apv_7Q2abcdEF");
        assert_eq!(action.class, "release");
        assert_eq!(action.target, "@agent-relay/sdk");
        for bad in [
            query(&[("class", "merge"), ("target", "a/b")]),
            query(&[
                ("approval", "apv_short"),
                ("class", "merge"),
                ("target", "a/b"),
            ]),
            query(&[
                ("approval", "grt_7Q2abcdEF"),
                ("class", "merge"),
                ("target", "a/b"),
            ]),
            query(&[
                ("approval", "apv_7Q2abcdEF"),
                ("class", "prompt_approval"),
                ("target", "a:b"),
            ]),
            query(&[
                ("approval", "apv_7Q2abcdEF"),
                ("class", "approve_all"),
                ("target", "a/b"),
            ]),
            query(&[("approval", "apv_7Q2abcdEF"), ("class", "merge")]),
            query(&[
                ("approval", "apv_7Q2abcdEF"),
                ("class", "merge"),
                ("target", "  "),
            ]),
            query(&[
                ("approval", "apv_7Q2abcdEF"),
                ("class", "merge"),
                ("target", "a\nb"),
            ]),
        ] {
            let error = redeem_query(&bad).unwrap_err();
            assert_eq!(error.code, "invalid_redeem", "{bad:?}");
            assert_eq!(error.status, 400);
        }
        let long = "x".repeat(MAX_TARGET + 1);
        assert!(redeem_query(&query(&[
            ("approval", "apv_7Q2abcdEF"),
            ("class", "merge"),
            ("target", &long)
        ]))
        .is_err());
    }
}
