use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::ids::DeliveryId;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexThreadSession {
    thread_id: String,
    rollout_path: Option<PathBuf>,
    codex_home: Option<PathBuf>,
}

impl CodexThreadSession {
    pub(crate) fn new(thread_id: impl Into<String>, rollout_path: Option<PathBuf>) -> Option<Self> {
        let thread_id = thread_id.into();
        let thread_id = thread_id.trim();
        if !safe_thread_id(thread_id) {
            return None;
        }
        Some(Self {
            thread_id: thread_id.to_string(),
            rollout_path,
            codex_home: None,
        })
    }

    pub(crate) fn with_codex_home(mut self, codex_home: Option<PathBuf>) -> Self {
        self.codex_home = codex_home;
        self
    }

    pub(crate) fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub(crate) fn has_rollout_path(&self) -> bool {
        self.rollout_path.is_some()
    }

    pub(crate) fn marker_for(delivery_id: &DeliveryId) -> String {
        format!("relay-delivery-id:{}", delivery_id.as_str())
    }

    pub(crate) fn body_with_marker(body: &str, delivery_id: &DeliveryId) -> String {
        let marker = Self::marker_for(delivery_id);
        if body.contains(&marker) {
            return body.to_string();
        }
        format!("{body}\n\n<!-- {marker} -->")
    }

    /// What Codex's own records say about a delivery this route queued.
    ///
    /// Two stores, and the difference between them is the difference between
    /// "delivered" and "read":
    ///
    /// * `$CODEX_HOME/queue_1.sqlite` — the table `codex queue` writes to. A
    ///   row here is positive proof the message is durably enqueued against
    ///   the thread. It is NOT proof anybody read it.
    /// * the thread's rollout JSONL — where Codex records the items a turn
    ///   actually consumed. A queued message does not appear here at all until
    ///   the live session picks it up.
    ///
    /// Verified against `codex-cli 0.155.0-alpha.9.2`: after `codex queue` the
    /// marker is present in `queued_items` and absent from every rollout
    /// record, and `thread/items/list` likewise returns only consumed items.
    /// The capture is in
    /// `.workflow-artifacts/migrate-native-delivery/phase-1-codex-queue-20260921a/evidence/codex-capture/`.
    ///
    /// Seam rule 4 is why the two are not collapsed: an acknowledgement has to
    /// name what was observed, and "a row exists in a queue table" is not an
    /// observation that the recipient read anything.
    pub(crate) async fn observe_marker(&self, delivery_id: &DeliveryId) -> CodexMarkerObservation {
        let marker = Self::marker_for(delivery_id);
        let rollout_path = match self.rollout_path.clone() {
            Some(path) => Some(path),
            None => {
                match lookup_thread_record(self.thread_id(), self.codex_home.as_deref()).await {
                    Ok(record) => record.and_then(|record| record.rollout_path),
                    Err(error) => {
                        tracing::warn!(
                            target = "agent_relay::broker",
                            thread_id = %self.thread_id(),
                            error = %error,
                            "Codex state lookup failed while settling queued delivery"
                        );
                        None
                    }
                }
            }
        };
        if let Some(path) = rollout_path {
            if let Some(offset) = find_consumed_marker_offset(&path, &marker).await {
                return CodexMarkerObservation::Consumed {
                    source: path.display().to_string(),
                    offset,
                };
            }
        }
        // Absence from the rollout is not absence from Codex. Ask the queue
        // store before answering, so "still waiting in the queue" is reported
        // as the distinct fact it is rather than as "nothing is known".
        match lookup_queued_marker(self.thread_id(), self.codex_home.as_deref(), &marker).await {
            Ok(Some(source)) => CodexMarkerObservation::Queued { source },
            Ok(None) => CodexMarkerObservation::Unknown,
            Err(error) => {
                tracing::warn!(
                    target = "agent_relay::broker",
                    thread_id = %self.thread_id(),
                    error = %error,
                    "Codex queue lookup failed while settling queued delivery"
                );
                CodexMarkerObservation::Unknown
            }
        }
    }
}

/// What Codex's records show for one queued delivery.
///
/// There is deliberately no variant meaning "the message is not there": a
/// queue store this broker cannot read and a message that was never written
/// look identical from here, and treating the second as the first re-sends a
/// delivered message (seam rule 2). `Unknown` is the floor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CodexMarkerObservation {
    /// The marker appears in the thread's rollout inside a record Codex writes
    /// for a USER INPUT item — i.e. a turn consumed it. This is the only
    /// observation that supports an acknowledgement.
    Consumed { source: String, offset: u64 },
    /// The marker is in Codex's durable queue for this thread and has not been
    /// consumed. Delivered to the transport; not read by anyone.
    Queued { source: String },
    /// Neither store answered. Not absence.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexThreadRecord {
    pub(crate) rollout_path: Option<PathBuf>,
    pub(crate) cwd: Option<PathBuf>,
}

async fn find_consumed_marker_offset(path: &Path, marker: &str) -> Option<u64> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let mut offset = 0u64;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if line
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
            && marker_line_is_consumed_user_input(line, marker)
        {
            return Some(offset);
        }
        offset = offset.saturating_add(line.len() as u64);
    }
    None
}

/// Read Codex's own queue store for a message carrying `marker`.
///
/// This is the table `codex queue` writes: one row per queued item, keyed by
/// thread, with the message body inside `payload_json`. Reading it is what
/// lets settlement say "durably enqueued and not yet read" instead of
/// collapsing that onto "nothing is known".
///
/// Returns the store path when the marker is present, `Ok(None)` when the
/// store is readable and the marker is not in it, and `Err` when the store
/// could not be read at all — which the caller must NOT treat as absence.
async fn lookup_queued_marker(
    thread_id: &str,
    codex_home: Option<&Path>,
    marker: &str,
) -> Result<Option<String>, String> {
    if !safe_thread_id(thread_id) {
        return Err("Codex thread id contains unsupported characters".to_string());
    }
    let Some(db) = codex_queue_db_path(codex_home) else {
        return Ok(None);
    };
    let query = format!(
        "SELECT COALESCE(payload_json, '') FROM queued_items WHERE thread_id = '{}';",
        sql_quote(thread_id)
    );
    let output = tokio::process::Command::new("sqlite3")
        .arg("-readonly")
        .arg(&db)
        .arg(query)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|_| "sqlite3 is unavailable".to_string())?;
    if !output.status.success() {
        return Err("Codex queue lookup failed".to_string());
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| "sqlite3 output was not utf-8")?;
    // The marker is relay-generated and ASCII, so a substring test over the
    // stored payload is sufficient and needs no JSON parse of a vendor shape
    // that may change.
    Ok(stdout.contains(marker).then(|| db.display().to_string()))
}

fn codex_queue_db_path(codex_home: Option<&Path>) -> Option<PathBuf> {
    codex_store_path(codex_home, "queue_1.sqlite")
}

pub(crate) async fn lookup_thread_record(
    thread_id: &str,
    codex_home: Option<&Path>,
) -> Result<Option<CodexThreadRecord>, String> {
    if !safe_thread_id(thread_id) {
        return Err("Codex thread id contains unsupported characters".to_string());
    }
    let Some(db) = codex_state_db_path(codex_home) else {
        return Ok(None);
    };
    tracing::debug!(
        target = "agent_relay::broker",
        thread_id = %thread_id,
        db = %db.display(),
        "looking up Codex rollout path"
    );
    let query = format!(
        "SELECT COALESCE(rollout_path, ''), COALESCE(cwd, '') FROM threads WHERE id = '{}';",
        sql_quote(thread_id)
    );
    let output = tokio::process::Command::new("sqlite3")
        .arg("-readonly")
        .arg("-separator")
        .arg("\t")
        .arg(db)
        .arg(query)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|_| "sqlite3 is unavailable".to_string())?;
    if !output.status.success() {
        return Err("Codex state lookup failed".to_string());
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| "sqlite3 output was not utf-8")?;
    let mut rows = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let Some(first) = rows.next() else {
        return Ok(None);
    };
    if rows.next().is_some() {
        return Err("Codex state returned multiple rows for one thread id".to_string());
    }
    let mut fields = first.splitn(3, '\t');
    let rollout_path = fields
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let cwd = fields
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    Ok(Some(CodexThreadRecord { rollout_path, cwd }))
}

fn codex_state_db_path(codex_home: Option<&Path>) -> Option<PathBuf> {
    codex_store_path(codex_home, "state_5.sqlite")
}

fn codex_store_path(codex_home: Option<&Path>, file_name: &str) -> Option<PathBuf> {
    let home = codex_home.map(PathBuf::from).or_else(|| {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
    })?;
    let root = home.join(file_name);
    if root.is_file() {
        return Some(root);
    }
    let nested = home.join("sqlite").join(file_name);
    nested.is_file().then_some(nested)
}

fn safe_thread_id(thread_id: &str) -> bool {
    !thread_id.is_empty()
        && !thread_id.starts_with('-')
        && thread_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn sql_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// Whether a rollout line is a record Codex wrote for a CONSUMED user input
/// item carrying `marker`.
///
/// Positive, not negative. A filter that only rejects assistant / reasoning /
/// summary records still accepts any future record shape that happens to
/// quote the message back, and seam rule 4 forbids acknowledging on an
/// observation that was never positively identified. The two accepted shapes
/// are the two projections Codex writes for one consumed user item, captured
/// live from `codex-cli 0.155.0-alpha.9.2` (see
/// `evidence/codex-capture/rollout-consumed-user-item.jsonl`):
///
/// ```text
/// {"type":"response_item","payload":{"type":"message","role":"user",
///   "content":[{"type":"input_text","text":"…<marker>…"}]}}
/// {"type":"event_msg","payload":{"type":"item_completed",
///   "item":{"type":"UserMessage","content":[{"type":"text","text":"…<marker>…"}]}}}
/// ```
///
/// The older un-wrapped form (`{"type":"item_completed","item":{…,"role":"user"}}`)
/// is accepted too, so a Codex that predates the `payload` envelope still
/// settles.
fn marker_line_is_consumed_user_input(line: &[u8], marker: &str) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return false;
    };
    // The rollout wraps every record in an envelope whose own `type` is the
    // projection (`response_item` / `event_msg`), never the item kind.
    let record = value.get("payload").unwrap_or(&value);
    for node in [Some(record), record.get("item")].into_iter().flatten() {
        if !json_value_contains_marker(node, marker) {
            continue;
        }
        if json_value_is_non_delivery_artifact(node) {
            continue;
        }
        if node_is_user_input(node) {
            return true;
        }
    }
    false
}

/// The kinds Codex uses for a user-authored input item, across the
/// projections above. Compared lower-cased because the rollout writes
/// `UserMessage` in the event projection and `message` + `role: user` in the
/// response-item projection.
fn node_is_user_input(node: &Value) -> bool {
    let lower = |key: &str| {
        node.get(key)
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase)
    };
    if lower("role").as_deref() == Some("user") {
        return true;
    }
    matches!(
        lower("type").as_deref(),
        Some("usermessage" | "user_message" | "userinput" | "user_input")
    )
}

fn json_value_contains_marker(value: &Value, marker: &str) -> bool {
    match value {
        Value::String(text) => text.contains(marker),
        Value::Array(items) => items
            .iter()
            .any(|item| json_value_contains_marker(item, marker)),
        Value::Object(map) => map
            .values()
            .any(|item| json_value_contains_marker(item, marker)),
        _ => false,
    }
}

fn json_value_is_non_delivery_artifact(value: &Value) -> bool {
    let mut strings = Vec::new();
    collect_schema_strings(value, &mut strings);
    strings.iter().any(|text| {
        matches!(
            text.as_str(),
            "assistant" | "system" | "summary" | "reasoning" | "compacted"
        )
    })
}

fn collect_schema_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for key in ["type", "role", "item_type", "payload_type"] {
                if let Some(text) = map.get(key).and_then(Value::as_str) {
                    out.push(text.to_ascii_lowercase());
                }
            }
            for value in map.values() {
                collect_schema_strings(value, out);
            }
        }
        Value::Array(items) => {
            for value in items {
                collect_schema_strings(value, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_is_stable_and_idempotent() {
        let delivery_id = DeliveryId::new("del_123");
        let body = CodexThreadSession::body_with_marker("hello", &delivery_id);
        assert!(body.contains("hello"));
        assert!(body.contains("relay-delivery-id:del_123"));
        assert_eq!(
            CodexThreadSession::body_with_marker(&body, &delivery_id),
            body
        );
    }

    #[test]
    fn thread_ids_that_look_like_flags_are_rejected() {
        assert!(CodexThreadSession::new("-config", None).is_none());
        assert!(CodexThreadSession::new("thread-1", None).is_some());
    }

    #[test]
    fn codex_state_db_path_uses_target_home_first() {
        let target = tempfile::tempdir().expect("target codex home");
        let broker = tempfile::tempdir().expect("broker codex home");
        let target_db = target.path().join("state_5.sqlite");
        let broker_db = broker.path().join("state_5.sqlite");
        std::fs::write(&target_db, b"target").expect("target db");
        std::fs::write(&broker_db, b"broker").expect("broker db");

        assert_eq!(
            codex_state_db_path(Some(target.path())).as_deref(),
            Some(target_db.as_path())
        );
    }

    /// The two real projections Codex writes for ONE consumed user input item,
    /// captured live from `codex-cli 0.155.0-alpha.9.2` (`codex app-server` →
    /// `thread/start` → `turn/start`). Verbatim apart from the marker text and
    /// shortened ids; see
    /// `evidence/codex-capture/rollout-consumed-user-item.jsonl`.
    fn consumed_user_item_records(marker: &str) -> String {
        format!(
            concat!(
                r#"{{"timestamp":"2026-09-22T18:29:35.389Z","ordinal":8,"type":"response_item","payload":{{"type":"message","id":"msg_01a0ca61","role":"user","content":[{{"type":"input_text","text":"hello from relay\n\n<!-- {marker} -->"}}],"internal_chat_message_metadata_passthrough":{{"turn_id":"01a0ca61-6208","create_time":1790101775.388333,"content_item_kinds":["user.text"]}}}}}}"#,
                "\n",
                r#"{{"timestamp":"2026-09-22T18:29:35.389Z","ordinal":9,"type":"event_msg","payload":{{"type":"item_completed","thread_id":"01a0ca61-60fd","turn_id":"01a0ca61-6208","item":{{"type":"UserMessage","id":"01a0ca61-641d","content":[{{"type":"text","text":"hello from relay\n\n<!-- {marker} -->","text_elements":[]}}]}},"started_at_ms":1790101775389,"completed_at_ms":1790101775389}}}}"#,
                "\n",
            ),
            marker = marker
        )
    }

    /// An isolated `CODEX_HOME` with no queue store, so a test that reaches the
    /// queue lookup cannot read the operator's real `~/.codex`.
    fn empty_codex_home() -> tempfile::TempDir {
        tempfile::tempdir().expect("codex home")
    }

    /// Write a `queue_1.sqlite` shaped like the one `codex queue` writes.
    fn write_queue_db(home: &std::path::Path, thread_id: &str, payload: &str) {
        let db = home.join("queue_1.sqlite");
        let status = std::process::Command::new("sqlite3")
            .arg(&db)
            .arg(format!(
                "CREATE TABLE queued_items (id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, \
                 payload_json TEXT NOT NULL, queue_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, \
                 updated_at_ms INTEGER NOT NULL); \
                 INSERT INTO queued_items VALUES ('item-1', '{thread_id}', '{payload}', 0, 0, 0);"
            ))
            .status()
            .expect("sqlite3 must be available to build the queue fixture");
        assert!(status.success(), "failed to build queue fixture");
    }

    #[tokio::test]
    async fn a_consumed_user_item_is_observed_in_both_real_projections() {
        for (index, record) in consumed_user_item_records("relay-delivery-id:del_seen")
            .lines()
            .enumerate()
        {
            let home = empty_codex_home();
            let path = home.path().join("session.jsonl");
            std::fs::write(&path, format!("{{\"text\":\"before\"}}\n{record}\n"))
                .expect("write session");
            let session = CodexThreadSession::new("thread-1", Some(path))
                .expect("session")
                .with_codex_home(Some(home.path().to_path_buf()));

            let observed = session.observe_marker(&DeliveryId::new("del_seen")).await;

            let CodexMarkerObservation::Consumed { offset, .. } = observed else {
                panic!("real consumed projection {index} must be observed, got {observed:?}");
            };
            assert!(offset > 0);
        }
    }

    /// The shape `codex queue` ACTUALLY produces before anybody reads the
    /// message: a row in `queued_items`, and nothing in the rollout.
    ///
    /// This is the negative case F3 asks for. Settlement must report the
    /// message as queued — never as acknowledged — because no turn has
    /// consumed it and a read receipt would name a reader who does not exist.
    #[tokio::test]
    async fn a_queued_but_unconsumed_message_is_queued_not_consumed() {
        let home = empty_codex_home();
        let thread_id = "01a0ca61-60fd-7492-a02d-a014d386db12";
        let path = home.path().join("session.jsonl");
        // The real rollout after `codex queue`: session records only, no marker.
        std::fs::write(
            &path,
            b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        )
        .expect("write session");
        write_queue_db(
            home.path(),
            thread_id,
            r#"{"UserInput":{"content":[{"type":"text","text":"hello from relay\n\n<!-- relay-delivery-id:del_queued -->"}],"client_id":"01a0ca61-627d"}}"#,
        );
        let session = CodexThreadSession::new(thread_id, Some(path))
            .expect("session")
            .with_codex_home(Some(home.path().to_path_buf()));

        assert_eq!(
            session.observe_marker(&DeliveryId::new("del_queued")).await,
            CodexMarkerObservation::Queued {
                source: home.path().join("queue_1.sqlite").display().to_string(),
            }
        );
    }

    /// Rule 4: an assistant record that quotes the delivery back is not an
    /// observation that the recipient read it, and neither is any record whose
    /// kind the matcher cannot positively identify as a user input item.
    #[tokio::test]
    async fn a_quoted_marker_in_a_non_user_record_is_not_an_acknowledgement() {
        for record in [
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"you said <!-- relay-delivery-id:del_quoted -->"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"<!-- relay-delivery-id:del_quoted -->"}]}}"#,
            // The synthetic shape the phase's original settlement fixture used.
            // No Codex version emits it, and it names no item kind, so it must
            // not settle either.
            r#"{"text":"<!-- relay-delivery-id:del_quoted -->"}"#,
        ] {
            let home = empty_codex_home();
            let path = home.path().join("session.jsonl");
            std::fs::write(&path, format!("{record}\n")).expect("write session");
            let session = CodexThreadSession::new("thread-1", Some(path))
                .expect("session")
                .with_codex_home(Some(home.path().to_path_buf()));

            assert_eq!(
                session.observe_marker(&DeliveryId::new("del_quoted")).await,
                CodexMarkerObservation::Unknown,
                "record must not acknowledge: {record}"
            );
        }
    }

    #[tokio::test]
    async fn missing_marker_is_unknown_not_absent() {
        let home = empty_codex_home();
        let path = home.path().join("session.jsonl");
        std::fs::write(&path, br#"{"text":"different"}"#).expect("write session");
        let session = CodexThreadSession::new("thread-1", Some(path))
            .expect("session")
            .with_codex_home(Some(home.path().to_path_buf()));

        assert_eq!(
            session
                .observe_marker(&DeliveryId::new("del_missing"))
                .await,
            CodexMarkerObservation::Unknown
        );
    }
}
