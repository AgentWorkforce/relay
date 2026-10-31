//! Registering a spawn's agent on the node, and spawns whose
//! `agent.register` went unanswered: the answer came late, the reply was
//! unreadable, or the spawn was cancelled or the core stopped while it
//! waited. Relaycast may still have registered the agent, holding its name
//! and a place on the node, with no id here to take it off by.
//!
//! A late answer is waited for (`LATE_ANSWER` past the register's timeout),
//! and the spawn goes on with the agent it names. Without one, Relaycast is
//! asked for the agent by name, and one it stamped with the same invocation
//! (`metadata.fleet`) is taken over (`agent.recover`) and the spawn goes on.
//! Otherwise the spawn fails saying Relaycast did not answer, a settler
//! waits for the answer a while longer, and then the agent is looked for
//! the same way and taken off the node, so an agent of the same name
//! elsewhere is never touched.
//!
//! Taking an agent off the node does not free its name: Relaycast refuses to
//! register a name an agent holds, however it ended, and points to
//! `agent.recover`, which only the node the agent was registered on may use.
//! So a spawn whose register meets that refusal takes the agent over when it
//! is this node's and was left by this invocation or by a spawn of that name
//! that failed here (its receipt says so), and no spawn here holds it.

use super::completions::Scope;
use super::intents::{self, InFlight, Intent};
use super::invoke::{register_error, unsaved_intent, SpawnError, REGISTER_TIMEOUT};
use super::ledger::Ledger;
use super::node::{Asked, NodeLink};
use super::wire;
use crate::relay::daemon::Core;
use crate::relay::sdk_gaps;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

/// How long Relaycast gets to say whether it holds an agent.
const LOOKUP: Duration = Duration::from_secs(10);

/// How much longer a register's answer is waited for past its timeout: by
/// the spawn, which then goes on with the agent, and again by the settler
/// once the spawn gave up.
const LATE_ANSWER: Duration = Duration::from_secs(30);

// What `UNANSWERED` says.
const _: () = assert!(REGISTER_TIMEOUT.as_secs() + LATE_ANSWER.as_secs() == 40);

/// No answer to the register: Relaycast may still register the agent,
/// which is then taken off the node, and a retry of the name takes it over.
const UNANSWERED: &str = "spawn_failed: Relaycast did not answer the request to register the agent within 40 seconds (it may be under load). If Relaycast registers it later, Agent Relay takes it off the node, so retrying the spawn with the same name is safe.";

/// The connection ended while the register waited for its answer.
const CLOSED: &str = "spawn_failed: the connection to Relaycast closed before Relaycast answered the request to register the agent. If Relaycast registered it, Agent Relay takes it off the node, so retrying the spawn with the same name is safe.";

/// The connection ended before the register was sent.
const NOT_SENT: &str = "spawn_failed: the connection to Relaycast closed before Agent Relay could ask it to register the agent. Nothing was registered, so retrying the spawn is safe.";

/// How long after Relaycast first says it holds no agent for an unanswered
/// register it is asked once more: a write it admitted can still land after
/// the connection that sent it closed.
const LOOKUP_GRACE: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 30 });

/// What is known of an unanswered register.
pub(super) enum Unanswered {
    /// The spawn gave up waiting for `id`'s answer, which may still come.
    Waiting(oneshot::Receiver<Value>, String),
    /// No answer will come on this connection.
    Lost,
}

/// One attempt being settled; given back when dropped, however its settler
/// ends.
struct Settling {
    ledger: Arc<Ledger>,
    attempt: (String, String),
}

impl Drop for Settling {
    fn drop(&mut self) {
        self.ledger.lock().settling.remove(&self.attempt);
    }
}

/// How a register ended other than with an agent.
enum Failed {
    /// Not sent: nothing was registered.
    NotSent(SpawnError),
    Refused(wire::Refusal),
    /// An agent may be registered; the spawn fails with the message.
    Unknown(Unanswered, &'static str),
}

impl Core {
    /// Registers the spawn's agent on the node first: Relaycast stamps the
    /// invocation onto the agent, which is how Cloud knows the spawn is the
    /// one it asked for. A name Relaycast says is taken by an agent this node
    /// left (an earlier attempt whose answer was lost, or a spawn of the
    /// name that failed here) is taken over. What may be registered without
    /// an answer is left in `left`, to be settled once the spawn has given
    /// its place back.
    pub(super) async fn register(
        &self,
        link: &NodeLink,
        in_flight: &mut InFlight,
        left: &mut Option<(Intent, Unanswered)>,
        general: bool,
    ) -> Result<wire::RegisteredAgent, SpawnError> {
        let refusal = match self.register_once(link, in_flight, general).await {
            Ok(agent) => return Ok(agent),
            Err(failed) => refused(in_flight, left, failed)?,
        };
        let error = register_error(&refusal.code, &refusal.message);
        if error.starts_with("spawn_agent_name_in_use") {
            match self.left_holding(link, &in_flight.intent).await {
                Ok(Some((agent_id, invocation))) => {
                    match self
                        .recover_left(link, in_flight, &agent_id, &invocation)
                        .await
                    {
                        Ok(agent) => return Ok(agent),
                        // Refused: the name stays taken. This invocation's
                        // own agent is still taken off the node later.
                        Err(failed) => {
                            refused(in_flight, left, failed)?;
                            if invocation == in_flight.intent.invocation_id {
                                *left = Some((in_flight.intent.clone(), Unanswered::Lost));
                                return Err(error.into());
                            }
                        }
                    }
                }
                Ok(None) => {}
                // Relaycast could not be asked: this invocation's own agent
                // may hold the name, settled later.
                Err(()) => {
                    *left = Some((in_flight.intent.clone(), Unanswered::Lost));
                    return Err(error.into());
                }
            }
        }
        // Nothing was registered: nothing is left to recover.
        let _ = in_flight.update(|intent| intent.register_sent = false);
        Err(error.into())
    }

    async fn register_once(
        &self,
        link: &NodeLink,
        in_flight: &mut InFlight,
        general: bool,
    ) -> Result<wire::RegisteredAgent, Failed> {
        // Recorded before it is sent, so a restart looks for what it left.
        if let Err(error) = in_flight.update(|intent| intent.register_sent = true) {
            in_flight.intent.register_sent = false;
            return Err(Failed::NotSent(unsaved_intent("spawn", &error).into()));
        }
        let id = format!("agent_register_{}", crate::relay::store::random_uuid());
        let intent = &in_flight.intent;
        let frame = wire::agent_register(
            &id,
            &intent.name,
            &intent.invocation_id,
            &super::session_ref(&intent.invocation_id),
            general,
        );
        match answer(link, &id, frame).await {
            // Relaycast registered it and the answer was lost or is still
            // coming: taken over, and the answer no longer waited for.
            Err(Failed::Unknown(Unanswered::Waiting(late, id), error)) => {
                match tokio::time::timeout(LOOKUP, registered_for(intent)).await {
                    Ok(Ok(Some(agent_id))) => {
                        link.forget_request(&id);
                        let invocation = intent.invocation_id.clone();
                        match self
                            .recover_left(link, in_flight, &agent_id, &invocation)
                            .await
                        {
                            Ok(agent) => Ok(agent),
                            Err(Failed::Unknown(how, error)) => Err(Failed::Unknown(how, error)),
                            // Not taken over: the agent Relaycast registered
                            // is still this spawn's, settled later.
                            Err(_) => Err(Failed::Unknown(Unanswered::Lost, error)),
                        }
                    }
                    _ => Err(Failed::Unknown(Unanswered::Waiting(late, id), error)),
                }
            }
            answered => registered(answered?, &id),
        }
    }

    /// Takes over `agent_id`, which this node registered for `invocation`
    /// and left: Relaycast stamps it with this spawn's invocation and gives
    /// it a new token. Its earlier spawn's settling leaves it alone.
    async fn recover_left(
        &self,
        link: &NodeLink,
        in_flight: &InFlight,
        agent_id: &str,
        invocation: &str,
    ) -> Result<wire::RegisteredAgent, Failed> {
        let ledger = self.ledger();
        {
            let mut state = ledger.lock();
            // Checked with the claim, so a settler taking it off the node
            // and this takeover never both go ahead (`claim_deregister`).
            if state.is_deregistering(agent_id) {
                return Err(Failed::Refused(wire::Refusal {
                    code: "agent_already_exists".into(),
                    message: format!(
                        "Agent \"{}\" is still being taken off the node",
                        in_flight.intent.name
                    ),
                }));
            }
            state
                .adopted
                .insert(agent_id.to_string(), in_flight.intent.invocation_id.clone());
        }
        let id = format!("agent_recover_{}", crate::relay::store::random_uuid());
        let intent = &in_flight.intent;
        let frame = wire::agent_recover(
            &id,
            &intent.name,
            agent_id,
            &intent.invocation_id,
            &super::session_ref(&intent.invocation_id),
        );
        let adopted = match answer(link, &id, frame).await {
            Ok(reply) => registered(reply, &id),
            Err(failed) => Err(failed),
        };
        match &adopted {
            Ok(_) if invocation != intent.invocation_id => {
                // The earlier spawn's records no longer stand for it.
                let _ = intents::forget(&self.config.app_data_dir, |kept| {
                    kept.invocation_id == invocation
                        && kept.agent_id.as_deref().is_none_or(|kept| kept == agent_id)
                        && (kept.agent_id.is_none() || kept.ended)
                });
            }
            Ok(_) => {}
            // Not known to be taken over, of an earlier spawn whose settler
            // may have left it to this takeover: if Relaycast never applies
            // it, the agent still carries that spawn's invocation, which no
            // settler looks for, so it is taken off the node by its id here,
            // out of reach of a takeover until Relaycast answers. Applied
            // later, it carries this one's, and this settler finds it.
            Err(Failed::Unknown(..)) if invocation != intent.invocation_id => {
                {
                    let mut state = ledger.lock();
                    state.adopted.remove(agent_id);
                    state.claim_deregistering(agent_id);
                }
                let (link, agent_id, name) =
                    (link.clone(), agent_id.to_string(), intent.name.clone());
                tokio::spawn(async move {
                    super::recover::take_off(&link, &ledger, &agent_id, &name).await;
                });
            }
            // Not taken over, or not known to be: no spawn here holds the
            // agent (a mark left before is stale, as `holds` let this
            // takeover go ahead), so either attempt's settler may take it
            // off the node: this one's finds it once Relaycast stamped it
            // with this invocation, the earlier one's while it carries its.
            Err(_) => {
                ledger.lock().adopted.remove(agent_id);
            }
        }
        adopted
    }

    /// The agent holding `intent`'s name, with the invocation it was
    /// registered for, when this node left it: registered here for this
    /// invocation, or for a spawn of the name whose receipt here says it
    /// failed, and no spawn here holds it. `Err` when Relaycast could not
    /// be asked.
    async fn left_holding(
        &self,
        link: &NodeLink,
        intent: &Intent,
    ) -> Result<Option<(String, String)>, ()> {
        let holder = tokio::time::timeout(LOOKUP, holder(intent))
            .await
            .map_err(drop)??;
        let Some(holder) = holder else {
            return Ok(None);
        };
        let fleet = &holder["metadata"]["fleet"];
        let (Some(agent_id), Some(invocation)) = (
            holder["id"].as_str().filter(|id| !id.is_empty()),
            fleet["invocation_id"].as_str().filter(|id| !id.is_empty()),
        ) else {
            return Ok(None);
        };
        let ours = fleet["node_id"].as_str() == Some(link.node.node_id.as_str())
            && (invocation == intent.invocation_id || self.failed_here(&intent.name, invocation))
            && !self.holds(agent_id);
        Ok(ours.then(|| (agent_id.to_string(), invocation.to_string())))
    }

    /// Whether this computer's receipt for `invocation` says its spawn of
    /// `name` failed.
    fn failed_here(&self, name: &str, invocation: &str) -> bool {
        self.workspace().is_some_and(|workspace| {
            Scope::workspace(&workspace)
                .load(&self.config.app_data_dir, invocation)
                .ok()
                .flatten()
                .is_some_and(|receipt| receipt.failed_as(name))
        })
    }

    /// Whether a spawn here holds `agent_id`, kept or still to be settled:
    /// saved, starting, being released, cleaned up or taken off the node,
    /// or left running. One
    /// a spawn took over that failed since is free to take over again.
    fn holds(&self, agent_id: &str) -> bool {
        if self.spawned(agent_id) {
            return true;
        }
        let held = {
            let ledger = self.ledger();
            let state = ledger.lock();
            state.is_deregistering(agent_id)
                || state
                    .releasing
                    .values()
                    .any(|releasing| releasing.listed.1.agent_id == agent_id)
                || state
                    .failed
                    .values()
                    .any(|cleanup| cleanup.intent.agent_id.as_deref() == Some(agent_id))
        };
        held || intents::load(&self.config.app_data_dir)
            .iter()
            .any(|kept| kept.agent_id.as_deref() == Some(agent_id) && !kept.ended)
    }

    /// Whether `agent_id` is a spawn's here: saved, starting or left
    /// running.
    fn spawned(&self, agent_id: &str) -> bool {
        let in_ledger = {
            let ledger = self.ledger();
            let state = ledger.lock();
            state
                .starting
                .values()
                .any(|(_, agent)| agent.agent_id == agent_id)
                || state
                    .unsaved
                    .values()
                    .any(|unsaved| unsaved.listed.1.agent_id == agent_id)
        };
        in_ledger
            || self
                .store
                .read(|store| store.registrations.iter().any(|r| r.agent_id == agent_id))
    }

    /// Settles the spawn of `intent`, whose register went unanswered, in
    /// the background. Called by the spawn that gave up, and by recovery on
    /// the next connection for one a stopped core left (`Unanswered::Lost`).
    /// One settler at a time per attempt: a recovery while the spawn's own
    /// settler still waits leaves it to that one, so one that missed the
    /// agent never removes the intent another is about to end it by.
    pub(super) fn settle_unanswered(&self, link: NodeLink, intent: Intent, unanswered: Unanswered) {
        let ledger = self.ledger();
        let attempt = (intent.invocation_id.clone(), intent.session_id.clone());
        if !ledger.lock().settling.insert(attempt.clone()) {
            if let Unanswered::Waiting(_, id) = &unanswered {
                link.forget_request(id);
            }
            return;
        }
        let settling = Settling { ledger, attempt };
        let core = self.me.clone();
        tokio::spawn(async move {
            let _settling = settling;
            let answered = match unanswered {
                Unanswered::Waiting(answer, id) => late_answer(&link, answer, &id).await,
                Unanswered::Lost => None,
            };
            let agent_id = match answered {
                Some(Ok(agent_id)) => Some(agent_id),
                // Refused: nothing was registered.
                Some(Err(())) => None,
                None => match registered_for(&intent).await {
                    Ok(Some(found)) => Some(found),
                    // None yet: one Relaycast admitted may still be landing,
                    // so it is asked again before the intent goes.
                    Ok(None) => {
                        tokio::time::sleep(LOOKUP_GRACE).await;
                        match registered_for(&intent).await {
                            Ok(found) => found,
                            Err(()) => return,
                        }
                    }
                    // Relaycast could not be asked: the next connection asks.
                    Err(()) => return,
                },
            };
            if let Some(core) = core.upgrade() {
                core.end_unanswered(link, intent, agent_id);
            }
        });
    }

    /// Claims `agent_id` to take off the node for `invocation`'s settler,
    /// unless another invocation here took it over: one lock for both, so
    /// a takeover never follows a claim.
    pub(super) fn claim_deregister(&self, agent_id: &str, invocation: &str) -> bool {
        let ledger = self.ledger();
        let mut state = ledger.lock();
        if state
            .adopted
            .get(agent_id)
            .is_some_and(|by| by != invocation)
        {
            return false;
        }
        state.claim_deregistering(agent_id);
        true
    }

    /// Ends the spawn: its agent, if Relaycast holds one, is taken off the
    /// node (the intent kept, ended, until Relaycast confirms); with none,
    /// the intent goes. Left alone when the invocation started again
    /// meanwhile: a retry holding its place here, or one that wrote its own
    /// intent (every change is to this attempt's intent only, so a retry's
    /// is never erased). A retry already saved holds the name with its own
    /// agent, which is never taken off; only this attempt's intent goes.
    fn end_unanswered(&self, link: NodeLink, intent: Intent, agent_id: Option<String>) {
        if self
            .ledger()
            .lock()
            .reserved
            .contains(&intent.invocation_id)
        {
            return;
        }
        // An agent a spawn here took over, or holds, is that spawn's.
        let agent_id = agent_id.filter(|agent_id| {
            !self.saved(&intent)
                && !self.spawned(agent_id)
                && self.claim_deregister(agent_id, &intent.invocation_id)
        });
        let app_data_dir = self.config.app_data_dir.clone();
        let unanswered =
            |kept: &Intent| kept.register_sent && kept.agent_id.is_none() && !kept.ended;
        let ended = agent_id.as_ref().map(|agent_id| Intent {
            agent_id: Some(agent_id.clone()),
            ended: true,
            ..intent.clone()
        });
        let changed = intents::change_attempt(&app_data_dir, &intent, unanswered, ended.as_ref());
        // Its agent found after its record went (no retry wrote one since):
        // recorded again, ended, so it is still taken off the node.
        let recorded = changed
            || ended
                .as_ref()
                .is_some_and(|ended| intents::put_if_absent(&app_data_dir, ended));
        if !recorded {
            if let Some(agent_id) = &agent_id {
                self.ledger().lock().release_deregistering(agent_id);
            }
            return;
        }
        if let (Some(ended), Some(agent_id)) = (ended, agent_id) {
            super::recover::deregister_claimed(link, self.ledger(), app_data_dir, agent_id, ended);
        }
    }
}

/// How a register or takeover ended without an agent: the refusal to go
/// on with, or the spawn's error, with what may be registered in `left`.
fn refused(
    in_flight: &mut InFlight,
    left: &mut Option<(Intent, Unanswered)>,
    failed: Failed,
) -> Result<wire::Refusal, SpawnError> {
    match failed {
        Failed::Refused(refusal) => Ok(refusal),
        Failed::NotSent(error) => {
            // Nothing is left to recover.
            let _ = in_flight.update(|intent| intent.register_sent = false);
            Err(error)
        }
        Failed::Unknown(how, error) => {
            *left = Some((in_flight.intent.clone(), how));
            Err(error.into())
        }
    }
}

/// Sends a register or takeover, `id`, and waits for its answer, a slow
/// one too. `Unknown` when none came: Relaycast may still act on it.
async fn answer(link: &NodeLink, id: &str, frame: Value) -> Result<Value, Failed> {
    // Under database pressure Relaycast's node answers past the timeout: it
    // retries a pressured write for longer, and one already started
    // finishes late. The answer is waited for `LATE_ANSWER` more, a late
    // `d1_pressure` included.
    match link
        .request_answer(id, frame, REGISTER_TIMEOUT, LATE_ANSWER)
        .await
    {
        Asked::Answered(reply) => Ok(reply),
        Asked::NotSent => Err(Failed::NotSent(NOT_SENT.into())),
        Asked::Closed => Err(Failed::Unknown(Unanswered::Lost, CLOSED)),
        Asked::Late(late) => Err(Failed::Unknown(
            Unanswered::Waiting(late, id.to_string()),
            UNANSWERED,
        )),
    }
}

/// The agent a register or takeover answered with.
fn registered(reply: Value, id: &str) -> Result<wire::RegisteredAgent, Failed> {
    match wire::reply_to(&reply, id) {
        Some(Ok(data)) => wire::registered_agent(data).ok_or(Failed::Unknown(
            Unanswered::Lost,
            "spawn_failed: Agent Relay registered the agent without a token",
        )),
        Some(Err(refusal)) => Err(Failed::Refused(refusal)),
        None => Err(Failed::Unknown(
            Unanswered::Lost,
            "spawn_failed: Agent Relay sent an unreadable answer",
        )),
    }
}

/// The register's answer, if it comes in time: the agent id it registered,
/// or `Err` for a refusal. `None` when none came or it was unreadable.
async fn late_answer(
    link: &NodeLink,
    answer: oneshot::Receiver<Value>,
    id: &str,
) -> Option<Result<String, ()>> {
    let Ok(Ok(reply)) = tokio::time::timeout(LATE_ANSWER, answer).await else {
        link.forget_request(id);
        return None;
    };
    match wire::reply_to(&reply, id)? {
        Ok(data) => data["agent_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(|id| Ok(id.to_string())),
        Err(_) => Some(Err(())),
    }
}

/// The id of the agent Relaycast registered for `intent`, if any: the agent
/// of its name stamped with its invocation. `Err` when Relaycast could not
/// be asked.
async fn registered_for(intent: &Intent) -> Result<Option<String>, ()> {
    let agent = holder(intent).await?;
    Ok(agent.as_ref().and_then(|agent| stamped_for(agent, intent)))
}

/// The agent holding `intent`'s name, as Relaycast has it. `Err` when
/// Relaycast could not be asked.
async fn holder(intent: &Intent) -> Result<Option<Value>, ()> {
    let http = sdk_gaps::http(&intent.base_url, &intent.workspace_key).map_err(drop)?;
    sdk_gaps::get_agent(&http, &intent.name).await.map_err(drop)
}

/// The agent's id when Relaycast stamped it with `intent`'s invocation.
fn stamped_for(agent: &Value, intent: &Intent) -> Option<String> {
    (agent["metadata"]["fleet"]["invocation_id"].as_str() == Some(&intent.invocation_id))
        .then(|| agent["id"].as_str().map(str::to_string))
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_an_agent_stamped_with_the_invocation_is_the_spawns() {
        let intent = intents::tests::intent("w1");
        let agent = |invocation: &str| {
            json!({"id": "agent_w1", "name": "w1",
                "metadata": {"fleet": {"node_id": "node_desktop_1", "invocation_id": invocation}}})
        };
        assert_eq!(
            stamped_for(&agent("inv_w1"), &intent).as_deref(),
            Some("agent_w1")
        );
        assert_eq!(stamped_for(&agent("inv_other"), &intent), None);
        assert_eq!(
            stamped_for(&json!({"id": "agent_w1", "name": "w1"}), &intent),
            None
        );
    }
}
