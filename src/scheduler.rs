use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use crate::types::{InjectRequest, RelayPriority};

#[derive(Debug, Clone)]
struct CoalesceState {
    request: InjectRequest,
    first_seen: Instant,
    last_seen: Instant,
    deadline: Instant,
}

/// Maximum coalesced message body size (32 KiB). When exceeded, the current
/// group is flushed and the new message starts a fresh coalesce window.
const MAX_COALESCED_BODY_SIZE: usize = 32 * 1024;

#[derive(Debug)]
pub struct Scheduler {
    human_cooldown: Duration,
    coalesce_window: Duration,
    max_hold: Duration,
    last_human_keypress: Option<Instant>,
    pending: HashMap<(String, String), CoalesceState>,
}

impl Scheduler {
    pub fn new(human_cooldown_ms: u64, coalesce_window_ms: u64) -> Self {
        Self {
            human_cooldown: Duration::from_millis(human_cooldown_ms),
            coalesce_window: Duration::from_millis(coalesce_window_ms),
            max_hold: Duration::from_millis(2000),
            last_human_keypress: None,
            pending: HashMap::new(),
        }
    }

    pub fn record_human_input(&mut self, now: Instant) {
        self.last_human_keypress = Some(now);
    }

    pub fn can_inject(&self, priority: RelayPriority, now: Instant) -> bool {
        if matches!(priority, RelayPriority::P0 | RelayPriority::P1) {
            return true;
        }

        match self.last_human_keypress {
            Some(last) => now.duration_since(last) >= self.human_cooldown,
            None => true,
        }
    }

    pub fn push(&mut self, mut req: InjectRequest, now: Instant) -> Option<InjectRequest> {
        let key = (req.from.clone(), req.target.clone());

        if let Some(state) = self.pending.get_mut(&key) {
            let within_window = now.duration_since(state.last_seen) <= self.coalesce_window;
            let within_hold = now.duration_since(state.first_seen) <= self.max_hold;
            let within_size =
                state.request.body.len() + 1 + req.body.len() <= MAX_COALESCED_BODY_SIZE;
            if within_window && within_hold && within_size {
                state.request.body.push('\n');
                state.request.body.push_str(&req.body);
                state.last_seen = now;
                state.deadline =
                    std::cmp::min(state.first_seen + self.max_hold, now + self.coalesce_window);
                return None;
            }

            let flushed = self.pending.remove(&key).map(|s| s.request);
            req.attempts = 0;
            self.pending.insert(
                key,
                CoalesceState {
                    request: req,
                    first_seen: now,
                    last_seen: now,
                    deadline: now + self.coalesce_window,
                },
            );
            return flushed;
        }

        self.pending.insert(
            key,
            CoalesceState {
                request: req,
                first_seen: now,
                last_seen: now,
                deadline: now + self.coalesce_window,
            },
        );
        None
    }

    pub fn drain_ready(&mut self, now: Instant) -> Vec<InjectRequest> {
        let ready_keys: Vec<(String, String)> = self
            .pending
            .iter()
            .filter_map(|(key, state)| {
                if now >= state.deadline {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect();

        ready_keys
            .into_iter()
            .filter_map(|k| self.pending.remove(&k).map(|s| s.request))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use crate::types::{InjectRequest, RelayPriority};

    use super::Scheduler;

    fn req(id: &str, from: &str, target: &str, body: &str) -> InjectRequest {
        InjectRequest {
            id: id.into(),
            from: from.into(),
            target: target.into(),
            body: body.into(),
            priority: RelayPriority::P3,
            attempts: 0,
        }
    }

    #[test]
    fn injection_pauses_during_cooldown() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        sched.record_human_input(start);
        assert!(!sched.can_inject(RelayPriority::P2, start + Duration::from_millis(1000)));
        assert!(sched.can_inject(RelayPriority::P2, start + Duration::from_millis(3001)));
    }

    #[test]
    fn bursts_coalesce_within_window() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        assert!(sched
            .push(req("1", "alice", "#general", "hello"), start)
            .is_none());
        assert!(sched
            .push(
                req("2", "alice", "#general", "world"),
                start + Duration::from_millis(200)
            )
            .is_none());

        let ready = sched.drain_ready(start + Duration::from_millis(750));
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].body, "hello\nworld");
    }

    #[test]
    fn different_sender_or_target_do_not_coalesce() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        sched.push(req("1", "alice", "#general", "a"), start);
        sched.push(
            req("2", "bob", "#general", "b"),
            start + Duration::from_millis(50),
        );

        let ready = sched.drain_ready(start + Duration::from_millis(600));
        assert_eq!(ready.len(), 2);
    }

    #[test]
    fn p0_bypasses_cooldown() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        sched.record_human_input(start);
        assert!(sched.can_inject(RelayPriority::P0, start));
    }

    #[test]
    fn p1_bypasses_cooldown() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        sched.record_human_input(start);
        assert!(sched.can_inject(RelayPriority::P1, start));
    }

    #[test]
    fn max_hold_flushes_coalesced_messages() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        // Push first message
        sched.push(req("1", "alice", "#general", "a"), start);
        // Push within window repeatedly, but exceed max_hold (2000ms)
        sched.push(
            req("2", "alice", "#general", "b"),
            start + Duration::from_millis(400),
        );
        sched.push(
            req("3", "alice", "#general", "c"),
            start + Duration::from_millis(800),
        );
        sched.push(
            req("4", "alice", "#general", "d"),
            start + Duration::from_millis(1200),
        );
        sched.push(
            req("5", "alice", "#general", "e"),
            start + Duration::from_millis(1600),
        );
        // At 2100ms, first_seen + max_hold (2000ms) is exceeded
        // The next push should flush the coalesced group
        let flushed = sched.push(
            req("6", "alice", "#general", "f"),
            start + Duration::from_millis(2100),
        );
        assert!(flushed.is_some());
        let flushed = flushed.unwrap();
        assert!(flushed.body.contains("a\nb\nc\nd\ne"));
    }

    #[test]
    fn drain_ready_empty_before_deadline() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        sched.push(req("1", "alice", "#general", "hello"), start);
        let ready = sched.drain_ready(start + Duration::from_millis(100));
        assert!(ready.is_empty());
    }

    #[test]
    fn window_expiry_starts_new_group() {
        let mut sched = Scheduler::new(3000, 500);
        let start = Instant::now();
        sched.push(req("1", "alice", "#general", "first"), start);
        // Push past coalesce window (500ms)
        let flushed = sched.push(
            req("2", "alice", "#general", "second"),
            start + Duration::from_millis(600),
        );
        assert!(flushed.is_some());
        assert_eq!(flushed.unwrap().body, "first");
    }
}
