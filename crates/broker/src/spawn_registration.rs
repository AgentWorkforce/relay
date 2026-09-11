//! Custody for fresh node-created identities. A reply notification never owns a
//! token: this retained record does. Durable intent precedes any possible send.
use crate::{
    ids::WorkerName, node_control::AgentRegistrationToken, relaycast::RelaycastHttpClient,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::Notify;
use uuid::Uuid;

const MAX_RESERVATIONS: usize = 256;

#[derive(Clone, Serialize, Deserialize)]
struct Intent {
    name: String,
    generation: Uuid,
    service: String,
    workspace_fingerprint: String,
    node_id: String,
    request_id: String,
    provider_instance: Option<String>,
    agent_id: Option<String>,
    token_hash: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Reserved,
    Sent,
    Owned,
    Running,
    Retired,
}

struct State {
    intent: Intent,
    phase: Phase,
    abandoned: bool,
    error: Option<String>,
    token: Option<AgentRegistrationToken>,
    connection: Option<Arc<AtomicBool>>,
}

pub(crate) struct SpawnRegistration {
    state: Mutex<State>,
    path: PathBuf,
    pub(crate) http: RelaycastHttpClient,
    changed: Notify,
}

// Deliberately omit credentials and token custody from Debug.
impl std::fmt::Debug for SpawnRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnRegistration")
            .field("request_id", &self.request_id())
            .finish()
    }
}

fn fingerprint(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn persist(path: &Path, intent: &Intent) -> Result<(), String> {
    let parent = path.parent().ok_or("registration journal has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(intent).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

impl SpawnRegistration {
    pub(crate) fn matches_service(
        &self,
        service: &str,
        workspace_key: &str,
        websocket: &str,
    ) -> bool {
        let state = self.state.lock().unwrap();
        let expected = format!("{}/v1/node/ws", service.trim_end_matches('/'));
        let expected = if let Some(rest) = expected.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = expected.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            return false;
        };
        state.intent.service.trim_end_matches('/') == service.trim_end_matches('/')
            && state.intent.workspace_fingerprint == fingerprint(workspace_key)
            && websocket == expected
    }

    pub(crate) fn request_id(&self) -> String {
        self.state.lock().unwrap().intent.request_id.clone()
    }
    pub(crate) fn generation(&self) -> Uuid {
        self.state.lock().unwrap().intent.generation
    }
    pub(crate) fn name(&self) -> String {
        self.state.lock().unwrap().intent.name.clone()
    }
    pub(crate) fn retired(&self) -> bool {
        self.state.lock().unwrap().phase == Phase::Retired
    }

    /// Called on the node-control task immediately before writing this request.
    /// Cancellation wins only while the record is provably unsent.
    pub(crate) fn begin_send(
        &self,
        node_id: &str,
        provider_instance: &str,
        ready: Arc<AtomicBool>,
    ) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.phase != Phase::Reserved || state.abandoned {
            return false;
        }
        if (!state.intent.node_id.is_empty() && state.intent.node_id != node_id)
            || !ready.load(Ordering::Acquire)
        {
            drop(state);
            self.reject_unsent("node_registration_contract_unavailable");
            return false;
        }
        state.intent.node_id = node_id.to_string();
        state.intent.provider_instance = Some(provider_instance.to_owned());
        if let Err(error) = persist(&self.path, &state.intent) {
            state.error = Some(format!("registration intent persistence failed: {error}"));
            state.abandoned = true;
            self.changed.notify_one();
            return false;
        }
        state.connection = Some(ready);
        state.phase = Phase::Sent;
        true
    }

    pub(crate) fn reject_unsent(&self, reason: &str) {
        let mut state = self.state.lock().unwrap();
        if state.phase != Phase::Reserved {
            return;
        }
        state.error = Some(reason.to_string());
        state.abandoned = true;
        // Retiring fails closed if the durable deletion cannot be confirmed.
        if Self::remove_intent(&self.path).is_ok() {
            state.phase = Phase::Retired;
        }
        self.changed.notify_one();
    }

    fn remove_intent(path: &Path) -> Result<(), String> {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        sync_directory(path.parent().ok_or("registration journal has no parent")?)
    }

    pub(crate) fn record_reply(&self, reply: &crate::fleet_wire::Reply) {
        let mut state = self.state.lock().unwrap();
        if reply.id != state.intent.request_id || !matches!(state.phase, Phase::Sent | Phase::Owned)
        {
            return;
        }
        let data = reply.validate_agent_register_data();
        let token = match data {
            Ok(data)
                if data.name.as_deref() == Some(state.intent.name.as_str())
                    && !data.agent_id.trim().is_empty()
                    && !data.token.trim().is_empty() =>
            {
                AgentRegistrationToken {
                    name: state.intent.name.clone(),
                    agent_id: data.agent_id,
                    token: data.token,
                    delivery_ack_seq: data.delivery_ack_seq,
                }
            }
            _ => {
                state.error = Some("invalid_agent_register_reply_data; name quarantined".into());
                state.abandoned = true;
                self.changed.notify_one();
                return;
            }
        };
        if let Some(existing) = &state.token {
            if existing != &token {
                state.error = Some("conflicting_agent_register_reply; name quarantined".into());
                state.abandoned = true;
                // Conflicting identity cannot authorize automatic cleanup.
                state.connection = None;
            }
            self.changed.notify_one();
            return;
        }
        state.intent.agent_id = Some(token.agent_id.clone());
        state.intent.token_hash = Some(fingerprint(&token.token));
        // Capture the token even when persistence fails; original intent still
        // reserves the name after a crash. Never expose an unpersisted success.
        state.token = Some(token);
        state.phase = Phase::Owned;
        if let Err(error) = persist(&self.path, &state.intent) {
            state.error = Some(format!(
                "registration ownership persistence failed: {error}"
            ));
            state.abandoned = true;
        }
        self.changed.notify_one();
    }

    pub(crate) fn record_error(&self, code: &str) {
        let mut state = self.state.lock().unwrap();
        if state.phase != Phase::Sent {
            return;
        }
        let pre_effect_rejection = code == "agent_already_exists" && state.error.is_none();
        state.error = Some(format!(
            "{code}; registration outcome requires reconciliation"
        ));
        state.abandoned = true;
        // Only this audited create-only rejection proves no creation occurred.
        if pre_effect_rejection && Self::remove_intent(&self.path).is_ok() {
            state.phase = Phase::Retired;
        }
        self.changed.notify_one();
    }

    pub(crate) fn abandon(&self) {
        let unsent = {
            let mut state = self.state.lock().unwrap();
            state.abandoned = true;
            state.phase == Phase::Reserved
        };
        if unsent {
            self.reject_unsent("agent_register_cancelled_before_send");
        }
    }

    pub(crate) async fn wait(&self) -> Result<AgentRegistrationToken, String> {
        struct Abandon<'a>(&'a SpawnRegistration, bool);
        impl Drop for Abandon<'_> {
            fn drop(&mut self) {
                if self.1 {
                    self.0.abandon();
                }
            }
        }
        let mut guard = Abandon(self, true);
        let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                {
                    let state = self.state.lock().unwrap();
                    if let Some(error) = &state.error {
                        return Err(error.clone());
                    }
                    if let Some(token) = &state.token {
                        return Ok(token.clone());
                    }
                }
                self.changed.notified().await;
            }
        })
        .await
        .map_err(|_| "agent_register_timeout; name quarantined".to_string())?;
        if result.is_ok() {
            guard.1 = false;
        }
        result
    }

    pub(crate) fn admit(&self, token: &str) -> Result<Uuid, String> {
        let mut state = self.state.lock().unwrap();
        if state.phase != Phase::Owned
            || state.abandoned
            || state.error.is_some()
            || !state
                .connection
                .as_ref()
                .is_some_and(|ready| ready.load(Ordering::Acquire))
            || state
                .token
                .as_ref()
                .is_none_or(|owned| owned.token != token)
        {
            return Err("spawn registration is not ready for admission".into());
        }
        state.phase = Phase::Running;
        Ok(state.intent.generation)
    }

    pub(crate) fn cleanup_identity(&self) -> Option<(String, String)> {
        let state = self.state.lock().unwrap();
        state.connection.as_ref()?;
        Some((
            state.intent.agent_id.clone()?,
            state.intent.token_hash.clone()?,
        ))
    }

    pub(crate) fn needs_cleanup(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.abandoned && state.phase == Phase::Owned && state.connection.is_some()
    }

    pub(crate) fn retire_after_cleanup(&self, generation: Uuid) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.intent.generation != generation {
            return Err("registration generation mismatch".into());
        }
        Self::remove_intent(&self.path)?;
        state.phase = Phase::Retired;
        state.token = None;
        Ok(())
    }
}

pub(crate) struct SpawnRegistrations {
    pub(crate) entries: HashMap<WorkerName, Arc<SpawnRegistration>>,
    quarantined: HashMap<WorkerName, Intent>,
    directory: PathBuf,
    load_error: Option<String>,
}

impl SpawnRegistrations {
    pub(crate) fn load(directory: PathBuf) -> Self {
        let mut registry = Self {
            entries: HashMap::new(),
            quarantined: HashMap::new(),
            directory,
            load_error: None,
        };
        if !registry.directory.exists() {
            return registry;
        }
        let result = (|| -> Result<(), String> {
            for entry in fs::read_dir(&registry.directory).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let intent: Intent =
                    serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                if intent.name.is_empty()
                    || path.file_stem().and_then(|s| s.to_str())
                        != Some(intent.generation.to_string().as_str())
                {
                    return Err("invalid registration journal identity".into());
                }
                registry
                    .quarantined
                    .insert(WorkerName::new(intent.name.clone()), intent);
            }
            Ok(())
        })();
        registry.load_error = result.err();
        registry
    }

    pub(crate) fn blocked(&self, name: &str) -> bool {
        self.load_error.is_some()
            || self.quarantined.contains_key(name)
            || self.entries.get(name).is_some_and(|entry| !entry.retired())
    }

    pub(crate) fn reserve(
        &mut self,
        name: WorkerName,
        http: RelaycastHttpClient,
    ) -> Result<Arc<SpawnRegistration>, String> {
        self.entries.retain(|_, entry| !entry.retired());
        if self.blocked(&name) {
            return Err("worker name has unresolved registration custody".into());
        }
        if self.entries.len() + self.quarantined.len() >= MAX_RESERVATIONS {
            return Err("spawn registration custody is full".into());
        }
        let service = http
            .base_url
            .clone()
            .unwrap_or_else(|| "https://cast.agentrelay.com".into());
        let url = reqwest::Url::parse(&service).map_err(|_| "invalid registration service URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "registration service URL must not contain credentials, query, or fragment".into(),
            );
        }
        let generation = Uuid::new_v4();
        let intent = Intent {
            name: name.to_string(),
            generation,
            service,
            workspace_fingerprint: fingerprint(&http.api_key),
            node_id: String::new(),
            request_id: format!("fresh_agent_{generation}"),
            provider_instance: None,
            agent_id: None,
            token_hash: None,
        };
        let path = self.directory.join(format!("{generation}.json"));
        persist(&path, &intent)?;
        let registration = Arc::new(SpawnRegistration {
            state: Mutex::new(State {
                intent,
                phase: Phase::Reserved,
                abandoned: false,
                error: None,
                token: None,
                connection: None,
            }),
            path,
            http,
            changed: Notify::new(),
        });
        self.entries.insert(name, registration.clone());
        Ok(registration)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_wire::{Reply, FLEET_WIRE_VERSION};
    use serde_json::json;

    fn registry() -> (tempfile::TempDir, SpawnRegistrations) {
        let directory = tempfile::tempdir().unwrap();
        let registry = SpawnRegistrations::load(directory.path().join("custody"));
        (directory, registry)
    }
    fn reserve(registry: &mut SpawnRegistrations) -> Arc<SpawnRegistration> {
        registry
            .reserve(
                WorkerName::new("worker"),
                RelaycastHttpClient::new(
                    Some("http://localhost:1234".into()),
                    "workspace-test",
                    "broker",
                    "codex",
                ),
            )
            .unwrap()
    }
    fn send(custody: &SpawnRegistration) -> Arc<AtomicBool> {
        let ready = Arc::new(AtomicBool::new(true));
        assert!(custody.begin_send("node", "instance", ready.clone()));
        ready
    }
    fn reply(custody: &SpawnRegistration) -> Reply {
        Reply {
            v: FLEET_WIRE_VERSION,
            id: custody.request_id(),
            ok: true,
            data: json!({"name":"worker","agent_id":"original-id","token":"original-secret"}),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_then_late_success_retains_exact_custody_past_old_ttl() {
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        send(&custody);
        assert!(custody.wait().await.unwrap_err().contains("timeout"));
        tokio::time::advance(std::time::Duration::from_secs(301)).await;
        assert!(registry.blocked("worker"));
        custody.record_reply(&reply(&custody));
        assert!(custody.needs_cleanup());
        assert_eq!(
            custody.cleanup_identity(),
            Some(("original-id".into(), fingerprint("original-secret")))
        );
        assert!(custody.admit("original-secret").is_err());
        custody.retire_after_cleanup(custody.generation()).unwrap();
        assert!(!registry.blocked("worker"));
    }

    #[tokio::test]
    async fn successful_notification_does_not_transfer_sole_token_custody() {
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        send(&custody);
        custody.record_reply(&reply(&custody));
        let token = custody.wait().await.unwrap();
        drop(token);
        custody.abandon();
        assert!(custody.needs_cleanup());
        assert!(custody.cleanup_identity().is_some());
        assert!(registry.blocked("worker"));
    }

    #[test]
    fn queued_cancellation_retires_without_sending_and_restart_keeps_ambiguous_names() {
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        custody.abandon();
        assert!(!custody.begin_send("node", "instance", Arc::new(AtomicBool::new(true))));
        assert!(!registry.blocked("worker"));
        let next = reserve(&mut registry);
        send(&next);
        let restored = SpawnRegistrations::load(registry.directory.clone());
        assert!(restored.blocked("worker"));
        assert!(restored.entries.is_empty());
        let serialized = fs::read_to_string(&next.path).unwrap();
        assert!(!serialized.contains("workspace-test"));
        assert!(!serialized.contains("original-secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&next.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn exact_id_name_shape_and_duplicate_guards_never_replace_owned_identity() {
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        send(&custody);
        let mut unknown = reply(&custody);
        unknown.id = "other-request".into();
        custody.record_reply(&unknown);
        assert!(custody.cleanup_identity().is_none());
        custody.record_reply(&reply(&custody));
        custody.record_reply(&reply(&custody));
        custody.record_error("node_control_failed");
        assert!(custody.admit("wrong-token").is_err());
        let mut conflict = reply(&custody);
        conflict.data["token"] = json!("replacement-token");
        custody.record_reply(&conflict);
        assert!(!custody.needs_cleanup());
        assert!(custody.admit("original-secret").is_err());
        assert!(custody.cleanup_identity().is_none());
    }

    #[test]
    fn malformed_or_mismatched_success_keeps_name_quarantined() {
        for data in [
            json!({}),
            json!({"name":"other","agent_id":"id","token":"secret"}),
            json!({"name":"worker","agent_id":"","token":"secret"}),
            json!({"name":"worker","agent_id":"id","token":""}),
        ] {
            let (_directory, mut registry) = registry();
            let custody = reserve(&mut registry);
            send(&custody);
            let mut frame = reply(&custody);
            frame.data = data;
            custody.record_reply(&frame);
            assert!(registry.blocked("worker"));
            assert!(custody.cleanup_identity().is_none());
            assert!(custody.admit("secret").is_err());
        }
    }

    #[test]
    fn only_audited_pre_effect_rejection_retires_a_sent_registration() {
        for (code, blocked) in [
            ("agent_already_exists", false),
            ("node_control_failed", true),
            ("workspace_busy", true),
        ] {
            let (_directory, mut registry) = registry();
            let custody = reserve(&mut registry);
            send(&custody);
            custody.record_error(code);
            assert_eq!(registry.blocked("worker"), blocked);
        }
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        send(&custody);
        custody.record_error("node_control_failed");
        custody.record_error("agent_already_exists");
        assert!(
            registry.blocked("worker"),
            "a contradictory second error is not proof of rollback"
        );
    }

    #[tokio::test]
    async fn cancelling_waiter_keeps_sent_identity_and_cleans_a_later_reply() {
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        send(&custody);
        let waiting = custody.clone();
        let task = tokio::spawn(async move { waiting.wait().await });
        tokio::task::yield_now().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        custody.record_reply(&reply(&custody));
        assert!(custody.needs_cleanup());
        assert!(registry.blocked("worker"));
    }

    #[test]
    fn capacity_rejects_new_names_without_evicting_uncertain_custody() {
        let (_directory, mut registry) = registry();
        for index in 0..MAX_RESERVATIONS {
            registry
                .reserve(
                    WorkerName::new(format!("worker-{index}")),
                    RelaycastHttpClient::local_only("broker"),
                )
                .unwrap();
        }
        assert!(registry
            .reserve(
                WorkerName::new("overflow"),
                RelaycastHttpClient::local_only("broker")
            )
            .unwrap_err()
            .contains("full"));
        let restored = SpawnRegistrations::load(registry.directory.clone());
        for index in 0..MAX_RESERVATIONS {
            assert!(restored.blocked(&format!("worker-{index}")));
        }
    }

    #[test]
    fn admission_requires_same_live_connection_and_immutable_generation() {
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        let ready = send(&custody);
        custody.record_reply(&reply(&custody));
        ready.store(false, Ordering::Release);
        assert!(custody.admit("original-secret").is_err());
        assert!(custody.retire_after_cleanup(Uuid::new_v4()).is_err());
        assert!(registry.blocked("worker"));
    }

    #[test]
    fn service_binding_rejects_different_workspace_or_websocket() {
        let (_directory, mut registry) = registry();
        let custody = reserve(&mut registry);
        assert!(custody.matches_service(
            "http://localhost:1234",
            "workspace-test",
            "ws://localhost:1234/v1/node/ws"
        ));
        assert!(!custody.matches_service(
            "http://localhost:1234",
            "other",
            "ws://localhost:1234/v1/node/ws"
        ));
        assert!(!custody.matches_service(
            "http://localhost:1234",
            "workspace-test",
            "ws://localhost:5678/v1/node/ws"
        ));
    }

    #[test]
    fn corrupt_journal_and_failed_intent_write_fail_closed() {
        let (_directory, registry) = registry();
        fs::create_dir_all(&registry.directory).unwrap();
        fs::write(registry.directory.join("bad.json"), "{").unwrap();
        let mut restored = SpawnRegistrations::load(registry.directory.clone());
        assert!(restored.blocked("any-name"));
        assert!(restored
            .reserve(
                WorkerName::new("other"),
                RelaycastHttpClient::local_only("broker")
            )
            .is_err());
        let file = registry.directory.join("file");
        fs::write(&file, "not a directory").unwrap();
        let mut invalid = SpawnRegistrations::load(file.join("child"));
        assert!(invalid
            .reserve(
                WorkerName::new("other"),
                RelaycastHttpClient::local_only("broker")
            )
            .is_err());
    }
}
