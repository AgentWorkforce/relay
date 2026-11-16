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

use super::*;
use crate::relay::sdk_gaps::{
    gate_delete_self, gate_patch_self, gate_register, new_recovery, GateError, GateSelfPatch,
};
use crate::relay::store::GateEnrolment;
use std::time::{Duration, Instant};

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
    not_before: Instant,
}

impl Core {
    /// Enrols `name` at `gate_url` for a new registration: a fresh recovery
    /// proof, the device token as the bearer. Nothing is sent for a `ctl:`
    /// name (relaygate's reserved control names) or when signed out.
    pub(super) async fn enrol_at_gate(
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
                self.gate_cleanups.lock().unwrap().push(GateCleanup {
                    base_url: base_url.to_owned(),
                    token: token.clone(),
                    name: name.to_owned(),
                    agent_id: agent_id.to_owned(),
                    not_before: Instant::now() + RENEW_RETRY,
                });
            }
            self.hub.activity(
                Level::Warning,
                format!("@{name} could not be removed from relaygate yet: {error}."),
            );
        }
    }

    fn gate_agent_held(&self, agent_id: &str) -> bool {
        self.store
            .read(|s| s.registrations.iter().any(|r| r.agent_id == agent_id))
    }

    /// Tries again each gate agent [`Core::undo_gate_enrolment`] could not
    /// delete, once its wait is over. Nothing is kept for an install
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
        for mut cleanup in due {
            if self.gate_agent_held(&cleanup.agent_id) {
                continue;
            }
            match gate_delete_self(&cleanup.base_url, &cleanup.token).await {
                Err(error) if gate_delete_retryable(&error) => {
                    cleanup.not_before = Instant::now() + RENEW_RETRY;
                    self.gate_cleanups.lock().unwrap().push(cleanup);
                }
                Err(error) => self.gate_left_behind(&cleanup.name, &error),
                Ok(()) => {}
            }
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
        let now = chrono::Utc::now();
        let due: Vec<String> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| r.missing_since.is_none() && r.archived_at.is_none())
                .filter(|r| r.gate.as_ref().is_some_and(|gate| gate.due(now)))
                .map(|r| r.name.clone())
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
    /// entry in [`Core::gate_locks`] already (removal).
    async fn renew_gate_locked(&self, name: &str, failed: Option<&Secret>) -> Renewal {
        let Some((registration, token)) = self.store.read(|s| {
            let registration = s.registration_named(name)?.clone();
            let token = s.tokens.get(name)?.clone();
            Some((registration, token))
        }) else {
            return Renewal::NotRenewed;
        };
        let Some(gate) = registration.gate.clone() else {
            return Renewal::NotRenewed;
        };
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
        let device = match self.device_token().await {
            Ok(device) => device,
            Err(error) => {
                self.renewal_failed(name, error.message, Some(RENEW_RETRY), false);
                return Renewal::NotRenewed;
            }
        };
        let result = gate_register(
            &registration.base_url,
            &device,
            name,
            gate.recovery.expose(),
        )
        .await;
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
        let enrolment = GateEnrolment::issued(gate.recovery, chrono::Utc::now(), issued.expires_at);
        let saved = self.store.update(|store| {
            let Some(current) = store
                .registrations
                .iter_mut()
                .find(|r| r.name == name && r.agent_id == registration.agent_id)
            else {
                return false;
            };
            current.gate = Some(enrolment.clone());
            store.tokens.insert(name.into(), issued.token.clone());
            true
        });
        match saved {
            Ok(true) => {}
            Ok(false) => {
                // Dropped here while this renewal ran, by a path other than
                // removal (which holds the lock): the agent the register
                // reached now answers only to the token just issued, so
                // that is what takes it down.
                if self.store.read(|s| s.registration_named(name).is_none()) {
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
    /// install sends with its register, plus `extra` and its status. Only
    /// the agent's own name is patched (relaygate lets an agent change
    /// itself only); anything else answers `Ok` with nothing sent.
    pub(super) async fn publish_at_gate(
        &self,
        registration: &Registration,
        name: &str,
        description: Option<&str>,
        extra: Option<Map<String, Value>>,
        status: &str,
    ) -> relaycast::Result<()> {
        if name != registration.name {
            return Ok(());
        }
        let Some(token) = self.store.read(|s| s.tokens.get(name).cloned()) else {
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
        metadata.extend(extra.unwrap_or_default());
        let patch = GateSelfPatch {
            status: Some(status.to_owned()),
            metadata: Some(metadata),
            ..GateSelfPatch::default()
        };
        let result = gate_patch_self(base, &token, &patch).await;
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
