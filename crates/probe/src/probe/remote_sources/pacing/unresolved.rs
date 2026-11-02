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

    pub fn by_connector(&self) -> BTreeMap<String, String> {
        self.0
            .values()
            .map(|failure| (failure.connector.clone(), failure.reason.clone()))
            .collect()
    }
}
