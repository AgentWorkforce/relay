//! Reading a conversation on Relaycast, after its history has been returned.
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
//! The read position does not depend on the queue: a delivery that expired,
//! or one that cannot be reached (below), would leave the conversation
//! unread. So reading a conversation's newest page also marks its newest
//! message read (`POST /v1/messages/{id}/read`), once per newest message.
//!
//! None of this holds up `messages.history`: the page is returned first and
//! the conversation is read in a task of its own, one at a time per identity
//! (reads made meanwhile wait their turn). The queue is listed in that task,
//! after the page was read, so a delivery that arrived while it was read is
//! among those acknowledged.
//!
//! Every call goes through the workspace's Relaycast pause: once a pause
//! starts, by one of these calls or anyone else's, the task stops sending,
//! waits the pause out and starts over, up to [`SETTLE_ATTEMPTS`] times.
//! What it did not acknowledge stays queued (not lost, only redriven) and
//! the conversation's next read acknowledges it.
//!
//! `GET /v1/deliveries` has neither a cursor nor a channel filter: it lists
//! your oldest pending deliveries, at most 200. Acked ones leave the list,
//! so after acknowledging some the list is read again, up to
//! [`QUEUE_PASSES`] times. A list of 200 that holds none of this
//! conversation's cannot be paged past without acknowledging (reading)
//! other conversations, so then this conversation's stay queued and are
//! redriven; the conversation is still read, by its read position.

use super::*;
use crate::relay::delivery::policy::Delivery;

/// The most deliveries one `GET /v1/deliveries` answers: Relaycast's cap.
pub(super) const QUEUE_PAGE: u32 = 200;
/// How many times one conversation's read lists the queue.
pub(super) const QUEUE_PASSES: usize = 20;
/// How many times one conversation's read starts over after a pause.
pub(super) const SETTLE_ATTEMPTS: usize = 3;
/// The longest one wait for a pause to end.
const LONGEST_WAIT: Duration = Duration::from_secs(600);

/// Relaycast's message ids are increasing integers in decimal.
fn id_order(id: &str) -> (usize, &str) {
    (id.len(), id)
}

/// A conversation's history page, returned, and still to be read on
/// Relaycast.
#[derive(Clone, Debug)]
pub(super) struct ConversationRead {
    pub identity: PersonIdentity,
    pub scope: WorkspaceScope,
    pub conversation: String,
    /// The ids of the messages on the page.
    pub on_page: HashSet<String>,
    /// Whether the page is the conversation's newest (read without `before`).
    pub latest: bool,
}

impl ConversationRead {
    fn newest(&self) -> Option<&String> {
        self.on_page
            .iter()
            .max_by(|a, b| id_order(a).cmp(&id_order(b)))
    }
}

/// Marks each settling task apart, across sign-outs.
static NEXT_WORKER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The identity a read is made as: one task at a time each.
fn settling_key(identity: &PersonIdentity) -> (String, String) {
    (identity.base_url.clone(), identity.name.clone())
}

/// Why a read stopped before it was done: the workspace's Relaycast pause,
/// and how long it has left.
struct Paused(Duration);

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

    /// Reads `read`'s conversation on Relaycast in a task of its own, after
    /// the ones already being read as the same identity.
    pub(super) fn settle_read(self: &Arc<Self>, read: ConversationRead) {
        if read.on_page.is_empty() {
            return;
        }
        let key = settling_key(&read.identity);
        // This task's own mark: sign-out forgets `settling` while a task
        // may still be running, and a task started after it for the same
        // identity must not have its queue drained or removed by this one.
        let worker = NEXT_WORKER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut state = self.messaging.lock().unwrap();
            if let Some((_, queued)) = state.settling.get_mut(&key) {
                let same = |r: &ConversationRead| {
                    r.conversation == read.conversation
                        && r.latest == read.latest
                        && r.newest() == read.newest()
                };
                if !queued.iter().any(same) {
                    queued.push(read);
                }
                return;
            }
            state.settling.insert(key.clone(), (worker, Vec::new()));
        }
        let core = self.clone();
        tokio::spawn(async move {
            let mut next = Some(read);
            while let Some(read) = next.take() {
                core.settle_with_retries(&read).await;
                let mut state = core.messaging.lock().unwrap();
                match state.settling.get_mut(&key) {
                    Some((owner, queued)) if *owner == worker && !queued.is_empty() => {
                        next = Some(queued.remove(0));
                    }
                    Some((owner, _)) if *owner == worker => {
                        state.settling.remove(&key);
                    }
                    // Forgotten (signed out), or another task's now.
                    _ => {}
                }
            }
        });
    }

    /// Waits until every conversation read has been settled.
    #[cfg(test)]
    pub(super) async fn reads_settled(&self) {
        for _ in 0..1_000 {
            if self.messaging.lock().unwrap().settling.is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("conversation reads did not settle");
    }

    async fn settle_with_retries(&self, read: &ConversationRead) {
        for _ in 0..SETTLE_ATTEMPTS {
            match self.acknowledge_conversation(read).await {
                Ok(_) => return,
                Err(Paused(wait)) => tokio::time::sleep(wait.min(LONGEST_WAIT)).await,
            }
        }
    }

    /// The workspace's pause, if one is running.
    fn read_paused(&self, read: &ConversationRead) -> Result<(), Paused> {
        match self.relaycast_backoff.pause_left(&read.scope) {
            Some(wait) => Err(Paused(wait)),
            None => Ok(()),
        }
    }

    /// Marks the newest message of `read`'s newest page read, and
    /// acknowledges the deliveries of its conversation, listing the queue
    /// now. Returns how many deliveries were acknowledged, or the pause
    /// that stopped it.
    async fn acknowledge_conversation(&self, read: &ConversationRead) -> Result<usize, Paused> {
        let identity = &read.identity;
        let scope = &read.scope;
        let Some(newest) = read.newest().cloned() else {
            return Ok(0);
        };
        self.read_paused(read)?;
        if read.latest {
            self.mark_newest_read(read, &newest).await?;
        }
        let Ok(http) = sdk_gaps::http(&identity.base_url, &identity.token) else {
            return Ok(0);
        };
        let channel = match self.message_detail(&http, identity, scope, &newest).await {
            Ok(detail) => text(&detail["channel_id"]),
            // A retired token reads nothing more: the next read, with the
            // identity's new token, acknowledges these.
            Err(error) if error.is_auth_rejection() => return Ok(0),
            Err(_) => {
                self.read_paused(read)?;
                None
            }
        };
        let ours = |delivery: &Delivery| match &channel {
            Some(channel) => {
                delivery.channel_id.as_ref() == Some(channel)
                    && id_order(&delivery.message_id) <= id_order(&newest)
            }
            None => read.on_page.contains(&delivery.message_id),
        };
        let mut tried: HashSet<String> = HashSet::new();
        let mut acknowledged = 0;
        for _ in 0..QUEUE_PASSES {
            let listed = client::deliveries_up_to(&identity.base_url, &identity.token, QUEUE_PAGE);
            let listed = match self.person_read(scope, listed).await {
                Ok(listed) => listed,
                Err(_) => {
                    self.read_paused(read)?;
                    break;
                }
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
                let ack = client::ack(&identity.base_url, &identity.token, &delivery.id);
                match self.person_read(scope, ack).await {
                    Ok(_) => acknowledged += 1,
                    Err(error) if error.is_auth_rejection() => return Ok(acknowledged),
                    Err(_) => self.read_paused(read)?,
                }
            }
            // A shorter list held every pending delivery.
            if !full {
                break;
            }
        }
        Ok(acknowledged)
    }

    /// Moves your read position in `read`'s conversation up to `newest`,
    /// unless it was already moved there.
    async fn mark_newest_read(&self, read: &ConversationRead, newest: &str) -> Result<(), Paused> {
        let identity = &read.identity;
        let key = (
            identity.base_url.clone(),
            identity.name.clone(),
            read.conversation.clone(),
        );
        if self
            .messaging
            .lock()
            .unwrap()
            .marked
            .get(&key)
            .map(String::as_str)
            == Some(newest)
        {
            return Ok(());
        }
        let marked = client::mark_read(&identity.base_url, &identity.token, newest);
        match self.person_read(&read.scope, marked).await {
            Ok(()) => {
                let mut state = self.messaging.lock().unwrap();
                if state.marked.len() >= DETAILS_KEPT {
                    state.marked.clear();
                }
                state.marked.insert(key, newest.to_string());
                Ok(())
            }
            // Not read now: the conversation's next read tries again.
            Err(_) => self.read_paused(read),
        }
    }
}
