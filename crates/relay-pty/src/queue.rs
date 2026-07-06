use std::collections::VecDeque;

/// A fixed, indexed set of priority levels. Index 0 is the most urgent
/// level and higher indices are progressively less urgent. Callers define
/// their own scheme (an enum, typically) and describe it through this
/// trait; the queue itself never interprets levels beyond their index.
pub trait PriorityScheme: Copy {
    /// Number of distinct levels in the scheme (one queue bucket each).
    const LEVELS: usize;
    /// Most urgent bucket index the overflow policy may evict from.
    /// Items at indices below this are never dropped to admit new work.
    const FIRST_DROPPABLE: usize;
    /// Bucket index for this level: `0` is most urgent,
    /// `LEVELS - 1` least urgent.
    fn index(self) -> usize;
}

/// An item carrying a priority from some [`PriorityScheme`].
pub trait Prioritized {
    type Priority: PriorityScheme;
    fn priority(&self) -> Self::Priority;
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum QueueError {
    #[error("queue is full")]
    Full,
}

#[derive(Debug)]
pub struct BoundedPriorityQueue<T> {
    max: usize,
    len: usize,
    buckets: Vec<VecDeque<T>>,
}

impl<T> BoundedPriorityQueue<T>
where
    T: Prioritized,
{
    pub fn new(max: usize) -> Self {
        let mut buckets = Vec::with_capacity(T::Priority::LEVELS);
        for _ in 0..T::Priority::LEVELS {
            buckets.push(VecDeque::new());
        }
        Self {
            max,
            len: 0,
            buckets,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn push(&mut self, item: T) -> Result<(), QueueError> {
        if self.len >= self.max {
            return Err(QueueError::Full);
        }
        self.enqueue(item);
        Ok(())
    }

    pub fn push_with_overflow_policy(&mut self, item: T) -> Result<Option<T>, QueueError> {
        if self.len < self.max {
            self.enqueue(item);
            return Ok(None);
        }

        if let Some(dropped) = self.drop_overflow_candidate() {
            self.enqueue(item);
            return Ok(Some(dropped));
        }

        Err(QueueError::Full)
    }

    pub fn pop(&mut self) -> Option<T> {
        for idx in 0..T::Priority::LEVELS {
            if let Some(item) = self.buckets[idx].pop_front() {
                self.len -= 1;
                return Some(item);
            }
        }
        None
    }

    fn enqueue(&mut self, item: T) {
        let idx = item.priority().index();
        self.buckets[idx].push_back(item);
        self.len += 1;
    }

    fn drop_overflow_candidate(&mut self) -> Option<T> {
        for idx in (T::Priority::FIRST_DROPPABLE..T::Priority::LEVELS).rev() {
            if let Some(item) = self.buckets[idx].pop_front() {
                self.len -= 1;
                return Some(item);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{BoundedPriorityQueue, Prioritized, PriorityScheme, QueueError};

    /// Five-level scheme matching the relay P0–P4 convention: P0 most
    /// urgent, P2 and below evictable under overflow.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TestPriority {
        P0,
        P1,
        P2,
        P3,
        P4,
    }

    impl PriorityScheme for TestPriority {
        const LEVELS: usize = 5;
        const FIRST_DROPPABLE: usize = 2;

        fn index(self) -> usize {
            match self {
                TestPriority::P0 => 0,
                TestPriority::P1 => 1,
                TestPriority::P2 => 2,
                TestPriority::P3 => 3,
                TestPriority::P4 => 4,
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Msg {
        id: &'static str,
        p: TestPriority,
    }

    impl Prioritized for Msg {
        type Priority = TestPriority;

        fn priority(&self) -> TestPriority {
            self.p
        }
    }

    #[test]
    fn lower_priority_number_dequeues_first() {
        let mut q = BoundedPriorityQueue::new(10);
        q.push(Msg {
            id: "p3",
            p: TestPriority::P3,
        })
        .unwrap();
        q.push(Msg {
            id: "p2",
            p: TestPriority::P2,
        })
        .unwrap();

        assert_eq!(q.pop().unwrap().id, "p2");
        assert_eq!(q.pop().unwrap().id, "p3");
    }

    #[test]
    fn queue_refuses_push_above_max() {
        let mut q = BoundedPriorityQueue::new(1);
        q.push(Msg {
            id: "a",
            p: TestPriority::P3,
        })
        .unwrap();
        let err = q
            .push(Msg {
                id: "b",
                p: TestPriority::P3,
            })
            .unwrap_err();
        assert_eq!(err, QueueError::Full);
    }

    #[test]
    fn overflow_drops_low_priority_first() {
        let mut q = BoundedPriorityQueue::new(2);
        q.push(Msg {
            id: "p1",
            p: TestPriority::P1,
        })
        .unwrap();
        q.push(Msg {
            id: "p4",
            p: TestPriority::P4,
        })
        .unwrap();

        let dropped = q
            .push_with_overflow_policy(Msg {
                id: "incoming",
                p: TestPriority::P2,
            })
            .unwrap()
            .unwrap();
        assert_eq!(dropped.id, "p4");
        assert_eq!(q.pop().unwrap().id, "p1");
        assert_eq!(q.pop().unwrap().id, "incoming");
    }

    #[test]
    fn p1_is_retained_under_overflow() {
        let mut q = BoundedPriorityQueue::new(1);
        q.push(Msg {
            id: "p1",
            p: TestPriority::P1,
        })
        .unwrap();
        let err = q
            .push_with_overflow_policy(Msg {
                id: "p2",
                p: TestPriority::P2,
            })
            .unwrap_err();
        assert_eq!(err, QueueError::Full);
    }

    #[test]
    fn fifo_within_same_priority() {
        let mut q = BoundedPriorityQueue::new(10);
        q.push(Msg {
            id: "a",
            p: TestPriority::P3,
        })
        .unwrap();
        q.push(Msg {
            id: "b",
            p: TestPriority::P3,
        })
        .unwrap();
        assert_eq!(q.pop().unwrap().id, "a");
        assert_eq!(q.pop().unwrap().id, "b");
    }

    #[test]
    fn overflow_cannot_drop_p0_or_p1() {
        let mut q = BoundedPriorityQueue::new(2);
        q.push(Msg {
            id: "p0",
            p: TestPriority::P0,
        })
        .unwrap();
        q.push(Msg {
            id: "p1",
            p: TestPriority::P1,
        })
        .unwrap();
        let err = q
            .push_with_overflow_policy(Msg {
                id: "p2",
                p: TestPriority::P2,
            })
            .unwrap_err();
        assert_eq!(err, QueueError::Full);
    }

    #[test]
    fn pop_empty_returns_none() {
        let mut q = BoundedPriorityQueue::<Msg>::new(10);
        assert!(q.pop().is_none());
    }

    #[test]
    fn len_tracks_correctly() {
        let mut q = BoundedPriorityQueue::new(10);
        q.push(Msg {
            id: "a",
            p: TestPriority::P3,
        })
        .unwrap();
        q.push(Msg {
            id: "b",
            p: TestPriority::P2,
        })
        .unwrap();
        q.push(Msg {
            id: "c",
            p: TestPriority::P4,
        })
        .unwrap();
        assert_eq!(q.len(), 3);
        q.pop();
        assert_eq!(q.len(), 2);
    }
}
