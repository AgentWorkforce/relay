import Foundation

/// The `auto_join_general` setting's wording, shared with Linux
/// (`linux_app::models::AUTO_JOIN_GENERAL_*`). Off unless turned on, so
/// agents stay out of #general and are reached by direct message.
public enum AutoJoinGeneral {
    public static let title = "New agents join #general"
    public static let explanation = "Agents you put on the relay are reached by direct message. Turn this on to have each agent put on the relay from now on join #general and get its posts."
    public static let joinedExplanation = "Each agent put on the relay from now on joins #general and gets its posts. Agents already on the relay keep the channels they are in."
    public static let turnOnHelp = "Have agents put on the relay from now on join #general"
    public static let turnOffHelp = "Keep agents put on the relay from now on out of #general"
}

/// The settings agents changed on the session socket (`agent_changes`),
/// worded as Linux words them (`linux_app::models::agent_change_*`).
public enum AgentSettingsChanges {
    public static let title = "Changed by agents"
    public static let explanation = "Agents on this computer can read and change these settings (GET and PATCH /settings on the session socket). Each change they make is listed here."
    /// How many changes Settings lists.
    public static let shown = 5

    /// Who changed which setting from what to what.
    public static func line(_ change: AgentSettingsChange) -> String {
        "\(change.by) changed \(change.key) from \(change.from ?? "unset") to \(change.to)"
    }

    /// When, on the local clock (`Oct 16 2026, 14:02`), as Linux's
    /// `dated_clock`; nil for a time that does not parse.
    public static func time(_ change: AgentSettingsChange, timeZone: TimeZone = .current) -> String? {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: change.at) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "MMM d yyyy, HH:mm"
        return formatter.string(from: date)
    }

    /// The line Settings shows, dated when the time parses.
    public static func row(_ change: AgentSettingsChange, timeZone: TimeZone = .current) -> String {
        guard let time = time(change, timeZone: timeZone) else { return line(change) }
        return "\(line(change)) · \(time)"
    }
}
