import Foundation

/// The session history setting's wording (`history_retention_days`), shared
/// with Linux (`linux_app::models::HISTORY_RETENTION_*`): how long this
/// computer keeps local session history, and the warning a short choice gets.
public enum HistoryRetentionCopy {
    public static let section = "Session history"
    public static let title = "Keep session history"
    public static let detail = "How long this computer keeps the sessions Agent Relay finds. Older sessions are removed from this computer; copies already uploaded to your workspace are not affected."
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

    /// `7 days`, `30 days`: a choice as a span of time.
    private static func span(_ days: Int) -> String {
        days == 1 ? "1 day" : "\(days) days"
    }

    /// The warning a choice gets when a session that has not uploaded by
    /// then can be removed before it does: a choice shorter than the
    /// default, or any limit while uploads are held (signed out or paused).
    public static func warning(_ days: Int, uploadsHeld: Bool) -> String? {
        guard days != forever else { return nil }
        if uploadsHeld {
            return "While you’re signed out or uploads are paused, sessions that haven’t uploaded within \(span(days)) can be removed from this computer before they upload."
        }
        guard days < defaultDays else { return nil }
        return "Sessions that haven’t uploaded within \(span(days)) can be removed from this computer before they upload, for example while you’re signed out or uploads are paused."
    }
}
