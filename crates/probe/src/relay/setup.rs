//! Agent-led setup: the `/setup/*`, `/webhooks` and `/integrations/*`
//! routes of the relay-send socket, for a session the kernel identified,
//! before or after it is on the relay.
//!
//! Sign-in and uploads are the account's and the uploader's bridge methods
//! (`account.status`, `account.sign_in`, `uploader.status`,
//! `uploader.sharing.set`), called exactly as a client would call them; a
//! core built without them answers `setup_unavailable`. Webhooks and
//! integrations are the agent runtime's own. No route returns a Cloud
//! bearer, workspace key or agent token; a newly created webhook's secret is
//! returned once, to the session that created it.
//!
//! The first setup request applies the agent-led defaults once: Claude Code
//! direct delivery (unless the user's own settings already name
//! `crossSessionInbound`, `hold` included), automatic activation of live and future sessions, and
//! uploads of only the sessions a person chooses (sharing mode `selected`):
//! nothing uploads until a session is chosen. A sign-in through setup
//! installs the uploader in that mode, and the bootstrap never changes an
//! install's sharing mode, so it never widens what an install shares, nor
//! narrows a mode its owner chose. The defaults are
//! recorded as applied once all three hold with a workspace signed in, and
//! an explicit setup choice (`POST /setup/sharing` with `new` or `all`
//! included) also closes the bootstrap, so later choices survive status
//! reads and restarts.
//!
//! No route waits on work it does not report. The local defaults are applied
//! in place; the uploader's sharing mode and Relaycast's verification of a
//! newly found workspace key continue in the background, and `/setup/status`
//! answers from the last state they left. See docs/agent-driven-setup.md.

use crate::relay::daemon::Core;
use crate::relay::delivery::policy::relayfile_glob;
use crate::relay::outbound::OutboundError;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::server;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, Registration, SessionKind};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Claude Code's `crossSessionInbound` setting, as setup changes it.
pub trait DirectDelivery: Send + Sync {
    /// Whether Claude Code delivers relayed messages without holding them.
    fn delivers_directly(&self) -> bool;
    /// The organization-managed value, which a user setting cannot override.
    fn managed_value(&self) -> Option<String>;
    /// The user's own value whenever their settings name the key, with any
    /// value (`hold` included): an explicit choice the defaults never
    /// override. `None` when the key is absent, Claude Code's own default.
    fn user_choice(&self) -> Option<String>;
    /// Sets (`true`, "accept") or removes (`false`) the user's setting.
    /// The message is safe to show.
    fn set_direct_delivery(&self, enabled: bool) -> Result<(), String>;
}

/// Why the agent-led defaults are not all in place.
#[derive(Clone, Debug, PartialEq, Eq)]
struct DefaultsError {
    code: String,
    message: String,
}

impl From<&OutboundError> for DefaultsError {
    fn from(error: &OutboundError) -> DefaultsError {
        DefaultsError {
            code: error.code.clone(),
            message: error.message.clone(),
        }
    }
}

fn managed_policy() -> OutboundError {
    OutboundError::new(
        409,
        "managed_policy",
        "Managed Claude settings do not allow direct delivery.",
    )
}

/// Clears its flag when the background work holding it ends, however it
/// ends.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct Setup {
    core: Arc<Core>,
    direct: Arc<dyn DirectDelivery>,
    /// One change to the local defaults at a time. Held only across local
    /// reads and writes, never across an await.
    defaults: Mutex<()>,
    /// One uploader sharing change at a time: the bootstrap's or an
    /// explicit choice.
    sharing: tokio::sync::Mutex<()>,
    defaults_error: Mutex<Option<DefaultsError>>,
    /// The bootstrap's uploader step is running.
    bootstrapping: AtomicBool,
    /// The last `uploader.status` answer: `None` before the first arrives,
    /// `Some(None)` when it failed.
    uploader: Mutex<Option<Option<Value>>>,
    /// An `uploader.status` read is running.
    reading_uploader: AtomicBool,
    /// A check for live sessions still waiting to be activated is running.
    checking_activation: AtomicBool,
    /// Bumped whenever an error is reported, so a background activation
    /// check clears only an error it began after.
    errors_set: AtomicU64,
}

impl Setup {
    pub fn new(core: Arc<Core>, direct: Arc<dyn DirectDelivery>) -> Setup {
        Setup {
            core,
            direct,
            defaults: Mutex::new(()),
            sharing: tokio::sync::Mutex::new(()),
            defaults_error: Mutex::new(None),
            bootstrapping: AtomicBool::new(false),
            uploader: Mutex::new(None),
            reading_uploader: AtomicBool::new(false),
            checking_activation: AtomicBool::new(false),
            errors_set: AtomicU64::new(0),
        }
    }

    /// Whether a session of `kind` gets relayed messages without a hold:
    /// Codex always; Claude Code when its setting accepts them; Devin and
    /// Cursor CLI when the desktop's hooks are in their configuration —
    /// without them a staged inbox file is queued but never spoken.
    pub fn session_delivers_directly(&self, kind: SessionKind) -> bool {
        match kind {
            SessionKind::ClaudeTerminal => self.direct.delivers_directly(),
            SessionKind::Devin => self.hooks_on(crate::relay::devin::SETTING),
            SessionKind::CursorCli => self.hooks_on(crate::relay::cursor_cli::SETTING),
            _ => true,
        }
    }

    /// Whether the settings extension owning `key` reports it on.
    fn hooks_on(&self, key: &str) -> bool {
        self.core
            .plugins
            .settings
            .iter()
            .find_map(|extension| extension.get().get(key).and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn set_error(&self, error: Option<DefaultsError>) {
        let mut current = self.defaults_error.lock().unwrap();
        self.errors_set.fetch_add(1, Ordering::SeqCst);
        *current = error;
    }

    fn clear_error_if(&self, code: &str) {
        let mut error = self.defaults_error.lock().unwrap();
        if error.as_ref().is_some_and(|e| e.code == code) {
            *error = None;
        }
    }

    async fn method(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        server::call(&self.core, method, params).await
    }

    /// The account as `account.status` reports it; without the account
    /// methods, signed in exactly when a workspace is known.
    async fn account(&self) -> Value {
        match self.method("account.status", json!({})).await {
            Ok(account) => account,
            Err(_) => {
                let workspace = self.core.status().workspace;
                let signed_in = self.core.workspace().is_some();
                json!({
                    "state": if signed_in { "signed_in" } else { "signed_out" },
                    "workspace_id": workspace.workspace_id,
                    "workspace_name": workspace.workspace_name,
                })
            }
        }
    }

    /// Reads `uploader.status` and keeps the answer for `/setup/status`.
    async fn read_uploader(&self) -> Option<Value> {
        let answer = self.method("uploader.status", json!({})).await.ok();
        *self.uploader.lock().unwrap() = Some(answer.clone());
        answer
    }

    /// Starts an `uploader.status` read unless one is running; status
    /// reports the answer once it arrives.
    fn refresh_uploader(self: &Arc<Self>) {
        if self.reading_uploader.swap(true, Ordering::SeqCst) {
            return;
        }
        let setup = self.clone();
        tokio::spawn(async move {
            let _running = Running(&setup.reading_uploader);
            setup.read_uploader().await;
        });
    }

    /// Sets the uploader's sharing mode; the caller holds `sharing`.
    async fn set_sharing(&self, mode: &str) -> Result<(), RpcError> {
        self.method("uploader.sharing.set", json!({ "mode": mode }))
            .await?;
        if let Some(Some(answer)) = self.uploader.lock().unwrap().as_mut() {
            answer["sharing_mode"] = json!(mode);
        }
        Ok(())
    }

    fn signed_in(&self, account: &Value) -> bool {
        account["state"] == "signed_in" && self.core.workspace().is_some()
    }

    fn set_auto_activate(&self, enabled: bool) -> Result<(), OutboundError> {
        self.core
            .store
            .update(|store| store.auto_activate = Some(enabled))
            .map_err(|e| OutboundError::new(500, "save_failed", e.to_string()))
    }

    fn defaults_applied(&self) -> bool {
        self.core
            .store
            .read(|store| store.agent_led_defaults_applied == Some(true))
    }

    /// Marks the bootstrap done, so an explicit choice made through a setup
    /// route is never overridden by the defaults.
    fn complete_bootstrap(&self) -> Result<(), OutboundError> {
        if self.defaults_applied() {
            return Ok(());
        }
        self.core
            .store
            .update(|store| store.agent_led_defaults_applied = Some(true))
            .map_err(|e| OutboundError::new(500, "save_failed", e.to_string()))
    }

    fn set_direct(&self, enabled: bool) -> Result<(), OutboundError> {
        // An explicit setup choice, like one made in Settings: recorded once
        // Claude's settings change, so the on-by-default pass never reverses
        // it and a failed write is not kept.
        let _changing = self.core.integration_settings.lock().unwrap();
        self.core.with_integration_choice(
            crate::relay::claude_settings::SETTING,
            || self.set_direct_unrecorded(enabled),
            |e| OutboundError::new(500, "save_failed", e.to_string()),
        )
    }

    fn set_direct_unrecorded(&self, enabled: bool) -> Result<(), OutboundError> {
        if enabled
            && self
                .direct
                .managed_value()
                .is_some_and(|managed| managed != "accept")
        {
            return Err(managed_policy());
        }
        if enabled && self.direct.delivers_directly() {
            return Ok(());
        }
        self.direct
            .set_direct_delivery(enabled)
            .map_err(|message| OutboundError::new(500, "save_failed", message))
    }

    /// The direct-delivery default: on, unless the user's own settings
    /// already chose a value, which is kept.
    fn set_direct_default(&self) -> Result<(), OutboundError> {
        if self
            .direct
            .managed_value()
            .is_some_and(|managed| managed != "accept")
        {
            return Err(managed_policy());
        }
        if self.direct.user_choice().is_some() {
            return Ok(());
        }
        self.set_direct(true)
    }

    /// Whether a live session still waits to be put on the relay
    /// automatically.
    async fn activation_outstanding(&self) -> bool {
        if !self.core.store.read(|s| s.auto_activates()) || self.core.workspace().is_none() {
            return false;
        }
        let directory = self.core.plugins.sessions.clone();
        let found = tokio::task::spawn_blocking(move || directory.auto_activation_sessions())
            .await
            .unwrap_or_default();
        found.iter().any(|session| {
            session.live
                && self
                    .core
                    .store
                    .read(|store| store.registration_for(&session.target).is_none())
        })
    }

    /// Clears a reported activation failure once no live session waits to
    /// be activated, checked in the background unless a check is running.
    /// The check discovers every session on this computer, which can wait
    /// on the Codex app and the fleet's brokers for many seconds, so no
    /// route waits on it; status reports what the last check left.
    fn recheck_activation(self: &Arc<Self>) {
        if self.checking_activation.swap(true, Ordering::SeqCst) {
            return;
        }
        let setup = self.clone();
        tokio::spawn(async move {
            let _running = Running(&setup.checking_activation);
            let began = setup.errors_set.load(Ordering::SeqCst);
            if !setup.activation_outstanding().await {
                // An activation that failed while this check ran reported
                // a newer error this check knows nothing about.
                let mut error = setup.defaults_error.lock().unwrap();
                if setup.errors_set.load(Ordering::SeqCst) == began
                    && error
                        .as_ref()
                        .is_some_and(|e| e.code == "activation_failed")
                {
                    *error = None;
                }
            }
        });
    }

    /// Activates every live session that is not on the relay yet; the
    /// failures, joined, as an error.
    async fn activate(&self) -> Option<OutboundError> {
        if !self.core.store.read(|s| s.auto_activates()) || self.core.workspace().is_none() {
            return None;
        }
        let failures = self.core.activate_new_sessions().await;
        (!failures.is_empty())
            .then(|| OutboundError::new(502, "activation_failed", failures.join("; ")))
    }

    /// Applies the agent-led defaults; failures are reported by
    /// `/setup/status`. Direct delivery and automatic activation are set
    /// before this returns. The uploader's sharing mode waits on the
    /// uploader, so it is set in the background. Activation waits on
    /// Relaycast, so only `POST /setup/auto-activate` asks for it, and it
    /// reports the result itself.
    pub async fn apply_defaults(self: &Arc<Self>) {
        let Some(local) = self.apply_local_defaults() else {
            if self
                .direct
                .managed_value()
                .is_some_and(|managed| managed != "accept")
            {
                self.set_error(Some((&managed_policy()).into()));
                return;
            }
            self.clear_error_if("managed_policy");
            self.recheck_activation();
            return;
        };
        let account = self.account().await;
        if !self.signed_in(&account) {
            self.set_error(local.as_ref().map(Into::into));
            return;
        }
        // Each default is applied even when another cannot be: an
        // organization's Claude policy does not stop uploads. The first
        // failure is the one reported.
        match &local {
            Some(failure) => self.set_error(Some(failure.into())),
            None => {
                self.clear_error_if("managed_policy");
                self.clear_error_if("save_failed");
            }
        }
        self.start_bootstrap(local.is_none());
    }

    /// Sets direct delivery and automatic activation unless the bootstrap
    /// is closed (`None`); `Some` carries the first failure.
    fn apply_local_defaults(&self) -> Option<Option<OutboundError>> {
        let _changing = self.defaults.lock().unwrap();
        if self.defaults_applied() {
            return None;
        }
        let mut failure = self.set_direct_default().err();
        if !self.core.store.read(|s| s.auto_activates()) {
            if let Err(error) = self.set_auto_activate(true) {
                failure = failure.or(Some(error));
            }
        }
        Some(failure)
    }

    /// Starts the bootstrap's uploader step unless it is running.
    fn start_bootstrap(self: &Arc<Self>, local_applied: bool) {
        if self.bootstrapping.swap(true, Ordering::SeqCst) {
            return;
        }
        let setup = self.clone();
        tokio::spawn(async move {
            let _running = Running(&setup.bootstrapping);
            setup.finish_bootstrap(local_applied).await;
        });
    }

    /// Waits for the uploader to answer and, when the local defaults also
    /// hold, closes the bootstrap. It never changes the sharing mode: a
    /// sign-in through setup or an app installs the uploader sharing only
    /// chosen sessions (`selected`), and an install's own mode, `new` or
    /// `all` included when its owner chose one, is kept, so the bootstrap
    /// never widens what is shared. An uploader that does not answer is
    /// asked again by the next setup request.
    async fn finish_bootstrap(&self, local_applied: bool) {
        let _sharing = self.sharing.lock().await;
        if self.defaults_applied() {
            return;
        }
        let mut failure = None;
        let read = self.method("uploader.status", json!({})).await;
        *self.uploader.lock().unwrap() = Some(read.as_ref().ok().cloned());
        // An explicit choice may have closed the bootstrap while the
        // uploader answered.
        if self.defaults_applied() {
            return;
        }
        // An install answers with its own mode, which is kept. One that does
        // not answer is asked again by the next setup request. A core built
        // without session history has no uploader to wait for.
        if let Err(error) = read {
            if error.data.kind != crate::relay::protocol::ErrorKind::HistoryUnavailable {
                failure = Some(OutboundError::from_rpc(&error, "sharing_failed"));
            }
        }
        if !local_applied {
            // The local failure is already the one reported.
            return;
        }
        if failure.is_none() {
            let _changing = self.defaults.lock().unwrap();
            failure = self.complete_bootstrap().err();
        }
        // Only this step's own error is cleared: a route may have recorded
        // another (an activation failure) while the uploader answered.
        match failure {
            Some(failure) => self.set_error(Some((&failure).into())),
            None => self.clear_error_if("sharing_failed"),
        }
    }

    /// Answers one setup route for `session`.
    pub async fn handle(
        self: &Arc<Self>,
        session: &DiscoveredSession,
        route: &str,
        request: Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        // A key may have appeared since the last rediscovery. Relaycast is
        // asked about it in the background; status reports its answer.
        if self.core.workspace().is_none() && self.core.rediscover_workspace() {
            let core = self.core.clone();
            tokio::spawn(async move {
                let _ = core.verify_workspace().await;
            });
        }
        if route.contains("/setup/") {
            self.apply_defaults().await;
        }
        let registration = self
            .core
            .store
            .read(|store| store.registration_for(&session.target).cloned());
        let exactly = |key: &str| request.len() == 1 && request.contains_key(key);
        let enabled = || {
            request
                .get("enabled")
                .and_then(Value::as_bool)
                .filter(|_| exactly("enabled"))
                .ok_or_else(|| {
                    OutboundError::new(400, "invalid_enabled", "enabled must be true or false.")
                })
        };
        let require_registration = |what: &str| {
            registration.clone().ok_or_else(|| {
                OutboundError::new(
                    403,
                    "not_a_relay_session",
                    format!("Register this session before {what}."),
                )
            })
        };
        match route {
            "GET /setup/status" => Ok(self.status(session).await),
            "POST /setup/sign-in" => self.sign_in(&request).await,
            "POST /setup/sharing" => {
                let mode = request
                    .get("mode")
                    .and_then(Value::as_str)
                    .filter(|m| exactly("mode") && ["new", "all", "selected"].contains(m))
                    .ok_or_else(|| {
                        OutboundError::new(
                            400,
                            "invalid_mode",
                            "mode must be new, all, or selected.",
                        )
                    })?;
                let _sharing = self.sharing.lock().await;
                self.set_sharing(mode)
                    .await
                    .map_err(|error| OutboundError::from_rpc(&error, "sharing_failed"))?;
                let _changing = self.defaults.lock().unwrap();
                self.complete_bootstrap()?;
                Ok(json!({ "sharing_mode": mode }))
            }
            "POST /setup/auto-activate" => {
                let enabled = enabled()?;
                {
                    let _changing = self.defaults.lock().unwrap();
                    self.set_auto_activate(enabled)?;
                    self.complete_bootstrap()?;
                }
                if enabled {
                    if let Some(failure) = self.activate().await {
                        self.set_error(Some((&failure).into()));
                        return Err(failure);
                    }
                    self.clear_error_if("activation_failed");
                } else {
                    self.clear_error_if("activation_failed");
                }
                Ok(json!({ "auto_activate": enabled }))
            }
            "POST /setup/direct-delivery" if exactly("default") => {
                // The first-run default, as the apps apply it: on unless the
                // user's own settings already chose a value, which is kept.
                // Not an explicit choice, so the bootstrap stays as it is.
                if request.get("default") != Some(&Value::Bool(true)) {
                    return Err(OutboundError::new(
                        400,
                        "invalid_default",
                        "default must be true.",
                    ));
                }
                {
                    let _changing = self.defaults.lock().unwrap();
                    self.set_direct_default()?;
                }
                self.clear_error_if("managed_policy");
                Ok(json!({
                    "direct_delivery": self.direct.delivers_directly(),
                    "user_choice": self.direct.user_choice(),
                }))
            }
            "POST /setup/direct-delivery" => {
                let enabled = enabled()?;
                {
                    let _changing = self.defaults.lock().unwrap();
                    self.set_direct(enabled)?;
                    self.complete_bootstrap()?;
                }
                self.clear_error_if("managed_policy");
                Ok(json!({ "direct_delivery": self.direct.delivers_directly() }))
            }
            "POST /webhooks" => {
                if !request.is_empty() {
                    return Err(OutboundError::new(
                        400,
                        "invalid_request",
                        "POST /webhooks has no request fields.",
                    ));
                }
                let registration = require_registration("creating a webhook")?;
                let hook = self
                    .core
                    .create_webhook(&registration.name)
                    .await
                    .map_err(|error| OutboundError::from_rpc(&error, "webhook_failed"))?;
                Ok(json!({
                    "created": hook.created,
                    "webhook_id": hook.id,
                    "url": hook.url,
                    "secret": hook.secret.as_ref().map(|s| s.expose()),
                }))
            }
            "DELETE /webhooks" => {
                if !request.is_empty() {
                    return Err(OutboundError::new(
                        400,
                        "invalid_request",
                        "DELETE /webhooks has no request fields.",
                    ));
                }
                let registration = require_registration("changing its webhook")?;
                let already_deleted = self
                    .core
                    .revoke_webhook(&registration.name)
                    .await
                    .map_err(|error| OutboundError::from_rpc(&error, "webhook_failed"))?;
                Ok(json!({"created": false, "already_deleted": already_deleted}))
            }
            "POST /integrations/subscribe" | "DELETE /integrations/subscribe" => {
                let provider = request.get("provider").and_then(Value::as_str);
                let resource = request.get("resource").and_then(Value::as_str);
                let (Some(provider), Some(resource)) = (provider, resource) else {
                    return Err(invalid_integration());
                };
                let resource = resource.trim();
                if request.len() != 2
                    || resource.is_empty()
                    || !["github", "linear", "slack", "jira"].contains(&provider)
                {
                    return Err(invalid_integration());
                }
                let registration = require_registration("subscribing it")?;
                let subscribing = route.starts_with("POST");
                if subscribing {
                    if let Some(glob) = held_subscription(&registration, provider, resource) {
                        return Ok(json!({
                            "subscribed": true,
                            "provider": provider,
                            "resource": resource,
                            "path_glob": glob,
                            "already_subscribed": true,
                        }));
                    }
                }
                let result = if subscribing {
                    self.core
                        .subscribe_integration(&registration.name, provider, resource)
                        .await
                } else {
                    self.core
                        .unsubscribe_integration(&registration.name, provider, resource)
                        .await
                };
                result
                    .map(|change| serde_json::to_value(change).unwrap_or_default())
                    .map_err(|error| OutboundError::from_rpc(&error, "integration_failed"))
            }
            _ => Err(OutboundError::new(
                404,
                "not_found",
                "Use a documented Agent Relay setup route.",
            )),
        }
    }

    /// `GET /setup/status`, from the last known state: it waits on no
    /// network call, uploader command or setup change in progress.
    pub async fn status(self: &Arc<Self>, session: &DiscoveredSession) -> Value {
        let account = self.account().await;
        let signed_in = self.signed_in(&account);
        let state = match signed_in {
            true => "signed_in",
            false => account["state"].as_str().unwrap_or("signed_out"),
        }
        .to_string();
        self.refresh_uploader();
        let read = self.uploader.lock().unwrap().clone();
        let uploader = read.clone().flatten();
        let uploader_summary = match &read {
            None => json!({"running": false, "healthy": false, "pending": true}),
            Some(Some(raw)) => {
                let delivery = &raw["delivery"];
                // The stage carries every degradation: a delivery failure, a
                // failed cycle (`offline`) and records waiting too long with
                // no acknowledgement (`stalled`).
                let degraded = ["needs_attention", "conflict", "offline", "not_running"]
                    .contains(&raw["stage"].as_str().unwrap_or("offline"));
                json!({
                    "running": raw["running"] == true,
                    "paused": raw["paused"] == true,
                    "healthy": raw["running"] == true && delivery["failure"].is_null() && !degraded,
                    "stage": raw["stage"],
                    "stalled": raw["stalled"] == true,
                    "failure_code": delivery["failure_code"],
                    "renewal_failure": delivery["renewal_failure"],
                    "pending_records": delivery["pending_records"].as_i64().unwrap_or(0),
                    "last_acknowledged_ms": delivery["last_acknowledged_ms"],
                })
            }
            Some(None) => json!({"running": false, "healthy": false}),
        };
        let registration = self
            .core
            .store
            .read(|store| store.registration_for(&session.target).cloned());
        let directory = self.core.plugins.sessions.clone();
        let unreadable_session_files =
            tokio::task::spawn_blocking(move || directory.unreadable_session_files())
                .await
                .unwrap_or_default();
        let workspace = account["workspace_id"]
            .as_str()
            .map(|id| json!({"id": id, "name": account["workspace_name"]}));
        // The signed-in person, as `account.status` names them.
        let person = &account["person"];
        let named = !person["name"].is_null() || !person["email"].is_null();
        let person = named.then(|| json!({"name": person["name"], "email": person["email"]}));
        let mut result = json!({
            "version": self.core.config().version,
            "sign_in": state,
            "signed_in": signed_in,
            "account": person,
            "workspace": workspace,
            "cloud_identity_sync": crate::relay::account::cloud_identity_sync(&self.core),
            "relaycast": self
                .core
                .workspace()
                .map(|_| self.core.status().workspace.verification),
            "defaults": if self.defaults_applied() { "applied" } else { "pending" },
            "sharing_mode": uploader
                .as_ref()
                .and_then(|u| u["sharing_mode"].as_str())
                .unwrap_or("selected"),
            "auto_activate": self.core.store.read(|s| s.auto_activates()),
            "allow_self_registration": self.core.store.read(|s| s.allows_self_registration()),
            "direct_delivery": self.direct.delivers_directly(),
            "direct_delivery_user_choice": self.direct.user_choice(),
            "uploader": uploader_summary,
            "session": {
                "id": session.target.id,
                "kind": session.target.kind,
                "registered": registration.is_some(),
                "name": registration.as_ref().map(|r| r.name.clone()),
                "address": registration.as_ref().map(|r| r.direct_address(&self.core.machine_prefix)),
                "direct_delivery": self.session_delivers_directly(session.target.kind),
                "mcp": self.core.relay_mcp_access(&session.target),
            },
            "webhook": {"created": registration.as_ref().is_some_and(|r| r.webhook.is_some())},
            "integrations": registration
                .iter()
                .flat_map(|r| r.integrations.iter().flatten())
                .map(|i| json!({"provider": i.provider, "resource": i.resource, "ready": i.ready == Some(true)}))
                .collect::<Vec<_>>(),
            "unreadable_session_files": unreadable_session_files,
        });
        if ["expired", "denied", "error"].contains(&state.as_str()) {
            if let Some(message) = account["error"].as_str() {
                result["sign_in_message"] = json!(message);
            }
        } else if state == "pending_approval" {
            copy_sign_in_link(&account, &mut result);
            result["sign_in_phase"] = account["phase"].clone();
        } else if state == "preparing" {
            let preparing = preparing(&account);
            result["sign_in_phase"] = preparing["phase"].clone();
            result["sign_in_message"] = preparing["message"].clone();
            result["poll_after_seconds"] = preparing["poll_after_seconds"].clone();
            if !preparing["progress"].is_null() {
                result["sign_in_progress"] = preparing["progress"].clone();
            }
        }
        if let Some(reused) = account["reused_login"].as_bool() {
            result["reused_login"] = json!(reused);
        }
        if let Some(error) = self.defaults_error.lock().unwrap().clone() {
            result["defaults_error"] = json!({"code": error.code, "message": error.message});
        }
        result
    }

    /// Existing setup clients keep device approval, including remote callers.
    /// `flow: browser` opts into the desktop's session-aware PKCE handoff.
    async fn sign_in(&self, request: &Map<String, Value>) -> Result<Value, OutboundError> {
        let invalid = || {
            OutboundError::new(
                400,
                "invalid_request",
                "POST /setup/sign-in accepts an optional workspace id, flow (browser or device), and schedule acknowledgement.",
            )
        };
        if request
            .keys()
            .any(|k| k != "workspace" && k != "flow" && k != "acknowledge_uninspected_schedules")
        {
            return Err(invalid());
        }
        let flow = match request.get("flow") {
            None => None,
            Some(Value::String(flow)) if flow == "browser" || flow == "device" => Some(flow),
            Some(_) => return Err(invalid()),
        };
        let acknowledge = match request.get("acknowledge_uninspected_schedules") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err(invalid()),
        };
        let workspace = match request.get("workspace") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) if is_uuid(&id.to_lowercase()) => Some(id.to_lowercase()),
            Some(_) => {
                return Err(OutboundError::new(
                    400,
                    "invalid_workspace",
                    "workspace must be an Agent Relay workspace UUID.",
                ))
            }
        };
        let account = self.account().await;
        if self.signed_in(&account) {
            let current = account["workspace_id"].as_str().map(str::to_lowercase);
            if workspace.is_some() && current.is_some() && workspace != current {
                return Err(OutboundError::new(
                    409,
                    "workspace_mismatch",
                    "This computer is signed in to another workspace. Disconnect it before switching workspaces.",
                ));
            }
            return Ok(signed_in_response(&account));
        }
        let mut params = json!({
            "sharing": "selected",
            "acknowledge_uninspected_schedules": acknowledge,
        });
        // Published setup guides open the URL only when user_code is present.
        // Keep their default until they opt into a browser-capable contract.
        if flow.map(String::as_str) != Some("browser") {
            params["flow"] = json!("device");
        }
        if let Some(workspace) = &workspace {
            params["workspace"] = json!(workspace);
        }
        let started = self
            .method("account.sign_in", params)
            .await
            .map_err(|error| match error.data.kind {
                ErrorKind::Conflict | ErrorKind::Busy => {
                    OutboundError::new(409, "sign_in_in_progress", error.message.clone())
                }
                _ => OutboundError::from_rpc(&error, "sign_in_failed"),
            })?;
        match started["state"].as_str() {
            Some("pending_approval") => {
                let mut result = json!({"status": "pending_approval"});
                copy_sign_in_link(&started, &mut result);
                Ok(result)
            }
            Some("signed_in") => Ok(signed_in_response(&self.account().await)),
            Some("preparing") => {
                let mut current = self.account().await;
                if current["state"] != "preparing" {
                    current = started;
                }
                Ok(preparing(&current))
            }
            _ => Err(OutboundError::new(
                502,
                "sign_in_failed",
                started["error"]
                    .as_str()
                    .unwrap_or("Sign-in could not start."),
            )),
        }
    }
}

fn copy_sign_in_link(account: &Value, result: &mut Value) {
    for key in [
        "verification_url",
        "verification_url_complete",
        "user_code",
        "expires_at",
        "interval",
    ] {
        result[key] = account[key].clone();
    }
}

fn invalid_integration() -> OutboundError {
    OutboundError::new(
        400,
        "invalid_integration",
        "provider and a non-empty resource are required.",
    )
}

fn signed_in_response(account: &Value) -> Value {
    let mut result = json!({
        "status": "signed_in",
        "workspace": {"id": account["workspace_id"], "name": account["workspace_name"]},
    });
    result["reused_login"] = json!(account["reused_login"].as_bool().unwrap_or(true));
    result
}

/// The `preparing` answer: its phase in words and when to look again.
fn preparing(account: &Value) -> Value {
    let phase = account["phase"]
        .as_str()
        .filter(|p| !p.is_empty())
        .unwrap_or("preparing_local_sessions");
    let reused = account["reused_login"].as_bool();
    let message = match phase {
        "checking_existing_login" => "Looking for an existing Agent Relay login.".to_string(),
        "reusing_existing_login" => "Reusing an existing Agent Relay login.".to_string(),
        "starting_device_login" => "Requesting a device login.".to_string(),
        "device_login_approved" => "Device login approved; connecting the workspace.".to_string(),
        _ => format!(
            "{}preparing the local session catalog for automatic uploads.",
            if reused == Some(true) {
                "Reused an existing Agent Relay login; "
            } else {
                ""
            }
        ),
    };
    let mut result = json!({
        "status": "preparing",
        "phase": phase,
        "message": message,
        "poll_after_seconds": 3,
    });
    if let Some(reused) = reused {
        result["reused_login"] = json!(reused);
    }
    if account["progress"].is_object() {
        result["progress"] = account["progress"].clone();
    }
    result
}

/// The path glob of a finished subscription `registration` already holds for
/// this resource, however the resource is spelled. Asking for it again
/// succeeds: an agent subscribes after every pull request it opens, and a
/// retried command must not read as a failure. A subscription still being
/// made or ended is not held; the core decides that request.
fn held_subscription(
    registration: &Registration,
    provider: &str,
    resource: &str,
) -> Option<String> {
    let glob = relayfile_glob(provider, resource)?;
    registration
        .integrations
        .iter()
        .flatten()
        .any(|held| {
            held.provider == provider
                && held.path_glob.as_deref() == Some(glob.as_str())
                && held.ready == Some(true)
                && held.terminal != Some(true)
        })
        .then_some(glob)
}

#[cfg(test)]
mod tests {
    use super::*;

    // test_setup_routes_bootstrap_before_registration_and_cover_the_contract
    // (the preparing wording) and AppModel's agentSetupPreparation.
    #[test]
    fn preparing_names_its_phase_and_when_to_poll() {
        let account =
            json!({"state": "preparing", "phase": "reusing_existing_login", "reused_login": true});
        let answer = preparing(&account);
        assert_eq!(answer["phase"], "reusing_existing_login");
        assert_eq!(answer["message"], "Reusing an existing Agent Relay login.");
        assert_eq!(answer["poll_after_seconds"], 3);
        assert_eq!(answer["reused_login"], true);
        let scanning = preparing(&json!({
            "state": "preparing",
            "reused_login": true,
            "progress": {"phase": "scan", "source": "codex", "processed_files": 3, "total_files": 9, "sessions_captured": 1},
        }));
        assert_eq!(scanning["phase"], "preparing_local_sessions");
        assert_eq!(
            scanning["message"],
            "Reused an existing Agent Relay login; preparing the local session catalog for automatic uploads."
        );
        assert_eq!(scanning["progress"]["total_files"], 9);
    }

    #[test]
    fn a_signed_in_answer_carries_the_workspace_and_no_credential() {
        let answer = signed_in_response(&json!({
            "state": "signed_in", "workspace_id": "5058", "workspace_name": "Acme", "reused_login": false,
        }));
        assert_eq!(
            answer,
            json!({"status": "signed_in", "workspace": {"id": "5058", "name": "Acme"}, "reused_login": false})
        );
    }
    #[test]
    fn only_a_finished_subscription_of_this_session_is_already_held() {
        use crate::relay::store::Integration;
        let glob = "/github/repos/acme/api/pulls/42/**";
        let holding = |ready: Option<bool>, terminal: Option<bool>| {
            let mut registration: Registration = serde_json::from_value(json!({
                "name": "reviewer",
                "agentID": "agent_1",
                "target": {"kind": "codex", "id": "s1"},
                "title": "reviewer",
                "baseURL": "https://relay.example",
                "registeredAt": "2026-10-01T00:00:00Z",
            }))
            .unwrap();
            let mut entry = Integration::new("github", "acme/api#42", "rw_1");
            entry.path_glob = Some(glob.into());
            entry.ready = ready;
            entry.terminal = terminal;
            registration.integrations = Some(vec![entry]);
            registration
        };
        let held = holding(Some(true), None);
        // Every spelling of the pull request names the one subscription.
        for resource in [
            "acme/api#42",
            "https://github.com/acme/api/pull/42",
            "https://github.com/acme/api/pull/42/files#diff-1",
            glob,
        ] {
            assert_eq!(
                held_subscription(&held, "github", resource).as_deref(),
                Some(glob),
                "{resource}"
            );
        }
        // Another pull request, the whole repository, another provider and an
        // unreadable resource are not held.
        for (provider, resource) in [
            ("github", "acme/api#43"),
            ("github", "acme/api"),
            ("github", "other/api#42"),
            ("linear", glob),
            ("github", "https://example.com/acme/api/pull/42"),
        ] {
            assert_eq!(
                held_subscription(&held, provider, resource),
                None,
                "{resource}"
            );
        }
        // One still being made, or ended by its pull request closing, goes to
        // the core rather than being reported as held.
        for unfinished in [
            holding(None, None),
            holding(Some(false), None),
            holding(Some(true), Some(true)),
        ] {
            assert_eq!(
                held_subscription(&unfinished, "github", "acme/api#42"),
                None
            );
        }
        let mut none = holding(Some(true), None);
        none.integrations = None;
        assert_eq!(held_subscription(&none, "github", "acme/api#42"), None);
    }
}
