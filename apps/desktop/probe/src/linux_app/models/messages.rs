//! What the composer says about a recipient and a message sent to it. The
//! message's state is what Relaycast holds for it (`roster.get` with its
//! id); the recipient's liveness is only a hint shown beside it.

use super::time::relative_ms;
use crate::relay::contract::directory::{Recipient, RecipientParams};
use crate::relay::delivery::DeliveryActivity;
use crate::relay::people::{Liveness, MessageState};

/// How a delivery note reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryTone {
    Delivered,
    Waiting,
    Failed,
    Unknown,
}

/// The note after a send. `recipient` is the latest lookup, for why a
/// message is queued.
pub fn delivery_note(
    state: Option<MessageState>,
    recipient: Option<&Recipient>,
) -> (&'static str, DeliveryTone) {
    match state {
        None => ("Sent — delivery unknown", DeliveryTone::Unknown),
        Some(MessageState::Queued) if offline(recipient) => {
            ("Queued — agent not running", DeliveryTone::Waiting)
        }
        Some(MessageState::Queued) => (
            "Queued — not yet handed to the agent",
            DeliveryTone::Waiting,
        ),
        Some(MessageState::Delivered) => ("Delivered", DeliveryTone::Delivered),
        Some(MessageState::PickedUp) => ("Picked up by the agent", DeliveryTone::Delivered),
        Some(MessageState::NoSuchAgent) => ("No such agent", DeliveryTone::Failed),
    }
}

fn offline(recipient: Option<&Recipient>) -> bool {
    recipient
        .and_then(|recipient| recipient.agent.as_ref())
        .is_some_and(|agent| agent.liveness == Liveness::Offline)
}

/// Whether a message to `recipient` would wait for an agent that is not
/// running.
pub fn queues(recipient: Option<&Recipient>) -> bool {
    recipient.is_some_and(|recipient| recipient.known) && offline(recipient)
}

/// The inline warning before a send. Nothing when the roster of the
/// workspace messages go to cannot be read.
pub fn recipient_warning(recipient: &Recipient) -> Option<String> {
    if !recipient.known {
        return None;
    }
    match &recipient.agent {
        None => Some("No agent has this name or address.".to_string()),
        Some(agent) if agent.liveness == Liveness::Offline => Some(format!(
            "@{} is not running right now. Queue anyway?",
            agent.name
        )),
        Some(_) => None,
    }
}

/// Whether a reply is expected, and when the recipient was last seen.
pub fn reply_note(recipient: &Recipient, now_ms: i64) -> Option<String> {
    if !recipient.known {
        return None;
    }
    let Some(agent) = &recipient.agent else {
        return Some("No such agent — no reply is expected.".to_string());
    };
    let seen = match agent.last_seen_ms.filter(|seen| *seen > 0) {
        Some(seen) => format!(", last seen {}", relative_ms(Some(seen), now_ms)),
        None => String::new(),
    };
    Some(match agent.liveness {
        Liveness::Live => format!("Running{seen} — a reply can come any time."),
        Liveness::Idle => format!("Idle{seen} — it replies when it picks the message up."),
        Liveness::Offline => format!("Not running{seen} — no reply until it runs again."),
    })
}

/// How a conversation is titled: an exact `agent@machine` as is, a name as
/// `@name`.
pub fn endpoint_label(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('@') || !value.contains('@') {
        format!("@{}", value.trim_start_matches('@'))
    } else {
        value.to_string()
    }
}

/// `roster.get`'s and `messages.send`'s recipient: an exact
/// `agent@machine` address, else a name.
pub fn recipient_params(raw: &str) -> RecipientParams {
    let value = raw.trim();
    let value = value.strip_prefix('@').unwrap_or(value).to_string();
    let (to, address) = if value.contains('@') {
        (None, Some(value))
    } else {
        (Some(value), None)
    };
    RecipientParams {
        to,
        address,
        message_id: None,
    }
}

/// A recent delivery's heading: `@bob → @api`.
pub fn activity_heading(entry: &DeliveryActivity) -> String {
    match &entry.sender {
        Some(sender) => format!("@{sender} → @{}", entry.agent),
        None => format!("Someone → @{}", entry.agent),
    }
}

/// A recent delivery's second line: why it ended as it did, else the
/// message's preview.
pub fn activity_body(entry: &DeliveryActivity) -> &str {
    entry.detail.as_deref().unwrap_or(&entry.preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recipient(known: bool, liveness: Option<&str>, last_seen_ms: Option<i64>) -> Recipient {
        let agent = liveness.map(|liveness| {
            json!({"name": "web", "kind": "agent", "where": "other_desktop", "status": "active",
                   "liveness": liveness, "last_seen_ms": last_seen_ms, "description": "", "is_self": false})
        });
        serde_json::from_value(json!({"known": known, "agent": agent, "message": null})).unwrap()
    }

    #[test]
    fn notes_name_what_relaycast_holds() {
        let offline = recipient(true, Some("offline"), None);
        let live = recipient(true, Some("live"), None);
        assert_eq!(
            delivery_note(Some(MessageState::Queued), Some(&offline)),
            ("Queued — agent not running", DeliveryTone::Waiting)
        );
        assert_eq!(
            delivery_note(Some(MessageState::Queued), Some(&live)),
            (
                "Queued — not yet handed to the agent",
                DeliveryTone::Waiting
            )
        );
        assert_eq!(
            delivery_note(Some(MessageState::Queued), None),
            (
                "Queued — not yet handed to the agent",
                DeliveryTone::Waiting
            )
        );
        assert_eq!(
            delivery_note(Some(MessageState::Delivered), Some(&offline)),
            ("Delivered", DeliveryTone::Delivered)
        );
        assert_eq!(
            delivery_note(Some(MessageState::PickedUp), Some(&live)),
            ("Picked up by the agent", DeliveryTone::Delivered)
        );
        assert_eq!(
            delivery_note(Some(MessageState::NoSuchAgent), None),
            ("No such agent", DeliveryTone::Failed)
        );
        // Liveness never stands in for a state Relaycast did not report.
        assert_eq!(
            delivery_note(None, Some(&live)),
            ("Sent — delivery unknown", DeliveryTone::Unknown)
        );
    }

    #[test]
    fn an_offline_recipient_queues_with_a_warning() {
        let offline = recipient(true, Some("offline"), None);
        assert!(queues(Some(&offline)));
        assert_eq!(
            recipient_warning(&offline).as_deref(),
            Some("@web is not running right now. Queue anyway?")
        );
        for liveness in ["live", "idle"] {
            let running = recipient(true, Some(liveness), None);
            assert!(!queues(Some(&running)));
            assert_eq!(recipient_warning(&running), None);
        }
        let missing = recipient(true, None, None);
        assert!(!queues(Some(&missing)));
        assert!(!queues(None));
        assert_eq!(
            recipient_warning(&missing).as_deref(),
            Some("No agent has this name or address.")
        );
    }

    #[test]
    fn another_workspaces_roster_says_nothing() {
        let unknown = recipient(false, None, None);
        assert!(!queues(Some(&unknown)));
        assert_eq!(recipient_warning(&unknown), None);
        assert_eq!(reply_note(&unknown, 0), None);
    }

    #[test]
    fn reply_notes_follow_liveness() {
        let now = 1_000_000_000;
        let seen = Some(now - 5 * 60_000);
        assert_eq!(
            reply_note(&recipient(true, Some("live"), seen), now).as_deref(),
            Some("Running, last seen 5 minutes ago — a reply can come any time.")
        );
        assert_eq!(
            reply_note(&recipient(true, Some("idle"), None), now).as_deref(),
            Some("Idle — it replies when it picks the message up.")
        );
        assert_eq!(
            reply_note(
                &recipient(true, Some("offline"), Some(now - 3_600_000)),
                now
            )
            .as_deref(),
            Some("Not running, last seen 1 hour ago — no reply until it runs again.")
        );
        assert_eq!(
            reply_note(&recipient(true, None, None), now).as_deref(),
            Some("No such agent — no reply is expected.")
        );
    }

    #[test]
    fn endpoint_labels_and_parameters() {
        assert_eq!(endpoint_label("alice"), "@alice");
        assert_eq!(endpoint_label("@alice"), "@alice");
        assert_eq!(endpoint_label(" alice@laptop "), "alice@laptop");
        let name = recipient_params("@web");
        assert_eq!((name.to.as_deref(), name.address), (Some("web"), None));
        let address = recipient_params(" web@desk ");
        assert_eq!(
            (address.to, address.address.as_deref()),
            (None, Some("web@desk"))
        );
    }

    #[test]
    fn recent_deliveries_name_sender_and_agent() {
        let entry = |sender: Option<&str>, detail: Option<&str>| -> DeliveryActivity {
            serde_json::from_value(json!({"at_ms": 0, "agent": "api", "sender": sender, "preview": "hello",
                                         "outcome": "failed", "detail": detail, "settlement": null}))
            .unwrap()
        };
        let failed = entry(Some("bob"), Some("gone"));
        assert_eq!(activity_heading(&failed), "@bob → @api");
        assert_eq!(activity_body(&failed), "gone");
        let delivered = entry(None, None);
        assert_eq!(activity_heading(&delivered), "Someone → @api");
        assert_eq!(activity_body(&delivered), "hello");
    }
}
