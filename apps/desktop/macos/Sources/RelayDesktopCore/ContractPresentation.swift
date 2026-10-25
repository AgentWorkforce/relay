import Foundation

// How the app presents the generated bridge contract types
// (`CoreContract.swift`): identities, labels and derived values. The types
// themselves come from the core's Rust registry.

public enum BridgeTime {
    /// Milliseconds since the epoch; zero, negative and missing mean never.
    public static func date(milliseconds: Int64?) -> Date? {
        guard let milliseconds, milliseconds > 0 else { return nil }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000.0)
    }
}

public enum SkipDate {
    public static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

// MARK: - Snapshot

extension WorkspaceStatus {
    public var isFound: Bool { state == .found }
}

extension PushState {
    public var isLive: Bool { self == .live }
}

extension SignInState {
    /// The last attempt ended without a session.
    public var isFailure: Bool { self == .denied || self == .expired || self == .error }
}

extension AccountStatus {
    public static let signedOut = AccountStatus(state: .signedOut)
}

extension SignInReport {
    /// The account part of the report, as `status.account` carries it.
    public var account: AccountStatus {
        AccountStatus(action: action, error: error, person: person, phase: phase, progress: progress,
                      reusedLogin: reusedLogin, siteUrl: siteUrl, state: state, workspaceId: workspaceId,
                      workspaceName: workspaceName)
    }

    /// The page to open: the complete link when there is one.
    public var link: String? { verificationUrlComplete ?? verificationUrl }
}

extension CaptureProgress {
    public var isCapturing: Bool { phase == "scanning" || phase == "capture_paused" }
    public var headline: String { phase == "capture_paused" ? "History preparation paused · Retrying" : "Reading local history" }
    public var detail: String {
        let count = totalFiles.map { "\(processedFiles.formatted()) of \($0.formatted()) files processed" }
            ?? "\(processedFiles.formatted()) files processed"
        return "\(source.isEmpty ? "Local history" : source.capitalized): \(count) · \(sessionsCaptured.formatted()) sessions captured locally."
    }
    public var fraction: Double? {
        guard let totalFiles, totalFiles > 0 else { return nil }
        return min(1, max(0, Double(processedFiles) / Double(totalFiles)))
    }
}

// MARK: - Sessions and agents on this computer

/// The app a person chats with a session in, when it is not the provider's
/// own: Conductor runs Claude Code and Codex sessions in its workspaces.
public enum SessionHost {
    /// The host's name, or nil for a session in the provider's own app.
    public static func name(_ host: String?) -> String? {
        switch host?.lowercased() {
        case "conductor": return "Conductor"
        case "paseo": return "Paseo"
        default: return nil
        }
    }

    /// The icon's tooltip: "Codex in Conductor", or the provider alone.
    public static func label(provider: String, host: String?) -> String {
        name(host).map { "\(provider) in \($0)" } ?? provider
    }
}

extension SessionKind {
    public var label: String {
        switch self {
        case .codex: return "Codex"
        case .claudeTerminal: return "Claude Code"
        case .claudeCloud: return "Claude app"
        case .grok, .grokOpen: return "Grok"
        case .opencode, .opencodeOpen: return "OpenCode"
        case .museOpen: return "Muse"
        case .devin: return "Devin"
        case .openclaw: return "OpenClaw"
        case .hermes: return "Hermes"
        case .pi: return "Pi"
        case .unknown(let kind): return kind
        }
    }

    /// The icon and history source name.
    public var source: String {
        switch self {
        case .codex: return "codex"
        case .claudeTerminal, .claudeCloud: return "claude"
        case .grok, .grokOpen: return "grok"
        case .opencode, .opencodeOpen: return "opencode"
        case .museOpen: return "muse"
        case .devin: return "devin"
        case .openclaw: return "openclaw"
        case .hermes: return "hermes"
        case .pi: return "pi"
        case .unknown(let kind): return kind
        }
    }
}

extension LocalSession {
    /// An OpenCode window that was open before Agent Relay's OpenCode plugin
    /// was on: running, listed, but unreachable until OpenCode restarts. A
    /// registered session whose window has closed is not running, and is
    /// hidden like any ended session.
    public var needsOpenCodeRestart: Bool { !live && running != false && target.kind == .opencodeOpen }
}

extension Target {
    /// `kind:id`, unique across kinds.
    public var key: String { "\(kind.rawValue):\(id)" }

    /// The `SOURCE:ID` key the uploader lists this session under; a Claude
    /// app session has no local transcript and none.
    public var uploadKey: String? {
        switch kind {
        // Every route names a session by its harness's own id.
        case .codex, .claudeTerminal, .grok, .grokOpen, .opencode, .opencodeOpen, .museOpen, .devin:
            return "\(kind.source):\(id)"
        case .claudeCloud, .openclaw, .hermes, .pi, .unknown: return nil
        }
    }
}

extension LocalSession: Identifiable {
    public var id: String { target.key }
    public var updatedAt: Date? { BridgeTime.date(milliseconds: updatedAtMs) }
    public var projectName: String? { project.flatMap { $0.isEmpty ? nil : $0 } }
}

extension AgentIntegration: Identifiable {
    public var id: String { "\(provider):\(resource)" }
}

extension LocalAgent: Identifiable {
    public var id: String { name }
}

extension DeliveryActivity: Identifiable {
    public var id: String { "\(atMs)-\(agent)-\(preview.hashValue)" }
    public var date: Date? { BridgeTime.date(milliseconds: atMs) }
}

// MARK: - Fleet

extension WorkerRow: Identifiable {
    public var stateLabel: String {
        switch state {
        case .starting: return "Starting"
        case .working: return "Working"
        case .idle: return "Idle"
        case .waiting: return "Waiting for input"
        case .unknown: return "Status unknown"
        }
    }
}

extension BrokerListing: Identifiable {
    public var id: String { nodeId }
}

// MARK: - Workspace directory and messaging

extension RosterAgent: Identifiable {
    public var id: String { address ?? name }

    public var whereLabel: String {
        switch `where` {
        case .thisComputer: return "this computer"
        case .cloud: return "cloud"
        case .otherDesktop: return host.map { "on \($0)" } ?? "another computer"
        }
    }

    /// The harness whose mark the roster row draws, when the registrar said
    /// which it is; nil draws the generic person, service or agent glyph.
    public var harnessSource: String? {
        guard let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines),
              !provider.isEmpty else { return nil }
        return provider
    }
}

extension WorkspacePerson: Identifiable {
    public var id: String { identityHash }
}

extension DirectMessage: Identifiable {}

// MARK: - Uploader

extension SharingMode {
    /// The order Settings offers the modes in.
    public static let displayOrder: [SharingMode] = [.selected, .new, .all]

    public var title: String {
        switch self {
        case .all: return "Automatically upload all sessions, past and future"
        case .new: return "Automatically upload new sessions"
        case .selected: return "Only sessions I choose"
        }
    }

    public var explanation: String {
        switch self {
        case .all:
            return "Every existing and future local coding session uploads automatically, without selecting it first."
        case .new:
            return "Upload new sessions automatically. Existing sessions stay local unless you choose to share them."
        case .selected:
            return "New sessions stay local until you turn on Upload session. Once enabled, those sessions keep uploading changes until you turn it off."
        }
    }

    public var confirmationTitle: String {
        switch self {
        case .selected: return "Upload only sessions you choose?"
        case .new: return "Automatically upload new sessions?"
        case .all: return "Automatically upload all sessions?"
        }
    }

    public var confirmationAction: String {
        switch self {
        case .selected: return "Use selected sessions only"
        case .new: return "Enable automatic uploads"
        case .all: return "Upload all past and future sessions"
        }
    }
}

extension UploadSession: Identifiable {
    /// `SOURCE:ID`.
    public var id: String { "\(source):\(sessionId)" }

    /// Project for old cores that did not resolve repository identity.
    public var legacyProject: String {
        guard let cwd, !cwd.isEmpty else { return "" }
        let trimmed = cwd.hasSuffix("/") && cwd.count > 1 ? String(cwd.dropLast()) : cwd
        let component = (trimmed as NSString).lastPathComponent
        return component == "/" ? "" : component
    }

    /// The core-resolved project, or the cwd folder for an older core.
    public var displayProject: String { project ?? legacyProject }

    /// The local title, else the id.
    public var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? sessionId : trimmed
    }

    public var lastActivity: Date? { BridgeTime.date(milliseconds: lastActivityMs) }

    /// What a confirmed include or exclude makes this row until the next listing.
    public func withInclusion(_ included: Bool) -> UploadSession {
        UploadSession(cwd: cwd, firstActivityMs: firstActivityMs, gitBranch: gitBranch, host: host, included: included,
                      isAgent: isAgent, lastActivityMs: lastActivityMs, models: models, project: project, reasoningEffort: reasoningEffort, sessionId: sessionId, source: source,
                      status: included ? .shared : .notShared, title: title)
    }
}

// MARK: - Incoming messages

extension IncomingThread: Identifiable {}
extension HeldMessage: Identifiable {}

extension IncomingStatus {
    public var stateLabel: String {
        switch state {
        case .connected: return "Receiving messages."
        case .connecting: return "Connecting…"
        case .polling: return "Checking for messages."
        case .paused: return "Paused with uploads."
        case .needsSignIn: return "Sign in again to receive messages."
        case .unavailable: return "Incoming messages are not available for this account."
        case .stopped: return "Not receiving messages."
        }
    }
}

// MARK: - Skip chat

extension TurnReference: Identifiable {
    public var id: String { "\(source ?? ""):\(sessionId)" }
}

extension SendReceipt {
    public var sent: Bool { state == .sent }

    public var message: String {
        switch state {
        case .sent: return agent.map { "Sent to @\($0)." } ?? "Sent."
        case .sending: return "Sending…"
        case .unconfirmed: return "Send could not be confirmed" + (detail.map { ": \($0)" } ?? ".")
        }
    }
}

extension TurnAction: Identifiable {}
extension ConversationTurn: Identifiable {}

extension ChatConversation {
    public static let empty = ChatConversation(messages: [], sending: false)
}

extension SkipWorkState {
    public var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .ready: return "Skip can push"
        case .working: return "Working"
        case .idle: return "Idle"
        case .done: return "Done"
        }
    }
}

extension ProjectSession: Identifiable {
    public var id: String { key }
    /// Whether Skip has a message to move this session along.
    public var canPush: Bool { pushKey != nil && !(nudge ?? "").isEmpty }
}

extension Project: Identifiable {}

extension ProjectsReport {
    public var generatedDate: Date? { SkipDate.parse(generatedAt) }

    /// Sessions Skip can move along that have not been pushed.
    public var waiting: [ProjectSession] {
        projects.flatMap(\.sessions).filter { $0.canPush && $0.receipt == nil }
    }

    public func count(_ state: SkipWorkState) -> Int { projects.filter { $0.state == state }.count }
}

extension PushOutcome {
    /// Why a push could not start, as the page says it.
    public var note: String? {
        switch outcome {
        case .sent, .alreadyPushed: return nil
        case .unconfirmed: return detail.map { "Send could not be confirmed: \($0)" } ?? "Send could not be confirmed."
        case .notPushable: return "Skip has nothing to send for this session now. Refresh the briefing."
        case .notOnThisComputer: return "Not among the local sessions in Agents. Start it here, then push again."
        case .accountWorkspaceNotConnected: return "Connect this account’s workspace in Agents so Skip can reach the session."
        case .otherWorkspace: return "This session is on a different Agent Relay workspace than this account."
        case .registerFailed: return "Could not put the session on the relay" + (detail.map { ": \($0)" } ?? ".")
        }
    }
}

extension SessionEvent: Identifiable {}

// MARK: - Contractor access

extension Access {
    public var label: String {
        switch self {
        case .none: return "None"
        case .read: return "Read"
        case .write: return "Write"
        }
    }
}

extension AccessGrant: Identifiable {
    /// What the grant allows, e.g. "GitHub (write), Linear (read)".
    public func summary(names: [String: String] = [:]) -> String {
        let granted = scopes.filter { $0.access != .none }
        guard !granted.isEmpty else { return "No access" }
        return granted.map { "\(names[$0.service] ?? $0.service) (\($0.access.rawValue))" }.joined(separator: ", ")
    }
}

extension PendingSeat: Identifiable {
    public var id: String { userId }
}

extension Service: Identifiable {}

extension ContractorStatus {
    public var isVisible: Bool { availability == .ready || availability == .failed }
    public var isOwner: Bool { role == .owner }
    public var serviceNames: [String: String] {
        Dictionary(services.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    }
}

public extension RequestEntry {
    /// A Relay Connect room's calls are named for the room, so its
    /// workspace's limits are not read as the team's.
    var serviceName: String {
        guard service == "Relaycast" else { return service }
        return connect == true ? "Relay Connect" : "Agent Relay"
    }
    var failureSummary: String {
        if service == "Cloud", status == 403, endpoint.contains("/messaging/desktop-identities") {
            return "Agents couldn't link to Cloud"
        }
        return "\(serviceName) request failed"
    }
}
