import Foundation

/// Public profile fields returned by Cloud's workspace-scoped people endpoint.
/// They are joined to human Relaycast peers by their exact bare handle only.
struct WorkspacePerson: Equatable, Sendable {
    let handle: String
    let displayName: String
    let avatarURL: URL?

    init?(_ data: [String: Any]) {
        guard let handle = data["handle"] as? String, !handle.isEmpty,
              handle == handle.trimmingCharacters(in: .whitespacesAndNewlines),
              !handle.contains("@") else { return nil }
        self.handle = handle
        displayName = (data["displayName"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        avatarURL = PersonPhotoURL.parse(data["avatarUrl"] as? String)
    }
}

enum PersonPhotoURL {
    /// Profile images are anonymous HTTPS requests, never credential-bearing
    /// URLs or local file/data URLs. Apply the same rule to redirects.
    static func parse(_ value: String?) -> URL? {
        guard let value, let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.fragment == nil,
              components.port == nil || components.port == 443 else { return nil }
        return components.url
    }
}

/// Keeps profile data in memory and rejects overlapping or previous-account
/// requests, even when a user leaves and returns to the same workspace.
struct WorkspacePeopleDirectory {
    struct Request: Equatable {
        let id = UUID()
        let workspaceID: String
        let sessionGeneration: Int
    }

    private(set) var people: [String: WorkspacePerson] = [:]
    private var latestRequest: Request?

    mutating func begin(workspaceID: String, sessionGeneration: Int) -> Request {
        if latestRequest?.workspaceID != workspaceID ||
            latestRequest?.sessionGeneration != sessionGeneration {
            people = [:]
        }
        let request = Request(workspaceID: workspaceID, sessionGeneration: sessionGeneration)
        latestRequest = request
        return request
    }

    @discardableResult
    mutating func finish(_ response: [String: Any], for request: Request) -> Bool {
        guard latestRequest == request else { return false }
        let rows = response["people"] as? [[String: Any]] ?? []
        let grouped = Dictionary(grouping: rows.compactMap(WorkspacePerson.init), by: \.handle)
        // An ambiguous handle must not show somebody else's picture.
        people = grouped.compactMapValues { $0.count == 1 ? $0.first : nil }
        return true
    }

    func person(handle: String, isHuman: Bool, workspaceID: String?, sessionGeneration: Int) -> WorkspacePerson? {
        guard isHuman, let workspaceID,
              latestRequest?.workspaceID == workspaceID,
              latestRequest?.sessionGeneration == sessionGeneration else { return nil }
        return people[handle]
    }

    mutating func reset() {
        latestRequest = nil
        people = [:]
    }
}
