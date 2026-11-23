//! Acknowledging your queued deliveries one conversation at a time.
//!
//! On Relaycast acking a delivery is also reading it: the ack writes a read
//! receipt and moves your read position in its channel, which is what
//! `GET /v1/inbox` counts unread from, on every device. So reading one
//! conversation acknowledges only that conversation's deliveries: those in
//! its channel up to the newest message on the page read. The channel is
//! what `GET /v1/messages/{id}` names for that newest message (DM history
//! and the conversation list do not name it); when it cannot be read, only
//! the deliveries of messages on the page are acknowledged. A message that
//! arrived after the page was read stays queued.
//!
//! `GET /v1/deliveries` has neither a cursor nor a channel filter: it lists
//! your oldest pending deliveries, at most 200. Acked ones leave the list,
//! so after acknowledging some the list is read again, up to
//! [`QUEUE_PASSES`] times. A list of 200 that holds none of this
//! conversation's cannot be paged past without acknowledging (reading)
//! other conversations, so then this conversation's stay queued: they are
//! not lost and not read, only redriven, and `messages.mark_read` reads
//! the conversation whatever its queue holds.

use super::*;
use crate::relay::delivery::policy::Delivery;
use crate::relay::diagnostic_http::HttpClient;

/// The most deliveries one `GET /v1/deliveries` answers: Relaycast's cap.
pub(super) const QUEUE_PAGE: u32 = 200;
/// How many times one conversation's read lists the queue.
pub(super) const QUEUE_PASSES: usize = 20;

/// Relaycast's message ids are increasing integers in decimal.
fn id_order(id: &str) -> (usize, &str) {
    (id.len(), id)
}

impl Core {
    /// Your oldest pending deliveries; `None` when they cannot be read.
    pub(super) async fn person_deliveries(
        &self,
        identity: &PersonIdentity,
        scope: &WorkspaceScope,
    ) -> Option<Vec<Delivery>> {
        let pending = client::deliveries_up_to(&identity.base_url, &identity.token, QUEUE_PAGE);
        self.person_read(scope, pending).await.ok()
    }

    /// Whether `pending` holds a delivery no history read saw before.
    pub(super) fn new_person_deliveries(&self, pending: &[Delivery]) -> bool {
        let mut state = self.messaging.lock().unwrap();
        if state.seen_deliveries.len() >= DETAILS_KEPT {
            state.seen_deliveries.clear();
        }
        let mut new = false;
        for delivery in pending {
            new |= state.seen_deliveries.insert(delivery.id.clone());
        }
        new
    }

    /// Acknowledges the deliveries of the conversation `page` was read from,
    /// starting with `pending`, the queue as it was listed before the read.
    /// Returns how many.
    pub(super) async fn acknowledge_conversation(
        &self,
        http: &HttpClient,
        identity: &PersonIdentity,
        scope: &WorkspaceScope,
        page: &[Value],
        pending: Option<Vec<Delivery>>,
    ) -> usize {
        // Nothing queued: nothing to look up.
        if pending.as_ref().is_some_and(Vec::is_empty) {
            return 0;
        }
        let on_page: HashSet<String> = page.iter().filter_map(|m| text(&m["id"])).collect();
        let Some(newest) = on_page
            .iter()
            .max_by(|a, b| id_order(a).cmp(&id_order(b)))
            .cloned()
        else {
            return 0;
        };
        let channel = self
            .message_detail(http, identity, scope, &newest)
            .await
            .ok()
            .and_then(|detail| text(&detail["channel_id"]));
        let ours = |delivery: &Delivery| match &channel {
            Some(channel) => {
                delivery.channel_id.as_ref() == Some(channel)
                    && id_order(&delivery.message_id) <= id_order(&newest)
            }
            None => on_page.contains(&delivery.message_id),
        };
        let mut tried: HashSet<String> = HashSet::new();
        let mut acknowledged = 0;
        let mut pending = pending;
        for _ in 0..QUEUE_PASSES {
            let listed = match pending.take() {
                Some(listed) => listed,
                None => match self.person_deliveries(identity, scope).await {
                    Some(listed) => listed,
                    None => break,
                },
            };
            let full = listed.len() >= QUEUE_PAGE as usize;
            let due: Vec<&Delivery> = listed
                .iter()
                .filter(|d| !tried.contains(&d.id) && ours(d))
                .collect();
            if due.is_empty() {
                break;
            }
            for delivery in due {
                tried.insert(delivery.id.clone());
                if client::ack(&identity.base_url, &identity.token, &delivery.id)
                    .await
                    .is_ok()
                {
                    acknowledged += 1;
                }
            }
            // A shorter list held every pending delivery.
            if !full {
                break;
            }
        }
        acknowledged
    }
}
