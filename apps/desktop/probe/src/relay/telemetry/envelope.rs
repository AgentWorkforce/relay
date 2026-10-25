//! Versioned desktop identity envelope; authoritative person properties belong to Cloud.

use super::*;

impl Telemetry {
    /// What every event carries. Attached events carry the user's groups;
    /// the rest create no person profile.
    pub(super) fn base_properties(&self, account: Option<&TelemetryAccount>) -> Map<String, Value> {
        let mut properties = Map::new();
        for (key, value) in [
            ("$lib", "agentrelay-desktop"),
            ("$lib_version", self.config.version.as_str()),
            ("$app_version", self.config.version.as_str()),
            ("app", "relay-desktop"),
            ("surface", "desktop"),
            ("emitter", "relay-desktop.core"),
            ("actor_kind", "human"),
            (
                "identity_source",
                if account.is_some() {
                    "cloud_install"
                } else {
                    "anonymous_generation"
                },
            ),
            ("platform", platform()),
            ("environment", "production"),
            ("os_version", self.os_version.as_str()),
            ("probe_version", self.config.version.as_str()),
        ] {
            properties.insert(key.into(), value.into());
        }
        properties.insert("analytics_contract_version".into(), 2.into());
        properties.insert("$geoip_disable".into(), true.into());
        match account {
            Some(account) => {
                let mut groups = Map::new();
                for (kind, id) in [
                    ("organization", &account.organization_id),
                    ("workspace", &account.workspace_id),
                ] {
                    if let Some(id) = id {
                        groups.insert(kind.into(), id.clone().into());
                    }
                }
                if !groups.is_empty() {
                    properties.insert("$groups".into(), Value::Object(groups));
                }
            }
            None => {
                properties.insert("$process_person_profile".into(), false.into());
            }
        }
        properties
    }
}
