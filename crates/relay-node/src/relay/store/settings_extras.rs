//! Settings the store keeps beside its older flat fields: whether agents
//! registered from now on join #general, whether the tools found on this
//! computer are connected once the person signs in, and the record of the
//! settings agents changed on the session socket (`PATCH /settings`).
//! Flattened into the store's JSON, so the keys sit at its top level.

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
    /// Missing means on in Agent Relay Dev and off in the release build: the
    /// spawning agent may answer its session's approvals
    /// (`spawn::settings::requester_approvals`).
    #[serde(
        rename = "spawnRequesterApprovals",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub spawn_requester_approvals: Option<bool>,
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
    /// Missing means true: once signed in, the tools found here are
    /// connected (`Core::apply_integration_defaults`).
    #[serde(
        rename = "connectDetectedTools",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub connect_detected_tools: Option<bool>,
    /// Missing means false: an open Pi session joins only when added. On,
    /// it joins by itself while `auto_activate` is on (`pi_auto_activate`).
    #[serde(
        rename = "piAutoActivate",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub pi_auto_activate: Option<bool>,
    /// As `pi_auto_activate`, for an open OpenCode session
    /// (`opencode_auto_activate`).
    #[serde(
        rename = "opencodeAutoActivate",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub opencode_auto_activate: Option<bool>,
    /// Missing means true: a Claude Code session's `AskUserQuestion` goes to
    /// `question_escalation_inbox` over Agent Relay instead of its dialog
    /// (`relay::question`). Only an explicit false (`off`) shows the dialog;
    /// it is kept, as any set flag is, through a reload and a merge.
    #[serde(
        rename = "questionEscalation",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub question_escalation: Option<bool>,
    /// The agent that escalated questions go to. Missing means the owner's
    /// person identity.
    #[serde(
        rename = "questionEscalationInbox",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub question_escalation_inbox: Option<String>,
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

    /// Each side's new records kept, newest first by time; each flag takes
    /// the side that changed it.
    pub fn merged(base: &Self, ours: &Self, theirs: &Self) -> Self {
        fn changed<T: Clone + PartialEq>(
            base: &Option<T>,
            ours: &Option<T>,
            theirs: &Option<T>,
        ) -> Option<T> {
            if ours != base {
                ours.clone()
            } else {
                theirs.clone()
            }
        }
        let mut changes = ours.agent_changes.clone();
        for change in &theirs.agent_changes {
            if !changes.contains(change) {
                changes.push(change.clone());
            }
        }
        changes.sort_by(|a, b| b.at.cmp(&a.at));
        changes.truncate(AGENT_CHANGES_KEPT);
        SettingsExtras {
            auto_join_general: changed(
                &base.auto_join_general,
                &ours.auto_join_general,
                &theirs.auto_join_general,
            ),
            connect_detected_tools: changed(
                &base.connect_detected_tools,
                &ours.connect_detected_tools,
                &theirs.connect_detected_tools,
            ),
            spawn_native_input: changed(
                &base.spawn_native_input,
                &ours.spawn_native_input,
                &theirs.spawn_native_input,
            ),
            spawn_requester_approvals: changed(
                &base.spawn_requester_approvals,
                &ours.spawn_requester_approvals,
                &theirs.spawn_requester_approvals,
            ),
            teammate_native_input: changed(
                &base.teammate_native_input,
                &ours.teammate_native_input,
                &theirs.teammate_native_input,
            ),
            pi_auto_activate: changed(
                &base.pi_auto_activate,
                &ours.pi_auto_activate,
                &theirs.pi_auto_activate,
            ),
            opencode_auto_activate: changed(
                &base.opencode_auto_activate,
                &ours.opencode_auto_activate,
                &theirs.opencode_auto_activate,
            ),
            question_escalation: changed(
                &base.question_escalation,
                &ours.question_escalation,
                &theirs.question_escalation,
            ),
            question_escalation_inbox: changed(
                &base.question_escalation_inbox,
                &ours.question_escalation_inbox,
                &theirs.question_escalation_inbox,
            ),
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
            spawn_requester_approvals: Some(true),
            teammate_native_input: Some(false),
            pi_auto_activate: Some(true),
            agent_changes: vec![change("2026-10-16T00:00:02Z", "auto_join_general")],
            ..SettingsExtras::default()
        };
        let theirs = SettingsExtras {
            auto_join_general: None,
            spawn_native_input: Some(true),
            spawn_requester_approvals: None,
            teammate_native_input: None,
            connect_detected_tools: Some(false),
            opencode_auto_activate: Some(true),
            question_escalation: Some(true),
            question_escalation_inbox: Some("lead".into()),
            agent_changes: vec![change("2026-10-16T00:00:03Z", "auto_activate")],
            ..SettingsExtras::default()
        };
        let merged = SettingsExtras::merged(&base, &ours, &theirs);
        assert_eq!(merged.auto_join_general, Some(true));
        assert_eq!(merged.connect_detected_tools, Some(false));
        assert_eq!(merged.spawn_native_input, Some(true));
        assert_eq!(merged.spawn_requester_approvals, Some(true));
        assert_eq!(merged.teammate_native_input, Some(false));
        assert_eq!(merged.pi_auto_activate, Some(true));
        assert_eq!(merged.opencode_auto_activate, Some(true));
        assert_eq!(merged.question_escalation, Some(true));
        assert_eq!(merged.question_escalation_inbox.as_deref(), Some("lead"));
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

    /// Question escalation is on unless turned off, so an explicit off must
    /// never be lost to a merge: kept when either side set it and the other
    /// left it, or when the other side changed only other settings.
    #[test]
    fn a_merge_keeps_an_explicit_question_escalation_off() {
        let unset = SettingsExtras::default();
        let off = SettingsExtras {
            question_escalation: Some(false),
            ..SettingsExtras::default()
        };
        assert_eq!(
            SettingsExtras::merged(&unset, &off, &unset).question_escalation,
            Some(false)
        );
        assert_eq!(
            SettingsExtras::merged(&unset, &unset, &off).question_escalation,
            Some(false)
        );
        // Already off in the base: another process writing other settings
        // (or the inbox) keeps it off.
        let other = SettingsExtras {
            auto_join_general: Some(true),
            question_escalation_inbox: Some("lead".into()),
            ..off.clone()
        };
        for (ours, theirs) in [(&off, &other), (&other, &off)] {
            let merged = SettingsExtras::merged(&off, ours, theirs);
            assert_eq!(merged.question_escalation, Some(false));
            assert_eq!(merged.auto_join_general, Some(true));
        }
        // An explicit on is kept the same way.
        let on = SettingsExtras {
            question_escalation: Some(true),
            ..SettingsExtras::default()
        };
        assert_eq!(
            SettingsExtras::merged(&unset, &on, &unset).question_escalation,
            Some(true)
        );
        assert_eq!(
            SettingsExtras::merged(&unset, &unset, &on).question_escalation,
            Some(true)
        );
        // Saved and read back, off stays an explicit false.
        let store = Store {
            extras: off,
            ..Store::default()
        };
        let value = serde_json::to_value(&store).unwrap();
        assert_eq!(value["questionEscalation"], false);
        let back: Store = serde_json::from_value(value).unwrap();
        assert_eq!(back.extras.question_escalation, Some(false));
    }

    #[test]
    fn the_keys_sit_at_the_stores_top_level() {
        let mut store = Store::default();
        store.extras.auto_join_general = Some(true);
        store.extras.spawn_native_input = Some(true);
        store.extras.pi_auto_activate = Some(true);
        store.extras.opencode_auto_activate = Some(false);
        store.extras.question_escalation = Some(true);
        store.extras.question_escalation_inbox = Some("lead".into());
        store
            .extras
            .record(vec![change("2026-10-16T00:00:00Z", "auto_activate")]);
        let value = serde_json::to_value(&store).unwrap();
        assert_eq!(value["autoJoinGeneral"], true);
        assert_eq!(value["spawnNativeInput"], true);
        assert_eq!(value["piAutoActivate"], true);
        assert_eq!(value["opencodeAutoActivate"], false);
        assert_eq!(value["questionEscalation"], true);
        assert_eq!(value["questionEscalationInbox"], "lead");
        assert_eq!(value["agentSettingsChanges"][0]["by"], "api");
        let back: Store = serde_json::from_value(value).unwrap();
        assert_eq!(back.extras, store.extras);
    }
}
