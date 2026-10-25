//! The Sessions page's offer to put Devin sessions on the relay: Devin has
//! run here and Agent Relay's hooks are off. The Mac's `DevinSetup` is the
//! reference, word for word.

pub const DEVIN_SETUP_TITLE: &str = "Devin found";
pub const DEVIN_SETUP_MESSAGE: &str = "Put the Devin sessions you open on the relay, so they appear here and can be messaged, the way Claude Code and Codex sessions are? This adds Agent Relay's hooks to ~/.config/devin/config.json.";
pub const DEVIN_SETUP_TURN_ON: &str = "Turn On";
pub const DEVIN_SETUP_NOT_NOW: &str = "Not now";

/// The card shows while the core reports Devin's hooks off (`Some(false)`:
/// Devin has run here) and the person has not chosen Not now. No value
/// means Devin never ran here; `Some(true)` means they are on.
pub fn devin_setup_shows(hooks: Option<bool>, dismissed: bool) -> bool {
    hooks == Some(false) && !dismissed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devin_setup_shows_only_while_the_hooks_are_off_and_not_dismissed() {
        assert!(devin_setup_shows(Some(false), false));
        assert!(!devin_setup_shows(Some(false), true));
        assert!(!devin_setup_shows(Some(true), false));
        assert!(!devin_setup_shows(None, false));
    }

    #[test]
    fn devin_setup_wording_matches_the_mac() {
        assert_eq!(DEVIN_SETUP_TITLE, "Devin found");
        assert_eq!(
            DEVIN_SETUP_MESSAGE,
            "Put the Devin sessions you open on the relay, so they appear here and can be messaged, the way Claude Code and Codex sessions are? This adds Agent Relay's hooks to ~/.config/devin/config.json."
        );
        assert_eq!(DEVIN_SETUP_TURN_ON, "Turn On");
        assert_eq!(DEVIN_SETUP_NOT_NOW, "Not now");
    }
}
