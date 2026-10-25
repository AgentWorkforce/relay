import Foundation

/// "3 minutes ago" style text for the panel and the Sessions table.
public enum RelativeTime {
    public static let placeholder = "—"

    // Every visible table row formats two dates; creating formatters per call dominates that.
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()
    private static let exact: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "MMM d, yyyy, h:mm:ss a 'UTC'"
        return formatter
    }()

    public static func string(for date: Date?, relativeTo now: Date = Date()) -> String {
        guard let date = date else { return placeholder }
        if abs(now.timeIntervalSince(date)) < 60 { return "Just now" }
        return relative.localizedString(for: date, relativeTo: now)
    }

    public static func exactString(for date: Date?) -> String {
        guard let date else { return placeholder }
        return exact.string(from: date)
    }

    public static func string(milliseconds: Int64?, relativeTo now: Date = Date()) -> String {
        string(for: BridgeTime.date(milliseconds: milliseconds), relativeTo: now)
    }
}
