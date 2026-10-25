import Foundation
import RelayDesktopCore

/// Immutable search input shared by query projections. Building metadata and
/// suggestions belongs to source updates, not to each settled keystroke.
struct SessionSearchSource {
    let entries: [SessionSearchSnapshot.Entry]
    let metadata: [String: SessionSearchSnapshot.Entry]
    let rows: [LocalSessionRow]
    let harnessNames: [String: String]

    init(entries: [SessionSearchSnapshot.Entry], harnessNames: [String: String]) {
        self.entries = entries
        metadata = Dictionary(entries.map { ($0.row.id, $0) }, uniquingKeysWith: { _, last in last })
        rows = entries.map(\.row)
        self.harnessNames = harnessNames
    }
}

@MainActor
final class SessionSearchSourceCache {
    struct Rows {
        let values: [LocalSessionRow]
        let harnesses: [String]
        let projects: [String]
        let harnessNames: [String: String]
    }
    private struct RowsKey: Equatable {
        let relay: ObjectIdentifier
        let uploads: UInt64
        let sessions: UInt64
    }
    private struct MetadataKey: Equatable {
        let rows: RowsKey
        let upload: UInt64
        let relay: UInt64
    }
    private var rowsKey: RowsKey?
    private var metadataKey: MetadataKey?
    private var cachedRows: Rows?
    private var cachedSource: SessionSearchSource?
    private var cachedLookup: SessionRowLookup?
    private(set) var rowsBuildCount = 0
    private(set) var metadataBuildCount = 0

    func rows(model: AppModel, relay: RelayModel) -> Rows {
        let key = RowsKey(relay: ObjectIdentifier(relay), uploads: model.sessionRowsRevision, sessions: relay.sessionRowsRevision)
        if rowsKey != key {
            let values = LocalSessionRow.mergeUnsorted(uploads: model.sessions, sessions: relay.sessions)
                .map { $0.withTitle(relay.titleEdits.title(for: $0.id)) }
            let harnesses = Set(values.map(\.source)).sorted()
            cachedRows = Rows(values: values, harnesses: harnesses,
                projects: Set(values.map(\.project).filter { !$0.isEmpty }).sorted(),
                harnessNames: Dictionary(uniqueKeysWithValues: harnesses.map { ($0, AgentIconView.name(for: $0)) }))
            rowsKey = key
            rowsBuildCount += 1
        }
        return cachedRows!
    }

    func snapshot(model: AppModel, relay: RelayModel) -> SessionSearchSource {
        let rows = rows(model: model, relay: relay)
        let key = MetadataKey(rows: rowsKey!, upload: model.sessionSearchMetadataRevision, relay: relay.sessionSearchMetadataRevision)
        if metadataKey != key {
            let lookup = SessionRowLookup(model: model, relay: relay)
            let index = SessionRowIndex(model: model, relay: relay, lookup: lookup)
            let entries = rows.values.map { row in
                SessionSearchSnapshot.Entry(row: row,
                    uploadState: row.upload.map { model.uploadState(for: $0) } ?? .discovering,
                    status: index.activityStatus(for: row),
                    onRelay: row.relay.map { relay.presence(of: $0).isOn },
                    uploadEnabled: row.upload.map { !model.stoppingUploads.contains($0.id) && ($0.included || model.requestingUploads.contains($0.id)) })
            }
            cachedSource = SessionSearchSource(entries: entries, harnessNames: rows.harnessNames)
            cachedLookup = lookup
            metadataKey = key
            metadataBuildCount += 1
        }
        return cachedSource!
    }

    func rowIndex(model: AppModel, relay: RelayModel) -> SessionRowIndex {
        _ = snapshot(model: model, relay: relay)
        return SessionRowIndex(model: model, relay: relay, lookup: cachedLookup!)
    }
}
