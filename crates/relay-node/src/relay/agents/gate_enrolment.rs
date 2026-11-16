//! Agents of a gate-only install: enrolled at relaygate with the desktop's
//! device token, and kept enrolled by registering again (same name, same
//! recovery proof, so the same agent id) for a new `rg_` token: at 80% of
//! the token's lifetime, and once at once when a delivery read finds the
//! token refused (401 `relaygate_unauthenticated`).
//!
//! A refusal (403) or a taken name (409) is not retried: it stays on the
//! agent's status until it is registered again. A rate limit or an outage
//! waits for the gate's `Retry-After`.
//!
//! A name's recovery proof is saved before the first register is sent and
//! kept after the agent is removed ([`crate::relay::store::Store::gate_recoveries`]):
//! relaygate binds the name to it on the first register, answer read or
//! not, and keeps it reserved for the same proof after `DELETE /v1/agent`.
//!
//! Removal and every renewal of one agent hold the same lock
//! ([`Core::gate_locks`]), so a renewal can never register an agent again
//! after its removal deleted it.
//!
//! An alias of a gate agent (a rename) is a gate agent of its own: enrolled
//! under its name with its own recovery proof, renewed like any other, and
//! deleted with its own token when it is released.
//!
//! An agent spawned on a gate-only install is registered with its launch's
//! one-time credential instead, and refreshed with its own token
//! ([`launched`]).

use super::*;
use crate::relay::sdk_gaps::{
    gate_delete_self, gate_patch_self, gate_register, new_recovery, GateError, GateSelfPatch,
};
use crate::relay::store::{AgentAlias, GateEnrolment};
use std::time::{Duration, Instant};

mod launched;

/// How long a failed renewal waits when the gate named no `Retry-After`.
const RENEW_RETRY: Duration = Duration::from_secs(30);
/// The least time between two renewals of one agent, so a gate that
/// refuses every token it issues is not asked again in a tight loop.
const RENEW_SPACING: Duration = Duration::from_secs(1);
/// The longest wait a gate's `Retry-After` is honoured for: a larger (or
/// unrepresentable) one waits this long instead.
const LONGEST_WAIT: Duration = Duration::from_secs(60 * 60);

/// When a wait of `wait` (a gate's `Retry-After`, untrusted) ends: at least
/// [`RENEW_SPACING`] and at most [`LONGEST_WAIT`] from now, so it can
/// never overflow an `Instant`.
fn wait_until(wait: Duration) -> Instant {
    let wait = wait.clamp(RENEW_SPACING, LONGEST_WAIT);
    let now = Instant::now();
    now.checked_add(wait).unwrap_or(now)
}

/// What this run knows about renewals, by agent name. Nothing here is
/// saved: after a restart every due agent is tried again.
#[derive(Default)]
pub(crate) struct GateRenewals {
    /// Not renewed again before then (a `Retry-After`, or the spacing).
    not_before: HashMap<String, Instant>,
    /// Refused or name taken: not renewed again by itself.
    stopped: HashSet<String>,
    /// Why the last renewal failed, shown on the agent.
    errors: BTreeMap<String, String>,
    /// By gate origin: no agent `PATCH` is sent before then (a 429 or 503
    /// answered one, with its `Retry-After` or [`RENEW_RETRY`]).
    patch_not_before: HashMap<String, Instant>,
}

/// How a renewal ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Renewal {
    /// The agent holds a token newer than the one that failed.
    Renewed,
    /// relaygate will not renew it (a refusal, a taken name, another
    /// agent): not tried again by itself until it is registered again.
    Stopped,
    /// Not renewed now (nothing due, signed out, an outage or rate limit, a
    /// wait, a failed save): the old token stays and it is tried later.
    NotRenewed,
}

/// A gate agent that could not be saved here and whose `DELETE /v1/agent`
/// failed: tried again on later passes while this run lasts.
pub(crate) struct GateCleanup {
    base_url: String,
    token: Secret,
    name: String,
    agent_id: String,
    /// An alias's recovery proof: a refused token is replaced by
    /// registering the name again with it, then the delete is repeated.
    recovery: Option<Secret>,
    /// The gate refused `token` already: registered again before the
    /// next delete.
    refused: bool,
    not_before: Instant,
}

impl GateCleanup {
    /// Waits for the gate's `Retry-After` when `error` named one, else
    /// [`RENEW_RETRY`].
    fn wait_after(&mut self, error: &GateError) {
        self.not_before = match error {
            GateError::RateLimited {
                retry_after: Some(wait),
            }
            | GateError::Unavailable {
                retry_after: Some(wait),
            } => wait_until(*wait),
            _ => Instant::now() + RENEW_RETRY,
        };
    }
}

impl Core {
    /// Enrols `name` at `gate_url` for a new registration: a fresh recovery
    /// proof, the device token as the bearer. Nothing is sent for a `ctl:`
    /// name (relaygate's reserved control names) or when signed out.
    pub(crate) async fn enrol_at_gate(
        &self,
        gate_url: &str,
        name: &str,
    ) -> Result<(crate::relay::sdk_gaps::GateRegistration, GateEnrolment), RpcError> {
        if name.starts_with("ctl:") {
            return Err(RpcError::invalid_params(format!(
                "@{name} is reserved: names starting with ctl: cannot be registered."
            )));
        }
        let device = self.device_token().await?;
        let recovery = self.gate_recovery_for(gate_url, name)?;
        let issued = gate_register(gate_url, &device, name, recovery.expose())
            .await
            .map_err(|error| gate_rpc_error(&error, name))?;
        let enrolment = GateEnrolment::issued(recovery, chrono::Utc::now(), issued.expires_at);
        Ok((issued, enrolment))
    }

    /// The recovery proof to enrol `name` at `gate_url` with: the one kept
    /// from an earlier enrolment of the name here, else a new one, saved
    /// before anything is sent. Without that save nothing is sent: an
    /// answer lost on the way back would bind the name to a proof this
    /// computer no longer has.
    fn gate_recovery_for(&self, gate_url: &str, name: &str) -> Result<Secret, RpcError> {
        if let Some(kept) = self.store.read(|s| s.gate_recovery(gate_url, name)) {
            return Ok(kept);
        }
        let fresh = new_recovery().map_err(|error| {
            RpcError::new(
                ErrorKind::Internal,
                format!("Could not make a recovery proof for @{name}: {error}"),
            )
        })?;
        self.store
            // Decided on the file as it is now, under its lock: another
            // process may have kept a proof for this name already.
            .update_latest(|s| s.keep_gate_recovery(gate_url, name, fresh))
            .map_err(|error| {
                RpcError::new(
                    ErrorKind::StoreFailed,
                    format!("Could not save a recovery proof for @{name}, so it was not enrolled at relaygate. {error}"),
                )
            })
    }

    /// The desktop's device token, or a clear signed-out error. An empty
    /// one counts as none: no request goes out with an empty bearer.
    pub(crate) async fn device_token(&self) -> Result<Secret, RpcError> {
        self.plugins
            .cloud
            .device_token()
            .await
            .filter(|token| !token.expose().trim().is_empty())
            .ok_or_else(|| {
                RpcError::new(
                    ErrorKind::NotSignedIn,
                    "Signed out of Agent Relay: sign in again so this computer's agents can enrol through relaygate.",
                )
            })
    }

    /// Takes a gate agent down with its own token (`DELETE /v1/agent`)
    /// after it could not be kept here (its save failed, or the name was
    /// taken here meanwhile). Never when a registration here holds the same
    /// agent: the gate has one agent per name. A delete that fails on an
    /// outage is tried again on later passes ([`Core::retry_gate_cleanups`]);
    /// one the gate refuses has nothing left to delete with.
    pub(super) async fn undo_gate_enrolment(
        &self,
        base_url: &str,
        token: &Secret,
        name: &str,
        agent_id: &str,
    ) {
        if self.gate_agent_held(agent_id) {
            return;
        }
        if let Err(error) = gate_delete_self(base_url, token).await {
            if gate_delete_retryable(&error) {
                let mut cleanup = GateCleanup {
                    base_url: base_url.to_owned(),
                    token: token.clone(),
                    name: name.to_owned(),
                    agent_id: agent_id.to_owned(),
                    recovery: None,
                    refused: false,
                    not_before: Instant::now(),
                };
                cleanup.wait_after(&error);
                self.gate_cleanups.lock().unwrap().push(cleanup);
            }
            self.hub.activity(
                Level::Warning,
                format!("@{name} could not be removed from relaygate yet: {error}."),
            );
        }
    }

    /// Enrols `alias` at relaygate for gate agent `registration`'s session
    /// (a rename): an agent of its own there, with its own recovery proof.
    pub(super) async fn enrol_gate_alias(
        &self,
        registration: &Registration,
        alias: &str,
    ) -> Result<AgentAlias, RpcError> {
        let (issued, enrolment) = self.enrol_at_gate(&registration.base_url, alias).await?;
        Ok(AgentAlias {
            name: alias.to_owned(),
            agent_id: issued.agent_id,
            token: issued.token,
            registered_at: crate::relay::store::iso8601_now(),
            gate: Some(enrolment),
        })
    }

    /// Deletes `alias`, an alias of a gate agent this computer no longer
    /// holds, at relaygate with its own token (`DELETE /v1/agent`). A token
    /// the gate refused (it expired) is replaced first by registering the
    /// alias again with its recovery proof, which reaches the same agent,
    /// and the delete is sent once more with the new one. An outage, at
    /// either step, is tried again on later passes from where it stopped
    /// ([`Core::retry_gate_cleanups`]); a gate that still refuses leaves an
    /// agent that expires with its token.
    pub(super) async fn delete_gate_alias(&self, base_url: &str, alias: &AgentAlias) {
        let recovery = self
            .store
            .read(|s| s.gate_recovery(base_url, &alias.name))
            .or_else(|| alias.gate.as_ref().and_then(|gate| gate.recovery.clone()));
        self.run_gate_cleanup(GateCleanup {
            base_url: base_url.to_owned(),
            token: alias.token.clone(),
            name: alias.name.clone(),
            agent_id: alias.agent_id.clone(),
            recovery,
            refused: false,
            not_before: Instant::now(),
        })
        .await;
        if !self.gate_name_held(base_url, &alias.name, &alias.agent_id) {
            self.forget_gate_renewal(&alias.name);
        }
    }

    /// Deletes `cleanup`'s agent at relaygate, or queues it again on an
    /// outage with what it still needs (a new token first, when the gate
    /// refused its own).
    ///
    /// The name is claimed for the whole removal, as every enrolment here
    /// claims it until its registration is saved: one in flight is waited
    /// out (the cleanup is queued), and none starts meanwhile. A name
    /// enrolled here again reaches the same agent (same recovery proof),
    /// so a registration that holds it keeps it and nothing is deleted.
    async fn run_gate_cleanup(&self, mut cleanup: GateCleanup) {
        let name = cleanup.name.clone();
        if self.claim_name(&name).is_err() {
            cleanup.not_before = Instant::now() + RENEW_RETRY;
            self.gate_cleanups.lock().unwrap().push(cleanup);
            return;
        }
        let failed = {
            let lock = self.gate_locks.get(&name);
            let _removing = lock.lock().await;
            self.gate_cleanup_step(&mut cleanup).await
        };
        self.release_name(&name);
        if let Some(error) = failed {
            cleanup.wait_after(&error);
            self.gate_cleanups.lock().unwrap().push(cleanup);
            self.hub.activity(
                Level::Warning,
                format!("@{name} could not be removed from relaygate yet: {error}."),
            );
        }
    }

    /// One attempt at `cleanup`, under its name's claim and gate lock: the
    /// error to wait out and try again after, if any.
    async fn gate_cleanup_step(&self, cleanup: &mut GateCleanup) -> Option<GateError> {
        let name = cleanup.name.clone();
        let mut renewed = false;
        loop {
            if self.gate_name_held(&cleanup.base_url, &name, &cleanup.agent_id) {
                return None;
            }
            if cleanup.refused {
                let Some(recovery) = cleanup.recovery.clone() else {
                    self.gate_left_behind(&name, &GateError::Unauthenticated);
                    return None;
                };
                match self
                    .register_gate_name_again(&cleanup.base_url, &name, &recovery)
                    .await
                {
                    Ok(token) => {
                        cleanup.token = token;
                        cleanup.refused = false;
                        renewed = true;
                    }
                    Err(error) if gate_delete_retryable(&error) => return Some(error),
                    Err(error) => {
                        self.gate_left_behind(&name, &error);
                        return None;
                    }
                }
            }
            match gate_delete_self(&cleanup.base_url, &cleanup.token).await {
                Ok(()) => return None,
                Err(GateError::Unauthenticated) if !renewed && cleanup.recovery.is_some() => {
                    cleanup.refused = true;
                }
                Err(error) if gate_delete_retryable(&error) => return Some(error),
                Err(error) => {
                    self.gate_left_behind(&name, &error);
                    return None;
                }
            }
        }
    }

    /// A new token for gate agent `name`, whose own was refused: registered
    /// again with `recovery`, the proof kept for its name.
    async fn register_gate_name_again(
        &self,
        base_url: &str,
        name: &str,
        recovery: &Secret,
    ) -> Result<Secret, GateError> {
        let device = self
            .device_token()
            .await
            .map_err(|_| GateError::Unauthenticated)?;
        let issued = gate_register(base_url, &device, name, recovery.expose()).await?;
        Ok(issued.token)
    }

    fn gate_agent_held(&self, agent_id: &str) -> bool {
        self.store
            .read(|s| s.registrations.iter().any(|r| r.agent_id == agent_id))
    }

    /// Whether a registration here holds gate agent `agent_id` or the name
    /// `name` at `base_url`, as any of its names.
    fn gate_name_held(&self, base_url: &str, name: &str, agent_id: &str) -> bool {
        self.store.read(|s| {
            s.registrations
                .iter()
                .any(|r| r.agent_id == agent_id || (r.base_url == base_url && r.answers_to(name)))
        })
    }

    /// Tries again each gate agent a removal could not delete yet, once its
    /// wait is over, from where it stopped. Nothing is kept for an install
    /// without a gate, so this does nothing there.
    pub(crate) async fn retry_gate_cleanups(&self) {
        let due: Vec<GateCleanup> = {
            let mut cleanups = self.gate_cleanups.lock().unwrap();
            if cleanups.is_empty() {
                return;
            }
            let now = Instant::now();
            let (due, waiting) = std::mem::take(&mut *cleanups)
                .into_iter()
                .partition(|c| c.not_before <= now);
            *cleanups = waiting;
            due
        };
        for cleanup in due {
            self.run_gate_cleanup(cleanup).await;
        }
    }

    /// Deletes gate agent `name` at relaygate with its own token, before
    /// its registration is dropped. A refused token is renewed once and
    /// the delete repeated. A gate that still refuses (the token cannot be
    /// renewed, the name is no longer this person's) leaves nothing this
    /// computer could remove: the agent goes, and what is left expires
    /// with its token. An outage keeps the registration, so removal can be
    /// retried.
    ///
    /// The caller holds `name`'s entry in [`Core::gate_locks`] from before
    /// this until the registration is dropped.
    pub(super) async fn remove_at_gate(
        &self,
        registration: &Registration,
        name: &str,
    ) -> Result<(), RpcError> {
        let token = || self.store.read(|s| s.tokens.get(name).cloned());
        let Some(mut current) = token() else {
            return Ok(());
        };
        let mut renewed = false;
        loop {
            match gate_delete_self(&registration.base_url, &current).await {
                Ok(()) => return Ok(()),
                Err(GateError::Unauthenticated) if !renewed => {
                    renewed = true;
                    match self.renew_gate_locked(name, Some(&current)).await {
                        Renewal::Renewed => match token() {
                            Some(next) => {
                                current = next;
                                continue;
                            }
                            None => return Ok(()),
                        },
                        Renewal::Stopped => {
                            self.gate_left_behind(name, &GateError::Unauthenticated);
                            return Ok(());
                        }
                        // Signed out, an outage, a wait: the agent may still
                        // be there, and its recovery proof is what reaches
                        // it again. The registration is kept.
                        Renewal::NotRenewed => {
                            let kind = match self.device_token().await {
                                Ok(_) => ErrorKind::RelaycastUnreachable,
                                Err(_) => ErrorKind::NotSignedIn,
                            };
                            let why = self.gate_error(name).unwrap_or_else(|| {
                                format!("@{name}: its relaygate token was refused and could not be renewed yet.")
                            });
                            return Err(RpcError::new(
                                kind,
                                format!("Could not remove @{name} from relaygate. {why} The registration was kept; retry when the connection is working."),
                            ));
                        }
                    }
                }
                Err(
                    error @ (GateError::Unauthenticated
                    | GateError::Refused { .. }
                    | GateError::NameTaken
                    | GateError::Invalid(_)),
                ) => {
                    self.gate_left_behind(name, &error);
                    return Ok(());
                }
                Err(error) => {
                    let mut mapped = gate_rpc_error(&error, name);
                    mapped.message = format!(
                        "Could not remove @{name} from relaygate. {} The registration was kept; retry when the connection is working.",
                        mapped.message,
                    );
                    return Err(mapped);
                }
            }
        }
    }

    fn gate_left_behind(&self, name: &str, error: &GateError) {
        self.hub.activity(
            Level::Warning,
            format!("@{name} could not be removed from relaygate: {error}. It was removed from this computer and expires at relaygate with its token."),
        );
    }

    /// Why `name`'s last renewal failed, if it did.
    pub(crate) fn gate_error(&self, name: &str) -> Option<String> {
        self.gate_renewals.lock().unwrap().errors.get(name).cloned()
    }

    /// Forgets a gate agent's renewal state: it was registered anew or
    /// removed.
    pub(crate) fn forget_gate_renewal(&self, name: &str) {
        let mut renewals = self.gate_renewals.lock().unwrap();
        renewals.not_before.remove(name);
        renewals.stopped.remove(name);
        renewals.errors.remove(name);
    }

    /// Starts a renewal for every present gate agent whose token is due,
    /// unless one is running or it waits. Called on every delivery pass.
    pub(crate) fn renew_due_gate_registrations(self: &Arc<Self>) {
        self.report_lost_launch_gates();
        let now = chrono::Utc::now();
        // Each name with a token of its own: the agent, then its aliases.
        let due: Vec<String> = self.store.read(|store| {
            store
                .credentials()
                .into_iter()
                .map(|(r, _)| r)
                .filter(|r| r.missing_since.is_none() && r.archived_at.is_none())
                .filter(|r| r.gate.as_ref().is_some_and(|gate| gate.due(now)))
                .map(|r| r.name)
                .collect()
        });
        for name in due {
            if !self.may_renew(&name) {
                continue;
            }
            let core = self.clone();
            tokio::spawn(async move {
                core.renew_gate_registration(&name, None).await;
            });
        }
        self.renew_person_if_due();
    }

    /// Starts a renewal of your own gate identity (tracked as `@name`, a
    /// key no agent name can take) when its token is due, unless one is in
    /// flight, a refusal stopped it, or the gate's wait after a failure is
    /// not over ([`Core::person_renewal_failed`]).
    fn renew_person_if_due(self: &Arc<Self>) {
        let Some(channel) = self.person_gate_channel() else {
            return;
        };
        if !self.person_gate_due() || !self.may_renew(&channel) {
            return;
        }
        if self.gate_locks.get(&channel).try_lock().is_err() {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            let _ = core.person_identity(false).await;
        });
    }

    /// When your gate identity may be enrolled again, if not yet: a failed
    /// enrolment's wait (the gate's `Retry-After`, else [`RENEW_RETRY`]),
    /// and why it failed. Foreground enrolments honour it as well as the
    /// background renewal.
    pub(crate) fn person_renewal_wait(&self, channel: &str) -> Option<(Duration, Option<String>)> {
        let renewals = self.gate_renewals.lock().unwrap();
        let wait = renewals
            .not_before
            .get(channel)?
            .checked_duration_since(Instant::now())
            .filter(|wait| !wait.is_zero())?;
        Some((wait, renewals.errors.get(channel).cloned()))
    }

    /// Records a failed enrolment of your gate identity: not enrolled again
    /// before the gate's `Retry-After` (else [`RENEW_RETRY`]); a refusal or
    /// a taken name also stops the background renewal until an enrolment
    /// succeeds. Unlike an agent's, it is not shown as a delivery error.
    pub(crate) fn person_renewal_failed(&self, channel: &str, error: &RpcError) {
        let stop = matches!(error.data.kind, ErrorKind::Refused | ErrorKind::Conflict);
        let wait = error
            .retry_after_secs
            .map(Duration::from_secs)
            .unwrap_or(RENEW_RETRY);
        let mut renewals = self.gate_renewals.lock().unwrap();
        renewals.not_before.insert(channel.into(), wait_until(wait));
        if stop {
            renewals.stopped.insert(channel.into());
        }
        renewals
            .errors
            .insert(channel.into(), error.message.clone());
    }

    /// Says once, on each launched agent whose relaygate registration this
    /// run does not hold (it lived in memory alone, so a restart lost it),
    /// that it needs a relaunch: its launch credential was spent, so it
    /// cannot be registered again here, and it acts with no other token.
    fn report_lost_launch_gates(&self) {
        let lost: Vec<String> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| r.spawn.as_ref().is_some_and(|spawn| spawn.gate_launch))
                .filter(|r| r.archived_at.is_none() && store.launch_gate_of(r).is_none())
                .map(|r| r.name.clone())
                .collect()
        });
        for name in lost {
            if self.gate_error(&name).is_some() {
                continue;
            }
            let message = format!(
                "@{name}: its relaygate registration ended when Agent Relay restarted, and its launch credential can be used only once. Relaunch the agent."
            );
            self.hub.activity(Level::Warning, message.clone());
            self.renewal_failed(&name, message, None, true);
        }
    }

    fn may_renew(&self, name: &str) -> bool {
        let renewals = self.gate_renewals.lock().unwrap();
        !renewals.stopped.contains(name)
            && renewals
                .not_before
                .get(name)
                .is_none_or(|at| *at <= Instant::now())
    }

    /// Registers gate agent `name` again for a new token. With `failed`,
    /// the token relaygate refused: when the agent already holds another,
    /// that one is used and nothing is sent. Without it, only a token that
    /// is still due is renewed. One renewal per agent runs at a time, and
    /// never while it is being removed.
    pub(crate) async fn renew_gate_registration(
        &self,
        name: &str,
        failed: Option<&Secret>,
    ) -> Renewal {
        let lock = self.gate_locks.get(name);
        let _renewing = lock.lock().await;
        self.renew_gate_locked(name, failed).await
    }

    /// [`Core::renew_gate_registration`] for a caller that holds `name`'s
    /// entry in [`Core::gate_locks`] already (removal, a send). `name` may
    /// be an alias: it renews with its own recovery proof.
    pub(crate) async fn renew_gate_locked(&self, name: &str, failed: Option<&Secret>) -> Renewal {
        let Some((registration, token, alias)) = self.store.read(|s| {
            let (registration, token) = s.credential_named(name)?;
            Some((registration, token, s.registration_named(name).is_none()))
        }) else {
            return Renewal::NotRenewed;
        };
        let Some(mut gate) = registration.gate.clone() else {
            return Renewal::NotRenewed;
        };
        if alias {
            // Its own proof, never the agent's it is an alias of.
            match self
                .store
                .read(|s| s.gate_recovery(&registration.base_url, name))
            {
                Some(recovery) => gate.recovery = Some(recovery),
                None => return Renewal::NotRenewed,
            }
        }
        match failed {
            Some(failed) if *failed != token => return Renewal::Renewed,
            None if !gate.due(chrono::Utc::now()) => return Renewal::NotRenewed,
            _ => {}
        }
        if self.gate_renewals.lock().unwrap().stopped.contains(name) {
            return Renewal::Stopped;
        }
        if !self.may_renew(name) {
            return Renewal::NotRenewed;
        }
        self.gate_renewals
            .lock()
            .unwrap()
            .not_before
            .insert(name.into(), Instant::now() + RENEW_SPACING);
        // A launched agent's registration has no recovery proof: it is
        // refreshed with its own token instead.
        let Some(recovery) = gate.recovery.clone() else {
            return self
                .refresh_launch_gate(name, &registration.base_url, &token, &gate)
                .await;
        };
        let device = match self.device_token().await {
            Ok(device) => device,
            Err(error) => {
                self.renewal_failed(name, error.message, Some(RENEW_RETRY), false);
                return Renewal::NotRenewed;
            }
        };
        let result = gate_register(&registration.base_url, &device, name, recovery.expose()).await;
        let issued = match result {
            Ok(issued) => issued,
            Err(error) => {
                let message = gate_rpc_error(&error, name).message;
                let (wait, stop) = match &error {
                    GateError::Refused { .. } | GateError::NameTaken => (None, true),
                    GateError::RateLimited { retry_after }
                    | GateError::Unavailable { retry_after } => {
                        (Some(retry_after.unwrap_or(RENEW_RETRY)), false)
                    }
                    _ => (Some(RENEW_RETRY), false),
                };
                self.renewal_failed(name, message, wait, stop);
                return if stop {
                    Renewal::Stopped
                } else {
                    Renewal::NotRenewed
                };
            }
        };
        if issued.agent_id != registration.agent_id {
            // The same name and recovery always answer the same agent; a
            // different one is not this agent, and its token is not kept.
            self.renewal_failed(
                name,
                format!("@{name}: relaygate answered the re-registration with another agent, so the old one was kept."),
                None,
                true,
            );
            return Renewal::Stopped;
        }
        let enrolment = GateEnrolment::issued(recovery, chrono::Utc::now(), issued.expires_at);
        let saved = self.store.update(|store| {
            if let Some(current) = store
                .registrations
                .iter_mut()
                .find(|r| r.name == name && r.agent_id == registration.agent_id)
            {
                current.gate = Some(enrolment.clone());
                store.tokens.insert(name.into(), issued.token.clone());
                return true;
            }
            // An alias, current or still forwarding: its token is its own.
            let held = store.registrations.iter_mut().find_map(|r| {
                r.alias
                    .iter_mut()
                    .chain(r.retired_aliases.iter_mut().flatten().map(|r| &mut r.alias))
                    .find(|a| a.name == name && a.agent_id == registration.agent_id)
            });
            match held {
                Some(alias) => {
                    alias.token = issued.token.clone();
                    alias.gate = Some(enrolment.clone());
                    true
                }
                None => false,
            }
        });
        match saved {
            Ok(true) => {}
            Ok(false) => {
                // Dropped here while this renewal ran, by a path other than
                // removal (which holds the lock): the agent the register
                // reached now answers only to the token just issued, so
                // that is what takes it down.
                if self.store.read(|s| s.credential_named(name).is_none()) {
                    self.undo_gate_enrolment(
                        &registration.base_url,
                        &issued.token,
                        name,
                        &registration.agent_id,
                    )
                    .await;
                }
                return Renewal::NotRenewed;
            }
            Err(error) => {
                // The old token is revoked now: registering again after
                // the wait issues another, which is saved then.
                self.renewal_failed(
                    name,
                    format!("@{name}: Could not save its new relaygate token. {error}"),
                    Some(RENEW_RETRY),
                    false,
                );
                return Renewal::NotRenewed;
            }
        }
        {
            let mut renewals = self.gate_renewals.lock().unwrap();
            renewals.errors.remove(name);
        }
        // The push channel restarts with the new token.
        self.sync_agents().await;
        self.hub.invalidated(Listing::Agents);
        Renewal::Renewed
    }

    /// Tells relaygate what gate agent `registration` is (`PATCH
    /// /v1/agent` with its own token): the session metadata a workspace-key
    /// install sends with its register, plus `extra` and its status. Each
    /// of its names patches itself (relaygate lets an agent change itself
    /// only): an alias with its own token, naming the agent it is an alias
    /// of. A name it does not hold answers `Ok` with nothing sent. A token
    /// the gate refused is renewed once, unless a renewal or removal holds
    /// the name, and the patch sent again.
    pub(super) async fn publish_at_gate(
        &self,
        registration: &Registration,
        name: &str,
        description: Option<&str>,
        extra: Option<Map<String, Value>>,
        status: &str,
    ) -> relaycast::Result<()> {
        let held_token = || {
            self.store.read(|s| {
                s.credential_named(name)
                    .filter(|(held, _)| held.target == registration.target)
                    .map(|(_, token)| token)
            })
        };
        let Some(token) = held_token() else {
            return Ok(());
        };
        let base = &registration.base_url;
        let waiting = self
            .gate_renewals
            .lock()
            .unwrap()
            .patch_not_before
            .get(base)
            .is_some_and(|at| *at > Instant::now());
        if waiting {
            // Stays pending: the gate asked to wait.
            return Err(relaycast::RelayError::InvalidResponse(
                "relaygate asked to wait before the next update".into(),
            ));
        }
        let owner = self.agent_owner();
        let mut metadata = self.metadata(
            &registration.target,
            &registration.title,
            description,
            owner.as_ref(),
        );
        if name != registration.name {
            metadata.insert("alias_of".into(), Value::String(registration.name.clone()));
        }
        metadata.extend(extra.unwrap_or_default());
        let patch = GateSelfPatch {
            status: Some(status.to_owned()),
            metadata: Some(metadata),
            ..GateSelfPatch::default()
        };
        let mut result = gate_patch_self(base, &token, &patch).await;
        if matches!(result, Err(GateError::Unauthenticated)) {
            // Never waits on a renewal or removal of the name in progress:
            // the patch stays pending and is sent on a later pass.
            let lock = self.gate_locks.get(name);
            if let Ok(_renewing) = lock.clone().try_lock_owned() {
                if self.renew_gate_locked(name, Some(&token)).await == Renewal::Renewed {
                    if let Some(next) = held_token() {
                        result = gate_patch_self(base, &next, &patch).await;
                    }
                }
            }
        }
        if let Err(
            GateError::RateLimited { retry_after } | GateError::Unavailable { retry_after },
        ) = &result
        {
            // Worked out before the lock is taken; an earlier wait still
            // running is never shortened by a later, shorter answer.
            let until = wait_until(retry_after.unwrap_or(RENEW_RETRY));
            let mut renewals = self.gate_renewals.lock().unwrap();
            keep_later(&mut renewals.patch_not_before, base, until);
        }
        result.map(drop).map_err(|error| match error {
            GateError::Other(inner) => *inner,
            other => relaycast::RelayError::InvalidResponse(other.to_string()),
        })
    }

    /// Publishes a new gate agent's session metadata. One that fails is
    /// queued with the name markers, which publish it again.
    pub(super) async fn publish_gate_registration(
        &self,
        registration: &Registration,
        description: Option<&str>,
    ) {
        let name = registration.name.clone();
        let status = self.roster_status(registration, &name);
        let published = self
            .publish_at_gate(registration, &name, description, None, status)
            .await;
        if published.is_err() {
            let _ = self.store.remember(|s| {
                let pending = s.pending_name_markers.get_or_insert_with(Vec::new);
                if !pending.contains(&name) {
                    pending.push(name.clone());
                }
            });
        }
    }

    fn renewal_failed(&self, name: &str, message: String, wait: Option<Duration>, stop: bool) {
        {
            let until = wait.map(wait_until);
            let mut renewals = self.gate_renewals.lock().unwrap();
            if let Some(until) = until {
                renewals.not_before.insert(name.into(), until);
            }
            if stop {
                renewals.stopped.insert(name.into());
            }
            renewals.errors.insert(name.into(), message.clone());
        }
        self.hub
            .update(|status| status.agents.delivery_error = Some(message));
        self.hub.invalidated(Listing::Agents);
    }
}

/// Whether a failed `DELETE /v1/agent` may succeed later with the same
/// token: an outage or a rate limit, not a refusal.
fn gate_delete_retryable(error: &GateError) -> bool {
    matches!(
        error,
        GateError::RateLimited { .. } | GateError::Unavailable { .. } | GateError::Other(_)
    )
}

/// `error` from a gate registration of `name`, as the person reads it.
pub(super) fn gate_rpc_error(error: &GateError, name: &str) -> RpcError {
    match error {
        GateError::NameTaken => RpcError::new(
            ErrorKind::Conflict,
            format!("@{name} is already taken at relaygate. Choose another name."),
        ),
        GateError::Refused { code } => RpcError::new(
            ErrorKind::Refused,
            format!("relaygate does not allow you to enrol @{name} ({code})."),
        ),
        GateError::Unauthenticated => RpcError::new(
            ErrorKind::NotSignedIn,
            "relaygate did not accept this computer's sign-in: sign in to Agent Relay again.",
        ),
        GateError::RateLimited { retry_after } | GateError::Unavailable { retry_after } => {
            let mut mapped = RpcError::new(
                ErrorKind::RelaycastUnreachable,
                format!("Could not register @{name}: {error}. Try again shortly."),
            );
            mapped.retry_after_secs = retry_after.map(|wait| wait.as_secs().max(1));
            mapped
        }
        GateError::Invalid(what) => RpcError::new(ErrorKind::Refused, *what),
        GateError::Other(inner) => {
            relaycast_error(inner, format!("Could not register @{name} at relaygate."))
        }
    }
}

/// Records `until` for `key` unless a later deadline is kept already.
fn keep_later(deadlines: &mut HashMap<String, Instant>, key: &str, until: Instant) {
    let kept = deadlines.entry(key.to_owned()).or_insert(until);
    *kept = (*kept).max(until);
}

#[cfg(test)]
mod wait_tests {
    use super::*;

    #[test]
    fn an_enormous_retry_after_is_capped_and_never_overflows() {
        let before = Instant::now();
        let until = wait_until(Duration::from_millis(u64::MAX));
        assert!(until <= Instant::now() + LONGEST_WAIT);
        assert!(until >= before + LONGEST_WAIT - Duration::from_secs(1));
        let until = wait_until(Duration::MAX);
        assert!(until <= Instant::now() + LONGEST_WAIT);
    }

    #[test]
    fn a_shorter_later_wait_never_shortens_one_still_running() {
        let mut deadlines = HashMap::new();
        let long = wait_until(Duration::from_secs(120));
        keep_later(&mut deadlines, "https://gate.corp.test", long);
        keep_later(
            &mut deadlines,
            "https://gate.corp.test",
            wait_until(Duration::from_secs(1)),
        );
        assert_eq!(deadlines["https://gate.corp.test"], long);
        let longer = wait_until(Duration::from_secs(300));
        keep_later(&mut deadlines, "https://gate.corp.test", longer);
        assert_eq!(deadlines["https://gate.corp.test"], longer);
    }

    #[test]
    fn a_tiny_retry_after_still_spaces_requests() {
        let before = Instant::now();
        assert!(wait_until(Duration::ZERO) >= before + RENEW_SPACING);
    }
}
