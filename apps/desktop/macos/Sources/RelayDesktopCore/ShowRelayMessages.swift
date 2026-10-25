import Foundation

/// The `show_relay_messages` setting's wording, shared with Linux
/// (`linux_app::models::SHOW_RELAY_MESSAGES_*`). Off unless turned on, so
/// relay messages are hidden from the person; the agent still gets them in full.
public enum ShowRelayMessages {
    public static let title = "Show me relay messages in full"
    public static let explanation = "Relay messages are hidden from you, or shown as a short pointer in a terminal. The agent still gets each one in full and can reply."
    public static let shownExplanation = "You see each relay message in full in the agent's chat. The agent gets them either way."
    public static let turnOffHelp = "Hide relay messages from you; the agent still gets them in full"
    public static let turnOnHelp = "Show me each relay message in full in agent chats"
}
