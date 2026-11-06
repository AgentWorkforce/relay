//! Route integration deliveries only after setup or cleanup has settled.
use super::policy::{decide_for_agent, decide_for_agent_with_integrations, Decision};
use super::{Core, Delivery, DeliveryOutcome, Registration, Secret, WorkspaceScope};
use std::sync::Arc;

impl Core {
    /// A busy integration mutation leaves the delivery queued. Re-read under
    /// its lock so a snapshot captured before the ready save cannot drop an
    /// event after successful setup. DM and other channel routing never waits.
    fn integration_delivery_decision(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Option<(Registration, Decision)> {
        // A queue snapshot can predate the first shared-channel creation.
        // Identify the current channel before choosing the nonblocking lane.
        let prior_channel = registration.integration_channel_id.as_deref();
        let current = self
            .agent_credential(&registration.name)
            .filter(|(current, _)| current.agent_id == registration.agent_id)?
            .0;
        let registration = &current;
        let webhook = registration
            .webhook
            .as_ref()
            .map(|entry| entry.channel_id.as_str());
        let channel = registration.integration_channel_id.as_deref();
        let from =
            |channel: Option<&str>| channel.is_some() && delivery.channel_id.as_deref() == channel;
        if !from(channel) && !from(prior_channel) {
            return Some((
                registration.clone(),
                decide_for_agent(delivery, &registration.name, webhook, channel),
            ));
        }
        // Setup takes target then integration; delivery already holds agent.
        // Never wait in the reverse order, and release before any remote ack.
        let _integrating = self.integration_lock.try_lock().ok()?;
        let current = self
            .agent_credential(&registration.name)
            .filter(|(current, _)| current.agent_id == registration.agent_id)?
            .0;
        let decision =
            if current.integration_channel_id.as_deref() != delivery.channel_id.as_deref() {
                Decision::Skip("the integration channel was removed".into())
            } else {
                decide_for_agent_with_integrations(
                    delivery,
                    &current.name,
                    current
                        .webhook
                        .as_ref()
                        .map(|entry| entry.channel_id.as_str()),
                    current.integration_channel_id.as_deref(),
                    current.integrations.as_deref().unwrap_or_default(),
                )
            };
        Some((current, decision))
    }

    /// Coalesce a whole deferred queue page into one timer for this identity.
    /// Replacing an identity under the same name can schedule its own retry.
    fn retry_integration_later(self: &Arc<Self>, registration: &Registration) -> bool {
        {
            let Ok(mut state) = self.delivery.lock() else {
                return false;
            };
            if state.integration_retries.get(&registration.name) == Some(&registration.agent_id) {
                return false;
            }
            state
                .integration_retries
                .insert(registration.name.clone(), registration.agent_id.clone());
        }
        let core = self.clone();
        let registration = registration.clone();
        let delay = self.config.delivery_timing.retry_unit;
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if core.take_integration_retry(&registration) && core.current(&registration) {
                core.request_drain(&registration.name);
            }
        });
        true
    }

    /// Clear only this timer's pending flag; an older timer cannot cancel a
    /// replacement identity's retry after removal or re-registration.
    fn take_integration_retry(&self, registration: &Registration) -> bool {
        let Ok(mut state) = self.delivery.lock() else {
            return false;
        };
        let owns =
            state.integration_retries.get(&registration.name) == Some(&registration.agent_id);
        if owns {
            state.integration_retries.remove(&registration.name);
        }
        owns
    }

    /// Settle a definite skip, admit an injection, or defer without settlement
    /// while integration setup/cleanup owns the routing state.
    pub(super) async fn admit_delivery(
        self: &Arc<Self>,
        registration: &Registration,
        delivery: &Delivery,
        workspace: &WorkspaceScope,
        token: &Secret,
    ) -> Option<Registration> {
        let Some((current, decision)) = self.integration_delivery_decision(registration, delivery)
        else {
            // A push wake may have been consumed while another agent owns
            // setup. Retry independently of the long live-push safety poll.
            self.retry_integration_later(registration);
            return None;
        };
        let Decision::Skip(reason) = decision else {
            return Some(current);
        };
        let _ = self
            .relaycast_ack(workspace, &registration.base_url, token, &delivery.id)
            .await;
        self.record(
            registration,
            delivery,
            DeliveryOutcome::Skipped,
            Some(reason),
        );
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::daemon::{Config, Plugins};
    use crate::relay::delivery::DeliveryTiming;
    use crate::relay::paths::CorePaths;
    use crate::relay::push::PushTiming;
    use crate::relay::store::Integration;
    use std::time::Duration;

    /// A stale queue snapshot must observe channel creation and the final ready
    /// save, while active setup defers even without a subscription entry.
    #[tokio::test]
    async fn busy_setup_defers_without_an_entry_and_unlocked_admission_rereads_ready_state() {
        let temp = tempfile::tempdir().unwrap();
        let config = Config {
            paths: CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: Default::default(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let (core, _signals) = Core::with_plugins(config, Plugins::default());
        let old: Registration = serde_json::from_value(serde_json::json!({
            "name": "agent",
            "agentID": "a1",
            "target": {"kind": "codex", "id": "session"},
            "baseURL": "https://relay.test",
            "registeredAt": 1790683200.0,
            "integrationChannelID": "events",
        }))
        .unwrap();
        core.store
            .update(|store| {
                store.registrations.push(old.clone());
                store
                    .tokens
                    .insert(old.name.clone(), Secret::new("fixture"));
            })
            .unwrap();
        let event = Delivery {
            channel_id: Some("events".into()),
            text: Some(
                "Jira comment.created\nRelayfile path: /jira/issues/KAN-1/comments/9.json".into(),
            ),
            ..Delivery::default()
        };
        let busy = core.integration_lock.lock().await;
        let mut before_channel_creation = old.clone();
        before_channel_creation.integration_channel_id = None;
        assert!(core
            .integration_delivery_decision(&before_channel_creation, &event)
            .is_none());
        assert!(core.integration_delivery_decision(&old, &event).is_none());
        let dm = Delivery {
            reason: Some("dm".into()),
            text: Some("hello".into()),
            ..Delivery::default()
        };
        assert!(matches!(
            core.integration_delivery_decision(&old, &dm),
            Some((_, Decision::Inject))
        ));
        let mut current = old.clone();
        let mut held = Integration::new("jira", "/jira/issues/**", "rw_test");
        held.path_glob = Some(held.resource.clone());
        held.event_types = Some(vec!["comment.created".into()]);
        current.integrations = Some(vec![held]);
        core.store
            .update(|store| store.update(current.clone()))
            .unwrap();
        drop(busy);
        assert!(matches!(
            core.integration_delivery_decision(&old, &event),
            Some((_, Decision::Skip(_)))
        ));
        current.integrations.as_mut().unwrap()[0].ready = Some(true);
        core.store
            .update(|store| store.update(current.clone()))
            .unwrap();
        let (fresh, decision) = core
            .integration_delivery_decision(&before_channel_creation, &event)
            .unwrap();
        assert_eq!(decision, Decision::Inject);
        assert_eq!(fresh.integrations.unwrap()[0].ready, Some(true));
        // A batch shares one retry, and an old timer cannot clear a newer
        // immutable identity's flag under the same name.
        assert!(core.retry_integration_later(&old));
        for _ in 0..20 {
            assert!(!core.retry_integration_later(&old));
        }
        let mut replacement = old.clone();
        replacement.agent_id = "a2".into();
        assert!(core.retry_integration_later(&replacement));
        assert!(!core.take_integration_retry(&old));
        assert!(core.take_integration_retry(&replacement));
        assert!(!core.take_integration_retry(&replacement));
        assert!(core.retry_integration_later(&replacement));
        core.forget_agent(&replacement.name);
        assert!(!core.take_integration_retry(&replacement));
        current.integration_channel_id = None;
        current.integrations = None;
        core.store.update(|store| store.update(current)).unwrap();
        assert!(matches!(
            core.integration_delivery_decision(&old, &event),
            Some((_, Decision::Skip(_)))
        ));
    }
}
