//! Local consent for Relaycast deliveries into Claude Code terminal sessions.
//!
//! Claude Code's `crossSessionInbound` is login-wide. This policy sits one
//! layer earlier, before Agent Relay writes to a particular session's inbox:
//! a person may require known senders, put one session in Ask first, and
//! approve or dismiss individual held deliveries.
//!
//! An organization's workspace policy may hold messages too
//! (`delivery.inbound_default: "hold"`, locked): then a message from a
//! sender who is not one of the organization's admins (`admin_senders`, by
//! name or address) is held in **every** harness, not only Claude Code's,
//! and an admin's message always delivers. The person still approves or
//! dismisses each held message, but cannot allow a sender for good while the
//! rule applies; exceptions made before it stay saved and apply again once
//! it is lifted. The rule is the account's, kept in memory and given again
//! on every policy apply (`Core::apply_settings_policy`).

use crate::platform::fs as private_fs;
use crate::relay::contract::claude_delivery::{
    ClaudeDeliverySession, ClaudeDeliveryStatus, ClaudeHeldDelivery, ClaudeSender,
};
use crate::relay::delivery::policy::{with_attachments, Delivery};
use crate::relay::store::{Registration, SessionKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE: &str = "claude-delivery-policy.json";
const KEPT_DECISIONS: usize = 1_000;
const KEPT_HELD: usize = 1_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Held {
    id: String,
    agent: String,
    session_id: String,
    sender: String,
    sender_name: String,
    text: String,
    held_at_ms: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
    workspace: Option<String>,
    restricted: bool,
    ask_first_sessions: BTreeSet<String>,
    allowed_senders: BTreeMap<String, String>,
    held: BTreeMap<String, Held>,
    approved: BTreeSet<String>,
    dismissed: BTreeSet<String>,
    consumed: BTreeMap<String, PriorOutcome>,
    decision_agents: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "reason", rename_all = "snake_case")]
pub enum PriorOutcome {
    Delivered,
    InDoubt,
    Refused(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Deliver,
    Hold,
    Dismiss,
    /// Injection already completed, but its main-store marker was not made
    /// durable. Restore that marker without putting the message in the
    /// session again.
    Handled(PriorOutcome),
    /// The push frame omitted the canonical sender address. Read the queue,
    /// whose complete record carries it, before applying sender policy.
    ReadQueue,
}

/// The refusal of a persistent sender exception while the organization
/// holds messages.
pub const ORGANIZATION_HOLD_REFUSAL: &str =
    "Your organization holds messages from senders who are not its admins, so a sender cannot be allowed for good. Approve each message instead.";

/// Why the organization held a message, as its delivery record says.
pub const ORGANIZATION_HOLD_REASON: &str =
    "Held by your organization: the sender is not one of its admins. Waiting for your approval in Agent Relay.";

/// The policy file is installation-local and contains no credentials.
pub struct ClaudeDeliveryPolicy {
    path: PathBuf,
    saved: Mutex<Saved>,
    /// The organization's admins, by name and address, while it holds every
    /// other sender's messages; `None` when it does not.
    organization: Mutex<Option<BTreeSet<String>>>,
    /// Each (organization holds, person restricts) state after a change, for
    /// tests of the order changes are made in.
    #[cfg(test)]
    pub(crate) states: Mutex<Vec<(bool, bool)>>,
}

impl ClaudeDeliveryPolicy {
    pub fn open(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join(FILE);
        let fail_closed = || Saved {
            restricted: true,
            ..Saved::default()
        };
        let saved = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| fail_closed()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(_) => fail_closed(),
        };
        Self {
            path,
            saved: Mutex::new(saved),
            organization: Mutex::new(None),
            #[cfg(test)]
            states: Mutex::new(Vec::new()),
        }
    }

    #[cfg(test)]
    fn note_state(&self) {
        let state = (self.organization_holds(), self.restricted());
        self.states.lock().unwrap().push(state);
    }

    /// Sets the organization's hold: `Some(admins)` holds every message from
    /// a sender not among `admins` (names or addresses), in every harness;
    /// `None` lifts it. Answers whether it changed.
    pub fn set_organization_hold(&self, admins: Option<BTreeSet<String>>) -> bool {
        let mut current = self.organization.lock().unwrap_or_else(|p| p.into_inner());
        if *current == admins {
            return false;
        }
        *current = admins;
        drop(current);
        #[cfg(test)]
        self.note_state();
        true
    }

    /// Whether the organization holds non-admin senders' messages now.
    pub fn organization_holds(&self) -> bool {
        self.organization
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    /// Whether an injection's outcome into `registration` is recorded here
    /// (`consume`) until the main store has it, so a failed main-store write
    /// never injects it twice: always for Claude Code, and for any harness
    /// while the organization holds messages or the person approved this one.
    pub fn records_outcome(&self, registration: &Registration, id: &str) -> bool {
        registration.target.kind == SessionKind::ClaudeTerminal
            || self.organization_holds()
            || self
                .saved
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .approved
                .contains(id)
    }

    /// The person's own restriction (known senders only).
    pub fn restricted(&self) -> bool {
        self.saved
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .restricted
    }

    fn save(&self, saved: &Saved) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or("The policy path has no directory.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        private_fs::set_mode(parent, 0o700).map_err(|e| e.to_string())?;
        let temporary = self.path.with_extension("json.new");
        let bytes = serde_json::to_vec(saved).map_err(|e| e.to_string())?;
        let mut file = private_fs::private(
            fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true),
        )
        .open(&temporary)
        .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        // Closed before the rename, so no handle of this core outlives it.
        drop(file);
        fs::rename(&temporary, &self.path).map_err(|e| e.to_string())?;
        private_fs::set_mode(&self.path, 0o600).map_err(|e| e.to_string())
    }

    fn change<T>(&self, body: impl FnOnce(&mut Saved) -> T) -> Result<T, String> {
        let mut saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        let before = saved.clone();
        let answer = body(&mut saved);
        if let Err(error) = self.save(&saved) {
            *saved = before;
            return Err(error);
        }
        Ok(answer)
    }

    fn sender(delivery: &Delivery) -> (String, String) {
        let name = delivery
            .sender
            .clone()
            .unwrap_or_else(|| "Unknown sender".into());
        (delivery.sender_address.clone().unwrap_or_default(), name)
    }

    /// Selects the current Relaycast workspace without ever persisting its
    /// credential. Workspace-bound approvals and exceptions are discarded
    /// on a change; the top-level restriction preference remains local to
    /// this installation.
    pub fn use_workspace(&self, workspace: &str) -> Result<bool, String> {
        let mut saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        if saved.workspace.as_deref() == Some(workspace) {
            return Ok(false);
        }
        let restricted = saved.restricted;
        // Delivery outcomes are an installation-local at-most-once journal,
        // not a consent preference. Keep them while workspace-specific
        // allowlists, session choices and visible holds are reset.
        let consumed = std::mem::take(&mut saved.consumed);
        let mut decision_agents = std::mem::take(&mut saved.decision_agents);
        decision_agents.retain(|id, _| consumed.contains_key(id));
        *saved = Saved {
            workspace: Some(workspace.to_string()),
            restricted,
            consumed,
            decision_agents,
            ..Saved::default()
        };
        // Keep the fail-closed reset in memory even if persistence is
        // temporarily unavailable. A later policy change saves it again.
        self.save(&saved)?;
        Ok(true)
    }

    pub fn decide(&self, registration: &Registration, delivery: &Delivery) -> Decision {
        let organization = self
            .organization
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        // A dismissal, and an injection already made, stand in every
        // harness, even after the organization lifts the rule that held the
        // message: neither is undone or repeated.
        if saved.dismissed.contains(&delivery.id) {
            return Decision::Dismiss;
        }
        if let Some(outcome) = saved.consumed.get(&delivery.id) {
            return Decision::Handled(outcome.clone());
        }
        if saved.approved.contains(&delivery.id) {
            return Decision::Deliver;
        }
        if registration.target.kind != SessionKind::ClaudeTerminal && organization.is_none() {
            return Decision::Deliver;
        }
        if let Some(admins) = organization {
            // Only an authenticated address proves who sent it.
            let Some(address) = delivery.sender_address.as_deref() else {
                return Decision::ReadQueue;
            };
            let admin = admins.contains(address)
                || delivery
                    .sender
                    .as_deref()
                    .is_some_and(|name| admins.contains(name));
            // The person's own exceptions wait while the organization holds.
            return if admin {
                Decision::Deliver
            } else {
                Decision::Hold
            };
        }
        let asks_first = saved.ask_first_sessions.contains(&registration.target.id);
        let sender_restricted = saved.restricted;
        if (asks_first || sender_restricted) && delivery.sender_address.is_none() {
            return Decision::ReadQueue;
        }
        let allowed = delivery
            .sender_address
            .as_deref()
            .is_some_and(|sender| saved.allowed_senders.contains_key(sender));
        if asks_first || (sender_restricted && !allowed) {
            Decision::Hold
        } else {
            Decision::Deliver
        }
    }

    /// Remembers a newly held item. `false` means it was already shown.
    pub fn hold(&self, registration: &Registration, delivery: &Delivery) -> Result<bool, String> {
        let (sender, sender_name) = Self::sender(delivery);
        let mut saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        if saved.held.contains_key(&delivery.id) {
            return Ok(false);
        }
        let before = saved.clone();
        saved.held.insert(
            delivery.id.clone(),
            Held {
                id: delivery.id.clone(),
                agent: registration.name.clone(),
                session_id: registration.target.id.clone(),
                sender,
                sender_name,
                text: with_attachments(
                    delivery.text.clone().unwrap_or_default(),
                    &delivery.attachments,
                ),
                held_at_ms: crate::relay::state::now_ms(),
            },
        );
        trim_held(&mut saved.held);
        if let Err(error) = self.save(&saved) {
            *saved = before;
            return Err(error);
        }
        Ok(true)
    }

    pub fn approve(&self, id: &str) -> Result<Option<String>, String> {
        self.change(|saved| {
            let held = saved.held.remove(id)?;
            saved.dismissed.remove(id);
            saved.approved.insert(id.to_string());
            saved
                .decision_agents
                .insert(id.to_string(), held.agent.clone());
            trim(&mut saved.approved);
            trim_decision_agents(saved);
            Some(held.agent)
        })
    }

    pub fn dismiss(&self, id: &str) -> Result<Option<String>, String> {
        self.change(|saved| {
            let held = saved.held.remove(id)?;
            saved.approved.remove(id);
            saved.dismissed.insert(id.to_string());
            saved
                .decision_agents
                .insert(id.to_string(), held.agent.clone());
            trim(&mut saved.dismissed);
            trim_decision_agents(saved);
            Some(held.agent)
        })
    }

    /// Records the terminal outcome before the main delivery store is
    /// updated. If that independent write fails, reopening this policy still
    /// proves that the prompt must not be injected again.
    pub fn consume(&self, id: &str, agent: &str, outcome: PriorOutcome) -> Result<(), String> {
        self.change(|saved| {
            saved.consumed.insert(id.to_string(), outcome);
            saved
                .decision_agents
                .insert(id.to_string(), agent.to_string());
            while saved.consumed.len() > KEPT_DECISIONS {
                if let Some(first) = saved.consumed.keys().next().cloned() {
                    saved.consumed.remove(&first);
                    saved.decision_agents.remove(&first);
                }
            }
        })
    }

    pub fn finish(&self, id: &str) {
        let _ = self.change(|saved| {
            saved.held.remove(id);
            saved.approved.remove(id);
            saved.dismissed.remove(id);
            saved.consumed.remove(id);
            saved.decision_agents.remove(id);
        });
    }

    /// Removes approval state belonging to an agent that no longer exists.
    pub fn remove_agent(&self, agent: &str) -> Result<bool, String> {
        let mut saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        let mut ids: BTreeSet<_> = saved
            .held
            .values()
            .filter(|held| held.agent == agent)
            .map(|held| held.id.clone())
            .collect();
        ids.extend(
            saved
                .decision_agents
                .iter()
                .filter(|(_, owner)| owner.as_str() == agent)
                .map(|(id, _)| id.clone()),
        );
        if ids.is_empty() {
            return Ok(false);
        }
        let before = saved.clone();
        for id in ids {
            saved.held.remove(&id);
            saved.approved.remove(&id);
            saved.dismissed.remove(&id);
            saved.consumed.remove(&id);
            saved.decision_agents.remove(&id);
        }
        if let Err(error) = self.save(&saved) {
            *saved = before;
            return Err(error);
        }
        Ok(true)
    }

    /// The held IDs for one registration before its Relaycast queue is read.
    /// A pre-read snapshot keeps an older read from removing a message held by
    /// a push that arrived while the request was in flight.
    pub fn held_ids_for_agent(&self, agent: &str) -> BTreeSet<String> {
        self.saved
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .held
            .values()
            .filter(|held| held.agent == agent)
            .map(|held| held.id.clone())
            .collect()
    }

    /// Removes pre-existing approvals that disappeared from a successfully
    /// read Relaycast queue. The caller deliberately does not invoke this when
    /// the read fails, because absence is known only from a successful read.
    pub fn reconcile_queue(
        &self,
        held_before_read: &BTreeSet<String>,
        queued: &HashSet<&str>,
    ) -> Result<bool, String> {
        let missing: Vec<_> = held_before_read
            .iter()
            .filter(|id| !queued.contains(id.as_str()))
            .cloned()
            .collect();
        if missing.is_empty() {
            return Ok(false);
        }
        let mut saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        let before = saved.clone();
        let mut changed = false;
        for id in missing {
            changed |= saved.held.remove(&id).is_some();
            changed |= saved.approved.remove(&id);
            changed |= saved.dismissed.remove(&id);
            changed |= saved.consumed.remove(&id).is_some();
            changed |= saved.decision_agents.remove(&id).is_some();
        }
        if !changed {
            return Ok(false);
        }
        if let Err(error) = self.save(&saved) {
            *saved = before;
            return Err(error);
        }
        Ok(true)
    }

    pub fn set_restricted(&self, restricted: bool) -> Result<(), String> {
        self.change(|saved| saved.restricted = restricted)?;
        #[cfg(test)]
        self.note_state();
        Ok(())
    }

    pub fn set_session(&self, session_id: &str, direct: bool) -> Result<(), String> {
        self.change(|saved| {
            if direct {
                saved.ask_first_sessions.remove(session_id);
            } else {
                saved.ask_first_sessions.insert(session_id.to_string());
            }
        })
    }

    pub fn set_sender(&self, sender: &str, name: &str, allowed: bool) -> Result<(), String> {
        if allowed && self.organization_holds() {
            return Err(ORGANIZATION_HOLD_REFUSAL.to_string());
        }
        self.change(|saved| {
            if allowed {
                saved
                    .allowed_senders
                    .insert(sender.to_string(), name.to_string());
            } else {
                saved.allowed_senders.remove(sender);
            }
        })
    }

    pub fn status(&self, registrations: &[Registration]) -> ClaudeDeliveryStatus {
        let saved = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        let mut sessions: Vec<_> = registrations
            .iter()
            .filter(|r| r.target.kind == SessionKind::ClaudeTerminal)
            .map(|r| ClaudeDeliverySession {
                id: r.target.id.clone(),
                agent: r.name.clone(),
                title: r.title.clone(),
                direct: !saved.ask_first_sessions.contains(&r.target.id),
            })
            .collect();
        sessions.sort_by(|a, b| a.title.cmp(&b.title).then(a.agent.cmp(&b.agent)));
        ClaudeDeliveryStatus {
            restricted: saved.restricted,
            sessions,
            allowed_senders: saved
                .allowed_senders
                .iter()
                .map(|(address, name)| ClaudeSender {
                    address: address.clone(),
                    name: name.clone(),
                })
                .collect(),
            held: saved
                .held
                .values()
                .map(|held| ClaudeHeldDelivery {
                    id: held.id.clone(),
                    agent: held.agent.clone(),
                    session_id: held.session_id.clone(),
                    sender: held.sender.clone(),
                    sender_name: held.sender_name.clone(),
                    text: held.text.clone(),
                    held_at_ms: held.held_at_ms,
                })
                .collect(),
            organization_hold: self.organization_holds(),
        }
    }
}

fn trim(values: &mut BTreeSet<String>) {
    while values.len() > KEPT_DECISIONS {
        if let Some(first) = values.first().cloned() {
            values.remove(&first);
        }
    }
}

fn trim_decision_agents(saved: &mut Saved) {
    saved.decision_agents.retain(|id, _| {
        saved.approved.contains(id)
            || saved.dismissed.contains(id)
            || saved.consumed.contains_key(id)
    });
}

fn trim_held(values: &mut BTreeMap<String, Held>) {
    while values.len() > KEPT_HELD {
        let oldest = values
            .values()
            .min_by(|a, b| a.held_at_ms.cmp(&b.held_at_ms).then(a.id.cmp(&b.id)))
            .map(|held| held.id.clone());
        if let Some(id) = oldest {
            values.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::delivery::policy::Attachment;
    use crate::relay::store::Target;

    fn registration(id: &str) -> Registration {
        Registration {
            name: "claude-review".into(),
            agent_id: "agent-1".into(),
            target: Target::new(SessionKind::ClaudeTerminal, id),
            title: "Review".into(),
            base_url: "https://cast.agentrelay.com".into(),
            registered_at: "2026-10-12T00:00:00Z".into(),
            workspace_key: None,
            machine_prefix: None,
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
            cleared: None,
            gate: None,
            control_url: None,
        }
    }

    fn delivery(id: &str, sender: &str) -> Delivery {
        Delivery {
            id: id.into(),
            sender: Some(sender.into()),
            sender_address: Some(format!("{sender}@desk")),
            text: Some("Please review this.".into()),
            ..Delivery::default()
        }
    }

    /// The organization's hold covers every harness: an admin delivers, by
    /// address or name; anyone else is held for a one-time approval, and no
    /// sender can be allowed for good until it is lifted.
    #[test]
    fn the_organization_holds_non_admins_in_every_harness() {
        let root = tempfile::tempdir().unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let mut codex = registration("thread-1");
        codex.target = Target::new(SessionKind::Codex, "thread-1");
        let from_sam = delivery("del-1", "sam");
        // An exception made before the rule stays saved.
        policy.set_sender("sam@desk", "Sam", true).unwrap();
        assert_eq!(policy.decide(&codex, &from_sam), Decision::Deliver);

        let admins = BTreeSet::from(["lead".to_string(), "ops@desk".to_string()]);
        assert!(policy.set_organization_hold(Some(admins.clone())));
        assert!(!policy.set_organization_hold(Some(admins)));
        assert_eq!(policy.decide(&codex, &from_sam), Decision::Hold);
        let claude = registration("11111111-1111-1111-1111-111111111111");
        assert_eq!(policy.decide(&claude, &from_sam), Decision::Hold);
        assert_eq!(
            policy.decide(&codex, &delivery("del-2", "lead")),
            Decision::Deliver
        );
        assert_eq!(
            policy.decide(&codex, &delivery("del-3", "ops")),
            Decision::Deliver
        );
        let unaddressed = Delivery {
            sender_address: None,
            ..delivery("del-4", "lead")
        };
        assert_eq!(policy.decide(&codex, &unaddressed), Decision::ReadQueue);
        // One message may be approved; a sender may not be allowed for good.
        assert!(policy.hold(&codex, &from_sam).unwrap());
        assert_eq!(
            policy.approve("del-1").unwrap().as_deref(),
            Some("claude-review")
        );
        assert_eq!(policy.decide(&codex, &from_sam), Decision::Deliver);
        assert_eq!(
            policy.set_sender("kim@desk", "Kim", true).unwrap_err(),
            ORGANIZATION_HOLD_REFUSAL
        );
        policy.set_sender("sam@desk", "Sam", false).unwrap();
        assert!(policy.status(&[]).organization_hold);
        // A message dismissed under the rule stays dismissed once it is lifted.
        let from_kim = delivery("del-6", "kim");
        assert!(policy.hold(&codex, &from_kim).unwrap());
        policy.dismiss("del-6").unwrap();
        // Lifted: every harness but Claude delivers as before.
        assert!(policy.set_organization_hold(None));
        assert_eq!(policy.decide(&codex, &from_kim), Decision::Dismiss);
        // An approved message whose injection is recorded is not injected
        // again once the rule is lifted, in any harness.
        let from_lee = delivery("del-7", "lee");
        assert!(policy.set_organization_hold(Some(BTreeSet::from(["lead".to_string()]))));
        assert!(policy.hold(&codex, &from_lee).unwrap());
        policy.approve("del-7").unwrap();
        assert!(policy.records_outcome(&codex, "del-7"));
        policy
            .consume("del-7", "claude-review", PriorOutcome::Delivered)
            .unwrap();
        assert!(policy.set_organization_hold(None));
        assert_eq!(
            policy.decide(&codex, &from_lee),
            Decision::Handled(PriorOutcome::Delivered)
        );
        assert!(!policy.records_outcome(&codex, "del-8"));
        assert_eq!(
            policy.decide(&codex, &delivery("del-5", "kim")),
            Decision::Deliver
        );
        assert!(!policy.status(&[]).organization_hold);
    }

    #[test]
    fn session_and_sender_controls_hold_then_approve() {
        let root = tempfile::tempdir().unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let message = delivery("del-1", "sam");
        assert_eq!(policy.decide(&registration, &message), Decision::Deliver);
        policy.set_restricted(true).unwrap();
        assert_eq!(policy.decide(&registration, &message), Decision::Hold);
        assert!(policy.hold(&registration, &message).unwrap());
        assert!(!policy.hold(&registration, &message).unwrap());
        assert_eq!(
            policy.approve("del-1").unwrap().as_deref(),
            Some("claude-review")
        );
        assert_eq!(policy.decide(&registration, &message), Decision::Deliver);
        policy.finish("del-1");
        policy.set_sender("sam@desk", "sam", true).unwrap();
        assert_eq!(policy.decide(&registration, &message), Decision::Deliver);
        policy.set_session(&registration.target.id, false).unwrap();
        assert_eq!(policy.decide(&registration, &message), Decision::Hold);
    }

    #[test]
    fn holding_the_same_delivery_again_does_not_touch_disk() {
        let root = tempfile::tempdir().unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let message = delivery("del-duplicate", "sam");
        assert!(policy.hold(&registration, &message).unwrap());

        let original = root.path().to_path_buf();
        let moved = original.with_extension("moved");
        fs::rename(&original, &moved).unwrap();
        fs::write(&original, b"not a directory").unwrap();
        assert!(!policy.hold(&registration, &message).unwrap());
        assert!(policy
            .hold(&registration, &delivery("del-new", "sam"))
            .is_err());
        fs::remove_file(&original).unwrap();
        fs::rename(&moved, &original).unwrap();
    }

    #[test]
    fn dismissal_survives_reopen_until_settled() {
        let root = tempfile::tempdir().unwrap();
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let message = delivery("del-2", "lee");
        let policy = ClaudeDeliveryPolicy::open(root.path());
        policy.set_session(&registration.target.id, false).unwrap();
        policy.hold(&registration, &message).unwrap();
        policy.dismiss("del-2").unwrap();
        let reopened = ClaudeDeliveryPolicy::open(root.path());
        assert_eq!(reopened.decide(&registration, &message), Decision::Dismiss);
    }

    #[test]
    fn an_unreadable_policy_holds_every_sender() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(FILE), b"not json").unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let registration = registration("11111111-1111-1111-1111-111111111111");
        assert_eq!(
            policy.decide(&registration, &delivery("del-3", "pat")),
            Decision::Hold
        );
    }

    #[test]
    fn addressless_pushes_are_read_from_the_queue_before_sender_policy() {
        let root = tempfile::tempdir().unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let mut message = delivery("del-addressless", "pat");
        message.sender_address = None;
        policy.set_restricted(true).unwrap();
        assert_eq!(policy.decide(&registration, &message), Decision::ReadQueue);
        assert!(policy.hold(&registration, &message).unwrap());
        let status = policy.status(std::slice::from_ref(&registration));
        assert_eq!(status.held[0].sender, "");
        assert_eq!(status.held[0].sender_name, "pat");

        message.sender_address = Some("pat@desk".into());
        assert_eq!(policy.decide(&registration, &message), Decision::Hold);
        policy.set_sender("pat@desk", "pat", true).unwrap();
        assert_eq!(policy.decide(&registration, &message), Decision::Deliver);
    }

    #[test]
    fn consumed_outcome_survives_reopen_until_main_store_recovers() {
        let root = tempfile::tempdir().unwrap();
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let message = delivery("del-consumed", "pat");
        let policy = ClaudeDeliveryPolicy::open(root.path());
        policy.set_session(&registration.target.id, false).unwrap();
        policy.hold(&registration, &message).unwrap();
        policy.approve(&message.id).unwrap();
        policy
            .consume(&message.id, &registration.name, PriorOutcome::Delivered)
            .unwrap();

        let reopened = ClaudeDeliveryPolicy::open(root.path());
        assert_eq!(
            reopened.decide(&registration, &message),
            Decision::Handled(PriorOutcome::Delivered)
        );
        reopened.finish(&message.id);
        assert_eq!(reopened.decide(&registration, &message), Decision::Hold);
    }

    #[test]
    fn changing_workspace_discards_workspace_bound_choices() {
        let root = tempfile::tempdir().unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let message = delivery("del-workspace", "pat");
        policy.use_workspace("workspace-one").unwrap();
        policy.set_restricted(true).unwrap();
        policy.set_sender("pat@desk", "pat", true).unwrap();
        policy.set_session(&registration.target.id, false).unwrap();
        policy.hold(&registration, &message).unwrap();
        policy.approve(&message.id).unwrap();
        policy
            .consume(&message.id, &registration.name, PriorOutcome::Delivered)
            .unwrap();

        policy.use_workspace("workspace-two").unwrap();
        let status = policy.status(std::slice::from_ref(&registration));
        assert!(status.restricted);
        assert!(status.allowed_senders.is_empty());
        assert!(status.held.is_empty());
        assert!(status.sessions[0].direct);
        assert_eq!(
            policy.decide(&registration, &message),
            Decision::Handled(PriorOutcome::Delivered)
        );
        let reopened = ClaudeDeliveryPolicy::open(root.path());
        assert_eq!(
            reopened.decide(&registration, &message),
            Decision::Handled(PriorOutcome::Delivered)
        );
    }

    #[test]
    fn held_approval_describes_attachments_and_is_removed_with_its_agent() {
        let root = tempfile::tempdir().unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let mut message = delivery("del-file", "pat");
        message.attachments.push(Attachment {
            file_id: "file-1".into(),
            filename: Some("review.png".into()),
            content_type: Some("image/png".into()),
            size_bytes: Some(512),
            ..Attachment::default()
        });
        policy.set_session(&registration.target.id, false).unwrap();
        policy.hold(&registration, &message).unwrap();
        let status = policy.status(std::slice::from_ref(&registration));
        assert!(status.held[0].text.contains("review.png"));
        assert!(status.held[0].text.contains("image/png"));
        assert!(policy.remove_agent(&registration.name).unwrap());
        assert!(policy.status(&[registration]).held.is_empty());
    }

    #[test]
    fn removing_an_agent_also_removes_its_pending_decision() {
        let root = tempfile::tempdir().unwrap();
        let policy = ClaudeDeliveryPolicy::open(root.path());
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let message = delivery("del-approved", "pat");
        policy.set_session(&registration.target.id, false).unwrap();
        policy.hold(&registration, &message).unwrap();
        policy.approve(&message.id).unwrap();
        assert_eq!(policy.decide(&registration, &message), Decision::Deliver);
        assert!(policy.remove_agent(&registration.name).unwrap());
        assert_eq!(policy.decide(&registration, &message), Decision::Hold);
    }

    #[test]
    fn held_collection_is_bounded_by_oldest_timestamp() {
        let mut held = BTreeMap::new();
        for index in 0..=KEPT_HELD {
            let id = format!("delivery-{index}");
            held.insert(
                id.clone(),
                Held {
                    id,
                    agent: "agent".into(),
                    session_id: "session".into(),
                    sender: "sender@desk".into(),
                    sender_name: "sender".into(),
                    text: String::new(),
                    held_at_ms: index as i64,
                },
            );
        }
        trim_held(&mut held);
        assert_eq!(held.len(), KEPT_HELD);
        assert!(!held.contains_key("delivery-0"));
    }

    #[test]
    fn a_successful_queue_read_durably_removes_only_expired_prior_holds() {
        let root = tempfile::tempdir().unwrap();
        let registration = registration("11111111-1111-1111-1111-111111111111");
        let active = delivery("active", "lee");
        let expired = delivery("expired", "pat");
        let later = delivery("later", "sam");
        let policy = ClaudeDeliveryPolicy::open(root.path());
        policy.set_session(&registration.target.id, false).unwrap();
        policy.hold(&registration, &active).unwrap();
        policy.hold(&registration, &expired).unwrap();

        let held_before_read = policy.held_ids_for_agent(&registration.name);
        // Approval may race the queue read. Reconciliation must clear its
        // decision too when Relaycast no longer has the delivery.
        assert!(policy.approve("expired").unwrap().is_some());
        // A push held after the read began was not in its response and must
        // not be removed by that older response.
        policy.hold(&registration, &later).unwrap();
        let queued = HashSet::from(["active"]);
        assert!(policy.reconcile_queue(&held_before_read, &queued).unwrap());

        let status = policy.status(std::slice::from_ref(&registration));
        let held: BTreeSet<_> = status.held.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(held, BTreeSet::from(["active", "later"]));
        assert_eq!(policy.decide(&registration, &expired), Decision::Hold);

        let reopened = ClaudeDeliveryPolicy::open(root.path());
        assert_eq!(reopened.decide(&registration, &expired), Decision::Hold);
        assert_eq!(reopened.status(&[registration]).held.len(), 2);
    }
}
