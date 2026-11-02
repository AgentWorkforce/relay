use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct UnresolvedFailure {
    connector: String,
    source: String,
    session_id: String,
    reason: String,
    /// The latest failed download attempt, so equal failures on later
    /// retries are still distinct health events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    at_ms: Option<i64>,
}

/// Safe health messages for session downloads that have not recovered.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(super) struct UnresolvedFailures(BTreeMap<String, UnresolvedFailure>);

impl UnresolvedFailures {
    pub fn record(
        &mut self,
        key: String,
        connector: &str,
        source: &str,
        session_id: &str,
        reason: String,
        at_ms: i64,
    ) {
        self.0.insert(
            key,
            UnresolvedFailure {
                connector: connector.to_string(),
                source: source.to_string(),
                session_id: session_id.to_string(),
                reason,
                at_ms: Some(at_ms),
            },
        );
    }

    pub fn succeeded(&mut self, key: &str) {
        self.0.remove(key);
    }

    pub fn retain_wanted(&mut self, mut wanted: impl FnMut(&str, &str) -> bool) {
        self.0
            .retain(|_, failure| wanted(&failure.source, &failure.session_id));
    }

    /// Folds in what another writer saved while this copy was in use (it was
    /// `started` at `since_ms`; `on_disk` is the file now): a failure that
    /// writer recorded since is kept, and one it resolved since (gone from
    /// the file, and not recorded again here) is forgotten.
    pub fn merge_concurrent(&mut self, started: &Self, on_disk: &Self, since_ms: i64) {
        for (key, failure) in &on_disk.0 {
            let theirs_is_new = failure.at_ms.is_some_and(|at| at >= since_ms);
            let newer = self
                .0
                .get(key)
                .is_none_or(|ours| ours.at_ms < failure.at_ms);
            if theirs_is_new && newer {
                self.0.insert(key.clone(), failure.clone());
            }
        }
        for key in started.0.keys() {
            let resolved_there = !on_disk.0.contains_key(key);
            let recorded_here = self
                .0
                .get(key)
                .is_some_and(|ours| ours.at_ms.is_some_and(|at| at >= since_ms));
            if resolved_there && !recorded_here {
                self.0.remove(key);
            }
        }
    }

    /// Each connector's latest failure reason (by `at_ms`).
    pub fn by_connector(&self) -> BTreeMap<String, String> {
        let mut latest: BTreeMap<&str, &UnresolvedFailure> = BTreeMap::new();
        for failure in self.0.values() {
            let newer = latest
                .get(failure.connector.as_str())
                .is_none_or(|current| current.at_ms <= failure.at_ms);
            if newer {
                latest.insert(&failure.connector, failure);
            }
        }
        latest
            .into_iter()
            .map(|(connector, failure)| (connector.to_string(), failure.reason.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_connector_reports_its_latest_failure() {
        let mut failures = UnresolvedFailures::default();
        failures.record("a".into(), "devin", "devin", "1", "newer".into(), 20);
        failures.record("b".into(), "devin", "devin", "2", "older".into(), 10);
        assert_eq!(failures.by_connector()["devin"], "newer");
    }

    #[test]
    fn a_sweep_keeps_what_a_selected_download_saved_meanwhile() {
        let mut started = UnresolvedFailures::default();
        started.record("old".into(), "devin", "devin", "1", "old".into(), 5);
        // Meanwhile a selected download resolved `old` and recorded `new`.
        let mut on_disk = UnresolvedFailures::default();
        on_disk.record("new".into(), "devin", "devin", "2", "new".into(), 15);
        // The sweep's own copy still has `old` and recorded `own`.
        let mut sweep = started.clone();
        sweep.record("own".into(), "devin", "devin", "3", "own".into(), 12);
        sweep.merge_concurrent(&started, &on_disk, 10);
        assert!(!sweep.0.contains_key("old"));
        assert!(sweep.0.contains_key("new"));
        assert!(sweep.0.contains_key("own"));
    }
}
