import Foundation

/// The uploader's stage as the app words it. The core decides the stage
/// (`uploader.status`); this is presentation only.
public enum DisplayState: Equatable, Hashable {
    case notRunning
    case paused
    /// Carries the probe's sentence.
    case needsAttention(String)
    case conflict
    case offline
    case preparing
    case uploading
    case upToDate
}

/// What the panel and the Agents page say about uploads, from one
/// `uploader.status` answer.
public struct StatusViewModel: Equatable {
    public let state: DisplayState
    public let headline: String
    public let detail: String?
    public let acknowledgedRecords: Int
    public let pendingRecords: Int
    public let quarantinedRecords: Int
    public let sharedSessions: Int
    public let totalSessions: Int
    public let lastUpload: Date?
    public let isPaused: Bool
    public let isJournalFull: Bool
    /// A problem that is not retried on its own stopped uploads, and retrying
    /// is what the person can do about it. A sign-in failure is fixed by
    /// signing in, not by retrying.
    public let canRetryUploads: Bool

    public init(status: UploaderStatus) {
        let delivery = status.delivery
        let skipped = max(0, delivery.skippedRecords)
        let quarantined = max(0, delivery.quarantinedRecords)
        let message = status.stageMessage
        let state: DisplayState
        switch status.stage {
        case .notRunning: state = .notRunning
        case .paused: state = .paused
        case .needsAttention: state = .needsAttention(message ?? "Uploads need attention.")
        case .conflict: state = .conflict
        case .offline: state = .offline
        case .preparing: state = .preparing
        case .uploading: state = .uploading
        case .upToDate: state = .upToDate
        }
        self.state = state
        if state == .upToDate && status.sharingMode == .selected && status.sessions.total > 0 && status.sessions.shared == 0 {
            headline = "Choose sessions to upload"
            detail = "No sessions are enabled for upload. Select sessions below to get started."
        } else if status.collectorReplacing && state == .preparing {
            headline = "Replacing the uploader"
            detail = "The updated uploader will resume automatically when the current capture stops."
        } else if status.upgrading && state == .preparing {
            headline = "Upgrading local history"
            detail = message ?? "Uploads continue when the upgrade finishes."
        } else if state == .preparing && !delivery.bootstrapComplete {
            headline = "Preparing uploads"
            detail = "Preparing enabled sessions. Upload completion has not been confirmed yet."
        } else {
            headline = Self.headline(for: state)
            if state == .conflict {
                detail = message ?? "\(quarantined) records quarantined after a receiver conflict. Other records can continue uploading."
            } else if (state == .upToDate || state == .uploading) && skipped > 0 {
                let skippedDetail = skipped == 1 ? "1 record was skipped during upload." : "\(skipped) records were skipped during upload."
                if state == .uploading, let message, !message.isEmpty {
                    detail = "\(message) \(skippedDetail)"
                } else {
                    detail = skippedDetail
                }
            } else {
                detail = Self.detail(for: state, message: message)
            }
        }
        acknowledgedRecords = max(0, delivery.acknowledgedRecords)
        pendingRecords = max(0, delivery.pendingRecords)
        quarantinedRecords = quarantined
        sharedSessions = status.sessions.shared
        totalSessions = status.sessions.total
        lastUpload = BridgeTime.date(milliseconds: delivery.lastAcknowledgedMs)
        isPaused = status.paused
        isJournalFull = status.journalFull
        canRetryUploads = status.stage == .needsAttention && delivery.stopped
            && delivery.failureCode != .authenticationRequired
    }

    public var symbol: String {
        switch state {
        case .upToDate: return "checkmark.circle"
        case .preparing: return "clock"
        case .paused: return "pause.circle"
        case .offline: return "wifi.slash"
        case .needsAttention: return "exclamationmark.circle"
        case .conflict: return "exclamationmark.triangle"
        case .notRunning: return "stop.circle"
        case .uploading: return "arrow.up.circle"
        }
    }

    public static func headline(for state: DisplayState) -> String {
        switch state {
        case .notRunning: return "Not running"
        case .paused: return "Paused"
        case .needsAttention: return "Needs attention"
        case .conflict: return "Delivery conflict"
        case .offline: return "Offline — retrying"
        case .preparing: return "Checking for updates"
        case .uploading: return "Uploading…"
        case .upToDate: return "Up to date"
        }
    }

    static func detail(for state: DisplayState, message: String?) -> String? {
        switch state {
        case .notRunning: return "Agent Relay is starting the uploader again."
        case .paused: return "Nothing is uploaded until you resume."
        case .needsAttention(let sentence): return sentence
        case .conflict: return message ?? "Receiver-proven records were quarantined. Inspect conflicts for repair."
        case .offline:
            if let message, !message.isEmpty { return message }
            return "Agent Relay will try again shortly."
        case .preparing: return "Checking session changes in the background."
        case .uploading:
            if let message, !message.isEmpty { return message }
            return nil
        case .upToDate: return "Monitoring for new session activity."
        }
    }
}
