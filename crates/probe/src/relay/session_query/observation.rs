//! Query-private helper metadata, compiled into both the helper and core.
//! The public UploadSession contract never carries provider paths or this cache.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ExecutionObservation {
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub source_fingerprint: String,
}

impl ExecutionObservation {
    pub fn positive(
        model: Option<String>,
        reasoning_effort: Option<String>,
        source_fingerprint: Option<String>,
    ) -> Option<Self> {
        let value = Self {
            model: model?,
            reasoning_effort,
            source_fingerprint: source_fingerprint?,
        };
        value.valid().then_some(value)
    }

    pub fn valid(&self) -> bool {
        let field = |value: &str| {
            !value.is_empty()
                && value == value.trim()
                && value.len() <= 128
                && !value.chars().any(char::is_control)
        };
        field(&self.model)
            && self.reasoning_effort.as_deref().is_none_or(field)
            && self.source_fingerprint.len() == 64
            && self
                .source_fingerprint
                .bytes()
                .all(|c| c.is_ascii_hexdigit())
    }
}

pub(crate) fn source_fingerprint(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()))
}

#[derive(Serialize, Deserialize)]
pub(crate) struct ObservedSession<T> {
    #[serde(flatten)]
    pub session: T,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "_query_execution"
    )]
    pub observation: Option<ExecutionObservation>,
}
