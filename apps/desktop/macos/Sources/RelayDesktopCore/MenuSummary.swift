import Foundation

/// A count in the menu-bar summary. Each is a session search, so choosing
/// it opens the session list showing exactly the sessions it counted.
public enum MenuSummaryFilter: CaseIterable, Sendable {
    case receiving, localOnly, uploaded, notUploaded

    public var title: String {
        switch self {
        case .receiving: return "Receiving messages"
        case .localOnly: return "Local only"
        case .uploaded: return "Uploaded"
        case .notUploaded: return "Not uploaded"
        }
    }

    public var search: String {
        switch self {
        case .receiving: return "is:active is:on-relay"
        case .localOnly: return "is:active is:off-relay"
        case .uploaded: return "upload:uploaded"
        case .notUploaded: return "-upload:uploaded"
        }
    }

    /// Receiving and Uploaded read as live; the others stay muted.
    public var isLive: Bool { self == .receiving || self == .uploaded }

    /// How many `rows` the session list shows for this filter.
    public func count(_ rows: [LocalSessionRow], uploadState: (LocalSessionRow) -> SessionUploadState?) -> Int {
        let query = LocalSessionQuery(search)
        return rows.filter { query.matches($0, uploadState: uploadState($0)) }.count
    }
}
