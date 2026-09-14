//! Durable, single-writer task ownership/outbox. RuntimePaths holds the broker lock.
use super::*;
use crate::fleet_wire::{
    ActionAccept, ActionInvoke, ActionResult, ActionResultError, ActionResultOutput,
    ActionResultPayload, TaskResultFields, FLEET_WIRE_VERSION,
};
use std::collections::BTreeMap;

pub(super) const TASK_ACTION: &str = "task.run";
pub(super) const TASK_REQUEST_PREFIX: &str = "task_receipt_";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TaskFinal {
    pub output: Option<Value>,
    pub error: Option<String>,
    pub accounting: Option<BTreeMap<String, f64>>,
}

// JavaScript JSON receipts can normalize 17.0 to 17. Compare JSON numbers
// by their wire numeric value, not serde_json's internal integer/float variant.
pub(super) fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| json_equal(value, other)))
        }
        _ => left == right,
    }
}
impl PartialEq for TaskFinal {
    fn eq(&self, other: &Self) -> bool {
        self.error == other.error
            && self.accounting == other.accounting
            && match (&self.output, &other.output) {
                (Some(a), Some(b)) => json_equal(a, b),
                (None, None) => true,
                _ => false,
            }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TaskRecord {
    pub invoke: ActionInvoke,
    pub name: WorkerName,
    pub generation: Uuid,
    pub callback_token: String,
    /// Written before any attempt to create a process. Never cleared on restart.
    pub launch_claimed: bool,
    pub final_result: Option<TaskFinal>,
    pub receipt: Option<Value>,
    #[serde(default)]
    pub rejection: Option<String>,
}

impl TaskRecord {
    pub fn execution(&self) -> &crate::fleet_wire::TaskExecution {
        self.invoke
            .task_execution
            .as_ref()
            .expect("validated task record")
    }
    pub fn accept(&self, id: String) -> ActionAccept {
        ActionAccept {
            v: FLEET_WIRE_VERSION,
            id,
            invocation_id: self.invoke.invocation_id.clone(),
            execution_id: self.execution().execution_id.clone(),
            worker_generation: self.generation.to_string(),
        }
    }
    pub fn result(&self, id: String, value: &TaskFinal, final_result: bool) -> ActionResult {
        ActionResult {
            v: FLEET_WIRE_VERSION,
            id: Some(id),
            invocation_id: self.invoke.invocation_id.clone(),
            result: match &value.error {
                Some(error) => ActionResultPayload::Error(ActionResultError {
                    error: error.clone(),
                }),
                None => ActionResultPayload::Output(ActionResultOutput {
                    output: value.output.clone().unwrap_or(Value::Null),
                }),
            },
            task: Some(TaskResultFields {
                final_result,
                execution_id: self.execution().execution_id.clone(),
                worker_generation: self.generation.to_string(),
                accounting: value.accounting.as_ref().map(|values| {
                    values
                        .iter()
                        .map(|(key, value)| {
                            (
                                key.clone(),
                                serde_json::Number::from_f64(*value)
                                    .expect("validated finite accounting"),
                            )
                        })
                        .collect()
                }),
            }),
        }
    }
    pub fn expired(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.execution().deadline)
            .map_or(true, |deadline| deadline <= chrono::Utc::now())
    }
}

#[derive(Default)]
pub(super) struct TaskStore {
    path: Option<PathBuf>,
    poisoned: bool,
    pub records: BTreeMap<String, TaskRecord>,
}

impl TaskStore {
    pub fn open(path: PathBuf) -> Result<Self> {
        let records: BTreeMap<String, TaskRecord> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("invalid durable task ledger")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };
        for (id, record) in &records {
            anyhow::ensure!(
                id == &record.invoke.invocation_id,
                "task ledger identity mismatch"
            );
            validate_invoke(&record.invoke)?;
        }
        Ok(Self {
            path: Some(path),
            records,
            poisoned: false,
        })
    }
    pub fn enabled(&self) -> bool {
        self.path.is_some() && !self.poisoned
    }
    fn put(&mut self, record: TaskRecord) -> Result<()> {
        anyhow::ensure!(
            !self.poisoned,
            "task ledger requires reopen after a failed durable write"
        );
        let path = self
            .path
            .as_ref()
            .context("durable task provider is disabled")?;
        let mut next = self.records.clone();
        next.insert(record.invoke.invocation_id.clone(), record);
        let persisted = (|| -> Result<()> {
            crate::util::fs::write_json_atomic(path, &next)?;
            // Task receipts require the rename itself to be durable, not best effort.
            #[cfg(unix)]
            std::fs::File::open(path.parent().context("task ledger has no parent")?)?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = persisted {
            self.poisoned = true;
            return Err(error);
        }
        self.records = next;
        Ok(())
    }
    pub fn prepare(&mut self, invoke: ActionInvoke) -> Result<TaskRecord> {
        anyhow::ensure!(self.enabled(), "durable task provider is unavailable");
        validate_invoke(&invoke)?;
        if let Some(existing) = self.records.get(&invoke.invocation_id) {
            if existing.invoke == invoke {
                return Ok(existing.clone());
            }
            let mut prior = existing.invoke.clone();
            prior.task_execution = invoke.task_execution.clone();
            anyhow::ensure!(
                prior == invoke
                    && existing.execution().run_id
                        == invoke.task_execution.as_ref().unwrap().run_id
                    && existing.execution().step_id
                        == invoke.task_execution.as_ref().unwrap().step_id
                    && existing.execution().dispatch_id
                        == invoke.task_execution.as_ref().unwrap().dispatch_id
                    && existing.execution().deadline
                        == invoke.task_execution.as_ref().unwrap().deadline,
                "task_invocation_conflict"
            );
            anyhow::ensure!(
                !existing.launch_claimed
                    && existing.final_result.is_none()
                    && existing.receipt.is_none(),
                "task_execution_already_claimed"
            );
        }
        let generation = Uuid::new_v4();
        let name = WorkerName::new(format!("task-{}", &generation.simple().to_string()[..16]));
        let record = TaskRecord {
            invoke,
            name,
            generation,
            callback_token: format!("arr_{}", Uuid::new_v4().simple()),
            launch_claimed: false,
            final_result: None,
            receipt: None,
            rejection: None,
        };
        self.put(record.clone())?;
        Ok(record)
    }
    pub fn by_token(&self, token: &str) -> Option<&TaskRecord> {
        self.records
            .values()
            .find(|record| record.callback_token == token)
    }
    pub fn claim_launch(&mut self, id: &str) -> Result<Option<TaskRecord>> {
        let mut record = self.records.get(id).context("unknown task")?.clone();
        if record.launch_claimed
            || record.final_result.is_some()
            || record.receipt.is_some()
            || record.expired()
        {
            return Ok(None);
        }
        record.launch_claimed = true;
        self.put(record.clone())?;
        Ok(Some(record))
    }
    pub fn queue_final(&mut self, id: &str, value: TaskFinal) -> Result<TaskRecord> {
        anyhow::ensure!(
            value.error.is_some() != value.output.is_some(),
            "task result needs output or error"
        );
        anyhow::ensure!(
            value
                .error
                .as_ref()
                .is_none_or(|error| !error.trim().is_empty()),
            "empty task failure"
        );
        anyhow::ensure!(
            value
                .accounting
                .as_ref()
                .is_none_or(|a| a.values().all(|n| n.is_finite() && *n >= 0.0)),
            "invalid task accounting"
        );
        let mut record = self.records.get(id).context("unknown task")?.clone();
        if let Some(existing) = &record.final_result {
            anyhow::ensure!(existing == &value, "task_result_conflict");
            return Ok(record);
        }
        anyhow::ensure!(record.receipt.is_none(), "task_already_terminal");
        record.final_result = Some(value);
        self.put(record.clone())?;
        Ok(record)
    }
    pub fn reject(&mut self, id: &str, reason: String) -> Result<()> {
        let mut record = self.records.get(id).context("unknown task")?.clone();
        record.rejection = Some(reason);
        self.put(record)
    }
    pub fn finish(&mut self, id: &str, mut receipt: Value) -> Result<TaskRecord> {
        let mut record = self.records.get(id).context("unknown task")?.clone();
        validate_receipt(&record, &receipt)?;
        if let Some(object) = receipt.as_object_mut() {
            object.remove("newly_accepted");
        }
        anyhow::ensure!(
            matches!(
                receipt.get("status").and_then(Value::as_str),
                Some("completed" | "failed")
            ),
            "nonterminal task receipt"
        );
        if let Some(previous) = &record.receipt {
            anyhow::ensure!(json_equal(previous, &receipt), "task_receipt_conflict");
            return Ok(record);
        }
        record.receipt = Some(receipt);
        self.put(record.clone())?;
        Ok(record)
    }
}

pub(super) fn validate_invoke(invoke: &ActionInvoke) -> Result<()> {
    anyhow::ensure!(
        invoke.action == TASK_ACTION && !invoke.invocation_id.is_empty(),
        "invalid task action"
    );
    let execution = invoke
        .task_execution
        .as_ref()
        .context("missing task execution fence")?;
    anyhow::ensure!(
        !execution.execution_id.is_empty(),
        "missing execution identity"
    );
    chrono::DateTime::parse_from_rfc3339(&execution.deadline).context("invalid task deadline")?;
    let context = invoke
        .input
        .get("task_context")
        .context("missing task context")?;
    for (key, expected) in [
        ("run_id", &execution.run_id),
        ("step_id", &execution.step_id),
        ("dispatch_id", &execution.dispatch_id),
    ] {
        anyhow::ensure!(
            !expected.is_empty()
                && context.get(key).and_then(Value::as_str) == Some(expected.as_str()),
            "task correlation mismatch"
        );
    }
    Ok(())
}

pub(super) fn validate_receipt(record: &TaskRecord, receipt: &Value) -> Result<()> {
    anyhow::ensure!(
        receipt.get("invocation_id").and_then(Value::as_str)
            == Some(record.invoke.invocation_id.as_str()),
        "receipt invocation mismatch"
    );
    anyhow::ensure!(
        receipt.get("action_name").and_then(Value::as_str) == Some(TASK_ACTION),
        "receipt action mismatch"
    );
    let execution = receipt
        .get("task_execution")
        .context("receipt missing execution")?;
    anyhow::ensure!(
        execution.get("execution_id").and_then(Value::as_str)
            == Some(record.execution().execution_id.as_str()),
        "receipt execution mismatch"
    );
    for (key, value) in [
        ("run_id", &record.execution().run_id),
        ("step_id", &record.execution().step_id),
        ("dispatch_id", &record.execution().dispatch_id),
        ("deadline", &record.execution().deadline),
    ] {
        anyhow::ensure!(
            execution.get(key).and_then(Value::as_str) == Some(value.as_str()),
            "receipt correlation mismatch"
        );
    }
    let generation = record.generation.to_string();
    // An invocation can expire before acceptance, when no generation is bound.
    let expired_unaccepted = receipt.get("status").and_then(Value::as_str) == Some("failed")
        && receipt.get("error").and_then(Value::as_str) == Some("task_deadline_exceeded")
        && execution.get("worker_generation").is_none();
    anyhow::ensure!(
        expired_unaccepted
            || execution.get("worker_generation").and_then(Value::as_str)
                == Some(generation.as_str()),
        "receipt generation mismatch"
    );
    Ok(())
}

#[cfg(test)]
pub(super) fn fixture_invoke() -> ActionInvoke {
    serde_json::from_value(json!({"v":1,"type":"action.invoke","invocation_id":"inv-task","action":"task.run",
        "input":{"task":"answer","task_context":{"run_id":"run","step_id":"step","dispatch_id":"dispatch","timeout_ms":120000}},
        "task_execution":{"execution_id":"inv-task/1","run_id":"run","step_id":"step","dispatch_id":"dispatch",
        "deadline":(chrono::Utc::now()+chrono::Duration::minutes(2)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}})
        .as_object().unwrap().iter().filter(|(key,_)|key.as_str() != "type").map(|(k,v)|(k.clone(),v.clone())).collect::<serde_json::Map<String,Value>>().into()).unwrap()
}

#[cfg(test)]
pub(super) fn fixture_receipt(record: &TaskRecord, status: &str) -> Value {
    let mut execution = serde_json::to_value(record.execution()).unwrap();
    execution["worker_generation"] = json!(record.generation.to_string());
    execution["accepted_at"] = json!("2026-01-01T00:00:00.000Z");
    if let Some(accounting) = record
        .final_result
        .as_ref()
        .and_then(|result| result.accounting.as_ref())
    {
        execution["accounting"] = json!(accounting);
    }
    json!({"invocation_id":record.invoke.invocation_id,"action_name":"task.run","status":status,
        "task_execution":execution,"output":record.final_result.as_ref().and_then(|result|result.output.clone()),
        "error":record.final_result.as_ref().and_then(|result|result.error.clone()),
        "completed_at":if status == "running" { Value::Null } else { json!("2026-01-01T00:01:00.000Z") }})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn value() -> TaskFinal {
        TaskFinal {
            output: Some(json!({"answer":42})),
            error: None,
            accounting: None,
        }
    }
    #[test]
    fn task_store_prepared_and_claimed_launch_survive_reopen_without_a_second_claim() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.json");
        let mut store = TaskStore::open(path.clone()).unwrap();
        let original = store.prepare(fixture_invoke()).unwrap();
        let mut reopened = TaskStore::open(path.clone()).unwrap();
        assert_eq!(
            reopened
                .prepare(original.invoke.clone())
                .unwrap()
                .generation,
            original.generation
        );
        assert!(reopened
            .claim_launch(&original.invoke.invocation_id)
            .unwrap()
            .is_some());
        let mut restarted = TaskStore::open(path).unwrap();
        assert!(restarted
            .claim_launch(&original.invoke.invocation_id)
            .unwrap()
            .is_none());
        assert_eq!(
            restarted.records[&original.invoke.invocation_id].callback_token,
            original.callback_token
        );
    }
    #[test]
    fn task_store_changed_input_and_claimed_attempt_cannot_replace_execution() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = TaskStore::open(directory.path().join("tasks.json")).unwrap();
        let original = store.prepare(fixture_invoke()).unwrap();
        let mut changed = original.invoke.clone();
        changed.input["task"] = json!("different");
        assert!(store.prepare(changed).is_err());
        let mut retried = original.invoke.clone();
        retried.task_execution.as_mut().unwrap().execution_id = "inv-task/2".into();
        let replacement = store.prepare(retried).unwrap();
        assert_ne!(replacement.generation, original.generation);
        store
            .claim_launch(&replacement.invoke.invocation_id)
            .unwrap();
        assert!(store.prepare(original.invoke).is_err());
        assert_eq!(store.records["inv-task"].generation, replacement.generation);
    }
    #[test]
    fn task_store_final_outbox_and_receipt_reconcile_after_restart_and_ack_loss() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.json");
        let mut store = TaskStore::open(path.clone()).unwrap();
        let original = store.prepare(fixture_invoke()).unwrap();
        store.claim_launch(&original.invoke.invocation_id).unwrap();
        let queued = store
            .queue_final(&original.invoke.invocation_id, value())
            .unwrap();
        let mut restarted = TaskStore::open(path.clone()).unwrap();
        assert_eq!(
            restarted
                .queue_final("inv-task", value())
                .unwrap()
                .final_result,
            queued.final_result
        );
        assert!(restarted
            .queue_final(
                "inv-task",
                TaskFinal {
                    output: Some(json!(43)),
                    ..value()
                }
            )
            .is_err());
        let receipt = fixture_receipt(&queued, "completed");
        restarted.finish("inv-task", receipt.clone()).unwrap();
        let mut reopened = TaskStore::open(path).unwrap();
        let mut accept_replay = receipt.clone();
        accept_replay["newly_accepted"] = json!(false);
        assert_eq!(
            reopened.finish("inv-task", accept_replay).unwrap().receipt,
            Some(receipt)
        );
    }
    #[test]
    fn task_store_rejects_wrong_receipt_fence_generation_or_correlation() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = TaskStore::open(directory.path().join("tasks.json")).unwrap();
        let original = store.prepare(fixture_invoke()).unwrap();
        for field in [
            "execution_id",
            "worker_generation",
            "run_id",
            "step_id",
            "dispatch_id",
            "deadline",
        ] {
            let mut receipt = fixture_receipt(&original, "completed");
            receipt["task_execution"][field] = json!("changed");
            assert!(store.finish("inv-task", receipt).is_err());
        }
        assert!(store.records["inv-task"].receipt.is_none());
    }
    #[test]
    fn task_store_failed_disk_write_never_claims_launch_and_requires_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.json");
        let mut store = TaskStore::open(path.clone()).unwrap();
        let original = store.prepare(fixture_invoke()).unwrap();
        // Replacing the ledger with a directory makes atomic rename fail deterministically.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(store.claim_launch("inv-task").is_err());
        assert!(!store.enabled());
        assert!(!store.records["inv-task"].launch_claimed);
        assert!(store.prepare(original.invoke).is_err());
    }
    #[test]
    fn task_store_corrupt_ledger_fails_closed_and_secrets_are_private() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.json");
        let mut store = TaskStore::open(path.clone()).unwrap();
        store.prepare(fixture_invoke()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::write(&path, "not json").unwrap();
        assert!(TaskStore::open(path).is_err());
    }
}
