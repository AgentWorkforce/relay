import Foundation
import RelayDesktopCore

struct SessionSearchSnapshot {
    struct Entry {
        let row: LocalSessionRow
        let uploadState: SessionUploadState?
        let status: String?
        let onRelay: Bool?
        let uploadEnabled: Bool?
    }
    let entries: [Entry]
    let metadata: [String: Entry]
    let sourceRows: [LocalSessionRow]
    let query: String
    let sort: LocalSessionSort
    var grouping: LocalSessionGrouping = .none
    var harnessNames: [String: String] = [:]
    var hiddenSessionIDs: Set<String> = []
    var showHiddenSessions = false

    init(entries: [Entry], query: String, sort: LocalSessionSort, grouping: LocalSessionGrouping = .none,
         harnessNames: [String: String] = [:], hiddenSessionIDs: Set<String> = [], showHiddenSessions: Bool = false) {
        self.init(source: SessionSearchSource(entries: entries, harnessNames: harnessNames), query: query,
                  sort: sort, grouping: grouping, hiddenSessionIDs: hiddenSessionIDs, showHiddenSessions: showHiddenSessions)
    }

    init(source: SessionSearchSource, query: String, sort: LocalSessionSort, grouping: LocalSessionGrouping = .none,
         hiddenSessionIDs: Set<String> = [], showHiddenSessions: Bool = false) {
        entries = source.entries
        metadata = source.metadata
        sourceRows = source.rows
        harnessNames = source.harnessNames
        self.query = query
        self.sort = sort
        self.grouping = grouping
        self.hiddenSessionIDs = hiddenSessionIDs
        self.showHiddenSessions = showHiddenSessions
    }

    struct Result {
        let rows: [LocalSessionRow]
        let groups: [SessionTableGroup]
    }

    func results() -> Result {
        let parsed = LocalSessionQuery(query)
        let filtered = entries.filter { !Task.isCancelled && (showHiddenSessions || !hiddenSessionIDs.contains($0.row.id)) && parsed.matches($0.row, uploadState: $0.uploadState) }.map(\.row)
        let rows = sort.sorted(filtered, status: { metadata[$0.id]?.status },
                           onRelay: { metadata[$0.id]?.onRelay }, uploadEnabled: { metadata[$0.id]?.uploadEnabled })
        var keys: [String] = []
        var grouped: [String: [LocalSessionRow]] = [:]
        for row in rows {
            if Task.isCancelled { break }
            let key: String
            switch grouping {
            case .none: key = ""
            case .harness: key = harnessNames[row.source] ?? row.source
            case .project: key = row.project.isEmpty ? "No project" : row.project
            case .status: key = metadata[row.id]?.uploadState?.title ?? SessionUploadState.discovering.title
            case .week: key = LocalSessionGrouping.week(row.updatedAt)
            }
            if grouped[key] == nil { keys.append(key) }
            grouped[key, default: []].append(row)
        }
        return Result(rows: rows, groups: keys.map { SessionTableGroup(key: $0, rows: grouped[$0]!) })
    }
}

/// One group of the Sessions table. Row identities are resolved here, off the
/// main thread, so scrolling never recomputes them for every row.
struct SessionTableGroup: Identifiable {
    struct Item: Identifiable {
        let id: String
        let row: LocalSessionRow
        let striped: Bool
    }
    let key: String
    let rows: [LocalSessionRow]
    let items: [Item]
    var id: String { key }

    init(key: String, rows: [LocalSessionRow]) {
        self.key = key
        self.rows = rows
        items = rows.enumerated().map { Item(id: $1.id, row: $1, striped: $0.isMultiple(of: 2)) }
    }
}

/// Keep query editing independent of result computation. Only the latest edit commits.
@MainActor
final class SessionSearchProjection: ObservableObject {
    @Published private(set) var sourceRows: [LocalSessionRow] = []
    @Published private(set) var rows: [LocalSessionRow] = []
    @Published private(set) var groups: [SessionTableGroup] = []
    @Published private(set) var generation = 0
    private(set) var isPending = true
    private(set) var appliedGrouping: LocalSessionGrouping = .none
    private var task: Task<Void, Never>?
    private var worker: Task<SessionSearchSnapshot.Result, Never>?
    private var revision = 0

    func schedule(delay: UInt64 = 80_000_000, snapshot: @escaping @MainActor () -> SessionSearchSnapshot) {
        task?.cancel()
        worker?.cancel()
        revision += 1
        isPending = true
        let requestedRevision = revision
        task = Task { [weak self] in
            do { if delay > 0 { try await Task.sleep(nanoseconds: delay) } }
            catch { return }
            guard let self, !Task.isCancelled else { return }
            let input = snapshot()
            self.sourceRows = input.sourceRows
            let computation = Task.detached(priority: .userInitiated) { input.results() }
            self.worker = computation
            let results = await computation.value
            guard !Task.isCancelled, self.revision == requestedRevision else { return }
            self.isPending = false
            self.appliedGrouping = input.grouping
            self.rows = results.rows
            self.groups = results.groups
            self.generation += 1
        }
    }

    func cancel() { task?.cancel(); worker?.cancel(); revision += 1; isPending = false }
    func waitUntilSettled() async { await task?.value }
    deinit { task?.cancel(); worker?.cancel() }
}
