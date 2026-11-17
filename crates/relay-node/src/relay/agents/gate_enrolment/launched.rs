//! A launched agent's relaygate registration on a gate-only install.
//!
//! Control gives each launch a one-time credential (`sh_lt_…`). The node
//! redeems it itself, inside the launch and before the harness starts: one
//! `POST /v1/register` with the credential as the bearer and the agent's
//! name as the body, never retried and never sent anywhere else. The
//! credential is dropped as soon as that call returns, so no agent process
//! ever sees it.
//!
//! The `rg_` token it answers is the agent's credential at the gate for as
//! long as the launch lives: kept in memory alone, with the gate enrolments
//! ([`crate::relay::store::Store::launch_gates`]), refreshed at 80% of its
//! lifetime with `POST /v1/token/refresh`, and released with `DELETE
//! /v1/agent` when the launch ends.

use super::*;
use crate::relay::sdk_gaps::{
    gate_refresh, gate_register_launch, GATE_DENIED, GATE_NAME_SCOPE, GATE_NAME_TAKEN,
    GATE_UNAUTHENTICATED, GATE_UNAVAILABLE,
};
use crate::relay::store::LaunchGate;

impl Core {
    /// Registers launched agent `name` at relaygate `gate_url` with its
    /// launch's one-time `credential`, which is spent here whatever the
    /// answer and dropped before this returns. The registration is bound to
    /// the launch (`invocation_id`) and replaces any earlier one of the
    /// name. A refusal or a failed call is the launch's failure: its reason
    /// names relaygate's code and holds no secret.
    pub(crate) async fn register_launch_at_gate(
        &self,
        gate_url: &str,
        name: &str,
        invocation_id: &str,
        credential: Secret,
    ) -> Result<(), String> {
        let registered = gate_register_launch(gate_url, &credential, name).await;
        drop(credential);
        let issued = registered.map_err(|error| launch_refusal(&error, name))?;
        let gate = GateEnrolment::launched(chrono::Utc::now(), issued.expires_at);
        let lock = self.gate_locks.get(name);
        let _renewals = lock.lock().await;
        self.store.launch_gates(|gates| {
            gates.0.insert(
                name.to_owned(),
                LaunchGate {
                    invocation_id: invocation_id.to_owned(),
                    gate_url: gate_url.to_owned(),
                    agent_id: issued.agent_id,
                    token: issued.token,
                    gate,
                },
            )
        });
        self.forget_gate_renewal(name);
        Ok(())
    }

    /// Ends launched agent `name`'s relaygate registration, if it has one
    /// made for launch `invocation_id`: it is dropped here, then deleted at
    /// the gate with its own token (`DELETE /v1/agent`), best effort. A
    /// later launch of the same name keeps its own. A failed delete is
    /// reported without the token; the registration expires at the gate
    /// with it.
    pub(crate) async fn release_launch_gate(&self, name: &str, invocation_id: &str) {
        self.release_launch_gate_unless(name, invocation_id, None)
            .await;
    }

    /// Like [`Core::release_launch_gate`] for a launch whose process ended,
    /// except while agent `agent_id` still owes an automatic answer: that
    /// answer goes out with this registration, which is then kept until the
    /// agent leaves. Decided under the gate lock an answer's send holds, so
    /// a send whose claim is then released (a refused token) is seen as
    /// still owed.
    pub(crate) async fn release_ended_launch_gate(
        &self,
        name: &str,
        invocation_id: &str,
        agent_id: &str,
    ) {
        self.release_launch_gate_unless(name, invocation_id, Some(agent_id))
            .await;
    }

    async fn release_launch_gate_unless(
        &self,
        name: &str,
        invocation_id: &str,
        owing: Option<&str>,
    ) {
        let lock = self.gate_locks.get(name);
        let _renewals = lock.lock().await;
        if let Some(agent_id) = owing {
            let owes_answer = self.store.read(|store| {
                store
                    .replies
                    .iter()
                    .flatten()
                    .any(|reply| reply.agent_id == agent_id && reply.claimed != Some(true))
            });
            if owes_answer {
                return;
            }
        }
        let Some(launched) = self.store.launch_gates(|gates| match gates.0.get(name) {
            Some(held) if held.invocation_id == invocation_id => gates.0.remove(name),
            _ => None,
        }) else {
            return;
        };
        self.forget_gate_renewal(name);
        if let Err(error) = gate_delete_self(&launched.gate_url, &launched.token).await {
            self.hub.activity(
                Level::Warning,
                format!("@{name} could not be released at relaygate: {error}. It expires there with its token."),
            );
        }
    }

    /// Renews launched agent `name`'s registration with a refresh of its
    /// current `token`, which relaygate revokes at once. A refresh refused,
    /// or failed after the token expired, ends the registration: it is
    /// dropped, and the agent needs a relaunch.
    ///
    /// The caller holds `name`'s entry in [`Core::gate_locks`].
    pub(super) async fn refresh_launch_gate(
        &self,
        name: &str,
        gate_url: &str,
        token: &Secret,
        gate: &GateEnrolment,
    ) -> Renewal {
        let refreshed = match gate_refresh(gate_url, token).await {
            Ok(refreshed) => refreshed,
            Err(error) => {
                let expired = chrono::DateTime::parse_from_rfc3339(&gate.expires_at)
                    .map(|at| at <= chrono::Utc::now())
                    .unwrap_or(true);
                if expired || matches!(error, GateError::Unauthenticated) {
                    self.store.launch_gates(|gates| {
                        if gates.0.get(name).is_some_and(|held| held.token == *token) {
                            gates.0.remove(name);
                        }
                    });
                    self.renewal_failed(
                        name,
                        format!("@{name}: its relaygate registration could not be refreshed ({error}) and has ended. Relaunch the agent."),
                        None,
                        true,
                    );
                    return Renewal::Stopped;
                }
                let wait = match &error {
                    GateError::RateLimited { retry_after }
                    | GateError::Unavailable { retry_after } => retry_after.unwrap_or(RENEW_RETRY),
                    _ => RENEW_RETRY,
                };
                self.renewal_failed(
                    name,
                    format!("@{name}: could not refresh its relaygate registration: {error}."),
                    Some(wait),
                    false,
                );
                return Renewal::NotRenewed;
            }
        };
        let enrolment = GateEnrolment::launched(chrono::Utc::now(), refreshed.expires_at);
        let kept = self
            .store
            .launch_gates(|gates| match gates.0.get_mut(name) {
                Some(held) if held.token == *token => {
                    held.token = refreshed.token.clone();
                    held.gate = enrolment;
                    true
                }
                _ => false,
            });
        if !kept {
            // Released or replaced while the refresh ran: the agent it
            // reached answers only to the token just issued.
            let _ = gate_delete_self(gate_url, &refreshed.token).await;
            return Renewal::NotRenewed;
        }
        self.gate_renewals.lock().unwrap().errors.remove(name);
        // The push channel restarts with the new token.
        self.sync_agents().await;
        self.hub.invalidated(Listing::Agents);
        Renewal::Renewed
    }
}

/// Why registering launched agent `name` at relaygate failed, as the
/// spawn's error: relaygate's code and what it means, never a secret.
fn launch_refusal(error: &GateError, name: &str) -> String {
    let (prefix, code, why) = match error {
        GateError::Unauthenticated => (
            "spawn_failed",
            GATE_UNAUTHENTICATED,
            "relaygate did not accept the launch credential (it expired or was used already)"
                .to_owned(),
        ),
        GateError::Refused { code } if code == GATE_NAME_SCOPE => (
            "spawn_failed",
            GATE_NAME_SCOPE,
            "the name is outside the names relaygate allows this person".to_owned(),
        ),
        GateError::Refused { .. } => (
            "spawn_failed",
            GATE_DENIED,
            "relaygate's policy does not allow this person to launch the agent".to_owned(),
        ),
        GateError::NameTaken => (
            "spawn_agent_name_in_use",
            GATE_NAME_TAKEN,
            "another person holds the name at relaygate".to_owned(),
        ),
        GateError::Unavailable { .. } => (
            "spawn_failed",
            GATE_UNAVAILABLE,
            "relaygate is unavailable".to_owned(),
        ),
        GateError::RateLimited { .. } => (
            "spawn_failed",
            "rate_limited",
            "relaygate is rate limiting requests".to_owned(),
        ),
        GateError::Invalid(what) => ("spawn_failed", "invalid_request", (*what).to_owned()),
        GateError::Other(inner) => (
            "spawn_failed",
            "unreachable",
            format!("could not register at relaygate: {inner}"),
        ),
    };
    format!("{prefix}: relaygate did not register @{name} ({code}): {why}. The launch credential is spent; spawn the agent again.")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each register error names relaygate's code and holds no secret.
    #[test]
    fn a_register_error_names_its_code() {
        let cases = [
            (
                GateError::Unauthenticated,
                "spawn_failed:",
                GATE_UNAUTHENTICATED,
            ),
            (
                GateError::Refused {
                    code: GATE_DENIED.into(),
                },
                "spawn_failed:",
                GATE_DENIED,
            ),
            (
                GateError::Refused {
                    code: GATE_NAME_SCOPE.into(),
                },
                "spawn_failed:",
                GATE_NAME_SCOPE,
            ),
            (
                GateError::NameTaken,
                "spawn_agent_name_in_use:",
                GATE_NAME_TAKEN,
            ),
            (
                GateError::Unavailable { retry_after: None },
                "spawn_failed:",
                GATE_UNAVAILABLE,
            ),
        ];
        for (error, prefix, code) in cases {
            let reason = launch_refusal(&error, "lc1");
            assert!(reason.starts_with(prefix), "{reason}");
            assert!(reason.contains(&format!("({code})")), "{reason}");
            assert!(reason.contains("@lc1"), "{reason}");
            assert!(
                !reason.contains("sh_lt_") && !reason.contains("rg_"),
                "{reason}"
            );
        }
    }
}
