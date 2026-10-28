//! Last positive display observations, bounded by current catalog identities.
//! Source stamps are not append proofs and do not own this display cache.
use super::*;

#[derive(Clone, PartialEq, Eq)]
struct SourceBound {
    fingerprint: Option<String>,
    models: Option<Vec<String>>,
}

struct Overlay {
    epoch: u64,
    source: SourceBound,
    value: ExecutionObservation,
}

#[derive(Default)]
pub(super) struct ExecutionCache {
    sources: HashMap<String, SourceBound>,
    overlays: HashMap<String, Overlay>,
}

impl ExecutionCache {
    pub fn project(
        &mut self,
        key: &str,
        models: Vec<String>,
        path: Option<&Path>,
        epoch: u64,
    ) -> (Option<Vec<String>>, Option<String>) {
        let source = SourceBound {
            fingerprint: path.map(super::super::observation::source_fingerprint),
            models: Some(models),
        };
        self.sources.insert(key.into(), source.clone());
        if let Some(overlay) = self.overlays.get(key) {
            if overlay.epoch == epoch && overlay.source == source {
                return (
                    Some(vec![overlay.value.model.clone()]),
                    overlay.value.reasoning_effort.clone(),
                );
            }
            self.overlays.remove(key);
        }
        (source.models, None)
    }

    pub fn forget(&mut self, key: &str) {
        self.sources.remove(key);
        self.overlays.remove(key);
    }

    pub fn restore(&mut self, index: &mut Index) -> Result<(), RpcError> {
        for (key, overlay) in &self.overlays {
            if let Some(mut row) = index.get(key)? {
                if let Some(upload) = row.upload.as_mut() {
                    upload.models = overlay.source.models.clone();
                    upload.reasoning_effort = None;
                    index.put(row)?;
                }
            }
        }
        self.overlays.clear();
        Ok(())
    }

    pub fn apply(
        &mut self,
        index: &mut Index,
        key: &str,
        value: &ExecutionObservation,
    ) -> Result<(), RpcError> {
        let Some(source) = self.sources.get(key) else {
            return Ok(());
        };
        if !value.valid() || source.fingerprint.as_deref() != Some(&value.source_fingerprint) {
            return Ok(());
        }
        if index.observe_execution(key, value)? {
            self.overlays.insert(
                key.into(),
                Overlay {
                    epoch: index.epoch,
                    source: source.clone(),
                    value: value.clone(),
                },
            );
        }
        Ok(())
    }
}

impl CatalogIndex {
    /// The caller holds the index mutex and discards this disposable index on
    /// any error after mutation. A retained cursor must never enter this path.
    pub fn observed_snapshot(
        &mut self,
        request: &SessionQueryParams,
        initial: Candidates,
        observations: &[(String, ExecutionObservation)],
        version: CatalogVersion,
    ) -> Result<(Candidates, CatalogVersion), RpcError> {
        if request.cursor.is_some()
            || self.index.epoch != initial.live_epoch
            || self.index.revision != initial.live_revision
            || !self.settings_current()
        {
            return Err(stale());
        }
        if observations.len() > PAGE_ROWS {
            return Err(RpcError::invalid_params("Too many session observations."));
        }
        let allowed: HashSet<_> = initial
            .rows
            .iter()
            .filter(|row| row.upload.is_some())
            .map(LocalSessionRow::key)
            .collect();
        let mut counts = HashMap::new();
        for (key, _) in observations {
            *counts.entry(key.clone()).or_insert(0) += 1;
        }
        for (key, observation) in observations {
            if allowed.contains(key) && counts.get(key) == Some(&1) {
                self.execution.apply(&mut self.index, key, observation)?;
            }
        }
        let candidates = if self.index.revision == initial.live_revision {
            initial
        } else {
            let mut current = self.index.candidates(request)?;
            current.proof_cache_key = initial.proof_cache_key;
            current
        };
        // Model writes revise the index, but cannot certify helper badges
        // against a collector commit that happened after their read.
        let version = self.version_at(request, version)?;
        Ok((candidates, version))
    }
}

#[cfg(test)]
mod tests;
