//! Change-driven invalidation for tombstone-free local retention.
use super::*;

impl CatalogIndex {
    /// Retention deliberately emits no upload tombstones. Fence every seed,
    /// repair and answer against its separate durable eviction generation.
    pub(crate) fn retention_current(&self) -> Result<(), RpcError> {
        let generation = self.store.retention_generation().map_err(|_| failed())?;
        if generation != self.retention_generation {
            return Err(stale());
        }
        Ok(())
    }
    pub(super) fn reseed_after_retention(&mut self, generation: u64) -> Result<(), RpcError> {
        let local = self
            .index
            .live
            .iter()
            .map(|key| self.index.get(key))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|row| row.and_then(|row| row.relay))
            .collect();
        let archived = self.index.archived.clone();
        let presentation = self.index.presentation.clone();
        let epoch = self.index.epoch.wrapping_add(1);
        self.index = Index::new()?;
        self.index.epoch = epoch;
        self.execution = execution::ExecutionCache::default();
        self.links.clear();
        self.by_cwd.clear();
        self.pending_projects.clear();
        self.project_queue.clear();
        self.project_in_flight.clear();
        // Replay ordinary feed changes after this seed. A second eviction
        // during enumeration rejects this disposable projection; no retry loop.
        self.watermark = self.store.head_revision().map_err(|_| failed())?;
        self.retention_generation = generation;
        self.seed()?;
        // Retired catalog directories must not keep scheduling name lookups.
        // Preserve surviving names and their original expiry deadlines.
        self.projects.retain(|cwd, _| self.by_cwd.contains_key(cwd));
        self.project_resolved_at
            .retain(|cwd, _| self.by_cwd.contains_key(cwd));
        self.project_expiry
            .retain(|std::cmp::Reverse((_, cwd))| self.by_cwd.contains_key(cwd));
        self.index.live(local, archived, presentation)?;
        self.retention_current()
    }
    #[cfg(test)]
    pub(crate) fn due_projects_for_test(&mut self, now: std::time::Instant) -> Vec<String> {
        self.needed_projects_at(now)
    }
}
