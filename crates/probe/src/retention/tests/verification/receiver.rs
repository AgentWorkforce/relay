//! A durable local receiver which really applies tombstones and deduplicates
//! revisions. It has no HTTP client, credentials, or cloud endpoint.
use super::super::*;
use crate::delivery::worker::*;
use crate::delivery::{
    AcceptanceLevel, DeliveryAcknowledgment, DeliveryFailure, HistoryExportBatch, PreparedPayload,
};

pub(super) struct Local {
    root: PathBuf,
    mode: String,
    kinds: Vec<&'static str>,
}

impl Local {
    pub fn new(root: &Path, mode: &str) -> Self {
        Self {
            root: root.into(),
            mode: mode.into(),
            kinds: ai_hist::ChangeKind::ALL
                .iter()
                .map(|k| k.as_str())
                .collect(),
        }
    }
}

impl Receivers for Local {
    fn receiver(&self, destination: &str, _: &str) -> Option<&dyn Receiver> {
        (destination == "w1v-synthetic").then_some(self)
    }
}

impl Receiver for Local {
    fn mapping_version(&self) -> &str {
        "1"
    }
    fn supported_kinds(&self) -> &[&str] {
        &self.kinds
    }
    fn supports_tombstones(&self) -> bool {
        true
    }

    fn prepare(
        &self,
        batch: &HistoryExportBatch,
        _: &ReceiverContext<'_>,
    ) -> Result<PreparedBody, ReceiverFailure> {
        // Survives the killed sender process. Comparing deterministic bytes
        // alone would not detect a restart incorrectly rebuilding the body.
        let conn = Connection::open(self.root.join("receiver.db")).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS preparations(batch_id TEXT PRIMARY KEY,calls INTEGER NOT NULL)").unwrap();
        conn.execute("INSERT INTO preparations VALUES(?1,1) ON CONFLICT(batch_id) DO UPDATE SET calls=calls+1", [&batch.batch_id]).unwrap();
        Ok(PreparedBody {
            content_type: "application/json".into(),
            body: serde_json::to_string(batch).unwrap(),
        })
    }

    fn send(
        &self,
        payload: &PreparedPayload,
        batch: &HistoryExportBatch,
        ctx: &ReceiverContext<'_>,
    ) -> Result<DeliveryAcknowledgment, ReceiverFailure> {
        if self.mode == "upload-fail" {
            return Err(DeliveryFailure::Transient.into());
        }
        let mut conn = Connection::open(self.root.join("receiver.db")).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS attempts(batch_id TEXT,body TEXT);
            CREATE TABLE IF NOT EXISTS applied(revision_id TEXT PRIMARY KEY,operation TEXT);
            CREATE TABLE IF NOT EXISTS copies(record_id TEXT PRIMARY KEY,revision INTEGER,body TEXT);
            PRAGMA synchronous=FULL;").unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO attempts VALUES(?1,?2)",
            params![batch.batch_id, payload.body],
        )
        .unwrap();
        let limit = if matches!(self.mode.as_str(), "upload-partial" | "upload-pause") {
            1
        } else {
            usize::MAX
        };
        let mut accepted = Vec::new();
        for record in batch
            .records
            .iter()
            .filter(|r| !ctx.accepted_revision_ids.contains(&r.revision_id))
            .take(limit)
        {
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO applied VALUES(?1,?2)",
                    params![record.revision_id, record.operation],
                )
                .unwrap();
            if inserted > 0 {
                if record.operation == "delete" {
                    tx.execute(
                        "DELETE FROM copies WHERE record_id=?1 AND revision<=?2",
                        params![record.record_id, record.revision],
                    )
                    .unwrap();
                } else {
                    tx.execute("INSERT INTO copies VALUES(?1,?2,?3) ON CONFLICT(record_id) DO UPDATE SET revision=excluded.revision,body=excluded.body WHERE excluded.revision>copies.revision",params![record.record_id,record.revision,serde_json::to_string(&record.payload).unwrap()]).unwrap();
                }
            }
            accepted.push(record.revision_id.clone());
        }
        tx.commit().unwrap();
        if self.mode == "upload-pause" {
            super::fixture::checkpoint(&self.root);
        }
        Ok(DeliveryAcknowledgment {
            batch_id: batch.batch_id.clone(),
            accepted_revision_ids: accepted,
            unsupported_revision_ids: vec![],
            suppressed_revision_ids: vec![],
            rejected_revision_ids: vec![],
            isolation_frontier: vec![],
            acceptance_level: AcceptanceLevel::Durable,
        })
    }
}
