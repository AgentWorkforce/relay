import Foundation

/// Wording for the Hermes setting, on wherever Hermes has run. The Linux
/// app's `HERMES_*` constants match these word for word.
public enum HermesCopy {
    public static let title = "Hermes"
    public static let onDetail = "Agent Relay reaches Hermes's relay profile on this computer, so it appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only."
    public static let offDetail = "Turn this on so Hermes's relay profile on this computer appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only."
    public static let turnOnHelp = "List and message Hermes on this computer"
    public static let turnOffHelp = "Stop listing and messaging Hermes"
}
