use super::*;
use crate::relay::contract::account::{SessionQueryParams, UploadSession};
use crate::relay::session_query::{
    Candidates, CatalogVersion, ExecutionObservation, ObservedSession, PAGE_ROWS,
};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct Enriched {
    pub uploads: Vec<UploadSession>,
    pub observations: Vec<(String, ExecutionObservation)>,
}

#[derive(Deserialize)]
struct QuerySessions {
    sessions: Vec<ObservedSession<UploadSession>>,
}

pub(super) fn decode(value: Value, allowed: &[String]) -> Result<Enriched, RpcError> {
    let answer = read_answer::<QuerySessions>(value)?;
    if answer.sessions.len() > PAGE_ROWS {
        return Err(query_failed());
    }
    let allowed: HashSet<_> = allowed.iter().cloned().collect();
    let mut counts = HashMap::new();
    for row in &answer.sessions {
        *counts
            .entry(format!("{}:{}", row.session.source, row.session.session_id))
            .or_insert(0) += 1;
    }
    let mut result = Enriched::default();
    for row in answer.sessions {
        let key = format!("{}:{}", row.session.source, row.session.session_id);
        if !allowed.contains(&key) || counts.get(&key) != Some(&1) {
            continue;
        }
        if let Some(observation) = row.observation.and_then(|value| {
            ExecutionObservation::positive(
                Some(value.model),
                value.reasoning_effort,
                Some(value.source_fingerprint),
            )
        }) {
            result.observations.push((key, observation));
        }
        result.uploads.push(row.session);
    }
    Ok(result)
}

impl Uploader {
    pub(super) async fn observed_snapshot(
        &self,
        request: &SessionQueryParams,
        initial: Candidates,
        observations: Vec<(String, ExecutionObservation)>,
        path: PathBuf,
        version: CatalogVersion,
        reader: Arc<HistoryReader>,
    ) -> Result<(Candidates, CatalogVersion), RpcError> {
        let slot = self.query_index.clone();
        let request = request.clone();
        tokio::task::spawn_blocking(move || {
            // Cancellation cannot release the reset barrier while a detached
            // blocking continuation can still mutate/select this index.
            let _reader = reader;
            let mut slot = slot.lock().map_err(|_| query_failed())?;
            let (db, _, catalog) = slot.as_mut().ok_or_else(query_failed)?;
            if request.cursor.is_some()
                || *db != path
                || catalog.index.epoch() != initial.live_epoch
                || catalog.index.revision() != initial.live_revision
                || !catalog.settings_current()
            {
                return Err(RpcError::new(
                    ErrorKind::Busy,
                    "Sessions changed. Refresh this page to continue.",
                ));
            }
            let result = catalog.observed_snapshot(&request, initial, &observations, version);
            if result.is_err() {
                // SQL pruning/revisions and the display overlay are one
                // disposable object. Never reuse a partially failed update.
                *slot = None;
            }
            result
        })
        .await
        .map_err(|_| query_failed())?
    }
}

#[cfg(test)]
mod tests;
