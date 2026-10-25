import Foundation

/// Joins local history to local relay discovery. Never reads the workspace roster.
public struct LocalSessionRow: Identifiable, Equatable {
    public let upload: UploadSession?
    public let relay: LocalSession?
    public var id: String { upload?.id ?? relay!.target.uploadKey ?? relay!.id }
    public var titleOverride: String? = nil
    public func withTitle(_ title: String?) -> Self {
        var copy = self
        copy.titleOverride = title
        return copy
    }
    /// A search projection may lag a confirmed catalog update. Controls use
    /// these latest copies without carrying the projection's optimistic title.
    public func withLatestSources(upload: UploadSession?, relay: LocalSession?) -> Self {
        Self(upload: upload ?? self.upload, relay: relay ?? self.relay)
    }
    public var title: String {
        let title = titleOverride ?? upload?.displayTitle ?? relay?.title ?? ""
        return title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Untitled session" : title
    }
    public var source: String { upload?.source ?? relay!.target.kind.source }
    /// Only observed settings belong in the compact subtitle.
    public func executionDetails(harness: String) -> String {
        let models = (upload?.models ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && $0.lowercased() != "unknown" }
        let effort = upload?.reasoningEffort?.trimmingCharacters(in: .whitespacesAndNewlines)
        return [models.isEmpty ? nil : models.joined(separator: ", "),
                harness.isEmpty || harness.lowercased() == "unknown" ? nil : harness,
                effort.flatMap { $0.isEmpty || $0.lowercased() == "unknown" ? nil : "\($0) reasoning" }]
            .compactMap { $0 }.joined(separator: " · ")
    }
    public var modelName: String {
        let values = (upload?.models ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.lowercased() != "unknown" }
        return values.isEmpty ? "—" : values.joined(separator: ", ")
    }
    public var reasoning: String {
        let value = upload?.reasoningEffort?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty || value.lowercased() == "unknown" ? "—" : value
    }
    public var reasoningSortKey: String? {
        let value = reasoning.lowercased()
        guard value != "—" else { return nil }
        let levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        return String(format: "%02d:%@", levels.firstIndex(of: value) ?? 99, value)
    }
    public var createdAt: Date? {
        guard let ms = upload?.firstActivityMs, ms > 0 else { return nil }
        return Date(timeIntervalSince1970: Double(ms) / 1000)
    }
    public var sessionID: String { upload?.sessionId ?? relay?.target.id ?? id }
    public var project: String {
        if let resolved = upload?.project {
            return resolved.isEmpty ? relay?.projectName ?? "" : resolved
        }
        return upload?.legacyProject ?? relay?.projectName ?? ""
    }
    public var updatedAt: Date? { upload?.lastActivity ?? relay?.updatedAt }
    public var directory: String { upload?.cwd ?? relay?.directory ?? "" }

    public static func merge(uploads: [UploadSession], sessions: [LocalSession]) -> [Self] {
        mergeUnsorted(uploads: uploads, sessions: sessions).sorted {
            if $0.updatedAt != $1.updatedAt { return ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
            return $0.id < $1.id
        }
    }

    /// Search applies its requested order after filtering; avoid sorting the
    /// entire source first when only membership and metadata are needed.
    public static func mergeUnsorted(uploads: [UploadSession], sessions: [LocalSession]) -> [Self] {
        var byUpload: [String: LocalSession] = [:]
        for session in sessions {
            // A stopped managed session and a live window can share a key:
            // keep the live one, then the first, as `relaySession(for:in:)` does.
            guard let key = session.target.uploadKey else { continue }
            if let kept = byUpload[key], kept.live || !session.live { continue }
            byUpload[key] = session
        }
        let uploadKeys = Set(uploads.map(\.id))
        var rows = uploads.map { Self(upload: $0, relay: byUpload[$0.id]) }
        rows += sessions.filter { session in
            session.target.uploadKey.map { !uploadKeys.contains($0) && byUpload[$0]?.id == session.id } ?? true
        }.map { Self(upload: nil, relay: $0) }
        return rows
    }

    /// The relay session a row id names: the live one when a stopped managed
    /// session shares its upload key, otherwise the first.
    public static func relaySession(for id: String, in sessions: [LocalSession]) -> LocalSession? {
        let matching = sessions.filter { ($0.target.uploadKey ?? $0.id) == id }
        return matching.first(where: \.live) ?? matching.first
    }

    public func matches(_ query: String) -> Bool {
        LocalSessionQuery(query).matches(self)
    }

    /// Row ids a relay-only session had before it joined its transcript by
    /// upload key; hidden sessions saved under them stay hidden.
    private static let renamedIDs = [("grok-open:", "grok:"), ("opencode-open:", "opencode:"), ("muse-open:", "muse:")]

    /// The current row id for a hidden session saved under an older one.
    public static func currentHiddenID(_ id: String) -> String {
        for (old, new) in renamedIDs where id.hasPrefix(old) { return new + id.dropFirst(old.count) }
        return id
    }
}

public enum LocalSessionGrouping: String, CaseIterable, Identifiable, Codable {
    case none = "None", harness = "Harness", project = "Project", status = "Status", week = "Week"
    public var id: String { rawValue }

    /// Cloud groups weeks from Monday in UTC, independent of the machine timezone.
    public static func week(_ date: Date?) -> String {
        guard let date else { return "Unknown week" }
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let monday = calendar.dateInterval(of: .weekOfYear, for: date)!.start
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "MMM d, yyyy"
        return "Week of " + formatter.string(from: monday)
    }
}

public enum LocalSessionSortColumn: String, CaseIterable, Codable {
    case session = "Session", project = "Project", status = "Status"
    case updated = "Updated", relay = "Messages", upload = "Upload"

    case harness = "Harness", model = "Model", reasoning = "Reasoning"
    case created = "Created", directory = "Directory", sessionID = "Session ID"

    public var startsAscending: Bool { ![Self.updated, .created, .relay, .upload].contains(self) }
}

public struct LocalSessionSort: Equatable, Codable {
    public private(set) var column: LocalSessionSortColumn = .updated
    public private(set) var ascending = false
    public init() {}

    /// Idle headers show the current order; hovered headers preview the click.
    public func headerDirection(for column: LocalSessionSortColumn, previewNext: Bool) -> Bool? {
        if previewNext { return self.column == column ? !ascending : column.startsAscending }
        return self.column == column ? ascending : nil
    }

    public mutating func select(_ column: LocalSessionSortColumn) {
        ascending = self.column == column ? !ascending : column.startsAscending
        self.column = column
    }

    public func sorted(_ rows: [LocalSessionRow], status: (LocalSessionRow) -> String?,
                       onRelay: (LocalSessionRow) -> Bool?, uploadEnabled: (LocalSessionRow) -> Bool?) -> [LocalSessionRow] {
        // Missing values stay last in either direction. Identity is a stable
        // tie-breaker so refreshes and new pages cannot shuffle equal values.
        func compare<T: Comparable>(_ lhs: T?, _ rhs: T?) -> Int {
            switch (lhs, rhs) {
            case (nil, nil): return 0
            case (nil, _): return 1
            case (_, nil): return -1
            case let (left?, right?):
                if left == right { return 0 }
                return (left < right) == ascending ? -1 : 1
            }
        }
        return rows.sorted { left, right in
            let order: Int
            switch column {
            case .session: order = compare(left.title.lowercased(), right.title.lowercased())
            case .project:
                order = compare(left.project.isEmpty ? nil : left.project.lowercased(), right.project.isEmpty ? nil : right.project.lowercased())
            case .harness: order = compare(left.source.lowercased(), right.source.lowercased())
            case .model: order = compare(left.modelName == "—" ? nil : left.modelName.lowercased(), right.modelName == "—" ? nil : right.modelName.lowercased())
            case .reasoning: order = compare(left.reasoningSortKey, right.reasoningSortKey)
            case .status: order = compare(status(left)?.lowercased(), status(right)?.lowercased())
            case .updated: order = compare(left.updatedAt, right.updatedAt)
            case .created: order = compare(left.createdAt, right.createdAt)
            case .directory: order = compare(left.directory.isEmpty ? nil : left.directory.lowercased(), right.directory.isEmpty ? nil : right.directory.lowercased())
            case .sessionID: order = compare(left.sessionID.lowercased(), right.sessionID.lowercased())
            case .relay: order = compare(onRelay(left).map { $0 ? 1 : 0 }, onRelay(right).map { $0 ? 1 : 0 })
            case .upload: order = compare(uploadEnabled(left).map { $0 ? 1 : 0 }, uploadEnabled(right).map { $0 ? 1 : 0 })
            }
            return order == 0 ? left.id < right.id : order < 0
        }
    }
}
