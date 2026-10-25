import Foundation
import RelayDesktopCore

/// Everything one Sessions table row draws, as plain values. Rows compare
/// these instead of observing the models, so a model change redraws only the
/// rows whose own values changed.
struct SessionRowState: Equatable {
    /// The projected row: title, project, dates and the other sortable fields.
    let row: LocalSessionRow
    /// The latest confirmed copies. Search results are projected
    /// asynchronously; controls read these so clearing optimistic intent
    /// cannot flash old values.
    let upload: UploadSession?
    let relaySession: LocalSession?
    let uploadState: SessionUploadState
    let stopping: Bool
    let hidden: Bool
    let hiding: Bool
    let error: String?
    let activityStatus: String
    let presence: RelayPresence
    let canToggleRelay: Bool
    let title: String

    var host: String? { relaySession?.host ?? upload?.host }
}

/// Lookups for building row states, made once per model change instead of
/// scanning the session lists for every row.
@MainActor
struct SessionRowIndex {
    private let model: AppModel
    private let relay: RelayModel
    private let lookup: SessionRowLookup

    init(model: AppModel, relay: RelayModel, lookup: SessionRowLookup? = nil) {
        self.model = model
        self.relay = relay
        self.lookup = lookup ?? SessionRowLookup(model: model, relay: relay)
    }

    func relaySession(for row: LocalSessionRow) -> LocalSession? {
        guard let original = row.relay else { return nil }
        return lookup.relaySessions[original.id] ?? original
    }

    func activityStatus(for row: LocalSessionRow) -> String {
        let session = relaySession(for: row)
        if lookup.archivedUploadKeys.contains(row.id) || session.map({ lookup.archivedTargets.contains($0.target) }) == true { return "Archived" }
        guard let session, session.running != false else { return "Finished" }
        if let name = session.registration?.name, lookup.idleNames.contains(name) { return "Idle" }
        return session.live ? "Active" : "Idle"
    }

    func state(for row: LocalSessionRow) -> SessionRowState {
        let upload = lookup.uploads[row.id] ?? row.upload
        let session = relaySession(for: row)
        let hidden = model.hiddenSessionIDs.contains(row.id)
        let presence = session.map { relay.presence(of: $0) } ?? .off
        return SessionRowState(
            row: row, upload: upload, relaySession: session,
            uploadState: upload.map { model.uploadState(for: $0) } ?? .discovering,
            stopping: upload.map { model.stoppingUploads.contains($0.id) } ?? false,
            hidden: hidden, hiding: model.hidingSessionIDs.contains(row.id),
            error: model.uploadErrors[row.id] ?? session.flatMap { relay.errors[$0.id] },
            activityStatus: activityStatus(for: row),
            presence: presence,
            canToggleRelay: session.map { !hidden && relay.canToggle($0, presence: presence) } ?? false,
            title: relay.displayedTitle(for: row.withLatestSources(upload: upload, relay: session)))
    }
}

/// Immutable dictionaries can be shared by render passes without retaining the models.
@MainActor
struct SessionRowLookup {
    let uploads: [String: UploadSession]
    let relaySessions: [String: LocalSession]
    let archivedUploadKeys: Set<String>
    let archivedTargets: Set<Target>
    let idleNames: Set<String>

    init(model: AppModel, relay: RelayModel) {
        uploads = Dictionary(model.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        relaySessions = Dictionary(relay.sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        archivedUploadKeys = Set(relay.archivedAgents.compactMap(\.target.uploadKey))
        archivedTargets = Set(relay.archivedAgents.map(\.target))
        idleNames = Set(relay.roster.filter { $0.liveness == .idle }.map(\.name))
    }

}
