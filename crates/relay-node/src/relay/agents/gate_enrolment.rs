//! Agents of a gate-only install: enrolled at relaygate with the desktop's
//! device token, and kept enrolled by registering again (same name, same
//! recovery proof, so the same agent id) for a new `rg_` token: at 80% of
//! the token's lifetime, and once at once when a delivery read finds the
//! token refused (401 `relaygate_unauthenticated`).
//!
//! A refusal (403) or a taken name (409) is not retried: it stays on the
//! agent's status until it is registered again. A rate limit or an outage
//! waits for the gate's `Retry-After`.

use super::*;
use crate::relay::sdk_gaps::{gate_delete_self, gate_register, new_recovery, GateError};
use crate::relay::store::GateEnrolment;
use std::time::{Duration, Instant};

/// How long a failed renewal waits when the gate named no `Retry-After`.
const RENEW_RETRY: Duration = Duration::from_secs(30);
/// The least time between two renewals of one agent, so a gate that
/// refuses every token it issues is not asked again in a tight loop.
const RENEW_SPACING: Duration = Duration::from_secs(1);

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
}

/// How a renewal ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Renewal {
    /// The agent holds a token newer than the one that failed.
    Renewed,
    /// Nothing changed; the old token stays until it is renewed later.
    NotRenewed,
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
        let recovery = new_recovery().map_err(|error| {
            RpcError::new(
                ErrorKind::Internal,
                format!("Could not make a recovery proof for @{name}: {error}"),
            )
        })?;
        let issued = gate_register(gate_url, &device, name, recovery.expose())
            .await
            .map_err(|error| gate_rpc_error(&error, name))?;
        let enrolment = GateEnrolment::issued(recovery, chrono::Utc::now(), issued.expires_at);
        Ok((issued, enrolment))
    }

    /// The desktop's device token, or a clear signed-out error. An empty
    /// one counts as none: no request goes out with an empty bearer.
    async fn device_token(&self) -> Result<Secret, RpcError> {
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

    /// Takes a gate agent down with its own token (`DELETE /v1/agent`),
    /// after a store failure left it without a saved token. Best effort:
    /// relaygate has no key-held cleanup to retry with later.
    pub(super) async fn delete_at_gate(&self, base_url: &str, token: &Secret, name: &str) {
        if let Err(error) = gate_delete_self(base_url, token).await {
            self.hub.activity(
                Level::Warning,
                format!("@{name} could not be removed from relaygate again: {error}. It expires with its token."),
            );
        }
    }

    /// Deletes gate agent `name` at relaygate with its own token, before
    /// its registration is dropped. A refused token is renewed once and
    /// the delete repeated. A gate that still refuses (the token cannot be
    /// renewed, the name is no longer this person's) leaves nothing this
    /// computer could remove: the agent goes, and what is left expires
    /// with its token. An outage keeps the registration, so removal can be
    /// retried.
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
                    if let Renewal::Renewed =
                        self.renew_gate_registration(name, Some(&current)).await
                    {
                        if let Some(next) = token() {
                            current = next;
                            continue;
                        }
                    }
                    self.gate_left_behind(name, &GateError::Unauthenticated);
                    return Ok(());
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
    /// is still due is renewed. One renewal per agent runs at a time.
    pub(crate) async fn renew_gate_registration(
        &self,
        name: &str,
        failed: Option<&Secret>,
    ) -> Renewal {
        let lock = self.gate_locks.get(name);
        let _renewing = lock.lock().await;
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
                return Renewal::NotRenewed;
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
            return Renewal::NotRenewed;
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
            Ok(false) => return Renewal::NotRenewed,
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

    fn renewal_failed(&self, name: &str, message: String, wait: Option<Duration>, stop: bool) {
        {
            let mut renewals = self.gate_renewals.lock().unwrap();
            if let Some(wait) = wait {
                renewals
                    .not_before
                    .insert(name.into(), Instant::now() + wait.max(RENEW_SPACING));
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
