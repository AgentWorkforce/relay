//! Whether a Relay Connect participant's session can read what is sent to
//! it, as the local session and its sender each need to know it.
//!
//! Relaycast refuses a participant token's roster read ("Workspace key
//! required"), so presence comes from Cloud's participant-authenticated
//! roster. That roster is only true if a credential is used while its
//! session runs: every request with it refreshes the participant's
//! Relaycast presence.

use crate::relay::cloud_http;
use crate::relay::connect::{log_connect_failure, ConnectSession};
use crate::relay::daemon::Core;
use crate::relay::outbound::OutboundError;
use crate::relay::store::Target;
use crate::relay::workspace::Secret;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const CONNECT_ROSTER_TIMEOUT: Duration = Duration::from_secs(12);

/// One participant of Cloud's roster.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct RosterEntry {
    pub agent_name: String,
    #[serde(default)]
    pub role: Option<String>,
    /// Still registered in this Connect's workspace.
    #[serde(default)]
    pub available: bool,
    /// Relaycast has seen the participant's session within its liveness
    /// window.
    #[serde(default)]
    pub online: bool,
}

/// Reads Cloud's roster with the participant token. An error keeps Cloud's
/// status and code, so a refused token or a gone Connect is told apart from
/// an unreachable Cloud.
pub fn read_cloud_roster(
    url: &str,
    connect_id: &str,
    token: &Secret,
) -> Result<Vec<RosterEntry>, OutboundError> {
    let answer = cloud_http::send_blocking_with_headers(
        "GET",
        url,
        Some(token.expose()),
        &[],
        None,
        CONNECT_ROSTER_TIMEOUT,
    )
    .map_err(|error| {
        log_connect_failure("roster", connect_id, "connect_unreachable", error.cause());
        OutboundError::new(
            503,
            "connect_unreachable",
            "Relay Connect could not be reached.",
        )
    })?;
    if !answer.ok() {
        let code = answer.body["error"]["code"]
            .as_str()
            .unwrap_or("connect_roster_failed");
        return Err(OutboundError::new(
            answer.status,
            code,
            answer
                .message()
                .unwrap_or_else(|| "Relay Connect did not return its participants.".into()),
        ));
    }
    serde_json::from_value(answer.inner()["participants"].clone()).map_err(|_| {
        OutboundError::new(
            502,
            "invalid_roster_response",
            "Relay Connect returned an incomplete participant list.",
        )
    })
}

/// Whether `name` is online, or `None` while presence is unknown.
pub fn recipient_online(roster: Option<&[RosterEntry]>, name: &str) -> Option<bool> {
    roster.map(|roster| {
        roster
            .iter()
            .any(|entry| entry.available && entry.agent_name == name && entry.online)
    })
}

/// One receipt of `/connect/send`: Relaycast accepting a message proves only
/// that it is queued, so the receipt says whether anyone is there to read it.
pub fn send_receipt(name: &str, message_id: Option<&str>, online: Option<bool>) -> Value {
    let delivery = match online {
        Some(true) => "sent",
        Some(false) => "queued_recipient_offline",
        None => "presence_unknown",
    };
    json!({
        "to": name,
        "message_id": message_id,
        "recipient_online": online,
        "delivery": delivery,
    })
}

/// The notice a sender's agent passes to its human when recipients are away.
pub fn offline_warning(names: &[&str]) -> Option<String> {
    let (first, rest) = names.split_first()?;
    let (who, verb, whose) = if rest.is_empty() {
        (first.to_string(), "is", "its")
    } else {
        (names.join(", "), "are", "their")
    };
    Some(format!(
        "{who} {verb} offline: Relay has not seen {whose} session in the last few minutes. \
         Your message is queued and has not been seen. Relay holds an undelivered Connect \
         message for about an hour; tell your human, and do not wait on a reply that may not come."
    ))
}

/// What a broadcast that failed part-way already did. An exact retry with the
/// same request key reconciles these recipients instead of duplicating them.
pub fn partial_send_note(sent: &[Value]) -> String {
    let named = |offline: bool| -> Vec<&str> {
        sent.iter()
            .filter(|receipt| (receipt["recipient_online"] == false) == offline)
            .filter_map(|receipt| receipt["to"].as_str())
            .collect()
    };
    let (delivered, queued) = (named(false), named(true));
    let mut note = Vec::new();
    if !delivered.is_empty() {
        note.push(format!(
            "Already delivered to: {}. An exact retry with the same Idempotency-Key will not duplicate them.",
            delivered.join(", ")
        ));
    }
    if !queued.is_empty() {
        note.push(format!(
            "Queued for {}, but not delivered. An exact retry with the same Idempotency-Key will not duplicate them either.",
            queued.join(", ")
        ));
        note.extend(offline_warning(&queued));
    }
    note.join(" ")
}

impl Core {
    /// Whether a Connect credential's session can take a message now. A
    /// session the latest discovery pass did not find running is reachable
    /// only while a fleet worker owns it (discovery leaves those out); when
    /// that ownership cannot be read, or before the first pass, the
    /// credential keeps being used as before.
    pub(crate) async fn connect_target_reachable(&self, target: &Target) -> bool {
        if self.connect.lock().unwrap().discovered_live(target) != Some(false) {
            return true;
        }
        let sessions = self.plugins.sessions.clone();
        let target = target.clone();
        tokio::task::spawn_blocking(move || sessions.fleet_owned(&target))
            .await
            .map_or(true, |owned| owned.unwrap_or(true))
    }

    pub(crate) async fn connect_cloud_roster(
        &self,
        session: &ConnectSession,
    ) -> Result<Vec<RosterEntry>, OutboundError> {
        let client = self.plugins.connect_cloud.clone();
        let connect_id = session.connect_id.clone();
        let token = session.token.clone();
        tokio::task::spawn_blocking(move || client.roster(&connect_id, &token))
            .await
            .unwrap_or_else(|_| {
                Err(crate::relay::connect::connect_internal_error(
                    "roster",
                    &session.connect_id,
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, available: bool, online: bool) -> RosterEntry {
        RosterEntry {
            agent_name: name.into(),
            role: Some("host".into()),
            available,
            online,
        }
    }

    #[test]
    fn a_receipt_names_a_queued_message_to_an_offline_recipient() {
        let roster = [entry("host", true, false), entry("gone", false, true)];
        assert_eq!(recipient_online(Some(&roster), "host"), Some(false));
        assert_eq!(recipient_online(Some(&roster), "gone"), Some(false));
        assert_eq!(recipient_online(None, "host"), None);
        assert_eq!(
            send_receipt("host", Some("m1"), Some(false)),
            json!({"to": "host", "message_id": "m1", "recipient_online": false,
                   "delivery": "queued_recipient_offline"})
        );
        assert_eq!(
            send_receipt("host", Some("m1"), Some(true))["delivery"],
            "sent"
        );
        assert_eq!(
            send_receipt("host", Some("m1"), None)["delivery"],
            "presence_unknown"
        );
        assert!(send_receipt("host", Some("m1"), None)["recipient_online"].is_null());
    }

    #[test]
    fn a_partial_broadcast_does_not_call_a_queued_message_delivered() {
        let sent = [
            send_receipt("host", Some("m1"), Some(false)),
            send_receipt("guest", Some("m2"), Some(true)),
            send_receipt("other", Some("m3"), None),
        ];
        let note = partial_send_note(&sent);
        assert!(note.starts_with(
            "Already delivered to: guest, other. An exact retry with the same Idempotency-Key will not duplicate them. \
             Queued for host, but not delivered. An exact retry with the same Idempotency-Key will not duplicate them either. \
             host is offline:"
        ));
        assert!(!partial_send_note(&sent[1..]).contains("Queued"));
    }

    #[test]
    fn the_offline_warning_names_every_absent_recipient() {
        assert_eq!(offline_warning(&[]), None);
        assert!(offline_warning(&["host"])
            .unwrap()
            .starts_with("host is offline: Relay has not seen its session"));
        assert!(offline_warning(&["host", "guest"])
            .unwrap()
            .starts_with("host, guest are offline: Relay has not seen their session"));
    }
}
