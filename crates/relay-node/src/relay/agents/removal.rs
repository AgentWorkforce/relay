//! Removing agents after their deliveries settle, including explicit end of
//! a session Agent Relay spawned and still owns.

use super::roster_publication::rejected_keys::KeyProof;
use super::{key_gone, removal_guards};
use crate::relay::client;
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::state::{Level, Listing};
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemovalMode {
    /// An ordinary Receive messages change. Integrations must be removed first.
    User,
    /// Confirmed Upload Off also removes integrations belonging to the session.
    UploadExcluded,
    /// Automatic cleanup after an archived session has settled its refusals.
    Archived,
    /// The explicit End Agent action: stop the owned spawn, then remove all
    /// relay resources that belonged to it.
    EndSpawned,
}

impl RemovalMode {
    fn removes_integrations(self) -> bool {
        self != RemovalMode::User
    }
}

impl Core {
    /// Takes the agent off the relay: after any delivery in flight finishes,
    /// its webhook, integration channel and Relaycast identity are removed,
    /// followed by the local registration.
    pub async fn unregister(&self, name: &str) -> Result<(), RpcError> {
        self.unregister_with_integrations(name, RemovalMode::User)
            .await
    }

    /// The person confirmed taking this session off the relay while deleting
    /// its Cloud copy: [`Core::unregister`], integrations included, for both
    /// manual and automatic registrations.
    pub async fn unregister_upload_excluded(&self, name: &str) -> Result<(), RpcError> {
        self.unregister_with_integrations(name, RemovalMode::UploadExcluded)
            .await
    }

    /// Ends an agent this computer spawned and still owns, then removes its
    /// relay identity. The action lock serializes this with a Cloud release
    /// or take over; removal's delivery locks keep a new turn from starting
    /// between the last check and the stop.
    pub async fn end_spawned_agent(&self, name: &str) -> Result<(), RpcError> {
        let _agent = self.lock_spawn_action(name).await;
        self.unregister_with_integrations(name, RemovalMode::EndSpawned)
            .await
    }

    pub(super) async fn unregister_archived(&self, name: &str) -> Result<(), RpcError> {
        self.unregister_with_integrations(name, RemovalMode::Archived)
            .await
    }

    async fn unregister_with_integrations(
        &self,
        name: &str,
        mode: RemovalMode,
    ) -> Result<(), RpcError> {
        let registration = self.registration_named(name)?;
        let (_changing, _delivering) = removal_guards(
            &self.target_locks,
            &self.agent_locks,
            &registration.target.key(),
            name,
        )
        .await;
        let registration = self.registration_named(name)?;
        // A delivery in flight through any alias finishes first, too.
        let mut _delivering_aliases = Vec::new();
        for alias in registration.names().into_iter().skip(1) {
            _delivering_aliases.push(self.agent_locks.get(&alias).lock_owned().await);
        }
        if !self.prepare_removal(&registration, name, mode).await? {
            return Ok(());
        }
        let key = self.key_for(&registration).ok_or_else(|| key_gone(name))?;
        let mut removed = self.remove_remotely(&registration, name, &key).await;
        if let Err(error) = &removed {
            match self.prove_rejected_key(&registration, &key, error).await {
                KeyProof::Current(current) => {
                    removed = self.remove_remotely(&registration, name, &current).await;
                }
                KeyProof::Unreachable => {
                    self.leave_unreachable(&registration, name).await;
                    removed = Ok(());
                }
                KeyProof::Unknown => {}
            }
        }
        removed.map_err(|error| {
            let mut mapped = RpcError::from_relaycast(&error);
            let status = match &error {
                relaycast::RelayError::Api { status, .. } => format!(" (HTTP {status})"),
                _ => String::new(),
            };
            mapped.message = format!(
                "Could not remove @{name} from Agent Relay{status}. {} The registration was kept; retry when the connection is working.",
                mapped.message,
            );
            mapped
        })?;
        self.store
            .update(|store| store.remove(name))
            .map_err(|error| {
                RpcError::new(
                    ErrorKind::StoreFailed,
                    format!("@{name} was removed from Agent Relay, but this computer could not save that. {error}"),
                )
            })?;
        self.stop_spawned(&registration);
        self.forget_agent_and_alias(&registration);
        self.sync_agents().await;
        self.hub.invalidated(Listing::Agents);
        let left = match registration.alias_name() {
            Some(alias) => format!("@{alias} (@{name}) left the relay."),
            None => format!("@{name} left the relay."),
        };
        self.hub.activity(Level::Info, left);
        Ok(())
    }

    /// Takes an agent whose saved key's workspace is out of reach off this
    /// computer only. Its webhook is revoked by its id with the current key,
    /// in case it lives in this computer's workspace (its agent record was
    /// deleted there by hand); a webhook elsewhere answers not found and is
    /// untouched. Nothing is removed by name. What may be left is named,
    /// before the registration that recorded it is dropped.
    async fn leave_unreachable(&self, registration: &Registration, name: &str) {
        let mut left = Vec::new();
        if let Some(webhook) = &registration.webhook {
            let current = self
                .workspace()
                .filter(|w| w.base_url == registration.base_url);
            let revoked = match current {
                Some(current) => {
                    let base = &registration.base_url;
                    let result = client::delete_webhook(base, &current.key, &webhook.id).await;
                    self.observe_relaycast_write_result(
                        &self.relaycast_scope(base, &current.key),
                        &result,
                    );
                    result.is_ok()
                }
                None => false,
            };
            let state = if revoked {
                "unless this workspace held it, "
            } else {
                ""
            };
            left.push(format!(
                "webhook {} ({}, {state}still live) and its channel #{}",
                webhook.id, webhook.url, webhook.channel_name
            ));
        }
        if let Some(channel) = &registration.integration_channel_name {
            left.push(format!("integration channel #{channel}"));
        }
        if registration.has_integrations() {
            left.push("integration subscriptions".into());
        }
        let rest = if left.is_empty() {
            String::new()
        } else {
            format!(" Remove its {} in that workspace.", left.join(", "))
        };
        self.hub.activity(
            Level::Warning,
            format!("@{name}'s workspace no longer accepts the key it registered with, and this computer's workspace does not hold this agent, so it was taken off this computer only; whatever it has in the workspace it registered with stays there.{rest}"),
        );
    }

    /// Removes `registration`'s webhook and integration channel with `key`.
    async fn remove_resources(
        &self,
        registration: &Registration,
        key: &Secret,
    ) -> relaycast::Result<()> {
        let base = &registration.base_url;
        if let Some(webhook) = &registration.webhook {
            client::delete_webhook(base, key, &webhook.id).await?;
            client::delete_channel(base, key, &webhook.channel_name).await?;
        }
        if let Some(channel) = &registration.integration_channel_name {
            client::delete_channel(base, key, channel).await?;
        }
        Ok(())
    }

    /// Removes `registration`'s webhook, integration channel and every
    /// name from Relaycast with `key`.
    async fn remove_remotely(
        &self,
        registration: &Registration,
        name: &str,
        key: &Secret,
    ) -> relaycast::Result<()> {
        let base = &registration.base_url;
        let removed = async {
            self.remove_resources(registration, key).await?;
            // Every name is released together. Aliases go first, each
            // forgotten as soon as it is gone, so a failure removing the
            // registered name never leaves a stale alias.
            for alias in registration.names().into_iter().skip(1) {
                client::delete_agent(base, key, &alias).await?;
                self.forget_removed_alias(name, &alias);
            }
            client::delete_agent(base, key, name).await
        }
        .await;
        self.observe_relaycast_write_result(&self.relaycast_scope(base, key), &removed);
        removed
    }

    /// Validates the selected removal under its delivery locks. Archive
    /// cleanup can be deferred without error while a refusal still settles.
    async fn prepare_removal(
        &self,
        registration: &Registration,
        name: &str,
        mode: RemovalMode,
    ) -> Result<bool, RpcError> {
        if mode == RemovalMode::Archived
            && self.store.read(|s| s.has_pending_refusal_for(registration))
        {
            return Ok(false);
        }
        if registration.has_integrations() && !mode.removes_integrations() {
            return Err(RpcError::new(
                ErrorKind::Refused,
                "Unsubscribe or clean up integrations before removing this agent.",
            ));
        }
        if mode == RemovalMode::EndSpawned {
            let Some(spawn) = registration.spawn.as_ref() else {
                return Err(RpcError::new(
                    ErrorKind::Refused,
                    format!("Agent Relay did not spawn @{name}; take it off the relay instead."),
                ));
            };
            if spawn.taken_over_at.is_some() {
                return Err(RpcError::new(
                    ErrorKind::Refused,
                    format!("Agent Relay no longer runs @{name}; take it off the relay without ending its session."),
                ));
            }
        }
        self.keep_spawn_receipt(registration)?;
        if mode == RemovalMode::EndSpawned {
            self.end_spawned(registration).await.map_err(|reason| {
                RpcError::new(
                    ErrorKind::Internal,
                    format!("Could not end @{name}: {reason}. The agent was kept; try again."),
                )
            })?;
        }
        Ok(true)
    }
}
