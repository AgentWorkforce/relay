//! Experimental mobile Claude continuation. Matches MobileClaudeHandoffCopy.

pub const MOBILE_CLAUDE_HANDOFF_UNAVAILABLE: &str =
    "Not available on this platform yet. A verified native connection from Claude is required.";

pub const MOBILE_CLAUDE_HANDOFF_TITLE: &str = "Continue Claude from mobile (Experimental)";
pub const MOBILE_CLAUDE_HANDOFF_DETAIL: &str = "First enable Accept spawns from Agent Relay in Settings and wait for ownership verification. Requires Claude Code 2.1.310 or later in the 2.1 series. Enable once, then restart Claude or run /reload-plugins in the open session. Your messages continue its conversation with existing permissions while it runs. Reading a session sends no message. After your first mobile message, replies stay synced to your phone.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux_app::models::{apply_settings_change, settings_change_fields};
    use crate::relay::contract::agents::{SettingsChange, SettingsValues};
    use serde_json::json;

    #[test]
    fn old_cores_do_not_offer_handoff_and_changes_are_explicit() {
        let values: SettingsValues = serde_json::from_value(json!({
            "allow_self_registration": true, "auto_activate": false,
        }))
        .unwrap();
        assert_eq!(values.mobile_claude_handoff, None);
        assert_eq!(values.mobile_claude_handoff_supported, None);
        let unavailable: SettingsValues = serde_json::from_value(json!({"allow_self_registration":true,"auto_activate":false,"mobile_claude_handoff":false,"mobile_claude_handoff_supported":false})).unwrap();
        assert_eq!(unavailable.mobile_claude_handoff, Some(false));
        assert_eq!(unavailable.mobile_claude_handoff_supported, Some(false));
        assert!(MOBILE_CLAUDE_HANDOFF_UNAVAILABLE.contains("Not available"));
        let change = SettingsChange {
            mobile_claude_handoff: Some(true),
            ..Default::default()
        };
        assert_eq!(settings_change_fields(&change), ["mobile_claude_handoff"]);
        assert_eq!(
            apply_settings_change(&values, &change).mobile_claude_handoff,
            Some(true)
        );
        assert!(MOBILE_CLAUDE_HANDOFF_TITLE.contains("Experimental"));
        assert!(MOBILE_CLAUDE_HANDOFF_DETAIL.contains("Reading a session sends no message."));
    }
}
