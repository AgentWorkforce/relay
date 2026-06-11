use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

/// Wall-clock snapshot of one dedup entry for crash recovery. `Instant`s
/// cannot be serialized, so insertion times are persisted as unix millis and
/// converted back relative to load time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedDedupEntry {
    pub key: String,
    pub inserted_at_ms: u64,
}

#[derive(Debug)]
pub struct DedupCache {
    ttl: Duration,
    max_entries: usize,
    seen: HashMap<String, Instant>,
    order: VecDeque<(String, Instant)>,
    dirty: bool,
}

impl DedupCache {
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries,
            seen: HashMap::new(),
            order: VecDeque::new(),
            dirty: false,
        }
    }

    pub fn insert_if_new(&mut self, id: &str, now: Instant) -> bool {
        self.evict(now);
        if self.seen.contains_key(id) {
            return false;
        }

        self.dirty = true;
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
            self.dirty = true;
        }
    }

    pub fn remove(&mut self, id: &str) {
        if self.seen.remove(id).is_some() {
            self.dirty = true;
        }
        self.order.retain(|(key, _)| key != id);
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    /// Return whether the cache was mutated since the last call, clearing the flag.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// Snapshot live entries as wall-clock timestamps (oldest first).
    /// `now`/`now_ms` must describe the same moment on both clocks.
    pub fn to_persisted(&self, now: Instant, now_ms: u64) -> Vec<PersistedDedupEntry> {
        self.order
            .iter()
            .map(|(key, inserted_at)| PersistedDedupEntry {
                key: key.clone(),
                inserted_at_ms: now_ms
                    .saturating_sub(now.duration_since(*inserted_at).as_millis() as u64),
            })
            .collect()
    }

    /// Rebuild a cache from persisted entries, dropping anything whose TTL
    /// already elapsed. `now`/`now_ms` must describe the same moment on both
    /// clocks.
    pub fn from_persisted(
        ttl: Duration,
        max_entries: usize,
        entries: Vec<PersistedDedupEntry>,
        now: Instant,
        now_ms: u64,
    ) -> Self {
        let mut cache = Self::new(ttl, max_entries);
        let mut entries = entries;
        entries.sort_by_key(|entry| entry.inserted_at_ms);
        for entry in entries {
            let elapsed = Duration::from_millis(now_ms.saturating_sub(entry.inserted_at_ms));
            if elapsed >= ttl {
                continue;
            }
            // `checked_sub` can fail close to process/system start; treating
            // the entry as just-inserted only extends its dedup window.
            let inserted_at = now.checked_sub(elapsed).unwrap_or(now);
            if cache.seen.contains_key(&entry.key) {
                continue;
            }
            cache.seen.insert(entry.key.clone(), inserted_at);
            cache.order.push_back((entry.key, inserted_at));
            while cache.seen.len() > cache.max_entries {
                if let Some((old_id, _)) = cache.order.pop_front() {
                    cache.seen.remove(&old_id);
                }
            }
        }
        cache
    }
}

pub(crate) fn unix_now_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

pub(crate) fn save_dedup_cache(path: &Path, cache: &DedupCache) -> anyhow::Result<()> {
    let persisted = cache.to_persisted(Instant::now(), unix_now_millis());
    crate::util::fs::write_json_atomic(path, &persisted)
}

pub(crate) fn load_dedup_cache(path: &Path, ttl: Duration, max_entries: usize) -> DedupCache {
    let entries: Vec<PersistedDedupEntry> = std::fs::read_to_string(path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default();
    DedupCache::from_persisted(ttl, max_entries, entries, Instant::now(), unix_now_millis())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{load_dedup_cache, save_dedup_cache, DedupCache, PersistedDedupEntry};

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

    #[test]
    fn tracks_dirty_on_mutation() {
        let mut dedup = DedupCache::new(Duration::from_secs(60), 100);
        assert!(!dedup.take_dirty(), "fresh cache starts clean");

        assert!(dedup.insert_if_new("a", Instant::now()));
        assert!(dedup.take_dirty(), "new insert marks dirty");
        assert!(!dedup.take_dirty(), "take_dirty clears the flag");

        assert!(!dedup.insert_if_new("a", Instant::now()));
        assert!(!dedup.take_dirty(), "duplicate insert is not a mutation");

        dedup.remove("a");
        assert!(dedup.take_dirty(), "remove marks dirty");
        dedup.remove("a");
        assert!(
            !dedup.take_dirty(),
            "removing a missing key is not a mutation"
        );
    }

    #[test]
    fn persistence_round_trips_and_drops_expired() {
        let dir = tempfile::tempdir().expect("tempdir should create");
        let path = dir.path().join("dedup.json");
        let ttl = Duration::from_secs(300);

        let mut dedup = DedupCache::new(ttl, 100);
        let now = Instant::now();
        dedup.insert_if_new("ws_demo:evt_1", now);
        dedup.insert_if_new("ws_demo:evt_2", now);
        save_dedup_cache(&path, &dedup).expect("dedup cache should save");

        let mut reloaded = load_dedup_cache(&path, ttl, 100);
        assert_eq!(reloaded.len(), 2, "live entries survive a reload");
        assert!(
            !reloaded.insert_if_new("ws_demo:evt_1", Instant::now()),
            "reloaded entries still deduplicate replayed events"
        );
        assert!(
            reloaded.insert_if_new("ws_demo:evt_3", Instant::now()),
            "new events still insert after reload"
        );
    }

    #[test]
    fn from_persisted_drops_expired_entries() {
        let ttl = Duration::from_secs(300);
        let now_ms: u64 = 1_700_000_000_000;
        let entries = vec![
            PersistedDedupEntry {
                key: "fresh".to_string(),
                inserted_at_ms: now_ms - 1_000,
            },
            PersistedDedupEntry {
                key: "expired".to_string(),
                inserted_at_ms: now_ms - ttl.as_millis() as u64 - 1,
            },
        ];

        let mut cache = DedupCache::from_persisted(ttl, 100, entries, Instant::now(), now_ms);
        assert_eq!(cache.len(), 1, "expired entries are dropped on load");
        assert!(!cache.insert_if_new("fresh", Instant::now()));
        assert!(cache.insert_if_new("expired", Instant::now()));
    }

    #[test]
    fn load_missing_or_corrupt_file_yields_empty_cache() {
        let dir = tempfile::tempdir().expect("tempdir should create");
        let missing = dir.path().join("missing.json");
        assert!(load_dedup_cache(&missing, Duration::from_secs(300), 100).is_empty());

        let corrupt = dir.path().join("corrupt.json");
        std::fs::write(&corrupt, "not json").expect("seed file should write");
        assert!(load_dedup_cache(&corrupt, Duration::from_secs(300), 100).is_empty());
    }
}
