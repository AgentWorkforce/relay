//! What is unread for you, and marking it read, with Relaycast's own read
//! state: the position every device you read on moves.
//!
//! ```text
//! GET  /v1/inbox                (as you) ─▶ unread_dms, unread_channels
//! POST /v1/messages/{id}/read   (as you) ─▶ receipt; read position moves up
//! ```
//!
//! A DM's `unread_count` counts only the other side's messages after your
//! read position. (`/v1/dm/conversations`' `unread_count` counts every
//! message, so it is not used for this.) Marking a message read also acks
//! its delivery and fans `message.read` out to the conversation, your own
//! identity included: that `deliver` frame on your push socket wakes you
//! ([`Core::wake`]) like a reply does, so a read on another device (the iOS
//! app, the dashboard) raises the `messages` invalidation here and clients
//! read the inbox again. Relaycast sends it best effort, only while the
//! socket is up; a socket coming back up raises the invalidation too.

use super::*;
use crate::relay::contract::directory::{
    InboxMessage, MessageInbox, UnreadChannel, UnreadConversation,
};
use crate::relay::contract::Done;

/// A count Relaycast sends as a number, or as a numeric string.
fn count(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

/// `GET /v1/inbox`'s answer for `me`, read leniently: an entry without an
/// id or a count is left out.
pub fn read_inbox(inbox: &Value, me: &str) -> MessageInbox {
    let unread = inbox["unread_dms"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|dm| {
            let unread_count = count(&dm["unread_count"]).filter(|n| *n > 0)?;
            let last = &dm["last_message"];
            Some(UnreadConversation {
                conversation_id: text(&dm["conversation_id"])?,
                peer: text(&dm["from"]).unwrap_or_else(|| "unknown".into()),
                unread_count,
                last_message: text(&last["id"]).map(|id| InboxMessage {
                    id,
                    text: last["text"].as_str().unwrap_or_default().to_string(),
                    created_at: text(&last["created_at"]),
                }),
            })
        })
        .collect();
    let unread_channels = inbox["unread_channels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|channel| {
            Some(UnreadChannel {
                channel: text(&channel["channel_name"])?,
                unread_count: count(&channel["unread_count"]).filter(|n| *n > 0)?,
            })
        })
        .collect();
    MessageInbox {
        identity: me.to_string(),
        unread,
        unread_channels,
    }
}

fn message_not_found() -> RpcError {
    RpcError::new(
        ErrorKind::NotFound,
        "That message is not in any of your conversations.",
    )
}

impl Core {
    /// What Relaycast counts as unread for you.
    pub async fn inbox(&self) -> Result<MessageInbox, RpcError> {
        let identity = self.person_identity(false).await?;
        let scope = self.person_scope(&identity);
        self.person_read_allowed(&scope)?;
        let read = |identity: PersonIdentity| async move {
            let http = sdk_gaps::http(&identity.base_url, &identity.token)?;
            let scope = self.person_scope(&identity);
            self.person_read(&scope, sdk_gaps::inbox(&http)).await
        };
        let (identity, inbox) = match read(identity.clone()).await {
            Err(error) if error.is_auth_rejection() => {
                let fresh = self.person_identity_refused(&identity.token).await?;
                (fresh.clone(), read(fresh).await)
            }
            other => (identity, other),
        };
        let inbox = inbox.map_err(|e| self.person_error(&scope, &e))?;
        Ok(read_inbox(&inbox, &identity.name))
    }

    /// Marks `message_id` and everything before it in its conversation read
    /// for you, on every device. Paced like a read: refused while the
    /// workspace's Relaycast pause lasts.
    pub async fn mark_read(&self, message_id: &str) -> Result<Done, RpcError> {
        let message_id = message_id.trim();
        if message_id.is_empty() {
            return Err(RpcError::invalid_params("Name the message to mark read."));
        }
        let identity = self.person_identity(false).await?;
        let scope = self.person_scope(&identity);
        self.person_read_allowed(&scope)?;
        let mark = |identity: PersonIdentity| async move {
            let scope = self.person_scope(&identity);
            let marked = client::mark_read(&identity.base_url, &identity.token, message_id);
            self.person_read(&scope, marked).await
        };
        let marked = match mark(identity.clone()).await {
            Err(error) if error.is_auth_rejection() => {
                let fresh = self.person_identity_refused(&identity.token).await?;
                mark(fresh).await
            }
            other => other,
        };
        match marked {
            Ok(()) => {
                // Every client on this computer reads the inbox again now,
                // without waiting for Relaycast's `message.read` echo.
                self.hub.invalidated(Listing::Messages);
                Ok(Done {})
            }
            Err(error) if error.is_not_found() => Err(message_not_found()),
            Err(error) => Err(self.person_error(&scope, &error)),
        }
    }
}
