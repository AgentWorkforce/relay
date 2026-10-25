import Foundation

/// Local presentation snapshots. Restoring a view never changes session data.
public struct SessionViewConfiguration: Codable, Equatable {
    public var search: String
    public var grouping: LocalSessionGrouping
    public var sort: LocalSessionSort
    public var columns: Data
    public var showHidden: Bool

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.search == rhs.search && lhs.grouping == rhs.grouping && lhs.sort == rhs.sort
            && lhs.showHidden == rhs.showHidden
            && SessionColumnLayout(data: lhs.columns) == SessionColumnLayout(data: rhs.columns)
    }

    public init(search: String, grouping: LocalSessionGrouping, sort: LocalSessionSort,
                columns: SessionColumnLayout, showHidden: Bool) {
        self.search = search
        self.grouping = grouping
        self.sort = sort
        self.columns = columns.data
        self.showHidden = showHidden
    }
}

public struct SavedSessionView: Codable, Identifiable, Equatable {
    public var id: UUID
    public var name: String
    public var configuration: SessionViewConfiguration
}

public struct SavedSessionViews: Codable, Equatable {
    public static let preferenceKey = "savedSessionViews.v1"
    public private(set) var views: [SavedSessionView] = []
    public private(set) var defaultID: UUID?
    public var defaultView: SavedSessionView? { views.first { $0.id == defaultID } }
    public init(data: Data? = nil) {
        if let data, let saved = try? JSONDecoder().decode(Self.self, from: data) {
            self = saved
            if defaultView == nil { defaultID = nil }
        }
    }
    public var data: Data { (try? JSONEncoder().encode(self)) ?? Data() }
    public func canSave(name: String) -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && !views.contains { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }
    @discardableResult
    public mutating func save(name: String, configuration: SessionViewConfiguration, makeDefault: Bool) -> UUID? {
        guard canSave(name: name) else { return nil }
        let id = UUID()
        views.append(SavedSessionView(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines), configuration: configuration))
        if makeDefault { defaultID = id }
        return id
    }
    public mutating func setDefault(_ id: UUID?) {
        defaultID = views.first { $0.id == id }?.id
    }
    public mutating func delete(_ id: UUID) {
        views.removeAll { $0.id == id }
        if defaultID == id { defaultID = nil }
    }
}
