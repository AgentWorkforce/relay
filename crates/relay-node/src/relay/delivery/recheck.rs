//! Re-checking a kept message's framing against Relaycast.
//!
//! A kept message's framing is sealed with a key this core holds in memory
//! (`message_pointer`), so a message kept before the core restarted cannot be
//! proven from its file. `read` then asks Relaycast for the message, as the
//! session's own agent and only at the registration's own origin, and
//! recomputes the framing from the server's sender the way delivery does
//! (`Core::session_text`). Any failure or mismatch reads as a peer's.

use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::message_pointer::{self, Framing, Kept};
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use serde_json::Value;

/// How long a re-check waits for Relaycast before reading as a peer's.
const RECHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl Core {
    /// The framing Relaycast's copy of `kept` proves for `registration`
    /// (`message_pointer::rechecked`), or a peer's when the origin is not
    /// the registration's pinned one (`workspace::pinned_origin`), the read
    /// fails or times out, or anything disagrees.
    pub(crate) async fn recheck_kept_framing(
        &self,
        registration: &Registration,
        token: &Secret,
        kept: &Kept,
    ) -> Framing {
        let Some(origin) = crate::relay::workspace::pinned_origin(&registration.base_url) else {
            return Framing::Peer;
        };
        let Ok(http) = crate::relay::sdk_gaps::http(&origin, token) else {
            return Framing::Peer;
        };
        let read = crate::relay::sdk_gaps::message(&http, &kept.message_id);
        let Ok(Ok(server)) = tokio::time::timeout(RECHECK_TIMEOUT, read).await else {
            return Framing::Peer;
        };
        let Some(delivery) = delivery_of(kept, &server) else {
            return Framing::Peer;
        };
        let (framed, _, _) = self
            .session_text(registration, (&delivery, None), false, false)
            .await;
        message_pointer::rechecked(kept, &server, &framed)
    }
}

/// The delivery `server` (Relaycast's message) would have been, as the queue
/// reports one: a direct message unless it names a channel.
fn delivery_of(kept: &Kept, server: &Value) -> Option<Delivery> {
    let text = |key: &str| {
        server[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let channel_id = text("channel_id");
    let thread_id = text("thread_id");
    let reason = match (&channel_id, &thread_id) {
        (None, _) => "dm",
        (Some(_), Some(_)) => "thread-reply",
        (Some(_), None) => "mention",
    };
    Some(Delivery {
        id: kept.message_id.clone(),
        message_id: text("id")?,
        status: "delivered".into(),
        reason: Some(reason.into()),
        channel_id,
        sender: text("agent_name"),
        sender_id: text("agent_id"),
        sender_address: text("agent_address"),
        text: server["text"].as_str().map(str::to_string),
        thread_id,
        ..Delivery::default()
    })
}
