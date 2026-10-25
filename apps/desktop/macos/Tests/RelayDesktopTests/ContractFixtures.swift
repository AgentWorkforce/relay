@testable import RelayDesktopCore

/// Contract values with the fields a test does not care about filled in.
enum Fixture {
    static func uploaderStatus(stage: Stage = .upToDate, message: String? = nil, running: Bool = true, paused: Bool = false,
                               sharingMode: SharingMode = .new, total: Int = 0, shared: Int = 0,
                               journalFull: Bool = false, skippedRecords: Int = 0, stopped: Bool = false,
                               failureCode: DeliveryFailureCode? = nil) -> UploaderStatus {
        UploaderStatus(
            collectorOutdated: false, collectorReplacing: false,
            delivery: UploadDelivery(acknowledgedRecords: 0, bootstrapComplete: true, failureCode: failureCode, pendingRecords: 0,
                                     quarantinedRecords: 0, skippedRecords: skippedRecords, stopped: stopped, unqueuedChanges: 0),
            journalFull: journalFull, needsStart: false, paused: paused, running: running,
            sessions: SessionCounts(excluded: total - shared, shared: shared, total: total),
            sharingMode: sharingMode, stage: stage, stageMessage: message, stalled: false, upgrading: false
        )
    }

    static func uploadSession(source: String = "codex", sessionId: String, title: String = "", cwd: String? = nil,
                              included: Bool = false, status: UploadShareStatus = .notShared) -> UploadSession {
        UploadSession(cwd: cwd, included: included, isAgent: false, sessionId: sessionId, source: source, status: status,
                      title: title)
    }

    static func localSession(target: Target, title: String, project: String? = nil, live: Bool = true,
                             running: Bool? = nil, registration: SessionRegistration? = nil) -> LocalSession {
        LocalSession(live: live, project: project, registration: registration, running: running, suggestedName: "agent",
                     target: target, title: title)
    }
}
