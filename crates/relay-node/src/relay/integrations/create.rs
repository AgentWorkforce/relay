//! Journal and create one already-validated provider subscription.
use super::*;
pub(super) struct SubscriptionIntent {
    pub provider: String,
    pub resource: String,
    pub workspace: String,
    pub glob: String,
    pub event_types: Vec<String>,
}
impl Core {
    pub(super) async fn finish_subscription(
        &self,
        registration: &Registration,
        key: &Secret,
        intent: SubscriptionIntent,
    ) -> Result<IntegrationChange, RpcError> {
        let SubscriptionIntent {
            provider,
            resource,
            workspace,
            glob,
            event_types,
        } = intent;
        let provider = provider.as_str();
        let resource = resource.as_str();
        let name = registration.name.as_str();
        let files = self.relayfile(&workspace).await?;
        let base = &registration.base_url;
        let agent_id = &registration.agent_id;
        let mut entry = Integration::new(provider, resource, &workspace);
        entry.path_glob = Some(glob.clone());
        entry.event_types = event_types.clone();
        // Journaled before even the shared channel is created; its name is
        // derived from the agent, so cleanup can recover a lost answer.
        self.save_integration(agent_id, &entry)?;
        let http =
            sdk_gaps::http(base, key).map_err(|e| relaycast(&e, "Could not reach Agent Relay."))?;
        let channel = sdk_gaps::subscription_channel(&http, name, agent_id)
            .await
            .map_err(|e| relaycast(&e, "The agent's event channel did not verify."))?;
        self.store
            .update(|store| {
                if let Some(mut current) = store.registration_named(name).cloned() {
                    current.integration_channel_id = Some(channel.id.clone());
                    current.integration_channel_name = Some(channel.name.clone());
                    store.update(current);
                }
            })
            .map_err(|e| RpcError::store(&e))?;
        let (writeback_url, writeback_secret) = files.writeback_secret(&channel.name).await?;
        let inbound = sdk_gaps::relayfile_inbound_target(&http, &channel.name, provider, &glob)
            .await
            .map_err(|e| relaycast(&e, "Could not create the inbound target."))?;
        let unsafe_url =
            || failed("relayfile or Agent Relay returned an address that is not https.");
        entry.inbound_url = Some(attempt_url(&inbound.url, &entry.id).ok_or_else(unsafe_url)?);
        entry.writeback_url = Some(attempt_url(&writeback_url, &entry.id).ok_or_else(unsafe_url)?);
        self.save_integration(agent_id, &entry)?;
        let inbound_url = entry.inbound_url.clone().unwrap_or_default();
        entry.cloud_subscription_id = Some(
            files
                .create_subscription(
                    &inbound_url,
                    std::slice::from_ref(&glob),
                    &inbound.secret,
                    &event_types,
                )
                .await?,
        );
        self.save_integration(agent_id, &entry)?;
        let writeback = entry.writeback_url.clone().unwrap_or_default();
        entry.subscription_id = Some(
            client::create_reply_subscription(
                base,
                key,
                &channel.name,
                &writeback,
                &writeback_secret,
            )
            .await
            .map_err(|e| relaycast(&e, "Could not create the reply subscription."))?,
        );
        entry.ready = Some(true);
        self.save_integration(agent_id, &entry)?;
        self.request_drain(name);
        self.hub.invalidated(Listing::Agents);
        Ok(IntegrationChange {
            subscribed: true,
            event_types,
            provider: provider.into(),
            resource: resource.into(),
            path_glob: Some(glob),
            already_unsubscribed: false,
        })
    }
}
