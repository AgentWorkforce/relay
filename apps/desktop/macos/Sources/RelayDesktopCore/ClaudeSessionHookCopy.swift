import Foundation

/// Wording for the Claude Code SessionStart hook setting. The hook is off
/// unless turned on. It tells a session that is not on the relay how to
/// activate with POST /register, and it never registers the session. The
/// Linux app's `CLAUDE_SESSION_HOOK_*` constants match these word for word.
public enum ClaudeSessionHookCopy {
    public static let title = "Claude Code activation"
    public static let turnedOn = "Agent Relay's SessionStart hook is in each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes."
    public static let turnedOff = "A Claude Code session stays off the relay until you put it on. Turn this on to add a SessionStart hook to each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes."
    public static let turnOnHelp = "Add Agent Relay's SessionStart hook to each Claude login"
    public static let turnOffHelp = "Remove Agent Relay's SessionStart hook from each Claude login"
}
