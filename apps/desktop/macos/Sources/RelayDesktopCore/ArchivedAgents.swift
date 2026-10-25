import Foundation

/// How the Agents page shows agents that left the relay because their
/// session was archived. The Linux app's `models::agents` matches it.
public enum ArchivedAgentText {
    public static let sectionTitle = "Archived"

    /// `Session archived 5 minutes ago · name released`; without the time
    /// when it does not read.
    public static func detail(archivedAt: String, now: Date = Date()) -> String {
        guard let date = ISO8601DateFormatter().date(from: archivedAt) else {
            return "Session archived · name released"
        }
        return "Session archived \(RelativeTime.string(for: date, relativeTo: now)) · name released"
    }

    /// Whether `search` finds the agent by name, title or address.
    public static func matches(_ agent: ArchivedAgent, search: String) -> Bool {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return true }
        return [agent.name, agent.title, agent.address].contains { $0.localizedCaseInsensitiveContains(query) }
    }
}
