//! Durable Muse admission receipts, separate from courier process ownership.

use super::Receipts;
use crate::relay::muse::MuseConfig;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Reads admission receipts from Muse's own session store under
/// `<data>/muse/sessions/YYYY/MM/DD/<session>/session.jsonl`.
pub struct SystemReceipts {
    sessions_root: PathBuf,
    config: MuseConfig,
}

impl SystemReceipts {
    pub fn new(config: &MuseConfig) -> Self {
        Self {
            sessions_root: config.data_dir.join("sessions"),
            config: config.clone(),
        }
    }

    /// The `session.jsonl` for `session_id`, found in the date-sharded store.
    fn log_path(&self, session_id: &str) -> Option<PathBuf> {
        // sessions/<YYYY>/<MM>/<DD>/<session_id>/session.jsonl
        for year in read_dir_names(&self.sessions_root) {
            let year_dir = self.sessions_root.join(&year);
            for month in read_dir_names(&year_dir) {
                let month_dir = year_dir.join(&month);
                for day in read_dir_names(&month_dir) {
                    let candidate = month_dir.join(&day).join(session_id).join("session.jsonl");
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }
}

fn read_dir_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    // Newest shards first keeps the common case (a session started today)
    // cheap.
    names.sort_unstable_by(|a, b| b.cmp(a));
    names
}

impl Receipts for SystemReceipts {
    fn turn_ended(&self, target_session: &str, receipt_id: &str) -> bool {
        crate::relay::muse::turn_ended(&self.config, target_session, receipt_id)
    }

    fn admitted(
        &self,
        target_session: &str,
        courier_session: &str,
        text: &str,
        _since: Instant,
    ) -> Option<String> {
        let path = self.log_path(target_session)?;
        let data = std::fs::read_to_string(path).ok()?;
        let mut receipt = None;
        for line in data.lines() {
            let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            // `inbox_item_drained` carries the full body, the sender and the
            // Muse message id; its presence means the message is durably in
            // the target session.
            let payload = &record["payload"];
            let event = &payload["event"];
            if event["kind"] != "inbox_item_drained" {
                continue;
            }
            let snapshot = &event["delivery_snapshot"];
            let source = &snapshot["source"];
            let sender_ok = source["sender_session_id"] == *courier_session
                || source["sender_session_name"] == *courier_session;
            // The courier model forwards the text verbatim but may add
            // surrounding whitespace; compare trimmed. Any other alteration
            // leaves the body unmatched, so the send stays in doubt (never a
            // wrong-text delivery).
            let body_ok = snapshot["body"]
                .as_str()
                .is_some_and(|body| body.trim() == text.trim());
            if sender_ok && body_ok {
                if let Some(id) = source["message_id"].as_str() {
                    receipt = Some(id.to_string());
                }
            }
        }
        receipt
    }
}
