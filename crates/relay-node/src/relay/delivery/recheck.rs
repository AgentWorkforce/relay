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
use crate::relay::message_pointer::{self, Kept};
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use serde_json::Value;

/// How long a re-check waits for Relaycast before reading as a peer's.
const RECHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl Core {
    /// The message Relaycast's copy of `kept` proves for `registration`,
    /// rebuilt from the server's copy (`message_pointer::rechecked`): its
    /// text and framing are the server's, never the file's. `None` when the
    /// origin is not the registration's pinned one
    /// (`workspace::pinned_origin`), the read fails or times out, or the
    /// server's message is another one.
    pub(crate) async fn recheck_kept_framing(
        &self,
        registration: &Registration,
        token: &Secret,
        kept: &Kept,
    ) -> Option<message_pointer::Rechecked> {
        self.recheck_within(RECHECK_TIMEOUT, registration, token, kept)
            .await
    }

    /// [`Self::recheck_kept_framing`] with the whole re-check (the read and
    /// the rebuild, whose sender checks may ask Relaycast again) under one
    /// `limit`, so `read` answers a peer's framing in time.
    pub(crate) async fn recheck_within(
        &self,
        limit: std::time::Duration,
        registration: &Registration,
        token: &Secret,
        kept: &Kept,
    ) -> Option<message_pointer::Rechecked> {
        let recheck = async {
            let origin = crate::relay::workspace::pinned_origin(&registration.base_url)?;
            let http = crate::relay::sdk_gaps::http(&origin, token).ok()?;
            let server = crate::relay::sdk_gaps::message(&http, &kept.message_id)
                .await
                .ok()?;
            let mut delivery = delivery_of(kept, &server)?;
            // Relaycast's single-message read carries no `has_owner_approval`.
            // While the delivery is still pending, its by-message proof does
            // (`owner_approval`); once it is acknowledged it reads 404, and a
            // delegate's message then reads as a peer's.
            if !delivery.has_owner_approval {
                delivery.has_owner_approval =
                    crate::relay::sdk_gaps::delivery_by_message(&http, &kept.message_id)
                        .await
                        .is_ok_and(|proof| proof["owner_approval"].is_object());
            }
            // The files it carried come back with the commands that fetch
            // them, as a delivery whose files were not saved in time shows
            // them.
            self.add_fetch_hints(&registration.target, &mut delivery.attachments)
                .await;
            let (framed, _, source) = self
                .session_text(registration, (&delivery, None), false, false)
                .await;
            // A delegate's approval is attested again by Agent Relay Cloud,
            // for the same sources as at delivery (`Core::with_delegation`);
            // without that there is no delegate line, and the message reads
            // as a peer's.
            let framed = match source {
                crate::relay::delivery::session_text::InputSource::Owner => framed,
                _ => {
                    self.with_delegation(registration, &delivery, token, framed)
                        .await
                }
            };
            message_pointer::rechecked(kept, &server, framed)
        };
        tokio::time::timeout(limit, recheck).await.ok().flatten()
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
    // A one-to-one DM keeps DM semantics whether or not Relaycast names its
    // `dmch_` channel, as the queue reports it (`spawn::drive::direct_from`).
    let dm_channel = channel_id.as_deref().is_some_and(|channel| {
        channel.starts_with(crate::relay::spawn::drive::ONE_TO_ONE_DM_CHANNEL)
    });
    let reason = match (&channel_id, &thread_id) {
        (None, _) => "dm",
        (Some(_), Some(_)) => "thread-reply",
        (Some(_), None) if dm_channel => "dm",
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
        attachments: crate::relay::delivery::policy::Attachment::list(&[server]),
        has_owner_approval: server["has_owner_approval"].as_bool() == Some(true),
        ..Delivery::default()
    })
}
