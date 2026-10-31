//! Core-owned catalog projection. History owns its schema: seed and incremental
//! repairs use only the SDK. SQLite indexes belong solely to this disposable
//! projection. Clients receive one bounded page, never an increasing prefix.
use crate::session_model::{LocalSessionQuery, LocalSessionRow};
use crate::relay::contract::account::{SessionQueryPage, SessionQueryParams, UploadSession};
use crate::relay::contract::agents::LocalSession;
use crate::relay::protocol::{ErrorKind, RpcError};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

pub(crate) const PAGE_ROWS: usize = 200;
const PAGE_BYTES: usize = 256 * 1024;
const SORTS: &[&str] = &[
    "session",
    "project",
    "status",
    "updated",
    "relay",
    "upload",
    "harness",
    "model",
    "reasoning",
    "created",
    "directory",
    "sessionID",
];

fn failed() -> RpcError {
    RpcError::new(
        ErrorKind::UploaderFailed,
        "Agent Relay could not read the session catalog.",
    )
}
fn stale() -> RpcError {
    RpcError::new(
        ErrorKind::Busy,
        "Sessions changed. Refresh this page to continue.",
    )
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Cursor {
    epoch: u64,
    revision: u64,
    query: u64,
    value: Option<String>,
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proof_cache_key: Option<String>,
}

pub(crate) struct Candidates {
    pub live_epoch: u64,
    pub live_revision: u64,
    pub proof_cache_key: String,
    pub rows: Vec<LocalSessionRow>,
    snapshot_archived: HashSet<String>,
    cursors: Vec<String>,
    more: bool,
    revision: u64,
    start_cursor: String,
}
impl Candidates {
    /// Final predicates run after badge enrichment, on at most PAGE_ROWS rows.
    pub fn finish(
        mut self,
        request: &SessionQueryParams,
        enriched: Vec<UploadSession>,
        status: Option<&crate::session_model::StatusView>,
    ) -> Result<SessionQueryPage, RpcError> {
        let enriched: HashMap<_, _> = enriched
            .into_iter()
            .map(|row| (format!("{}:{}", row.source, row.session_id), row))
            .collect();
        let query = LocalSessionQuery::new(&request.query);
        let mut page = SessionQueryPage {
            archived_keys: Some(vec![]),
            unchanged: false,
            verification_pending: false,
            sessions: vec![],
            local_sessions: vec![],
            next_cursor: None,
            revision: self.revision,
            candidates_scanned: 0,
        };
        let mut budget = budget::PageBudget::default();
        let hidden: HashSet<_> = request.hidden.iter().collect();
        let candidates = self.rows.len();
        for (index, mut row) in self.rows.drain(..).enumerate() {
            let retry = retry_cursor(&self.cursors[index], &self.proof_cache_key)?;
            let budget_cursor = budget::continuation_cursor(self.more, index, candidates, &retry);
            if !budget.fits(&page, None, budget_cursor, None)? {
                if index == 0 {
                    return Err(RpcError::invalid_params("A session cursor is too large."));
                }
                self.more = true;
                break;
            }
            if hidden.contains(&row.key()) {
                page.candidates_scanned += 1;
                page.next_cursor = Some(self.cursors[index].clone());
                continue;
            }
            let key = row.key();
            enrich_upload(&mut row, enriched.get(&key));
            if !request.preparing(&row.key()) && verification_pending(&query, &row, status) {
                page.verification_pending = true;
                page.candidates_scanned += 1;
                let raw = if index == 0 {
                    &self.start_cursor
                } else {
                    &self.cursors[index - 1]
                };
                page.next_cursor = Some(retry_cursor(raw, &self.proof_cache_key)?);
                self.more = true;
                break;
            }
            if matches_row(&query, &row, request, status) {
                if !budget.push(
                    &mut page,
                    row,
                    budget_cursor,
                    self.snapshot_archived
                        .contains(&key)
                        .then_some(key.as_str()),
                )? {
                    self.more = true;
                    break;
                }
            }
            page.candidates_scanned += 1;
            page.next_cursor = Some(self.cursors[index].clone());
        }
        if !self.more {
            page.next_cursor = None;
        }
        if serde_json::to_vec(&page).map_err(|_| failed())?.len() > PAGE_BYTES {
            return Err(RpcError::invalid_params("A session cursor is too large."));
        }
        Ok(page)
    }
}

fn retry_cursor(raw: &str, proof_key: &str) -> Result<String, RpcError> {
    let mut cursor: Cursor = serde_json::from_str(raw).map_err(|_| failed())?;
    cursor.proof_cache_key = Some(proof_key.into());
    serde_json::to_string(&cursor).map_err(|_| failed())
}

fn enrich_upload(row: &mut LocalSessionRow, upload: Option<&UploadSession>) {
    if let Some((current, upload)) = row.upload.as_mut().zip(upload) {
        current.status = upload.status;
        current.included = upload.included;
        current.avatar = upload.avatar.clone();
    }
}
fn matches_row(
    query: &LocalSessionQuery,
    row: &LocalSessionRow,
    request: &SessionQueryParams,
    status: Option<&crate::session_model::StatusView>,
) -> bool {
    query.matches(
        row,
        if request.preparing(&row.key()) {
            Some(crate::session_model::SessionUploadState::Preparing)
        } else {
            row.upload
                .as_ref()
                .map(|s| crate::session_model::SessionUploadState::of(s, status))
        },
    )
}

mod index;
pub(crate) use index::Index;
mod observation;
pub(crate) use observation::{ExecutionObservation, ObservedSession};

#[cfg(feature = "history")]
mod catalog;
#[cfg(feature = "history")]
pub use catalog::catalog_title;
#[cfg(feature = "history")]
pub(crate) use catalog::{CatalogIndex, CatalogVersion};

fn order_key(value: Option<&str>, key: &str, ascending: bool) -> String {
    let Some(value) = value else {
        return format!("1{key}");
    };
    let mut result = String::from("0");
    use std::fmt::Write;
    for byte in value.bytes() {
        let byte = if ascending { byte } else { !byte };
        let _ = write!(result, "{byte:02x}");
    }
    result.push(if ascending { '!' } else { '~' });
    result.push_str(key);
    result
}

fn page_sql(column: &str, direction: &str, predicate: &str, limit: usize) -> String {
    format!("SELECT key,payload,order_{column}_{direction},archived FROM rows WHERE {predicate} ORDER BY order_{column}_{direction} LIMIT {limit}")
}

#[cfg(test)]
#[path = "session_query/tests/catalog_fixture.rs"]
pub(crate) mod test_catalog;
#[cfg(test)]
mod tests;

fn verification_pending(
    query: &LocalSessionQuery,
    row: &LocalSessionRow,
    status: Option<&crate::session_model::StatusView>,
) -> bool {
    use crate::session_model::SessionUploadState;
    use crate::relay::contract::account::UploadShareStatus;
    let Some(upload) = row
        .upload
        .as_ref()
        .filter(|s| s.included && s.status == UploadShareStatus::Checking)
    else {
        return false;
    };
    if !query
        .terms
        .iter()
        .any(|term| term.field.as_deref() == Some("upload"))
        || query.terms.iter().any(|term| {
            term.field.as_deref() == Some("upload")
                && term.value.eq_ignore_ascii_case("checking")
                && !term.excluded
        })
    {
        return false;
    }
    let matched = query.matches(row, Some(SessionUploadState::of(upload, status)));
    let mut possible = upload.clone();
    [
        UploadShareStatus::Uploaded,
        UploadShareStatus::Queued,
        UploadShareStatus::Uploading,
        UploadShareStatus::Shared,
    ]
    .into_iter()
    .any(|state| {
        possible.status = state;
        query.matches(row, Some(SessionUploadState::of(&possible, status))) != matched
    })
}

mod facets;

mod budget;
