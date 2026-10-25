//! Registering a spawn's agent on the node, and spawns whose
//! `agent.register` went unanswered: the answer came late, the reply was
//! unreadable, or the spawn was cancelled or the core stopped while it
//! waited. Relaycast may still have registered the agent, holding its name
//! and a place on the node, with no id here to take it off by.
//!
//! A late answer is waited for, first by the spawn, which then launches
//! the agent it names, then by a settler once the spawn gave up; without
//! one, Relaycast is asked for the agent by name, and it is taken as this
//! spawn's only when Relaycast stamped it with the same invocation
//! (`metadata.fleet`), so an agent of the same name elsewhere is never
//! touched. Registering again
//! cannot find it: Relaycast refuses a name already taken. A retry of the
//! invocation that meets that refusal frees the name the same way.

use super::intents::{self, InFlight, Intent};
use super::invoke::{deregistered, register_error, unsaved_intent, SpawnError, REGISTER_TIMEOUT};
use super::ledger::Ledger;
use super::node::{Asked, NodeLink};
use super::wire;
use crate::relay::daemon::Core;
use crate::relay::sdk_gaps;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

/// How much longer a register's answer is waited for past its timeout: by
/// the spawn, which then goes on with the agent, and again by the settler
/// once the spawn gave up.
const LATE_ANSWER: Duration = Duration::from_secs(30);

const LATE: &str = "spawn_failed: Agent Relay did not register the agent in time";

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

/// Registers the spawn's agent on the node first: Relaycast stamps the
/// invocation onto the agent, which is how Cloud knows the spawn is the one
/// it asked for. A name Relaycast says is taken by this invocation's own
/// agent (an earlier attempt whose answer was lost) is taken off the node
/// and registered again, once. What may be registered without an answer is
/// left in `left`, to be settled once the spawn has given its place back.
pub(super) async fn register(
    link: &NodeLink,
    in_flight: &mut InFlight,
    left: &mut Option<(Intent, Unanswered)>,
    general: bool,
) -> Result<wire::RegisteredAgent, SpawnError> {
    let mut freed = false;
    loop {
        let refusal = match register_once(link, in_flight, general).await {
            Ok(agent) => return Ok(agent),
            Err(Failed::NotSent(error)) => {
                // Nothing is left to recover.
                let _ = in_flight.update(|intent| intent.register_sent = false);
                return Err(error);
            }
            Err(Failed::Unknown(how, error)) => {
                *left = Some((in_flight.intent.clone(), how));
                return Err(error.into());
            }
            Err(Failed::Refused(refusal)) => refusal,
        };
        let error = register_error(&refusal.code, &refusal.message);
        if error.starts_with("spawn_agent_name_in_use") {
            match registered_for(&in_flight.intent).await {
                // Another agent's: the name is taken.
                Ok(None) => {}
                Ok(Some(agent_id))
                    if !freed && deregistered(link, &agent_id, &in_flight.intent.name).await =>
                {
                    freed = true;
                    continue;
                }
                // This invocation's agent still holds it, or Relaycast
                // could not be asked: settled later.
                _ => {
                    *left = Some((in_flight.intent.clone(), Unanswered::Lost));
                    return Err(error.into());
                }
            }
        }
        // Nothing was registered: nothing is left to recover.
        let _ = in_flight.update(|intent| intent.register_sent = false);
        return Err(error.into());
    }
}

async fn register_once(
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
    // Under database pressure Relaycast's node answers past the timeout: it
    // retries a pressured write for longer, and one already started
    // finishes late. The spawn waits `LATE_ANSWER` more for that answer, a
    // late `d1_pressure` included, and goes on with the agent it
    // registered, rather than failing and taking it off.
    let reply = match link
        .request_answer(&id, frame, REGISTER_TIMEOUT, LATE_ANSWER)
        .await
    {
        Asked::Answered(reply) => reply,
        Asked::NotSent => return Err(Failed::NotSent(LATE.into())),
        Asked::Closed => return Err(Failed::Unknown(Unanswered::Lost, LATE)),
        Asked::Late(answer) => return Err(Failed::Unknown(Unanswered::Waiting(answer, id), LATE)),
    };
    match wire::reply_to(&reply, &id) {
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

impl Core {
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
        let agent_id = agent_id.filter(|_| !self.saved(&intent));
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
            return;
        }
        if let (Some(ended), Some(agent_id)) = (ended, agent_id) {
            super::recover::deregister(link, app_data_dir, agent_id, ended);
        }
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
    let http = sdk_gaps::http(&intent.base_url, &intent.workspace_key).map_err(drop)?;
    let agent = sdk_gaps::get_agent(&http, &intent.name)
        .await
        .map_err(drop)?;
    Ok(agent.as_ref().and_then(|agent| stamped_for(agent, intent)))
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
