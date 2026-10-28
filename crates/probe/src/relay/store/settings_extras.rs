//! Settings the store keeps beside its older flat fields: whether agents
//! registered from now on join #general, and the record of the settings
//! agents changed on the session socket (`PATCH /settings`). Flattened into
//! the store's JSON, so both keys sit at its top level.

use super::*;
use crate::relay::contract::agents::AgentSettingsChange;

/// How many agent changes the store remembers, newest first.
pub const AGENT_CHANGES_KEPT: usize = 20;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsExtras {
    /// Missing means true: the spawning agent's DMs use native input.
    #[serde(
        rename = "spawnNativeInput",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub spawn_native_input: Option<bool>,
    /// Missing means true: a teammate's direct message to a Claude Code
    /// session with Agent Relay's plugin starts a user turn.
    #[serde(
        rename = "teammateNativeInput",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub teammate_native_input: Option<bool>,
    /// Missing means false: agents are registered outside #general.
    #[serde(
        rename = "autoJoinGeneral",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_join_general: Option<bool>,
    /// Newest first, at most `AGENT_CHANGES_KEPT`.
    #[serde(
        rename = "agentSettingsChanges",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub agent_changes: Vec<AgentSettingsChange>,
}

impl SettingsExtras {
    /// Puts `changes` (oldest first) at the front of the record, keeping
    /// the newest `AGENT_CHANGES_KEPT`.
    pub fn record(&mut self, changes: Vec<AgentSettingsChange>) {
        for change in changes {
            self.agent_changes.insert(0, change);
        }
        self.agent_changes.truncate(AGENT_CHANGES_KEPT);
    }

    /// Each side's new records kept, newest first by time; the flag takes
    /// the side that changed it.
    pub fn merged(base: &Self, ours: &Self, theirs: &Self) -> Self {
        let flag = if ours.auto_join_general != base.auto_join_general {
            ours.auto_join_general
        } else {
            theirs.auto_join_general
        };
        let mut changes = ours.agent_changes.clone();
        for change in &theirs.agent_changes {
            if !changes.contains(change) {
                changes.push(change.clone());
            }
        }
        changes.sort_by(|a, b| b.at.cmp(&a.at));
        changes.truncate(AGENT_CHANGES_KEPT);
        SettingsExtras {
            auto_join_general: flag,
            spawn_native_input: if ours.spawn_native_input != base.spawn_native_input {
                ours.spawn_native_input
            } else {
                theirs.spawn_native_input
            },
            teammate_native_input: if ours.teammate_native_input != base.teammate_native_input {
                ours.teammate_native_input
            } else {
                theirs.teammate_native_input
            },
            agent_changes: changes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(at: &str, key: &str) -> AgentSettingsChange {
        AgentSettingsChange {
            at: at.into(),
            by: "api".into(),
            key: key.into(),
            from: Some("false".into()),
            to: "true".into(),
        }
    }

    #[test]
    fn the_record_keeps_the_newest_first_and_is_bounded() {
        let mut extras = SettingsExtras::default();
        let many = (0..AGENT_CHANGES_KEPT + 5)
            .map(|i| change(&format!("2026-10-16T00:00:{i:02}Z"), "auto_join_general"))
            .collect();
        extras.record(many);
        assert_eq!(extras.agent_changes.len(), AGENT_CHANGES_KEPT);
        assert_eq!(extras.agent_changes[0].at, "2026-10-16T00:00:24Z");
    }

    #[test]
    fn a_merge_keeps_both_sides_records_and_the_changed_flag() {
        let base = SettingsExtras::default();
        let ours = SettingsExtras {
            auto_join_general: Some(true),
            spawn_native_input: None,
            teammate_native_input: Some(false),
            agent_changes: vec![change("2026-10-16T00:00:02Z", "auto_join_general")],
        };
        let theirs = SettingsExtras {
            auto_join_general: None,
            spawn_native_input: Some(true),
            teammate_native_input: None,
            agent_changes: vec![change("2026-10-16T00:00:03Z", "auto_activate")],
        };
        let merged = SettingsExtras::merged(&base, &ours, &theirs);
        assert_eq!(merged.auto_join_general, Some(true));
        assert_eq!(merged.spawn_native_input, Some(true));
        assert_eq!(merged.teammate_native_input, Some(false));
        let keys: Vec<_> = merged
            .agent_changes
            .iter()
            .map(|c| c.key.as_str())
            .collect();
        assert_eq!(keys, ["auto_activate", "auto_join_general"]);
        let theirs_flag = SettingsExtras {
            auto_join_general: Some(false),
            ..SettingsExtras::default()
        };
        assert_eq!(
            SettingsExtras::merged(&base, &base, &theirs_flag).auto_join_general,
            Some(false)
        );
    }

    #[test]
    fn the_keys_sit_at_the_stores_top_level() {
        let mut store = Store::default();
        store.extras.auto_join_general = Some(true);
        store.extras.spawn_native_input = Some(true);
        store
            .extras
            .record(vec![change("2026-10-16T00:00:00Z", "auto_activate")]);
        let value = serde_json::to_value(&store).unwrap();
        assert_eq!(value["autoJoinGeneral"], true);
        assert_eq!(value["spawnNativeInput"], true);
        assert_eq!(value["agentSettingsChanges"][0]["by"], "api");
        let back: Store = serde_json::from_value(value).unwrap();
        assert_eq!(back.extras, store.extras);
    }
}
