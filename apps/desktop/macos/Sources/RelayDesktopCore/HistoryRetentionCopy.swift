import Foundation

/// The session history setting's wording (`history_retention_days`), shared
/// with Linux (`linux_app::models::HISTORY_RETENTION_*`): the disabled preview
/// shown until relayhistory can enforce a retention choice.
public enum HistoryRetentionCopy {
    public static let section = "Session history"
    public static let title = "Keep session history (coming soon)"
    public static let detail = "Automatic history removal is not available yet. Agent Relay keeps local session history until you remove it yourself."
    /// Days kept unless changed.
    public static let defaultDays = 30
    /// The setting's value for keeping history forever.
    public static let forever = 0
    /// The choices Settings offers, in order (the core's `CHOICES`).
    public static let choices = [7, 30, 90, forever]

    /// `7 days`, `30 days (default)`, `Forever`.
    public static func label(_ days: Int) -> String {
        switch days {
        case forever: return "Forever"
        case defaultDays: return "\(days) days (default)"
        case 1: return "1 day"
        default: return "\(days) days"
        }
    }

    /// No deletion warning is shown until relayhistory enforces this setting.
    public static func warning(_ days: Int, uploadsHeld: Bool) -> String? {
        nil
    }
}
