//! Admission and idle retirement share one mutex: a join cannot race an idle
//! decision and be cut off after it has been accepted.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub(crate) struct ConnectLifetime(Arc<Mutex<State>>);
struct State {
    requests: usize,
    touched: Instant,
    seen_room: bool,
    adopted: bool,
    closed: bool,
}
pub(crate) struct RequestGuard(ConnectLifetime);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        let mut state = self.0 .0.lock().unwrap();
        state.requests -= 1;
        state.touched = Instant::now();
    }
}
impl Default for ConnectLifetime {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(State {
            requests: 0,
            touched: Instant::now(),
            seen_room: false,
            adopted: false,
            closed: false,
        })))
    }
}
impl ConnectLifetime {
    pub fn enter(&self) -> Option<RequestGuard> {
        let mut state = self.0.lock().unwrap();
        if state.closed {
            return None;
        }
        state.requests += 1;
        Some(RequestGuard(self.clone()))
    }
    pub fn adopt(&self) {
        self.0.lock().unwrap().adopted = true;
    }
    pub fn retire_if_idle(&self, active_rooms: bool, shared: bool, now: Instant) -> bool {
        let mut state = self.0.lock().unwrap();
        state.adopted |= shared;
        if state.adopted || state.closed {
            return false;
        }
        state.seen_room |= active_rooms;
        if active_rooms || state.requests > 0 {
            state.touched = now;
            return false;
        }
        let grace = Duration::from_secs(if state.seen_room { 60 } else { 900 });
        if now.saturating_duration_since(state.touched) < grace {
            return false;
        }
        state.closed = true;
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_and_last_room_have_distinct_grace_periods() {
        let life = ConnectLifetime::default();
        let now = Instant::now();
        assert!(!life.retire_if_idle(false, false, now + Duration::from_secs(60)));
        assert!(!life.retire_if_idle(true, false, now + Duration::from_secs(61)));
        assert!(!life.retire_if_idle(true, false, now + Duration::from_secs(600)));
        assert!(!life.retire_if_idle(false, false, now + Duration::from_secs(659)));
        assert!(life.retire_if_idle(false, false, now + Duration::from_secs(661)));
        assert!(life.enter().is_none());
    }
    #[test]
    fn pending_join_prevents_shutdown_and_resets_idle_clock() {
        let life = ConnectLifetime::default();
        let request = life.enter().unwrap();
        assert!(!life.retire_if_idle(false, false, Instant::now() + Duration::from_secs(9999)));
        drop(request);
        assert!(!life.retire_if_idle(false, false, Instant::now()));
    }
    #[test]
    fn shared_registration_or_gui_permanently_adopts_core() {
        for gui in [true, false] {
            let life = ConnectLifetime::default();
            if gui {
                life.adopt();
            }
            assert!(!life.retire_if_idle(false, !gui, Instant::now() + Duration::from_secs(9999)));
            assert!(!life.retire_if_idle(
                false,
                false,
                Instant::now() + Duration::from_secs(19999)
            ));
        }
    }
}
