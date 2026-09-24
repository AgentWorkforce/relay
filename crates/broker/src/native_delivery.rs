//! Durable delivery into an already-running native harness session.
//!
//! The receipt is written before the broker writes to the worker. Once that
//! boundary is crossed, every retry with the same `delivery_id` is a read-only
//! lookup: an interrupted or failed write is in doubt and is never replayed.

use std::{collections::BTreeMap, future::Future, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    ids::{DeliveryId, EventId, MessageTarget, WorkerName},
    protocol::{MessageInjectionMode, RelayDelivery},
    worker::WorkerRegistry,
};

pub(crate) const NATIVE_EXISTING_SESSION_CAPABILITY: &str = "relay:native-existing-session:v1";
pub(crate) const NATIVE_EXISTING_SESSION_RECONCILE_CAPABILITY: &str =
    "relay:native-existing-session-reconcile:v1";
const MAX_MESSAGE_BYTES: usize = 128 * 1024;
const MAX_RECEIPTS: usize = 100_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeExistingSessionDelivery {
    pub(crate) relay_agent_name: String,
    pub(crate) session_id: String,
    pub(crate) delivery_id: String,
    pub(crate) lineage_id: String,
    pub(crate) head_sha: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeExistingSessionReconcile {
    pub(crate) relay_agent_name: String,
    pub(crate) session_id: String,
    pub(crate) delivery_id: String,
    pub(crate) lineage_id: String,
    pub(crate) head_sha: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum NativeReceiptState {
    /// The durable cancellation boundary was crossed. The worker write may or
    /// may not have completed, so replay is forbidden.
    InDoubt,
    /// The worker's sole stdin writer confirmed the complete protocol frame.
    Queued,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct NativeDeliveryReceipt {
    receipt_id: String,
    delivery_id: String,
    relay_agent_name: String,
    session_id: String,
    lineage_id: String,
    head_sha: String,
    request_digest: String,
    state: NativeReceiptState,
    recorded_at_ms: u64,
}

impl NativeDeliveryReceipt {
    pub(crate) fn receipt_id(&self) -> &str {
        &self.receipt_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeDeliveryDisposition {
    Queued,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeDeliveryOutcome {
    pub(crate) receipt_id: String,
    pub(crate) disposition: NativeDeliveryDisposition,
}

#[derive(Debug, Error)]
pub(crate) enum NativeDeliveryError {
    #[error("invalid_native_delivery: {0}")]
    Invalid(String),
    #[error("native_delivery_conflict: delivery id is already bound to different input")]
    Conflict,
    #[error("native_session_unauthorized: {0}")]
    Unauthorized(String),
    #[error("native_delivery_receipt_unavailable: {0}")]
    ReceiptUnavailable(String),
    #[error("native_delivery_in_doubt: {0}")]
    InDoubt(String),
}

impl NativeDeliveryError {
    pub(crate) fn committed(&self) -> bool {
        matches!(self, Self::InDoubt(_))
    }

    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid_native_delivery",
            Self::Conflict => "native_delivery_conflict",
            Self::Unauthorized(_) => "native_session_unauthorized",
            Self::ReceiptUnavailable(_) => "native_delivery_receipt_unavailable",
            Self::InDoubt(_) => "native_delivery_in_doubt",
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct NativeDeliveryLedger {
    #[serde(default)]
    receipts: BTreeMap<String, NativeDeliveryReceipt>,
}

impl NativeExistingSessionDelivery {
    pub(crate) fn validate(&self) -> Result<(), NativeDeliveryError> {
        validate_identifier(&self.relay_agent_name, "relayAgentName")?;
        validate_identifier(&self.session_id, "sessionId")?;
        validate_identifier(&self.delivery_id, "deliveryId")?;
        validate_identifier(&self.lineage_id, "lineageId")?;
        if self.head_sha.len() != 40 || !self.head_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(NativeDeliveryError::Invalid(
                "headSha must be a 40-character hexadecimal commit id".to_string(),
            ));
        }
        if self.message.trim().is_empty() {
            return Err(NativeDeliveryError::Invalid(
                "message must not be empty".to_string(),
            ));
        }
        if self.message.len() > MAX_MESSAGE_BYTES {
            return Err(NativeDeliveryError::Invalid(format!(
                "message exceeds the {MAX_MESSAGE_BYTES}-byte limit"
            )));
        }
        Ok(())
    }

    pub(crate) fn relay_delivery(&self) -> RelayDelivery {
        RelayDelivery {
            delivery_id: DeliveryId::new(self.delivery_id.clone()),
            event_id: EventId::new(self.delivery_id.clone()),
            workspace_id: None,
            workspace_alias: None,
            from: "cloud-babysitter".to_string(),
            target: MessageTarget::new(self.relay_agent_name.clone()),
            body: self.message.clone(),
            thread_id: None,
            priority: None,
            // `wait` maps to the native session's `on-idle` mode. A Babysitter
            // wake-up must not interrupt an active coding turn.
            injection_mode: MessageInjectionMode::Wait,
        }
    }

    fn request_digest(&self) -> String {
        digest(&serde_json::json!([
            self.relay_agent_name,
            self.session_id,
            self.delivery_id,
            self.lineage_id,
            self.head_sha,
            self.message,
        ]))
    }

    fn receipt(&self) -> NativeDeliveryReceipt {
        NativeDeliveryReceipt {
            receipt_id: format!("ndr_{}", digest(&self.delivery_id)),
            delivery_id: self.delivery_id.clone(),
            relay_agent_name: self.relay_agent_name.clone(),
            session_id: self.session_id.clone(),
            lineage_id: self.lineage_id.clone(),
            head_sha: self.head_sha.clone(),
            request_digest: self.request_digest(),
            state: NativeReceiptState::InDoubt,
            recorded_at_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
        }
    }
}

impl NativeExistingSessionReconcile {
    pub(crate) fn validate(&self) -> Result<(), NativeDeliveryError> {
        validate_identifier(&self.relay_agent_name, "relayAgentName")?;
        validate_identifier(&self.session_id, "sessionId")?;
        validate_identifier(&self.delivery_id, "deliveryId")?;
        validate_identifier(&self.lineage_id, "lineageId")?;
        if self.head_sha.len() != 40 || !self.head_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(NativeDeliveryError::Invalid(
                "headSha must be a 40-character hexadecimal commit id".to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_identifier(value: &str, field: &str) -> Result<(), NativeDeliveryError> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(NativeDeliveryError::Invalid(format!(
            "{field} must be a non-empty bounded identifier"
        )));
    }
    Ok(())
}

fn digest(value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("native delivery digest input is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

fn load_ledger(path: &Path) -> Result<NativeDeliveryLedger, NativeDeliveryError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            NativeDeliveryError::ReceiptUnavailable(format!(
                "could not parse {}: {error}",
                path.display()
            ))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(NativeDeliveryLedger::default())
        }
        Err(error) => Err(NativeDeliveryError::ReceiptUnavailable(format!(
            "could not read {}: {error}",
            path.display()
        ))),
    }
}

fn save_ledger(path: &Path, ledger: &NativeDeliveryLedger) -> Result<(), NativeDeliveryError> {
    crate::util::fs::write_json_atomic(path, ledger).map_err(|error| {
        NativeDeliveryError::ReceiptUnavailable(format!(
            "could not persist {}: {error}",
            path.display()
        ))
    })
}

/// Return the existing receipt for an exact duplicate. A delivery id reused
/// with any different field is a conflict, never an authorization to resend.
pub(crate) fn existing_receipt(
    path: &Path,
    input: &NativeExistingSessionDelivery,
) -> Result<Option<NativeDeliveryReceipt>, NativeDeliveryError> {
    input.validate()?;
    let ledger = load_ledger(path)?;
    let Some(receipt) = ledger.receipts.get(&input.delivery_id) else {
        return Ok(None);
    };
    if receipt.request_digest != input.request_digest() {
        return Err(NativeDeliveryError::Conflict);
    }
    Ok(Some(receipt.clone()))
}

/// Reserve an exact delivery durably, then perform its one permitted worker
/// write. The reservation remains `in_doubt` after every post-reservation
/// failure so a caller can reconcile but can never cause a second write.
pub(crate) async fn reserve_and_deliver<F, Fut>(
    path: &Path,
    input: &NativeExistingSessionDelivery,
    send: F,
) -> Result<NativeDeliveryOutcome, NativeDeliveryError>
where
    F: FnOnce(RelayDelivery) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    if let Some(receipt) = existing_receipt(path, input)? {
        return Ok(NativeDeliveryOutcome {
            receipt_id: receipt.receipt_id,
            disposition: NativeDeliveryDisposition::Duplicate,
        });
    }

    let mut ledger = load_ledger(path)?;
    if ledger.receipts.len() >= MAX_RECEIPTS {
        return Err(NativeDeliveryError::ReceiptUnavailable(format!(
            "native delivery receipt capacity ({MAX_RECEIPTS}) is exhausted"
        )));
    }
    let receipt = input.receipt();
    ledger
        .receipts
        .insert(input.delivery_id.clone(), receipt.clone());
    // This is the cancellation boundary. No worker write may occur unless this
    // exact reservation is durable on disk first.
    save_ledger(path, &ledger)?;

    if let Err(error) = send(input.relay_delivery()).await {
        return Err(NativeDeliveryError::InDoubt(error.to_string()));
    }

    let stored = ledger
        .receipts
        .get_mut(&input.delivery_id)
        .expect("receipt inserted before worker write");
    stored.state = NativeReceiptState::Queued;
    // Failure here is still in doubt: the durable write-ahead record remains
    // authoritative and a retry will return it without another worker write.
    save_ledger(path, &ledger).map_err(|error| NativeDeliveryError::InDoubt(error.to_string()))?;
    Ok(NativeDeliveryOutcome {
        receipt_id: receipt.receipt_id,
        disposition: NativeDeliveryDisposition::Queued,
    })
}

pub(crate) fn reconcile_receipt(
    path: &Path,
    input: &NativeExistingSessionReconcile,
) -> Result<Option<NativeDeliveryReceipt>, NativeDeliveryError> {
    input.validate()?;
    let ledger = load_ledger(path)?;
    let Some(receipt) = ledger.receipts.get(&input.delivery_id) else {
        return Ok(None);
    };
    if receipt.relay_agent_name != input.relay_agent_name
        || receipt.session_id != input.session_id
        || receipt.lineage_id != input.lineage_id
        || receipt.head_sha != input.head_sha
    {
        return Err(NativeDeliveryError::Conflict);
    }
    Ok(Some(receipt.clone()))
}

pub(crate) fn worker_name(input: &NativeExistingSessionDelivery) -> WorkerName {
    WorkerName::new(input.relay_agent_name.clone())
}

/// Production bridge shared by the authenticated local listener and the
/// Relaycast Fleet action. Authorization happens at the final broker hop, after
/// exact-duplicate reconciliation but before the first durable reservation.
pub(crate) async fn deliver_authorized(
    workers: &mut WorkerRegistry,
    path: &Path,
    input: &NativeExistingSessionDelivery,
) -> Result<NativeDeliveryOutcome, NativeDeliveryError> {
    if let Some(receipt) = existing_receipt(path, input)? {
        return Ok(NativeDeliveryOutcome {
            receipt_id: receipt.receipt_id,
            disposition: NativeDeliveryDisposition::Duplicate,
        });
    }
    let name = worker_name(input);
    workers
        .authorize_native_existing_session(&name, &input.session_id)
        .map_err(|error| NativeDeliveryError::Unauthorized(error.to_string()))?;
    reserve_and_deliver(path, input, |delivery| {
        workers.deliver(name.as_str(), delivery)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use super::*;

    fn delivery(id: &str) -> NativeExistingSessionDelivery {
        NativeExistingSessionDelivery {
            relay_agent_name: "garden-coder".to_string(),
            session_id: "native-session-1".to_string(),
            delivery_id: id.to_string(),
            lineage_id: "lineage-1".to_string(),
            head_sha: "a".repeat(40),
            message: "Review the exact live head".to_string(),
        }
    }

    #[tokio::test]
    async fn writes_ahead_and_never_resends_an_ambiguous_delivery() {
        let dir = tempfile::tempdir().expect("receipt dir");
        let path = dir.path().join("receipts.json");
        let writes = Arc::new(AtomicUsize::new(0));
        let first_writes = Arc::clone(&writes);
        let reserved_path = path.clone();

        let error = reserve_and_deliver(&path, &delivery("bst_1"), move |_| {
            assert!(
                reserved_path.exists(),
                "write-ahead receipt must exist before the worker callback"
            );
            first_writes.fetch_add(1, Ordering::SeqCst);
            async { anyhow::bail!("writer outcome unknown") }
        })
        .await
        .expect_err("ambiguous write should fail");
        assert!(error.committed());

        let retry_writes = Arc::clone(&writes);
        let retry = reserve_and_deliver(&path, &delivery("bst_1"), move |_| {
            retry_writes.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        })
        .await
        .expect("retry should reconcile the write-ahead receipt");
        assert_eq!(retry.disposition, NativeDeliveryDisposition::Duplicate);
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn exact_duplicate_is_idempotent_but_changed_input_conflicts() {
        let dir = tempfile::tempdir().expect("receipt dir");
        let path = dir.path().join("receipts.json");
        let writes = Arc::new(AtomicUsize::new(0));
        let first_writes = Arc::clone(&writes);
        let first = reserve_and_deliver(&path, &delivery("bst_2"), move |_| {
            first_writes.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        })
        .await
        .expect("first delivery");
        assert_eq!(first.disposition, NativeDeliveryDisposition::Queued);

        let duplicate = reserve_and_deliver(&path, &delivery("bst_2"), |_| async { Ok(()) })
            .await
            .expect("duplicate delivery");
        assert_eq!(duplicate.disposition, NativeDeliveryDisposition::Duplicate);

        let mut changed = delivery("bst_2");
        changed.message = "different authority".to_string();
        assert!(matches!(
            reserve_and_deliver(&path, &changed, |_| async { Ok(()) }).await,
            Err(NativeDeliveryError::Conflict)
        ));
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn restart_reloads_the_durable_receipt_and_reconciliation_is_exact() {
        let dir = tempfile::tempdir().expect("receipt dir");
        let path = dir.path().join("receipts.json");
        let request = delivery("bst_3");
        let queued = reserve_and_deliver(&path, &request, |_| async { Ok(()) })
            .await
            .expect("first delivery");

        let reconcile = NativeExistingSessionReconcile {
            relay_agent_name: request.relay_agent_name.clone(),
            session_id: request.session_id.clone(),
            delivery_id: request.delivery_id.clone(),
            lineage_id: request.lineage_id.clone(),
            head_sha: request.head_sha.clone(),
        };
        let restored = reconcile_receipt(&path, &reconcile)
            .expect("reconcile")
            .expect("durable receipt");
        assert_eq!(restored.receipt_id(), queued.receipt_id);

        let mismatched = NativeExistingSessionReconcile {
            session_id: "replacement-session".to_string(),
            ..reconcile
        };
        assert!(matches!(
            reconcile_receipt(&path, &mismatched),
            Err(NativeDeliveryError::Conflict)
        ));
    }

    #[test]
    fn invalid_inputs_fail_before_receipt_creation() {
        let dir = tempfile::tempdir().expect("receipt dir");
        let path = dir.path().join("receipts.json");
        let mut input = delivery("bst_bad");
        input.head_sha = "not-a-sha".to_string();
        assert!(matches!(
            existing_receipt(&path, &input),
            Err(NativeDeliveryError::Invalid(_))
        ));
        assert!(!path.exists());
    }
}
