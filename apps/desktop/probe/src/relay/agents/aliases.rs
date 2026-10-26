//! Renaming: an agent keeps the name it was registered with, and a rename
//! registers the new name as an alias (`store::AgentAlias`).

use super::*;
use crate::relay::contract::agents::Renamed;
use crate::relay::store::RetiredAlias;
use std::sync::PoisonError;

/// A bounded native title is presentation metadata, never the agent's objective.
pub(super) fn published_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

/// Persist the latest native title and retry its publication for every alias.
pub(crate) fn update_registered_title(
    store: &mut Store,
    source: &str,
    id: &str,
    title: &str,
) -> bool {
    // A partial discovery has no new title evidence; keep the last known one.
    if title.trim().is_empty() {
        return false;
    }
    let mut names = Vec::new();
    for registration in &mut store.registrations {
        if registration.target.kind.source() == source
            && registration.target.id == id
            && registration.title != title
        {
            registration.title = title.to_owned();
            names.extend(registration.names());
        }
    }
    let changed = !names.is_empty();
    if changed {
        let pending = store.pending_name_markers.get_or_insert_with(Vec::new);
        for name in names {
            if !pending.contains(&name) {
                pending.push(name);
            }
        }
    }
    changed
}

/// An agent's push state across its name and its alias: the alias's when
/// the name's is live but the alias's is not, so a failing alias channel is
/// not shown as receiving.
pub(crate) fn agent_push(
    push: &BTreeMap<String, PushState>,
    registration: &Registration,
) -> Option<PushState> {
    let own = push.get(&registration.name);
    let alias = registration.alias_name().and_then(|alias| push.get(alias));
    match (own, alias) {
        (Some(PushState::Live), Some(alias)) => Some(alias.clone()),
        (Some(own), _) => Some(own.clone()),
        (None, alias) => alias.cloned(),
    }
}

/// The answer for a session already on the relay: the registration as it
/// stands, under its current name. A description does not change it; a
/// new name does (`answer_registered`).
pub(super) fn already_registered(registration: &Registration, machine_prefix: &str) -> Registered {
    Registered {
        address: registration.current_address(machine_prefix),
        name: registration.display_name().to_owned(),
        already_registered: true,
    }
}

/// Whether a roster lists an agent: a renamed session's earlier name only
/// forwards what was sent to it, and its new one is listed instead.
pub(crate) fn is_listed(metadata: &Value) -> bool {
    metadata["renamed_to"].as_str().is_none_or(str::is_empty)
}

impl Core {
    /// Compute after acquiring the name's roster lock and reloading its row.
    pub(super) fn roster_status(&self, registration: &Registration, name: &str) -> &'static str {
        let present = registration.archived_at.is_none()
            && registration.missing_since.is_none()
            && registration.display_name() == name
            && (registration.spawn.is_none() || self.spawned_live().contains(&registration.target));
        if present {
            "active"
        } else {
            "idle"
        }
    }

    /// Gives the session a new name, its only shown name and sender, as an
    /// alias: a second Relaycast agent delivering into the same session. The
    /// registered name keeps forwarding until the agent leaves the relay; an
    /// alias a rename replaces keeps forwarding for `RETIRED_FORWARDING`, so
    /// a message sent mid-rename or a late reply still arrives. Renaming back
    /// to a name still forwarding takes it up again.
    pub async fn rename(&self, name: &str, raw_new_name: &str) -> Result<Renamed, RpcError> {
        let registration = self
            .store
            .read(|store| store.registration_answering(name).cloned())
            .ok_or_else(|| not_registered(name))?;
        if registration.spawn.is_some() {
            return Err(RpcError::new(
                ErrorKind::Refused,
                "An agent Agent Relay spawned keeps the name it was spawned with.",
            ));
        }
        let new_name = normalize_name(raw_new_name).ok_or_else(name_rules)?;
        if new_name == registration.display_name() {
            // The address of the name asked for: the alias's own when it is one.
            let address = registration.current_address(&self.machine_prefix);
            return Ok(Renamed {
                address,
                name: new_name,
                released: None,
            });
        }
        if self
            .store
            .read(|s| s.name_holder(&new_name, &registration.target).is_some())
        {
            return Err(RpcError::new(
                ErrorKind::Conflict,
                format!("@{new_name} is already used by another session here. Turn that one off first, or choose another name."),
            ));
        }
        let lock = self.target_locks.get(&registration.target.key());
        let Ok(_changing) = lock.try_lock() else {
            return Err(busy());
        };
        // Another change may have finished between the read and the lock.
        let snapshot = registration;
        let registration = self.registration_named(&snapshot.name)?;
        if registration != snapshot {
            return Err(busy());
        }
        let key = self
            .key_for(&registration)
            .ok_or_else(|| key_gone(&registration.name))?;
        let retired = registration.retired().find(|a| a.name == new_name).cloned();
        let fresh = retired.is_none() && new_name != registration.name;
        let alias = if fresh {
            self.claim_name(&new_name)?;
            let result = self.register_alias(&registration, &new_name, &key).await;
            self.release_name(&new_name);
            Some(result?)
        } else {
            retired
        };
        if let Err(error) = self.save_alias(&registration, alias.as_ref()) {
            if let Some(alias) = alias.as_ref().filter(|_| fresh) {
                self.delete_or_retry(&registration.base_url, &key, &alias.name)
                    .await;
            }
            return Err(error);
        }
        let current = self.registration_named(&registration.name)?;
        self.publish_names(&current, &key).await;
        let released = registration.alias_name().map(str::to_owned);
        self.sync_agents().await;
        self.hub.invalidated(Listing::Agents);
        let message = format!(
            "@{} is now @{}. Messages already sent to @{} still arrive.",
            registration.display_name(),
            current.display_name(),
            registration.display_name()
        );
        self.hub.activity(Level::Info, message);
        let address = current.current_address(&self.machine_prefix);
        Ok(Renamed {
            address,
            name: new_name,
            released,
        })
    }

    /// Forgets what delivery holds for an agent that left the relay, under
    /// its name and its alias alike.
    pub(super) fn forget_agent_and_alias(&self, registration: &Registration) {
        for name in registration.names() {
            self.forget_agent(&name);
        }
    }

    /// Drops an alias Relaycast has removed from the agent `name`, so a later
    /// failure removing the agent itself never leaves a stale alias.
    pub(super) fn forget_removed_alias(&self, name: &str, alias: &str) {
        let _ = self.store.update(|store| {
            let Some(mut current) = store.registration_named(name).cloned() else {
                return;
            };
            if current.alias_name() == Some(alias) {
                current.alias = None;
            }
            if let Some(retired) = current.retired_aliases.as_mut() {
                retired.retain(|r| r.alias.name != alias);
            }
            if current.retired_aliases.as_ref().is_some_and(Vec::is_empty) {
                current.retired_aliases = None;
            }
            store.update(current);
        });
    }

    /// Registers `alias` on Relaycast as an agent of its own for the
    /// session `registration` stands for.
    async fn register_alias(
        &self,
        registration: &Registration,
        alias: &str,
        key: &Secret,
    ) -> Result<AgentAlias, RpcError> {
        let base = &registration.base_url;
        let workspace = self.relaycast_scope(base, key);
        let owner = self.agent_owner();
        let mut metadata = self.metadata(
            &registration.target,
            &registration.title,
            None,
            owner.as_ref(),
        );
        metadata.insert("alias_of".into(), json!(registration.name));
        let prefix = registration
            .machine_prefix
            .clone()
            .unwrap_or_else(|| self.machine_prefix.clone());
        let result = client::register_agent(base, key, alias, &prefix, metadata).await;
        self.observe_relaycast_write_result(&workspace, &result);
        let agent = result.map_err(|error| {
            if is_name_taken(&error) {
                RpcError::new(
                    ErrorKind::Conflict,
                    format!("@{alias} is already taken in this workspace. Choose another name."),
                )
            } else {
                relaycast_error(
                    &error,
                    format!("Could not register @{alias} on Agent Relay."),
                )
            }
        })?;
        Ok(AgentAlias {
            name: agent.name,
            agent_id: agent.id,
            token: agent.token,
            registered_at: iso8601_now(),
        })
    }

    /// Releases an alias the store no longer holds. It retires first, so
    /// its push channel stays open while what it was sent is delivered,
    /// then leaves Relaycast (retried until it is gone).
    /// The answer for a session already on the relay. A name it asks for
    /// that is not its current one replaces it, as a rename does: one name
    /// per session. The session's lock is released for the rename.
    pub(super) async fn answer_registered(
        &self,
        existing: Registration,
        raw_name: Option<&str>,
        changing: tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<Registered, RpcError> {
        let asked = raw_name
            .and_then(normalize_name)
            .filter(|name| name != existing.display_name());
        let Some(asked) = asked else {
            return Ok(already_registered(&existing, &self.machine_prefix));
        };
        drop(changing);
        let renamed = self.rename(&existing.name, &asked).await?;
        Ok(Registered {
            name: renamed.name,
            address: renamed.address,
            already_registered: true,
        })
    }

    /// One name per session: every earlier name only forwards what was sent
    /// to it, so it names the current one (`renamed_to`, which rosters hide
    /// it by) and is marked idle; the current name's marker is cleared.
    async fn publish_names(&self, registration: &Registration, key: &Secret) {
        for name in registration.names() {
            self.publish_marker(&name, key).await;
        }
    }

    /// Publishes `name`'s marker, or queues it to be tried again.
    async fn publish_marker(&self, name: &str, key: &Secret) {
        let lock = self.roster_locks.get(name);
        let _publishing = lock.lock().await;
        // A lifecycle pass may have completed while this write waited.
        let Some(registration) = self.store.read(|s| s.registration_answering(name).cloned())
        else {
            return self.forget_name_marker(name);
        };
        let current = registration.display_name();
        let renamed_to = if name == current { "" } else { current };
        let mut metadata = Map::new();
        metadata.insert("renamed_to".into(), json!(renamed_to));
        metadata.insert(
            "session_title".into(),
            json!(published_title(&registration.title)),
        );
        let handoff_revision = self
            .roster_revision
            .load(std::sync::atomic::Ordering::SeqCst);
        metadata.extend(self.mobile_handoff_metadata(&registration));
        if matches!(
            registration.target.kind,
            SessionKind::OpenClaw | SessionKind::Hermes
        ) {
            metadata.insert("session_scope".into(), json!("agent"));
        }
        let status = self.roster_status(&registration, name);
        let base = &registration.base_url;
        // Relaycast activates PATCHes with no status. Always send the current
        // state, serialized with presence updates so older writes finish first.
        let result = client::update_agent_metadata(base, key, name, metadata, Some(status)).await;
        self.observe_relaycast_write_result(&self.relaycast_scope(base, key), &result);
        let name = name.to_owned();
        let _ = self.store.remember(|s| {
            // A native title setter can publish while this PATCH is in flight.
            // Only acknowledge the snapshot the server actually received.
            let unchanged = s.registration_answering(&name) == Some(&registration)
                && self
                    .roster_revision
                    .load(std::sync::atomic::Ordering::SeqCst)
                    == handoff_revision;
            let list = s.pending_name_markers.get_or_insert_with(Vec::new);
            list.retain(|pending| pending != &name);
            if result.is_err() || !unchanged {
                list.push(name);
            }
            if list.is_empty() {
                s.pending_name_markers = None;
            }
        });
    }

    /// Refresh titles and forwarding markers once after start, including
    /// registrations created before titles were published to the roster.
    pub(super) fn backfill_name_markers(&self) {
        let _ = self.store.remember(|s| {
            let renamed: Vec<String> = s
                .registrations
                .iter()
                .filter(|r| r.spawn.is_none() && r.archived_at.is_none())
                .flat_map(Registration::names)
                .collect();
            let list = s.pending_name_markers.get_or_insert_with(Vec::new);
            for name in renamed {
                if !list.contains(&name) {
                    list.push(name);
                }
            }
            if list.is_empty() {
                s.pending_name_markers = None;
            }
        });
    }

    /// The periodic pass over names: markers Relaycast has not confirmed are
    /// published as they stand now, and replaced aliases that have forwarded
    /// for `RETIRED_FORWARDING` are released.
    pub(super) async fn retry_name_markers(&self) {
        let pending = self
            .store
            .read(|s| s.pending_name_markers.clone().unwrap_or_default());
        for name in pending {
            self.retry_name_marker(&name).await;
        }
        self.release_expired_aliases().await;
    }

    /// Under the session's lock, as a rename publishes: a rename in progress
    /// is waited out (and tried next pass), and the marker sent is the one
    /// the registration has now, never one read before the rename.
    async fn retry_name_marker(&self, name: &str) {
        let target = self
            .store
            .read(|s| s.registration_answering(name).map(|r| r.target.key()));
        let Some(target) = target else {
            return self.forget_name_marker(name);
        };
        let lock = self.target_locks.get(&target);
        let Ok(_changing) = lock.try_lock() else {
            return;
        };
        let current = self.store.read(|s| s.registration_answering(name).cloned());
        let Some(registration) = current else {
            return self.forget_name_marker(name);
        };
        let Some(key) = self.key_for(&registration) else {
            return;
        };
        if self.relaycast_write_allowed(&self.relaycast_scope(&registration.base_url, &key)) {
            self.publish_marker(name, &key).await;
        }
    }

    fn forget_name_marker(&self, name: &str) {
        let _ = self.store.remember(|s| {
            s.pending_name_markers
                .iter_mut()
                .for_each(|l| l.retain(|n| n != name))
        });
    }

    /// Releases each replaced alias that has forwarded for
    /// `RETIRED_FORWARDING` and has no refusal left to settle. It leaves the
    /// store and is queued for removal from Relaycast in the same save, so
    /// the cleanup pass removes it (and retries until it is gone).
    async fn release_expired_aliases(&self) {
        let now = chrono::Utc::now();
        let due: Vec<(String, String)> = self.store.read(|s| {
            s.registrations
                .iter()
                .flat_map(|r| {
                    r.retired_aliases
                        .iter()
                        .flatten()
                        .filter(|retired| retired.expired(now))
                        .filter(|retired| !s.has_pending_refusal(&retired.alias.agent_id))
                        .map(|retired| (r.name.clone(), retired.alias.name.clone()))
                })
                .collect()
        });
        let mut released = false;
        for (name, alias) in due {
            released |= self.release_expired_alias(&name, &alias).await;
        }
        if released {
            self.sync_agents().await;
            self.hub.invalidated(Listing::Agents);
        }
    }

    /// Under the session's lock and the alias's own delivery lock, so a
    /// delivery to it in flight finishes (and journals any refusal) first;
    /// expiry and refusals are checked again under both. Kept, forwarding,
    /// while no key can remove it from Relaycast.
    async fn release_expired_alias(&self, name: &str, alias: &str) -> bool {
        let Some(registration) = self.store.read(|s| s.registration_named(name).cloned()) else {
            return false;
        };
        let Some(key) = self.key_for(&registration) else {
            return false;
        };
        let lock = self.target_locks.get(&registration.target.key());
        let Ok(_changing) = lock.try_lock() else {
            return false;
        };
        let _delivering = self.agent_locks.get(alias).lock_owned().await;
        let now = chrono::Utc::now();
        let Ok(Some(agent_id)) = self.store.update(|s| {
            let mut current = s.registration_named(name)?.clone();
            let retired = current.retired_aliases.as_mut()?;
            let at = retired.iter().position(|r| r.alias.name == alias)?;
            let still_due =
                retired[at].expired(now) && !s.has_pending_refusal(&retired[at].alias.agent_id);
            if !still_due {
                return None;
            }
            let expired = retired.remove(at);
            if retired.is_empty() {
                current.retired_aliases = None;
            }
            s.add_pending_cleanup(PendingCleanup {
                kind: CleanupKind::Agent,
                name: alias.to_owned(),
                base_url: current.base_url.clone(),
                workspace_key: key,
            });
            s.update(current);
            Some(expired.alias.agent_id)
        }) else {
            return false;
        };
        let _ = self.store.remember(|s| s.retire_refusals(&agent_id));
        self.forget_agent(alias);
        self.forget_name_marker(alias);
        true
    }

    /// Saves `alias` as the session's name. The alias it replaces is kept,
    /// forwarding for `RETIRED_FORWARDING`, in the same save; one taken up
    /// again leaves that list.
    fn save_alias(
        &self,
        registration: &Registration,
        alias: Option<&AgentAlias>,
    ) -> Result<(), RpcError> {
        let saved = self.store.update(|store| {
            let Some(mut current) = store.registration_named(&registration.name).cloned() else {
                return false;
            };
            if current.agent_id != registration.agent_id {
                return false;
            }
            let taken_up = alias.map(|a| a.name.as_str());
            let mut retired = current.retired_aliases.take().unwrap_or_default();
            retired.retain(|r| Some(r.alias.name.as_str()) != taken_up);
            if let Some(replaced) = current.alias.take() {
                retired.push(RetiredAlias {
                    alias: replaced,
                    retired_at: iso8601_now(),
                });
            }
            current.retired_aliases = (!retired.is_empty()).then_some(retired);
            current.alias = alias.cloned();
            store.update(current);
            true
        });
        match saved {
            Ok(true) => Ok(()),
            Ok(false) => Err(not_registered(&registration.name)),
            Err(error) => Err(RpcError::store(&error)),
        }
    }

    fn retiring(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, (Registration, Secret)>> {
        self.retiring.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Holds `name` for a pending removal, as `claim_name` does, unless it is
    /// an alias still draining: that one is removed once it is done.
    pub(super) fn claim_cleanup_name(&self, name: &str) -> bool {
        !self.retiring().contains_key(name) && self.claim_name(name).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aliased() -> Registration {
        let mut registration: Registration = serde_json::from_value(json!({
            "name": "original", "agentID": "a1",
            "target": {"kind": "codex", "id": "01a0c221-6806-7210-af25-97e104b15049"},
            "baseURL": "https://cast.example", "registeredAt": "2026-10-14T00:00:00Z",
        }))
        .unwrap();
        registration.alias = Some(AgentAlias {
            name: "nickname".into(),
            agent_id: "a2".into(),
            token: Secret::new("at_alias"),
            registered_at: "2026-10-14T00:00:00Z".into(),
        });
        registration
    }

    #[test]
    fn an_alias_follows_its_session_presence_and_shows_its_channel() {
        let mut store = Store::default();
        store.registrations.push(aliased());
        assert_eq!(present_registration_names(&store), ["nickname"]);
        let waiting = PushState::Waiting { retry_in_ms: 1_000 };
        let push = BTreeMap::from([
            ("original".to_string(), PushState::Live),
            ("nickname".to_string(), waiting.clone()),
        ]);
        assert_eq!(agent_push(&push, &aliased()), Some(waiting));
        let push = BTreeMap::from([("original".to_string(), PushState::Live)]);
        assert_eq!(agent_push(&push, &aliased()), Some(PushState::Live));
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;

    fn registration(name: &str, kind: &str, id: &str) -> Registration {
        serde_json::from_value(json!({
            "name": name, "agentID": name, "target": {"kind": kind, "id": id},
            "title": "Old title", "baseURL": "https://cast.example", "registeredAt": "2026-10-24T00:00:00Z"
        })).unwrap()
    }

    #[test]
    fn native_title_changes_queue_only_the_matching_provider_and_session() {
        let mut store = Store::default();
        store.registrations = vec![
            registration("current", "codex", "same"),
            registration("other", "claude-terminal", "same"),
        ];
        update_registered_title(&mut store, "codex", "same", "Fix delivery");
        assert_eq!(store.registrations[0].title, "Fix delivery");
        assert_eq!(store.registrations[1].title, "Old title");
        assert_eq!(
            store.pending_name_markers.as_deref(),
            Some(["current".to_owned()].as_slice())
        );
        update_registered_title(&mut store, "codex", "same", "Fix delivery");
        assert_eq!(store.pending_name_markers.as_ref().unwrap().len(), 1);
        update_registered_title(&mut store, "codex", "same", "  ");
        assert_eq!(store.registrations[0].title, "Fix delivery");
        assert!(store
            .registrations
            .iter()
            .all(|r| r.missing_since.is_none()));
    }

    #[test]
    fn published_titles_are_bounded_single_line_metadata() {
        assert_eq!(published_title("  Fix\n  delivery \t"), "Fix delivery");
        assert_eq!(published_title(&"é".repeat(210)).chars().count(), 200);
    }
}
