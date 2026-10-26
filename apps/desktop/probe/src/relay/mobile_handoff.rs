//! Authenticated owner turns delivered by the installed Claude mod. A peer
//! message never enters this queue. Input goes to the current native session;
//! no process is stopped, resumed, backgrounded, or given a different policy.

use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::inject::InjectOutcome;
use crate::relay::spawn::drive::direct_from;
use crate::relay::store::{Registration, SessionKind};

pub(crate) mod journal;
pub(crate) use journal::Binding;
pub use journal::Runtime;

pub(crate) fn eligible(registration: &Registration) -> bool {
    registration.target.kind == SessionKind::ClaudeTerminal
        && registration
            .spawn
            .as_ref()
            .is_none_or(|spawn| spawn.taken_over_at.is_some())
}

fn scope(registration: &Registration) -> String {
    MessageRef::of(&format!(
        "{}\n{}\n{}\n{}",
        registration.base_url,
        registration.agent_id,
        registration.target.key(),
        registration
            .workspace_key
            .as_ref()
            .map(|key| key.expose())
            .unwrap_or_default()
    ))
}

impl Core {
    /// Alias views can name a session only through the current stored
    /// registration. The immutable original agent keeps one queue across
    /// renames; a matching target alone is never enough authority.
    pub(crate) fn mobile_handoff_registration(
        &self,
        incoming: &Registration,
    ) -> Option<Registration> {
        self.store.read(|store| {
            store
                .registration_for(&incoming.target)
                .filter(|canonical| {
                    canonical.base_url == incoming.base_url
                        && canonical.workspace_key == incoming.workspace_key
                        && canonical.agent_ids().contains(&incoming.agent_id)
                })
                .cloned()
        })
    }

    pub(crate) fn mobile_handoff_disabled(&self) -> Result<(), String> {
        journal::edit(&self.config.app_data_dir, |queue| {
            queue.cancel();
            Ok(())
        })
    }

    /// Explicit login revocation ends its native generation, even if the same
    /// process is shared again. Keep receipts so leased input cannot replay.
    pub(crate) fn mobile_handoff_roots_revoked(
        &self,
        targets: &std::collections::BTreeSet<crate::relay::store::Target>,
    ) -> Result<(), String> {
        if targets.is_empty() {
            return Ok(());
        }
        let registrations = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|registration| targets.contains(&registration.target))
                .cloned()
                .collect::<Vec<_>>()
        });
        let scopes = registrations.iter().map(scope).collect();
        journal::edit(&self.config.app_data_dir, |queue| {
            queue.cancel_scopes(&scopes);
            Ok(())
        })?;
        for registration in &registrations {
            self.mobile_handoff_changed(registration);
        }
        Ok(())
    }

    /// A previously leased native message never falls back to a peer inbox,
    /// even after opt-out or a change to the current human's authority.
    pub(crate) async fn previous_mobile_delivery(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        native: bool,
    ) -> Option<InjectOutcome> {
        if registration.target.kind != SessionKind::ClaudeTerminal
            || !self
                .config
                .app_data_dir
                .join("mobile-claude-handoff/queue.json")
                .exists()
        {
            return None;
        }
        let canonical = self.mobile_handoff_registration(registration);
        let key = canonical.as_ref().map(scope);
        let (outcome, pending) =
            match self.mobile_receipt(registration, key.as_deref(), &delivery.id, true) {
                Ok(receipt) => receipt,
                Err(reason) => return Some(InjectOutcome::Retry(reason)),
            };
        let Some(pending) = pending else {
            // Unknown IDs and terminal receipts never require a Cloud lookup.
            return outcome.map(delivery_outcome);
        };
        let mut authorized = self.mobile_receipt_retained(registration, &pending.scope);
        if authorized && !native {
            // The earlier native classification may have observed missing
            // discovery proof just before it recovered. Recheck the owner,
            // independently of admission, only for a known pending receipt.
            // Unknown verification preserves bounded waiting, never execution.
            if let Some(current) = canonical.as_ref() {
                if let Some((_, owner)) = self.verified_owner(current).await {
                    authorized = owner == pending.owner && direct_from(delivery, Some(&owner));
                }
            }
        }
        authorized &= self.mobile_receipt_retained(registration, &pending.scope);
        match self.mobile_receipt(registration, Some(&pending.scope), &delivery.id, authorized) {
            Ok((outcome, _)) => outcome.map(delivery_outcome),
            Err(reason) => Some(InjectOutcome::Retry(reason)),
        }
    }

    fn mobile_receipt_retained(&self, registration: &Registration, expected: &str) -> bool {
        self.mobile_handoff_registration(registration)
            .is_some_and(|current| {
                scope(&current) == expected
                    && eligible(&current)
                    && self
                        .store
                        .read(|store| store.mobile_claude_handoff == Some(true))
                    && self.mobile_claude_plugins.retains_receipt(&current.target)
            })
    }

    fn mobile_receipt(
        &self,
        registration: &Registration,
        scope: Option<&str>,
        delivery_id: &str,
        authorized: bool,
    ) -> Result<(Option<journal::Outcome>, Option<Binding>), String> {
        let result = journal::edit(&self.config.app_data_dir, |queue| {
            let Some(key) = scope else {
                return Ok((
                    queue
                        .contains_delivery(delivery_id)
                        .then_some(journal::Outcome::InDoubt),
                    None,
                    false,
                ));
            };
            let before = (queue.status(key), queue.notice(key));
            let outcome = queue
                .previous(key, delivery_id, authorized, crate::relay::state::now_ms())
                .or_else(|| {
                    queue
                        .contains_delivery(delivery_id)
                        .then_some(journal::Outcome::InDoubt)
                });
            let pending = queue.pending_binding(key, delivery_id);
            Ok((
                outcome,
                pending,
                before != (queue.status(key), queue.notice(key)),
            ))
        })?;
        if result.2 {
            self.mobile_handoff_changed(registration);
        }
        Ok((result.0, result.1))
    }

    pub(crate) fn mobile_handoff_control_valid(
        &self,
        binding: &Binding,
        runtime: &Runtime,
        token: &str,
        confirmed: bool,
    ) -> bool {
        journal::edit(&self.config.app_data_dir, |queue| {
            Ok(queue.control_valid(binding, runtime, token, confirmed))
        })
        .unwrap_or(false)
    }

    pub(crate) fn mobile_handoff_pending(
        &self,
        registration: &Registration,
    ) -> Result<bool, String> {
        if !self.mobile_handoff_enabled(registration)
            || !self
                .config
                .app_data_dir
                .join("mobile-claude-handoff/queue.json")
                .exists()
        {
            return Ok(false);
        }
        let Some(canonical) = self.mobile_handoff_registration(registration) else {
            return Ok(false);
        };
        journal::edit(&self.config.app_data_dir, |queue| {
            Ok(queue.pending(&scope(&canonical)))
        })
    }

    pub(crate) fn prune_mobile_handoff_runtimes(&self) -> Result<(), String> {
        if !self
            .config
            .app_data_dir
            .join("mobile-claude-handoff/queue.json")
            .exists()
        {
            return Ok(());
        }
        let registrations = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|registration| eligible(registration))
                .cloned()
                .collect::<Vec<_>>()
        });
        let changed = journal::edit(&self.config.app_data_dir, |queue| {
            Ok(queue.prune_active(|binding, expected| {
                registrations.iter().any(|registration| {
                    scope(registration) == binding.scope
                        && self.plugins.sessions.mobile_claude_incarnation(expected) != Some(false)
                })
            }))
        })?;
        // Both the journal and store locks are released before roster
        // invalidations are queued. No Cloud lookup or write occurs here.
        for registration in registrations
            .iter()
            .filter(|registration| changed.contains(&scope(registration)))
        {
            self.mobile_handoff_changed(registration);
        }
        Ok(())
    }

    pub(crate) fn mobile_handoff_metadata(
        &self,
        registration: &Registration,
    ) -> serde_json::Map<String, serde_json::Value> {
        let canonical = self.mobile_handoff_registration(registration);
        let registration = canonical.as_ref().unwrap_or(registration);
        let enabled = canonical.is_some() && self.mobile_handoff_enabled(registration);
        let (mut status, notice, confirmed) = if enabled {
            journal::edit(&self.config.app_data_dir, |queue| {
                let scope = scope(registration);
                Ok((
                    queue.status(&scope).unwrap_or_default(),
                    queue.notice(&scope),
                    queue.confirmed_runtime(&scope),
                ))
            })
            .unwrap_or_default()
        } else {
            ("", "", None)
        };
        if status == "ready"
            && !confirmed.is_some_and(|expected| {
                self.plugins
                    .sessions
                    .mobile_claude_runtime(&registration.target, expected.pid)
                    .is_some_and(|current| {
                        (current.pid, current.start) == (expected.pid, expected.start)
                    })
            })
        {
            status = "";
        }
        serde_json::json!({"mobile_handoff_enabled": enabled, "mobile_handoff_state": status, "mobile_handoff_error": notice})
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    pub(crate) fn mobile_handoff_changed(&self, registration: &Registration) {
        let canonical = self.mobile_handoff_registration(registration);
        let registration = canonical.as_ref().unwrap_or(registration);
        let _ = self.store.remember(|store| {
            self.roster_revision
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let pending = store.pending_name_markers.get_or_insert_with(Vec::new);
            for name in registration.names() {
                if !pending.contains(&name) {
                    pending.push(name);
                }
            }
        });
    }

    pub(crate) fn mobile_handoff_enabled(&self, registration: &Registration) -> bool {
        crate::relay::claude_mobile_plugin::supported()
            && eligible(registration)
            && self.mobile_claude_plugins.contains(&registration.target)
            && self
                .store
                .read(|store| store.mobile_claude_handoff == Some(true))
    }

    pub(crate) async fn mobile_handoff_binding(
        &self,
        registration: &Registration,
    ) -> Option<Binding> {
        if !self.mobile_handoff_enabled(registration) {
            return None;
        }
        let canonical = self.mobile_handoff_registration(registration)?;
        let (_, owner) = self.verified_owner(&canonical).await?;
        Some(Binding {
            scope: scope(&canonical),
            owner,
        })
    }

    pub(crate) async fn mobile_owner_turn(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> bool {
        if !direct_from(delivery, delivery.sender_id.as_deref()) {
            return false;
        }
        self.mobile_handoff_binding(registration)
            .await
            .is_some_and(|binding| direct_from(delivery, Some(&binding.owner)))
    }

    pub(crate) async fn deliver_mobile_owner(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        text: &str,
    ) -> InjectOutcome {
        let Some(binding) = self
            .mobile_handoff_binding(registration)
            .await
            .filter(|binding| direct_from(delivery, Some(&binding.owner)))
        else {
            return InjectOutcome::Refused(
                "The signed-in machine owner could not be verified.".into(),
            );
        };
        let result = journal::edit(&self.config.app_data_dir, |queue| {
            let key = binding.scope.clone();
            let before = (queue.status(&key), queue.notice(&key));
            queue.prune(|id| self.store.read(|store| store.was_handled(id)));
            let outcome =
                queue.enqueue(binding, &delivery.id, text, crate::relay::state::now_ms())?;
            let changed = before != (queue.status(&key), queue.notice(&key));
            Ok((outcome, changed))
        });
        if result.as_ref().is_ok_and(|(_, changed)| *changed) {
            self.mobile_handoff_changed(registration);
        }
        let result = result.map(|(outcome, _)| outcome);
        result
            .map(delivery_outcome)
            .unwrap_or_else(InjectOutcome::Retry)
    }
}

fn delivery_outcome(outcome: journal::Outcome) -> InjectOutcome {
    match outcome {
            journal::Outcome::Started => InjectOutcome::Delivered,
            journal::Outcome::Waiting => {
                InjectOutcome::Waiting("Waiting for Claude's mobile control mod.".into())
            }
            journal::Outcome::Unavailable => InjectOutcome::Refused("Restart or reload Claude to enable mobile control, then send the message again. This message was not submitted.".into()),
            journal::Outcome::Failed => InjectOutcome::Refused(
                "Claude could not start the mobile message. The message was not submitted.".into(),
            ),
            journal::Outcome::InDoubt => InjectOutcome::InDoubt(
                "Claude's native submission was not confirmed; the message will not be sent again."
                    .into(),
            ),
    }
}

#[cfg(all(test, unix))]
mod tests;
