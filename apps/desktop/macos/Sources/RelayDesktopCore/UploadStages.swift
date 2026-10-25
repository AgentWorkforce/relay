import Foundation

/// Independent stages: local capture can continue while selected sessions upload.
public struct UploadStage: Equatable, Identifiable {
    public enum State: Equatable {
        case waiting, active, complete, paused, blocked
    }

    /// Something the person can do to unblock a stage.
    public enum Action: Equatable {
        /// Remove consumed records from the full upload journal.
        case compact
        /// Retry uploads a problem stopped.
        case retry
    }

    public let id: Int
    public let title: String
    public let detail: String
    public let state: State
    /// Only present when the uploader reports a bounded total for this stage.
    public let fraction: Double?
    public let action: Action?

    public init(id: Int, title: String, detail: String, state: State, fraction: Double?, action: Action? = nil) {
        self.id = id
        self.title = title
        self.detail = detail
        self.state = state
        self.fraction = fraction
        self.action = action
    }
}

public enum UploadStages {
    /// What the upload stage says while an action the person asked for runs.
    public static func pendingDetail(_ action: UploadStage.Action) -> String {
        switch action {
        case .compact: return "Compacting the upload journal…"
        case .retry: return "Retrying uploads…"
        }
    }

    public static func make(
        catalogReady: Bool,
        loadedSessions: Int,
        enabledSessions: Int = 0,
        preparingHistory: Bool,
        capture: CaptureProgress?,
        status: StatusViewModel?,
        summary: SessionUploadSummary?,
        pending: UploadStage.Action? = nil
    ) -> [UploadStage] {
        // A compaction asked for shows the journal as being compacted, not full.
        let journalFull = status?.isJournalFull == true && pending != .compact

        let reading = UploadStage(
            id: 0, title: "Reading sessions",
            detail: catalogReady ? "\(loadedSessions.formatted()) sessions loaded" : "Finding local sessions…",
            state: catalogReady ? .complete : .active, fraction: catalogReady ? 1 : nil
        )

        let collecting: UploadStage
        if journalFull {
            collecting = UploadStage(id: 1, title: "Collecting transcripts",
                                     detail: "Paused · Upload journal full", state: .blocked, fraction: nil)
        } else if let capture, capture.isCapturing {
            collecting = UploadStage(
                id: 1, title: "Collecting transcripts",
                detail: (capture.phase == "capture_paused" ? "Retrying · " : "") + capture.detail,
                state: capture.phase == "capture_paused" ? .blocked : .active,
                fraction: capture.fraction
            )
        } else if preparingHistory || summary?.state == .preparing {
            collecting = UploadStage(id: 1, title: "Collecting transcripts",
                                     detail: "Preparing session content for upload…", state: .active, fraction: nil)
        } else {
            collecting = UploadStage(id: 1, title: "Collecting transcripts",
                                     detail: catalogReady ? "Local history is ready" : "Waiting for local history",
                                     state: catalogReady ? .complete : .waiting, fraction: catalogReady ? 1 : nil)
        }

        let uploadState: UploadStage.State
        var uploadDetail: String
        var uploadAction: UploadStage.Action?
        if journalFull {
            // A full journal stalls capture and delivery; compacting works
            // whether or not uploads are paused, so it outranks the rest.
            // The core's attention sentence can be an unrelated delivery
            // failure, so the stage names the journal itself.
            uploadState = .blocked
            uploadDetail = "Upload journal full"
            uploadAction = .compact
        } else {
            switch summary?.state {
            case .paused:
                uploadState = .paused
                uploadDetail = "Paused · Resume uploads to continue"
            case .notRunning, .offline, .needsAttention:
                uploadState = .blocked
                uploadDetail = summary?.detail ?? "Waiting to retry"
                // Stopped uploads wait for the person, so their stage offers the retry.
                if status?.canRetryUploads == true { uploadAction = .retry }
            case .conflict:
                uploadState = .active
                uploadDetail = summary?.detail ?? "Delivery conflicts need review"
            case .uploading:
                uploadState = .active
                uploadDetail = "\((status?.pendingRecords ?? 0).formatted()) records waiting to send"
            case .upToDate where max(enabledSessions, status?.sharedSessions ?? 0) > 0 && collecting.state != .complete:
                uploadState = .waiting
                uploadDetail = "Waiting for prepared session content"
            case .upToDate where max(enabledSessions, status?.sharedSessions ?? 0) > 0:
                uploadState = .complete
                uploadDetail = "Enabled sessions are up to date"
            case .preparing:
                uploadState = .waiting
                uploadDetail = "Waiting for prepared session content"
            default:
                uploadState = .waiting
                uploadDetail = status == nil ? "Checking uploader…" : "Select sessions to upload"
            }
        }
        // Acknowledged records are lifetime totals, not progress for this
        // upload, so sending stays indeterminate until it completes.
        var uploading = UploadStage(id: 2, title: "Uploading to server", detail: uploadDetail,
                                    state: uploadState, fraction: uploadState == .complete ? 1 : nil,
                                    action: uploadAction)
        // An action the person asked for shows as under way until the
        // uploader's next status says where it stands.
        if let pending {
            uploading = UploadStage(id: 2, title: "Uploading to server", detail: Self.pendingDetail(pending),
                                    state: .active, fraction: nil)
        }
        return [reading, collecting, uploading]
    }
}
