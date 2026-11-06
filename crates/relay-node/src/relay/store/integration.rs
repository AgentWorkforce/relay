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
    #[serde(rename = "eventTypes", default, skip_serializing_if = "Vec::is_empty")]
    pub event_types: Vec<String>,
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
            event_types: Vec::new(),
            inbound_url: None,
            writeback_url: None,
            webhook_id: None,
            cloud_subscription_id: None,
            subscription_id: None,
            ready: None,
            terminal: None,
        }
    }

    /// The Relaycast webhook name earlier versions created per subscription.
    pub fn webhook_name(&self) -> String {
        format!("desktop-integration-{}", self.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn event_filters_survive_storage_and_legacy_entries_remain_broad() {
        let mut integration = Integration::new("jira", "/jira/issues/**", "rw_test");
        integration.event_types = vec!["comment.created".into()];
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
            .is_empty());
    }
}
