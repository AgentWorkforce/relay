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
        let (session, registration, token) = self.authorize(pid, uid).await?;
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
