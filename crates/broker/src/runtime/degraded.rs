//! Deliberately reduced operation. Local delivery never uses Relaycast routing.
//! Reconciliation publishes audit records, not DMs: replaying a DM would execute
//! work twice and could route an old local name to a different machine.
use super::*;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

pub(super) const WARNING: &str = "[agent-relay] DEGRADED — LOCAL ONLY: local spawn, attach and durable delivery are available. Cross-machine routing, worker presence, Relaycast messaging tools and remote attachment are DISABLED. Delivery records reconcile in the background; restart without --local-only to enable fleet capabilities.";
const MAX_OUTBOX_RECORDS: usize = 10_000;
const MAX_OUTBOX_BYTES: usize = 32 * 1024 * 1024;

pub(super) fn local_session(name: &str) -> RelaySession {
    let (ws_control_tx, rx) = mpsc::channel(1);
    drop(rx);
    let (tx, ws_inbound_rx) = mpsc::channel(1);
    drop(tx);
    let workspace = RelayWorkspace {
        workspace_id: WorkspaceId::new("local"),
        workspace_alias: None,
        relay_workspace_key: String::new(),
        self_name: name.into(),
        self_agent_id: AgentId::new("local"),
        self_names: HashSet::from([name.to_string()]),
        self_agent_ids: HashSet::new(),
        http_client: RelaycastHttpClient::local_only(name),
        ws_control_tx,
    };
    RelaySession {
        configured_base: None,
        default_workspace_id: Some(workspace.workspace_id.clone()),
        workspaces: vec![workspace],
        ws_inbound_rx,
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Outbox {
    // Digest pins destination without persisting credentials. Refuse to send a
    // backlog to a newly selected workspace or service after a restart.
    scope: Option<String>,
    records: VecDeque<Value>,
}

struct Journal {
    path: PathBuf,
    outbox: Outbox,
    connected: bool,
    configured: bool,
}

impl Journal {
    fn open(path: PathBuf, scope: Option<String>) -> Result<Self> {
        let mut outbox: Outbox = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .context("local delivery outbox is corrupt; preserve it for recovery")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Outbox::default(),
            Err(error) => return Err(error).context("cannot read local delivery outbox"),
        };
        if !outbox.records.is_empty() {
            anyhow::ensure!(outbox.scope == scope, "local delivery outbox belongs to another reconciliation destination; restore the original configuration or use a different state directory");
        }
        outbox.scope = scope.clone();
        let journal = Self {
            path,
            outbox,
            connected: false,
            configured: scope.is_some(),
        };
        journal.save()?;
        Ok(journal)
    }

    fn save(&self) -> Result<()> {
        crate::util::fs::write_json_atomic(&self.path, &self.outbox)
    }

    fn enqueue(&mut self, record: Value) -> Result<()> {
        anyhow::ensure!(
            self.outbox.records.len() < MAX_OUTBOX_RECORDS,
            "local delivery reconciliation outbox is full"
        );
        self.outbox.records.push_back(record);
        let result = (|| {
            anyhow::ensure!(
                serde_json::to_vec(&self.outbox)?.len() <= MAX_OUTBOX_BYTES,
                "local delivery reconciliation outbox is full"
            );
            self.save()
        })();
        if result.is_err() {
            self.outbox.records.pop_back();
        }
        result
    }

    fn acknowledge(&mut self, event_id: &str) -> Result<()> {
        if self
            .outbox
            .records
            .front()
            .and_then(|r| r["event_id"].as_str())
            != Some(event_id)
        {
            return Ok(());
        }
        let record = self.outbox.records.pop_front().expect("front was checked");
        if let Err(error) = self.save() {
            self.outbox.records.push_front(record);
            return Err(error);
        }
        Ok(())
    }
}

pub(super) struct DegradedState {
    journal: Arc<Mutex<Journal>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for DegradedState {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl DegradedState {
    pub(super) fn start(paths: &RuntimePaths, name: &str) -> Result<Self> {
        let key = std::env::var("AGENT_RELAY_WORKSPACE_KEY")
            .ok()
            .or_else(|| std::env::var("RELAY_WORKSPACE_KEY").ok())
            .filter(|key| !key.trim().is_empty());
        let base = std::env::var("RELAYCAST_BASE_URL")
            .ok()
            .or_else(|| std::env::var("RELAY_BASE_URL").ok())
            .filter(|base| !base.trim().is_empty());
        let scope = key.as_ref().map(|key| {
            format!(
                "{:x}",
                Sha256::digest(format!(
                    "{}\0{}",
                    base.as_deref()
                        .unwrap_or("https://cast.agentrelay.com")
                        .trim_end_matches('/'),
                    key
                ))
            )
        });
        let journal = Arc::new(Mutex::new(Journal::open(
            paths.state.with_extension("local-outbox.json"),
            scope,
        )?));
        let task_journal = journal.clone();
        let identity = stable_node_identity_key(&paths.state);
        // A separate identity cannot rotate the normal broker's token or claim
        // that the local workers are reachable through a fleet node.
        let name = format!(
            "{name}-local-{}",
            &identity[identity.len().saturating_sub(12)..]
        );
        let task = tokio::spawn(async move {
            let Some(key) = key else {
                return;
            };
            let auth = AuthClient::new(base.clone());
            let mut client = None;
            let mut retry_delay = true;
            loop {
                if retry_delay {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                retry_delay = true;
                let pending = task_journal.lock().unwrap().outbox.records.front().cloned();
                let Some(record) = pending else {
                    continue;
                };
                if client.is_none() {
                    let result = timeout(
                        Duration::from_secs(12),
                        auth.startup_session_set_with_identity(
                            Some(&name),
                            true,
                            Some("agent"),
                            Some(&identity),
                        ),
                    )
                    .await;
                    if let Ok(Ok(sessions)) = result {
                        if let Some(session) = sessions.default_session() {
                            // No websocket, node registration, or worker presence
                            // is enabled by an audit connection.
                            let http =
                                RelaycastHttpClient::new(base.clone(), key.clone(), &name, "local");
                            if let Some(token) = session.credentials.agent_token.as_deref() {
                                http.seed_agent_token(&name, token);
                            }
                            client = Some(http);
                        }
                    }
                }
                let Some(http) = client.as_ref() else {
                    task_journal.lock().unwrap().connected = false;
                    continue;
                };
                if reconcile_record(http, &name, &record).await.is_ok() {
                    let mut journal = task_journal.lock().unwrap();
                    if !journal.connected {
                        eprintln!("[agent-relay] local delivery audit reconciliation connected (broker operating mode unchanged)");
                    }
                    journal.connected = true;
                    retry_delay = false;
                    if journal
                        .acknowledge(record["event_id"].as_str().unwrap_or_default())
                        .is_err()
                    {
                        retry_delay = true;
                        eprintln!("[agent-relay] could not persist local reconciliation acknowledgement; record retained for retry");
                    }
                } else {
                    task_journal.lock().unwrap().connected = false;
                    client = None;
                }
            }
        });
        Ok(Self { journal, task })
    }

    pub(super) fn status(&self) -> Value {
        let journal = self.journal.lock().unwrap();
        json!({
            "mode": "local_only", "status": "degraded",
            "capabilities": {"local_spawn": true, "local_attach": true, "local_queue": true,
                "cross_machine_routing": false, "worker_presence": false, "remote_delivery": false,
                "remote_attach": false, "relaycast_tools": false},
            "reconciliation": {"configured": journal.configured, "connected": journal.connected,
                "pending_records": journal.outbox.records.len(), "delivery_semantics": "audit_only_at_least_once"}
        })
    }

    pub(super) fn enqueue(&self, record: Value) -> Result<()> {
        self.journal.lock().unwrap().enqueue(record)
    }
}

async fn reconcile_record(http: &RelaycastHttpClient, name: &str, record: &Value) -> Result<()> {
    timeout(
        Duration::from_secs(5),
        http.emit_agent_event(
            name,
            "local.delivery.queued",
            record
                .as_object()
                .context("invalid local delivery record")?
                .clone(),
        ),
    )
    .await
    .context("local reconciliation timed out")??;
    Ok(())
}

impl BrokerRuntime {
    pub(super) async fn handle_local_request(
        &mut self,
        req: ListenApiRequest,
    ) -> Option<ListenApiRequest> {
        let req = match req {
            ListenApiRequest::SetInboundDeliveryMode {
                mode: InboundDeliveryMode::ManualFlush,
                reply,
                ..
            } => {
                let _ = reply.send(Err(DeliveryRouteError::CapabilityDisabled));
                return None;
            }
            req => req,
        };
        let ListenApiRequest::Send {
            to,
            text,
            from,
            thread_id,
            workspace_id,
            workspace_alias,
            mode,
            reply,
        } = req
        else {
            return Some(req);
        };
        let result = self
            .queue_local_delivery(
                to,
                text,
                from,
                thread_id,
                workspace_id,
                workspace_alias,
                mode,
            )
            .await;
        let _ = reply.send(result.map_err(|error| error.to_string()));
        None
    }

    #[allow(clippy::too_many_arguments)]
    async fn queue_local_delivery(
        &mut self,
        to: MessageTarget,
        text: String,
        from: Option<String>,
        thread_id: Option<ThreadId>,
        workspace_id: Option<WorkspaceId>,
        workspace_alias: Option<WorkspaceAlias>,
        mode: MessageInjectionMode,
    ) -> Result<Value> {
        anyhow::ensure!(
            workspace_alias.is_none() && workspace_id.as_deref().is_none_or(|id| id == "local"),
            "DEGRADED: workspace routing is disabled in local-only mode"
        );
        let name = to.trim().trim_start_matches('@');
        anyhow::ensure!(
            self.workers.has_worker(name),
            "DEGRADED: only agents running on this broker can receive local deliveries"
        );
        let delivery_id = DeliveryId::new(format!("del_{}", Uuid::new_v4().simple()));
        let event_id = EventId::new(format!("local_{}", Uuid::new_v4().simple()));
        let from = normalize_sender(from);
        let queued_at_ms = unix_timestamp_millis();
        let delivery = RelayDelivery {
            delivery_id: delivery_id.clone(),
            event_id: event_id.clone(),
            from: from.clone(),
            target: MessageTarget::new(name),
            body: text.clone(),
            thread_id: thread_id.clone(),
            workspace_id: Some(WorkspaceId::new("local")),
            workspace_alias: None,
            priority: Some(1),
            injection_mode: mode,
        };
        // Commit locally before any handoff or success response. The normal
        // pending-delivery lifecycle retains/acks/dead-letters this work, just
        // as it does engine deliveries; it survives broker restarts.
        self.pending_deliveries.insert(
            delivery_id.clone(),
            PendingDelivery {
                worker_name: WorkerName::new(name),
                delivery,
                attempts: 0,
                failed_attempts: 0,
                next_retry_at: Instant::now(),
                queued_at_ms,
                last_error: None,
                withheld_fleet_ack: None,
                withheld_fleet_ack_floor: None,
            },
        );
        if let Err(error) = save_pending_deliveries(&self.paths.pending, &self.pending_deliveries) {
            self.pending_deliveries.remove(&delivery_id);
            return Err(error).context("local delivery was not accepted: persistence failed");
        }
        let record = json!({"event_id": event_id, "delivery_id": delivery_id,
            "from": from, "to": name, "body": text, "thread_id": thread_id,
            "queued_at_ms": queued_at_ms, "delivery_status": "queued_local", "mode": "local_only"});
        if let Err(error) = self.degraded.as_ref().expect("local mode").enqueue(record) {
            self.pending_deliveries.remove(&delivery_id);
            save_pending_deliveries(&self.paths.pending, &self.pending_deliveries)
                .context("local delivery acceptance uncertain: rollback persistence failed")?;
            return Err(error).context("local delivery was not accepted");
        }
        // Maintenance performs handoff, including after a reconnect/restart.
        // Never label this delivered: the PTY still owes an acknowledgement.
        Ok(
            json!({"success": true, "event_id": event_id, "delivery_id": delivery_id,
            "local": true, "mode": "local_only", "relaycast_published": false,
            "delivery_status": "queued_local", "reconciliation_pending": true,
            "workspace_id": "local"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbox_survives_restart_and_refuses_a_different_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.json");
        let record = json!({"event_id": "local_one", "body": "retained work"});
        let mut journal = Journal::open(path.clone(), Some("destination-a".into())).unwrap();
        journal.enqueue(record.clone()).unwrap();
        drop(journal);
        assert!(Journal::open(path.clone(), Some("destination-b".into())).is_err());
        let mut recovered = Journal::open(path.clone(), Some("destination-a".into())).unwrap();
        assert_eq!(recovered.outbox.records.front(), Some(&record));
        recovered.acknowledge("unrelated").unwrap();
        assert_eq!(recovered.outbox.records.len(), 1);
        recovered.acknowledge("local_one").unwrap();
        assert!(Journal::open(path, Some("destination-a".into()))
            .unwrap()
            .outbox
            .records
            .is_empty());
    }

    #[test]
    fn unscoped_backlog_cannot_acquire_an_upload_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.json");
        let record = json!({"event_id": "local_private", "body": "local-only work"});
        let mut journal = Journal::open(path.clone(), None).unwrap();
        journal.enqueue(record.clone()).unwrap();
        drop(journal);
        let original = std::fs::read(&path).unwrap();

        assert!(Journal::open(path.clone(), Some("new-destination".into())).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let recovered = Journal::open(path.clone(), None).unwrap();
        assert_eq!(recovered.outbox.scope, None);
        assert_eq!(recovered.outbox.records.front(), Some(&record));
        assert!(!recovered.configured);

        // A fresh, empty journal may still be configured normally.
        let empty = dir.path().join("empty.json");
        Journal::open(empty.clone(), None).unwrap();
        assert!(Journal::open(empty, Some("new-destination".into())).is_ok());
    }

    #[test]
    fn corrupt_or_full_outbox_is_never_silently_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.json");
        std::fs::write(&path, "{").unwrap();
        assert!(Journal::open(path.clone(), None).is_err());
        std::fs::remove_file(&path).unwrap();
        let mut journal = Journal::open(path, None).unwrap();
        journal.outbox.records = (0..MAX_OUTBOX_RECORDS)
            .map(|id| json!({"event_id": id}))
            .collect();
        assert!(journal.enqueue(json!({"event_id": "overflow"})).is_err());
        assert_eq!(journal.outbox.records.len(), MAX_OUTBOX_RECORDS);
    }

    #[tokio::test]
    async fn reconnect_replays_the_retained_audit_record_without_remote_delivery() {
        use httpmock::Method::POST;
        let server = httpmock::MockServer::start_async().await;
        let unavailable = server
            .mock_async(|when, then| {
                when.method(POST).path("/v1/agents/local-broker/events");
                then.status(503).json_body(
                    json!({"ok":false,"error":{"code":"unavailable","message":"test outage"}}),
                );
            })
            .await;
        let remote_delivery = server
            .mock_async(|when, then| {
                when.method(POST).path("/v1/dm");
                then.status(500);
            })
            .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.json");
        let record = json!({"event_id":"local_replay", "delivery_id":"del_replay", "body":"local work", "delivery_status":"queued_local"});
        let mut journal = Journal::open(path.clone(), None).unwrap();
        journal.enqueue(record.clone()).unwrap();
        let http = RelaycastHttpClient::new(
            Some(server.base_url()),
            "rk_live_test",
            "local-broker",
            "local",
        );
        assert!(reconcile_record(&http, "local-broker", &record)
            .await
            .is_err());
        assert_eq!(
            Journal::open(path.clone(), None)
                .unwrap()
                .outbox
                .records
                .front(),
            Some(&record)
        );
        unavailable.delete_async().await;
        let accepted = server.mock_async(|when, then| {
            when.method(POST).path("/v1/agents/local-broker/events")
                .json_body(json!({"type":"local.delivery.queued", "payload": record}));
            then.status(200).json_body(json!({"ok":true,"data":{"id":"audit_one","agent_id":"local-broker","type":"local.delivery.queued","payload":record,"created_at":"2026-09-09T00:00:00Z"}}));
        }).await;
        reconcile_record(&http, "local-broker", &record)
            .await
            .unwrap();
        journal.acknowledge("local_replay").unwrap();
        accepted.assert_hits_async(1).await;
        remote_delivery.assert_hits_async(0).await;
        assert!(Journal::open(path, None).unwrap().outbox.records.is_empty());
    }
}
