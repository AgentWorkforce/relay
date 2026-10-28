//! Aliases: one name per session. The agent keeps the Relaycast agent it was
//! registered with; a rename adds another (the alias), which becomes the
//! session's only shown name and sender. Every earlier name only forwards
//! what was sent to it: the registered one until the agent leaves the relay,
//! a replaced alias for `RETIRED_FORWARDING` (see `RetiredAlias`).

use super::{CleanupKind, PendingCleanup, Registration, Store, Target};
use crate::relay::workspace::Secret;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// How long a replaced alias keeps forwarding before it is released.
pub const RETIRED_FORWARDING: chrono::Duration = chrono::Duration::hours(24);

/// A rename: another name the session is reached by, held until the agent
/// is renamed again or leaves the relay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAlias {
    pub name: String,
    #[serde(rename = "agentID")]
    pub agent_id: String,
    pub token: Secret,
    #[serde(rename = "registeredAt", deserialize_with = "super::timestamp")]
    pub registered_at: String,
}

/// An alias a later rename replaced. It still forwards what was sent to it,
/// so a late reply arrives, until `RETIRED_FORWARDING` after `retired_at`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetiredAlias {
    pub alias: AgentAlias,
    /// ISO-8601, seconds precision.
    #[serde(rename = "retiredAt")]
    pub retired_at: String,
}

impl RetiredAlias {
    /// Whether it has forwarded for as long as it does, at `now`.
    pub fn expired(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.retired_at).map_or(true, |at| {
            now - at.with_timezone(&chrono::Utc) >= RETIRED_FORWARDING
        })
    }
}

impl Registration {
    /// The token it sends with, given its own: one name per session, so a
    /// renamed one sends under its current name.
    pub fn sender_token(&self, own: Secret) -> Secret {
        self.alias.as_ref().map_or(own, |alias| alias.token.clone())
    }

    /// The direct address of its one current name: the alias's once renamed.
    pub fn current_address(&self, current_prefix: &str) -> String {
        match self.alias_credential() {
            Some((alias, _)) => alias.direct_address(current_prefix),
            None => self.direct_address(current_prefix),
        }
    }

    /// The aliases a later rename replaced, still forwarding.
    pub fn retired(&self) -> impl Iterator<Item = &AgentAlias> {
        self.retired_aliases.iter().flatten().map(|r| &r.alias)
    }

    /// Every name that reaches this session: its own, its alias, then the
    /// replaced aliases still forwarding.
    pub fn names(&self) -> Vec<String> {
        std::iter::once(self.name.clone())
            .chain(self.alias_name().map(str::to_owned))
            .chain(self.retired().map(|alias| alias.name.clone()))
            .collect()
    }

    /// The Relaycast agent ids that stand for this session.
    pub fn agent_ids(&self) -> Vec<String> {
        std::iter::once(self.agent_id.clone())
            .chain(
                self.alias
                    .iter()
                    .chain(self.retired())
                    .map(|a| a.agent_id.clone()),
            )
            .collect()
    }

    /// The name people see: the alias when the agent was renamed.
    pub fn display_name(&self) -> &str {
        self.alias_name().unwrap_or(&self.name)
    }

    pub fn alias_name(&self) -> Option<&str> {
        self.alias.as_ref().map(|alias| alias.name.as_str())
    }

    /// Whether `name` reaches this agent, as any of its names.
    pub fn answers_to(&self, name: &str) -> bool {
        self.name == name
            || self.alias_name() == Some(name)
            || self.retired().any(|alias| alias.name == name)
    }

    /// `alias` as an agent of its own, for delivery and presence: the same
    /// session under that Relaycast agent and token. Webhooks and
    /// integrations stay with the registered name.
    fn view(&self, alias: &AgentAlias) -> (Registration, Secret) {
        let view = Registration {
            name: alias.name.clone(),
            agent_id: alias.agent_id.clone(),
            registered_at: alias.registered_at.clone(),
            webhook: None,
            integration_channel_id: None,
            integration_channel_name: None,
            integrations: None,
            alias: None,
            retired_aliases: None,
            ..self.clone()
        };
        (view, alias.token.clone())
    }

    /// The current alias as an agent of its own.
    pub fn alias_credential(&self) -> Option<(Registration, Secret)> {
        Some(self.view(self.alias.as_ref()?))
    }

    /// Each replaced alias still forwarding, as an agent of its own.
    pub fn retired_credentials(&self) -> impl Iterator<Item = (Registration, Secret)> + '_ {
        self.retired().map(|alias| self.view(alias))
    }

    fn cleanup_of(&self, alias: &AgentAlias) -> Option<PendingCleanup> {
        Some(PendingCleanup {
            kind: CleanupKind::Agent,
            name: alias.name.clone(),
            base_url: self.base_url.clone(),
            workspace_key: self.workspace_key.clone()?,
        })
    }

    /// The Relaycast removals owed for its aliases, current and replaced,
    /// once this registration is gone.
    pub(crate) fn alias_cleanups(&self) -> Vec<PendingCleanup> {
        self.alias
            .iter()
            .chain(self.retired())
            .filter_map(|alias| self.cleanup_of(alias))
            .collect()
    }
}

impl Store {
    pub fn registration_for(&self, target: &Target) -> Option<&Registration> {
        self.registrations.iter().find(|r| &r.target == target)
    }

    pub fn registration_named(&self, name: &str) -> Option<&Registration> {
        self.registrations.iter().find(|r| r.name == name)
    }

    /// Another session that already holds `name` as any of its names,
    /// perhaps in a workspace no longer active. Its token must never be
    /// displaced.
    pub fn name_holder(&self, name: &str, other_than: &Target) -> Option<&Registration> {
        self.registrations
            .iter()
            .find(|r| r.answers_to(name) && &r.target != other_than)
    }

    /// Each present session's one current name: only these are kept
    /// present on the relay; every earlier name only forwards.
    pub fn current_names(&self) -> HashSet<String> {
        self.registrations
            .iter()
            .filter(|r| r.missing_since.is_none())
            .map(|r| r.display_name().to_owned())
            .collect()
    }

    /// The registration that answers for `registration`'s session, which
    /// may be one of its forwarding names: it owns the answers and reply
    /// routes.
    pub fn reply_owner<'a>(&'a self, registration: &'a Registration) -> &'a Registration {
        self.registration_for(&registration.target)
            .unwrap_or(registration)
    }

    /// Every Relaycast agent id this computer delivers to.
    pub(super) fn agent_ids(&self) -> impl Iterator<Item = String> + '_ {
        self.registrations.iter().flat_map(Registration::agent_ids)
    }

    /// A replaced registration's aliases would otherwise outlive it on
    /// Relaycast, holding their names.
    pub(super) fn queue_replaced_aliases(&mut self, registration: &Registration) {
        let kept: HashSet<String> = registration.names().into_iter().collect();
        let orphaned: Vec<PendingCleanup> = self
            .registrations
            .iter()
            .filter(|r| r.target == registration.target)
            .flat_map(Registration::alias_cleanups)
            .filter(|cleanup| !kept.contains(&cleanup.name))
            .collect();
        for cleanup in orphaned {
            self.add_pending_cleanup(cleanup);
        }
    }

    /// The registration `name` reaches, by any of its names.
    pub fn registration_answering(&self, name: &str) -> Option<&Registration> {
        self.registrations.iter().find(|r| r.answers_to(name))
    }

    /// The registration and token deliveries to `name` are handled with:
    /// an agent's own, or one of its aliases'.
    pub fn credential_named(&self, name: &str) -> Option<(Registration, Secret)> {
        if let Some(registration) = self.registration_named(name) {
            let token = self.tokens.get(name)?;
            return Some((registration.clone(), token.clone()));
        }
        self.credentials()
            .into_iter()
            .find(|(registration, _)| registration.name == name)
    }

    /// Like `credential_named`, by Relaycast agent id.
    pub fn credential_for_agent_id(&self, agent_id: &str) -> Option<(Registration, Secret)> {
        self.credentials()
            .into_iter()
            .find(|(registration, _)| registration.agent_id == agent_id)
    }

    /// Every agent this computer delivers to: each registration with its
    /// token, then each alias, current or still forwarding, as an agent of
    /// its own.
    pub fn credentials(&self) -> Vec<(Registration, Secret)> {
        let own = self.registrations.iter().filter_map(|registration| {
            let token = self.tokens.get(&registration.name)?;
            Some((registration.clone(), token.clone()))
        });
        let aliases = self.registrations.iter().flat_map(|registration| {
            registration
                .alias_credential()
                .into_iter()
                .chain(registration.retired_credentials())
        });
        own.chain(aliases).collect()
    }

    /// Whether a refusal awaits settlement for any of the session's agents.
    pub fn has_pending_refusal_for(&self, registration: &Registration) -> bool {
        registration
            .agent_ids()
            .iter()
            .any(|id| self.has_pending_refusal(id))
    }

    /// Two processes renaming one agent at once each register an alias, and
    /// the merge keeps one: the other would stay on Relaycast unreachable.
    /// Only an alias a side added is queued; one already in `base` is
    /// released by the process that replaced it.
    pub(super) fn release_dropped_aliases(&mut self, base: &Store, sides: &[&Store]) {
        let aliases = |store: &Store| -> Vec<PendingCleanup> {
            store
                .registrations
                .iter()
                .flat_map(Registration::alias_cleanups)
                .collect()
        };
        let before: HashSet<String> = aliases(base).into_iter().map(|c| c.name).collect();
        let dropped: Vec<PendingCleanup> = sides
            .iter()
            .flat_map(|side| aliases(side))
            .filter(|cleanup| {
                !before.contains(&cleanup.name)
                    && !self
                        .registrations
                        .iter()
                        .any(|r| r.answers_to(&cleanup.name) && r.base_url == cleanup.base_url)
            })
            .collect();
        for cleanup in dropped {
            self.add_pending_cleanup(cleanup);
        }
    }
}
