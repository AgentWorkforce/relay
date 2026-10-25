//! The Sessions page's offer to put Capy threads on the relay. The Mac's
//! `CapySetup` is the reference, word for word.

pub const CAPY_SETUP_TITLE: &str = "Capy detected";
pub const CAPY_SETUP_MESSAGE: &str = "Put your Capy threads on Agent Relay so other agents can message them and their conversations appear in Sessions. Capy asks you to approve the Agent Relay plugin once.";
pub const CAPY_SETUP_ACTION: &str = "Set up in Capy";
pub const CAPY_SETUP_NOT_NOW: &str = "Not now";
/// Copied to the clipboard for the person to paste into a Capy thread.
pub const CAPY_SETUP_PROMPT: &str = "Set me up on Agent Relay: https://github.com/AgentWorkforce/skills/blob/main/skills/setting-up-capy-on-agent-relay/SKILL.md";
pub const CAPY_SETUP_COPIED: &str = "Prompt copied. Paste it into a Capy thread.";
pub const CAPY_URL: &str = "https://capy.ai";

/// The card shows while Capy is detected and the person has not chosen
/// Not now.
pub fn capy_setup_shows(installed: bool, dismissed: bool) -> bool {
    installed && !dismissed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capy_setup_shows_only_while_detected_and_not_dismissed() {
        assert!(capy_setup_shows(true, false));
        assert!(!capy_setup_shows(true, true));
        assert!(!capy_setup_shows(false, false));
    }

    #[test]
    fn capy_setup_wording_matches_the_mac() {
        assert_eq!(CAPY_SETUP_TITLE, "Capy detected");
        assert_eq!(
            CAPY_SETUP_MESSAGE,
            "Put your Capy threads on Agent Relay so other agents can message them and their conversations appear in Sessions. Capy asks you to approve the Agent Relay plugin once."
        );
        assert_eq!(CAPY_SETUP_ACTION, "Set up in Capy");
        assert_eq!(CAPY_SETUP_NOT_NOW, "Not now");
        assert_eq!(
            CAPY_SETUP_PROMPT,
            "Set me up on Agent Relay: https://github.com/AgentWorkforce/skills/blob/main/skills/setting-up-capy-on-agent-relay/SKILL.md"
        );
        assert_eq!(
            CAPY_SETUP_COPIED,
            "Prompt copied. Paste it into a Capy thread."
        );
        assert_eq!(CAPY_URL, "https://capy.ai");
    }
}
