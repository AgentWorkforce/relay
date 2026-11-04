//! Why a direct send's recipient was not an agent, read from the workspace
//! roster and its people: the candidates its name matches, the person it
//! names and their agents, or nothing (`docs/relay-core.md`, "Messaging
//! etiquette and unresolved recipients").

use crate::relay::client::Sent;
use crate::relay::daemon::Core;
use crate::relay::links::Endpoint;
use crate::relay::outbound::{Outbound, OutboundError};
use crate::relay::people::{decode_roster, RosterAgent, RosterQuery, WorkspacePerson};
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::state::now_ms;
use crate::relay::store::Registration;
use std::collections::HashMap;

/// Why a recipient Relaycast could not resolve was not an agent, read
/// from the roster and the workspace's people.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unresolved {
    /// Agents the name or address could have meant, by full address.
    Candidates(Vec<String>),
    /// The people in the workspace a name matches (usually one), each with
    /// their agents' full addresses.
    People(Vec<(String, Vec<String>)>),
    /// Nothing on the roster resembles it.
    Unknown,
}

/// Why `wanted` (a name or `agent@machine`) did not name an agent. A bare
/// name may be a person's (their name, its first word, or its words joined
/// with `-`), else every agent whose name contains it is a candidate. An
/// address is never a person's: its candidates are the agents named by any
/// of its readings (an `@` may sit in either part), wherever they are now.
/// Matching ignores case.
pub fn unresolved(wanted: &str, roster: &[RosterAgent], people: &[WorkspacePerson]) -> Unresolved {
    let wanted = wanted.trim().trim_start_matches('@').to_lowercase();
    if wanted.is_empty() {
        return Unresolved::Unknown;
    }
    let readings: Vec<&str> = wanted
        .char_indices()
        .filter(|(index, c)| *c == '@' && *index > 0)
        .map(|(index, _)| &wanted[..index])
        .collect();
    let agents = || roster.iter().filter(|agent| agent.kind != "human");
    let mut candidates: Vec<String> = if readings.is_empty() {
        if let Some(people) = named_people(&wanted, roster, people) {
            return Unresolved::People(people);
        }
        agents()
            .filter(|agent| agent.name.to_lowercase().contains(&wanted))
            .filter_map(|agent| agent.address.clone())
            .collect()
    } else {
        agents()
            .filter(|agent| readings.contains(&agent.name.to_lowercase().as_str()))
            .filter_map(|agent| agent.address.clone())
            .filter(|address| address.to_lowercase() != wanted)
            .collect()
    };
    candidates.sort();
    candidates.dedup();
    if candidates.is_empty() {
        Unresolved::Unknown
    } else {
        Unresolved::Candidates(candidates)
    }
}

/// The workspace's people `name` matches, each with their agents; the
/// roster's own person entries when no member does.
fn named_people(
    name: &str,
    roster: &[RosterAgent],
    people: &[WorkspacePerson],
) -> Option<Vec<(String, Vec<String>)>> {
    let addresses = |owner: Option<&str>| {
        let mut addresses: Vec<String> = roster
            .iter()
            .filter(|agent| {
                agent.kind != "human" && owner.is_some() && agent.owner_hash.as_deref() == owner
            })
            .filter_map(|agent| agent.address.clone())
            .collect();
        addresses.sort();
        addresses.dedup();
        addresses
    };
    let names_person = |full: &str| {
        let full = full.trim().to_lowercase();
        let words: Vec<&str> = full
            .split(|c: char| c.is_whitespace() || "-_.".contains(c))
            .filter(|word| !word.is_empty())
            .collect();
        full == name || words.first() == Some(&name) || words.join("-") == name
    };
    let mut found: Vec<(String, Vec<String>)> = people
        .iter()
        .filter(|person| names_person(&person.name))
        .map(|person| (person.name.clone(), addresses(Some(&person.identity_hash))))
        .collect();
    if found.is_empty() {
        found = roster
            .iter()
            .filter(|agent| agent.kind == "human" && names_person(&agent.name))
            .map(|human| (human.name.clone(), addresses(human.owner_hash.as_deref())))
            .collect();
    }
    (!found.is_empty()).then_some(found)
}

impl Unresolved {
    /// What a sender is told; `list` is how it lists agents itself.
    pub fn message(&self, wanted: &str, list: &str) -> String {
        let missing = if wanted.contains('@') {
            format!("No agent is at \"{wanted}\".")
        } else {
            format!("No agent is named \"{wanted}\".")
        };
        match self {
            Unresolved::Candidates(candidates) if candidates.len() == 1 => format!(
                "{missing} Did you mean {}? Send to that full address.",
                candidates[0]
            ),
            Unresolved::Candidates(candidates) => format!(
                "\"{wanted}\" matches more than one agent: {}. Send to one full address.",
                candidates.join(", ")
            ),
            Unresolved::People(people) => match people.as_slice() {
                [(name, agents)] if agents.is_empty() => format!(
                    "\"{wanted}\" is a person ({name}), not an agent, and has no agents on the \
                     relay now. {list} to find an agent to message."
                ),
                [(name, agents)] => format!(
                    "\"{wanted}\" is a person ({name}), not an agent. Their agents: {}. Send to \
                     one full address.",
                    agents.join(", ")
                ),
                people => format!(
                    "\"{wanted}\" names more than one person, not an agent: {}. Send to one full \
                     address.",
                    people
                        .iter()
                        .map(|(name, agents)| match agents.as_slice() {
                            [] => format!("{name} (no agents on the relay now)"),
                            agents => format!("{name} ({})", agents.join(", ")),
                        })
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
            },
            Unresolved::Unknown => {
                format!("{missing} {list} first, then send to an exact address from it.")
            }
        }
    }
}

/// A send failure, keeping Relaycast's address resolution outcomes apart.
/// A recipient Relaycast could not resolve is explained by `unresolved`:
/// the candidates its name matches, or the person it names.
fn send_error(error: &relaycast::RelayError, wanted: &str, unresolved: &Unresolved) -> RpcError {
    let message = unresolved.message(wanted, "List the workspace's agents");
    match (error, unresolved) {
        // Relaycast alone decides how an address with several `@` splits.
        (relaycast::RelayError::Api { code, .. }, _) if code == "ambiguous_address" => {
            RpcError::invalid_params(
                "That address matches more than one agent. Use the full agent@machine address.",
            )
        }
        (_, Unresolved::Candidates(candidates)) if candidates.len() > 1 => {
            RpcError::invalid_params(message)
        }
        (_, Unresolved::People(_)) => RpcError::invalid_params(message),
        (error, _) if unresolved_recipient(error) => RpcError::new(ErrorKind::NotFound, message),
        (error, _) => RpcError::from_relaycast(error),
    }
}

/// Whether Relaycast found no agent for a send's recipient.
pub(crate) fn unresolved_recipient(error: &relaycast::RelayError) -> bool {
    matches!(error.code(), Some("agent_not_found" | "address_not_found"))
}

impl Core {
    /// Why a send you made to `wanted` did not resolve, by the roster and
    /// people of the workspace your messages go to; `Unknown` when they
    /// cannot be read.
    pub(crate) async fn unresolved_recipient(&self, wanted: &str) -> Unresolved {
        if !self.roster_is_messaging_workspace().await {
            return Unresolved::Unknown;
        }
        let Ok((roster, _)) = self.roster(&RosterQuery::default()).await else {
            return Unresolved::Unknown;
        };
        let workspace = self.workspace();
        let people = self
            .members_for(|core| {
                core.workspace().map(|w| (w.base_url, w.key))
                    == workspace
                        .as_ref()
                        .map(|w| (w.base_url.clone(), w.key.clone()))
            })
            .await;
        unresolved(wanted, &roster, &people)
    }

    /// The signed-in workspace's people, read only while `same` holds and
    /// the signed-in account is unchanged, before and after the read:
    /// another account's member names never reach an explanation.
    async fn members_for(&self, same: impl Fn(&Core) -> bool) -> Vec<WorkspacePerson> {
        let account = |core: &Core| {
            core.plugins
                .cloud
                .account()
                .map(|a| (a.site_url, a.workspace_id, a.user_id))
        };
        let before = account(self);
        if before.is_none() || !same(self) {
            return Vec::new();
        }
        let people = self.people().await.unwrap_or_default();
        if account(self) != before || !same(self) {
            return Vec::new();
        }
        people
    }

    /// Why a send you made failed: for a recipient Relaycast found no agent
    /// for, explained by the roster.
    pub(crate) async fn person_send_error(
        &self,
        endpoint: &Endpoint,
        error: &relaycast::RelayError,
    ) -> RpcError {
        let explained = if unresolved_recipient(error) {
            self.unresolved_recipient(endpoint.value()).await
        } else {
            Unresolved::Unknown
        };
        send_error(error, endpoint.value(), &explained)
    }
}

impl Outbound {
    /// A direct send's outcome: a recipient Relaycast found no agent for is
    /// explained; any other failure keeps Relaycast's status and code.
    pub(crate) async fn settle(
        &self,
        sent: relaycast::Result<Sent>,
        registration: &Registration,
        endpoint: &Option<Endpoint>,
    ) -> Result<Sent, OutboundError> {
        match (sent, endpoint) {
            (Ok(sent), _) => Ok(sent),
            (Err(error), Some(endpoint)) if unresolved_recipient(&error) => {
                Err(self.unresolved(registration, endpoint, &error).await)
            }
            (Err(error), _) => Err(OutboundError::relaycast(&error)),
        }
    }

    /// A recipient Relaycast could not resolve, explained from the caller's
    /// workspace roster (and its people, when it is the signed-in
    /// workspace): every candidate's full address, the person it names and
    /// their agents, or that the roster has to be listed first.
    async fn unresolved(
        &self,
        registration: &Registration,
        endpoint: &Endpoint,
        error: &relaycast::RelayError,
    ) -> OutboundError {
        let wanted = endpoint.value();
        let base = &registration.base_url;
        let explained = match self.core.key_for(registration) {
            // Idle agents too: they can still be messaged.
            Some(key) => match self.roster(base, &key, true).await {
                Ok(answer) => {
                    let people = self
                        .core
                        .members_for(|core| {
                            core.workspace()
                                .is_some_and(|w| &w.base_url == base && w.key == key)
                        })
                        .await;
                    let mut agents = decode_roster(&answer.items, &HashMap::new(), None, now_ms());
                    // The caller is never the agent it meant.
                    agents.retain(|agent| !registration.answers_to(&agent.name));
                    unresolved(wanted, &agents, &people)
                }
                Err(_) => Unresolved::Unknown,
            },
            None => Unresolved::Unknown,
        };
        let message = explained.message(wanted, "List agents with GET /agents");
        match explained {
            Unresolved::Candidates(candidates) if candidates.len() > 1 => {
                OutboundError::new(400, "ambiguous_recipient", message)
            }
            Unresolved::People(_) => OutboundError::new(400, "recipient_is_person", message),
            _ => {
                let mut refused = OutboundError::relaycast(error);
                refused.message = message;
                refused
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn an_unresolved_recipient_names_its_candidates_or_its_person() {
        let roster = decode_roster(
            &[
                json!({"name": "codex-api", "address": "codex-api@laptop", "status": "active", "metadata": {"owner_hash": "grace"}}),
                json!({"name": "Codex-Web", "address": "Codex-Web@desk", "status": "active", "metadata": {}}),
                json!({"name": "claude-docs", "address": "claude-docs@desk", "status": "active", "metadata": {"owner_hash": "grace"}}),
                json!({"name": "ada-lovelace", "type": "human", "address": "ada-lovelace@cloud", "status": "active", "metadata": {}}),
            ],
            &HashMap::new(),
            None,
            NOW,
        );
        let people = [WorkspacePerson {
            name: "Grace Hopper".into(),
            avatar_url: None,
            identity_hash: "grace".into(),
            is_self: false,
        }];
        let candidates =
            Unresolved::Candidates(vec!["Codex-Web@desk".into(), "codex-api@laptop".into()]);
        assert_eq!(unresolved("CODEX", &roster, &people), candidates);
        assert_eq!(
            candidates.message("CODEX", "List agents"),
            "\"CODEX\" matches more than one agent: Codex-Web@desk, codex-api@laptop. Send to \
             one full address."
        );
        // An address is compared by its agent names, exactly: an agent that
        // moved is found where it is now, and the address never names a
        // person or a look-alike.
        assert_eq!(
            unresolved("codex-api@desk", &roster, &people),
            Unresolved::Candidates(vec!["codex-api@laptop".into()])
        );
        assert_eq!(
            unresolved("codex-api@desk", &roster, &people).message("codex-api@desk", "List agents"),
            "No agent is at \"codex-api@desk\". Did you mean codex-api@laptop? Send to that full \
             address."
        );
        assert_eq!(
            unresolved("docs@laptop", &roster, &people),
            Unresolved::Unknown
        );
        assert_eq!(
            unresolved("grace@laptop", &roster, &people),
            Unresolved::Unknown
        );
        // A member by first name, full name or slug; a roster person by name.
        let grace = Unresolved::People(vec![(
            "Grace Hopper".into(),
            vec!["claude-docs@desk".into(), "codex-api@laptop".into()],
        )]);
        for wanted in ["grace", "@Grace", "grace-hopper"] {
            assert_eq!(unresolved(wanted, &roster, &people), grace, "{wanted}");
        }
        assert_eq!(
            grace.message("grace", "List agents"),
            "\"grace\" is a person (Grace Hopper), not an agent. Their agents: \
             claude-docs@desk, codex-api@laptop. Send to one full address."
        );
        let ada = unresolved("ada", &roster, &people);
        assert_eq!(
            ada,
            Unresolved::People(vec![("ada-lovelace".into(), vec![])])
        );
        assert_eq!(
            ada.message("ada", "List agents with GET /agents"),
            "\"ada\" is a person (ada-lovelace), not an agent, and has no agents on the relay \
             now. List agents with GET /agents to find an agent to message."
        );
        assert_eq!(unresolved("ghost", &roster, &people), Unresolved::Unknown);
        assert_eq!(
            Unresolved::Unknown.message("ghost", "List agents with GET /agents"),
            "No agent is named \"ghost\". List agents with GET /agents first, then send to an \
             exact address from it."
        );
    }

    #[test]
    fn a_shared_first_name_lists_every_person_and_an_address_reads_every_split() {
        let roster = decode_roster(
            &[
                json!({"name": "codex-api", "address": "codex-api@laptop", "status": "active", "metadata": {"owner_hash": "smith"}}),
                json!({"name": "x@ops", "address": "x@ops@new-desk", "status": "active", "metadata": {}}),
                json!({"name": "x-tool", "address": "x-tool@desk", "status": "active", "metadata": {}}),
            ],
            &HashMap::new(),
            None,
            NOW,
        );
        let person = |name: &str, hash: &str| WorkspacePerson {
            name: name.into(),
            avatar_url: None,
            identity_hash: hash.into(),
            is_self: false,
        };
        let people = [
            person("Grace Hopper", "hopper"),
            person("Grace Smith", "smith"),
        ];
        let graces = unresolved("grace", &roster, &people);
        assert_eq!(
            graces,
            Unresolved::People(vec![
                ("Grace Hopper".into(), vec![]),
                ("Grace Smith".into(), vec!["codex-api@laptop".into()]),
            ])
        );
        assert_eq!(
            graces.message("grace", "List agents"),
            "\"grace\" names more than one person, not an agent: Grace Hopper (no agents on the \
             relay now); Grace Smith (codex-api@laptop). Send to one full address."
        );
        // `x@ops@old-desk` reads as agent `x` or agent `x@ops`; only the
        // agent named by a reading is suggested, never `x-tool`.
        assert_eq!(
            unresolved("x@ops@old-desk", &roster, &people),
            Unresolved::Candidates(vec!["x@ops@new-desk".into()])
        );
    }

    #[test]
    fn an_unresolved_send_keeps_its_kind_and_explains_itself() {
        let api =
            |code: &str, status: u16| relaycast::RelayError::api(code, "provider body", status);
        let many = Unresolved::Candidates(vec!["codex-a@m".into(), "codex-b@m".into()]);
        let error = send_error(&api("agent_not_found", 404), "codex", &many);
        assert_eq!(error.data.kind, ErrorKind::InvalidParams);
        assert!(error.message.contains("codex-a@m, codex-b@m"));
        let person = Unresolved::People(vec![("Grace Hopper".into(), vec!["codex-a@m".into()])]);
        let error = send_error(&api("agent_not_found", 404), "grace", &person);
        assert_eq!(error.data.kind, ErrorKind::InvalidParams);
        assert!(error
            .message
            .starts_with("\"grace\" is a person (Grace Hopper)"));
        let error = send_error(&api("address_not_found", 404), "a@m", &Unresolved::Unknown);
        assert_eq!(error.data.kind, ErrorKind::NotFound);
        assert_eq!(
            error.message,
            "No agent is at \"a@m\". List the workspace's agents first, then send to an exact \
             address from it."
        );
        // An address Relaycast reads more than one way stays ambiguous, even
        // when the roster suggests a name.
        let one = Unresolved::Candidates(vec!["alice-dev@desk".into()]);
        let error = send_error(&api("ambiguous_address", 400), "alice@team@desk", &one);
        assert_eq!(error.data.kind, ErrorKind::InvalidParams);
        assert!(error
            .message
            .starts_with("That address matches more than one agent."));
        assert!(!unresolved_recipient(&api("ambiguous_address", 400)));
        assert!(
            !send_error(&api("rate_limited", 429), "a", &Unresolved::Unknown)
                .message
                .contains("No agent")
        );
    }

    /// A Cloud whose signed-in account becomes another user's while
    /// `/members` is read, when `switch` is set.
    struct SwitchingCloud {
        switch: bool,
        switched: std::sync::atomic::AtomicBool,
    }

    impl crate::relay::cloud_session::CloudAccess for SwitchingCloud {
        fn account(&self) -> Option<crate::relay::cloud_session::CloudAccount> {
            let switched = self.switched.load(std::sync::atomic::Ordering::SeqCst);
            Some(crate::relay::cloud_session::CloudAccount {
                site_url: "https://agentrelay.com".into(),
                workspace_id: "rw_1".into(),
                user_id: Some(if switched { "user-2" } else { "user-1" }.into()),
            })
        }

        fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
            None
        }

        fn request(
            &self,
            _: &'static str,
            _: String,
            _: Option<serde_json::Value>,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<serde_json::Value, crate::relay::cloud_session::CloudError>,
        > {
            if self.switch {
                self.switched
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Box::pin(async {
                Ok(json!({"members": [{"userId": "user-9", "name": "Grace Hopper"}]}))
            })
        }
    }

    #[tokio::test]
    async fn member_names_are_dropped_when_the_account_changes_during_the_read() {
        for (switch, expected) in [(false, vec!["Grace Hopper"]), (true, vec![])] {
            let temp = tempfile::tempdir().unwrap();
            let config = crate::relay::daemon::Config {
                paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                    .unwrap(),
                home: temp.path().into(),
                app_data_dir: temp.path().join("app-data"),
                env: std::collections::BTreeMap::new(),
                version: "0.0.0-test".into(),
                host_name: "Test Desk.local".into(),
                rediscover_every: std::time::Duration::from_secs(3600),
                push_timing: crate::relay::push::PushTiming::default(),
                delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
            };
            let plugins = crate::relay::daemon::Plugins {
                cloud: std::sync::Arc::new(SwitchingCloud {
                    switch,
                    switched: Default::default(),
                }),
                ..Default::default()
            };
            let (core, _signals) = Core::with_plugins(config, plugins);
            let names: Vec<String> = core
                .members_for(|_| true)
                .await
                .into_iter()
                .map(|person| person.name)
                .collect();
            assert_eq!(names, expected, "switch: {switch}");
        }
    }
}
