import Foundation
import RelayDesktopCore

/// Cache the catalog independently of query edits and keyboard highlighting.
/// Each read checks the UTC date, including after a panel stays open overnight.
final class SessionSearchSuggestions: ObservableObject {
    struct Suggestion: Identifiable {
        let section: String
        let field: String
        let value: String
        let title: String
        let icon: String
        var id: String { field + ":" + value }
    }
    struct List {
        let items: [Suggestion]
        let ids: [String]
        let selectedIDs: Set<String>
        let query: LocalSessionQuery
    }
    private struct Key: Equatable {
        let harnesses: [String]
        let projects: [String]
        let day: Int
    }
    private var key: Key?
    private var options: [Suggestion] = []
    private var text: String?
    private var cachedList: List?
    private(set) var catalogBuildCount = 0
    private(set) var queryBuildCount = 0

    func list(text: String, harnesses: [String], projects: [String], now: Date = Date()) -> List {
        let key = Key(harnesses: harnesses, projects: projects, day: Int(floor(now.timeIntervalSince1970 / 86400)))
        if self.key != key {
            options = makeOptions(harnesses: harnesses, projects: projects, now: now)
            self.key = key
            cachedList = nil
            catalogBuildCount += 1
        }
        if self.text != text || cachedList == nil {
            let token = text.last?.isWhitespace == true ? "" : text.split(separator: " ").last.map(String.init) ?? ""
            let items: [Suggestion]
            if token.isEmpty || token.contains("\"") || options.contains(where: { $0.id.caseInsensitiveCompare(token) == .orderedSame }) {
                items = options
            } else {
                items = options.filter { $0.id.localizedCaseInsensitiveContains(token) || $0.title.localizedCaseInsensitiveContains(token) }
            }
            let query = LocalSessionQuery(text)
            cachedList = List(items: items, ids: items.map(\.id),
                selectedIDs: Set(items.filter { query.containsSelection($0.field, value: $0.value) }.map(\.id)), query: query)
            self.text = text
            queryBuildCount += 1
        }
        return cachedList!
    }

    private func dateSuggestions(now: Date) -> [Suggestion] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return [(1, "Today"), (7, "Last 7 days"), (30, "Last 30 days")].map { days, title in
            Suggestion(section: "Updated", field: "updated",
                value: ">=" + formatter.string(from: now.addingTimeInterval(-Double(days - 1) * 86400)),
                title: title, icon: "calendar")
        }
    }

    private func makeOptions(harnesses: [String], projects: [String], now: Date) -> [Suggestion] {
        return harnesses.map { Suggestion(section: "Harnesses", field: "harness", value: $0, title: AgentIconView.name(for: $0), icon: "terminal") }
            + [Suggestion(section: "Status", field: "is", value: "active", title: "Active", icon: "circle.fill"),
               Suggestion(section: "Status", field: "is", value: "inactive", title: "Inactive", icon: "circle"),
               Suggestion(section: "Messages", field: "is", value: "on-relay", title: "Receives messages", icon: "antenna.radiowaves.left.and.right"),
               Suggestion(section: "Messages", field: "is", value: "off-relay", title: "Does not receive messages", icon: "antenna.radiowaves.left.and.right.slash")]
            + projects.map { Suggestion(section: "Projects", field: "project", value: $0, title: $0, icon: "folder") }
            + [Suggestion(section: "Upload", field: "upload", value: "uploaded", title: "Uploaded", icon: "checkmark.circle"),
               Suggestion(section: "Upload", field: "upload", value: "in-progress", title: "In progress", icon: "arrow.up.circle"),
               Suggestion(section: "Upload", field: "upload", value: "local", title: "Not uploading", icon: "desktopcomputer"),
               Suggestion(section: "Upload", field: "upload", value: "discovering", title: "Indexing", icon: "clock")] + dateSuggestions(now: now)
    }
}
