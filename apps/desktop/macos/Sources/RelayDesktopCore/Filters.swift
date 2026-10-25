import Foundation

/// The Session Uploads search field.
public enum SessionFilter {
    /// Title, id, source and project, ignoring case; empty matches all.
    public static func matches(_ session: UploadSession, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if needle.isEmpty { return true }
        return [session.displayTitle, session.title, session.id,
                session.displayProject, session.source]
            .contains { $0.lowercased().contains(needle) }
    }

    public static func filter(_ sessions: [UploadSession], query: String) -> [UploadSession] {
        sessions.filter { matches($0, query: query) }
    }
}

/// The Agents page search field.
public enum AgentSessionFilter {
    /// The row's title, the session's own title, project, kind, id and
    /// relay name, ignoring case; empty matches all.
    public static func matches(_ session: LocalSession, title: String, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if needle.isEmpty { return true }
        let name = session.registration.map { "@\($0.name)" }
        return [title, session.title, session.projectName, session.target.kind.label, session.target.id, name]
            .compactMap { $0?.lowercased() }
            .contains { $0.contains(needle) }
    }

    public static func matches(_ worker: WorkerRow, broker: BrokerListing, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if needle.isEmpty { return true }
        return [worker.name, worker.providerLabel, worker.model ?? "", broker.name, worker.channels.joined(separator: " "), worker.stateLabel]
            .contains { $0.lowercased().contains(needle) }
    }

    public static func matches(_ agent: RosterAgent, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if needle.isEmpty { return true }
        return [agent.name, agent.address ?? "", agent.description, agent.whereLabel]
            .contains { $0.lowercased().contains(needle) }
    }
}
