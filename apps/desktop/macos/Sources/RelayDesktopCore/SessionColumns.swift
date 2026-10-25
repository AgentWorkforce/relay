import Foundation

public enum SessionColumn: String, CaseIterable, Identifiable {
    case session, status, project, updated, relay, upload, harness, directory, sessionID, model, reasoning, created
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .session: return "Session"
        case .project: return "Project"
        case .updated: return "Updated"
        case .relay: return "Messages"
        case .upload: return "Upload"
        case .harness: return "Harness"
        case .directory: return "Directory"
        case .sessionID: return "Session ID"
        case .status: return "Status"
        case .model: return "Model"
        case .reasoning: return "Reasoning"
        case .created: return "Created"
        }
    }
    public var width: CGFloat {
        switch self {
        case .session: return 420
        case .project: return 160
        case .harness: return 140
        case .updated: return 120
        case .relay: return 126
        case .upload: return 100
        case .directory, .sessionID: return 220
        case .status: return 100
        case .reasoning: return 130
        case .model, .created: return 200
        }
    }
    public var minimumWidth: CGFloat { self == .session ? 120 : self == .relay ? 126 : 80 }
    public var defaultVisible: Bool { Self.allCases.firstIndex(of: self)! < 6 }
    public var sortColumn: LocalSessionSortColumn? {
        switch self {
        case .session: return .session
        case .project: return .project
        case .updated: return .updated
        case .relay: return .relay
        case .upload: return .upload
        case .harness: return .harness
        case .model: return .model
        case .reasoning: return .reasoning
        case .status: return .status
        case .created: return .created
        case .directory: return .directory
        case .sessionID: return .sessionID
        }
    }
}

/// Local presentation only: hiding a control never changes the session's state.
public struct SessionColumnLayout: Equatable {
    public static let preferenceKey = "sessionColumns.v1"
    public private(set) var order = SessionColumn.allCases
    public private(set) var hidden = Set(SessionColumn.allCases.filter { !$0.defaultVisible })
    public private(set) var widths: [SessionColumn: CGFloat] = [:]
    public var visible: [SessionColumn] { order.filter { !hidden.contains($0) } }
    /// Give long session titles spare space, even after columns are reordered.
    public var expandingColumn: SessionColumn? { visible.contains(.session) ? .session : visible.last }
    public static let defaultWindowSize = CGSize(width: 1280, height: 800)
    public var minimumWidth: CGFloat { visible.reduce(100) { $0 + width(for: $1) } + CGFloat(max(0, visible.count - 1)) * 16 }
    public init(data: Data? = nil) {
        guard let data, let entries = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
        var seen: [SessionColumn] = []
        for entry in entries {
            guard let id = entry["id"] as? String, let column = SessionColumn(rawValue: id), !seen.contains(column) else { continue }
            seen.append(column)
            if let width = entry["width"] as? Double { setWidth(CGFloat(width), for: column) }
            if (entry["visible"] as? Bool) ?? column.defaultVisible { hidden.remove(column) }
            else { hidden.insert(column) }
        }
        order = seen + order.filter { !seen.contains($0) }
        if visible.isEmpty { hidden.remove(order[0]) }
    }
    public var data: Data {
        (try? JSONSerialization.data(withJSONObject: order.map { column -> [String: Any] in
            var entry: [String: Any] = ["id": column.rawValue, "visible": !hidden.contains(column)]
            if let width = widths[column] { entry["width"] = Double(width) }
            return entry
        })) ?? Data()
    }
    public func width(for column: SessionColumn) -> CGFloat { widths[column] ?? column.width }
    public mutating func setWidth(_ width: CGFloat, for column: SessionColumn) {
        guard width.isFinite else { return }
        widths[column] = min(1200, max(column.minimumWidth, width.rounded()))
    }
    public mutating func setVisible(_ visible: Bool, for column: SessionColumn) {
        if visible { hidden.remove(column) }
        else if self.visible.count > 1 { hidden.insert(column) }
    }
    public mutating func move(_ column: SessionColumn, to target: SessionColumn) {
        guard let from = order.firstIndex(of: column), let to = order.firstIndex(of: target), from != to else { return }
        order.remove(at: from)
        order.insert(column, at: to)
    }
}
