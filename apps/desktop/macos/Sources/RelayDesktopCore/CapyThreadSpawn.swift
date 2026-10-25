import Foundation

/// One form submission, saved before Cloud is called so a timeout or app
/// restart retries the same idempotent operation.
public struct CapySpawnOperation: Codable, Equatable {
    public static let preferenceKey = "capyThreadSpawn.v1"

    public let workspaceID: String
    public let clientRequestID: String
    public let projectID: String
    public let task: String
    public let model: String?
    public let pullRequestAuthor: String?
    public let reportTo: String?
    public var threadID: String?

    public init(workspaceID: String, clientRequestID: String, projectID: String, task: String,
                model: String?, pullRequestAuthor: String?, reportTo: String?, threadID: String? = nil) {
        self.workspaceID = workspaceID
        self.clientRequestID = clientRequestID
        self.projectID = projectID
        self.task = task
        self.model = model
        self.pullRequestAuthor = pullRequestAuthor
        self.reportTo = reportTo
        self.threadID = threadID
    }

    public func matches(workspaceID: String, projectID: String, task: String,
                        model: String?, pullRequestAuthor: String?, reportTo: String?) -> Bool {
        self.workspaceID == workspaceID && self.projectID == projectID && self.task == task
            && self.model == model && self.pullRequestAuthor == pullRequestAuthor && self.reportTo == reportTo
    }
}

public final class CapySpawnStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func operation(workspaceID: String) -> CapySpawnOperation? {
        guard let data = defaults.data(forKey: CapySpawnOperation.preferenceKey),
              let operation = try? JSONDecoder().decode(CapySpawnOperation.self, from: data),
              operation.workspaceID == workspaceID else { return nil }
        return operation
    }

    /// Returns a matching operation, or durably records a new id. Even after
    /// Cloud returns a thread id, retries must keep the original idempotency
    /// key; only the explicit Start another action clears it.
    /// A write that cannot be read back fails before any network request.
    public func prepare(workspaceID: String, projectID: String, task: String,
                        model: String?, pullRequestAuthor: String?, reportTo: String?) throws -> CapySpawnOperation {
        if let saved = operation(workspaceID: workspaceID),
           saved.matches(workspaceID: workspaceID, projectID: projectID, task: task,
                         model: model, pullRequestAuthor: pullRequestAuthor, reportTo: reportTo) {
            return saved
        }
        let operation = CapySpawnOperation(
            workspaceID: workspaceID,
            clientRequestID: "relay-desktop-\(UUID().uuidString.lowercased())",
            projectID: projectID,
            task: task,
            model: model,
            pullRequestAuthor: pullRequestAuthor,
            reportTo: reportTo
        )
        try save(operation)
        return operation
    }

    public func markCreated(_ operation: CapySpawnOperation, threadID: String) throws -> CapySpawnOperation {
        var created = operation
        created.threadID = threadID
        try save(created)
        return created
    }

    public func clear() {
        defaults.removeObject(forKey: CapySpawnOperation.preferenceKey)
    }

    private func save(_ operation: CapySpawnOperation) throws {
        let data = try JSONEncoder().encode(operation)
        defaults.set(data, forKey: CapySpawnOperation.preferenceKey)
        guard defaults.data(forKey: CapySpawnOperation.preferenceKey) == data else {
            throw CocoaError(.fileWriteUnknown)
        }
    }
}

public enum CapySpawnPresentation {
    public static let starting = "Starting Capy thread…"
    public static let waiting = "Thread started · Waiting for Capy to join the relay"

    public static func cloudSettingsURL(siteURL: String) -> URL? {
        guard var components = URLComponents(string: siteURL),
              components.scheme == "https" || components.scheme == "http",
              components.host != nil else { return nil }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = "capy"
        components.path = "/cloud/dashboard/settings"
        return components.url
    }
}
