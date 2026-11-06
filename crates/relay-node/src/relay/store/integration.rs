use super::random_uuid;
use serde::{Deserialize, Serialize};

/// A relayfile subscription, journaled before anything external is created
/// and kept until setup or cleanup finishes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Integration {
    pub id: String,
    pub provider: String,
    pub resource: String,
    #[serde(rename = "workspaceID")]
    pub workspace_id: String,
    #[serde(rename = "pathGlob", default, skip_serializing_if = "Option::is_none")]
    pub path_glob: Option<String>,
    /// None means an older writer omitted the field; Some([]) is explicitly broad.
    #[serde(
        rename = "eventTypes",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub event_types: Option<Vec<String>>,
    #[serde(
        rename = "inboundURL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub inbound_url: Option<String>,
    #[serde(
        rename = "writebackURL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub writeback_url: Option<String>,
    #[serde(rename = "webhookID", default, skip_serializing_if = "Option::is_none")]
    pub webhook_id: Option<String>,
    #[serde(
        rename = "cloudSubscriptionID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cloud_subscription_id: Option<String>,
    #[serde(
        rename = "subscriptionID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub subscription_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
    /// A terminal provider event was delivered; cleanup must converge even
    /// if its first cloud request or the process stops before `ready` flips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<bool>,
}

impl Integration {
    pub fn new(provider: &str, resource: &str, workspace_id: &str) -> Integration {
        Integration {
            id: random_uuid(),
            provider: provider.into(),
            resource: resource.into(),
            workspace_id: workspace_id.into(),
            path_glob: None,
            event_types: Some(Vec::new()),
            inbound_url: None,
            writeback_url: None,
            webhook_id: None,
            cloud_subscription_id: None,
            subscription_id: None,
            ready: None,
            terminal: None,
        }
    }

    /// Legacy records with no filter retain the broad subscription contract.
    pub fn effective_event_types(&self) -> &[String] {
        self.event_types.as_deref().unwrap_or_default()
    }

    /// The Relaycast webhook name earlier versions created per subscription.
    pub fn webhook_name(&self) -> String {
        format!("desktop-integration-{}", self.id)
    }
}

/// Legacy writers cannot clear a field they do not know. Explicit empty lists
/// remain meaningful, and a removed integration is never resurrected.
pub(super) fn preserve_filters(result: &mut super::Store, sources: &[&super::Store]) {
    for registration in &mut result.registrations {
        for entry in registration.integrations.iter_mut().flatten() {
            if entry.event_types.is_some() {
                continue;
            }
            entry.event_types = sources
                .iter()
                .flat_map(|store| &store.registrations)
                .filter(|old| old.agent_id == registration.agent_id)
                .flat_map(|old| old.integrations.iter().flatten())
                .find(|old| {
                    old.id == entry.id
                        && old.provider == entry.provider
                        && old.workspace_id == entry.workspace_id
                        && old.path_glob == entry.path_glob
                        && old.event_types.is_some()
                })
                .and_then(|old| old.event_types.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    /// Round-trip exact filters while preserving the meaning of a legacy omitted field.
    fn event_filters_survive_storage_and_legacy_entries_remain_broad() {
        let mut integration = Integration::new("jira", "/jira/issues/**", "rw_test");
        integration.event_types = Some(vec!["comment.created".into()]);
        let mut value = serde_json::to_value(&integration).unwrap();
        assert_eq!(value["eventTypes"], serde_json::json!(["comment.created"]));
        assert_eq!(
            serde_json::from_value::<Integration>(value.clone()).unwrap(),
            integration
        );
        value.as_object_mut().unwrap().remove("eventTypes");
        assert!(serde_json::from_value::<Integration>(value)
            .unwrap()
            .event_types
            .is_none());
    }
    #[test]
    /// Cover both merge fast paths, concurrent writes, explicit clearing and removal.
    fn merge_preserves_omitted_filters_but_respects_explicit_empty_and_removal() {
        use super::super::{Registration, SessionKind, Store, Target};
        let registration: Registration = serde_json::from_value(serde_json::json!({
            "name": "agent",
            "agentID": "a1",
            "target": serde_json::to_value(Target::new(SessionKind::Codex,"session")).unwrap(),
            "baseURL": "https://relay.test",
            "registeredAt": "2026-11-05T00:00:00Z",
        }))
        .unwrap();
        let mut base = Store::default();
        let mut registration = registration;
        let mut integration = Integration::new("jira", "/jira/**", "rw_test");
        integration.event_types = Some(vec!["comment.created".into()]);
        registration.integrations = Some(vec![integration]);
        base.registrations.push(registration);
        let mut legacy = base.clone();
        legacy.registrations[0].integrations.as_mut().unwrap()[0].event_types = None;
        let mut concurrent = base.clone();
        concurrent.auto_activate = Some(true);
        for merged in [
            Store::merged(&base, &legacy, &base),
            Store::merged(&base, &base, &legacy),
            Store::merged(&base, &concurrent, &legacy),
        ] {
            assert_eq!(
                merged.registrations[0].integrations.as_ref().unwrap()[0].effective_event_types(),
                &["comment.created"]
            );
        }
        let mut explicit = base.clone();
        explicit.registrations[0].integrations.as_mut().unwrap()[0].event_types = Some(vec![]);
        assert!(Store::merged(&base, &explicit, &base).registrations[0]
            .integrations
            .as_ref()
            .unwrap()[0]
            .effective_event_types()
            .is_empty());
        let mut removed = base.clone();
        removed.registrations[0].integrations = None;
        assert!(Store::merged(&base, &removed, &base).registrations[0]
            .integrations
            .is_none());
    }
}
