import Foundation

/// Optimistic titles stay in place until a subsequent catalog read confirms
/// them. A failure removes only its own request, never a newer edit.
public struct SessionTitleEdits: Equatable {
    private struct Confirmed: Equatable {
        let token: UUID
        let title: String
        let expiresAt: Date?
    }
    private struct Edit: Equatable {
        let token: UUID
        var title: String
        var saving: Bool
        let previous: Confirmed?
        var expiresAt: Date?
    }
    private var edits: [String: Edit] = [:]
    public init() {}
    public func title(for id: String) -> String? { edits[id]?.title }
    public func isSaving(_ id: String) -> Bool { edits[id]?.saving == true }

    @discardableResult public mutating func begin(_ id: String, title: String) -> UUID {
        let token = UUID()
        edits[id] = Edit(token: token, title: title, saving: true, previous: edits[id].map { Confirmed(token: $0.token, title: $0.title, expiresAt: $0.expiresAt) }, expiresAt: nil)
        return token
    }
    public mutating func succeed(_ id: String, token: UUID, title: String, now: Date = Date()) {
        guard edits[id]?.token == token else { return }
        edits[id]?.title = title
        edits[id]?.saving = false
        edits[id]?.expiresAt = now.addingTimeInterval(60)
    }
    public mutating func fail(_ id: String, token: UUID) {
        guard let edit = edits[id], edit.token == token else { return }
        edits[id] = edit.previous.map { Edit(token: $0.token, title: $0.title, saving: false, previous: nil, expiresAt: $0.expiresAt) }
    }
    public mutating func observe(_ id: String, title: String, now: Date = Date()) {
        guard let edit = edits[id], !edit.saving else { return }
        if edit.title == title || edit.expiresAt.map({ now >= $0 }) == true { edits[id] = nil }
    }
    public func expiration(for id: String) -> (token: UUID, date: Date)? {
        guard let edit = edits[id], !edit.saving, let date = edit.expiresAt else { return nil }
        return (edit.token, date)
    }
    /// A native acknowledgment is authoritative for the write, but cannot
    /// permanently mask a later rename in the harness or a stale importer.
    @discardableResult public mutating func expire(_ id: String, token: UUID, now: Date = Date()) -> Bool {
        guard let edit = edits[id], edit.token == token, !edit.saving,
              edit.expiresAt.map({ now >= $0 }) == true else { return false }
        edits[id] = nil
        return true
    }
}
