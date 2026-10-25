//! Reconciles this desktop's Relaycast agents with the signed-in person's
//! hosted MCP identities. Cloud receives the complete set for one stable,
//! installation-scoped source id. Agent tokens are sent only in the HTTPS
//! request body and are never logged.

use crate::relay::cloud_session::{
    self, access_is_fresh, can_refresh, segment, AgentOwner, CloudAccount, CloudError,
};
use crate::relay::daemon::Core;
use crate::relay::hosted_mcp;
use crate::relay::state::{Level, Verification, WorkspaceStatus};
use crate::relay::store::{CloudSession, DesktopIdentityClear};
use crate::relay::workspace::Workspace;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod refusal;
mod synced;

const FRESH_MARGIN: Duration = Duration::from_secs(60);

/// The identity sync's lock and the hosted MCP links Cloud last reported.
/// The links stay in memory: the refresh pass reads them again.
#[derive(Default)]
pub(crate) struct DesktopIdentitySync {
    lock: tokio::sync::Mutex<()>,
    links: Mutex<McpLinks>,
    refused: Mutex<Option<refusal::RefusedSnapshot>>,
    synced: Mutex<Option<synced::SyncedSnapshot>>,
}

/// Link times by agent id, for the account workspace that reported them
/// and the identity clears already queued when it did.
#[derive(Default)]
struct McpLinks {
    workspace_id: String,
    clears_seen: BTreeSet<(String, String)>,
    linked_at: BTreeMap<String, String>,
}

fn path(workspace_id: &str) -> String {
    format!(
        "/workspaces/{}/messaging/desktop-identities",
        segment(workspace_id)
    )
}

/// A clear is finished once Cloud holds no identities for its source. A
/// deleted workspace holds none, so its 404 ends the clear instead of
/// retrying it on every supervision pass.
fn cleared(result: Result<Value, CloudError>) -> Result<(), CloudError> {
    match result {
        Ok(_) | Err(CloudError::Status { status: 404, .. }) => Ok(()),
        Err(error) => Err(error),
    }
}

fn verified_as_account_workspace(
    active: Option<&Workspace>,
    status: &WorkspaceStatus,
    account_relay_workspace_id: Option<&String>,
) -> bool {
    active.is_some_and(|workspace| {
        status.verification == Verification::Verified
            && status.base_url.as_ref() == Some(&workspace.base_url)
            && status.workspace_id.as_ref() == account_relay_workspace_id
    })
}

/// Whether a recorded owner is the signed-in person in the account workspace.
/// An owner recorded without a workspace matches on the person alone.
fn owner_matches(owner: &AgentOwner, account: &CloudAccount) -> bool {
    Some(owner.user_id.as_str()) == account.user_id.as_deref()
        && owner
            .workspace_id
            .as_deref()
            .is_none_or(|workspace| workspace == account.workspace_id)
}

fn sync_failure_message(error: &CloudError) -> String {
    match error {
        CloudError::Status { status, .. } => {
            format!("Desktop identity sync failed (HTTP {status}): {error}")
        }
        _ => format!("Desktop identity sync failed: {error}"),
    }
}

impl Core {
    /// Coalesces naturally on `desktop_identity_sync`: every waiter reads the
    /// latest store once it gets the lock, so lifecycle transitions cannot
    /// publish a stale snapshot after a clear.
    pub(crate) fn request_desktop_identity_sync(&self) {
        // A sign-in or a workspace change: the spawn node is claimed for it.
        self.request_spawn_claim();
        let Some(core) = self.arc() else { return };
        tokio::spawn(async move { core.sync_desktop_identities().await });
    }

    pub(crate) async fn sync_desktop_identities(self: &Arc<Self>) {
        let _one = self.desktop_identity_sync.lock.lock().await;
        // A clear completes below: links cached before it was queued go now.
        self.forget_cleared_links();
        self.retry_desktop_identity_clears().await;
        self.sync_current_desktop_identities().await;
    }

    async fn sync_current_desktop_identities(&self) {
        let Some(account) = self.plugins.cloud.account() else {
            return;
        };
        // Agent tokens go only with a session confirmed as this person's.
        if !self.plugins.cloud.may_sync_identities() {
            crate::relay::account::note_identity_sync(self, None);
            return;
        }
        let generation = self.plugins.cloud.identity_sync_generation();
        // Agent tokens go only with a session confirmed as this person's.
        let active_workspace = self.workspace();
        let active_status = self.status().workspace;
        let body = self.store.read(|store| {
            let source_id = store.desktop_sync_source_id.clone()?;
            let cloud = store.cloud.as_ref()?;
            if cloud.account_workspace_id.as_deref() != Some(account.workspace_id.as_str()) {
                return None;
            }
            // Relaycast can issue multiple keys for one workspace. Accept an
            // active local key only after Relaycast verified its workspace
            // id against the account binding; key equality remains the safe
            // path before verification completes.
            let active_is_account_workspace = verified_as_account_workspace(
                active_workspace.as_ref(),
                &active_status,
                cloud.workspace_id.as_ref(),
            );
            let unresolved_active_key = active_workspace.as_ref().is_some_and(|workspace| {
                workspace.base_url == cloud.base_url
                    && workspace.key != cloud.key
                    && matches!(
                        active_status.verification,
                        Verification::Pending | Verification::Unreachable
                    )
                    && store.registrations.iter().any(|registration| {
                        store.tokens.contains_key(&registration.name)
                            && registration.base_url == workspace.base_url
                            && registration
                                .workspace_key
                                .as_ref()
                                .is_none_or(|key| key == &workspace.key)
                    })
            });
            // Do not briefly delete a valid alternate-key set while its
            // workspace lookup is still pending or retryable. A rejected
            // key is resolved (and therefore safely excluded).
            if unresolved_active_key {
                return None;
            }
            // An absent registration's token stays on this computer: Cloud
            // acts as the identities it holds, and an ended session's agent
            // must not look present anywhere until the session runs again.
            let identities: Vec<Value> = store
                .registrations
                .iter()
                .filter(|registration| registration.missing_since.is_none())
                // A token on this computer is not permission to transfer the
                // agent when a different person signs in: an agent recorded
                // for someone else (or another workspace) stays here. Legacy
                // and spawned registrations have no local owner record; they
                // sync as before, and Cloud checks each agent's owner itself.
                .filter(|registration| {
                    store
                        .agent_owners
                        .get(&registration.agent_id)
                        .is_none_or(|owner| owner_matches(owner, &account))
                })
                // Native spawns are Cloud-created worker identities, not
                // desktop-session identities. Their Relaycast metadata and
                // ownership come from the audited spawn invocation, so the
                // desktop must not try to re-admit them through this route.
                .filter(|registration| registration.spawn.is_none())
                .filter_map(|registration| {
                    let token = store.tokens.get(&registration.name)?;
                    let key = registration.workspace_key.as_ref().or_else(|| {
                        active_workspace
                            .as_ref()
                            .filter(|workspace| workspace.base_url == registration.base_url)
                            .map(|workspace| &workspace.key)
                    });
                    let key_matches = key == Some(&cloud.key)
                        || (active_is_account_workspace
                            && key == active_workspace.as_ref().map(|workspace| &workspace.key));
                    (registration.base_url == cloud.base_url && key_matches).then(|| {
                        json!({
                            "name": registration.name,
                            "address": registration.direct_address(&self.machine_prefix),
                            "agent_id": registration.agent_id,
                            "token": token,
                        })
                    })
                })
                .collect();
            Some(json!({"source_id": source_id, "identities": identities}))
        });
        let Some(body) = body else { return };
        if self
            .desktop_identity_sync
            .already_synced(&account, generation, &body)
        {
            return;
        }
        if self
            .desktop_identity_sync
            .wait_for_refusal_retry(&account, generation, &body)
        {
            crate::relay::account::note_identity_sync(self, Some(false));
            return;
        }
        let clears = self.queued_identity_clears();
        match self
            .plugins
            .cloud
            .request("PUT", path(&account.workspace_id), Some(body.clone()))
            .await
        {
            Ok(response) => {
                self.desktop_identity_sync.forget_refusal();
                self.desktop_identity_sync
                    .remember_synced(account.clone(), generation, body);
                crate::relay::account::note_identity_sync(self, Some(true));
                self.apply_mcp_links(&account.workspace_id, &clears, &response);
            }
            Err(error) => {
                self.desktop_identity_sync.forget_synced();
                crate::relay::account::note_identity_sync(self, Some(false));
                // A 503 is Cloud unable to verify identities with Relaycast
                // right now; sent again every minute it only adds to that
                // load, so it backs off like a refusal.
                let report = if matches!(
                    &error,
                    CloudError::Status {
                        status: 403 | 503,
                        ..
                    }
                ) {
                    self.desktop_identity_sync
                        .remember_refusal(account, generation, body)
                } else {
                    true
                };
                if report {
                    self.report_sync_failure(&error);
                }
            }
        }
    }

    /// A failed identity sync leaves `join_relay` unable to link this
    /// desktop's agents, so it is reported, never dropped silently.
    fn report_sync_failure(&self, error: &CloudError) {
        let message = sync_failure_message(error);
        crate::relay::diagnostics::write(format_args!("relay: {message}"));
        self.hub.activity(Level::Warning, message);
    }

    /// Reads which of this desktop's synced identities a hosted MCP session
    /// has linked to since the last sync. The identity `PUT` runs only when
    /// the agents change, so a `join_relay` made after it is learned here,
    /// on the refresh pass: a read of Cloud's stored links, no tokens sent.
    pub(crate) async fn refresh_mcp_links(&self) {
        let Some(account) = self.plugins.cloud.account() else {
            return;
        };
        // Clears complete only under this lock, so none can finish while
        // the read is in flight; one queued meanwhile changes the pending
        // set, and `apply_mcp_links` then drops the response.
        let _one = self.desktop_identity_sync.lock.lock().await;
        let source_id = self.store.read(|store| {
            let present = store
                .registrations
                .iter()
                .any(|registration| registration.missing_since.is_none());
            let cloud = store.cloud.as_ref()?;
            (present
                && cloud.account_workspace_id.as_deref() == Some(account.workspace_id.as_str()))
            .then(|| store.desktop_sync_source_id.clone())
            .flatten()
        });
        let Some(source_id) = source_id else { return };
        let path = format!(
            "{}?source_id={}",
            path(&account.workspace_id),
            segment(&source_id)
        );
        let clears = self.queued_identity_clears();
        if let Ok(response) = self.plugins.cloud.request("GET", path, None).await {
            self.apply_mcp_links(&account.workspace_id, &clears, &response);
        }
    }

    /// The workspace refresh, then the hosted MCP links (see
    /// [`Core::refresh_mcp_links`]).
    pub(crate) async fn refresh_pass(&self) {
        self.refresh_workspace().await;
        self.refresh_mcp_links().await;
    }

    fn mcp_links(&self) -> std::sync::MutexGuard<'_, McpLinks> {
        // Only plain map writes happen under it: a poisoned guard is whole.
        let links = &self.desktop_identity_sync.links;
        links
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The identity clears queued now, each by its request (or, for one
    /// saved without a request id, its workspace and source), with the
    /// account workspace it clears.
    fn queued_identity_clears(&self) -> BTreeSet<(String, String)> {
        self.store.read(|store| {
            let clears = store.desktop_identity_clears_pending.iter().flatten();
            clears
                .map(|clear| {
                    let fallback = || format!("{}/{}", clear.workspace_id, clear.source_id);
                    let id = clear.request_id.clone().unwrap_or_else(fallback);
                    (id, clear.workspace_id.clone())
                })
                .collect()
        })
    }

    /// Drops the cached links once a clear was queued after they were
    /// reported (a sign-out or switch): Cloud drops its links with it.
    fn forget_cleared_links(&self) {
        let clears = self.queued_identity_clears();
        let mut links = self.mcp_links();
        if !clears.is_subset(&links.clears_seen) {
            *links = McpLinks::default();
        }
    }

    /// When a hosted MCP session last linked itself to `agent_id`, as the
    /// signed-in account's workspace reported it. Nothing while signed out,
    /// for another account, or once an identity clear (a sign-out or switch)
    /// was queued after Cloud reported it: that clear drops Cloud's links.
    /// A clear that was already queued, such as an old one still failing,
    /// does not hide what was reported since.
    pub(crate) fn mcp_linked_at(&self, agent_id: &str) -> Option<String> {
        let account = self.plugins.cloud.account()?;
        self.forget_cleared_links();
        let links = self.mcp_links();
        (links.workspace_id == account.workspace_id)
            .then(|| links.linked_at.get(agent_id).cloned())
            .flatten()
    }

    /// Records the hosted MCP links Cloud reported for `workspace_id`. A
    /// response without `identities` (an older Cloud, or a failed link read)
    /// changes nothing; an identity listed without a link loses its old one.
    /// Dropped: a response for an account that is no longer the signed-in
    /// one; one in flight while an identity clear was queued or finished
    /// (`clears` is the set queued when the request was sent); and any while
    /// a clear of this same workspace is still queued, since Cloud is about
    /// to drop the links it reports.
    pub(crate) fn apply_mcp_links(
        &self,
        workspace_id: &str,
        clears: &BTreeSet<(String, String)>,
        response: &Value,
    ) {
        let Some(identities) = response.get("identities").and_then(Value::as_array) else {
            return;
        };
        let current = self
            .plugins
            .cloud
            .account()
            .is_some_and(|account| account.workspace_id == workspace_id);
        let clearing = clears.iter().any(|(_, cleared)| cleared == workspace_id);
        if !current || clearing || self.queued_identity_clears() != *clears {
            return;
        }
        let mut links = self.mcp_links();
        if links.workspace_id != workspace_id || links.clears_seen != *clears {
            *links = McpLinks {
                workspace_id: workspace_id.to_string(),
                clears_seen: clears.clone(),
                linked_at: BTreeMap::new(),
            };
        }
        for identity in identities {
            let Some(agent_id) = identity.get("agent_id").and_then(Value::as_str) else {
                continue;
            };
            let linked =
                identity.get("linked_mcp").and_then(Value::as_str) == Some(hosted_mcp::SERVER_NAME);
            match identity.get("linked_at").and_then(Value::as_str) {
                Some(at) if linked => {
                    links.linked_at.insert(agent_id.to_string(), at.to_string());
                }
                _ => {
                    links.linked_at.remove(agent_id);
                }
            }
        }
    }

    async fn retry_desktop_identity_clears(&self) {
        let pending = self.store.read(|store| {
            store
                .desktop_identity_clears_pending
                .clone()
                .unwrap_or_default()
        });
        for clear in pending {
            let Ok(session) = self.send_desktop_identity_clear(&clear).await else {
                // One old credential must not starve the current account's
                // upsert. It remains durable and is retried on supervision.
                continue;
            };
            // Cloud no longer holds what it last accepted from this source,
            // so the current set is sent again on this pass.
            self.desktop_identity_sync.forget_synced();
            if clear.revoke_after {
                cloud_session::revoke(&session).await;
            }
            let request_id = clear.request_id.clone();
            let _ = self.store.update(|store| {
                if let Some(clears) = store.desktop_identity_clears_pending.as_mut() {
                    clears.retain(|current| current.request_id != request_id);
                    if clears.is_empty() {
                        store.desktop_identity_clears_pending = None;
                    }
                }
            });
        }
    }

    async fn send_desktop_identity_clear(
        &self,
        clear: &DesktopIdentityClear,
    ) -> Result<CloudSession, CloudError> {
        let body = || json!({"source_id": clear.source_id, "identities": []});
        let mut session = match self.fresh_clear_session(clear).await {
            Ok(session) => session,
            Err(saved_error) => {
                return self
                    .send_clear_with_current_account(clear, body())
                    .await
                    .map(|_| clear.session.clone())
                    .map_err(|current_error| {
                        if current_error == CloudError::Rejected {
                            saved_error
                        } else {
                            current_error
                        }
                    });
            }
        };
        match cleared(
            cloud_session::api(
                &session.site_url,
                &session.access_token,
                "PUT",
                &path(&clear.workspace_id),
                Some(body()),
            )
            .await,
        ) {
            Ok(()) => return Ok(session),
            Err(CloudError::Rejected) if can_refresh(&session, crate::relay::state::now_ms()) => {
                if let Ok(refreshed) = cloud_session::refresh(&session).await {
                    if self.save_refreshed_clear(clear, &refreshed).is_ok() {
                        session = refreshed;
                        if cleared(
                            cloud_session::api(
                                &session.site_url,
                                &session.access_token,
                                "PUT",
                                &path(&clear.workspace_id),
                                Some(body()),
                            )
                            .await,
                        )
                        .is_ok()
                        {
                            return Ok(session);
                        }
                    }
                }
            }
            Err(_) => {}
        }
        // A later sign-in by the same owner can finish a clear whose saved
        // credential expired. Cloud still proves ownership and workspace.
        self.send_clear_with_current_account(clear, body())
            .await
            .map(|_| session)
    }

    async fn send_clear_with_current_account(
        &self,
        clear: &DesktopIdentityClear,
        body: Value,
    ) -> Result<(), CloudError> {
        let same_workspace = self
            .plugins
            .cloud
            .account()
            .is_some_and(|account| account.workspace_id == clear.workspace_id);
        if !same_workspace {
            return Err(CloudError::Rejected);
        }
        cleared(
            self.plugins
                .cloud
                .request("PUT", path(&clear.workspace_id), Some(body))
                .await,
        )
    }

    async fn fresh_clear_session(
        &self,
        clear: &DesktopIdentityClear,
    ) -> Result<CloudSession, CloudError> {
        let session = clear.session.clone();
        let now = crate::relay::state::now_ms();
        if access_is_fresh(&session, FRESH_MARGIN, now) || !can_refresh(&session, now) {
            return Ok(session);
        }
        let refreshed = cloud_session::refresh(&session).await?;
        self.save_refreshed_clear(clear, &refreshed)?;
        Ok(refreshed)
    }

    fn save_refreshed_clear(
        &self,
        clear: &DesktopIdentityClear,
        session: &CloudSession,
    ) -> Result<(), CloudError> {
        let request_id = clear.request_id.clone();
        self.store
            .update(|store| {
                if let Some(current) = store
                    .desktop_identity_clears_pending
                    .iter_mut()
                    .flatten()
                    .find(|current| current.request_id == request_id)
                {
                    current.session = session.clone();
                }
            })
            .map_err(|_| CloudError::Unreachable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::cloud_session::{CloudAccess, CloudAccount};
    use crate::relay::daemon::{Config, Plugins};
    use crate::relay::delivery::DeliveryTiming;
    use crate::relay::hosted_mcp::{McpAccess, NO_SERVER as NO_SERVER_FOR_TEST};
    use crate::relay::paths::CorePaths;
    use crate::relay::push::PushTiming;
    use crate::relay::store::{
        iso8601_from_seconds, CloudWorkspace, Registration, SessionKind, SpawnOrigin, Target,
    };
    use crate::relay::workspace::Secret;
    use futures_util::future::BoxFuture;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::thread;
    use std::time::Instant;

    const WORKSPACE: &str = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const CAST: &str = "https://cast.agentrelay.com";
    const KEY: &str = "rk_live_cloudcloud";
    const LOCAL_KEY: &str = "rk_live_local_local";

    #[derive(Default)]
    struct FakeCloud {
        calls: Mutex<Vec<(String, String, Option<Value>)>>,
        identity_sync_generation: AtomicU64,
        /// What every request answers; `{"synced": true}` when unset.
        response: Mutex<Option<Value>>,
        /// Runs when a request is sent, before it answers.
        on_request: Mutex<Option<Box<dyn Fn() + Send>>>,
        /// When set, every request fails with this error.
        failure: Mutex<Option<CloudError>>,
    }

    impl CloudAccess for FakeCloud {
        fn identity_sync_generation(&self) -> u64 {
            self.identity_sync_generation.load(Ordering::SeqCst)
        }

        fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
            None
        }

        fn account(&self) -> Option<CloudAccount> {
            Some(CloudAccount {
                site_url: "https://agentrelay.com".into(),
                workspace_id: WORKSPACE.into(),
                user_id: Some("user-1".into()),
            })
        }

        fn request(
            &self,
            method: &'static str,
            path: String,
            body: Option<Value>,
        ) -> BoxFuture<'_, Result<Value, CloudError>> {
            self.calls.lock().unwrap().push((method.into(), path, body));
            if let Some(hook) = self.on_request.lock().unwrap().as_ref() {
                hook();
            }
            if let Some(error) = self.failure.lock().unwrap().clone() {
                return Box::pin(async move { Err(error) });
            }
            let response = self
                .response
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| json!({"synced": true}));
            Box::pin(async move { Ok(response) })
        }
    }

    fn core() -> (tempfile::TempDir, Arc<Core>, Arc<FakeCloud>) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.clone(),
            app_data_dir: home.join("app-data"),
            env: BTreeMap::new(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let cloud = Arc::new(FakeCloud::default());
        let plugins = Plugins {
            cloud: cloud.clone(),
            ..Plugins::default()
        };
        let (core, _) = Core::with_plugins(config, plugins);
        (temp, core, cloud)
    }

    fn registration(name: &str, agent_id: &str, key: &str) -> Registration {
        Registration {
            name: name.into(),
            agent_id: agent_id.into(),
            target: Target::new(SessionKind::Codex, crate::relay::store::random_uuid()),
            title: name.into(),
            base_url: CAST.into(),
            registered_at: iso8601_from_seconds(0.0),
            workspace_key: Some(Secret::new(key)),
            machine_prefix: Some("test-desk".into()),
            added_by_session: None,
            auto_activated: None,
            missing_since: None,
            archived_at: None,
            webhook: None,
            reply_with_final_answer: None,
            integration_channel_id: None,
            integration_channel_name: None,
            integrations: None,
            route_binding: None,
            spawn: None,
            mcp: None,
            alias: None,
            retired_aliases: None,
        }
    }

    /// A site that answers every request with 401. It counts the requests it
    /// reads and stops once the client has returned and its accept queue is
    /// empty, or at `SITE_DEADLINE`, so a client that sends fewer requests than
    /// a test expects fails that test's count instead of hanging the run.
    struct RejectingSite {
        url: String,
        client_returned: Arc<AtomicBool>,
        server: thread::JoinHandle<usize>,
    }

    const SITE_DEADLINE: Duration = Duration::from_secs(10);

    impl RejectingSite {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let client_returned = Arc::new(AtomicBool::new(false));
            let returned = client_returned.clone();
            let server = thread::spawn(move || {
                let deadline = Instant::now() + SITE_DEADLINE;
                let mut requests = 0;
                loop {
                    // Read the flag before accepting: every connection the
                    // client made is queued before it returns, so an empty
                    // queue after that means it is done.
                    let stopped = returned.load(Ordering::SeqCst);
                    let stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            if stopped || Instant::now() >= deadline {
                                return requests;
                            }
                            thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("{error}"),
                    };
                    if reject(stream) {
                        requests += 1;
                    }
                }
            });
            Self {
                url,
                client_returned,
                server,
            }
        }

        /// The number of requests the site read, once the client has returned.
        async fn finish(self) -> usize {
            self.client_returned.store(true, Ordering::SeqCst);
            let server = self.server;
            tokio::time::timeout(
                SITE_DEADLINE + Duration::from_secs(5),
                tokio::task::spawn_blocking(move || server.join()),
            )
            .await
            .expect("rejecting site stopped")
            .unwrap()
            .unwrap()
        }
    }

    /// Reads one request and answers 401. Returns false when the client
    /// closed the connection before sending a request.
    fn reject(mut stream: TcpStream) -> bool {
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            return false;
        }
        let mut content_length = 0;
        loop {
            line.clear();
            let read = reader.read_line(&mut line).unwrap();
            assert_ne!(read, 0, "client closed a request before its headers ended");
            let header = line.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().unwrap();
                }
            }
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).unwrap();
        stream
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .unwrap();
        true
    }

    #[tokio::test]
    async fn sync_sends_exact_addresses_and_tokens_only_for_the_account_workspace() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                store.cloud = Some(CloudWorkspace {
                    key: Secret::new(KEY),
                    base_url: CAST.into(),
                    workspace_id: Some("rw_cast".into()),
                    account_workspace_id: Some(WORKSPACE.into()),
                    name: Some("Acme".into()),
                    relayfile_workspace_id: None,
                });
                assert!(store.add(
                    registration("claude-session", "agent-1", KEY),
                    Secret::new("agent-secret"),
                ));
                store.agent_owners.insert(
                    "agent-1".into(),
                    crate::relay::cloud_session::AgentOwner {
                        user_id: "user-1".into(),
                        workspace_id: Some(WORKSPACE.into()),
                    },
                );
                assert!(store.add(
                    registration("another-workspace", "agent-2", "rk_live_otherother"),
                    Secret::new("other-secret"),
                ));
                store.agent_owners.insert(
                    "agent-2".into(),
                    crate::relay::cloud_session::AgentOwner {
                        user_id: "user-1".into(),
                        workspace_id: Some(WORKSPACE.into()),
                    },
                );
                // Its session ended: its token is not handed to Cloud.
                let mut absent = registration("ended-session", "agent-3", KEY);
                absent.missing_since = Some("2026-10-01T12:00:00Z".into());
                assert!(store.add(absent, Secret::new("absent-secret")));
                store.agent_owners.insert(
                    "agent-3".into(),
                    crate::relay::cloud_session::AgentOwner {
                        user_id: "user-1".into(),
                        workspace_id: Some(WORKSPACE.into()),
                    },
                );
                assert!(store.add(
                    registration("foreign", "agent-4", KEY),
                    Secret::new("foreign-secret")
                ));
                store.agent_owners.insert(
                    "agent-4".into(),
                    crate::relay::cloud_session::AgentOwner {
                        user_id: "user-2".into(),
                        workspace_id: Some(WORKSPACE.into()),
                    },
                );
                assert!(store.add(
                    registration("unknown", "agent-5", KEY),
                    Secret::new("unknown-secret")
                ));
            })
            .unwrap();

        core.sync_desktop_identities().await;

        let calls = cloud.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "PUT");
        assert_eq!(calls[0].1, path(WORKSPACE));
        let body = calls[0].2.as_ref().unwrap();
        assert!(crate::relay::store::is_uuid(
            body["source_id"].as_str().unwrap()
        ));
        // An agent with no owner record (one registered before owners were
        // recorded) still syncs; Cloud checks its owner. One recorded for
        // another person does not.
        assert_eq!(
            body["identities"],
            json!([
                {
                    "name": "claude-session",
                    "address": "claude-session@test-desk-agent-1",
                    "agent_id": "agent-1",
                    "token": "agent-secret",
                },
                {
                    "name": "unknown",
                    "address": "unknown@test-desk-agent-5",
                    "agent_id": "agent-5",
                    "token": "unknown-secret",
                },
            ])
        );
        assert!(!body.to_string().contains("other-secret"));
        assert!(!body.to_string().contains("absent-secret"));
        assert!(!body.to_string().contains("foreign-secret"));
    }

    #[tokio::test]
    async fn a_store_from_before_owner_records_still_syncs_its_agents() {
        // v2026.10.42 and earlier recorded no `agentOwners`: their agents
        // must keep their Cloud identities after an update.
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("first", "agent-1", KEY), Secret::new("one")));
                assert!(store.add(registration("second", "agent-2", KEY), Secret::new("two")));
                assert!(store.agent_owners.is_empty());
            })
            .unwrap();

        core.sync_desktop_identities().await;

        let calls = cloud.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let names: Vec<&str> = calls[0].2.as_ref().unwrap()["identities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|identity| identity["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["first", "second"]);
    }

    #[tokio::test]
    async fn native_spawns_are_not_desktop_session_identities() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("session", "agent-1", KEY), Secret::new("one")));
                let mut spawned = registration("spawned", "agent-2", KEY);
                spawned.spawn = Some(SpawnOrigin {
                    node_id: "node-1".into(),
                    node_name: "test-desk".into(),
                    invocation_id: "invocation-1".into(),
                    harness: "claude".into(),
                    requester: None,
                    process: None,
                    owner: None,
                    taken_over_at: None,
                    task_unconfirmed: None,
                });
                assert!(store.add(spawned, Secret::new("two")));
            })
            .unwrap();

        core.sync_desktop_identities().await;

        let calls = cloud.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].2.as_ref().unwrap()["identities"],
            json!([{
                "name": "session",
                "address": "session@test-desk-agent-1",
                "agent_id": "agent-1",
                "token": "one",
            }])
        );
    }

    #[tokio::test]
    async fn an_agent_recorded_for_another_person_or_workspace_stays_here() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                for (name, id, user, workspace) in [
                    ("mine", "agent-1", "user-1", Some(WORKSPACE)),
                    ("theirs", "agent-2", "user-2", Some(WORKSPACE)),
                    ("elsewhere", "agent-3", "user-1", Some("another-workspace")),
                    ("mine-anywhere", "agent-4", "user-1", None),
                ] {
                    assert!(store.add(registration(name, id, KEY), Secret::new(name)));
                    store.agent_owners.insert(
                        id.into(),
                        crate::relay::cloud_session::AgentOwner {
                            user_id: user.into(),
                            workspace_id: workspace.map(Into::into),
                        },
                    );
                }
            })
            .unwrap();

        core.sync_desktop_identities().await;

        let calls = cloud.calls.lock().unwrap();
        let names: Vec<&str> = calls[0].2.as_ref().unwrap()["identities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|identity| identity["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["mine", "mine-anywhere"]);
    }

    #[tokio::test]
    async fn a_permanent_identity_refusal_is_reported_once_per_snapshot() {
        let (_temp, core, cloud) = core();
        *cloud.failure.lock().unwrap() = Some(CloudError::Status {
            status: 403,
            message: Some(
                "Desktop identity @first could not be verified in this workspace.".into(),
            ),
        });
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("first", "agent-1", KEY), Secret::new("one")));
            })
            .unwrap();
        let mut events = core.hub.subscribe();

        core.sync_desktop_identities().await;
        core.sync_desktop_identities().await;

        let reported = std::iter::from_fn(|| events.try_recv().ok())
            .filter(|event| event.topic == crate::relay::protocol::Topic::Activity)
            .map(|event| {
                event.data["message"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            reported,
            ["Desktop identity sync failed (HTTP 403): Desktop identity @first could not be verified in this workspace."]
        );
        assert!(!reported[0].contains("one"));
        assert_eq!(cloud.calls.lock().unwrap().len(), 1);

        *cloud.failure.lock().unwrap() = None;
        core.store
            .update(|store| {
                assert!(store.add(registration("second", "agent-2", KEY), Secret::new("two")));
            })
            .unwrap();
        core.sync_desktop_identities().await;
        assert_eq!(cloud.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_unchanged_set_cloud_accepted_is_not_sent_again() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("first", "agent-1", KEY), Secret::new("one")));
            })
            .unwrap();
        core.sync_desktop_identities().await;
        core.sync_desktop_identities().await;
        assert_eq!(
            cloud.calls.lock().unwrap().len(),
            1,
            "Cloud already holds it"
        );

        // A changed set is sent at once.
        core.store
            .update(|store| {
                assert!(store.add(registration("second", "agent-2", KEY), Secret::new("two")));
            })
            .unwrap();
        core.sync_desktop_identities().await;
        assert_eq!(cloud.calls.lock().unwrap().len(), 2);

        // So is the same set after a new sign-in.
        cloud
            .identity_sync_generation
            .fetch_add(1, Ordering::SeqCst);
        core.sync_desktop_identities().await;
        assert_eq!(cloud.calls.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_failed_sync_is_not_taken_as_synced() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("first", "agent-1", KEY), Secret::new("one")));
            })
            .unwrap();
        core.sync_desktop_identities().await;
        *cloud.failure.lock().unwrap() = Some(CloudError::Status {
            status: 500,
            message: None,
        });
        core.store
            .update(|store| {
                assert!(store.add(registration("second", "agent-2", KEY), Secret::new("two")));
            })
            .unwrap();
        core.sync_desktop_identities().await;
        *cloud.failure.lock().unwrap() = None;
        core.sync_desktop_identities().await;
        assert_eq!(
            cloud.calls.lock().unwrap().len(),
            3,
            "the failed set is sent again"
        );
    }

    #[tokio::test]
    async fn cloud_unable_to_verify_backs_off_like_a_refusal() {
        let (_temp, core, cloud) = core();
        *cloud.failure.lock().unwrap() = Some(CloudError::Status {
            status: 503,
            message: Some("Agent Relay could not verify desktop identities right now.".into()),
        });
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("first", "agent-1", KEY), Secret::new("one")));
            })
            .unwrap();
        let mut events = core.hub.subscribe();
        core.sync_desktop_identities().await;
        core.sync_desktop_identities().await;
        assert_eq!(
            cloud.calls.lock().unwrap().len(),
            1,
            "not sent again every pass"
        );
        let reported = std::iter::from_fn(|| events.try_recv().ok())
            .filter(|event| event.topic == crate::relay::protocol::Topic::Activity)
            .count();
        assert_eq!(reported, 1, "reported once");
    }

    #[tokio::test]
    async fn a_new_sign_in_retries_an_unchanged_refusal() {
        let (_temp, core, cloud) = core();
        *cloud.failure.lock().unwrap() = Some(CloudError::Status {
            status: 403,
            message: None,
        });
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("first", "agent-1", KEY), Secret::new("one")));
            })
            .unwrap();
        core.sync_desktop_identities().await;
        assert_eq!(cloud.calls.lock().unwrap().len(), 1);

        *cloud.failure.lock().unwrap() = None;
        cloud
            .identity_sync_generation
            .fetch_add(1, Ordering::SeqCst);
        core.sync_desktop_identities().await;

        assert_eq!(cloud.calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_different_key_needs_a_verified_matching_relay_workspace() {
        let active = Workspace {
            key: Secret::new(LOCAL_KEY),
            base_url: CAST.into(),
            workspace_id: Some("rw_cast".into()),
        };
        let mut status = WorkspaceStatus::discovered(Some(&active));
        let account_id = "rw_cast".to_string();
        assert!(!verified_as_account_workspace(
            Some(&active),
            &status,
            Some(&account_id)
        ));
        assert_eq!(status.verification, Verification::Pending);
        status.verification = Verification::Verified;
        assert!(verified_as_account_workspace(
            Some(&active),
            &status,
            Some(&account_id)
        ));
        status.workspace_id = Some("rw_other".into());
        assert!(!verified_as_account_workspace(
            Some(&active),
            &status,
            Some(&account_id)
        ));
    }

    #[tokio::test]
    async fn a_failed_old_workspace_clear_does_not_starve_the_current_upsert() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                let source = store.desktop_sync_source_id.clone().unwrap();
                store.cloud = Some(CloudWorkspace {
                    key: Secret::new(KEY),
                    base_url: CAST.into(),
                    workspace_id: Some("rw_cast".into()),
                    account_workspace_id: Some(WORKSPACE.into()),
                    name: None,
                    relayfile_workspace_id: None,
                });
                store.desktop_identity_clears_pending = Some(vec![DesktopIdentityClear::new(
                    "00000000-0000-4000-8000-000000000099".into(),
                    source,
                    CloudSession {
                        access_token: Secret::new("old-access"),
                        access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                        refresh_token: None,
                        refresh_token_expires_at: None,
                        site_url: "http://127.0.0.1:1".into(),
                    },
                    false,
                )]);
            })
            .unwrap();

        core.sync_desktop_identities().await;

        assert_eq!(cloud.calls.lock().unwrap().len(), 1);
        assert_eq!(
            core.store
                .read(|store| store.desktop_identity_clears_pending.as_ref().map(Vec::len)),
            Some(1)
        );
    }

    #[tokio::test]
    async fn a_deleted_workspace_finishes_its_clear() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut content_length = 0;
            let mut line = String::new();
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                let header = line.trim_end();
                if header.is_empty() {
                    break;
                }
                if let Some((name, value)) = header.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut body = vec![0; content_length];
            reader.read_exact(&mut body).unwrap();
            let answer = r#"{"error":"Workspace not found"}"#;
            let mut stream = stream;
            write!(
                stream,
                "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            )
            .unwrap();
        });
        let (_temp, core, _cloud) = core();
        core.store
            .update(|store| {
                let source = store.desktop_sync_source_id.clone().unwrap();
                store.desktop_identity_clears_pending = Some(vec![DesktopIdentityClear::new(
                    "0fb35c2e-861f-4d44-848e-fa3f5a3e192e".into(),
                    source,
                    CloudSession {
                        access_token: Secret::new("old-access"),
                        access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                        refresh_token: None,
                        refresh_token_expires_at: None,
                        site_url: site,
                    },
                    false,
                )]);
            })
            .unwrap();

        core.sync_desktop_identities().await;
        server.join().unwrap();

        assert_eq!(
            core.store
                .read(|store| store.desktop_identity_clears_pending.clone()),
            None
        );
    }

    #[tokio::test]
    async fn current_sign_in_finishes_clear_when_saved_refresh_fails() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                let source = store.desktop_sync_source_id.clone().unwrap();
                store.desktop_identity_clears_pending = Some(vec![DesktopIdentityClear::new(
                    WORKSPACE.into(),
                    source,
                    CloudSession {
                        access_token: Secret::new("expired-access"),
                        access_token_expires_at: Some("2000-01-01T00:00:00Z".into()),
                        refresh_token: Some(Secret::new("rejected-refresh")),
                        refresh_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                        site_url: "http://127.0.0.1:1".into(),
                    },
                    false,
                )]);
            })
            .unwrap();

        core.sync_desktop_identities().await;

        assert_eq!(cloud.calls.lock().unwrap().len(), 1);
        assert_eq!(
            core.store
                .read(|store| store.desktop_identity_clears_pending.as_ref().map(Vec::len)),
            None
        );
    }

    #[tokio::test]
    async fn a_finished_clear_has_the_current_set_sent_again() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(registration("first", "agent-1", KEY), Secret::new("one")));
            })
            .unwrap();
        core.sync_desktop_identities().await;
        assert_eq!(cloud.calls.lock().unwrap().len(), 1);

        // A clear for this source, left by an earlier sign-in, finishes now
        // and empties what Cloud holds from it.
        core.store
            .update(|store| {
                let source = store.desktop_sync_source_id.clone().unwrap();
                store.desktop_identity_clears_pending = Some(vec![DesktopIdentityClear::new(
                    WORKSPACE.into(),
                    source,
                    CloudSession {
                        access_token: Secret::new("expired-access"),
                        access_token_expires_at: Some("2000-01-01T00:00:00Z".into()),
                        refresh_token: Some(Secret::new("rejected-refresh")),
                        refresh_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                        site_url: "http://127.0.0.1:1".into(),
                    },
                    false,
                )]);
            })
            .unwrap();
        core.sync_desktop_identities().await;

        let calls = cloud.calls.lock().unwrap();
        assert_eq!(calls.len(), 3, "the clear, then the unchanged set again");
        let (_, _, body) = calls.last().unwrap();
        assert_eq!(
            body.as_ref().unwrap()["identities"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
    }

    #[tokio::test]
    async fn current_sign_in_finishes_clear_when_rejected_access_cannot_refresh() {
        let (_temp, core, cloud) = core();
        let site = RejectingSite::start();
        core.store
            .update(|store| {
                let source = store.desktop_sync_source_id.clone().unwrap();
                store.desktop_identity_clears_pending = Some(vec![DesktopIdentityClear::new(
                    WORKSPACE.into(),
                    source,
                    CloudSession {
                        access_token: Secret::new("rejected-access"),
                        access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                        refresh_token: Some(Secret::new("rejected-refresh")),
                        refresh_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                        site_url: site.url.clone(),
                    },
                    false,
                )]);
            })
            .unwrap();

        core.sync_desktop_identities().await;
        assert_eq!(site.finish().await, 2);

        assert_eq!(cloud.calls.lock().unwrap().len(), 1);
        assert_eq!(
            core.store
                .read(|store| store.desktop_identity_clears_pending.as_ref().map(Vec::len)),
            None
        );
    }

    fn account_cloud(store: &mut crate::relay::store::Store) {
        store.cloud = Some(CloudWorkspace {
            key: Secret::new(KEY),
            base_url: CAST.into(),
            workspace_id: Some("rw_cast".into()),
            account_workspace_id: Some(WORKSPACE.into()),
            name: None,
            relayfile_workspace_id: None,
        });
    }

    fn registered_at(at: &str, name: &str, agent_id: &str) -> Registration {
        Registration {
            registered_at: at.into(),
            ..registration(name, agent_id, KEY)
        }
    }

    fn access(core: &Core, name: &str) -> McpAccess {
        let target = core.store.read(|store| {
            store
                .registrations
                .iter()
                .find(|registration| registration.name == name)
                .unwrap()
                .target
                .clone()
        });
        core.relay_mcp_access(&target)
    }

    #[tokio::test]
    async fn a_hosted_mcp_link_cloud_reports_since_registration_shows_the_tools() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                for (name, id) in [
                    ("linked", "agent-1"),
                    ("stale", "agent-2"),
                    ("plain", "agent-3"),
                ] {
                    assert!(store.add(
                        registered_at("2026-10-15T15:00:00Z", name, id),
                        Secret::new(format!("{name}-secret")),
                    ));
                }
            })
            .unwrap();
        *cloud.response.lock().unwrap() = Some(json!({"synced": 3, "identities": [
            {"agent_id": "agent-1", "linked_mcp": "agent-relay-sessions", "linked_at": "2026-10-15T15:05:00.000Z"},
            {"agent_id": "agent-2", "linked_mcp": "agent-relay-sessions", "linked_at": "2026-10-15T14:00:00.000Z"},
            {"agent_id": "agent-3", "linked_mcp": null, "linked_at": null},
        ]}));

        core.sync_desktop_identities().await;

        assert_eq!(access(&core, "linked"), McpAccess::Declared);
        assert_eq!(access(&core, "stale"), McpAccess::Unknown);
        assert_eq!(access(&core, "plain"), McpAccess::Unknown);
        assert_eq!(
            core.mcp_linked_at("agent-1"),
            Some("2026-10-15T15:05:00.000Z".into())
        );
    }

    #[tokio::test]
    async fn a_link_outranks_the_declared_word_and_leaves_when_cloud_drops_it() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                let mut said_none = registered_at("2026-10-15T15:00:00Z", "said-none", "agent-1");
                said_none.mcp = Some(NO_SERVER_FOR_TEST.into());
                assert!(store.add(said_none, Secret::new("secret")));
            })
            .unwrap();
        assert_eq!(access(&core, "said-none"), McpAccess::SocketOnly);
        *cloud.response.lock().unwrap() = Some(json!({"identities": [
            {"agent_id": "agent-1", "linked_mcp": "agent-relay-sessions", "linked_at": "2026-10-15T15:05:00Z"},
        ]}));

        core.refresh_mcp_links().await;
        assert_eq!(access(&core, "said-none"), McpAccess::Declared);
        {
            let calls = cloud.calls.lock().unwrap();
            let (method, path, body) = calls.last().unwrap();
            assert_eq!(method, "GET");
            let source = core
                .store
                .read(|store| store.desktop_sync_source_id.clone().unwrap());
            assert_eq!(
                path,
                &format!("{}?source_id={source}", super::path(WORKSPACE))
            );
            assert!(body.is_none(), "the link read sends no tokens");
        }

        // An older Cloud without the report changes nothing.
        *cloud.response.lock().unwrap() = Some(json!({"synced": 1}));
        core.sync_desktop_identities().await;
        assert_eq!(access(&core, "said-none"), McpAccess::Declared);

        // leave_relay removed the binding: back to the declared word.
        *cloud.response.lock().unwrap() = Some(json!({"identities": [
            {"agent_id": "agent-1", "linked_mcp": null, "linked_at": null},
        ]}));
        core.refresh_mcp_links().await;
        assert_eq!(access(&core, "said-none"), McpAccess::SocketOnly);
    }

    #[tokio::test]
    async fn the_link_read_waits_for_a_present_agent_in_the_account_workspace() {
        let (_temp, core, cloud) = core();
        core.refresh_mcp_links().await;
        core.store
            .update(|store| {
                account_cloud(store);
                let mut gone = registration("gone", "agent-1", KEY);
                gone.missing_since = Some("2026-10-01T12:00:00Z".into());
                assert!(store.add(gone, Secret::new("secret")));
            })
            .unwrap();
        core.refresh_mcp_links().await;
        assert!(cloud.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_cached_link_stops_counting_once_the_account_is_cleared() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(
                    registered_at("2026-10-15T15:00:00Z", "linked", "agent-1"),
                    Secret::new("secret"),
                ));
            })
            .unwrap();
        *cloud.response.lock().unwrap() = Some(json!({"identities": [
            {"agent_id": "agent-1", "linked_mcp": "agent-relay-sessions", "linked_at": "2026-10-15T15:05:00Z"},
        ]}));
        core.refresh_mcp_links().await;
        assert_eq!(access(&core, "linked"), McpAccess::Declared);

        // A response for another account (in flight across a switch) is dropped.
        core.apply_mcp_links(
            "another-account-workspace",
            &BTreeSet::new(),
            &json!({"identities": [{"agent_id": "agent-1", "linked_mcp": null, "linked_at": null}]}),
        );
        assert_eq!(access(&core, "linked"), McpAccess::Declared);

        // Sign-out queues Cloud's clear of every identity: the link stops
        // counting at once, and no late response can restore it.
        core.store
            .update(|store| {
                store.cloud_session = Some(CloudSession {
                    access_token: Secret::new("access"),
                    access_token_expires_at: None,
                    refresh_token: None,
                    refresh_token_expires_at: None,
                    site_url: "http://127.0.0.1:1".into(),
                });
                assert!(store.queue_desktop_identity_clear(false));
            })
            .unwrap();
        assert_eq!(access(&core, "linked"), McpAccess::Unknown);
        core.refresh_mcp_links().await;
        assert_eq!(core.mcp_linked_at("agent-1"), None);

        // The clear completes (the current sign-in finishes it); the cached
        // link was dropped with it, so it does not come back.
        *cloud.response.lock().unwrap() = Some(json!({"synced": 0}));
        core.sync_desktop_identities().await;
        assert!(core
            .store
            .read(|store| store.desktop_identity_clears_pending.is_none()));
        assert_eq!(access(&core, "linked"), McpAccess::Unknown);
    }

    #[tokio::test]
    async fn an_old_clear_still_failing_does_not_hide_links_reported_since() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(
                    registered_at("2026-10-15T15:00:00Z", "linked", "agent-1"),
                    Secret::new("secret"),
                ));
                // An earlier account's clear whose credential keeps failing.
                let source = store.desktop_sync_source_id.clone().unwrap();
                store.desktop_identity_clears_pending = Some(vec![DesktopIdentityClear::new(
                    "00000000-0000-4000-8000-000000000099".into(),
                    source,
                    CloudSession {
                        access_token: Secret::new("old-access"),
                        access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                        refresh_token: None,
                        refresh_token_expires_at: None,
                        site_url: "http://127.0.0.1:1".into(),
                    },
                    false,
                )]);
            })
            .unwrap();
        *cloud.response.lock().unwrap() = Some(json!({"identities": [
            {"agent_id": "agent-1", "linked_mcp": "agent-relay-sessions", "linked_at": "2026-10-15T15:05:00Z"},
        ]}));

        core.refresh_mcp_links().await;
        assert_eq!(access(&core, "linked"), McpAccess::Declared);
        core.sync_desktop_identities().await;
        assert_eq!(
            core.store
                .read(|store| store.desktop_identity_clears_pending.as_ref().map(Vec::len)),
            Some(1),
            "the old clear is still queued"
        );
        assert_eq!(access(&core, "linked"), McpAccess::Declared);
    }

    #[tokio::test]
    async fn a_link_read_holds_off_clears_until_it_lands() {
        let (_temp, core, cloud) = core();
        core.store
            .update(|store| {
                account_cloud(store);
                assert!(store.add(
                    registered_at("2026-10-15T15:00:00Z", "linked", "agent-1"),
                    Secret::new("secret"),
                ));
            })
            .unwrap();
        *cloud.response.lock().unwrap() = Some(json!({"identities": [
            {"agent_id": "agent-1", "linked_mcp": "agent-relay-sessions", "linked_at": "2026-10-15T15:05:00Z"},
        ]}));
        let held = Arc::new(AtomicBool::new(false));
        let (seen, weak) = (held.clone(), Arc::downgrade(&core));
        *cloud.on_request.lock().unwrap() = Some(Box::new(move || {
            // A clear cannot complete now: completing one needs this lock.
            let core = weak.upgrade().unwrap();
            seen.store(
                core.desktop_identity_sync.lock.try_lock().is_err(),
                Ordering::SeqCst,
            );
        }));

        core.refresh_mcp_links().await;

        assert!(held.load(Ordering::SeqCst), "the read ran without the lock");
        assert_eq!(access(&core, "linked"), McpAccess::Declared);
    }
}
