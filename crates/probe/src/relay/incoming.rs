//! Incoming messages: what people send from Agent Relay's web app to a
//! Codex thread the person shared from this computer.
//!
//! `Incoming` binds the account's mailbox (`relay::mailbox`) to the durable
//! layer (`relay::outbox`): one Codex outbox, sharing policy, inbox and
//! delivery worker per mailbox scope, under `<app data>/incoming/<scope>/`.
//! The sign-in activates the mailbox, and supervision activates it whenever
//! the app keeps the connected person's session and nothing else can
//! connect it; every supervision tick connects it (restoring the binding a
//! relaunch left); sign-out stops it, ends the device session at Cloud and
//! forgets the credential and binding.
//!
//! A sign-out or account switch is cancellation, not the person's pause:
//! the accept boundary is serialized with invalidation, so a frame that
//! arrives while the receiver stops is neither stored nor refused for good.

use crate::relay::contract::incoming::{HeldMessage, IncomingStatus, IncomingThread};
use crate::relay::mailbox::{
    self, CredentialStore, MailboxConfig, MailboxError, MailboxInbox, MailboxNetwork, MailboxStore,
    Receiver, ReceiverParts, ReceiverState, ThreadReport,
};
use crate::relay::outbox::{
    CodexDelivery, CodexDeliveryEffects, CodexInboundMessage, CodexInbox, CodexOutboxMessage,
    CodexSharingPolicy, Mode, OutboxError,
};
use crate::relay::uploader::Target;
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

/// A thread on this computer, for the catalog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalThread {
    pub id: String,
    pub project: String,
    pub title: String,
    pub open: bool,
}

/// The Codex threads on this computer, newest first. May block.
pub type Threads = Arc<dyn Fn() -> Vec<LocalThread> + Send + Sync>;

/// What `Incoming` is built with.
pub struct IncomingParts {
    pub app_data_dir: PathBuf,
    pub network: Arc<dyn MailboxNetwork>,
    pub credentials: Arc<dyn CredentialStore>,
    pub effects: Arc<dyn CodexDeliveryEffects>,
    pub threads: Threads,
}

/// The accept boundary: open until the receiver it guards is invalidated.
/// Accepting and invalidating are serialized, so a frame is either stored
/// before a stop or not at all; the inbox's own authorization gate reads
/// the flag without that lock, from inside an accept.
#[derive(Default)]
struct Lifecycle {
    serial: Mutex<()>,
    closed: AtomicBool,
}

impl Lifecycle {
    fn invalidate(&self) {
        let _serial = self.serial.lock().unwrap();
        self.closed.store(true, Ordering::SeqCst);
    }

    fn is_active(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }

    fn with_active<T>(
        &self,
        body: impl FnOnce() -> Result<T, MailboxError>,
    ) -> Result<T, MailboxError> {
        let _serial = self.serial.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return Err(MailboxError::Cancelled);
        }
        body()
    }
}

/// The outbox as the receiver's store.
struct OutboxStore(Arc<CodexDelivery>);

fn outbox(error: OutboxError) -> String {
    error.to_string()
}

impl MailboxStore for OutboxStore {
    fn cursor(&self) -> Result<Option<String>, String> {
        self.0.store().and_then(|s| s.cursor()).map_err(outbox)
    }
    fn reset_cursor_if_matching(&self, since: &str) -> Result<(), String> {
        self.0
            .store()
            .and_then(|s| s.reset_cursor_if_matching(since))
            .map_err(outbox)
    }
    fn checkpoint(&self, id: &str) -> Result<(), String> {
        self.0
            .store()
            .and_then(|s| s.checkpoint(id))
            .map_err(outbox)
    }
    fn pending_acks(&self) -> Result<Vec<(i64, Value)>, String> {
        self.0
            .store()
            .and_then(|s| s.pending_acks())
            .map_err(outbox)
    }
    fn acknowledge_through(&self, sequence: i64) -> Result<(), String> {
        self.0
            .store()
            .and_then(|s| s.acknowledge_through(sequence))
            .map_err(outbox)
    }
}

/// The inbox as the receiver's sink, behind the accept boundary.
struct Accept {
    inbox: Arc<CodexInbox>,
    lifecycle: Arc<Lifecycle>,
}

impl MailboxInbox for Accept {
    fn receive_durably(&self, message: &Value) -> Result<(), MailboxError> {
        let message: CodexInboundMessage =
            serde_json::from_value(message.clone()).map_err(|_| MailboxError::InvalidResponse)?;
        self.lifecycle.with_active(|| {
            self.inbox
                .receive_durably(message)
                .map_err(|error| match error {
                    OutboxError::AuthenticationRequired => MailboxError::AuthenticationRequired,
                    other => MailboxError::Storage(other.to_string()),
                })
        })
    }
}

/// One connected mailbox.
struct Active {
    config: MailboxConfig,
    receiver: Arc<Receiver>,
    task: tokio::task::JoinHandle<()>,
    delivery: Arc<CodexDelivery>,
    inbox: Arc<CodexInbox>,
    policy: Arc<CodexSharingPolicy>,
    lifecycle: Arc<Lifecycle>,
}

#[derive(Default)]
struct State {
    active: Option<Active>,
    /// The mailbox bound to the connected account, kept for sign-out even
    /// when no receiver could start.
    binding: Option<(MailboxConfig, PathBuf)>,
    /// Why sharing cannot be trusted right now (a recovered or failed
    /// change); incoming stays paused until a sharing change is saved.
    policy_error: Option<String>,
    /// Bumped by every stop: an activation or connection begun before one
    /// keeps nothing.
    transition: u64,
    /// The activation in flight, if any.
    activating: Option<u64>,
    attempts: u64,
}

/// Where incoming stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "stopped"))]
pub enum IncomingState {
    /// Not connected: signed out, or the mailbox is not available.
    Stopped,
    /// The mailbox needs activating, which a sign-in does.
    Unavailable,
    Paused,
    Connecting,
    Connected,
    Polling,
    NeedsSignIn,
}

/// How an `Incoming::activate` ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    /// The credential and its binding are saved.
    Activated,
    /// Cloud refused, a save failed, or a stop discarded it.
    Failed,
    /// Nothing to do: the mailbox is connected, another activation is in
    /// flight, or a usable binding can restore it.
    Unneeded,
}

pub struct Incoming {
    parts: IncomingParts,
    state: tokio::sync::Mutex<State>,
    /// The person's pause, shared with the uploader's.
    paused: Arc<AtomicBool>,
    /// A sharing change could not be saved or was recovered.
    policy_failure: Arc<AtomicBool>,
    /// Cloud refused (or there is no) credential.
    auth_lost: Arc<AtomicBool>,
}

fn ms(time: std::time::SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn held(message: &CodexOutboxMessage) -> HeldMessage {
    HeldMessage {
        id: message.id.clone(),
        thread_id: message.thread_id.clone(),
        text: message.text.clone(),
        sender_name: message.sender_name.clone(),
        enqueued_at_ms: ms(message.enqueued_at),
        expires_at_ms: ms(message.expires_at),
    }
}

const RECOVERED: &str = "An incomplete sharing change was recovered. All incoming shares were reset; choose which threads to share again.";
const SAVE_FAILED: &str =
    "Could not save sharing. Incoming messages stay paused until a sharing change is saved.";

impl Incoming {
    pub fn new(parts: IncomingParts) -> Arc<Incoming> {
        Arc::new(Incoming {
            parts,
            state: tokio::sync::Mutex::default(),
            paused: Arc::new(AtomicBool::new(true)),
            policy_failure: Arc::new(AtomicBool::new(true)),
            auth_lost: Arc::new(AtomicBool::new(false)),
        })
    }

    fn root(&self) -> PathBuf {
        self.parts.app_data_dir.join("incoming")
    }

    /// The account's own mailbox identity before activation names one.
    fn source(target: &Target) -> Result<MailboxConfig, MailboxError> {
        MailboxConfig::new(
            &target.site_url,
            target.account_id.as_deref().unwrap_or_default(),
            target.workspace_id.as_deref().unwrap_or_default(),
        )
    }

    fn connection_path(&self, source: &MailboxConfig) -> PathBuf {
        self.root().join(source.scope()).join("connection.json")
    }

    /// This computer's id for the room, made once.
    pub fn device_id(&self) -> String {
        let path = self.parts.app_data_dir.join("desktop-cloud-device-id");
        if let Ok(text) = std::fs::read_to_string(&path) {
            let id = text.trim();
            if !id.is_empty() {
                return id.to_string();
            }
        }
        let id = crate::relay::store::random_uuid().to_ascii_uppercase();
        let _ = mailbox::write_private(&path, id.as_bytes());
        id
    }

    /// Activates the mailbox with this app's own Cloud session: the one a
    /// sign-in got or kept, never the official CLI's or a probe's. Only
    /// when it `needs_activation`, checked and claimed in one step: of two
    /// callers (a sign-in's and supervision's), one mints the room session
    /// and the other stands down with `Unneeded`.
    ///
    /// Runs in its own task: a cancel that aborts the sign-in after the
    /// uploader attached leaves it signed in, so the activation completes
    /// and clears `activating` rather than stopping halfway with it set.
    /// A sign-out still discards it (`transition`).
    pub async fn activate(self: &Arc<Self>, target: &Target, access_token: &Secret) -> Activation {
        let (incoming, target, access_token) = (self.clone(), target.clone(), access_token.clone());
        tokio::spawn(async move { incoming.activate_now(&target, &access_token).await })
            .await
            .unwrap_or(Activation::Failed)
    }

    /// Whether `target`'s mailbox has no receiver, no activation in flight,
    /// and no binding with a usable credential to restore: only an
    /// activation can connect it.
    pub async fn needs_activation(&self, target: &Target) -> bool {
        let state = self.state.lock().await;
        self.needs_activation_locked(&state, target)
    }

    fn needs_activation_locked(&self, state: &State, target: &Target) -> bool {
        if state.active.is_some() || state.activating.is_some() {
            return false;
        }
        let Ok(source) = Incoming::source(target) else {
            return false;
        };
        let config = match std::fs::read(self.connection_path(&source)) {
            Err(_) => source,
            Ok(bytes) => match serde_json::from_slice::<MailboxConfig>(&bytes)
                .ok()
                .and_then(|saved| saved.validated().ok())
            {
                Some(saved) => saved,
                None => return true,
            },
        };
        self.parts
            .credentials
            .load(&config.scope())
            .is_none_or(|c| config.bearer(&c, crate::relay::state::now_ms()).is_err())
    }

    async fn activate_now(&self, target: &Target, access_token: &Secret) -> Activation {
        let (transition, attempt) = {
            let mut state = self.state.lock().await;
            if !self.needs_activation_locked(&state, target) {
                return Activation::Unneeded;
            }
            state.attempts += 1;
            let attempt = state.attempts;
            state.activating = Some(attempt);
            (state.transition, attempt)
        };
        let device = self.device_id();
        let result = async {
            let source = Incoming::source(target)?;
            let activated = mailbox::activate(
                self.parts.network.as_ref(),
                &source.site,
                &source.workspace_id,
                access_token,
                &device,
                crate::relay::state::now_ms(),
            )
            .await?;
            Ok::<_, MailboxError>((source, activated))
        }
        .await;
        let mut state = self.state.lock().await;
        if state.transition != transition || state.activating != Some(attempt) {
            return Activation::Failed;
        }
        state.activating = None;
        match result {
            Ok((source, activated)) => {
                let path = self.connection_path(&source);
                let scope = activated.config.scope();
                let saved = self
                    .parts
                    .credentials
                    .save(&activated.credential)
                    .and_then(|_| {
                        mailbox::write_private(
                            &path,
                            &serde_json::to_vec(&activated.config).unwrap_or_default(),
                        )
                    });
                if saved.is_ok() {
                    state.binding = Some((activated.config, path));
                    Activation::Activated
                } else {
                    // Nothing could find a credential without its binding
                    // again: end the session and forget it now.
                    self.paused.store(true, Ordering::SeqCst);
                    let (network, config, credential) = (
                        self.parts.network.clone(),
                        activated.config,
                        activated.credential,
                    );
                    self.parts.credentials.remove(&scope);
                    tokio::spawn(async move {
                        Receiver::deactivate(network.as_ref(), &config, &credential).await;
                    });
                    Activation::Failed
                }
            }
            Err(_) => {
                self.paused.store(true, Ordering::SeqCst);
                Activation::Failed
            }
        }
    }

    /// Connects the attached account's mailbox (restoring a relaunch's
    /// binding), or only updates the pause when it is already connected.
    pub async fn connect(self: &Arc<Self>, target: &Target, paused: bool) {
        let mut state = self.state.lock().await;
        if state.activating.is_some() {
            self.set_paused(paused);
            return;
        }
        let Ok(source) = Incoming::source(target) else {
            self.set_paused(true);
            return;
        };
        let path = self.connection_path(&source);
        let config = match std::fs::read(&path) {
            Err(_) => source,
            Ok(bytes) => match serde_json::from_slice::<MailboxConfig>(&bytes)
                .ok()
                .and_then(|saved| saved.validated().ok())
            {
                Some(saved) => saved,
                None => {
                    // A binding that cannot be read names no mailbox to
                    // restore or clean up; the next sign-in activates anew.
                    let _ = std::fs::remove_file(&path);
                    self.set_paused(true);
                    return;
                }
            },
        };
        if state.active.as_ref().is_some_and(|a| a.config == config) {
            self.set_paused(paused);
            return;
        }
        Self::stop_locked(&mut state, false, &self.parts).await;
        // Kept for sign-out even when no receiver can start now.
        state.binding = Some((config.clone(), path));
        let scope = config.scope();
        let credential = self.parts.credentials.load(&scope);
        let usable = credential
            .as_ref()
            .is_some_and(|c| config.bearer(c, crate::relay::state::now_ms()).is_ok());
        if !usable {
            self.set_paused(true);
            return;
        }
        let root = self.root().join(&scope);
        let policy = match CodexSharingPolicy::open(root.join("shares.json")) {
            Ok(policy) => Arc::new(policy),
            Err(_) => {
                self.set_paused(true);
                return;
            }
        };
        let delivery = CodexDelivery::new(
            root.join("codex-outbox.sqlite"),
            self.parts.effects.clone(),
            crate::relay::outbox::system_clock(),
        );
        let inbox = CodexInbox::new(delivery.clone(), policy.clone());
        let lifecycle = Arc::new(Lifecycle::default());
        let recovered = policy.recovered_interrupted_change();
        self.policy_failure.store(recovered, Ordering::SeqCst);
        state.policy_error = recovered.then(|| RECOVERED.to_string());
        self.auth_lost.store(false, Ordering::SeqCst);
        {
            let (pause, failure) = (self.paused.clone(), self.policy_failure.clone());
            inbox.set_is_paused(move || {
                failure.load(Ordering::SeqCst) || pause.load(Ordering::SeqCst)
            });
            let (credentials, lost, lifecycle, config) = (
                self.parts.credentials.clone(),
                self.auth_lost.clone(),
                lifecycle.clone(),
                config.clone(),
            );
            inbox.set_is_authorized(move || {
                lifecycle.is_active()
                    && !lost.load(Ordering::SeqCst)
                    && credentials
                        .load(&config.scope())
                        .is_some_and(|c| config.bearer(&c, crate::relay::state::now_ms()).is_ok())
            });
        }
        let credentials = self.parts.credentials.clone();
        let credential_scope = scope.clone();
        let threads = self.parts.threads.clone();
        let catalog_policy = policy.clone();
        let lost = self.auth_lost.clone();
        let receiver = Receiver::new(ReceiverParts {
            config: config.clone(),
            network: self.parts.network.clone(),
            store: Arc::new(OutboxStore(delivery.clone())),
            inbox: Arc::new(Accept {
                inbox: inbox.clone(),
                lifecycle: lifecycle.clone(),
            }),
            credential: Arc::new(move || {
                credentials
                    .load(&credential_scope)
                    .ok_or(MailboxError::AuthenticationRequired)
            }),
            catalog: Arc::new(move || {
                let (threads, policy) = (threads.clone(), catalog_policy.clone());
                Box::pin(async move {
                    tokio::task::spawn_blocking(move || catalog(&threads(), &policy))
                        .await
                        .unwrap_or_default()
                }) as BoxFuture<'static, Vec<ThreadReport>>
            }),
            authenticated: Arc::new(move |ok| lost.store(!ok, Ordering::SeqCst)),
            pause: Arc::new(|duration| Box::pin(tokio::time::sleep(duration))),
            jitter: || {
                let mut byte = [0u8; 1];
                let _ = getrandom::getrandom(&mut byte);
                f64::from(byte[0]) / 255.0
            },
        });
        self.set_paused(paused);
        delivery.start();
        let task = receiver.start();
        state.active = Some(Active {
            config,
            receiver,
            task,
            delivery,
            inbox,
            policy,
            lifecycle,
        });
    }

    fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    /// The person's pause (it follows the uploader's).
    pub fn pause(&self, paused: bool) {
        self.set_paused(paused);
    }

    async fn stop_locked(state: &mut State, remove_credential: bool, parts: &IncomingParts) {
        state.transition += 1;
        state.activating = None;
        state.policy_error = None;
        let active = state.active.take();
        let binding = state.binding.take();
        if let Some(active) = &active {
            active.lifecycle.invalidate();
            active.task.abort();
        }
        if remove_credential {
            if let Some((config, path)) = binding {
                let scope = config.scope();
                // The credential is read before it is removed, so a later
                // sign-in's is never the one deactivated or deleted.
                if let Some(credential) = parts.credentials.load(&scope) {
                    let network = parts.network.clone();
                    tokio::spawn(async move {
                        Receiver::deactivate(network.as_ref(), &config, &credential).await;
                    });
                }
                parts.credentials.remove(&scope);
                let _ = std::fs::remove_file(&path);
            }
        }
        if let Some(active) = active {
            let delivery = active.delivery.clone();
            let _ = tokio::task::spawn_blocking(move || delivery.stop()).await;
        }
    }

    /// Stops incoming; on sign-out also ends the device session and
    /// forgets the credential and binding.
    pub async fn stop(&self, remove_credential: bool) {
        self.set_paused(true);
        self.policy_failure.store(true, Ordering::SeqCst);
        let mut state = self.state.lock().await;
        Self::stop_locked(&mut state, remove_credential, &self.parts).await;
    }

    /// `incoming.status`.
    pub async fn status(&self) -> IncomingStatus {
        let state = self.state.lock().await;
        let Some(active) = &state.active else {
            let reason = if state.binding.is_some() {
                IncomingState::Unavailable
            } else {
                IncomingState::Stopped
            };
            return IncomingStatus {
                state: reason,
                error: state.policy_error.clone(),
                threads: Vec::new(),
                held: Vec::new(),
                can_approve: false,
            };
        };
        let paused =
            self.paused.load(Ordering::SeqCst) || self.policy_failure.load(Ordering::SeqCst);
        let shown = if paused {
            IncomingState::Paused
        } else {
            match active.receiver.state() {
                ReceiverState::Connected => IncomingState::Connected,
                ReceiverState::Polling => IncomingState::Polling,
                ReceiverState::NeedsSignIn => IncomingState::NeedsSignIn,
                ReceiverState::Connecting | ReceiverState::Stopped => IncomingState::Connecting,
            }
        };
        let threads = {
            let (threads, policy) = (self.parts.threads.clone(), active.policy.clone());
            tokio::task::spawn_blocking(move || {
                let rows = threads();
                rows.iter()
                    .map(|thread| {
                        let share = policy.share_for(&thread.id);
                        IncomingThread {
                            id: thread.id.clone(),
                            project: thread.project.clone(),
                            title: thread.title.clone(),
                            open: thread.open,
                            shared: share.is_some(),
                            mode: share.as_ref().map(|s| s.mode),
                            allows_unrestricted: share
                                .as_ref()
                                .is_some_and(|s| s.allows_unrestricted),
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .unwrap_or_default()
        };
        let held: Vec<HeldMessage> = active
            .inbox
            .held_messages()
            .unwrap_or_default()
            .iter()
            .map(held)
            .collect();
        IncomingStatus {
            state: shown,
            error: state.policy_error.clone(),
            threads,
            held,
            can_approve: active.inbox.can_deliver(),
        }
    }

    /// Shares a thread (`mode`) or stops sharing it (`None`). A save that
    /// fails pauses incoming until a later change saves.
    pub async fn share(
        &self,
        thread_id: &str,
        mode: Option<Mode>,
        allows_unrestricted: bool,
    ) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let Some(active) = &state.active else {
            return Err("Incoming messages are not connected.".into());
        };
        let saved = match mode {
            Some(mode) => active
                .policy
                .share(thread_id, mode, allows_unrestricted)
                .map(|_| ()),
            None => active.policy.unshare(thread_id),
        };
        match saved {
            Ok(()) => {
                active.delivery.wake();
                self.policy_failure.store(false, Ordering::SeqCst);
                state.policy_error = None;
                Ok(())
            }
            Err(_) => {
                self.policy_failure.store(true, Ordering::SeqCst);
                state.policy_error = Some(SAVE_FAILED.into());
                Err(SAVE_FAILED.into())
            }
        }
    }

    /// Approves a held message; `false` when it cannot be approved now
    /// (expired, gone, or incoming paused).
    pub async fn approve(&self, id: &str) -> Result<bool, String> {
        let state = self.state.lock().await;
        let active = state
            .active
            .as_ref()
            .ok_or("Incoming messages are not connected.")?;
        active.inbox.approve(id).map_err(|e| e.to_string())
    }

    pub async fn reject(&self, id: &str) -> Result<bool, String> {
        let state = self.state.lock().await;
        let active = state
            .active
            .as_ref()
            .ok_or("Incoming messages are not connected.")?;
        active
            .inbox
            .reject(id, Some("declined by the local user"))
            .map_err(|e| e.to_string())
    }

    /// The connected mailbox's scope, for tests and support.
    pub async fn scope(&self) -> Option<String> {
        self.state
            .lock()
            .await
            .active
            .as_ref()
            .map(|a| a.config.scope())
    }
}

/// The catalog the mailbox reports: every recent thread, with whether (and
/// how) it is shared; only shared ones leave this computer.
fn catalog(threads: &[LocalThread], policy: &CodexSharingPolicy) -> Vec<ThreadReport> {
    threads
        .iter()
        .map(|thread| {
            let share = policy.share_for(&thread.id);
            ThreadReport {
                id: thread.id.clone(),
                mode: share.as_ref().map(|s| s.mode.as_str().to_string()),
                open: thread.open,
                project: thread.project.clone(),
                shared: share.is_some(),
                title: thread.title.clone(),
            }
        })
        .collect()
}

/// The recent Codex threads on this computer and which are open now.
pub fn codex_threads(
    config: crate::relay::codex::CodexConfig,
    table: Arc<dyn crate::relay::process::ProcessTable>,
    uid: u32,
) -> Threads {
    Arc::new(move || {
        let recent = crate::relay::codex::recent_threads(&config, 500);
        let open = crate::relay::codex::open_thread_ids(&config, table.as_ref(), uid);
        recent
            .into_iter()
            .map(|thread| LocalThread {
                open: open.contains(&thread.id.to_lowercase()),
                project: thread.project().unwrap_or_default(),
                id: thread.id,
                title: thread.title,
            })
            .collect()
    })
}

#[cfg(test)]
mod tests;
