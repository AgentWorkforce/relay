import Foundation

/// Matches the GTK mobile Claude handoff setting word for word.
public enum MobileClaudeHandoffCopy {
    public static let unavailable = "Not available on this platform yet. A verified native connection from Claude is required."
    public static let title = "Continue Claude from mobile (Experimental)"
    public static let detail = "First enable Accept spawns from Agent Relay in Settings and wait for ownership verification. Requires Claude Code 2.1.310 or later in the 2.1 series. Enable once, then restart Claude or run /reload-plugins in the open session. Your messages continue its conversation with existing permissions while it runs. Reading a session sends no message. After your first mobile message, replies stay synced to your phone."
}
