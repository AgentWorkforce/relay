use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct DedupCache {
    ttl: Duration,
    max_entries: usize,
    seen: HashMap<String, Instant>,
    order: VecDeque<(String, Instant)>,
}

impl DedupCache {
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries,
            seen: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn insert_if_new(&mut self, id: &str, now: Instant) -> bool {
        self.evict(now);
        if self.seen.contains_key(id) {
            return false;
        }

        self.seen.insert(id.to_string(), now);
        self.order.push_back((id.to_string(), now));

        while self.seen.len() > self.max_entries {
            if let Some((old_id, _)) = self.order.pop_front() {
                self.seen.remove(&old_id);
            }
        }

        debug_assert_eq!(
            self.seen.len(),
            self.order.len(),
            "DedupCache: HashMap and VecDeque out of sync"
        );
        true
    }

    fn evict(&mut self, now: Instant) {
        while let Some((id, ts)) = self.order.front().cloned() {
            if now.duration_since(ts) < self.ttl {
                break;
            }
            self.order.pop_front();
            self.seen.remove(&id);
        }
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::DedupCache;

    #[test]
    fn drops_duplicates() {
        let mut dedup = DedupCache::new(Duration::from_secs(60), 100);
        let now = Instant::now();
        assert!(dedup.insert_if_new("id1", now));
        assert!(!dedup.insert_if_new("id1", now + Duration::from_secs(1)));
    }

    #[test]
    fn remains_bounded() {
        let mut dedup = DedupCache::new(Duration::from_secs(60), 2);
        let now = Instant::now();
        dedup.insert_if_new("a", now);
        dedup.insert_if_new("b", now);
        dedup.insert_if_new("c", now);
        assert_eq!(dedup.len(), 2);
    }

    #[test]
    fn re_insert_after_ttl_succeeds() {
        let mut dedup = DedupCache::new(Duration::from_secs(5), 100);
        let now = Instant::now();
        assert!(dedup.insert_if_new("x", now));
        assert!(!dedup.insert_if_new("x", now + Duration::from_secs(1)));
        // After TTL expires, should be insertable again
        assert!(dedup.insert_if_new("x", now + Duration::from_secs(6)));
    }
}
