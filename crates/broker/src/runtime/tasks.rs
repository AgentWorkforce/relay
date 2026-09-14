use super::task_store::{
    json_equal, validate_receipt, TaskFinal, TaskRecord, TaskStore, TASK_REQUEST_PREFIX,
};
use super::*;
use crate::fleet_wire::{ActionInvoke, BrokerToRelaycast, Reply};
use crate::listen_api::AgentResultRouteError;
use tokio::sync::oneshot;

type CallbackReply = oneshot::Sender<Result<Value, AgentResultRouteError>>;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum TaskRequestKind {
    Accept,
    Final,
    Interim,
}
pub(super) struct PendingTaskRequest {
    pub invocation: String,
    pub execution: String,
    pub kind: TaskRequestKind,
    pub sent_at: Instant,
    pub interim_reply: Option<CallbackReply>,
    pub interim_data: Option<Value>,
}
#[derive(Default)]
pub(super) struct TaskProvider {
    pub store: TaskStore,
    pub pending: HashMap<String, PendingTaskRequest>,
    pub callbacks: HashMap<String, Vec<(Instant, CallbackReply)>>,
    pub last_retry: Option<Instant>,
    pub retry_cursor: usize,
}

impl BrokerRuntime {
    pub(super) async fn handle_task_invoke(&mut self, invoke: ActionInvoke) {
        match self.task_provider.store.prepare(invoke) {
            Ok(record) => {
                self.send_task_request(&record, TaskRequestKind::Accept, None, None)
                    .await
            }
            Err(error) => tracing::warn!(error = %error, "task invocation refused before launch"),
        }
    }

    async fn send_task_request(
        &mut self,
        record: &TaskRecord,
        kind: TaskRequestKind,
        interim: Option<TaskFinal>,
        reply: Option<CallbackReply>,
    ) {
        if !self.node_delivery_connected
            || !self.task_provider.store.enabled()
            || self.task_provider.pending.len() >= 64
        {
            if let Some(reply) = reply {
                let _ = reply.send(Err(AgentResultRouteError::Retryable));
            }
            return;
        }
        if kind != TaskRequestKind::Interim
            && self.task_provider.pending.values().any(|request| {
                request.invocation == record.invoke.invocation_id
                    && request.execution == record.execution().execution_id
                    && request.kind == kind
            })
        {
            return;
        }
        let id = format!("{TASK_REQUEST_PREFIX}{}", Uuid::new_v4().simple());
        let message = if kind == TaskRequestKind::Accept {
            BrokerToRelaycast::ActionAccept(record.accept(id.clone()))
        } else {
            let value = interim
                .as_ref()
                .or(record.final_result.as_ref())
                .expect("result request has payload");
            BrokerToRelaycast::ActionResult(record.result(
                id.clone(),
                value,
                kind == TaskRequestKind::Final,
            ))
        };
        // Never await an engine reply in the broker loop. The fleet reader returns
        // the correlated response as an event; the callback waiter is separate.
        let pending = PendingTaskRequest {
            invocation: record.invoke.invocation_id.clone(),
            execution: record.execution().execution_id.clone(),
            kind,
            sent_at: Instant::now(),
            interim_data: interim.and_then(|value| value.output),
            interim_reply: reply,
        };
        if self
            .fleet_control_tx
            .try_send(FleetControlCommand::Send(message))
            .is_ok()
        {
            self.task_provider.pending.insert(id, pending);
        } else if let Some(reply) = pending.interim_reply {
            let _ = reply.send(Err(AgentResultRouteError::Retryable));
        }
    }

    pub(super) async fn handle_task_reply(&mut self, reply: Reply) {
        let Some(request) = self.task_provider.pending.remove(&reply.id) else {
            return;
        };
        let Some(record) = self
            .task_provider
            .store
            .records
            .get(&request.invocation)
            .cloned()
        else {
            return;
        };
        if record.execution().execution_id != request.execution {
            return;
        }
        let data = reply.data;
        if !reply.ok || validate_receipt(&record, &data).is_err() {
            if let Some(callback) = request.interim_reply {
                let _ = callback.send(Err(AgentResultRouteError::Retryable));
            }
            return;
        }
        let status = data.get("status").and_then(Value::as_str).unwrap_or("");
        if matches!(status, "completed" | "failed") {
            let first_receipt = record.receipt.is_none();
            match self.task_provider.store.finish(&request.invocation, data) {
                Ok(record) => {
                    if first_receipt {
                        let _ = timeout(Duration::from_millis(200), send_event(&self.sdk_out_tx, json!({
                            "kind":"agent_result", "name":record.name, "generation":record.generation.to_string(),
                            "result_id":record.invoke.invocation_id, "data":record.receipt.as_ref().and_then(|r|r.get("output")),
                            "final":true, "task_receipt":record.receipt
                        }))).await;
                    }
                    if let Some(callback) = request.interim_reply {
                        let _ = callback.send(Err(AgentResultRouteError::Conflict));
                    }
                    self.finish_task_callbacks(&record);
                    if record
                        .receipt
                        .as_ref()
                        .and_then(|r| r.get("status"))
                        .and_then(Value::as_str)
                        == Some("failed")
                    {
                        let _ = self
                            .workers
                            .stop_task_generation(record.name.as_str(), record.generation)
                            .await;
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "task receipt not acknowledged because local durable write failed")
                }
            }
            return;
        }
        if request.kind == TaskRequestKind::Interim {
            let _ = timeout(Duration::from_millis(200), send_event(&self.sdk_out_tx, json!({
                "kind":"agent_result", "name":record.name, "generation":record.generation.to_string(),
                "result_id":reply.id, "data":request.interim_data, "final":false
            }))).await;
            if let Some(callback) = request.interim_reply {
                let _ = callback.send(Ok(
                    json!({"success": true, "name": record.name, "final": false, "receipt": data}),
                ));
            }
            return;
        }
        if request.kind != TaskRequestKind::Accept || status != "running" {
            return;
        }
        if record.final_result.is_some() {
            self.send_task_request(&record, TaskRequestKind::Final, None, None)
                .await;
            return;
        }
        if record.expired() {
            return;
        }
        if record.launch_claimed {
            let live = self
                .workers
                .workers
                .get(&record.name)
                .is_some_and(|worker| {
                    worker.generation == record.generation
                        && self.workers.is_worker_live(&record.name)
                });
            if !live {
                self.fail_task(&request.invocation, "worker_execution_lost")
                    .await;
            }
            return;
        }
        // Even newly_accepted=false can reconcile a never-claimed launch: this
        // ledger proves no process creation was ever attempted. A claimed launch
        // with unknown outcome is failed above and is never retried.
        match self.task_provider.store.claim_launch(&request.invocation) {
            Ok(Some(record)) => self.launch_task(record).await,
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(error = %error, "task launch claim could not be persisted")
            }
        }
    }

    async fn launch_task(&mut self, record: TaskRecord) {
        let Some(cli) = record
            .invoke
            .input
            .get("cli")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            self.fail_task(&record.invoke.invocation_id, "task_missing_cli")
                .await;
            return;
        };
        let Some(task) = record
            .invoke
            .input
            .get("task")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            self.fail_task(&record.invoke.invocation_id, "task_missing_prompt")
                .await;
            return;
        };
        let Some(workspace_id) = self.default_workspace_id.clone() else {
            self.fail_task(&record.invoke.invocation_id, "task_workspace_unavailable")
                .await;
            return;
        };
        let workspace = self
            .workspace_lookup
            .get(&workspace_id)
            .cloned()
            .unwrap_or_else(|| self.default_workspace.clone());
        let callback = AgentResultMcpConfig {
            callback_url: self
                .workers
                .env_value("AGENT_RELAY_RESULT_URL")
                .unwrap_or("http://127.0.0.1:3889/api/agent-result")
                .to_owned(),
            token: record.callback_token.clone(),
            schema: record.invoke.input.get("result_schema").cloned(),
        };
        let outcome = super::relaycast_events::spawn_worker_from_request(
            record.name.clone(),
            cli,
            Some(task),
            record
                .invoke
                .input
                .get("channel")
                .and_then(Value::as_str)
                .map(str::to_owned),
            record
                .invoke
                .input
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            true,
            &record.invoke.input,
            &workspace_id,
            None,
            &workspace,
            &mut self.workers,
            &mut self.state,
            &self.paths,
            &self.telemetry,
            &self.sdk_out_tx,
            &mut self.dedup,
            &mut self.agent_spawn_count,
            &self.fleet_control_tx,
            &mut self.fleet_delivery_book,
            &mut self.fleet_inventory,
            &self.fleet_node_name,
            Some(record.invoke.invocation_id.clone()),
            None,
            &self.hosted_agent_event_tx,
            &mut self.pty_observability,
            Some((callback, record.generation)),
        )
        .await;
        if outcome.is_err() || !self.workers.is_worker_live(&record.name) {
            self.fail_task(&record.invoke.invocation_id, "worker_spawn_failed")
                .await;
        } else {
            // A task generation cannot be restarted by the ordinary supervisor.
            self.workers.supervisor.unregister(&record.name);
        }
        self.publish_fleet_load(true).await;
    }

    pub(super) async fn fail_task(&mut self, id: &str, error: &str) {
        if self
            .task_provider
            .store
            .records
            .get(id)
            .is_none_or(|r| r.final_result.is_some() || r.receipt.is_some())
        {
            return;
        }
        match self.task_provider.store.queue_final(
            id,
            TaskFinal {
                output: None,
                error: Some(error.to_owned()),
                accounting: None,
            },
        ) {
            Ok(record) => {
                self.send_task_request(&record, TaskRequestKind::Accept, None, None)
                    .await
            }
            Err(error) => tracing::warn!(error = %error, "task failure could not be persisted"),
        }
    }

    pub(super) async fn handle_task_error(&mut self, error: crate::fleet_wire::Error) {
        let Some(request) = self.task_provider.pending.remove(&error.id) else {
            return;
        };
        if self
            .task_provider
            .store
            .records
            .get(&request.invocation)
            .is_none_or(|r| r.execution().execution_id != request.execution)
        {
            return;
        }
        if let Some(callback) = request.interim_reply {
            let _ = callback.send(Err(AgentResultRouteError::Retryable));
        }
        if matches!(
            error.code.as_str(),
            "stale_task_execution" | "task_not_found" | "task_result_conflict"
        ) && self
            .task_provider
            .store
            .reject(&request.invocation, error.code)
            .is_ok()
        {
            if let Some(callbacks) = self.task_provider.callbacks.remove(&request.invocation) {
                for (_, callback) in callbacks {
                    let _ = callback.send(Err(AgentResultRouteError::Conflict));
                }
            }
        }
    }

    pub(super) async fn handle_task_callback(
        &mut self,
        token: String,
        name: Option<WorkerName>,
        data: Value,
        final_result: bool,
        metadata: Option<Value>,
        reply: CallbackReply,
    ) {
        if !self.task_provider.store.enabled() {
            let _ = reply.send(Err(AgentResultRouteError::Retryable));
            return;
        }
        let Some(record) = self.task_provider.store.by_token(&token).cloned() else {
            let _ = reply.send(Err(AgentResultRouteError::InvalidToken));
            return;
        };
        if name.as_ref().is_some_and(|name| name != &record.name) {
            let _ = reply.send(Err(AgentResultRouteError::InvalidToken));
            return;
        }
        // Old tokens remain reconcilable only for their original terminal result.
        // A replacement worker with the same display name cannot submit for it.
        if self
            .workers
            .workers
            .get(&record.name)
            .is_some_and(|w| w.generation != record.generation)
            || record.rejection.is_some()
        {
            let _ = reply.send(Err(AgentResultRouteError::Conflict));
            return;
        }
        let accounting = match metadata.as_ref().and_then(|v| v.get("accounting")) {
            Some(value) => match serde_json::from_value::<std::collections::BTreeMap<String, f64>>(
                value.clone(),
            ) {
                Ok(values) if values.values().all(|n| n.is_finite() && *n >= 0.0) => Some(values),
                _ => {
                    let _ = reply.send(Err(AgentResultRouteError::Conflict));
                    return;
                }
            },
            None => None,
        };
        let value = TaskFinal {
            output: Some(data),
            error: None,
            accounting,
        };
        if !final_result {
            self.send_task_request(&record, TaskRequestKind::Interim, Some(value), Some(reply))
                .await;
            return;
        }
        let record = match self
            .task_provider
            .store
            .queue_final(&record.invoke.invocation_id, value)
        {
            Ok(record) => record,
            Err(error) => {
                let conflict = error.to_string().contains("conflict")
                    || error.to_string().contains("terminal");
                let _ = reply.send(Err(if conflict {
                    AgentResultRouteError::Conflict
                } else {
                    AgentResultRouteError::Retryable
                }));
                return;
            }
        };
        let callbacks = self
            .task_provider
            .callbacks
            .entry(record.invoke.invocation_id.clone())
            .or_default();
        if callbacks.len() >= 16 {
            let _ = reply.send(Err(AgentResultRouteError::Retryable));
            return;
        }
        callbacks.push((Instant::now(), reply));
        if record.receipt.is_some() {
            self.finish_task_callbacks(&record);
        } else {
            self.send_task_request(&record, TaskRequestKind::Accept, None, None)
                .await;
        }
    }

    fn finish_task_callbacks(&mut self, record: &TaskRecord) {
        let Some(callbacks) = self
            .task_provider
            .callbacks
            .remove(&record.invoke.invocation_id)
        else {
            return;
        };
        let receipt = record.receipt.as_ref().expect("terminal receipt");
        let matches = record.final_result.as_ref().is_some_and(|result| {
            result.error.is_none()
                && receipt.get("status").and_then(Value::as_str) == Some("completed")
                && receipt
                    .get("output")
                    .zip(result.output.as_ref())
                    .is_some_and(|(a, b)| json_equal(a, b))
                && receipt
                    .get("task_execution")
                    .and_then(|e| e.get("accounting"))
                    .map(|value| {
                        serde_json::from_value::<std::collections::BTreeMap<String, f64>>(
                            value.clone(),
                        )
                    })
                    .transpose()
                    .ok()
                    == Some(result.accounting.clone())
        });
        for (_, callback) in callbacks {
            let response = if matches {
                Ok(json!({"success": true, "name": record.name, "final": true, "receipt": receipt}))
            } else {
                Err(AgentResultRouteError::Conflict)
            };
            let _ = callback.send(response);
        }
    }

    pub(super) async fn maintain_tasks(&mut self) {
        let now = Instant::now();
        let expired: Vec<String> = self
            .task_provider
            .pending
            .iter()
            .filter(|(_, request)| now.duration_since(request.sent_at) >= Duration::from_secs(5))
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(request) = self.task_provider.pending.remove(&id) {
                if let Some(callback) = request.interim_reply {
                    let _ = callback.send(Err(AgentResultRouteError::Retryable));
                }
            }
        }
        self.task_provider.callbacks.retain(|_, callbacks| {
            let mut retained = Vec::new();
            for (started, callback) in callbacks.drain(..) {
                if callback.is_closed() {
                    continue;
                }
                if now.duration_since(started) >= Duration::from_secs(5) {
                    let _ = callback.send(Err(AgentResultRouteError::Retryable));
                } else {
                    retained.push((started, callback));
                }
            }
            *callbacks = retained;
            !callbacks.is_empty()
        });
        if !self.node_delivery_connected
            || self
                .task_provider
                .last_retry
                .is_some_and(|last| now.duration_since(last) < Duration::from_secs(2))
        {
            return;
        }
        self.task_provider.last_retry = Some(now);
        let records: Vec<TaskRecord> = self
            .task_provider
            .store
            .records
            .values()
            .filter(|r| r.receipt.is_none() && r.rejection.is_none())
            .cloned()
            .collect();
        if !records.is_empty() {
            let start = self.task_provider.retry_cursor % records.len();
            for offset in 0..records.len().min(16) {
                self.send_task_request(
                    &records[(start + offset) % records.len()],
                    TaskRequestKind::Accept,
                    None,
                    None,
                )
                .await;
            }
            self.task_provider.retry_cursor = (start + records.len().min(16)) % records.len();
        }
    }
}
