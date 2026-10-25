//! The store's three-way merge: `ours` applied on top of `theirs`, both
//! descended from `base` — each entry takes the side that changed it, and
//! `ours` when both did.

use super::*;
use std::collections::{BTreeMap, HashMap, HashSet};

impl Store {
    /// `ours` applied on top of `theirs`, both descended from `base`: each
    /// entry (a registration, a token, a remembered delivery, …) takes the
    /// side that changed it, and `ours` when both did.
    pub fn merged(base: &Store, ours: &Store, theirs: &Store) -> Store {
        // An empty refusal journal can only be a legacy omission: normal
        // bounded eviction leaves a nonempty suffix. Pending settlements use
        // Option so an explicit empty journal can confirm completion.
        // The activation journal follows the same rule.
        let preserves_journals = |side: &Store| {
            (base.refused_delivery_ids.is_empty() || !side.refused_delivery_ids.is_empty())
                && (base.pending_refusal_settlements.is_none()
                    || side.pending_refusal_settlements.is_some())
                && (base.auto_activation_failures.is_none()
                    || side.auto_activation_failures.is_some())
        };
        if ours == base && preserves_journals(theirs) {
            let mut result = theirs.clone();
            preserve_spawn_origins(&mut result, &[ours, base]);
            result.retire_unregistered_refusals(&[base, ours, theirs]);
            return result;
        }
        if theirs == base && preserves_journals(ours) {
            let mut result = ours.clone();
            preserve_spawn_origins(&mut result, &[theirs, base]);
            result.retire_unregistered_refusals(&[base, ours, theirs]);
            return result;
        }
        let (registrations, tokens) = merge_agents(base, ours, theirs);
        let mut result = Store {
            registrations,
            tokens,
            agent_owners: merge_maps(&base.agent_owners, &ours.agent_owners, &theirs.agent_owners),
            allow_self_registration: pick(
                &base.allow_self_registration,
                &ours.allow_self_registration,
                &theirs.allow_self_registration,
            ),
            auto_activate: pick(
                &base.auto_activate,
                &ours.auto_activate,
                &theirs.auto_activate,
            ),
            show_relay_messages: pick(
                &base.show_relay_messages,
                &ours.show_relay_messages,
                &theirs.show_relay_messages,
            ),
            accept_spawns: pick(
                &base.accept_spawns,
                &ours.accept_spawns,
                &theirs.accept_spawns,
            ),
            spawn_full_access_codex: pick(
                &base.spawn_full_access_codex,
                &ours.spawn_full_access_codex,
                &theirs.spawn_full_access_codex,
            ),
            spawn_full_access_claude: pick(
                &base.spawn_full_access_claude,
                &ours.spawn_full_access_claude,
                &theirs.spawn_full_access_claude,
            ),
            spawn_allow_teammates: pick(
                &base.spawn_allow_teammates,
                &ours.spawn_allow_teammates,
                &theirs.spawn_allow_teammates,
            ),
            spawn_max_agents: pick(
                &base.spawn_max_agents,
                &ours.spawn_max_agents,
                &theirs.spawn_max_agents,
            ),
            spawn_billing_codex: pick(
                &base.spawn_billing_codex,
                &ours.spawn_billing_codex,
                &theirs.spawn_billing_codex,
            ),
            spawn_billing_claude: pick(
                &base.spawn_billing_claude,
                &ours.spawn_billing_claude,
                &theirs.spawn_billing_claude,
            ),
            spawn_repositories: pick(
                &base.spawn_repositories,
                &ours.spawn_repositories,
                &theirs.spawn_repositories,
            ),
            spawn_harnesses: merge_maps(
                &base.spawn_harnesses,
                &ours.spawn_harnesses,
                &theirs.spawn_harnesses,
            ),
            auto_activation_events: pick(
                &base.auto_activation_events,
                &ours.auto_activation_events,
                &theirs.auto_activation_events,
            ),
            auto_activation_failures: activation_failures::merge_activation_failures(
                base, ours, theirs,
            ),
            agent_led_defaults_applied: pick(
                &base.agent_led_defaults_applied,
                &ours.agent_led_defaults_applied,
                &theirs.agent_led_defaults_applied,
            ),
            integration_defaults_applied: union(
                &ours.integration_defaults_applied,
                &theirs.integration_defaults_applied,
            ),
            extras: SettingsExtras::merged(&base.extras, &ours.extras, &theirs.extras),
            cloud: pick(&base.cloud, &ours.cloud, &theirs.cloud),
            cloud_session: pick(
                &base.cloud_session,
                &ours.cloud_session,
                &theirs.cloud_session,
            ),
            desktop_sync_source_id: if base.desktop_sync_source_id.is_none() {
                theirs
                    .desktop_sync_source_id
                    .clone()
                    .or_else(|| ours.desktop_sync_source_id.clone())
            } else {
                pick(
                    &base.desktop_sync_source_id,
                    &ours.desktop_sync_source_id,
                    &theirs.desktop_sync_source_id,
                )
            },
            desktop_identity_clears_pending: {
                let normalized = |list: Option<&Vec<DesktopIdentityClear>>| {
                    list.into_iter()
                        .flatten()
                        .map(DesktopIdentityClear::normalized)
                        .collect::<Vec<_>>()
                };
                non_empty(merge_keyed(
                    &normalized(base.desktop_identity_clears_pending.as_ref()),
                    &normalized(ours.desktop_identity_clears_pending.as_ref()),
                    &normalized(theirs.desktop_identity_clears_pending.as_ref()),
                    |clear| clear.request_id.clone(),
                ))
            },
            pending_cleanups: non_empty(merge_keyed(
                base.pending_cleanups.as_deref().unwrap_or_default(),
                ours.pending_cleanups.as_deref().unwrap_or_default(),
                theirs.pending_cleanups.as_deref().unwrap_or_default(),
                |c| c.clone(),
            )),
            pending_key_migrations: non_empty(merge_keyed(
                base.pending_key_migrations.as_deref().unwrap_or_default(),
                ours.pending_key_migrations.as_deref().unwrap_or_default(),
                theirs.pending_key_migrations.as_deref().unwrap_or_default(),
                |owed| (owed.base_url.clone(), owed.old_key.clone()),
            )),
            pending_key_migration_legacy: None,
            pending_name_markers: non_empty(merge_keyed(
                base.pending_name_markers.as_deref().unwrap_or_default(),
                ours.pending_name_markers.as_deref().unwrap_or_default(),
                theirs.pending_name_markers.as_deref().unwrap_or_default(),
                |n| n.clone(),
            )),
            archived_sessions: {
                let mut merged = merge_keyed(
                    base.archived_sessions.as_deref().unwrap_or_default(),
                    ours.archived_sessions.as_deref().unwrap_or_default(),
                    theirs.archived_sessions.as_deref().unwrap_or_default(),
                    |a| (a.name.clone(), a.archived_at.clone()),
                );
                merged.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
                merged.truncate(ARCHIVED_SESSIONS_KEPT);
                non_empty(merged)
            },
            test_senders: {
                let empty = BTreeMap::new();
                let merged = merge_maps(
                    base.test_senders.as_ref().unwrap_or(&empty),
                    ours.test_senders.as_ref().unwrap_or(&empty),
                    theirs.test_senders.as_ref().unwrap_or(&empty),
                );
                (!merged.is_empty()).then_some(merged)
            },
            replies: non_empty(merge_keyed(
                base.replies.as_deref().unwrap_or_default(),
                ours.replies.as_deref().unwrap_or_default(),
                theirs.replies.as_deref().unwrap_or_default(),
                |r| (r.agent_id.clone(), r.message_id.clone()),
            )),
            reply_routes: non_empty(merge_keyed(
                base.reply_routes.as_deref().unwrap_or_default(),
                ours.reply_routes.as_deref().unwrap_or_default(),
                theirs.reply_routes.as_deref().unwrap_or_default(),
                |r| (r.agent_id.clone(), r.message_id.clone()),
            )),
            injected_delivery_ids: merge_keyed(
                &base.injected_delivery_ids,
                &ours.injected_delivery_ids,
                &theirs.injected_delivery_ids,
                |id| id.clone(),
            ),
            refused_delivery_ids: merge_keyed(
                &base.refused_delivery_ids,
                if ours.refused_delivery_ids.is_empty() {
                    &base.refused_delivery_ids
                } else {
                    &ours.refused_delivery_ids
                },
                if theirs.refused_delivery_ids.is_empty() {
                    &base.refused_delivery_ids
                } else {
                    &theirs.refused_delivery_ids
                },
                |id| id.clone(),
            ),
            pending_refusal_settlements: if base.pending_refusal_settlements.is_none()
                && ours.pending_refusal_settlements.is_none()
                && theirs.pending_refusal_settlements.is_none()
            {
                None
            } else {
                Some(merge_keyed(
                    base.pending_refusal_settlements
                        .as_deref()
                        .unwrap_or_default(),
                    ours.pending_refusal_settlements
                        .as_deref()
                        .or(base.pending_refusal_settlements.as_deref())
                        .unwrap_or_default(),
                    theirs
                        .pending_refusal_settlements
                        .as_deref()
                        .or(base.pending_refusal_settlements.as_deref())
                        .unwrap_or_default(),
                    |pending| pending.delivery_id.clone(),
                ))
            },
            in_doubt_delivery_ids: merge_keyed(
                &base.in_doubt_delivery_ids,
                &ours.in_doubt_delivery_ids,
                &theirs.in_doubt_delivery_ids,
                |id| id.clone(),
            ),
        };
        for list in [
            &mut result.in_doubt_delivery_ids,
            &mut result.refused_delivery_ids,
        ] {
            if list.len() > REMEMBERED_DELIVERIES {
                list.drain(..list.len() - REMEMBERED_DELIVERIES);
            }
        }
        result.keep_one_registration_per_target(ours);
        result.release_dropped_aliases(base, &[ours, theirs]);
        let live_ids: HashSet<&str> = result
            .registrations
            .iter()
            .map(|r| r.agent_id.as_str())
            .collect();
        result
            .agent_owners
            .retain(|id, _| live_ids.contains(id.as_str()));
        result.retire_unregistered_refusals(&[base, ours, theirs]);
        result.drop_cleanups_of_kept_agents();
        // A session registered on either side is not blocked; merge bounds
        // the journal to the newest blockers.
        result.tidy_activation_failures();
        preserve_spawn_origins(&mut result, &[ours, theirs, base]);
        result
    }

    /// Two processes that each registered the same session leave two agents
    /// on it. The one in `ours` is kept, as `add` would; the other is queued
    /// for removal from Relaycast so it is not orphaned.
    fn keep_one_registration_per_target(&mut self, ours: &Store) {
        let ours_names: HashSet<&str> =
            ours.registrations.iter().map(|r| r.name.as_str()).collect();
        let mut kept: HashMap<Target, usize> = HashMap::new();
        let mut dropped: Vec<usize> = Vec::new();
        for (index, registration) in self.registrations.iter().enumerate() {
            match kept.get(&registration.target).copied() {
                None => {
                    kept.insert(registration.target.clone(), index);
                }
                Some(existing) => {
                    let existing_ours =
                        ours_names.contains(self.registrations[existing].name.as_str());
                    if !existing_ours && ours_names.contains(registration.name.as_str()) {
                        kept.insert(registration.target.clone(), index);
                        dropped.push(existing);
                    } else {
                        dropped.push(index);
                    }
                }
            }
        }
        if dropped.is_empty() {
            return;
        }
        let dropped: Vec<Registration> = dropped
            .into_iter()
            .map(|index| self.registrations[index].clone())
            .collect();
        let names: HashSet<String> = dropped.iter().map(|r| r.name.clone()).collect();
        self.registrations.retain(|r| !names.contains(&r.name));
        for registration in dropped {
            self.tokens.remove(&registration.name);
            for cleanup in registration.alias_cleanups() {
                self.add_pending_cleanup(cleanup);
            }
            if let Some(key) = registration.workspace_key {
                self.add_pending_cleanup(PendingCleanup {
                    kind: CleanupKind::Agent,
                    name: registration.name,
                    base_url: registration.base_url,
                    workspace_key: key,
                });
            }
        }
    }

    /// An agent queued for removal that the merged store still holds would
    /// be deleted out from under it on the next cleanup pass.
    fn drop_cleanups_of_kept_agents(&mut self) {
        if let Some(mut list) = self.pending_cleanups.take() {
            // Matched by name and origin, not key: one workspace can have
            // several keys, and deleting a kept agent through another of them
            // would take it offline.
            let live: HashSet<(String, String)> = self
                .credentials()
                .into_iter()
                .map(|(r, _)| (r.name, r.base_url))
                .collect();
            list.retain(|c| {
                c.kind != CleanupKind::Agent
                    || !live.contains(&(c.name.clone(), c.base_url.clone()))
            });
            self.pending_cleanups = (!list.is_empty()).then_some(list);
        }
    }
}

/// `ours` if this process changed it (a removal included), else `theirs`.
/// Both sides' entries, once each: a default applied on either side stays
/// applied, so it is never applied twice.
fn union(ours: &Option<Vec<String>>, theirs: &Option<Vec<String>>) -> Option<Vec<String>> {
    if ours.is_none() && theirs.is_none() {
        return None;
    }
    let mut all: Vec<String> = theirs.clone().unwrap_or_default();
    for entry in ours.iter().flatten() {
        if !all.contains(entry) {
            all.push(entry.clone());
        }
    }
    Some(all)
}

fn pick<T: Clone + PartialEq>(base: &T, ours: &T, theirs: &T) -> T {
    if ours == base {
        theirs.clone()
    } else {
        ours.clone()
    }
}

/// A list merged entry by entry: `theirs`' order, then entries only `ours`
/// has. An entry removed on either side stays removed.
fn merge_keyed<T: Clone + PartialEq, K: std::hash::Hash + Eq>(
    base: &[T],
    ours: &[T],
    theirs: &[T],
    key: impl Fn(&T) -> K,
) -> Vec<T> {
    let mut base_by_key: HashMap<K, &T> = HashMap::new();
    for entry in base {
        base_by_key.entry(key(entry)).or_insert(entry);
    }
    let mut ours_by_key: HashMap<K, &T> = HashMap::new();
    for entry in ours {
        ours_by_key.entry(key(entry)).or_insert(entry);
    }
    let mut seen: HashSet<K> = HashSet::new();
    let mut result = Vec::new();
    for entry in theirs {
        let k = key(entry);
        let base = base_by_key.get(&k).copied().cloned();
        let ours = ours_by_key.get(&k).copied().cloned();
        if !seen.insert(k) {
            continue;
        }
        if let Some(value) = pick(&base, &ours, &Some(entry.clone())) {
            result.push(value);
        }
    }
    for entry in ours {
        let k = key(entry);
        let base = base_by_key.get(&k).copied().cloned();
        if !seen.insert(k) {
            continue;
        }
        if let Some(value) = pick(&base, &Some(entry.clone()), &None) {
            result.push(value);
        }
    }
    result
}

fn merge_maps<V: Clone + PartialEq>(
    base: &BTreeMap<String, V>,
    ours: &BTreeMap<String, V>,
    theirs: &BTreeMap<String, V>,
) -> BTreeMap<String, V> {
    let keys: HashSet<&String> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    keys.into_iter()
        .filter_map(|k| {
            pick(
                &base.get(k).cloned(),
                &ours.get(k).cloned(),
                &theirs.get(k).cloned(),
            )
            .map(|v| (k.clone(), v))
        })
        .collect()
}

fn non_empty<T>(list: Vec<T>) -> Option<Vec<T>> {
    (!list.is_empty()).then_some(list)
}

/// Registrations and their tokens, merged per agent name. A removal on
/// either side wins over an edit on the other: the removed agent may already
/// be gone from Relaycast, and its token with it.
fn merge_agents(
    base: &Store,
    ours: &Store,
    theirs: &Store,
) -> (Vec<Registration>, BTreeMap<String, Secret>) {
    type Agent = (Registration, Option<Secret>);
    let agents = |store: &Store| -> Vec<Agent> {
        store
            .registrations
            .iter()
            .map(|r| (r.clone(), store.tokens.get(&r.name).cloned()))
            .collect()
    };
    let names = |store: &Store| -> HashSet<String> {
        store.registrations.iter().map(|r| r.name.clone()).collect()
    };
    let (base_names, ours_names, theirs_names) = (names(base), names(ours), names(theirs));
    let merged: Vec<Agent> = merge_keyed(&agents(base), &agents(ours), &agents(theirs), |a| {
        a.0.name.clone()
    })
    .into_iter()
    .filter(|(registration, _)| {
        let name = &registration.name;
        !base_names.contains(name) || (ours_names.contains(name) && theirs_names.contains(name))
    })
    .collect();
    let mut tokens = BTreeMap::new();
    for (registration, token) in &merged {
        if let Some(token) = token {
            tokens.insert(registration.name.clone(), token.clone());
        }
    }
    (merged.into_iter().map(|(r, _)| r).collect(), tokens)
}

/// An older writer may omit fields it does not understand. Spawn origin
/// cannot be cleared on the same registration: removal deletes the row,
/// and taking over updates the origin. Never transfer it to a replacement.
fn preserve_spawn_origins(result: &mut Store, sources: &[&Store]) {
    for row in result.registrations.iter_mut().filter(|r| r.spawn.is_none()) {
        if let Some(old) = sources.iter().flat_map(|s| &s.registrations).find(|old| {
            old.spawn.is_some() && old.name == row.name && old.agent_id == row.agent_id && old.target == row.target
                && old.base_url == row.base_url && old.workspace_key == row.workspace_key
        }) {
            row.spawn = old.spawn.clone();
            // A writer that cannot recognize a spawn cannot determine its
            // presence either. Keep the spawn-aware writer's observation,
            // including a genuine missing mark, until lifecycle reconciles it.
            row.missing_since = old.missing_since.clone();
        }
    }
}
