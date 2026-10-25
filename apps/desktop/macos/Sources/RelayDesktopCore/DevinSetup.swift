import Foundation

/// The card above the session table offering to put Devin sessions on the
/// relay, while Devin has run here and Agent Relay's hooks are off (the core
/// reports `devin_direct_delivery` false) and the person has not chosen Not
/// now. Turn On adds the hooks; Settings still has the row afterwards. The
/// Linux app's `models::devin_setup` matches this word for word.
public enum DevinSetup {
    public static let title = "Devin found"
    public static let message = "Put the Devin sessions you open on the relay, so they appear here and can be messaged, the way Claude Code and Codex sessions are? This adds Agent Relay's hooks to ~/.config/devin/config.json."
    public static let turnOnAction = "Turn On"
    public static let notNowAction = "Not now"
    /// Set once the person chose Not now; the card never returns.
    public static let dismissedKey = "devinSetupDismissed"

    /// Shown while the hooks are off (`false`; no value means Devin never
    /// ran here) and the card was not dismissed.
    public static func shows(hooks: Bool?, dismissed: Bool) -> Bool {
        hooks == false && !dismissed
    }
}
