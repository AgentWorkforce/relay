//! Obligation lifecycle and boomerang for relay#1474.
//!
//! ## Design
//!
//! A message whose body contains `OBLIGATION_MARKER` registers an
//! [`ObligationRecord`] keyed on the message ID.  The record tracks:
//! - which agent sent the message (the *author*)
//! - which agent received it (the *recipient*)
//! - when the next boomerang return should fire
//!
//! **Clearing rule (load-bearing):** only the author can discharge an
//! obligation, by reacting with `✅` (`DONE_EMOJI`) on their own message.
//! A recipient `✅` reaction does NOT discharge — the broker checks
//! `reactor == author` before clearing the flag.
//!
//! **Boomerang delivery:** the maintenance tick drains obligations whose
//! `next_fire_at` has passed, then re-injects a knock message into the
//! recipient worker.  The injected body carries `RETURN_MARKER` and the
//! original message ID so the conformance fixture can detect it.
//!
//! **Toggle:** `RELAY_OBLIGATION_BOOMERANG` — any value other than `"0"`
//! (and the absent case) enables the feature.  Set to `"0"` to suppress all
//! boomerang behaviour.  The env var is re-read on every call so the test
//! control arm can set it before spawning the broker process.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

// ── Public constants ──────────────────────────────────────────────────────────

/// Embedded in the message body of an obligating DM by the sender.
pub const OBLIGATION_MARKER: &str = "@@c2a-obligation@@";

/// Embedded in the body of every boomerang re-injection so the conformance
/// fixture's `waitForReturn` can detect it.
pub const RETURN_MARKER: &str = "@@c2a-obligation-return@@";

/// The emoji that, when reacted by the *author*, discharges the obligation.
pub const DONE_EMOJI: &str = "✅";

/// Env var that gates the whole feature.  Any value other than `"0"` (and
/// absence) enables it.
pub const BOOMERANG_FLAG: &str = "RELAY_OBLIGATION_BOOMERANG";

/// Env var that sets the flat boomerang return interval in milliseconds.
/// Defaults to 500 ms when absent or unparseable.
pub const INTERVAL_FLAG: &str = "RELAY_OBLIGATION_INTERVAL_MS";

// ── Feature gate ─────────────────────────────────────────────────────────────

/// Returns `true` when `RELAY_OBLIGATION_BOOMERANG` is unset or any value
/// other than `"0"`.
pub fn boomerang_enabled() -> bool {
    std::env::var(BOOMERANG_FLAG)
        .map(|v| v.trim() != "0")
        .unwrap_or(true)
}

/// Returns the configured return interval.  Re-read each call so a test that
/// sets the env var after process start (unlikely but possible via
/// `harness.env`) picks it up.
pub fn interval_ms() -> u64 {
    std::env::var(INTERVAL_FLAG)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(500)
}

// ── Record ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct ObligationRecord {
    /// Message ID of the obligating message (also the store key).
    pub message_id: String,
    /// Agent name of the sender — the only party who can discharge.
    pub author: String,
    /// Agent name of the recipient — where boomerang returns are injected.
    pub recipient: String,
    /// When the obligation was first registered (for GC).
    pub registered_at: Instant,
    /// When the next boomerang return should fire.
    pub next_fire_at: Instant,
    /// How many returns have been injected so far.
    pub fire_count: u32,
    /// `true` once the author reacts ✅.
    pub discharged: bool,
    /// `true` once the obligation has fired the maximum number of times (3).
    /// Exhausted obligations are not drained again.
    pub exhausted: bool,
}

// ── Store ─────────────────────────────────────────────────────────────────────

/// In-memory store of outstanding obligation records.  Lives on
/// [`crate::runtime::event_loop::BrokerRuntime`] and is swept by the
/// 500 ms maintenance tick.
#[derive(Debug, Default)]
pub(crate) struct ObligationStore {
    records: HashMap<String, ObligationRecord>,
}

impl ObligationStore {
    /// Register a new obligation.  Idempotent: registering the same message ID
    /// twice is a no-op (the first registration wins).
    pub fn register(
        &mut self,
        message_id: String,
        author: String,
        recipient: String,
        interval: Duration,
    ) {
        if self.records.contains_key(&message_id) {
            return;
        }
        let now = Instant::now();
        self.records.insert(
            message_id.clone(),
            ObligationRecord {
                message_id,
                author,
                recipient,
                registered_at: now,
                next_fire_at: now + interval,
                fire_count: 0,
                discharged: false,
                exhausted: false,
            },
        );
    }

    /// Attempt to discharge the obligation identified by `message_id`.
    ///
    /// The discharge succeeds only when `reactor` is the obligation's author.
    /// Returns `true` when the record was found and marked discharged.
    pub fn try_discharge(&mut self, message_id: &str, reactor: &str) -> bool {
        if let Some(record) = self.records.get_mut(message_id) {
            if !record.discharged && !record.exhausted && record.author == reactor {
                record.discharged = true;
                return true;
            }
        }
        false
    }

    /// Collect all obligations that are due for a boomerang return, advance
    /// their `next_fire_at` by `interval`, and return the
    /// `(message_id, recipient)` pairs to inject.
    ///
    /// Discharged obligations are silently skipped.
    pub fn drain_due(&mut self, now: Instant, interval: Duration) -> Vec<(String, String)> {
        let mut due = Vec::new();
        for record in self.records.values_mut() {
            if record.discharged || record.exhausted || record.next_fire_at > now {
                continue;
            }
            due.push((record.message_id.clone(), record.recipient.clone()));
            record.fire_count += 1;
            if record.fire_count >= 3 {
                record.exhausted = true;
                tracing::warn!(
                    message_id = %record.message_id,
                    recipient = %record.recipient,
                    "obligation exhausted after max fires; no more boomerang returns will be sent"
                );
            } else {
                record.next_fire_at = now + interval;
            }
        }
        due
    }

    /// Remove discharged records older than one hour to bound memory growth.
    pub fn gc(&mut self, now: Instant) {
        const MAX_DISCHARGED_AGE: Duration = Duration::from_secs(3600);
        self.records.retain(|_, r| {
            (!r.discharged && !r.exhausted)
                || now.duration_since(r.registered_at) < MAX_DISCHARGED_AGE
        });
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Returns `true` when the message body contains the obligation marker.
#[inline]
pub fn is_obligating(body: &str) -> bool {
    body.contains(OBLIGATION_MARKER)
}

/// Build the boomerang knock body that is injected at the recipient.
///
/// The body must contain both `RETURN_MARKER` and `original_message_id` so
/// `waitForReturn` in the conformance fixture can detect it.
pub fn build_return_body(original_message_id: &str) -> String {
    format!(
        "{RETURN_MARKER}{original_message_id}\n\
         Your attention is still required. \
         Obligating message id: {original_message_id}"
    )
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn store_with_obligation(interval: Duration) -> (ObligationStore, Instant) {
        let mut store = ObligationStore::default();
        let now = Instant::now();
        store.register("msg-1".into(), "alice".into(), "bob".into(), interval);
        (store, now)
    }

    #[test]
    fn register_idempotent() {
        let mut store = ObligationStore::default();
        let interval = Duration::from_secs(5);
        store.register("msg-1".into(), "alice".into(), "bob".into(), interval);
        store.register("msg-1".into(), "alice2".into(), "bob2".into(), interval);
        // Second registration must not overwrite the first.
        assert_eq!(store.records["msg-1"].author, "alice");
    }

    #[test]
    fn author_discharges_obligation() {
        let interval = Duration::from_secs(5);
        let (mut store, _now) = store_with_obligation(interval);
        assert!(store.try_discharge("msg-1", "alice"));
        assert!(store.records["msg-1"].discharged);
    }

    #[test]
    fn recipient_cannot_discharge() {
        let interval = Duration::from_secs(5);
        let (mut store, _now) = store_with_obligation(interval);
        // "bob" is the recipient, not the author.
        assert!(!store.try_discharge("msg-1", "bob"));
        assert!(!store.records["msg-1"].discharged);
    }

    #[test]
    fn unknown_message_id_discharge_is_noop() {
        let interval = Duration::from_secs(5);
        let (mut store, _now) = store_with_obligation(interval);
        assert!(!store.try_discharge("nonexistent", "alice"));
    }

    #[test]
    fn drain_due_fires_at_interval() {
        let interval = Duration::from_millis(100);
        let (mut store, _now) = store_with_obligation(interval);
        // Nothing due immediately.
        let due = store.drain_due(Instant::now(), interval);
        assert!(due.is_empty());
        // Past interval: now due.
        let future = Instant::now() + interval + Duration::from_millis(50);
        let due = store.drain_due(future, interval);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, "msg-1");
        assert_eq!(due[0].1, "bob");
        // Same instant: not due again (next_fire_at advanced).
        let due2 = store.drain_due(future, interval);
        assert!(due2.is_empty());
    }

    #[test]
    fn discharged_obligation_not_drained() {
        let interval = Duration::from_millis(100);
        let (mut store, _now) = store_with_obligation(interval);
        store.try_discharge("msg-1", "alice");
        let future = Instant::now() + interval + Duration::from_millis(50);
        let due = store.drain_due(future, interval);
        assert!(due.is_empty());
    }

    #[test]
    fn build_return_body_contains_markers() {
        let body = build_return_body("msg-99");
        assert!(body.contains(RETURN_MARKER));
        assert!(body.contains("msg-99"));
    }

    #[test]
    fn is_obligating_detects_marker() {
        assert!(is_obligating("hello\n@@c2a-obligation@@{}"));
        assert!(!is_obligating("plain message"));
    }

    #[test]
    fn obligation_exhausts_after_max_fires() {
        let interval = Duration::from_millis(100);
        let (mut store, _now) = store_with_obligation(interval);
        // Fire 3 times; after the 3rd fire the obligation must be exhausted.
        for i in 0..3u32 {
            let t =
                Instant::now() + interval * (i + 1) + Duration::from_millis(50 * (i + 1) as u64);
            let due = store.drain_due(t, interval);
            assert_eq!(due.len(), 1, "fire {} must still drain", i);
        }
        // After 3 fires, obligation is exhausted; 4th drain returns empty.
        let t4 = Instant::now() + interval * 10;
        let due = store.drain_due(t4, interval);
        assert!(due.is_empty(), "exhausted obligation must not drain again");
    }

    #[test]
    fn gc_removes_old_discharged_records() {
        let mut store = ObligationStore::default();
        let interval = Duration::from_secs(5);
        store.register("msg-old".into(), "alice".into(), "bob".into(), interval);
        // Manually discharge and backdate.
        {
            let r = store.records.get_mut("msg-old").unwrap();
            r.discharged = true;
            r.registered_at = Instant::now() - Duration::from_secs(7200);
        }
        // Active obligation stays.
        store.register("msg-active".into(), "carol".into(), "dave".into(), interval);
        store.gc(Instant::now());
        assert!(!store.records.contains_key("msg-old"));
        assert!(store.records.contains_key("msg-active"));
    }
}
