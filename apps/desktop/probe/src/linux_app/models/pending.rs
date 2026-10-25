//! A value the person asked for while the core answers: shown in place of
//! the confirmed one and dropped when the answer arrives. A newer request
//! supersedes an older one (the last click wins), so an older answer
//! changes nothing; only the latest request's failure reverts. The Mac's
//! `PendingValue` in `RelayDesktopCore` matches this.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingValue<T> {
    wanted: Option<T>,
    token: u64,
}

impl<T> Default for PendingValue<T> {
    fn default() -> Self {
        PendingValue {
            wanted: None,
            token: 0,
        }
    }
}

impl<T: Clone + PartialEq> PendingValue<T> {
    /// The value asked for and not yet answered.
    pub fn wanted(&self) -> Option<&T> {
        self.wanted.as_ref()
    }

    pub fn is_pending(&self) -> bool {
        self.wanted.is_some()
    }

    /// What to show: the value asked for, else the confirmed one.
    pub fn shown(&self, confirmed: T) -> T {
        self.wanted.clone().unwrap_or(confirmed)
    }

    /// The latest request's token.
    pub fn token(&self) -> u64 {
        self.token
    }

    /// Records the intent; returns the token its answer must carry.
    pub fn begin(&mut self, value: T) -> u64 {
        self.token = self.token.wrapping_add(1);
        self.wanted = Some(value);
        self.token
    }

    /// The request `token` finished. Only the latest request settles the
    /// value; an older one changes nothing. Returns whether it was the
    /// latest.
    pub fn finish(&mut self, token: u64) -> bool {
        if token != self.token {
            return false;
        }
        self.wanted = None;
        true
    }

    /// Forgets the intent, whatever is in flight.
    pub fn clear(&mut self) {
        self.wanted = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_what_was_asked_for_until_its_answer() {
        let mut pending = PendingValue::default();
        assert_eq!(pending.shown(false), false);
        let token = pending.begin(true);
        assert!(pending.is_pending());
        assert_eq!(pending.shown(false), true);
        assert!(pending.finish(token));
        assert!(!pending.is_pending());
        assert_eq!(pending.shown(false), false);
    }

    #[test]
    fn the_last_click_wins_over_an_older_answer() {
        let mut pending = PendingValue::default();
        let first = pending.begin(true);
        let second = pending.begin(false);
        assert_eq!(pending.wanted(), Some(&false));
        // The first request's answer, success or failure, changes nothing.
        assert!(!pending.finish(first));
        assert_eq!(pending.shown(true), false);
        assert!(pending.finish(second));
        assert_eq!(pending.shown(true), true);
    }
}

/// A status the core reports (`incoming.status`, `claude_delivery.status`)
/// with every change still on its way written over it: a change shows at
/// once, a read never hides one still pending, and a refused change simply
/// stops being shown. One the core took stays until the read after it
/// lists it. The Mac's `IncomingModel` and `ClaudeDeliveryModel` match this.
pub struct PendingStatuses<T> {
    confirmed: Option<T>,
    pending: Vec<PendingStatus<T>>,
    token: u64,
    /// Reads are numbered as they start: a read lists only what the core
    /// took before it started, and an older read never replaces a newer
    /// one's status.
    reads_started: u64,
    applied_read: u64,
}

struct PendingStatus<T> {
    token: u64,
    /// The core took it, when `reads_started` reads had started: it goes
    /// once a read started after that succeeds.
    taken: Option<u64>,
    change: std::rc::Rc<dyn Fn(T) -> T>,
}

impl<T> Default for PendingStatuses<T> {
    fn default() -> Self {
        PendingStatuses {
            confirmed: None,
            pending: Vec::new(),
            token: 0,
            reads_started: 0,
            applied_read: 0,
        }
    }
}

impl<T: Clone> PendingStatuses<T> {
    /// The confirmed status with the pending changes applied in order.
    pub fn shown(&self) -> Option<T> {
        let confirmed = self.confirmed.clone()?;
        Some(
            self.pending
                .iter()
                .fold(confirmed, |status, pending| (pending.change)(status)),
        )
    }

    /// Records a change to show at once; returns its token.
    pub fn begin(&mut self, change: impl Fn(T) -> T + 'static) -> u64 {
        self.token = self.token.wrapping_add(1);
        self.pending.push(PendingStatus {
            token: self.token,
            taken: None,
            change: std::rc::Rc::new(change),
        });
        self.token
    }

    /// The change `token` was answered: refused, it stops showing now;
    /// taken, it shows until a read started after this succeeds.
    pub fn answered(&mut self, token: u64, taken: bool) {
        if taken {
            for pending in self
                .pending
                .iter_mut()
                .filter(|pending| pending.token == token)
            {
                pending.taken = Some(self.reads_started);
            }
        } else {
            self.pending.retain(|pending| pending.token != token);
        }
    }

    /// A read starts; its answer carries this number to `read`.
    pub fn begin_read(&mut self) -> u64 {
        self.reads_started += 1;
        self.reads_started
    }

    /// The read `read` answered: its status is the truth under the changes
    /// still on their way, and lists what the core took before it started.
    /// An older read's answer, after a newer one's, changes nothing.
    pub fn read(&mut self, read: u64, status: T) {
        if read <= self.applied_read {
            return;
        }
        self.applied_read = read;
        self.confirmed = Some(status);
        self.pending
            .retain(|pending| !pending.taken.is_some_and(|taken| taken < read));
    }

    /// Changes the retired core will never answer are not shown.
    pub fn interrupted(&mut self) {
        self.pending.clear();
    }

    /// Nothing of the previous account stays.
    pub fn clear(&mut self) {
        *self = PendingStatuses::default();
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn a_read_keeps_the_changes_still_on_their_way() {
        let mut statuses: PendingStatuses<Vec<&'static str>> = PendingStatuses::default();
        assert_eq!(statuses.shown(), None);
        let first = statuses.begin_read();
        statuses.read(first, vec!["a", "b"]);
        // A read started before the approval was taken lists the old
        // status: the approval still shows over it.
        let stale = statuses.begin_read();
        let approve = statuses.begin(|mut held: Vec<&str>| {
            held.retain(|id| *id != "a");
            held
        });
        let share = statuses.begin(|mut held: Vec<&str>| {
            held.push("shared");
            held
        });
        assert_eq!(statuses.shown(), Some(vec!["b", "shared"]));
        statuses.answered(approve, true);
        statuses.read(stale, vec!["a", "b"]);
        assert_eq!(statuses.shown(), Some(vec!["b", "shared"]));
        // The approval's own read lands before the share answers: the
        // approval is listed, the share still shows.
        let after = statuses.begin_read();
        statuses.read(after, vec!["b"]);
        assert_eq!(statuses.shown(), Some(vec!["b", "shared"]));
        // An older read's answer arriving now changes nothing.
        statuses.read(stale, vec!["a", "b"]);
        assert_eq!(statuses.shown(), Some(vec!["b", "shared"]));
        // Refused, the share stops showing at once.
        statuses.answered(share, false);
        assert_eq!(statuses.shown(), Some(vec!["b"]));
        statuses.interrupted();
        assert_eq!(statuses.shown(), Some(vec!["b"]));
        statuses.clear();
        assert_eq!(statuses.shown(), None);
    }
}
