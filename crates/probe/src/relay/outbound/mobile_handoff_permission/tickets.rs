//! Bounded idempotent approval tickets outlive individual native HTTP polls.
use super::{denied, Binding, OutboundError, Permission, Runtime, Value, WAIT};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::time::Instant;

const CAPACITY: usize = 256;
type Key = (String, String, i32, u64, String);

#[derive(Default)]
pub(in crate::relay::outbound) struct Tickets {
    entries: Arc<Mutex<HashMap<Key, Arc<Ticket>>>>,
}

pub(super) struct Ticket {
    pub token: String,
    tool: String,
    pub input: Value,
    deadline: Instant,
    pub state: tokio::sync::Mutex<TicketState>,
}

pub(super) struct TicketState {
    pub permission: Option<Permission>,
    pub result: Option<Value>,
    pub retry: NoticeRetry,
}

impl TicketState {
    pub fn finish(&mut self, result: Value) -> Value {
        self.permission.take();
        self.result = Some(result.clone());
        result
    }
}

impl Ticket {
    pub fn expired(&self, now: Instant) -> bool {
        now >= self.deadline
    }
}

impl Tickets {
    pub(super) fn open(
        &self,
        binding: &Binding,
        runtime: &Runtime,
        request: &str,
        token: &str,
        tool: &str,
        input: &Value,
        create: impl FnOnce() -> Result<Permission, OutboundError>,
        current: impl Fn() -> bool + Send + 'static,
    ) -> Result<Arc<Ticket>, OutboundError> {
        let key = (
            binding.scope.clone(),
            binding.owner.clone(),
            runtime.pid,
            runtime.start,
            request.into(),
        );
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(ticket) = entries.get(&key) {
            if ticket.token != token || ticket.tool != tool || ticket.input != *input {
                return Err(OutboundError::new(
                    409,
                    "mobile_permission_mismatch",
                    "An existing request ID must retain its exact permission input.",
                ));
            }
            return Ok(ticket.clone());
        }
        if entries.len() >= CAPACITY {
            return Err(OutboundError::new(
                429,
                "mobile_permissions_full",
                "Too many pending mobile permission requests.",
            ));
        }
        let now = Instant::now();
        let ticket = Arc::new(Ticket {
            token: token.into(),
            tool: tool.into(),
            input: input.clone(),
            deadline: now + WAIT,
            state: tokio::sync::Mutex::new(TicketState {
                permission: Some(create()?),
                result: None,
                retry: NoticeRetry::new(now),
            }),
        });
        entries.insert(key.clone(), ticket.clone());
        let cache = Arc::downgrade(&self.entries);
        let expiring = Arc::downgrade(&ticket);
        tokio::spawn(async move {
            // Lifecycle pruning revokes the generation when its exact native
            // process exits. Cancel even if no HTTP poll reconnects.
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let Some(ticket) = expiring.upgrade() else {
                    return;
                };
                if ticket.expired(Instant::now()) || !current() {
                    ticket.state.lock().await.finish(denied());
                    let remaining = ticket.deadline.saturating_duration_since(Instant::now());
                    drop(ticket);
                    tokio::time::sleep(remaining).await;
                    break;
                }
            }
            if let Some(cache) = cache.upgrade() {
                cache
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&key);
            }
        });
        Ok(ticket)
    }
}

pub(super) struct NoticeRetry {
    next: Instant,
    delay: Duration,
}

impl NoticeRetry {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            next: now,
            delay: Duration::from_secs(5),
        }
    }

    pub(super) fn due(&self, now: Instant) -> bool {
        now >= self.next
    }

    pub(super) fn attempted(&mut self, now: Instant) {
        self.next = now + self.delay;
        self.delay = (self.delay * 2).min(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests;
