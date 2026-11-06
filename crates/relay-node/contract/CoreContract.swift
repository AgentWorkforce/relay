// The relay core's bridge contract for the macOS app.
//
// Generated from the Rust contract registry (crates/relay-node/src/relay/contract).
// Do not edit; regenerate with `crates/relay-node/scripts/generate-contract.sh`.

import Foundation

/// The bridge contract version this app speaks.
public enum CoreBridgeVersion {
    public static let current = 2
}

/// Every bridge method's wire name.
public enum CoreMethod {
    /// The JSON-RPC notification every event travels under.
    public static let event = "event"
    public static let hello = "hello"
    public static let diagnosticsRequests = "diagnostics.requests"
    public static let statusGet = "status.get"
    public static let subscribe = "subscribe"
    public static let unsubscribe = "unsubscribe"
    public static let workspaceRefresh = "workspace.refresh"
    public static let workspaceVerify = "workspace.verify"
    public static let daemonShutdown = "daemon.shutdown"
    public static let sessionsList = "sessions.list"
    public static let sessionsTitleCapability = "sessions.title.capability"
    public static let sessionsTitleSet = "sessions.title.set"
    public static let sessionsManagedLaunch = "sessions.managed.launch"
    public static let sessionsExistingRegister = "sessions.existing.register"
    public static let spawnTargets = "spawn.targets"
    public static let spawnInvoke = "spawn.invoke"
    public static let spawnStatus = "spawn.status"
    public static let spawnRelease = "spawn.release"
    public static let spawnClaimRetry = "spawn.claim.retry"
    public static let agentsList = "agents.list"
    public static let agentsRegister = "agents.register"
    public static let agentsUnregister = "agents.unregister"
    public static let agentsEnd = "agents.end"
    public static let agentsRename = "agents.rename"
    public static let agentsTestMessage = "agents.test_message"
    public static let agentsReplySetting = "agents.reply_setting"
    public static let agentsTranscript = "agents.transcript"
    public static let agentsTakeOver = "agents.take_over"
    public static let agentsWebhookCreate = "agents.webhook.create"
    public static let agentsWebhookRevoke = "agents.webhook.revoke"
    public static let agentsIntegrationsSubscribe = "agents.integrations.subscribe"
    public static let agentsIntegrationsUnsubscribe = "agents.integrations.unsubscribe"
    public static let agentsIntegrationsCleanUp = "agents.integrations.clean_up"
    public static let settingsGet = "settings.get"
    public static let settingsSet = "settings.set"
    public static let activityList = "activity.list"
    public static let claudeDeliveryStatus = "claude_delivery.status"
    public static let claudeDeliveryRestrict = "claude_delivery.restrict"
    public static let claudeDeliverySession = "claude_delivery.session"
    public static let claudeDeliverySender = "claude_delivery.sender"
    public static let claudeDeliveryApprove = "claude_delivery.approve"
    public static let claudeDeliveryDismiss = "claude_delivery.dismiss"
    public static let openclawRelayToolsStatus = "openclaw.relay_tools.status"
    public static let openclawRelayToolsConnect = "openclaw.relay_tools.connect"
    public static let rosterList = "roster.list"
    public static let rosterGet = "roster.get"
    public static let fleetList = "fleet.list"
    public static let fleetRelease = "fleet.release"
    public static let messagesConversations = "messages.conversations"
    public static let messagesHistory = "messages.history"
    public static let messagesSend = "messages.send"
    public static let peopleList = "people.list"
    public static let linksParse = "links.parse"
}

/// Free JSON, where the contract carries a value it does not shape.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    /// A number written without a fraction or exponent, kept exact.
    case integer(Int64)
    /// An integer above `Int64.max`, kept exact.
    case unsigned(UInt64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? c.decode(UInt64.self) {
            self = .unsigned(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let value): try c.encode(value)
        case .integer(let value): try c.encode(value)
        case .unsigned(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        }
    }
}

/// What the person can do about a failed sign-in.
public enum AccountAction: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    /// `account.sign_in` with `acknowledge_uninspected_schedules` retries
    /// past an older uploader's schedules that could not be checked.
    case acknowledgeUninspectedSchedules
    /// The account has no workspace: the person creates one in the Cloud
    /// dashboard's Workspace settings, then signs in again.
    case createWorkspace
    /// A value this build does not know, as the core sent it.
    case unknown(String)

    public static let allCases: [AccountAction] = [.acknowledgeUninspectedSchedules, .createWorkspace]

    public init(rawValue: String) {
        switch rawValue {
        case "acknowledge_uninspected_schedules": self = .acknowledgeUninspectedSchedules
        case "create_workspace": self = .createWorkspace
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .acknowledgeUninspectedSchedules: return "acknowledge_uninspected_schedules"
        case .createWorkspace: return "create_workspace"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// The signed-in person, as the uploader recorded them.
public struct AccountPerson: Codable, Equatable, Hashable, Sendable {
    public let avatarUrl: String?
    public let email: String?
    public let id: String?
    public let name: String?

    public init(avatarUrl: String? = nil, email: String? = nil, id: String? = nil, name: String? = nil) {
        self.avatarUrl = avatarUrl
        self.email = email
        self.id = id
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case avatarUrl = "avatar_url"
        case email
        case id
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        self.email = try c.decodeIfPresent(String.self, forKey: .email)
        self.id = try c.decodeIfPresent(String.self, forKey: .id)
        self.name = try c.decodeIfPresent(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.avatarUrl, forKey: .avatarUrl)
        try c.encode(self.email, forKey: .email)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.name, forKey: .name)
    }
}

/// `status.account`: typed state for the UI, never the session itself.
public struct AccountStatus: Codable, Equatable, Hashable, Sendable {
    /// What the person can do about `error`.
    public let action: AccountAction?
    /// Last completed authentication check, milliseconds since the Unix epoch.
    public let authCheckedAt: Int64?
    public let authError: String?
    /// Live Cloud authentication and Relaycast verification, independently of uploader installation.
    public let authHealth: String?
    public let error: String?
    /// Signed in, but this computer holds no Cloud session it may use: Cloud
    /// refused the kept one even after a refresh. Cloud calls answer
    /// `not_signed_in` until the person signs in again.
    public let needsSignIn: Bool?
    public let person: AccountPerson?
    /// What the attempt is doing: `checking_existing_login`,
    /// `reusing_existing_login`, `waiting_for_browser`,
    /// `waiting_for_device_approval`, `selecting_workspace`, `connecting_workspace`,
    /// `preparing_local_sessions`.
    public let phase: String?
    /// Local capture progress while sessions are prepared.
    public let progress: CaptureProgress?
    public let reusedLogin: Bool?
    public let siteUrl: String?
    public let state: SignInState
    public let workspaceAvatarUrl: String?
    public let workspaceChoices: [WorkspaceChoice]?
    /// Distinct workspaces available to the signed-in person; absent on older Cloud versions.
    public let workspaceCount: Int?
    /// The Agent Relay (Cloud) workspace.
    public let workspaceId: String?
    public let workspaceName: String?

    public init(action: AccountAction? = nil, authCheckedAt: Int64? = nil, authError: String? = nil, authHealth: String? = nil, error: String? = nil, needsSignIn: Bool? = nil, person: AccountPerson? = nil, phase: String? = nil, progress: CaptureProgress? = nil, reusedLogin: Bool? = nil, siteUrl: String? = nil, state: SignInState, workspaceAvatarUrl: String? = nil, workspaceChoices: [WorkspaceChoice]? = nil, workspaceCount: Int? = nil, workspaceId: String? = nil, workspaceName: String? = nil) {
        self.action = action
        self.authCheckedAt = authCheckedAt
        self.authError = authError
        self.authHealth = authHealth
        self.error = error
        self.needsSignIn = needsSignIn
        self.person = person
        self.phase = phase
        self.progress = progress
        self.reusedLogin = reusedLogin
        self.siteUrl = siteUrl
        self.state = state
        self.workspaceAvatarUrl = workspaceAvatarUrl
        self.workspaceChoices = workspaceChoices
        self.workspaceCount = workspaceCount
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
    }

    enum CodingKeys: String, CodingKey {
        case action
        case authCheckedAt = "auth_checked_at"
        case authError = "auth_error"
        case authHealth = "auth_health"
        case error
        case needsSignIn = "needs_sign_in"
        case person
        case phase
        case progress
        case reusedLogin = "reused_login"
        case siteUrl = "site_url"
        case state
        case workspaceAvatarUrl = "workspace_avatar_url"
        case workspaceChoices = "workspace_choices"
        case workspaceCount = "workspace_count"
        case workspaceId = "workspace_id"
        case workspaceName = "workspace_name"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.action = try c.decodeIfPresent(AccountAction.self, forKey: .action)
        self.authCheckedAt = try c.decodeIfPresent(Int64.self, forKey: .authCheckedAt)
        self.authError = try c.decodeIfPresent(String.self, forKey: .authError)
        self.authHealth = try c.decodeIfPresent(String.self, forKey: .authHealth)
        self.error = try c.decodeIfPresent(String.self, forKey: .error)
        self.needsSignIn = try c.decodeIfPresent(Bool.self, forKey: .needsSignIn)
        self.person = try c.decodeIfPresent(AccountPerson.self, forKey: .person)
        self.phase = try c.decodeIfPresent(String.self, forKey: .phase)
        self.progress = try c.decodeIfPresent(CaptureProgress.self, forKey: .progress)
        self.reusedLogin = try c.decodeIfPresent(Bool.self, forKey: .reusedLogin)
        self.siteUrl = try c.decodeIfPresent(String.self, forKey: .siteUrl)
        self.state = try c.decode(SignInState.self, forKey: .state)
        self.workspaceAvatarUrl = try c.decodeIfPresent(String.self, forKey: .workspaceAvatarUrl)
        self.workspaceChoices = try c.decodeIfPresent([WorkspaceChoice].self, forKey: .workspaceChoices)
        self.workspaceCount = try c.decodeIfPresent(Int.self, forKey: .workspaceCount)
        self.workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        self.workspaceName = try c.decodeIfPresent(String.self, forKey: .workspaceName)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.action, forKey: .action)
        try c.encode(self.authCheckedAt, forKey: .authCheckedAt)
        try c.encode(self.authError, forKey: .authError)
        try c.encode(self.authHealth, forKey: .authHealth)
        try c.encode(self.error, forKey: .error)
        try c.encodeIfPresent(self.needsSignIn, forKey: .needsSignIn)
        try c.encode(self.person, forKey: .person)
        try c.encode(self.phase, forKey: .phase)
        try c.encode(self.progress, forKey: .progress)
        try c.encode(self.reusedLogin, forKey: .reusedLogin)
        try c.encode(self.siteUrl, forKey: .siteUrl)
        try c.encode(self.state, forKey: .state)
        try c.encode(self.workspaceAvatarUrl, forKey: .workspaceAvatarUrl)
        try c.encode(self.workspaceChoices, forKey: .workspaceChoices)
        try c.encode(self.workspaceCount, forKey: .workspaceCount)
        try c.encode(self.workspaceId, forKey: .workspaceId)
        try c.encode(self.workspaceName, forKey: .workspaceName)
    }
}

/// The `activity` topic: one line for the UI's log.
public struct ActivityLine: Codable, Equatable, Hashable, Sendable {
    public let atMs: Int64
    public let level: Level
    public let message: String

    public init(atMs: Int64, level: Level, message: String) {
        self.atMs = atMs
        self.level = level
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case atMs = "at_ms"
        case level
        case message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.atMs = try c.decode(Int64.self, forKey: .atMs)
        self.level = try c.decode(Level.self, forKey: .level)
        self.message = try c.decode(String.self, forKey: .message)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.atMs, forKey: .atMs)
        try c.encode(self.level, forKey: .level)
        try c.encode(self.message, forKey: .message)
    }
}

/// `activity.list`'s result, newest first.
public struct ActivityLog: Codable, Equatable, Hashable, Sendable {
    public let activity: [DeliveryActivity]

    public init(activity: [DeliveryActivity]) {
        self.activity = activity
    }

    enum CodingKeys: String, CodingKey {
        case activity
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.activity = try c.decode([DeliveryActivity].self, forKey: .activity)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.activity, forKey: .activity)
    }
}

/// What an agent is doing, as the desktop it runs on derived it. Every
/// field is absent when its harness or session does not say.
public struct AgentActivity: Codable, Equatable, Hashable, Sendable {
    /// The checked-out branch, or a short commit when detached.
    public let branch: String?
    /// The session's title and its to-do list's item in progress, at most
    /// `DOING_CHARACTERS` characters, without invite links.
    public let doing: String?
    /// The repository of its working directory: the `origin` remote's
    /// name, else the checkout's folder name.
    public let repo: String?
    public let turn: AgentTurn?
    /// When it last changed, in milliseconds since the epoch.
    public let updatedMs: Int64?

    public init(branch: String? = nil, doing: String? = nil, repo: String? = nil, turn: AgentTurn? = nil, updatedMs: Int64? = nil) {
        self.branch = branch
        self.doing = doing
        self.repo = repo
        self.turn = turn
        self.updatedMs = updatedMs
    }

    enum CodingKeys: String, CodingKey {
        case branch
        case doing
        case repo
        case turn
        case updatedMs = "updated_ms"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.branch = try c.decodeIfPresent(String.self, forKey: .branch)
        self.doing = try c.decodeIfPresent(String.self, forKey: .doing)
        self.repo = try c.decodeIfPresent(String.self, forKey: .repo)
        self.turn = try c.decodeIfPresent(AgentTurn.self, forKey: .turn)
        self.updatedMs = try c.decodeIfPresent(Int64.self, forKey: .updatedMs)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.branch, forKey: .branch)
        try c.encodeIfPresent(self.doing, forKey: .doing)
        try c.encodeIfPresent(self.repo, forKey: .repo)
        try c.encodeIfPresent(self.turn, forKey: .turn)
        try c.encodeIfPresent(self.updatedMs, forKey: .updatedMs)
    }
}

public struct AgentIntegration: Codable, Equatable, Hashable, Sendable {
    public let provider: String
    public let ready: Bool
    public let resource: String

    public init(provider: String, ready: Bool, resource: String) {
        self.provider = provider
        self.ready = ready
        self.resource = resource
    }

    enum CodingKeys: String, CodingKey {
        case provider
        case ready
        case resource
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.provider = try c.decode(String.self, forKey: .provider)
        self.ready = try c.decode(Bool.self, forKey: .ready)
        self.resource = try c.decode(String.self, forKey: .resource)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.provider, forKey: .provider)
        try c.encode(self.ready, forKey: .ready)
        try c.encode(self.resource, forKey: .resource)
    }
}

/// One setting an agent changed on the session socket, as Settings shows it.
public struct AgentSettingsChange: Codable, Equatable, Hashable, Sendable {
    /// When, as RFC 3339.
    public let at: String
    /// The agent's name on the relay, or its session when it is not on it.
    public let by: String
    /// The value before, as JSON text; absent when it had none.
    public let from: String?
    /// The setting, as `settings.get` names it.
    public let key: String
    /// The value set, as JSON text.
    public let to: String

    public init(at: String, by: String, from: String? = nil, key: String, to: String) {
        self.at = at
        self.by = by
        self.from = from
        self.key = key
        self.to = to
    }

    enum CodingKeys: String, CodingKey {
        case at
        case by
        case from
        case key
        case to
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.at = try c.decode(String.self, forKey: .at)
        self.by = try c.decode(String.self, forKey: .by)
        self.from = try c.decodeIfPresent(String.self, forKey: .from)
        self.key = try c.decode(String.self, forKey: .key)
        self.to = try c.decode(String.self, forKey: .to)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.at, forKey: .at)
        try c.encode(self.by, forKey: .by)
        try c.encodeIfPresent(self.from, forKey: .from)
        try c.encode(self.key, forKey: .key)
        try c.encode(self.to, forKey: .to)
    }
}

/// `agents.transcript`'s parameters: a spawned agent by name, read from
/// `cursor` on (from the start without one).
public struct AgentTranscriptParams: Codable, Equatable, Hashable, Sendable {
    public let cursor: LocalTranscriptCursor?
    public let name: String

    public init(cursor: LocalTranscriptCursor? = nil, name: String) {
        self.cursor = cursor
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case cursor
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.cursor = try c.decodeIfPresent(LocalTranscriptCursor.self, forKey: .cursor)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.cursor, forKey: .cursor)
        try c.encode(self.name, forKey: .name)
    }
}

/// Whether a turn is running.
public enum AgentTurn: String, Codable, CaseIterable, Hashable, Sendable {
    /// A turn is running, or one is blocked on a permission.
    case working
    /// Between turns: ready for a message.
    case idle

    /// A value this build does not know reads as `idle`.
    public init(from decoder: Decoder) throws {
        self = AgentTurn(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .idle
    }
}

public struct AgentWebhook: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let url: String

    public init(id: String, url: String) {
        self.id = id
        self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case id
        case url
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.url = try c.decode(String.self, forKey: .url)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.url, forKey: .url)
    }
}

/// `agents.list`'s result.
public struct Agents: Codable, Equatable, Hashable, Sendable {
    public let agents: [LocalAgent]
    /// Agents that left the relay because their session was archived,
    /// newest first.
    public let archived: [ArchivedAgent]

    public init(agents: [LocalAgent], archived: [ArchivedAgent]) {
        self.agents = agents
        self.archived = archived
    }

    enum CodingKeys: String, CodingKey {
        case agents
        case archived
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agents = try c.decode([LocalAgent].self, forKey: .agents)
        self.archived = try c.decode([ArchivedAgent].self, forKey: .archived)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agents, forKey: .agents)
        try c.encode(self.archived, forKey: .archived)
    }
}

/// Problems with this computer's agents as a whole; per-agent detail is in
/// `agents.list` and `activity.list`.
public struct AgentsStatus: Codable, Equatable, Hashable, Sendable {
    /// The first agent whose delivery queue could not be read, and why.
    public let deliveryError: String?
    /// A local integration could not finish setup; retained for late-connecting apps.
    public let integrationError: String?
    /// Why the agent store could not be read or saved.
    public let storeError: String?

    public init(deliveryError: String? = nil, integrationError: String? = nil, storeError: String? = nil) {
        self.deliveryError = deliveryError
        self.integrationError = integrationError
        self.storeError = storeError
    }

    enum CodingKeys: String, CodingKey {
        case deliveryError = "delivery_error"
        case integrationError = "integration_error"
        case storeError = "store_error"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.deliveryError = try c.decodeIfPresent(String.self, forKey: .deliveryError)
        self.integrationError = try c.decodeIfPresent(String.self, forKey: .integrationError)
        self.storeError = try c.decodeIfPresent(String.self, forKey: .storeError)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.deliveryError, forKey: .deliveryError)
        try c.encodeIfPresent(self.integrationError, forKey: .integrationError)
        try c.encode(self.storeError, forKey: .storeError)
    }
}

/// An agent that left the relay because its session was archived; its
/// name was released.
public struct ArchivedAgent: Codable, Equatable, Hashable, Sendable {
    public let address: String
    /// ISO-8601, seconds precision.
    public let archivedAt: String
    public let name: String
    public let target: Target
    public let title: String

    public init(address: String, archivedAt: String, name: String, target: Target, title: String) {
        self.address = address
        self.archivedAt = archivedAt
        self.name = name
        self.target = target
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case address
        case archivedAt = "archived_at"
        case name
        case target
        case title
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.address = try c.decode(String.self, forKey: .address)
        self.archivedAt = try c.decode(String.self, forKey: .archivedAt)
        self.name = try c.decode(String.self, forKey: .name)
        self.target = try c.decode(Target.self, forKey: .target)
        self.title = try c.decode(String.self, forKey: .title)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.address, forKey: .address)
        try c.encode(self.archivedAt, forKey: .archivedAt)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.target, forKey: .target)
        try c.encode(self.title, forKey: .title)
    }
}

/// One broker of `fleet.list`: its workers, or why they could not be read.
public struct BrokerListing: Codable, Equatable, Hashable, Sendable {
    /// Set when the broker could not be read; `workers` is then empty and
    /// means nothing.
    public let error: String?
    /// The node's display name.
    public let name: String
    /// The broker's scope: its node id, else its state directory.
    public let nodeId: String
    /// Most recently active first.
    public let workers: [WorkerRow]
    public let workspaceId: String?

    public init(error: String? = nil, name: String, nodeId: String, workers: [WorkerRow], workspaceId: String? = nil) {
        self.error = error
        self.name = name
        self.nodeId = nodeId
        self.workers = workers
        self.workspaceId = workspaceId
    }

    enum CodingKeys: String, CodingKey {
        case error
        case name
        case nodeId = "node_id"
        case workers
        case workspaceId = "workspace_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.error = try c.decodeIfPresent(String.self, forKey: .error)
        self.name = try c.decode(String.self, forKey: .name)
        self.nodeId = try c.decode(String.self, forKey: .nodeId)
        self.workers = try c.decode([WorkerRow].self, forKey: .workers)
        self.workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.error, forKey: .error)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.nodeId, forKey: .nodeId)
        try c.encode(self.workers, forKey: .workers)
        try c.encodeIfPresent(self.workspaceId, forKey: .workspaceId)
    }
}

/// Local capture progress while sessions are prepared for upload.
public struct CaptureProgress: Codable, Equatable, Hashable, Sendable {
    /// `scanning`, `capture_paused`, `watching`, …: the probe's phase.
    public let phase: String
    public let processedFiles: Int
    public let sessionsCaptured: Int
    /// The history source being read (`codex`, `claude`), or empty.
    public let source: String
    public let totalFiles: Int?

    public init(phase: String, processedFiles: Int, sessionsCaptured: Int, source: String, totalFiles: Int? = nil) {
        self.phase = phase
        self.processedFiles = processedFiles
        self.sessionsCaptured = sessionsCaptured
        self.source = source
        self.totalFiles = totalFiles
    }

    enum CodingKeys: String, CodingKey {
        case phase
        case processedFiles = "processed_files"
        case sessionsCaptured = "sessions_captured"
        case source
        case totalFiles = "total_files"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.phase = try c.decode(String.self, forKey: .phase)
        self.processedFiles = try c.decode(Int.self, forKey: .processedFiles)
        self.sessionsCaptured = try c.decode(Int.self, forKey: .sessionsCaptured)
        self.source = try c.decode(String.self, forKey: .source)
        self.totalFiles = try c.decodeIfPresent(Int.self, forKey: .totalFiles)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.phase, forKey: .phase)
        try c.encode(self.processedFiles, forKey: .processedFiles)
        try c.encode(self.sessionsCaptured, forKey: .sessionsCaptured)
        try c.encode(self.source, forKey: .source)
        try c.encode(self.totalFiles, forKey: .totalFiles)
    }
}

/// One watched Claude Code config folder.
public struct ClaudeConfigDir: Codable, Equatable, Hashable, Sendable {
    /// Why it is watched: `default` (the desktop's own), `sibling` (a
    /// `.claude-<name>` folder beside it), `environment`
    /// (`AGENT_RELAY_CLAUDE_CONFIG_DIRS`), `added` (in Settings) or
    /// `running` (a running Claude Code session's `CLAUDE_CONFIG_DIR`).
    public let origin: String
    public let path: String
    /// Its sessions may be put on the relay and uploaded. An unshared
    /// folder's sessions are not listed and never uploaded.
    public let shared: Bool

    public init(origin: String, path: String, shared: Bool) {
        self.origin = origin
        self.path = path
        self.shared = shared
    }

    enum CodingKeys: String, CodingKey {
        case origin
        case path
        case shared
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.origin = try c.decode(String.self, forKey: .origin)
        self.path = try c.decode(String.self, forKey: .path)
        self.shared = try c.decode(Bool.self, forKey: .shared)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.origin, forKey: .origin)
        try c.encode(self.path, forKey: .path)
        try c.encode(self.shared, forKey: .shared)
    }
}

/// A change to one watched Claude Code config folder. Each choice is
/// optional; one left out is unchanged.
public struct ClaudeConfigDirChange: Codable, Equatable, Hashable, Sendable {
    /// The folder, as `claude_config_dirs` lists it.
    public let path: String
    public let shared: Bool?

    public init(path: String, shared: Bool? = nil) {
        self.path = path
        self.shared = shared
    }

    enum CodingKeys: String, CodingKey {
        case path
        case shared
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.path = try c.decode(String.self, forKey: .path)
        self.shared = try c.decodeIfPresent(Bool.self, forKey: .shared)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.path, forKey: .path)
        try c.encodeIfPresent(self.shared, forKey: .shared)
    }
}

public struct ClaudeDeliveryChanged: Codable, Equatable, Hashable, Sendable {
    public let changed: Bool

    public init(changed: Bool) {
        self.changed = changed
    }

    enum CodingKeys: String, CodingKey {
        case changed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.changed = try c.decode(Bool.self, forKey: .changed)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.changed, forKey: .changed)
    }
}

public struct ClaudeDeliverySession: Codable, Equatable, Hashable, Sendable {
    public let agent: String
    /// `false` means Ask first for every message to this session.
    public let direct: Bool
    public let id: String
    public let title: String

    public init(agent: String, direct: Bool, id: String, title: String) {
        self.agent = agent
        self.direct = direct
        self.id = id
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case agent
        case direct
        case id
        case title
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agent = try c.decode(String.self, forKey: .agent)
        self.direct = try c.decode(Bool.self, forKey: .direct)
        self.id = try c.decode(String.self, forKey: .id)
        self.title = try c.decode(String.self, forKey: .title)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agent, forKey: .agent)
        try c.encode(self.direct, forKey: .direct)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.title, forKey: .title)
    }
}

public struct ClaudeDeliveryStatus: Codable, Equatable, Hashable, Sendable {
    public let allowedSenders: [ClaudeSender]
    public let held: [ClaudeHeldDelivery]
    public let restricted: Bool
    public let sessions: [ClaudeDeliverySession]

    public init(allowedSenders: [ClaudeSender], held: [ClaudeHeldDelivery], restricted: Bool, sessions: [ClaudeDeliverySession]) {
        self.allowedSenders = allowedSenders
        self.held = held
        self.restricted = restricted
        self.sessions = sessions
    }

    enum CodingKeys: String, CodingKey {
        case allowedSenders = "allowed_senders"
        case held
        case restricted
        case sessions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.allowedSenders = try c.decode([ClaudeSender].self, forKey: .allowedSenders)
        self.held = try c.decode([ClaudeHeldDelivery].self, forKey: .held)
        self.restricted = try c.decode(Bool.self, forKey: .restricted)
        self.sessions = try c.decode([ClaudeDeliverySession].self, forKey: .sessions)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.allowedSenders, forKey: .allowedSenders)
        try c.encode(self.held, forKey: .held)
        try c.encode(self.restricted, forKey: .restricted)
        try c.encode(self.sessions, forKey: .sessions)
    }
}

public struct ClaudeHeldDelivery: Codable, Equatable, Hashable, Sendable {
    public let agent: String
    public let heldAtMs: Int64
    public let id: String
    public let sender: String
    public let senderName: String
    public let sessionId: String
    public let text: String

    public init(agent: String, heldAtMs: Int64, id: String, sender: String, senderName: String, sessionId: String, text: String) {
        self.agent = agent
        self.heldAtMs = heldAtMs
        self.id = id
        self.sender = sender
        self.senderName = senderName
        self.sessionId = sessionId
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case agent
        case heldAtMs = "held_at_ms"
        case id
        case sender
        case senderName = "sender_name"
        case sessionId = "session_id"
        case text
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agent = try c.decode(String.self, forKey: .agent)
        self.heldAtMs = try c.decode(Int64.self, forKey: .heldAtMs)
        self.id = try c.decode(String.self, forKey: .id)
        self.sender = try c.decode(String.self, forKey: .sender)
        self.senderName = try c.decode(String.self, forKey: .senderName)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
        self.text = try c.decode(String.self, forKey: .text)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agent, forKey: .agent)
        try c.encode(self.heldAtMs, forKey: .heldAtMs)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.sender, forKey: .sender)
        try c.encode(self.senderName, forKey: .senderName)
        try c.encode(self.sessionId, forKey: .sessionId)
        try c.encode(self.text, forKey: .text)
    }
}

public struct ClaudeHeldParams: Codable, Equatable, Hashable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }

    enum CodingKeys: String, CodingKey {
        case id
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.id, forKey: .id)
    }
}

public struct ClaudeRestrictionParams: Codable, Equatable, Hashable, Sendable {
    public let restricted: Bool

    public init(restricted: Bool) {
        self.restricted = restricted
    }

    enum CodingKeys: String, CodingKey {
        case restricted
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.restricted = try c.decode(Bool.self, forKey: .restricted)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.restricted, forKey: .restricted)
    }
}

public struct ClaudeSender: Codable, Equatable, Hashable, Sendable {
    public let address: String
    public let name: String

    public init(address: String, name: String) {
        self.address = address
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case address
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.address = try c.decode(String.self, forKey: .address)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.address, forKey: .address)
        try c.encode(self.name, forKey: .name)
    }
}

public struct ClaudeSenderDeliveryParams: Codable, Equatable, Hashable, Sendable {
    public let allowed: Bool
    public let name: String
    public let sender: String

    public init(allowed: Bool, name: String, sender: String) {
        self.allowed = allowed
        self.name = name
        self.sender = sender
    }

    enum CodingKeys: String, CodingKey {
        case allowed
        case name
        case sender
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.allowed = try c.decode(Bool.self, forKey: .allowed)
        self.name = try c.decode(String.self, forKey: .name)
        self.sender = try c.decode(String.self, forKey: .sender)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.allowed, forKey: .allowed)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.sender, forKey: .sender)
    }
}

public struct ClaudeSessionDeliveryParams: Codable, Equatable, Hashable, Sendable {
    public let direct: Bool
    public let sessionId: String

    public init(direct: Bool, sessionId: String) {
        self.direct = direct
        self.sessionId = sessionId
    }

    enum CodingKeys: String, CodingKey {
        case direct
        case sessionId = "session_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.direct = try c.decode(Bool.self, forKey: .direct)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.direct, forKey: .direct)
        try c.encode(self.sessionId, forKey: .sessionId)
    }
}

/// One of your 1:1 conversations, as Relaycast lists it.
public struct Conversation: Codable, Equatable, Hashable, Sendable {
    public let id: String
    /// Relaycast's own summary of the last message.
    public let lastMessage: JSONValue
    public let peer: ConversationPeer?
    public let unreadCount: Int?

    public init(id: String, lastMessage: JSONValue, peer: ConversationPeer? = nil, unreadCount: Int? = nil) {
        self.id = id
        self.lastMessage = lastMessage
        self.peer = peer
        self.unreadCount = unreadCount
    }

    enum CodingKeys: String, CodingKey {
        case id
        case lastMessage = "last_message"
        case peer
        case unreadCount = "unread_count"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.lastMessage = try c.decode(JSONValue.self, forKey: .lastMessage)
        self.peer = try c.decodeIfPresent(ConversationPeer.self, forKey: .peer)
        self.unreadCount = try c.decodeIfPresent(Int.self, forKey: .unreadCount)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.lastMessage, forKey: .lastMessage)
        try c.encode(self.peer, forKey: .peer)
        try c.encode(self.unreadCount, forKey: .unreadCount)
    }
}

public struct ConversationPeer: Codable, Equatable, Hashable, Sendable {
    public let agentId: String?
    public let name: String

    public init(agentId: String? = nil, name: String) {
        self.agentId = agentId
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case agentId = "agent_id"
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agentId, forKey: .agentId)
        try c.encode(self.name, forKey: .name)
    }
}

/// `messages.conversations`'s result.
public struct Conversations: Codable, Equatable, Hashable, Sendable {
    public let conversations: [Conversation]
    /// Your relay identity's name.
    public let identity: String

    public init(conversations: [Conversation], identity: String) {
        self.conversations = conversations
        self.identity = identity
    }

    enum CodingKeys: String, CodingKey {
        case conversations
        case identity
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.conversations = try c.decode([Conversation].self, forKey: .conversations)
        self.identity = try c.decode(String.self, forKey: .identity)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.conversations, forKey: .conversations)
        try c.encode(self.identity, forKey: .identity)
    }
}

/// The `notify` topic: a notification for the UI to show.
public struct CoreNotification: Codable, Equatable, Hashable, Sendable {
    public let body: String
    /// Opens on click, e.g. a provider's connect page.
    public let link: String?
    public let title: String

    public init(body: String, link: String? = nil, title: String) {
        self.body = body
        self.link = link
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case body
        case link
        case title
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.body = try c.decode(String.self, forKey: .body)
        self.link = try c.decodeIfPresent(String.self, forKey: .link)
        self.title = try c.decode(String.self, forKey: .title)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.body, forKey: .body)
        try c.encode(self.link, forKey: .link)
        try c.encode(self.title, forKey: .title)
    }
}

public struct CreatedWebhook: Codable, Equatable, Hashable, Sendable {
    /// Whether this call created it.
    public let created: Bool
    public let id: String
    /// Only to the call that created the webhook.
    public let secret: String?
    public let url: String

    public init(created: Bool, id: String, secret: String? = nil, url: String) {
        self.created = created
        self.id = id
        self.secret = secret
        self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case created
        case id
        case secret
        case url
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.created = try c.decode(Bool.self, forKey: .created)
        self.id = try c.decode(String.self, forKey: .id)
        self.secret = try c.decodeIfPresent(String.self, forKey: .secret)
        self.url = try c.decode(String.self, forKey: .url)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.created, forKey: .created)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.secret, forKey: .secret)
        try c.encode(self.url, forKey: .url)
    }
}

public struct DaemonInfo: Codable, Equatable, Hashable, Sendable {
    public let bridgeVersion: Int
    /// Git revision of the service build; absent in older cores.
    public let buildRevision: String?
    /// The session-history library release this build carries
    /// (`Plugins::history_version`); absent without one.
    public let historyVersion: String?
    public let pid: Int
    public let socket: String
    public let startedAtMs: Int64
    public let version: String

    public init(bridgeVersion: Int, buildRevision: String? = nil, historyVersion: String? = nil, pid: Int, socket: String, startedAtMs: Int64, version: String) {
        self.bridgeVersion = bridgeVersion
        self.buildRevision = buildRevision
        self.historyVersion = historyVersion
        self.pid = pid
        self.socket = socket
        self.startedAtMs = startedAtMs
        self.version = version
    }

    enum CodingKeys: String, CodingKey {
        case bridgeVersion = "bridge_version"
        case buildRevision = "build_revision"
        case historyVersion = "history_version"
        case pid
        case socket
        case startedAtMs = "started_at_ms"
        case version
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.bridgeVersion = try c.decode(Int.self, forKey: .bridgeVersion)
        self.buildRevision = try c.decodeIfPresent(String.self, forKey: .buildRevision)
        self.historyVersion = try c.decodeIfPresent(String.self, forKey: .historyVersion)
        self.pid = try c.decode(Int.self, forKey: .pid)
        self.socket = try c.decode(String.self, forKey: .socket)
        self.startedAtMs = try c.decode(Int64.self, forKey: .startedAtMs)
        self.version = try c.decode(String.self, forKey: .version)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.bridgeVersion, forKey: .bridgeVersion)
        try c.encode(self.buildRevision, forKey: .buildRevision)
        try c.encode(self.historyVersion, forKey: .historyVersion)
        try c.encode(self.pid, forKey: .pid)
        try c.encode(self.socket, forKey: .socket)
        try c.encode(self.startedAtMs, forKey: .startedAtMs)
        try c.encode(self.version, forKey: .version)
    }
}

/// What a deep link asks for.
public enum DeepLink: Codable, Hashable, Sendable {
    /// Connect this computer to an Agent Relay account and workspace.
    case connect(accountId: String, siteUrl: String, workspaceId: String)
    /// Open the composer to this endpoint.
    case message(address: Bool, endpoint: String)
    /// A variant this build does not know, by the `kind` the core sent.
    case unknown(String)

    enum CodingKeys: String, CodingKey {
        case accountId = "account_id"
        case address
        case endpoint
        case kind
        case siteUrl = "site_url"
        case workspaceId = "workspace_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "connect": self = .connect(accountId: try c.decode(String.self, forKey: .accountId), siteUrl: try c.decode(String.self, forKey: .siteUrl), workspaceId: try c.decode(String.self, forKey: .workspaceId))
        case "message": self = .message(address: try c.decode(Bool.self, forKey: .address), endpoint: try c.decode(String.self, forKey: .endpoint))
        case let other: self = .unknown(other)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .connect(let accountId, let siteUrl, let workspaceId):
            try c.encode("connect", forKey: .kind)
            try c.encode(accountId, forKey: .accountId)
            try c.encode(siteUrl, forKey: .siteUrl)
            try c.encode(workspaceId, forKey: .workspaceId)
        case .message(let address, let endpoint):
            try c.encode("message", forKey: .kind)
            try c.encode(address, forKey: .address)
            try c.encode(endpoint, forKey: .endpoint)
        case .unknown(let value): try c.encode(value, forKey: .kind)
        }
    }
}

/// A message delivered to one of this computer's agents.
public struct DeliveryActivity: Codable, Equatable, Hashable, Sendable {
    public let agent: String
    public let atMs: Int64
    public let detail: String?
    public let outcome: DeliveryOutcome
    public let preview: String
    public let sender: String?
    /// Set for outcomes that place the message in the session.
    public let settlement: DeliverySettlement?

    public init(agent: String, atMs: Int64, detail: String? = nil, outcome: DeliveryOutcome, preview: String, sender: String? = nil, settlement: DeliverySettlement? = nil) {
        self.agent = agent
        self.atMs = atMs
        self.detail = detail
        self.outcome = outcome
        self.preview = preview
        self.sender = sender
        self.settlement = settlement
    }

    enum CodingKeys: String, CodingKey {
        case agent
        case atMs = "at_ms"
        case detail
        case outcome
        case preview
        case sender
        case settlement
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agent = try c.decode(String.self, forKey: .agent)
        self.atMs = try c.decode(Int64.self, forKey: .atMs)
        self.detail = try c.decodeIfPresent(String.self, forKey: .detail)
        self.outcome = try c.decode(DeliveryOutcome.self, forKey: .outcome)
        self.preview = try c.decode(String.self, forKey: .preview)
        self.sender = try c.decodeIfPresent(String.self, forKey: .sender)
        self.settlement = try c.decodeIfPresent(DeliverySettlement.self, forKey: .settlement)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agent, forKey: .agent)
        try c.encode(self.atMs, forKey: .atMs)
        try c.encode(self.detail, forKey: .detail)
        try c.encode(self.outcome, forKey: .outcome)
        try c.encode(self.preview, forKey: .preview)
        try c.encode(self.sender, forKey: .sender)
        try c.encode(self.settlement, forKey: .settlement)
    }
}

/// What happened to one delivery, as `activity.list` reports it.
public enum DeliveryOutcome: String, Codable, CaseIterable, Hashable, Sendable {
    case injected
    case skipped
    case failed
    case waiting
    case inDoubt = "in_doubt"
    /// An automatic final answer was sent.
    case answered

    /// A value this build does not know reads as `skipped`.
    public init(from decoder: Decoder) throws {
        self = DeliveryOutcome(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .skipped
    }
}

/// Where a message stands in the session it was handed to. A message the
/// session's own queue accepted is `handed_off`, or `waiting_for_turn` while
/// the session runs a turn it must finish first; it is `visible` once the
/// session records it (for a Codex queue handoff, its rollout records the
/// message's turn). A message Claude Code holds for the person's approval
/// before the session sees it is `held_for_approval`.
public enum DeliverySettlement: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    case handedOff
    case waitingForTurn
    case visible
    case heldForApproval
    /// A value this build does not know, as the core sent it.
    case unknown(String)

    public static let allCases: [DeliverySettlement] = [.handedOff, .waitingForTurn, .visible, .heldForApproval]

    public init(rawValue: String) {
        switch rawValue {
        case "handed_off": self = .handedOff
        case "waiting_for_turn": self = .waitingForTurn
        case "visible": self = .visible
        case "held_for_approval": self = .heldForApproval
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .handedOff: return "handed_off"
        case .waitingForTurn: return "waiting_for_turn"
        case .visible: return "visible"
        case .heldForApproval: return "held_for_approval"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// One message as a conversation shows it.
public struct DirectMessage: Codable, Equatable, Hashable, Sendable {
    public let createdAt: String?
    public let id: String
    public let mine: Bool
    public let sender: String
    public let senderAddress: String?
    public let senderId: String?
    public let text: String
    public let threadId: String?

    public init(createdAt: String? = nil, id: String, mine: Bool, sender: String, senderAddress: String? = nil, senderId: String? = nil, text: String, threadId: String? = nil) {
        self.createdAt = createdAt
        self.id = id
        self.mine = mine
        self.sender = sender
        self.senderAddress = senderAddress
        self.senderId = senderId
        self.text = text
        self.threadId = threadId
    }

    enum CodingKeys: String, CodingKey {
        case createdAt = "created_at"
        case id
        case mine
        case sender
        case senderAddress = "sender_address"
        case senderId = "sender_id"
        case text
        case threadId = "thread_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        self.id = try c.decode(String.self, forKey: .id)
        self.mine = try c.decode(Bool.self, forKey: .mine)
        self.sender = try c.decode(String.self, forKey: .sender)
        self.senderAddress = try c.decodeIfPresent(String.self, forKey: .senderAddress)
        self.senderId = try c.decodeIfPresent(String.self, forKey: .senderId)
        self.text = try c.decode(String.self, forKey: .text)
        self.threadId = try c.decodeIfPresent(String.self, forKey: .threadId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.createdAt, forKey: .createdAt)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.mine, forKey: .mine)
        try c.encode(self.sender, forKey: .sender)
        try c.encode(self.senderAddress, forKey: .senderAddress)
        try c.encode(self.senderId, forKey: .senderId)
        try c.encode(self.text, forKey: .text)
        try c.encode(self.threadId, forKey: .threadId)
    }
}

/// A result that carries nothing beyond success.
public struct Done: Codable, Equatable, Hashable, Sendable {
    public init() {
    }
}

public struct ErrorData: Codable, Equatable, Hashable, Sendable {
    public let kind: ErrorKind
    /// With `plan_limit_exceeded`: which cap was reached and how full it
    /// is, when Relaycast's refusal said. Absent on every other kind.
    public let planLimit: PlanLimitExceeded?
    /// Whether repeating the same request later can succeed.
    public let retryable: Bool

    public init(kind: ErrorKind, planLimit: PlanLimitExceeded? = nil, retryable: Bool) {
        self.kind = kind
        self.planLimit = planLimit
        self.retryable = retryable
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case planLimit = "plan_limit"
        case retryable
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.kind = try c.decode(ErrorKind.self, forKey: .kind)
        self.planLimit = try c.decodeIfPresent(PlanLimitExceeded.self, forKey: .planLimit)
        self.retryable = try c.decode(Bool.self, forKey: .retryable)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.kind, forKey: .kind)
        try c.encodeIfPresent(self.planLimit, forKey: .planLimit)
        try c.encode(self.retryable, forKey: .retryable)
    }
}

/// Every error a method can return.
public enum ErrorKind: String, Codable, CaseIterable, Hashable, Sendable {
    case parseError = "parse_error"
    case invalidRequest = "invalid_request"
    case methodNotFound = "method_not_found"
    case invalidParams = "invalid_params"
    case bridgeVersionMismatch = "bridge_version_mismatch"
    case rateLimited = "rate_limited"
    case conflict
    case shuttingDown = "shutting_down"
    case `internal`
    /// A method other than `hello` arrived before the handshake.
    case handshakeRequired = "handshake_required"
    /// No workspace key is known.
    case notSignedIn = "not_signed_in"
    /// A value the daemon refuses on principle (for example a non-https origin).
    case refused
    /// Relaycast could not be reached, or failed on its side (5xx).
    case relaycastUnreachable = "relaycast_unreachable"
    /// Relaycast refused the request as made (a 4xx other than those below);
    /// repeating it unchanged cannot succeed.
    case relaycastRefused = "relaycast_refused"
    /// Relaycast rejected the credential.
    case unauthorized
    /// The workspace's plan cap (devices, agents or humans) is reached;
    /// repeating the request cannot succeed until the plan changes.
    /// `data.plan_limit` carries the counters when Relaycast sent them.
    case planLimitExceeded = "plan_limit_exceeded"
    /// Relaycast, or this computer, has no such resource.
    case notFound = "not_found"
    /// Another change to the same agent or session is still running.
    case busy
    /// The agent store could not be saved; nothing was changed.
    case storeFailed = "store_failed"
    /// Agent Relay Cloud could not be reached or failed; worth retrying.
    case cloudFailed = "cloud_failed"
    /// Agent Relay Cloud refused the request; repeating it will not help.
    case cloudRefused = "cloud_refused"
    /// Whether this computer's relay already manages a session could not
    /// be read, so it is not given a second identity now.
    case fleetUnavailable = "fleet_unavailable"

    /// A value this build does not know reads as `internal`.
    public init(from decoder: Decoder) throws {
        self = ErrorKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .internal
    }
}

/// Registers an already-open Grok session. The probe finds the leader
/// itself; a process, socket, endpoint or credential is never accepted.
public struct ExistingRegisterParams: Codable, Equatable, Hashable, Sendable {
    /// The session's working directory, which `session/load` must accept.
    public let directory: String
    public let kind: SessionKind
    public let sessionId: String

    public init(directory: String, kind: SessionKind, sessionId: String) {
        self.directory = directory
        self.kind = kind
        self.sessionId = sessionId
    }

    enum CodingKeys: String, CodingKey {
        case directory
        case kind
        case sessionId = "session_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.directory = try c.decode(String.self, forKey: .directory)
        self.kind = try c.decode(SessionKind.self, forKey: .kind)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.directory, forKey: .directory)
        try c.encode(self.kind, forKey: .kind)
        try c.encode(self.sessionId, forKey: .sessionId)
    }
}

/// `fleet.list`'s result.
public struct FleetListing: Codable, Equatable, Hashable, Sendable {
    public let brokers: [BrokerListing]

    public init(brokers: [BrokerListing]) {
        self.brokers = brokers
    }

    enum CodingKeys: String, CodingKey {
        case brokers
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.brokers = try c.decode([BrokerListing].self, forKey: .brokers)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.brokers, forKey: .brokers)
    }
}

/// A harness's full-access setting, shown as "<label>: full access".
public struct FullAccessDescriptor: Codable, Equatable, Hashable, Sendable {
    /// Its value until the person chooses.
    public let defaultOn: Bool
    /// What on and off mean for this harness.
    public let detail: String

    public init(defaultOn: Bool, detail: String) {
        self.defaultOn = defaultOn
        self.detail = detail
    }

    enum CodingKeys: String, CodingKey {
        case defaultOn = "default_on"
        case detail
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.defaultOn = try c.decode(Bool.self, forKey: .defaultOn)
        self.detail = try c.decode(String.self, forKey: .detail)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.defaultOn, forKey: .defaultOn)
        try c.encode(self.detail, forKey: .detail)
    }
}

/// A harness this core knows, as the apps show its spawn settings
/// (`relay::harness::Descriptor`).
public struct HarnessDescriptor: Codable, Equatable, Hashable, Sendable {
    /// Whether how it is paid for may be stated
    /// (`spawn_harnesses.<id>.billing`).
    public let billing: Bool
    /// Its full-access setting (`spawn_harnesses.<id>.full_access`);
    /// absent when it has none.
    public let fullAccess: FullAccessDescriptor?
    /// Its id, as in `spawn:<id>` and `spawn_harnesses`.
    public let id: String
    /// Its product name, such as `Codex`.
    public let label: String

    public init(billing: Bool, fullAccess: FullAccessDescriptor? = nil, id: String, label: String) {
        self.billing = billing
        self.fullAccess = fullAccess
        self.id = id
        self.label = label
    }

    enum CodingKeys: String, CodingKey {
        case billing
        case fullAccess = "full_access"
        case id
        case label
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.billing = try c.decode(Bool.self, forKey: .billing)
        self.fullAccess = try c.decodeIfPresent(FullAccessDescriptor.self, forKey: .fullAccess)
        self.id = try c.decode(String.self, forKey: .id)
        self.label = try c.decode(String.self, forKey: .label)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.billing, forKey: .billing)
        try c.encodeIfPresent(self.fullAccess, forKey: .fullAccess)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.label, forKey: .label)
    }
}

public struct HelloParams: Codable, Equatable, Hashable, Sendable {
    /// The bridge version the client speaks.
    public let bridgeVersion: Int

    public init(bridgeVersion: Int) {
        self.bridgeVersion = bridgeVersion
    }

    enum CodingKeys: String, CodingKey {
        case bridgeVersion = "bridge_version"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.bridgeVersion = try c.decode(Int.self, forKey: .bridgeVersion)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.bridgeVersion, forKey: .bridgeVersion)
    }
}

public struct HelloResult: Codable, Equatable, Hashable, Sendable {
    public let bridgeVersion: Int
    public let daemonVersion: String
    /// Every method this core answers; clients feature-detect with it.
    public let methods: [String]
    public let pid: Int
    public let topics: [Topic]

    public init(bridgeVersion: Int, daemonVersion: String, methods: [String], pid: Int, topics: [Topic]) {
        self.bridgeVersion = bridgeVersion
        self.daemonVersion = daemonVersion
        self.methods = methods
        self.pid = pid
        self.topics = topics
    }

    enum CodingKeys: String, CodingKey {
        case bridgeVersion = "bridge_version"
        case daemonVersion = "daemon_version"
        case methods
        case pid
        case topics
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.bridgeVersion = try c.decode(Int.self, forKey: .bridgeVersion)
        self.daemonVersion = try c.decode(String.self, forKey: .daemonVersion)
        self.methods = try c.decode([String].self, forKey: .methods)
        self.pid = try c.decode(Int.self, forKey: .pid)
        self.topics = try c.decode([Topic].self, forKey: .topics)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.bridgeVersion, forKey: .bridgeVersion)
        try c.encode(self.daemonVersion, forKey: .daemonVersion)
        try c.encode(self.methods, forKey: .methods)
        try c.encode(self.pid, forKey: .pid)
        try c.encode(self.topics, forKey: .topics)
    }
}

/// `messages.history`'s result, in reading order (replies beneath their
/// parent).
public struct History: Codable, Equatable, Hashable, Sendable {
    public let identity: String
    public let messages: [DirectMessage]

    public init(identity: String, messages: [DirectMessage]) {
        self.identity = identity
        self.messages = messages
    }

    enum CodingKeys: String, CodingKey {
        case identity
        case messages
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.identity = try c.decode(String.self, forKey: .identity)
        self.messages = try c.decode([DirectMessage].self, forKey: .messages)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.identity, forKey: .identity)
        try c.encode(self.messages, forKey: .messages)
    }
}

public struct HistoryParams: Codable, Equatable, Hashable, Sendable {
    /// Pages back from this message id.
    public let before: String?
    /// A name (`alice` or `@alice`) or an `agent@machine` address: the 1:1
    /// conversation with it.
    public let endpoint: String

    public init(before: String? = nil, endpoint: String) {
        self.before = before
        self.endpoint = endpoint
    }

    enum CodingKeys: String, CodingKey {
        case before
        case endpoint
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.before = try c.decodeIfPresent(String.self, forKey: .before)
        self.endpoint = try c.decode(String.self, forKey: .endpoint)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.before, forKey: .before)
        try c.encode(self.endpoint, forKey: .endpoint)
    }
}

/// A session holding relay messages it has not read, as `agents.list` and
/// the session socket's `GET /agents` report it.
public struct InboxStall: Codable, Equatable, Hashable, Sendable {
    /// How long the oldest of them has waited.
    public let oldestUndrainedAgeMs: Int64
    /// Relay messages still waiting for the session to consume them.
    public let undrainedCount: Int

    public init(oldestUndrainedAgeMs: Int64, undrainedCount: Int) {
        self.oldestUndrainedAgeMs = oldestUndrainedAgeMs
        self.undrainedCount = undrainedCount
    }

    enum CodingKeys: String, CodingKey {
        case oldestUndrainedAgeMs = "oldest_undrained_age_ms"
        case undrainedCount = "undrained_count"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.oldestUndrainedAgeMs = try c.decode(Int64.self, forKey: .oldestUndrainedAgeMs)
        self.undrainedCount = try c.decode(Int.self, forKey: .undrainedCount)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.oldestUndrainedAgeMs, forKey: .oldestUndrainedAgeMs)
        try c.encode(self.undrainedCount, forKey: .undrainedCount)
    }
}

/// A subscription made or undone.
public struct IntegrationChange: Codable, Equatable, Hashable, Sendable {
    /// Nothing was left to undo.
    public let alreadyUnsubscribed: Bool?
    /// The relayfile paths a subscription delivers.
    public let pathGlob: String?
    public let provider: String
    public let resource: String
    public let subscribed: Bool

    public init(alreadyUnsubscribed: Bool? = nil, pathGlob: String? = nil, provider: String, resource: String, subscribed: Bool) {
        self.alreadyUnsubscribed = alreadyUnsubscribed
        self.pathGlob = pathGlob
        self.provider = provider
        self.resource = resource
        self.subscribed = subscribed
    }

    enum CodingKeys: String, CodingKey {
        case alreadyUnsubscribed = "already_unsubscribed"
        case pathGlob = "path_glob"
        case provider
        case resource
        case subscribed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.alreadyUnsubscribed = try c.decodeIfPresent(Bool.self, forKey: .alreadyUnsubscribed)
        self.pathGlob = try c.decodeIfPresent(String.self, forKey: .pathGlob)
        self.provider = try c.decode(String.self, forKey: .provider)
        self.resource = try c.decode(String.self, forKey: .resource)
        self.subscribed = try c.decode(Bool.self, forKey: .subscribed)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.alreadyUnsubscribed, forKey: .alreadyUnsubscribed)
        try c.encodeIfPresent(self.pathGlob, forKey: .pathGlob)
        try c.encode(self.provider, forKey: .provider)
        try c.encode(self.resource, forKey: .resource)
        try c.encode(self.subscribed, forKey: .subscribed)
    }
}

public struct IntegrationParams: Codable, Equatable, Hashable, Sendable {
    public let name: String
    public let provider: String
    public let resource: String

    public init(name: String, provider: String, resource: String) {
        self.name = name
        self.provider = provider
        self.resource = resource
    }

    enum CodingKeys: String, CodingKey {
        case name
        case provider
        case resource
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.provider = try c.decode(String.self, forKey: .provider)
        self.resource = try c.decode(String.self, forKey: .resource)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.provider, forKey: .provider)
        try c.encode(self.resource, forKey: .resource)
    }
}

/// The `invalidated` topic: re-fetch `what`.
public struct Invalidation: Codable, Equatable, Hashable, Sendable {
    public let what: Listing

    public init(what: Listing) {
        self.what = what
    }

    enum CodingKeys: String, CodingKey {
        case what
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.what = try c.decode(Listing.self, forKey: .what)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.what, forKey: .what)
    }
}

/// The level of an activity line.
public enum Level: String, Codable, CaseIterable, Hashable, Sendable {
    case info
    case warning
    case error

    /// A value this build does not know reads as `info`.
    public init(from decoder: Decoder) throws {
        self = Level(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .info
    }
}

public struct LimitParams: Codable, Equatable, Hashable, Sendable {
    public let limit: Int?

    public init(limit: Int? = nil) {
        self.limit = limit
    }

    enum CodingKeys: String, CodingKey {
        case limit
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.limit = try c.decodeIfPresent(Int.self, forKey: .limit)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.limit, forKey: .limit)
    }
}

/// `links.parse`'s parameters. The link's scheme and, for a connect link,
/// its site are the build's own (`AGENT_RELAY_SITE_URL` and
/// `AGENT_RELAY_URL_SCHEME` when the core was built); nothing in the request
/// chooses them.
public struct LinkParams: Codable, Equatable, Hashable, Sendable {
    public let url: String

    public init(url: String) {
        self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case url
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.url = try c.decode(String.self, forKey: .url)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.url, forKey: .url)
    }
}

/// A listing a client re-fetches on `invalidated`.
public enum Listing: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    case agents
    case roster
    case messages
    case people
    case activity
    case sessions
    case fleet
    /// Skip chat's saved conversation.
    case chat
    /// Skip's saved project view and its push receipts.
    case projects
    /// The uploader's status or sessions.
    case uploader
    /// The core's settings, changed from outside the app (an agent's
    /// `PATCH /settings`).
    case settings
    /// A value this build does not know, as the core sent it.
    case unknown(String)

    public static let allCases: [Listing] = [.agents, .roster, .messages, .people, .activity, .sessions, .fleet, .chat, .projects, .uploader, .settings]

    public init(rawValue: String) {
        switch rawValue {
        case "agents": self = .agents
        case "roster": self = .roster
        case "messages": self = .messages
        case "people": self = .people
        case "activity": self = .activity
        case "sessions": self = .sessions
        case "fleet": self = .fleet
        case "chat": self = .chat
        case "projects": self = .projects
        case "uploader": self = .uploader
        case "settings": self = .settings
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .agents: return "agents"
        case .roster: return "roster"
        case .messages: return "messages"
        case .people: return "people"
        case .activity: return "activity"
        case .sessions: return "sessions"
        case .fleet: return "fleet"
        case .chat: return "chat"
        case .projects: return "projects"
        case .uploader: return "uploader"
        case .settings: return "settings"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// Whether a roster agent is running, as Relaycast's presence and this
/// computer's sessions say. A hint for whether a reply can come: what
/// happened to a message is its [`MessageState`].
public enum Liveness: String, Codable, CaseIterable, Hashable, Sendable {
    /// Working: Relaycast saw it within its liveness window; a session on
    /// this computer is running.
    case live
    /// Running, and reported itself idle, waiting or blocked within the
    /// window.
    case idle
    /// Not seen within the window, or a session on this computer that is
    /// not running.
    case offline

    /// A value this build does not know reads as `offline`.
    public init(from decoder: Decoder) throws {
        self = Liveness(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .offline
    }
}

/// An agent on the relay from this computer.
public struct LocalAgent: Codable, Equatable, Hashable, Sendable {
    public let addedBySession: Bool
    public let address: String
    /// The name it was renamed to, if any: another name that reaches it,
    /// shown in its place.
    public let alias: String?
    /// Why this agent's delivery queue could not be read.
    public let deliveryError: String?
    /// Relay messages waiting behind a silent Codex turn or unread in a
    /// terminal Claude Code inbox past the threshold. Absent otherwise and
    /// in older cores.
    public let inboxStall: InboxStall?
    public let integrations: [AgentIntegration]
    /// The name the agent was registered with, which it keeps while on the
    /// relay. Agent methods take this name.
    public let name: String
    public let push: PushState?
    /// ISO-8601, seconds precision.
    public let registeredAt: String
    /// `true` always answers, `false` never, `null` only when the session
    /// cannot answer itself.
    public let replyWithFinalAnswer: Bool?
    /// For an agent Agent Relay spawned here: its place and lifecycle.
    /// Absent for every other agent and in older cores.
    public let spawn: SpawnedAgentState?
    public let target: Target
    public let title: String
    public let webhook: AgentWebhook?

    public init(addedBySession: Bool, address: String, alias: String? = nil, deliveryError: String? = nil, inboxStall: InboxStall? = nil, integrations: [AgentIntegration], name: String, push: PushState? = nil, registeredAt: String, replyWithFinalAnswer: Bool? = nil, spawn: SpawnedAgentState? = nil, target: Target, title: String, webhook: AgentWebhook? = nil) {
        self.addedBySession = addedBySession
        self.address = address
        self.alias = alias
        self.deliveryError = deliveryError
        self.inboxStall = inboxStall
        self.integrations = integrations
        self.name = name
        self.push = push
        self.registeredAt = registeredAt
        self.replyWithFinalAnswer = replyWithFinalAnswer
        self.spawn = spawn
        self.target = target
        self.title = title
        self.webhook = webhook
    }

    enum CodingKeys: String, CodingKey {
        case addedBySession = "added_by_session"
        case address
        case alias
        case deliveryError = "delivery_error"
        case inboxStall = "inbox_stall"
        case integrations
        case name
        case push
        case registeredAt = "registered_at"
        case replyWithFinalAnswer = "reply_with_final_answer"
        case spawn
        case target
        case title
        case webhook
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.addedBySession = try c.decode(Bool.self, forKey: .addedBySession)
        self.address = try c.decode(String.self, forKey: .address)
        self.alias = try c.decodeIfPresent(String.self, forKey: .alias)
        self.deliveryError = try c.decodeIfPresent(String.self, forKey: .deliveryError)
        self.inboxStall = try c.decodeIfPresent(InboxStall.self, forKey: .inboxStall)
        self.integrations = try c.decode([AgentIntegration].self, forKey: .integrations)
        self.name = try c.decode(String.self, forKey: .name)
        self.push = try c.decodeIfPresent(PushState.self, forKey: .push)
        self.registeredAt = try c.decode(String.self, forKey: .registeredAt)
        self.replyWithFinalAnswer = try c.decodeIfPresent(Bool.self, forKey: .replyWithFinalAnswer)
        self.spawn = try c.decodeIfPresent(SpawnedAgentState.self, forKey: .spawn)
        self.target = try c.decode(Target.self, forKey: .target)
        self.title = try c.decode(String.self, forKey: .title)
        self.webhook = try c.decodeIfPresent(AgentWebhook.self, forKey: .webhook)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.addedBySession, forKey: .addedBySession)
        try c.encode(self.address, forKey: .address)
        try c.encodeIfPresent(self.alias, forKey: .alias)
        try c.encode(self.deliveryError, forKey: .deliveryError)
        try c.encodeIfPresent(self.inboxStall, forKey: .inboxStall)
        try c.encode(self.integrations, forKey: .integrations)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.push, forKey: .push)
        try c.encode(self.registeredAt, forKey: .registeredAt)
        try c.encode(self.replyWithFinalAnswer, forKey: .replyWithFinalAnswer)
        try c.encodeIfPresent(self.spawn, forKey: .spawn)
        try c.encode(self.target, forKey: .target)
        try c.encode(self.title, forKey: .title)
        try c.encode(self.webhook, forKey: .webhook)
    }
}

/// A session on this computer, with its registration when it has one.
public struct LocalSession: Codable, Equatable, Hashable, Sendable {
    public let directory: String?
    /// What holds this session's transcript, for a session that can be
    /// held at all (see [`SessionHolder`]).
    public let holder: SessionHolder?
    /// The app a person chats with the session in, when it is not the
    /// provider's own: `conductor` or `paseo`.
    public let host: String?
    /// Whether the session can take a message now; a registered session
    /// discovery no longer finds is listed with `false`.
    public let live: Bool
    /// Git repository name when local metadata is available, otherwise a
    /// safe working-directory hint. Relay controller roots have no project.
    public let project: String?
    public let registration: SessionRegistration?
    /// Whether discovery found the session's process on this computer:
    /// `false` for a registered session that has ended. A session that runs
    /// but is not `live` cannot take a message yet (a Grok TUI without its
    /// leader, an OpenCode window opened before the plugin). Clients treat a
    /// missing value (an older core) as running.
    public let running: Bool?
    /// The name `agents.register` uses without one.
    public let suggestedName: String
    public let target: Target
    public let title: String
    public let updatedAtMs: Int64?

    public init(directory: String? = nil, holder: SessionHolder? = nil, host: String? = nil, live: Bool, project: String? = nil, registration: SessionRegistration? = nil, running: Bool? = nil, suggestedName: String, target: Target, title: String, updatedAtMs: Int64? = nil) {
        self.directory = directory
        self.holder = holder
        self.host = host
        self.live = live
        self.project = project
        self.registration = registration
        self.running = running
        self.suggestedName = suggestedName
        self.target = target
        self.title = title
        self.updatedAtMs = updatedAtMs
    }

    enum CodingKeys: String, CodingKey {
        case directory
        case holder
        case host
        case live
        case project
        case registration
        case running
        case suggestedName = "suggested_name"
        case target
        case title
        case updatedAtMs = "updated_at_ms"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.directory = try c.decodeIfPresent(String.self, forKey: .directory)
        self.holder = try c.decodeIfPresent(SessionHolder.self, forKey: .holder)
        self.host = try c.decodeIfPresent(String.self, forKey: .host)
        self.live = try c.decode(Bool.self, forKey: .live)
        self.project = try c.decodeIfPresent(String.self, forKey: .project)
        self.registration = try c.decodeIfPresent(SessionRegistration.self, forKey: .registration)
        self.running = try c.decodeIfPresent(Bool.self, forKey: .running)
        self.suggestedName = try c.decode(String.self, forKey: .suggestedName)
        self.target = try c.decode(Target.self, forKey: .target)
        self.title = try c.decode(String.self, forKey: .title)
        self.updatedAtMs = try c.decodeIfPresent(Int64.self, forKey: .updatedAtMs)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.directory, forKey: .directory)
        try c.encodeIfPresent(self.holder, forKey: .holder)
        try c.encodeIfPresent(self.host, forKey: .host)
        try c.encode(self.live, forKey: .live)
        try c.encode(self.project, forKey: .project)
        try c.encode(self.registration, forKey: .registration)
        try c.encodeIfPresent(self.running, forKey: .running)
        try c.encode(self.suggestedName, forKey: .suggestedName)
        try c.encode(self.target, forKey: .target)
        try c.encode(self.title, forKey: .title)
        try c.encode(self.updatedAtMs, forKey: .updatedAtMs)
    }
}

/// `sessions.list`'s result.
public struct LocalSessions: Codable, Equatable, Hashable, Sendable {
    public let sessions: [LocalSession]

    public init(sessions: [LocalSession]) {
        self.sessions = sessions
    }

    enum CodingKeys: String, CodingKey {
        case sessions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.sessions = try c.decode([LocalSession].self, forKey: .sessions)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.sessions, forKey: .sessions)
    }
}

public struct LocalTranscriptCursor: Codable, Equatable, Hashable, Sendable {
    public let id: Int64
    public let tsMs: Int64

    public init(id: Int64, tsMs: Int64) {
        self.id = id
        self.tsMs = tsMs
    }

    enum CodingKeys: String, CodingKey {
        case id
        case tsMs = "ts_ms"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(Int64.self, forKey: .id)
        self.tsMs = try c.decode(Int64.self, forKey: .tsMs)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.tsMs, forKey: .tsMs)
    }
}

public struct LocalTranscriptEntry: Codable, Equatable, Hashable, Sendable {
    public let id: String
    /// A copy from embedded transcript bytes in the private reader cache.
    public let imagePath: String?
    /// text, thinking, tool_use, tool_result, or context.
    public let kind: String
    public let role: String
    public let text: String
    public let timestampMs: Int64
    public let truncated: Bool

    public init(id: String, imagePath: String? = nil, kind: String, role: String, text: String, timestampMs: Int64, truncated: Bool) {
        self.id = id
        self.imagePath = imagePath
        self.kind = kind
        self.role = role
        self.text = text
        self.timestampMs = timestampMs
        self.truncated = truncated
    }

    enum CodingKeys: String, CodingKey {
        case id
        case imagePath = "image_path"
        case kind
        case role
        case text
        case timestampMs = "timestamp_ms"
        case truncated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.imagePath = try c.decodeIfPresent(String.self, forKey: .imagePath)
        self.kind = try c.decode(String.self, forKey: .kind)
        self.role = try c.decode(String.self, forKey: .role)
        self.text = try c.decode(String.self, forKey: .text)
        self.timestampMs = try c.decode(Int64.self, forKey: .timestampMs)
        self.truncated = try c.decode(Bool.self, forKey: .truncated)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.imagePath, forKey: .imagePath)
        try c.encode(self.kind, forKey: .kind)
        try c.encode(self.role, forKey: .role)
        try c.encode(self.text, forKey: .text)
        try c.encode(self.timestampMs, forKey: .timestampMs)
        try c.encode(self.truncated, forKey: .truncated)
    }
}

public struct LocalTranscriptPage: Codable, Equatable, Hashable, Sendable {
    public let entries: [LocalTranscriptEntry]
    /// Where what is written after this page starts: reading from it
    /// follows a transcript still being written. Only `agents.transcript`
    /// sets it.
    public let followCursor: LocalTranscriptCursor?
    public let nextCursor: LocalTranscriptCursor?

    public init(entries: [LocalTranscriptEntry], followCursor: LocalTranscriptCursor? = nil, nextCursor: LocalTranscriptCursor? = nil) {
        self.entries = entries
        self.followCursor = followCursor
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey {
        case entries
        case followCursor = "follow_cursor"
        case nextCursor = "next_cursor"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.entries = try c.decode([LocalTranscriptEntry].self, forKey: .entries)
        self.followCursor = try c.decodeIfPresent(LocalTranscriptCursor.self, forKey: .followCursor)
        self.nextCursor = try c.decodeIfPresent(LocalTranscriptCursor.self, forKey: .nextCursor)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.entries, forKey: .entries)
        try c.encodeIfPresent(self.followCursor, forKey: .followCursor)
        try c.encode(self.nextCursor, forKey: .nextCursor)
    }
}

public struct MachineInfo: Codable, Equatable, Hashable, Sendable {
    public let hostName: String
    /// The address prefix new registrations are issued with.
    public let machinePrefix: String

    public init(hostName: String, machinePrefix: String) {
        self.hostName = hostName
        self.machinePrefix = machinePrefix
    }

    enum CodingKeys: String, CodingKey {
        case hostName = "host_name"
        case machinePrefix = "machine_prefix"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.hostName = try c.decode(String.self, forKey: .hostName)
        self.machinePrefix = try c.decode(String.self, forKey: .machinePrefix)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.hostName, forKey: .hostName)
        try c.encode(self.machinePrefix, forKey: .machinePrefix)
    }
}

/// Launches a provider endpoint owned by the probe. Endpoint, process,
/// socket and credentials are intentionally not accepted from the caller.
public struct ManagedLaunchParams: Codable, Equatable, Hashable, Sendable {
    public let directory: String
    public let executable: String
    public let kind: SessionKind
    public let sessionId: String

    public init(directory: String, executable: String, kind: SessionKind, sessionId: String) {
        self.directory = directory
        self.executable = executable
        self.kind = kind
        self.sessionId = sessionId
    }

    enum CodingKeys: String, CodingKey {
        case directory
        case executable
        case kind
        case sessionId = "session_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.directory = try c.decode(String.self, forKey: .directory)
        self.executable = try c.decode(String.self, forKey: .executable)
        self.kind = try c.decode(SessionKind.self, forKey: .kind)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.directory, forKey: .directory)
        try c.encode(self.executable, forKey: .executable)
        try c.encode(self.kind, forKey: .kind)
        try c.encode(self.sessionId, forKey: .sessionId)
    }
}

public struct ManagedSessionStarted: Codable, Equatable, Hashable, Sendable {
    public let directory: String?
    public let target: Target
    public let title: String

    public init(directory: String? = nil, target: Target, title: String) {
        self.directory = directory
        self.target = target
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case directory
        case target
        case title
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.directory = try c.decodeIfPresent(String.self, forKey: .directory)
        self.target = try c.decode(Target.self, forKey: .target)
        self.title = try c.decode(String.self, forKey: .title)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.directory, forKey: .directory)
        try c.encode(self.target, forKey: .target)
        try c.encode(self.title, forKey: .title)
    }
}

/// What Relaycast holds for one message to an agent: its delivery row in
/// the agent's `pending_deliveries`, or that it has none.
public enum MessageState: String, Codable, CaseIterable, Hashable, Sendable {
    /// Relaycast holds it: not yet handed to the agent's host.
    case queued
    /// Relaycast handed it to the agent's host, which has not acknowledged
    /// it yet.
    case delivered
    /// Relaycast no longer holds it: the agent acknowledged it (or refused
    /// it).
    case pickedUp = "picked_up"
    /// Picked up by an agent on this computer whose Claude Code holds it for
    /// the person's approval before the session sees it.
    case heldForApproval = "held_for_approval"
    /// No agent has that name or address.
    case noSuchAgent = "no_such_agent"

    /// A value this build does not know reads as `queued`.
    public init(from decoder: Decoder) throws {
        self = MessageState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .queued
    }
}

public struct NameParams: Codable, Equatable, Hashable, Sendable {
    public let name: String

    public init(name: String) {
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.name, forKey: .name)
    }
}

/// A method that takes no parameters: anything but an object is refused.
public struct NoParams: Codable, Equatable, Hashable, Sendable {
    public init() {
    }
}

/// The node's reachability, as of `at`.
public struct NodeEvidence: Codable, Equatable, Hashable, Sendable {
    /// When it was last seen (ISO-8601); kept when the evidence went stale.
    public let at: String?
    public let state: NodeReach

    public init(at: String? = nil, state: NodeReach) {
        self.at = at
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case at
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.at = try c.decodeIfPresent(String.self, forKey: .at)
        self.state = try c.decode(NodeReach.self, forKey: .state)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.at, forKey: .at)
        try c.encode(self.state, forKey: .state)
    }
}

/// Whether this computer's spawn node reaches Agent Relay.
public enum NodeReach: String, Codable, CaseIterable, Hashable, Sendable {
    /// A heartbeat went out recently.
    case reachable
    /// The connection is down.
    case unreachable
    /// No recent evidence either way.
    case unknown

    /// A value this build does not know reads as `unknown`.
    public init(from decoder: Decoder) throws {
        self = NodeReach(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// `openclaw.relay_tools.connect`: `waiting` with the page the person
/// approves on, or `connected` (no URL) when OpenClaw was already signed in.
public struct OpenClawToolsConnect: Codable, Equatable, Hashable, Sendable {
    public let authorizationUrl: String?
    public let state: OpenClawToolsState

    public init(authorizationUrl: String? = nil, state: OpenClawToolsState) {
        self.authorizationUrl = authorizationUrl
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case authorizationUrl = "authorization_url"
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.authorizationUrl = try c.decodeIfPresent(String.self, forKey: .authorizationUrl)
        self.state = try c.decode(OpenClawToolsState.self, forKey: .state)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.authorizationUrl, forKey: .authorizationUrl)
        try c.encode(self.state, forKey: .state)
    }
}

/// Whether the person's OpenClaw agents can use Agent Relay's tools.
public enum OpenClawToolsState: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    /// OpenClaw is off or not set up, its command-line tool cannot be
    /// found, or it cannot sign in to MCP servers; `detail` says which.
    case unavailable
    /// Not signed in yet (or the sign-in lapsed): Connect starts it.
    case notConnected
    /// `openclaw mcp login` is waiting for the person to approve in the
    /// browser.
    case waiting
    /// OpenClaw holds Agent Relay's MCP credentials.
    case connected
    /// A value this build does not know, as the core sent it.
    case unknown(String)

    public static let allCases: [OpenClawToolsState] = [.unavailable, .notConnected, .waiting, .connected]

    public init(rawValue: String) {
        switch rawValue {
        case "unavailable": self = .unavailable
        case "not_connected": self = .notConnected
        case "waiting": self = .waiting
        case "connected": self = .connected
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .unavailable: return "unavailable"
        case .notConnected: return "not_connected"
        case .waiting: return "waiting"
        case .connected: return "connected"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// `openclaw.relay_tools.status`.
public struct OpenClawToolsStatus: Codable, Equatable, Hashable, Sendable {
    /// Why the tools are unavailable, or why the last sign-in failed, in
    /// words the apps show as they are.
    public let detail: String?
    public let state: OpenClawToolsState

    public init(detail: String? = nil, state: OpenClawToolsState) {
        self.detail = detail
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case detail
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.detail = try c.decodeIfPresent(String.self, forKey: .detail)
        self.state = try c.decode(OpenClawToolsState.self, forKey: .state)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.detail, forKey: .detail)
        try c.encode(self.state, forKey: .state)
    }
}

/// `people.list`'s result, sorted by name.
public struct People: Codable, Equatable, Hashable, Sendable {
    public let people: [WorkspacePerson]

    public init(people: [WorkspacePerson]) {
        self.people = people
    }

    enum CodingKeys: String, CodingKey {
        case people
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.people = try c.decode([WorkspacePerson].self, forKey: .people)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.people, forKey: .people)
    }
}

/// Relaycast refused something because the plan's cap is reached.
public struct PlanLimitExceeded: Codable, Equatable, Hashable, Sendable {
    /// How many the workspace has now.
    public let current: Int
    public let limit: PlanLimitKind
    /// The cap.
    public let max: Int
    /// The plan's key (`intro`).
    public let plan: String

    public init(current: Int, limit: PlanLimitKind, max: Int, plan: String) {
        self.current = current
        self.limit = limit
        self.max = max
        self.plan = plan
    }

    enum CodingKeys: String, CodingKey {
        case current
        case limit
        case max
        case plan
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.current = try c.decode(Int.self, forKey: .current)
        self.limit = try c.decode(PlanLimitKind.self, forKey: .limit)
        self.max = try c.decode(Int.self, forKey: .max)
        self.plan = try c.decode(String.self, forKey: .plan)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.current, forKey: .current)
        try c.encode(self.limit, forKey: .limit)
        try c.encode(self.max, forKey: .max)
        try c.encode(self.plan, forKey: .plan)
    }
}

/// Which cap a refusal names.
public enum PlanLimitKind: String, Codable, CaseIterable, Hashable, Sendable {
    case devices
    case agents
    case humans
    /// A cap this build does not know.
    case other

    /// A value this build does not know reads as `other`.
    public init(from decoder: Decoder) throws {
        self = PlanLimitKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

/// A plan's caps; `null` is unlimited.
public struct PlanLimits: Codable, Equatable, Hashable, Sendable {
    public let agents: Int?
    public let devices: Int?
    public let humans: Int?
    public let sessionRetentionDays: Int?

    public init(agents: Int? = nil, devices: Int? = nil, humans: Int? = nil, sessionRetentionDays: Int? = nil) {
        self.agents = agents
        self.devices = devices
        self.humans = humans
        self.sessionRetentionDays = sessionRetentionDays
    }

    enum CodingKeys: String, CodingKey {
        case agents
        case devices
        case humans
        case sessionRetentionDays = "session_retention_days"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agents = try c.decodeIfPresent(Int.self, forKey: .agents)
        self.devices = try c.decodeIfPresent(Int.self, forKey: .devices)
        self.humans = try c.decodeIfPresent(Int.self, forKey: .humans)
        self.sessionRetentionDays = try c.decodeIfPresent(Int.self, forKey: .sessionRetentionDays)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agents, forKey: .agents)
        try c.encode(self.devices, forKey: .devices)
        try c.encode(self.humans, forKey: .humans)
        try c.encode(self.sessionRetentionDays, forKey: .sessionRetentionDays)
    }
}

/// A spawned agent's process liveness, as of `at`.
public struct ProcessEvidence: Codable, Equatable, Hashable, Sendable {
    public let at: String?
    public let state: ProcessLiveness

    public init(at: String? = nil, state: ProcessLiveness) {
        self.at = at
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case at
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.at = try c.decodeIfPresent(String.self, forKey: .at)
        self.state = try c.decode(ProcessLiveness.self, forKey: .state)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.at, forKey: .at)
        try c.encode(self.state, forKey: .state)
    }
}

/// Whether a spawned agent's session runs.
public enum ProcessLiveness: String, Codable, CaseIterable, Hashable, Sendable {
    case running
    case unknown
    /// Seen to have ended: crashed, finished, or a Codex thread no longer
    /// loaded anywhere.
    case exited

    /// A value this build does not know reads as `unknown`.
    public init(from decoder: Decoder) throws {
        self = ProcessLiveness(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// A channel's connection state, as the status snapshot reports it.
public enum PushState: Codable, Hashable, Sendable {
    case connecting
    case live
    case waiting(retryInMs: Int)

    enum CodingKeys: String, CodingKey {
        case retryInMs = "retry_in_ms"
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .state) {
        case "connecting": self = .connecting
        case "live": self = .live
        case "waiting": self = .waiting(retryInMs: try c.decode(Int.self, forKey: .retryInMs))
        default: self = .connecting
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .connecting: try c.encode("connecting", forKey: .state)
        case .live: try c.encode("live", forKey: .state)
        case .waiting(let retryInMs):
            try c.encode("waiting", forKey: .state)
            try c.encode(retryInMs, forKey: .retryInMs)
        }
    }
}

/// `roster.get`'s result, also `messages.send`'s `recipient`.
public struct Recipient: Codable, Equatable, Hashable, Sendable {
    /// The roster's record; `null` when known and no agent has the name or
    /// address.
    public let agent: RosterAgent?
    /// Whether the roster was read in the workspace your messages go to.
    /// When not (no workspace key, another workspace, or not signed in),
    /// `agent` and `message` are `null` and say nothing.
    public let known: Bool
    /// With a message id: what Relaycast holds for that message; `null`
    /// when Relaycast's record cannot tell.
    public let message: MessageState?

    public init(agent: RosterAgent? = nil, known: Bool, message: MessageState? = nil) {
        self.agent = agent
        self.known = known
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case agent
        case known
        case message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agent = try c.decodeIfPresent(RosterAgent.self, forKey: .agent)
        self.known = try c.decode(Bool.self, forKey: .known)
        self.message = try c.decodeIfPresent(MessageState.self, forKey: .message)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agent, forKey: .agent)
        try c.encode(self.known, forKey: .known)
        try c.encode(self.message, forKey: .message)
    }
}

/// One endpoint to look up on the roster: give exactly one of `to` and
/// `address`, as `messages.send` takes them.
public struct RecipientParams: Codable, Equatable, Hashable, Sendable {
    /// An exact `agent@machine` address.
    public let address: String?
    /// A message sent to it, whose state is read too.
    public let messageId: String?
    /// A name (`alice` or `@alice`).
    public let to: String?

    public init(address: String? = nil, messageId: String? = nil, to: String? = nil) {
        self.address = address
        self.messageId = messageId
        self.to = to
    }

    enum CodingKeys: String, CodingKey {
        case address
        case messageId = "message_id"
        case to
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.address = try c.decodeIfPresent(String.self, forKey: .address)
        self.messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
        self.to = try c.decodeIfPresent(String.self, forKey: .to)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.address, forKey: .address)
        try c.encodeIfPresent(self.messageId, forKey: .messageId)
        try c.encodeIfPresent(self.to, forKey: .to)
    }
}

public struct RegisterParams: Codable, Equatable, Hashable, Sendable {
    public let description: String?
    /// Without one, the session's suggested name.
    public let name: String?
    public let target: Target

    public init(description: String? = nil, name: String? = nil, target: Target) {
        self.description = description
        self.name = name
        self.target = target
    }

    enum CodingKeys: String, CodingKey {
        case description
        case name
        case target
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.description = try c.decodeIfPresent(String.self, forKey: .description)
        self.name = try c.decodeIfPresent(String.self, forKey: .name)
        self.target = try c.decode(Target.self, forKey: .target)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.description, forKey: .description)
        try c.encodeIfPresent(self.name, forKey: .name)
        try c.encode(self.target, forKey: .target)
    }
}

/// An agent on the relay, as `agents.register` reports it.
public struct Registered: Codable, Equatable, Hashable, Sendable {
    public let address: String
    /// The session was registered already; nothing changed.
    public let alreadyRegistered: Bool
    public let name: String

    public init(address: String, alreadyRegistered: Bool, name: String) {
        self.address = address
        self.alreadyRegistered = alreadyRegistered
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case address
        case alreadyRegistered = "already_registered"
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.address = try c.decode(String.self, forKey: .address)
        self.alreadyRegistered = try c.decode(Bool.self, forKey: .alreadyRegistered)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.address, forKey: .address)
        try c.encode(self.alreadyRegistered, forKey: .alreadyRegistered)
        try c.encode(self.name, forKey: .name)
    }
}

public struct ReleaseParams: Codable, Equatable, Hashable, Sendable {
    /// The generation `fleet.list` reported; another is `conflict`.
    public let generation: String
    public let name: String
    public let nodeId: String

    public init(generation: String, name: String, nodeId: String) {
        self.generation = generation
        self.name = name
        self.nodeId = nodeId
    }

    enum CodingKeys: String, CodingKey {
        case generation
        case name
        case nodeId = "node_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.generation = try c.decode(String.self, forKey: .generation)
        self.name = try c.decode(String.self, forKey: .name)
        self.nodeId = try c.decode(String.self, forKey: .nodeId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.generation, forKey: .generation)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.nodeId, forKey: .nodeId)
    }
}

public struct RenameParams: Codable, Equatable, Hashable, Sendable {
    public let name: String
    public let newName: String

    public init(name: String, newName: String) {
        self.name = name
        self.newName = newName
    }

    enum CodingKeys: String, CodingKey {
        case name
        case newName = "new_name"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.newName = try c.decode(String.self, forKey: .newName)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.newName, forKey: .newName)
    }
}

public struct Renamed: Codable, Equatable, Hashable, Sendable {
    public let address: String
    /// The name asked for: the alias, or the agent's own name when the
    /// alias was removed.
    public let name: String
    /// The alias this rename replaced, if it had one. It keeps forwarding
    /// what is sent to it for 24 hours, then is released.
    public let released: String?

    public init(address: String, name: String, released: String? = nil) {
        self.address = address
        self.name = name
        self.released = released
    }

    enum CodingKeys: String, CodingKey {
        case address
        case name
        case released
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.address = try c.decode(String.self, forKey: .address)
        self.name = try c.decode(String.self, forKey: .name)
        self.released = try c.decodeIfPresent(String.self, forKey: .released)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.address, forKey: .address)
        try c.encode(self.name, forKey: .name)
        try c.encodeIfPresent(self.released, forKey: .released)
    }
}

public struct ReplySettingParams: Codable, Equatable, Hashable, Sendable {
    /// `true` always answers, `false` never, `null` only when the session
    /// cannot answer itself. Required.
    public let enabled: Bool?
    public let name: String

    public init(enabled: Bool? = nil, name: String) {
        self.enabled = enabled
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case enabled
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.enabled, forKey: .enabled)
        try c.encode(self.name, forKey: .name)
    }
}

public struct RequestEntry: Codable, Equatable, Hashable, Sendable {
    /// Made with a Relay Connect room's credential: that room's workspace,
    /// not the team's, so its limits are not the team's to upgrade.
    public let connect: Bool?
    public let durationMs: Int?
    public let endpoint: String
    public let failed: Bool
    public let id: String
    public let method: String
    public let request: String
    public let response: String
    public let service: String
    public let startedAtMs: Int
    public let status: Int?

    public init(connect: Bool? = nil, durationMs: Int? = nil, endpoint: String, failed: Bool, id: String, method: String, request: String, response: String, service: String, startedAtMs: Int, status: Int? = nil) {
        self.connect = connect
        self.durationMs = durationMs
        self.endpoint = endpoint
        self.failed = failed
        self.id = id
        self.method = method
        self.request = request
        self.response = response
        self.service = service
        self.startedAtMs = startedAtMs
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case connect
        case durationMs = "duration_ms"
        case endpoint
        case failed
        case id
        case method
        case request
        case response
        case service
        case startedAtMs = "started_at_ms"
        case status
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.connect = try c.decodeIfPresent(Bool.self, forKey: .connect)
        self.durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        self.endpoint = try c.decode(String.self, forKey: .endpoint)
        self.failed = try c.decode(Bool.self, forKey: .failed)
        self.id = try c.decode(String.self, forKey: .id)
        self.method = try c.decode(String.self, forKey: .method)
        self.request = try c.decode(String.self, forKey: .request)
        self.response = try c.decode(String.self, forKey: .response)
        self.service = try c.decode(String.self, forKey: .service)
        self.startedAtMs = try c.decode(Int.self, forKey: .startedAtMs)
        self.status = try c.decodeIfPresent(Int.self, forKey: .status)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.connect, forKey: .connect)
        try c.encode(self.durationMs, forKey: .durationMs)
        try c.encode(self.endpoint, forKey: .endpoint)
        try c.encode(self.failed, forKey: .failed)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.method, forKey: .method)
        try c.encode(self.request, forKey: .request)
        try c.encode(self.response, forKey: .response)
        try c.encode(self.service, forKey: .service)
        try c.encode(self.startedAtMs, forKey: .startedAtMs)
        try c.encode(self.status, forKey: .status)
    }
}

public struct RequestLog: Codable, Equatable, Hashable, Sendable {
    public let entries: [RequestEntry]

    public init(entries: [RequestEntry]) {
        self.entries = entries
    }

    enum CodingKeys: String, CodingKey {
        case entries
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.entries = try c.decode([RequestEntry].self, forKey: .entries)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.entries, forKey: .entries)
    }
}

public struct RevokedWebhook: Codable, Equatable, Hashable, Sendable {
    public let alreadyDeleted: Bool

    public init(alreadyDeleted: Bool) {
        self.alreadyDeleted = alreadyDeleted
    }

    enum CodingKeys: String, CodingKey {
        case alreadyDeleted = "already_deleted"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.alreadyDeleted = try c.decode(Bool.self, forKey: .alreadyDeleted)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.alreadyDeleted, forKey: .alreadyDeleted)
    }
}

/// `roster.list`'s result: active first, then most recently seen.
public struct Roster: Codable, Equatable, Hashable, Sendable {
    public let agents: [RosterAgent]
    public let fetchedAtMs: Int64
    /// Relaycast statuses that could not be read; their agents are missing
    /// from `agents`.
    public let unreadStatuses: [String]

    public init(agents: [RosterAgent], fetchedAtMs: Int64, unreadStatuses: [String]) {
        self.agents = agents
        self.fetchedAtMs = fetchedAtMs
        self.unreadStatuses = unreadStatuses
    }

    enum CodingKeys: String, CodingKey {
        case agents
        case fetchedAtMs = "fetched_at_ms"
        case unreadStatuses = "unread_statuses"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agents = try c.decode([RosterAgent].self, forKey: .agents)
        self.fetchedAtMs = try c.decode(Int64.self, forKey: .fetchedAtMs)
        self.unreadStatuses = try c.decode([String].self, forKey: .unreadStatuses)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agents, forKey: .agents)
        try c.encode(self.fetchedAtMs, forKey: .fetchedAtMs)
        try c.encode(self.unreadStatuses, forKey: .unreadStatuses)
    }
}

/// One roster entry, reduced to what the UI and sessions may see.
public struct RosterAgent: Codable, Equatable, Hashable, Sendable {
    /// What it is doing, as the desktop it runs on derived it from the
    /// session's own records (`relay::activity`): only while it is live,
    /// and only for a session shared with the workspace.
    public let activity: AgentActivity?
    public let address: String?
    /// Its objective, else native title, role and project, or persona.
    public let description: String
    /// The desktop it runs on, as that desktop named itself.
    public let host: String?
    /// Owned by the signed-in person.
    public let isSelf: Bool
    /// `agent`, `human` or `service`.
    public let kind: String
    public let lastSeenMs: Int64?
    /// Whether it is running now: a hint for whether a reply can come.
    public let liveness: Liveness
    public let name: String
    /// Its owner's identity hash, for grouping under people.
    public let ownerHash: String?
    /// The harness behind it (`codex`, `claude`, `grok`, `opencode`,
    /// `cursor-cloud`, `capy`), from the registrar's `session_kind`, else the
    /// name's prefix; absent when neither says.
    public let provider: String?
    /// The uploaded session whose saved Cloud overview describes this agent.
    public let sessionId: String?
    /// `active` or `idle`: Relaycast's status, any other than `active`
    /// reading `idle`.
    public let status: String
    public let `where`: RosterWhere

    public init(activity: AgentActivity? = nil, address: String? = nil, description: String, host: String? = nil, isSelf: Bool, kind: String, lastSeenMs: Int64? = nil, liveness: Liveness, name: String, ownerHash: String? = nil, provider: String? = nil, sessionId: String? = nil, status: String, `where`: RosterWhere) {
        self.activity = activity
        self.address = address
        self.description = description
        self.host = host
        self.isSelf = isSelf
        self.kind = kind
        self.lastSeenMs = lastSeenMs
        self.liveness = liveness
        self.name = name
        self.ownerHash = ownerHash
        self.provider = provider
        self.sessionId = sessionId
        self.status = status
        self.where = `where`
    }

    enum CodingKeys: String, CodingKey {
        case activity
        case address
        case description
        case host
        case isSelf = "is_self"
        case kind
        case lastSeenMs = "last_seen_ms"
        case liveness
        case name
        case ownerHash = "owner_hash"
        case provider
        case sessionId = "session_id"
        case status
        case `where`
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.activity = try c.decodeIfPresent(AgentActivity.self, forKey: .activity)
        self.address = try c.decodeIfPresent(String.self, forKey: .address)
        self.description = try c.decode(String.self, forKey: .description)
        self.host = try c.decodeIfPresent(String.self, forKey: .host)
        self.isSelf = try c.decode(Bool.self, forKey: .isSelf)
        self.kind = try c.decode(String.self, forKey: .kind)
        self.lastSeenMs = try c.decodeIfPresent(Int64.self, forKey: .lastSeenMs)
        self.liveness = try c.decode(Liveness.self, forKey: .liveness)
        self.name = try c.decode(String.self, forKey: .name)
        self.ownerHash = try c.decodeIfPresent(String.self, forKey: .ownerHash)
        self.provider = try c.decodeIfPresent(String.self, forKey: .provider)
        self.sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        self.status = try c.decode(String.self, forKey: .status)
        self.where = try c.decode(RosterWhere.self, forKey: .where)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.activity, forKey: .activity)
        try c.encode(self.address, forKey: .address)
        try c.encode(self.description, forKey: .description)
        try c.encode(self.host, forKey: .host)
        try c.encode(self.isSelf, forKey: .isSelf)
        try c.encode(self.kind, forKey: .kind)
        try c.encode(self.lastSeenMs, forKey: .lastSeenMs)
        try c.encode(self.liveness, forKey: .liveness)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.ownerHash, forKey: .ownerHash)
        try c.encodeIfPresent(self.provider, forKey: .provider)
        try c.encode(self.sessionId, forKey: .sessionId)
        try c.encode(self.status, forKey: .status)
        try c.encode(self.where, forKey: .where)
    }
}

public struct RosterParams: Codable, Equatable, Hashable, Sendable {
    /// Idle agents too: `all` can be thousands of rows.
    public let includeIdle: Bool
    /// Matches name, address or description.
    public let q: String?
    public let `where`: RosterWhere?

    public init(includeIdle: Bool = false, q: String? = nil, `where`: RosterWhere? = nil) {
        self.includeIdle = includeIdle
        self.q = q
        self.where = `where`
    }

    enum CodingKeys: String, CodingKey {
        case includeIdle = "include_idle"
        case q
        case `where`
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.includeIdle = try c.decodeIfPresent(Bool.self, forKey: .includeIdle) ?? false
        self.q = try c.decodeIfPresent(String.self, forKey: .q)
        self.where = try c.decodeIfPresent(RosterWhere.self, forKey: .where)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.includeIdle, forKey: .includeIdle)
        try c.encodeIfPresent(self.q, forKey: .q)
        try c.encodeIfPresent(self.where, forKey: .where)
    }
}

/// Where a roster agent runs.
public enum RosterWhere: String, Codable, CaseIterable, Hashable, Sendable {
    case cloud
    /// Registered from this computer.
    case thisComputer = "this_computer"
    /// Another desktop.
    case otherDesktop = "other_desktop"

    /// A value this build does not know reads as `other_desktop`.
    public init(from decoder: Decoder) throws {
        self = RosterWhere(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .otherDesktop
    }
}

/// A JSON-RPC error object. `data.kind` is the stable, machine-readable code
/// clients branch on; `message` is safe to show a person.
public struct RpcError: Codable, Equatable, Hashable, Sendable {
    public let code: Int64
    public let data: ErrorData
    public let message: String

    public init(code: Int64, data: ErrorData, message: String) {
        self.code = code
        self.data = data
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case code
        case data
        case message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.code = try c.decode(Int64.self, forKey: .code)
        self.data = try c.decode(ErrorData.self, forKey: .data)
        self.message = try c.decode(String.self, forKey: .message)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.code, forKey: .code)
        try c.encode(self.data, forKey: .data)
        try c.encode(self.message, forKey: .message)
    }
}

public struct SendParams: Codable, Equatable, Hashable, Sendable {
    /// An exact `agent@machine` address.
    public let address: String?
    /// Answers beneath this message instead.
    public let replyTo: String?
    public let text: String
    /// A name or address; give exactly one of `to` and `address`.
    public let to: String?

    public init(address: String? = nil, replyTo: String? = nil, text: String, to: String? = nil) {
        self.address = address
        self.replyTo = replyTo
        self.text = text
        self.to = to
    }

    enum CodingKeys: String, CodingKey {
        case address
        case replyTo = "reply_to"
        case text
        case to
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.address = try c.decodeIfPresent(String.self, forKey: .address)
        self.replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
        self.text = try c.decode(String.self, forKey: .text)
        self.to = try c.decodeIfPresent(String.self, forKey: .to)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.address, forKey: .address)
        try c.encodeIfPresent(self.replyTo, forKey: .replyTo)
        try c.encode(self.text, forKey: .text)
        try c.encodeIfPresent(self.to, forKey: .to)
    }
}

public struct SentMessage: Codable, Equatable, Hashable, Sendable {
    public let conversationId: String?
    public let messageId: String?
    /// The recipient and what Relaycast holds for this message, read just
    /// after the send.
    public let recipient: Recipient
    /// The name the endpoint resolved to.
    public let to: String?

    public init(conversationId: String? = nil, messageId: String? = nil, recipient: Recipient, to: String? = nil) {
        self.conversationId = conversationId
        self.messageId = messageId
        self.recipient = recipient
        self.to = to
    }

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id"
        case messageId = "message_id"
        case recipient
        case to
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId)
        self.messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
        self.recipient = try c.decode(Recipient.self, forKey: .recipient)
        self.to = try c.decodeIfPresent(String.self, forKey: .to)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.conversationId, forKey: .conversationId)
        try c.encode(self.messageId, forKey: .messageId)
        try c.encode(self.recipient, forKey: .recipient)
        try c.encode(self.to, forKey: .to)
    }
}

/// What holds a Claude Code session's transcript now. Claude Desktop
/// resumes a session in a process of its own, so Claude Code refuses
/// `claude --desktop --resume` while anything holds it; only the holder
/// hands the session over itself. Absent for a session nothing holds, for
/// every other provider, and in older cores.
public enum SessionHolder: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    /// A session a person types in. It hands over with `/desktop`.
    case interactive
    /// A headless process: `-p`/`--print`, a structured JSON pipe, or an
    /// SDK session. Claude Code's own advice for one is `claude agents`.
    case background
    /// A value this build does not know, as the core sent it.
    case unknown(String)

    public static let allCases: [SessionHolder] = [.interactive, .background]

    public init(rawValue: String) {
        switch rawValue {
        case "interactive": self = .interactive
        case "background": self = .background
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .interactive: return "interactive"
        case .background: return "background"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// Which kind of local session an agent stands for, and so which route a
/// message takes into it.
public enum SessionKind: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    /// An existing Pi session connected through the bundled extension.
    case pi
    /// An existing Oh My Pi (`omp`) session connected through the same
    /// bundled extension as Pi, installed in omp's own agent directory.
    case omp
    /// A Codex thread, in the desktop app or a terminal `codex`.
    case codex
    /// A Claude Code session in a terminal: its cross-session inbox.
    case claudeTerminal
    /// A Claude desktop app / claude.ai/code session.
    case claudeCloud
    /// A probe-managed Grok ACP session with a verified leader binding.
    case grok
    /// An already-open Grok ACP session registered with immutable proof of
    /// its leader. A separate kind from `Grok`, so a registration names one
    /// route for good and can never be delivered through the other.
    case grokOpen
    /// A probe-managed authenticated OpenCode server session.
    case opencode
    /// A Muse session a person opened in a terminal, delivered to through a
    /// probe-owned courier Muse session in the same workspace and trust (no
    /// keystrokes into the person's session; Muse's own peer messaging
    /// carries the turn). Discovered from Muse's runtime session registry.
    case museOpen
    /// An OpenCode session a person opened in a plain `opencode` TUI,
    /// reached through Agent Relay's OpenCode plugin: a per-process Unix
    /// socket that answers only delivery's requests for the sessions that
    /// process holds. Discovered from the plugin's per-pid records.
    case opencodeOpen
    /// A Devin CLI session a person runs in a terminal: its `devin acp`
    /// agent process holds `<devin>/cli/session_locks/<session>.lock` open,
    /// which is the kernel proof used for discovery and caller
    /// identification. Delivery writes the session's inbox file, which its
    /// lifecycle hooks drain into the conversation.
    case devin
    /// A Cursor CLI (`cursor-agent`) session a person runs in a terminal:
    /// the process holds its conversation's `store.db` open, which is the
    /// kernel proof used for discovery and caller identification. Delivery
    /// stages a message in Agent Relay's inbox, which Agent Relay's hooks in
    /// `~/.cursor/hooks.json` hand to the session at its next tool call or
    /// when its turn ends (`relay::cursor_cli`). Not a Cursor Cloud agent.
    case cursorCli
    /// A native Copilot harness session in VS Code, reached by verified hooks.
    case copilot
    /// An OpenClaw agent on the person's local OpenClaw Gateway, reached as
    /// a loopback operator client. Each relay sender gets a session of its
    /// own on that agent, never the person's main chat (`relay::openclaw`).
    case openclaw
    /// A Hermes Agent home whose gateway serves its API on loopback. Each
    /// relay sender gets a Hermes session of its own (`relay::hermes`).
    case hermes
    /// A value this build does not know, as the core sent it.
    case unknown(String)

    public static let allCases: [SessionKind] = [.pi, .omp, .codex, .claudeTerminal, .claudeCloud, .grok, .grokOpen, .opencode, .museOpen, .opencodeOpen, .devin, .cursorCli, .copilot, .openclaw, .hermes]

    public init(rawValue: String) {
        switch rawValue {
        case "pi": self = .pi
        case "omp": self = .omp
        case "codex": self = .codex
        case "claude-terminal": self = .claudeTerminal
        case "claude-cloud": self = .claudeCloud
        case "grok": self = .grok
        case "grok-open": self = .grokOpen
        case "opencode": self = .opencode
        case "muse-open": self = .museOpen
        case "opencode-open": self = .opencodeOpen
        case "devin": self = .devin
        case "cursor-cli": self = .cursorCli
        case "copilot": self = .copilot
        case "openclaw": self = .openclaw
        case "hermes": self = .hermes
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .pi: return "pi"
        case .omp: return "omp"
        case .codex: return "codex"
        case .claudeTerminal: return "claude-terminal"
        case .claudeCloud: return "claude-cloud"
        case .grok: return "grok"
        case .grokOpen: return "grok-open"
        case .opencode: return "opencode"
        case .museOpen: return "muse-open"
        case .opencodeOpen: return "opencode-open"
        case .devin: return "devin"
        case .cursorCli: return "cursor-cli"
        case .copilot: return "copilot"
        case .openclaw: return "openclaw"
        case .hermes: return "hermes"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// A session's registration, as `sessions.list` reports it.
public struct SessionRegistration: Codable, Equatable, Hashable, Sendable {
    public let addedBySession: Bool
    public let address: String
    /// The name it was renamed to, if any: another name that reaches it.
    public let alias: String?
    /// Relay messages waiting without session progress past the threshold.
    public let inboxStall: InboxStall?
    /// The name the agent was registered with, which it keeps while on the
    /// relay.
    public let name: String
    public let push: PushState?
    /// For an agent Agent Relay spawned here: what may be done with it.
    /// Absent for every other session and in older cores.
    public let spawn: SessionSpawn?

    public init(addedBySession: Bool, address: String, alias: String? = nil, inboxStall: InboxStall? = nil, name: String, push: PushState? = nil, spawn: SessionSpawn? = nil) {
        self.addedBySession = addedBySession
        self.address = address
        self.alias = alias
        self.inboxStall = inboxStall
        self.name = name
        self.push = push
        self.spawn = spawn
    }

    enum CodingKeys: String, CodingKey {
        case addedBySession = "added_by_session"
        case address
        case alias
        case inboxStall = "inbox_stall"
        case name
        case push
        case spawn
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.addedBySession = try c.decode(Bool.self, forKey: .addedBySession)
        self.address = try c.decode(String.self, forKey: .address)
        self.alias = try c.decodeIfPresent(String.self, forKey: .alias)
        self.inboxStall = try c.decodeIfPresent(InboxStall.self, forKey: .inboxStall)
        self.name = try c.decode(String.self, forKey: .name)
        self.push = try c.decodeIfPresent(PushState.self, forKey: .push)
        self.spawn = try c.decodeIfPresent(SessionSpawn.self, forKey: .spawn)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.addedBySession, forKey: .addedBySession)
        try c.encode(self.address, forKey: .address)
        try c.encodeIfPresent(self.alias, forKey: .alias)
        try c.encodeIfPresent(self.inboxStall, forKey: .inboxStall)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.push, forKey: .push)
        try c.encodeIfPresent(self.spawn, forKey: .spawn)
    }
}

/// What the apps may do with a session Agent Relay spawned, as
/// `sessions.list` reports it on its registration.
public struct SessionSpawn: Codable, Equatable, Hashable, Sendable {
    /// Agent Relay runs it headless and it can be handed to an interactive
    /// client (`agents.take_over`); until then its transcript is its own
    /// output (`agents.transcript`), and resuming it elsewhere is never
    /// offered. `false` for a harness whose sessions its own app opens live
    /// (Codex), and once taken over.
    public let canTakeOver: Bool
    /// The harness's id, such as `claude`.
    public let harness: String
    /// It was taken over: its headless process was stopped, and the session
    /// is the person's to run in an interactive client, under the same name.
    public let takenOver: Bool

    public init(canTakeOver: Bool, harness: String, takenOver: Bool) {
        self.canTakeOver = canTakeOver
        self.harness = harness
        self.takenOver = takenOver
    }

    enum CodingKeys: String, CodingKey {
        case canTakeOver = "can_take_over"
        case harness
        case takenOver = "taken_over"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.canTakeOver = try c.decode(Bool.self, forKey: .canTakeOver)
        self.harness = try c.decode(String.self, forKey: .harness)
        self.takenOver = try c.decode(Bool.self, forKey: .takenOver)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.canTakeOver, forKey: .canTakeOver)
        try c.encode(self.harness, forKey: .harness)
        try c.encode(self.takenOver, forKey: .takenOver)
    }
}

public struct SessionTitleCapability: Codable, Equatable, Hashable, Sendable {
    /// A user-safe explanation when the native harness cannot be renamed.
    public let reason: String?
    public let supported: Bool

    public init(reason: String? = nil, supported: Bool) {
        self.reason = reason
        self.supported = supported
    }

    enum CodingKeys: String, CodingKey {
        case reason
        case supported
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.reason = try c.decodeIfPresent(String.self, forKey: .reason)
        self.supported = try c.decode(Bool.self, forKey: .supported)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.reason, forKey: .reason)
        try c.encode(self.supported, forKey: .supported)
    }
}

/// A native session title, addressed by catalog source and original session id.
/// Paths and endpoints are resolved by the core, never supplied by a client.
public struct SessionTitleIdentity: Codable, Equatable, Hashable, Sendable {
    public let sessionId: String
    public let source: String

    public init(sessionId: String, source: String) {
        self.sessionId = sessionId
        self.source = source
    }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case source
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
        self.source = try c.decode(String.self, forKey: .source)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.sessionId, forKey: .sessionId)
        try c.encode(self.source, forKey: .source)
    }
}

public struct SessionTitleSetParams: Codable, Equatable, Hashable, Sendable {
    public let sessionId: String
    public let source: String
    public let title: String

    public init(sessionId: String, source: String, title: String) {
        self.sessionId = sessionId
        self.source = source
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case source
        case title
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
        self.source = try c.decode(String.self, forKey: .source)
        self.title = try c.decode(String.self, forKey: .title)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.sessionId, forKey: .sessionId)
        try c.encode(self.source, forKey: .source)
        try c.encode(self.title, forKey: .title)
    }
}

public struct SessionTitleUpdated: Codable, Equatable, Hashable, Sendable {
    /// The canonical title acknowledged by the native harness.
    public let title: String

    public init(title: String) {
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case title
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.title = try c.decode(String.self, forKey: .title)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.title, forKey: .title)
    }
}

/// The settings to change; each is optional and never `null`.
public struct SettingsChange: Codable, Equatable, Hashable, Sendable {
    public let acceptSpawns: Bool?
    public let allowSelfRegistration: Bool?
    public let analyticsEnabled: Bool?
    public let autoActivate: Bool?
    /// Whether agents registered from now on join #general.
    public let autoJoinGeneral: Bool?
    public let claudeCloudSessions: Bool?
    /// Changes one watched folder, such as whether it is shared.
    public let claudeConfigDir: ClaudeConfigDirChange?
    /// The Claude Code config folders added in Settings, replacing the
    /// last list. Each must be an existing folder.
    public let claudeConfigDirs: [String]?
    /// Adds or removes Agent Relay's Claude Code SessionStart hook. The hook
    /// never registers a session.
    public let claudeSessionHook: Bool?
    /// Adds or removes Agent Relay's Codex Stop hook.
    public let codexStopHook: Bool?
    /// Whether the tools found here are connected once signed in.
    public let connectDetectedTools: Bool?
    public let contractorAccess: Bool?
    /// Adds or removes Agent Relay's hooks in Cursor CLI's
    /// `~/.cursor/hooks.json`.
    public let cursorDirectDelivery: Bool?
    /// Adds or removes Agent Relay's lifecycle hooks in Devin's
    /// `config.json`.
    public let devinDirectDelivery: Bool?
    public let directDelivery: Bool?
    /// First-run default: `true` turns direct delivery on unless the user's
    /// own Claude settings already name `crossSessionInbound` (`hold`
    /// included); `false` changes nothing. Write-only.
    public let directDeliveryDefault: Bool?
    public let grokLeader: Bool?
    /// Turns the Hermes route on or off.
    public let hermesAgent: Bool?
    /// How long this computer keeps local session history: 7, 30 or 90
    /// days, or 0 to keep it forever.
    public let historyRetentionDays: Int?
    public let mobileClaudeHandoff: Bool?
    public let mobileNativeContinuation: Bool?
    /// Turns the OpenClaw Gateway route on or off.
    public let openclawGateway: Bool?
    /// Whether open OpenCode sessions join by themselves while
    /// `auto_activate` is on.
    public let opencodeAutoActivate: Bool?
    public let opencodePlugin: Bool?
    /// Whether open Pi sessions join by themselves while `auto_activate`
    /// is on.
    public let piAutoActivate: Bool?
    /// Installs (`true`) or removes (`false`) Agent Relay's Pi extension.
    public let piExtension: Bool?
    /// Shows each relay message whole in agent chats (`true`), or hides it
    /// (`false`, the default): the agent still reads it from hidden history.
    public let showRelayMessages: Bool?
    public let spawnAllowTeammates: Bool?
    public let spawnBillingClaude: String?
    public let spawnBillingCodex: String?
    public let spawnFullAccessClaude: Bool?
    public let spawnFullAccessCodex: Bool?
    /// Changes the spawn settings of the harnesses named, each by id; a
    /// value left out is unchanged.
    public let spawnHarnesses: [String: SpawnHarnessSettings]?
    public let spawnMaxAgents: Int?
    public let spawnNativeInput: Bool?
    public let spawnRepositories: [String]?
    public let spawnRequesterApprovals: Bool?
    public let teammateNativeInput: Bool?
    /// Turns trusting the people in the workspace on or off.
    public let trustWorkspaceMembers: Bool?
    /// Replaces the relay senders trusted like the person.
    public let trustedRelaySenders: [String]?

    public init(acceptSpawns: Bool? = nil, allowSelfRegistration: Bool? = nil, analyticsEnabled: Bool? = nil, autoActivate: Bool? = nil, autoJoinGeneral: Bool? = nil, claudeCloudSessions: Bool? = nil, claudeConfigDir: ClaudeConfigDirChange? = nil, claudeConfigDirs: [String]? = nil, claudeSessionHook: Bool? = nil, codexStopHook: Bool? = nil, connectDetectedTools: Bool? = nil, contractorAccess: Bool? = nil, cursorDirectDelivery: Bool? = nil, devinDirectDelivery: Bool? = nil, directDelivery: Bool? = nil, directDeliveryDefault: Bool? = nil, grokLeader: Bool? = nil, hermesAgent: Bool? = nil, historyRetentionDays: Int? = nil, mobileClaudeHandoff: Bool? = nil, mobileNativeContinuation: Bool? = nil, openclawGateway: Bool? = nil, opencodeAutoActivate: Bool? = nil, opencodePlugin: Bool? = nil, piAutoActivate: Bool? = nil, piExtension: Bool? = nil, showRelayMessages: Bool? = nil, spawnAllowTeammates: Bool? = nil, spawnBillingClaude: String? = nil, spawnBillingCodex: String? = nil, spawnFullAccessClaude: Bool? = nil, spawnFullAccessCodex: Bool? = nil, spawnHarnesses: [String: SpawnHarnessSettings]? = nil, spawnMaxAgents: Int? = nil, spawnNativeInput: Bool? = nil, spawnRepositories: [String]? = nil, spawnRequesterApprovals: Bool? = nil, teammateNativeInput: Bool? = nil, trustWorkspaceMembers: Bool? = nil, trustedRelaySenders: [String]? = nil) {
        self.acceptSpawns = acceptSpawns
        self.allowSelfRegistration = allowSelfRegistration
        self.analyticsEnabled = analyticsEnabled
        self.autoActivate = autoActivate
        self.autoJoinGeneral = autoJoinGeneral
        self.claudeCloudSessions = claudeCloudSessions
        self.claudeConfigDir = claudeConfigDir
        self.claudeConfigDirs = claudeConfigDirs
        self.claudeSessionHook = claudeSessionHook
        self.codexStopHook = codexStopHook
        self.connectDetectedTools = connectDetectedTools
        self.contractorAccess = contractorAccess
        self.cursorDirectDelivery = cursorDirectDelivery
        self.devinDirectDelivery = devinDirectDelivery
        self.directDelivery = directDelivery
        self.directDeliveryDefault = directDeliveryDefault
        self.grokLeader = grokLeader
        self.hermesAgent = hermesAgent
        self.historyRetentionDays = historyRetentionDays
        self.mobileClaudeHandoff = mobileClaudeHandoff
        self.mobileNativeContinuation = mobileNativeContinuation
        self.openclawGateway = openclawGateway
        self.opencodeAutoActivate = opencodeAutoActivate
        self.opencodePlugin = opencodePlugin
        self.piAutoActivate = piAutoActivate
        self.piExtension = piExtension
        self.showRelayMessages = showRelayMessages
        self.spawnAllowTeammates = spawnAllowTeammates
        self.spawnBillingClaude = spawnBillingClaude
        self.spawnBillingCodex = spawnBillingCodex
        self.spawnFullAccessClaude = spawnFullAccessClaude
        self.spawnFullAccessCodex = spawnFullAccessCodex
        self.spawnHarnesses = spawnHarnesses
        self.spawnMaxAgents = spawnMaxAgents
        self.spawnNativeInput = spawnNativeInput
        self.spawnRepositories = spawnRepositories
        self.spawnRequesterApprovals = spawnRequesterApprovals
        self.teammateNativeInput = teammateNativeInput
        self.trustWorkspaceMembers = trustWorkspaceMembers
        self.trustedRelaySenders = trustedRelaySenders
    }

    enum CodingKeys: String, CodingKey {
        case acceptSpawns = "accept_spawns"
        case allowSelfRegistration = "allow_self_registration"
        case analyticsEnabled = "analytics_enabled"
        case autoActivate = "auto_activate"
        case autoJoinGeneral = "auto_join_general"
        case claudeCloudSessions = "claude_cloud_sessions"
        case claudeConfigDir = "claude_config_dir"
        case claudeConfigDirs = "claude_config_dirs"
        case claudeSessionHook = "claude_session_hook"
        case codexStopHook = "codex_stop_hook"
        case connectDetectedTools = "connect_detected_tools"
        case contractorAccess = "contractor_access"
        case cursorDirectDelivery = "cursor_direct_delivery"
        case devinDirectDelivery = "devin_direct_delivery"
        case directDelivery = "direct_delivery"
        case directDeliveryDefault = "direct_delivery_default"
        case grokLeader = "grok_leader"
        case hermesAgent = "hermes_agent"
        case historyRetentionDays = "history_retention_days"
        case mobileClaudeHandoff = "mobile_claude_handoff"
        case mobileNativeContinuation = "mobile_native_continuation"
        case openclawGateway = "openclaw_gateway"
        case opencodeAutoActivate = "opencode_auto_activate"
        case opencodePlugin = "opencode_plugin"
        case piAutoActivate = "pi_auto_activate"
        case piExtension = "pi_extension"
        case showRelayMessages = "show_relay_messages"
        case spawnAllowTeammates = "spawn_allow_teammates"
        case spawnBillingClaude = "spawn_billing_claude"
        case spawnBillingCodex = "spawn_billing_codex"
        case spawnFullAccessClaude = "spawn_full_access_claude"
        case spawnFullAccessCodex = "spawn_full_access_codex"
        case spawnHarnesses = "spawn_harnesses"
        case spawnMaxAgents = "spawn_max_agents"
        case spawnNativeInput = "spawn_native_input"
        case spawnRepositories = "spawn_repositories"
        case spawnRequesterApprovals = "spawn_requester_approvals"
        case teammateNativeInput = "teammate_native_input"
        case trustWorkspaceMembers = "trust_workspace_members"
        case trustedRelaySenders = "trusted_relay_senders"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.acceptSpawns = try c.decodeIfPresent(Bool.self, forKey: .acceptSpawns)
        self.allowSelfRegistration = try c.decodeIfPresent(Bool.self, forKey: .allowSelfRegistration)
        self.analyticsEnabled = try c.decodeIfPresent(Bool.self, forKey: .analyticsEnabled)
        self.autoActivate = try c.decodeIfPresent(Bool.self, forKey: .autoActivate)
        self.autoJoinGeneral = try c.decodeIfPresent(Bool.self, forKey: .autoJoinGeneral)
        self.claudeCloudSessions = try c.decodeIfPresent(Bool.self, forKey: .claudeCloudSessions)
        self.claudeConfigDir = try c.decodeIfPresent(ClaudeConfigDirChange.self, forKey: .claudeConfigDir)
        self.claudeConfigDirs = try c.decodeIfPresent([String].self, forKey: .claudeConfigDirs)
        self.claudeSessionHook = try c.decodeIfPresent(Bool.self, forKey: .claudeSessionHook)
        self.codexStopHook = try c.decodeIfPresent(Bool.self, forKey: .codexStopHook)
        self.connectDetectedTools = try c.decodeIfPresent(Bool.self, forKey: .connectDetectedTools)
        self.contractorAccess = try c.decodeIfPresent(Bool.self, forKey: .contractorAccess)
        self.cursorDirectDelivery = try c.decodeIfPresent(Bool.self, forKey: .cursorDirectDelivery)
        self.devinDirectDelivery = try c.decodeIfPresent(Bool.self, forKey: .devinDirectDelivery)
        self.directDelivery = try c.decodeIfPresent(Bool.self, forKey: .directDelivery)
        self.directDeliveryDefault = try c.decodeIfPresent(Bool.self, forKey: .directDeliveryDefault)
        self.grokLeader = try c.decodeIfPresent(Bool.self, forKey: .grokLeader)
        self.hermesAgent = try c.decodeIfPresent(Bool.self, forKey: .hermesAgent)
        self.historyRetentionDays = try c.decodeIfPresent(Int.self, forKey: .historyRetentionDays)
        self.mobileClaudeHandoff = try c.decodeIfPresent(Bool.self, forKey: .mobileClaudeHandoff)
        self.mobileNativeContinuation = try c.decodeIfPresent(Bool.self, forKey: .mobileNativeContinuation)
        self.openclawGateway = try c.decodeIfPresent(Bool.self, forKey: .openclawGateway)
        self.opencodeAutoActivate = try c.decodeIfPresent(Bool.self, forKey: .opencodeAutoActivate)
        self.opencodePlugin = try c.decodeIfPresent(Bool.self, forKey: .opencodePlugin)
        self.piAutoActivate = try c.decodeIfPresent(Bool.self, forKey: .piAutoActivate)
        self.piExtension = try c.decodeIfPresent(Bool.self, forKey: .piExtension)
        self.showRelayMessages = try c.decodeIfPresent(Bool.self, forKey: .showRelayMessages)
        self.spawnAllowTeammates = try c.decodeIfPresent(Bool.self, forKey: .spawnAllowTeammates)
        self.spawnBillingClaude = try c.decodeIfPresent(String.self, forKey: .spawnBillingClaude)
        self.spawnBillingCodex = try c.decodeIfPresent(String.self, forKey: .spawnBillingCodex)
        self.spawnFullAccessClaude = try c.decodeIfPresent(Bool.self, forKey: .spawnFullAccessClaude)
        self.spawnFullAccessCodex = try c.decodeIfPresent(Bool.self, forKey: .spawnFullAccessCodex)
        self.spawnHarnesses = try c.decodeIfPresent([String: SpawnHarnessSettings].self, forKey: .spawnHarnesses)
        self.spawnMaxAgents = try c.decodeIfPresent(Int.self, forKey: .spawnMaxAgents)
        self.spawnNativeInput = try c.decodeIfPresent(Bool.self, forKey: .spawnNativeInput)
        self.spawnRepositories = try c.decodeIfPresent([String].self, forKey: .spawnRepositories)
        self.spawnRequesterApprovals = try c.decodeIfPresent(Bool.self, forKey: .spawnRequesterApprovals)
        self.teammateNativeInput = try c.decodeIfPresent(Bool.self, forKey: .teammateNativeInput)
        self.trustWorkspaceMembers = try c.decodeIfPresent(Bool.self, forKey: .trustWorkspaceMembers)
        self.trustedRelaySenders = try c.decodeIfPresent([String].self, forKey: .trustedRelaySenders)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.acceptSpawns, forKey: .acceptSpawns)
        try c.encodeIfPresent(self.allowSelfRegistration, forKey: .allowSelfRegistration)
        try c.encodeIfPresent(self.analyticsEnabled, forKey: .analyticsEnabled)
        try c.encodeIfPresent(self.autoActivate, forKey: .autoActivate)
        try c.encodeIfPresent(self.autoJoinGeneral, forKey: .autoJoinGeneral)
        try c.encodeIfPresent(self.claudeCloudSessions, forKey: .claudeCloudSessions)
        try c.encodeIfPresent(self.claudeConfigDir, forKey: .claudeConfigDir)
        try c.encodeIfPresent(self.claudeConfigDirs, forKey: .claudeConfigDirs)
        try c.encodeIfPresent(self.claudeSessionHook, forKey: .claudeSessionHook)
        try c.encodeIfPresent(self.codexStopHook, forKey: .codexStopHook)
        try c.encodeIfPresent(self.connectDetectedTools, forKey: .connectDetectedTools)
        try c.encodeIfPresent(self.contractorAccess, forKey: .contractorAccess)
        try c.encodeIfPresent(self.cursorDirectDelivery, forKey: .cursorDirectDelivery)
        try c.encodeIfPresent(self.devinDirectDelivery, forKey: .devinDirectDelivery)
        try c.encodeIfPresent(self.directDelivery, forKey: .directDelivery)
        try c.encodeIfPresent(self.directDeliveryDefault, forKey: .directDeliveryDefault)
        try c.encodeIfPresent(self.grokLeader, forKey: .grokLeader)
        try c.encodeIfPresent(self.hermesAgent, forKey: .hermesAgent)
        try c.encodeIfPresent(self.historyRetentionDays, forKey: .historyRetentionDays)
        try c.encodeIfPresent(self.mobileClaudeHandoff, forKey: .mobileClaudeHandoff)
        try c.encodeIfPresent(self.mobileNativeContinuation, forKey: .mobileNativeContinuation)
        try c.encodeIfPresent(self.openclawGateway, forKey: .openclawGateway)
        try c.encodeIfPresent(self.opencodeAutoActivate, forKey: .opencodeAutoActivate)
        try c.encodeIfPresent(self.opencodePlugin, forKey: .opencodePlugin)
        try c.encodeIfPresent(self.piAutoActivate, forKey: .piAutoActivate)
        try c.encodeIfPresent(self.piExtension, forKey: .piExtension)
        try c.encodeIfPresent(self.showRelayMessages, forKey: .showRelayMessages)
        try c.encodeIfPresent(self.spawnAllowTeammates, forKey: .spawnAllowTeammates)
        try c.encodeIfPresent(self.spawnBillingClaude, forKey: .spawnBillingClaude)
        try c.encodeIfPresent(self.spawnBillingCodex, forKey: .spawnBillingCodex)
        try c.encodeIfPresent(self.spawnFullAccessClaude, forKey: .spawnFullAccessClaude)
        try c.encodeIfPresent(self.spawnFullAccessCodex, forKey: .spawnFullAccessCodex)
        try c.encodeIfPresent(self.spawnHarnesses, forKey: .spawnHarnesses)
        try c.encodeIfPresent(self.spawnMaxAgents, forKey: .spawnMaxAgents)
        try c.encodeIfPresent(self.spawnNativeInput, forKey: .spawnNativeInput)
        try c.encodeIfPresent(self.spawnRepositories, forKey: .spawnRepositories)
        try c.encodeIfPresent(self.spawnRequesterApprovals, forKey: .spawnRequesterApprovals)
        try c.encodeIfPresent(self.teammateNativeInput, forKey: .teammateNativeInput)
        try c.encodeIfPresent(self.trustWorkspaceMembers, forKey: .trustWorkspaceMembers)
        try c.encodeIfPresent(self.trustedRelaySenders, forKey: .trustedRelaySenders)
    }
}

/// Every setting. Those an extension owns are absent when the core runs
/// without it.
public struct SettingsValues: Codable, Equatable, Hashable, Sendable {
    /// Agent Relay may start agents on this computer, headless
    /// (`relay::spawn`). On unless turned off. Absent in older cores.
    public let acceptSpawns: Bool?
    /// The latest settings changes agents made on the session socket
    /// (`PATCH /settings`), newest first. Read-only: a record, not a
    /// setting. Absent in older cores.
    public let agentChanges: [AgentSettingsChange]?
    /// Sessions may put themselves on the relay.
    public let allowSelfRegistration: Bool
    /// Whether Agent Relay sends usage analytics (`telemetry`). On unless
    /// turned off.
    public let analyticsEnabled: Bool?
    /// Newly found live sessions are registered.
    public let autoActivate: Bool
    /// Whether agents registered from now on join #general, so its posts
    /// reach them as turns. Off unless turned on; agents already registered
    /// keep the channels they are in. Absent in older cores.
    public let autoJoinGeneral: Bool?
    /// Whether Claude Code cloud sessions on claude.ai are listed and
    /// uploaded, read with Claude Code's own login in `~/.claude` (on macOS,
    /// its Keychain item). Off unless turned on.
    public let claudeCloudSessions: Bool?
    /// Every Claude Code config folder whose sessions this computer finds
    /// and uploads, the desktop's own first; read-only here, and
    /// `claude_config_dirs` in a change sets the folders added in Settings.
    public let claudeConfigDirs: [ClaudeConfigDir]?
    /// Whether Agent Relay's Claude Code SessionStart hook is installed in
    /// each known Claude login's `settings.json`. Off unless turned on.
    /// Absent when no Claude login directory exists. The hook never
    /// registers a session.
    public let claudeSessionHook: Bool?
    /// Whether Agent Relay's Codex Stop hook is in `~/.codex/hooks.json`, so
    /// relayed messages show in Conductor's Codex chats. Absent where
    /// Conductor has never run.
    public let codexStopHook: Bool?
    /// Whether the tools found here are connected once the person is signed
    /// in; nothing is written to a tool before. On unless turned off.
    public let connectDetectedTools: Bool?
    /// Contractor access: a workspace owner grants a contractor's seat
    /// scoped access to the workspace's services. Off unless turned on.
    public let contractorAccess: Bool?
    /// Whether Agent Relay's hooks are in Cursor CLI's `~/.cursor/hooks.json`,
    /// so a Cursor CLI session gets its messages at its next tool call or
    /// when its turn ends. Off unless turned on. Absent where Cursor CLI has
    /// never run.
    public let cursorDirectDelivery: Bool?
    /// Read-only: the tools signing in connects, by name (`Claude Code`, …).
    public let detectedTools: [String]?
    /// Whether Agent Relay's lifecycle hooks are in Devin's `config.json`,
    /// so staged inbox messages reach the conversation. Absent where Devin
    /// has never run.
    public let devinDirectDelivery: Bool?
    /// Claude Code's `crossSessionInbound`.
    public let directDelivery: Bool?
    /// The organization's `crossSessionInbound`, which a user setting cannot
    /// override; read-only, and absent when the organization sets none.
    public let directDeliveryManaged: String?
    /// Grok's `[cli] use_leader`: whether the sessions Grok opens run on its
    /// shared leader, the only route into a running Grok session. Absent
    /// where Grok has never run.
    public let grokLeader: Bool?
    /// Whether Agent Relay lists the local Hermes home and delivers to it
    /// through its loopback API, each relay sender in a session of its own.
    /// Absent where Hermes has never run.
    public let hermesAgent: Bool?
    /// Days this computer keeps local session history: 7, 30 or 90, or 0
    /// to keep it forever. 30 unless changed. relayhistory removes older
    /// sessions from this computer; uploaded copies are not affected.
    /// Absent in older cores.
    public let historyRetentionDays: Int?
    /// Your messages from the phone continue a Claude Code session as your
    /// own turns. On unless turned off, once this computer's ownership is
    /// verified; absent on cores without the native bridge.
    public let mobileClaudeHandoff: Bool?
    /// Whether the native Claude bridge is verified on this platform. Read only.
    public let mobileClaudeHandoffSupported: Bool?
    /// Your messages from the phone continue other supported sessions as
    /// your own turns. On unless turned off, once ownership is verified.
    public let mobileNativeContinuation: Bool?
    /// Whether this platform has verified native continuation adapters. Read only.
    public let mobileNativeContinuationSupported: Bool?
    /// Whether Agent Relay lists the agents of the local OpenClaw Gateway
    /// and delivers to them, each relay sender in a session of its own.
    /// Absent where OpenClaw is not set up.
    public let openclawGateway: Bool?
    /// The version of the local OpenClaw Gateway while it is on and cannot
    /// limit relay sessions (older than 2026.8.1): its relay senders then
    /// get the agent's usual tools. Read-only; absent otherwise.
    public let openclawUnlimitedVersion: String?
    /// Whether an open OpenCode session joins the relay by itself while
    /// `auto_activate` is on. Off unless turned on (`relay init` turns it on
    /// for a person who chose OpenCode): with it off, an OpenCode session
    /// joins only when added. Absent in older cores.
    public let opencodeAutoActivate: Bool?
    /// Whether Agent Relay's OpenCode plugin is installed in OpenCode's
    /// global `plugins/`, the route into a plain OpenCode session. Absent
    /// where OpenCode has never run.
    public let opencodePlugin: Bool?
    /// Whether an open Pi session joins the relay by itself while
    /// `auto_activate` is on. Off unless turned on (`relay init` turns it on
    /// for a person who chose Pi): with it off, a Pi session joins only when
    /// added. Absent in older cores.
    public let piAutoActivate: Bool?
    /// Whether Agent Relay's Pi extension is installed in Pi's global
    /// `extensions/`, the route into a Pi session. The desktop's core
    /// installs it at start unless it was turned off; a core `relay init`
    /// manages installs it only when this is turned on. Absent where Pi has
    /// never run.
    public let piExtension: Bool?
    /// Whether relay messages show in agent chats. Off unless turned on: the
    /// agent reads each message from hidden history and the chat shows none
    /// of it.
    public let showRelayMessages: Bool?
    /// Workspace owners and admins may spawn here too, not only this
    /// computer's owner; advertised as `teammates` and enforced by Cloud.
    /// Off unless turned on.
    public let spawnAllowTeammates: Bool?
    /// How spawned Claude is paid for, as `spawn_billing_codex`.
    public let spawnBillingClaude: String?
    /// How spawned Codex is paid for, as advertised to requesters:
    /// `unspecified`, `subscription` or `api`.
    public let spawnBillingCodex: String?
    /// Spawned Claude skips permission prompts; off lets it edit files and
    /// sends anything else that would ask to be answered remotely. On unless
    /// turned off.
    public let spawnFullAccessClaude: Bool?
    /// Spawned Codex runs without its sandbox; off keeps it to its
    /// workspace. On unless turned off.
    public let spawnFullAccessCodex: Bool?
    /// Each known harness's spawn settings, by id: those its descriptor
    /// offers (`SpawnStatus.harness_descriptors`). Codex and Claude have
    /// the flat keys above as well. Absent in older cores.
    public let spawnHarnesses: [String: SpawnHarnessSettings]?
    /// The most spawned agents this computer runs at once: 0 to 32, where 0
    /// (or no setting) means no limit. An idle agent keeps its place until
    /// it is released.
    public let spawnMaxAgents: Int?
    /// Allow verified spawning agents to send native input; on by default.
    public let spawnNativeInput: Bool?
    /// Owner/name keys of the repositories this computer offers spawned
    /// agents for, advertised as the node's `repo_keys`.
    public let spawnRepositories: [String]?
    /// The agent that spawned a session may answer its permission and
    /// approval requests by direct message, as the machine owner may; the
    /// first answer counts. Needs `spawn_native_input`. On in Agent Relay Dev
    /// and off in the release build unless set. Absent in older cores.
    public let spawnRequesterApprovals: Bool?
    /// A teammate's direct message to a Claude Code session with Agent
    /// Relay's plugin starts a user turn, labelled with the sender; on by
    /// default. Absent in older cores.
    public let teammateNativeInput: Bool?
    /// Whether the people in the workspace are trusted like the person too,
    /// by their person identity's Relaycast agent id (never their agents).
    /// On unless turned off. Absent where neither OpenClaw nor Hermes is set
    /// up.
    public let trustWorkspaceMembers: Bool?
    /// Relay senders (names or exact addresses) trusted like the person:
    /// their messages reach the person's own OpenClaw and Hermes instead of
    /// an answer-only session. Absent where neither is set up.
    public let trustedRelaySenders: [String]?
    /// The people in the workspace trusted while `trust_workspace_members`
    /// is on, as Agent Relay Cloud lists them; read-only. Empty while it is
    /// off, signed out, or Cloud's list has not been read lately.
    public let workspaceMembers: [TrustedWorkspaceMember]?

    public init(acceptSpawns: Bool? = nil, agentChanges: [AgentSettingsChange]? = nil, allowSelfRegistration: Bool, analyticsEnabled: Bool? = nil, autoActivate: Bool, autoJoinGeneral: Bool? = nil, claudeCloudSessions: Bool? = nil, claudeConfigDirs: [ClaudeConfigDir]? = nil, claudeSessionHook: Bool? = nil, codexStopHook: Bool? = nil, connectDetectedTools: Bool? = nil, contractorAccess: Bool? = nil, cursorDirectDelivery: Bool? = nil, detectedTools: [String]? = nil, devinDirectDelivery: Bool? = nil, directDelivery: Bool? = nil, directDeliveryManaged: String? = nil, grokLeader: Bool? = nil, hermesAgent: Bool? = nil, historyRetentionDays: Int? = nil, mobileClaudeHandoff: Bool? = nil, mobileClaudeHandoffSupported: Bool? = nil, mobileNativeContinuation: Bool? = nil, mobileNativeContinuationSupported: Bool? = nil, openclawGateway: Bool? = nil, openclawUnlimitedVersion: String? = nil, opencodeAutoActivate: Bool? = nil, opencodePlugin: Bool? = nil, piAutoActivate: Bool? = nil, piExtension: Bool? = nil, showRelayMessages: Bool? = nil, spawnAllowTeammates: Bool? = nil, spawnBillingClaude: String? = nil, spawnBillingCodex: String? = nil, spawnFullAccessClaude: Bool? = nil, spawnFullAccessCodex: Bool? = nil, spawnHarnesses: [String: SpawnHarnessSettings]? = nil, spawnMaxAgents: Int? = nil, spawnNativeInput: Bool? = nil, spawnRepositories: [String]? = nil, spawnRequesterApprovals: Bool? = nil, teammateNativeInput: Bool? = nil, trustWorkspaceMembers: Bool? = nil, trustedRelaySenders: [String]? = nil, workspaceMembers: [TrustedWorkspaceMember]? = nil) {
        self.acceptSpawns = acceptSpawns
        self.agentChanges = agentChanges
        self.allowSelfRegistration = allowSelfRegistration
        self.analyticsEnabled = analyticsEnabled
        self.autoActivate = autoActivate
        self.autoJoinGeneral = autoJoinGeneral
        self.claudeCloudSessions = claudeCloudSessions
        self.claudeConfigDirs = claudeConfigDirs
        self.claudeSessionHook = claudeSessionHook
        self.codexStopHook = codexStopHook
        self.connectDetectedTools = connectDetectedTools
        self.contractorAccess = contractorAccess
        self.cursorDirectDelivery = cursorDirectDelivery
        self.detectedTools = detectedTools
        self.devinDirectDelivery = devinDirectDelivery
        self.directDelivery = directDelivery
        self.directDeliveryManaged = directDeliveryManaged
        self.grokLeader = grokLeader
        self.hermesAgent = hermesAgent
        self.historyRetentionDays = historyRetentionDays
        self.mobileClaudeHandoff = mobileClaudeHandoff
        self.mobileClaudeHandoffSupported = mobileClaudeHandoffSupported
        self.mobileNativeContinuation = mobileNativeContinuation
        self.mobileNativeContinuationSupported = mobileNativeContinuationSupported
        self.openclawGateway = openclawGateway
        self.openclawUnlimitedVersion = openclawUnlimitedVersion
        self.opencodeAutoActivate = opencodeAutoActivate
        self.opencodePlugin = opencodePlugin
        self.piAutoActivate = piAutoActivate
        self.piExtension = piExtension
        self.showRelayMessages = showRelayMessages
        self.spawnAllowTeammates = spawnAllowTeammates
        self.spawnBillingClaude = spawnBillingClaude
        self.spawnBillingCodex = spawnBillingCodex
        self.spawnFullAccessClaude = spawnFullAccessClaude
        self.spawnFullAccessCodex = spawnFullAccessCodex
        self.spawnHarnesses = spawnHarnesses
        self.spawnMaxAgents = spawnMaxAgents
        self.spawnNativeInput = spawnNativeInput
        self.spawnRepositories = spawnRepositories
        self.spawnRequesterApprovals = spawnRequesterApprovals
        self.teammateNativeInput = teammateNativeInput
        self.trustWorkspaceMembers = trustWorkspaceMembers
        self.trustedRelaySenders = trustedRelaySenders
        self.workspaceMembers = workspaceMembers
    }

    enum CodingKeys: String, CodingKey {
        case acceptSpawns = "accept_spawns"
        case agentChanges = "agent_changes"
        case allowSelfRegistration = "allow_self_registration"
        case analyticsEnabled = "analytics_enabled"
        case autoActivate = "auto_activate"
        case autoJoinGeneral = "auto_join_general"
        case claudeCloudSessions = "claude_cloud_sessions"
        case claudeConfigDirs = "claude_config_dirs"
        case claudeSessionHook = "claude_session_hook"
        case codexStopHook = "codex_stop_hook"
        case connectDetectedTools = "connect_detected_tools"
        case contractorAccess = "contractor_access"
        case cursorDirectDelivery = "cursor_direct_delivery"
        case detectedTools = "detected_tools"
        case devinDirectDelivery = "devin_direct_delivery"
        case directDelivery = "direct_delivery"
        case directDeliveryManaged = "direct_delivery_managed"
        case grokLeader = "grok_leader"
        case hermesAgent = "hermes_agent"
        case historyRetentionDays = "history_retention_days"
        case mobileClaudeHandoff = "mobile_claude_handoff"
        case mobileClaudeHandoffSupported = "mobile_claude_handoff_supported"
        case mobileNativeContinuation = "mobile_native_continuation"
        case mobileNativeContinuationSupported = "mobile_native_continuation_supported"
        case openclawGateway = "openclaw_gateway"
        case openclawUnlimitedVersion = "openclaw_unlimited_version"
        case opencodeAutoActivate = "opencode_auto_activate"
        case opencodePlugin = "opencode_plugin"
        case piAutoActivate = "pi_auto_activate"
        case piExtension = "pi_extension"
        case showRelayMessages = "show_relay_messages"
        case spawnAllowTeammates = "spawn_allow_teammates"
        case spawnBillingClaude = "spawn_billing_claude"
        case spawnBillingCodex = "spawn_billing_codex"
        case spawnFullAccessClaude = "spawn_full_access_claude"
        case spawnFullAccessCodex = "spawn_full_access_codex"
        case spawnHarnesses = "spawn_harnesses"
        case spawnMaxAgents = "spawn_max_agents"
        case spawnNativeInput = "spawn_native_input"
        case spawnRepositories = "spawn_repositories"
        case spawnRequesterApprovals = "spawn_requester_approvals"
        case teammateNativeInput = "teammate_native_input"
        case trustWorkspaceMembers = "trust_workspace_members"
        case trustedRelaySenders = "trusted_relay_senders"
        case workspaceMembers = "workspace_members"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.acceptSpawns = try c.decodeIfPresent(Bool.self, forKey: .acceptSpawns)
        self.agentChanges = try c.decodeIfPresent([AgentSettingsChange].self, forKey: .agentChanges)
        self.allowSelfRegistration = try c.decode(Bool.self, forKey: .allowSelfRegistration)
        self.analyticsEnabled = try c.decodeIfPresent(Bool.self, forKey: .analyticsEnabled)
        self.autoActivate = try c.decode(Bool.self, forKey: .autoActivate)
        self.autoJoinGeneral = try c.decodeIfPresent(Bool.self, forKey: .autoJoinGeneral)
        self.claudeCloudSessions = try c.decodeIfPresent(Bool.self, forKey: .claudeCloudSessions)
        self.claudeConfigDirs = try c.decodeIfPresent([ClaudeConfigDir].self, forKey: .claudeConfigDirs)
        self.claudeSessionHook = try c.decodeIfPresent(Bool.self, forKey: .claudeSessionHook)
        self.codexStopHook = try c.decodeIfPresent(Bool.self, forKey: .codexStopHook)
        self.connectDetectedTools = try c.decodeIfPresent(Bool.self, forKey: .connectDetectedTools)
        self.contractorAccess = try c.decodeIfPresent(Bool.self, forKey: .contractorAccess)
        self.cursorDirectDelivery = try c.decodeIfPresent(Bool.self, forKey: .cursorDirectDelivery)
        self.detectedTools = try c.decodeIfPresent([String].self, forKey: .detectedTools)
        self.devinDirectDelivery = try c.decodeIfPresent(Bool.self, forKey: .devinDirectDelivery)
        self.directDelivery = try c.decodeIfPresent(Bool.self, forKey: .directDelivery)
        self.directDeliveryManaged = try c.decodeIfPresent(String.self, forKey: .directDeliveryManaged)
        self.grokLeader = try c.decodeIfPresent(Bool.self, forKey: .grokLeader)
        self.hermesAgent = try c.decodeIfPresent(Bool.self, forKey: .hermesAgent)
        self.historyRetentionDays = try c.decodeIfPresent(Int.self, forKey: .historyRetentionDays)
        self.mobileClaudeHandoff = try c.decodeIfPresent(Bool.self, forKey: .mobileClaudeHandoff)
        self.mobileClaudeHandoffSupported = try c.decodeIfPresent(Bool.self, forKey: .mobileClaudeHandoffSupported)
        self.mobileNativeContinuation = try c.decodeIfPresent(Bool.self, forKey: .mobileNativeContinuation)
        self.mobileNativeContinuationSupported = try c.decodeIfPresent(Bool.self, forKey: .mobileNativeContinuationSupported)
        self.openclawGateway = try c.decodeIfPresent(Bool.self, forKey: .openclawGateway)
        self.openclawUnlimitedVersion = try c.decodeIfPresent(String.self, forKey: .openclawUnlimitedVersion)
        self.opencodeAutoActivate = try c.decodeIfPresent(Bool.self, forKey: .opencodeAutoActivate)
        self.opencodePlugin = try c.decodeIfPresent(Bool.self, forKey: .opencodePlugin)
        self.piAutoActivate = try c.decodeIfPresent(Bool.self, forKey: .piAutoActivate)
        self.piExtension = try c.decodeIfPresent(Bool.self, forKey: .piExtension)
        self.showRelayMessages = try c.decodeIfPresent(Bool.self, forKey: .showRelayMessages)
        self.spawnAllowTeammates = try c.decodeIfPresent(Bool.self, forKey: .spawnAllowTeammates)
        self.spawnBillingClaude = try c.decodeIfPresent(String.self, forKey: .spawnBillingClaude)
        self.spawnBillingCodex = try c.decodeIfPresent(String.self, forKey: .spawnBillingCodex)
        self.spawnFullAccessClaude = try c.decodeIfPresent(Bool.self, forKey: .spawnFullAccessClaude)
        self.spawnFullAccessCodex = try c.decodeIfPresent(Bool.self, forKey: .spawnFullAccessCodex)
        self.spawnHarnesses = try c.decodeIfPresent([String: SpawnHarnessSettings].self, forKey: .spawnHarnesses)
        self.spawnMaxAgents = try c.decodeIfPresent(Int.self, forKey: .spawnMaxAgents)
        self.spawnNativeInput = try c.decodeIfPresent(Bool.self, forKey: .spawnNativeInput)
        self.spawnRepositories = try c.decodeIfPresent([String].self, forKey: .spawnRepositories)
        self.spawnRequesterApprovals = try c.decodeIfPresent(Bool.self, forKey: .spawnRequesterApprovals)
        self.teammateNativeInput = try c.decodeIfPresent(Bool.self, forKey: .teammateNativeInput)
        self.trustWorkspaceMembers = try c.decodeIfPresent(Bool.self, forKey: .trustWorkspaceMembers)
        self.trustedRelaySenders = try c.decodeIfPresent([String].self, forKey: .trustedRelaySenders)
        self.workspaceMembers = try c.decodeIfPresent([TrustedWorkspaceMember].self, forKey: .workspaceMembers)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.acceptSpawns, forKey: .acceptSpawns)
        try c.encodeIfPresent(self.agentChanges, forKey: .agentChanges)
        try c.encode(self.allowSelfRegistration, forKey: .allowSelfRegistration)
        try c.encodeIfPresent(self.analyticsEnabled, forKey: .analyticsEnabled)
        try c.encode(self.autoActivate, forKey: .autoActivate)
        try c.encodeIfPresent(self.autoJoinGeneral, forKey: .autoJoinGeneral)
        try c.encodeIfPresent(self.claudeCloudSessions, forKey: .claudeCloudSessions)
        try c.encodeIfPresent(self.claudeConfigDirs, forKey: .claudeConfigDirs)
        try c.encodeIfPresent(self.claudeSessionHook, forKey: .claudeSessionHook)
        try c.encodeIfPresent(self.codexStopHook, forKey: .codexStopHook)
        try c.encodeIfPresent(self.connectDetectedTools, forKey: .connectDetectedTools)
        try c.encodeIfPresent(self.contractorAccess, forKey: .contractorAccess)
        try c.encodeIfPresent(self.cursorDirectDelivery, forKey: .cursorDirectDelivery)
        try c.encodeIfPresent(self.detectedTools, forKey: .detectedTools)
        try c.encodeIfPresent(self.devinDirectDelivery, forKey: .devinDirectDelivery)
        try c.encodeIfPresent(self.directDelivery, forKey: .directDelivery)
        try c.encodeIfPresent(self.directDeliveryManaged, forKey: .directDeliveryManaged)
        try c.encodeIfPresent(self.grokLeader, forKey: .grokLeader)
        try c.encodeIfPresent(self.hermesAgent, forKey: .hermesAgent)
        try c.encodeIfPresent(self.historyRetentionDays, forKey: .historyRetentionDays)
        try c.encodeIfPresent(self.mobileClaudeHandoff, forKey: .mobileClaudeHandoff)
        try c.encodeIfPresent(self.mobileClaudeHandoffSupported, forKey: .mobileClaudeHandoffSupported)
        try c.encodeIfPresent(self.mobileNativeContinuation, forKey: .mobileNativeContinuation)
        try c.encodeIfPresent(self.mobileNativeContinuationSupported, forKey: .mobileNativeContinuationSupported)
        try c.encodeIfPresent(self.openclawGateway, forKey: .openclawGateway)
        try c.encodeIfPresent(self.openclawUnlimitedVersion, forKey: .openclawUnlimitedVersion)
        try c.encodeIfPresent(self.opencodeAutoActivate, forKey: .opencodeAutoActivate)
        try c.encodeIfPresent(self.opencodePlugin, forKey: .opencodePlugin)
        try c.encodeIfPresent(self.piAutoActivate, forKey: .piAutoActivate)
        try c.encodeIfPresent(self.piExtension, forKey: .piExtension)
        try c.encodeIfPresent(self.showRelayMessages, forKey: .showRelayMessages)
        try c.encodeIfPresent(self.spawnAllowTeammates, forKey: .spawnAllowTeammates)
        try c.encodeIfPresent(self.spawnBillingClaude, forKey: .spawnBillingClaude)
        try c.encodeIfPresent(self.spawnBillingCodex, forKey: .spawnBillingCodex)
        try c.encodeIfPresent(self.spawnFullAccessClaude, forKey: .spawnFullAccessClaude)
        try c.encodeIfPresent(self.spawnFullAccessCodex, forKey: .spawnFullAccessCodex)
        try c.encodeIfPresent(self.spawnHarnesses, forKey: .spawnHarnesses)
        try c.encodeIfPresent(self.spawnMaxAgents, forKey: .spawnMaxAgents)
        try c.encodeIfPresent(self.spawnNativeInput, forKey: .spawnNativeInput)
        try c.encodeIfPresent(self.spawnRepositories, forKey: .spawnRepositories)
        try c.encodeIfPresent(self.spawnRequesterApprovals, forKey: .spawnRequesterApprovals)
        try c.encodeIfPresent(self.teammateNativeInput, forKey: .teammateNativeInput)
        try c.encodeIfPresent(self.trustWorkspaceMembers, forKey: .trustWorkspaceMembers)
        try c.encodeIfPresent(self.trustedRelaySenders, forKey: .trustedRelaySenders)
        try c.encodeIfPresent(self.workspaceMembers, forKey: .workspaceMembers)
    }
}

/// The `shutdown` topic: the connection closes after it.
public struct ShutdownNotice: Codable, Equatable, Hashable, Sendable {
    public init() {
    }
}

/// `account.status`, `account.sign_in` and the `sign_in` topic: the account
/// plus the link waiting for the person, if any.
public struct SignInReport: Codable, Equatable, Hashable, Sendable {
    /// What the person can do about `error`.
    public let action: AccountAction?
    /// Last completed authentication check, milliseconds since the Unix epoch.
    public let authCheckedAt: Int64?
    public let authError: String?
    /// Live Cloud authentication and Relaycast verification, independently of uploader installation.
    public let authHealth: String?
    public let error: String?
    /// ISO-8601.
    public let expiresAt: String?
    /// Seconds between device-approval polls.
    public let interval: Int?
    /// Signed in, but this computer holds no Cloud session it may use: Cloud
    /// refused the kept one even after a refresh. Cloud calls answer
    /// `not_signed_in` until the person signs in again.
    public let needsSignIn: Bool?
    public let person: AccountPerson?
    /// What the attempt is doing: `checking_existing_login`,
    /// `reusing_existing_login`, `waiting_for_browser`,
    /// `waiting_for_device_approval`, `selecting_workspace`, `connecting_workspace`,
    /// `preparing_local_sessions`.
    public let phase: String?
    /// Local capture progress while sessions are prepared.
    public let progress: CaptureProgress?
    public let reusedLogin: Bool?
    public let siteUrl: String?
    public let state: SignInState
    public let userCode: String?
    public let verificationUrl: String?
    /// What the UI opens: the link with the code filled in.
    public let verificationUrlComplete: String?
    public let workspaceAvatarUrl: String?
    public let workspaceChoices: [WorkspaceChoice]?
    /// Distinct workspaces available to the signed-in person; absent on older Cloud versions.
    public let workspaceCount: Int?
    /// The Agent Relay (Cloud) workspace.
    public let workspaceId: String?
    public let workspaceName: String?

    public init(action: AccountAction? = nil, authCheckedAt: Int64? = nil, authError: String? = nil, authHealth: String? = nil, error: String? = nil, expiresAt: String? = nil, interval: Int? = nil, needsSignIn: Bool? = nil, person: AccountPerson? = nil, phase: String? = nil, progress: CaptureProgress? = nil, reusedLogin: Bool? = nil, siteUrl: String? = nil, state: SignInState, userCode: String? = nil, verificationUrl: String? = nil, verificationUrlComplete: String? = nil, workspaceAvatarUrl: String? = nil, workspaceChoices: [WorkspaceChoice]? = nil, workspaceCount: Int? = nil, workspaceId: String? = nil, workspaceName: String? = nil) {
        self.action = action
        self.authCheckedAt = authCheckedAt
        self.authError = authError
        self.authHealth = authHealth
        self.error = error
        self.expiresAt = expiresAt
        self.interval = interval
        self.needsSignIn = needsSignIn
        self.person = person
        self.phase = phase
        self.progress = progress
        self.reusedLogin = reusedLogin
        self.siteUrl = siteUrl
        self.state = state
        self.userCode = userCode
        self.verificationUrl = verificationUrl
        self.verificationUrlComplete = verificationUrlComplete
        self.workspaceAvatarUrl = workspaceAvatarUrl
        self.workspaceChoices = workspaceChoices
        self.workspaceCount = workspaceCount
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
    }

    enum CodingKeys: String, CodingKey {
        case action
        case authCheckedAt = "auth_checked_at"
        case authError = "auth_error"
        case authHealth = "auth_health"
        case error
        case expiresAt = "expires_at"
        case interval
        case needsSignIn = "needs_sign_in"
        case person
        case phase
        case progress
        case reusedLogin = "reused_login"
        case siteUrl = "site_url"
        case state
        case userCode = "user_code"
        case verificationUrl = "verification_url"
        case verificationUrlComplete = "verification_url_complete"
        case workspaceAvatarUrl = "workspace_avatar_url"
        case workspaceChoices = "workspace_choices"
        case workspaceCount = "workspace_count"
        case workspaceId = "workspace_id"
        case workspaceName = "workspace_name"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.action = try c.decodeIfPresent(AccountAction.self, forKey: .action)
        self.authCheckedAt = try c.decodeIfPresent(Int64.self, forKey: .authCheckedAt)
        self.authError = try c.decodeIfPresent(String.self, forKey: .authError)
        self.authHealth = try c.decodeIfPresent(String.self, forKey: .authHealth)
        self.error = try c.decodeIfPresent(String.self, forKey: .error)
        self.expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        self.interval = try c.decodeIfPresent(Int.self, forKey: .interval)
        self.needsSignIn = try c.decodeIfPresent(Bool.self, forKey: .needsSignIn)
        self.person = try c.decodeIfPresent(AccountPerson.self, forKey: .person)
        self.phase = try c.decodeIfPresent(String.self, forKey: .phase)
        self.progress = try c.decodeIfPresent(CaptureProgress.self, forKey: .progress)
        self.reusedLogin = try c.decodeIfPresent(Bool.self, forKey: .reusedLogin)
        self.siteUrl = try c.decodeIfPresent(String.self, forKey: .siteUrl)
        self.state = try c.decode(SignInState.self, forKey: .state)
        self.userCode = try c.decodeIfPresent(String.self, forKey: .userCode)
        self.verificationUrl = try c.decodeIfPresent(String.self, forKey: .verificationUrl)
        self.verificationUrlComplete = try c.decodeIfPresent(String.self, forKey: .verificationUrlComplete)
        self.workspaceAvatarUrl = try c.decodeIfPresent(String.self, forKey: .workspaceAvatarUrl)
        self.workspaceChoices = try c.decodeIfPresent([WorkspaceChoice].self, forKey: .workspaceChoices)
        self.workspaceCount = try c.decodeIfPresent(Int.self, forKey: .workspaceCount)
        self.workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        self.workspaceName = try c.decodeIfPresent(String.self, forKey: .workspaceName)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.action, forKey: .action)
        try c.encode(self.authCheckedAt, forKey: .authCheckedAt)
        try c.encode(self.authError, forKey: .authError)
        try c.encode(self.authHealth, forKey: .authHealth)
        try c.encode(self.error, forKey: .error)
        try c.encode(self.expiresAt, forKey: .expiresAt)
        try c.encode(self.interval, forKey: .interval)
        try c.encodeIfPresent(self.needsSignIn, forKey: .needsSignIn)
        try c.encode(self.person, forKey: .person)
        try c.encode(self.phase, forKey: .phase)
        try c.encode(self.progress, forKey: .progress)
        try c.encode(self.reusedLogin, forKey: .reusedLogin)
        try c.encode(self.siteUrl, forKey: .siteUrl)
        try c.encode(self.state, forKey: .state)
        try c.encode(self.userCode, forKey: .userCode)
        try c.encode(self.verificationUrl, forKey: .verificationUrl)
        try c.encode(self.verificationUrlComplete, forKey: .verificationUrlComplete)
        try c.encode(self.workspaceAvatarUrl, forKey: .workspaceAvatarUrl)
        try c.encode(self.workspaceChoices, forKey: .workspaceChoices)
        try c.encode(self.workspaceCount, forKey: .workspaceCount)
        try c.encode(self.workspaceId, forKey: .workspaceId)
        try c.encode(self.workspaceName, forKey: .workspaceName)
    }
}

/// Where the Agent Relay sign-in stands.
public enum SignInState: String, Codable, CaseIterable, Hashable, Sendable {
    case signedOut = "signed_out"
    case signedIn = "signed_in"
    /// Waiting for the person to approve in the browser.
    case pendingApproval = "pending_approval"
    /// Signed in to Cloud; connecting the workspace and preparing uploads.
    case preparing
    /// The person declined the device approval.
    case denied
    /// The approval (device or browser) ran out of time.
    case expired
    /// The last attempt failed; `error` says why.
    case error

    /// A value this build does not know reads as `error`.
    public init(from decoder: Decoder) throws {
        self = SignInState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .error
    }
}

/// The node's owner in Agent Relay, recorded from its token and the
/// signed-in person's session (`relay::spawn::claim`).
public struct SpawnClaim: Codable, Equatable, Hashable, Sendable {
    /// Why it is not claimed, when that is worth saying.
    public let note: String?
    public let state: SpawnClaimState

    public init(note: String? = nil, state: SpawnClaimState) {
        self.note = note
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case note
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.note = try c.decodeIfPresent(String.self, forKey: .note)
        self.state = try c.decode(SpawnClaimState.self, forKey: .state)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.note, forKey: .note)
        try c.encode(self.state, forKey: .state)
    }
}

public enum SpawnClaimState: String, Codable, CaseIterable, Hashable, Sendable {
    /// Not asked yet.
    case pending
    /// Recorded as the signed-in person's node.
    case claimed
    /// Another account owns it: the node takes no spawns until that owner,
    /// or a workspace owner, releases it.
    case ownedByOther = "owned_by_other"
    /// No Agent Relay sign-in to claim it with; asked again after a
    /// sign-in.
    case signedOut = "signed_out"
    /// Agent Relay did not record it; asked again after a backoff.
    case failed

    /// A value this build does not know reads as `pending`.
    public init(from decoder: Decoder) throws {
        self = SpawnClaimState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .pending
    }
}

public enum SpawnControlAction: String, Codable, CaseIterable, Hashable, Sendable {
    case spawn
    case release
}

public struct SpawnControlInvocation: Codable, Equatable, Hashable, Sendable {
    /// Set only from this core's same-workspace registration for this exact spawn invocation.
    public let agentId: String?
    /// A bounded machine code, never provider error text or arbitrary output.
    public let errorCode: String?
    public let id: String
    public let name: String?
    public let nodeId: String?
    public let ready: Bool
    public let spawned: Bool
    public let status: String
    public let taskUnconfirmed: Bool

    public init(agentId: String? = nil, errorCode: String? = nil, id: String, name: String? = nil, nodeId: String? = nil, ready: Bool, spawned: Bool, status: String, taskUnconfirmed: Bool) {
        self.agentId = agentId
        self.errorCode = errorCode
        self.id = id
        self.name = name
        self.nodeId = nodeId
        self.ready = ready
        self.spawned = spawned
        self.status = status
        self.taskUnconfirmed = taskUnconfirmed
    }

    enum CodingKeys: String, CodingKey {
        case agentId = "agent_id"
        case errorCode = "error_code"
        case id
        case name
        case nodeId = "node_id"
        case ready
        case spawned
        case status
        case taskUnconfirmed = "task_unconfirmed"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        self.errorCode = try c.decodeIfPresent(String.self, forKey: .errorCode)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decodeIfPresent(String.self, forKey: .name)
        self.nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId)
        self.ready = try c.decode(Bool.self, forKey: .ready)
        self.spawned = try c.decode(Bool.self, forKey: .spawned)
        self.status = try c.decode(String.self, forKey: .status)
        self.taskUnconfirmed = try c.decode(Bool.self, forKey: .taskUnconfirmed)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.agentId, forKey: .agentId)
        try c.encode(self.errorCode, forKey: .errorCode)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.nodeId, forKey: .nodeId)
        try c.encode(self.ready, forKey: .ready)
        try c.encode(self.spawned, forKey: .spawned)
        try c.encode(self.status, forKey: .status)
        try c.encode(self.taskUnconfirmed, forKey: .taskUnconfirmed)
    }
}

public struct SpawnControlTarget: Codable, Equatable, Hashable, Sendable {
    public let activeAgents: Int
    public let capabilities: [String]
    public let handlersLive: Bool
    public let id: String
    public let live: Bool
    public let maxAgents: Int
    public let name: String
    public let reservedAgents: Int
    public let stale: Bool

    public init(activeAgents: Int, capabilities: [String], handlersLive: Bool, id: String, live: Bool, maxAgents: Int, name: String, reservedAgents: Int, stale: Bool) {
        self.activeAgents = activeAgents
        self.capabilities = capabilities
        self.handlersLive = handlersLive
        self.id = id
        self.live = live
        self.maxAgents = maxAgents
        self.name = name
        self.reservedAgents = reservedAgents
        self.stale = stale
    }

    enum CodingKeys: String, CodingKey {
        case activeAgents = "active_agents"
        case capabilities
        case handlersLive = "handlers_live"
        case id
        case live
        case maxAgents = "max_agents"
        case name
        case reservedAgents = "reserved_agents"
        case stale
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.activeAgents = try c.decode(Int.self, forKey: .activeAgents)
        self.capabilities = try c.decode([String].self, forKey: .capabilities)
        self.handlersLive = try c.decode(Bool.self, forKey: .handlersLive)
        self.id = try c.decode(String.self, forKey: .id)
        self.live = try c.decode(Bool.self, forKey: .live)
        self.maxAgents = try c.decode(Int.self, forKey: .maxAgents)
        self.name = try c.decode(String.self, forKey: .name)
        self.reservedAgents = try c.decode(Int.self, forKey: .reservedAgents)
        self.stale = try c.decode(Bool.self, forKey: .stale)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.activeAgents, forKey: .activeAgents)
        try c.encode(self.capabilities, forKey: .capabilities)
        try c.encode(self.handlersLive, forKey: .handlersLive)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.live, forKey: .live)
        try c.encode(self.maxAgents, forKey: .maxAgents)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.reservedAgents, forKey: .reservedAgents)
        try c.encode(self.stale, forKey: .stale)
    }
}

/// One harness's spawn settings. In `settings.get`, each one the harness
/// offers; in a change, each one to change.
public struct SpawnHarnessSettings: Codable, Equatable, Hashable, Sendable {
    /// How it is paid for, as advertised to requesters: `unspecified`,
    /// `subscription` or `api`.
    public let billing: String?
    /// Runs without the harness's own confinement (its sandbox or
    /// permission prompts).
    public let fullAccess: Bool?

    public init(billing: String? = nil, fullAccess: Bool? = nil) {
        self.billing = billing
        self.fullAccess = fullAccess
    }

    enum CodingKeys: String, CodingKey {
        case billing
        case fullAccess = "full_access"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.billing = try c.decodeIfPresent(String.self, forKey: .billing)
        self.fullAccess = try c.decodeIfPresent(Bool.self, forKey: .fullAccess)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.billing, forKey: .billing)
        try c.encodeIfPresent(self.fullAccess, forKey: .fullAccess)
    }
}

public struct SpawnInvocationParams: Codable, Equatable, Hashable, Sendable {
    public let action: SpawnControlAction
    public let callerName: String
    public let invocationId: String

    public init(action: SpawnControlAction, callerName: String, invocationId: String) {
        self.action = action
        self.callerName = callerName
        self.invocationId = invocationId
    }

    enum CodingKeys: String, CodingKey {
        case action
        case callerName = "caller_name"
        case invocationId = "invocation_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.action = try c.decode(SpawnControlAction.self, forKey: .action)
        self.callerName = try c.decode(String.self, forKey: .callerName)
        self.invocationId = try c.decode(String.self, forKey: .invocationId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.action, forKey: .action)
        try c.encode(self.callerName, forKey: .callerName)
        try c.encode(self.invocationId, forKey: .invocationId)
    }
}

public struct SpawnInvokeParams: Codable, Equatable, Hashable, Sendable {
    public let callerName: String
    public let directory: String
    public let harness: String
    public let idempotencyKey: String
    public let name: String
    public let nodeId: String
    public let nodeName: String
    public let task: String

    public init(callerName: String, directory: String, harness: String, idempotencyKey: String, name: String, nodeId: String, nodeName: String, task: String) {
        self.callerName = callerName
        self.directory = directory
        self.harness = harness
        self.idempotencyKey = idempotencyKey
        self.name = name
        self.nodeId = nodeId
        self.nodeName = nodeName
        self.task = task
    }

    enum CodingKeys: String, CodingKey {
        case callerName = "caller_name"
        case directory
        case harness
        case idempotencyKey = "idempotency_key"
        case name
        case nodeId = "node_id"
        case nodeName = "node_name"
        case task
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.callerName = try c.decode(String.self, forKey: .callerName)
        self.directory = try c.decode(String.self, forKey: .directory)
        self.harness = try c.decode(String.self, forKey: .harness)
        self.idempotencyKey = try c.decode(String.self, forKey: .idempotencyKey)
        self.name = try c.decode(String.self, forKey: .name)
        self.nodeId = try c.decode(String.self, forKey: .nodeId)
        self.nodeName = try c.decode(String.self, forKey: .nodeName)
        self.task = try c.decode(String.self, forKey: .task)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.callerName, forKey: .callerName)
        try c.encode(self.directory, forKey: .directory)
        try c.encode(self.harness, forKey: .harness)
        try c.encode(self.idempotencyKey, forKey: .idempotencyKey)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.nodeId, forKey: .nodeId)
        try c.encode(self.nodeName, forKey: .nodeName)
        try c.encode(self.task, forKey: .task)
    }
}

public struct SpawnReleaseParams: Codable, Equatable, Hashable, Sendable {
    public let callerName: String
    public let expectedAgentId: String
    public let idempotencyKey: String
    public let name: String
    public let nodeId: String
    public let nodeName: String

    public init(callerName: String, expectedAgentId: String, idempotencyKey: String, name: String, nodeId: String, nodeName: String) {
        self.callerName = callerName
        self.expectedAgentId = expectedAgentId
        self.idempotencyKey = idempotencyKey
        self.name = name
        self.nodeId = nodeId
        self.nodeName = nodeName
    }

    enum CodingKeys: String, CodingKey {
        case callerName = "caller_name"
        case expectedAgentId = "expected_agent_id"
        case idempotencyKey = "idempotency_key"
        case name
        case nodeId = "node_id"
        case nodeName = "node_name"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.callerName = try c.decode(String.self, forKey: .callerName)
        self.expectedAgentId = try c.decode(String.self, forKey: .expectedAgentId)
        self.idempotencyKey = try c.decode(String.self, forKey: .idempotencyKey)
        self.name = try c.decode(String.self, forKey: .name)
        self.nodeId = try c.decode(String.self, forKey: .nodeId)
        self.nodeName = try c.decode(String.self, forKey: .nodeName)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.callerName, forKey: .callerName)
        try c.encode(self.expectedAgentId, forKey: .expectedAgentId)
        try c.encode(self.idempotencyKey, forKey: .idempotencyKey)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.nodeId, forKey: .nodeId)
        try c.encode(self.nodeName, forKey: .nodeName)
    }
}

/// The spawn node's places. A place is held from the spawn until the agent
/// is released or its session is seen to have ended; an idle agent keeps
/// its place.
public struct SpawnSlots: Codable, Equatable, Hashable, Sendable {
    /// Places held by spawned agents, idle ones included.
    public let held: Int
    /// The most spawned agents this computer runs at once; 0 means no limit.
    public let max: Int
    /// Spawns starting now.
    public let reserved: Int

    public init(held: Int, max: Int, reserved: Int) {
        self.held = held
        self.max = max
        self.reserved = reserved
    }

    enum CodingKeys: String, CodingKey {
        case held
        case max
        case reserved
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.held = try c.decode(Int.self, forKey: .held)
        self.max = try c.decode(Int.self, forKey: .max)
        self.reserved = try c.decode(Int.self, forKey: .reserved)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.held, forKey: .held)
        try c.encode(self.max, forKey: .max)
        try c.encode(self.reserved, forKey: .reserved)
    }
}

/// Where this computer's spawn node stands.
public enum SpawnState: String, Codable, CaseIterable, Hashable, Sendable {
    case connecting
    /// Spawning is turned off, or this computer cannot spawn.
    case off
    /// Agent Relay offers this computer as a spawn target.
    case live
    /// Disconnected; trying again.
    case waiting

    /// A value this build does not know reads as `off`.
    public init(from decoder: Decoder) throws {
        self = SpawnState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .off
    }
}

/// This computer's spawn node.
public struct SpawnStatus: Codable, Equatable, Hashable, Sendable {
    /// Whether Agent Relay records the node as the signed-in person's.
    /// Absent in older cores and while spawning is off.
    public let claim: SpawnClaim?
    /// Why it is not live.
    public let error: String?
    /// Every harness this core knows, in order: what Settings shows for
    /// each one it offers (`harnesses`). Absent in older cores.
    public let harnessDescriptors: [HarnessDescriptor]?
    /// The harnesses it offers, such as `codex` and `claude`.
    public let harnesses: [String]
    /// The name Agent Relay lists as the spawn target; spawned agents are
    /// addressed `name@<node name>`.
    public let nodeName: String?
    /// Agent Relay refused to enroll this computer because the plan's
    /// device cap is reached; `error` says so in words. Absent otherwise.
    public let planLimit: PlanLimitExceeded?
    /// How many spawned agents it takes and how many places are taken.
    /// Absent in older cores and while spawning is off.
    public let slots: SpawnSlots?
    public let state: SpawnState

    public init(claim: SpawnClaim? = nil, error: String? = nil, harnessDescriptors: [HarnessDescriptor]? = nil, harnesses: [String], nodeName: String? = nil, planLimit: PlanLimitExceeded? = nil, slots: SpawnSlots? = nil, state: SpawnState) {
        self.claim = claim
        self.error = error
        self.harnessDescriptors = harnessDescriptors
        self.harnesses = harnesses
        self.nodeName = nodeName
        self.planLimit = planLimit
        self.slots = slots
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case claim
        case error
        case harnessDescriptors = "harness_descriptors"
        case harnesses
        case nodeName = "node_name"
        case planLimit = "plan_limit"
        case slots
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.claim = try c.decodeIfPresent(SpawnClaim.self, forKey: .claim)
        self.error = try c.decodeIfPresent(String.self, forKey: .error)
        self.harnessDescriptors = try c.decodeIfPresent([HarnessDescriptor].self, forKey: .harnessDescriptors)
        self.harnesses = try c.decode([String].self, forKey: .harnesses)
        self.nodeName = try c.decodeIfPresent(String.self, forKey: .nodeName)
        self.planLimit = try c.decodeIfPresent(PlanLimitExceeded.self, forKey: .planLimit)
        self.slots = try c.decodeIfPresent(SpawnSlots.self, forKey: .slots)
        self.state = try c.decode(SpawnState.self, forKey: .state)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.claim, forKey: .claim)
        try c.encode(self.error, forKey: .error)
        try c.encodeIfPresent(self.harnessDescriptors, forKey: .harnessDescriptors)
        try c.encode(self.harnesses, forKey: .harnesses)
        try c.encode(self.nodeName, forKey: .nodeName)
        try c.encodeIfPresent(self.planLimit, forKey: .planLimit)
        try c.encodeIfPresent(self.slots, forKey: .slots)
        try c.encode(self.state, forKey: .state)
    }
}

public struct SpawnTargets: Codable, Equatable, Hashable, Sendable {
    public let targets: [SpawnControlTarget]

    public init(targets: [SpawnControlTarget]) {
        self.targets = targets
    }

    enum CodingKeys: String, CodingKey {
        case targets
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.targets = try c.decode([SpawnControlTarget].self, forKey: .targets)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.targets, forKey: .targets)
    }
}

/// The lifecycle of an agent this computer spawned. Each piece of evidence
/// is timestamped and reads `unknown` once it is too old.
public struct SpawnedAgentState: Codable, Equatable, Hashable, Sendable {
    /// `codex` or `claude`.
    public let harness: String
    /// It holds one of the node's places.
    public let holdsSlot: Bool
    public let node: NodeEvidence
    public let process: ProcessEvidence
    /// Set once its session ended without being released.
    public let unfinished: UnfinishedWork?
    public let work: WorkEvidence

    public init(harness: String, holdsSlot: Bool, node: NodeEvidence, process: ProcessEvidence, unfinished: UnfinishedWork? = nil, work: WorkEvidence) {
        self.harness = harness
        self.holdsSlot = holdsSlot
        self.node = node
        self.process = process
        self.unfinished = unfinished
        self.work = work
    }

    enum CodingKeys: String, CodingKey {
        case harness
        case holdsSlot = "holds_slot"
        case node
        case process
        case unfinished
        case work
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.harness = try c.decode(String.self, forKey: .harness)
        self.holdsSlot = try c.decode(Bool.self, forKey: .holdsSlot)
        self.node = try c.decode(NodeEvidence.self, forKey: .node)
        self.process = try c.decode(ProcessEvidence.self, forKey: .process)
        self.unfinished = try c.decodeIfPresent(UnfinishedWork.self, forKey: .unfinished)
        self.work = try c.decode(WorkEvidence.self, forKey: .work)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.harness, forKey: .harness)
        try c.encode(self.holdsSlot, forKey: .holdsSlot)
        try c.encode(self.node, forKey: .node)
        try c.encode(self.process, forKey: .process)
        try c.encode(self.unfinished, forKey: .unfinished)
        try c.encode(self.work, forKey: .work)
    }
}

/// The one snapshot the UI renders: `status.get`, `subscribe`, and the
/// `status` topic.
public struct Status: Codable, Equatable, Hashable, Sendable {
    /// The Agent Relay sign-in and the uploader's connection.
    public let account: AccountStatus
    public let agents: AgentsStatus
    public let daemon: DaemonInfo
    public let machine: MachineInfo
    /// Push channel per registered agent name.
    public let push: [String: PushState]
    public let revision: Int
    /// This computer's spawn node: whether Agent Relay can start agents
    /// here. Absent in older cores.
    public let spawn: SpawnStatus?
    public let workspace: WorkspaceStatus

    public init(account: AccountStatus, agents: AgentsStatus, daemon: DaemonInfo, machine: MachineInfo, push: [String: PushState], revision: Int, spawn: SpawnStatus? = nil, workspace: WorkspaceStatus) {
        self.account = account
        self.agents = agents
        self.daemon = daemon
        self.machine = machine
        self.push = push
        self.revision = revision
        self.spawn = spawn
        self.workspace = workspace
    }

    enum CodingKeys: String, CodingKey {
        case account
        case agents
        case daemon
        case machine
        case push
        case revision
        case spawn
        case workspace
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.account = try c.decode(AccountStatus.self, forKey: .account)
        self.agents = try c.decode(AgentsStatus.self, forKey: .agents)
        self.daemon = try c.decode(DaemonInfo.self, forKey: .daemon)
        self.machine = try c.decode(MachineInfo.self, forKey: .machine)
        self.push = try c.decode([String: PushState].self, forKey: .push)
        self.revision = try c.decode(Int.self, forKey: .revision)
        self.spawn = try c.decodeIfPresent(SpawnStatus.self, forKey: .spawn)
        self.workspace = try c.decode(WorkspaceStatus.self, forKey: .workspace)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.account, forKey: .account)
        try c.encode(self.agents, forKey: .agents)
        try c.encode(self.daemon, forKey: .daemon)
        try c.encode(self.machine, forKey: .machine)
        try c.encode(self.push, forKey: .push)
        try c.encode(self.revision, forKey: .revision)
        try c.encodeIfPresent(self.spawn, forKey: .spawn)
        try c.encode(self.workspace, forKey: .workspace)
    }
}

public struct Stopping: Codable, Equatable, Hashable, Sendable {
    public let stopping: Bool

    public init(stopping: Bool) {
        self.stopping = stopping
    }

    enum CodingKeys: String, CodingKey {
        case stopping
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.stopping = try c.decode(Bool.self, forKey: .stopping)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.stopping, forKey: .stopping)
    }
}

public struct Subscribed: Codable, Equatable, Hashable, Sendable {
    /// The snapshot to render now; later `status` events carry a higher
    /// revision.
    public let status: Status
    /// Every topic the connection is now subscribed to.
    public let topics: [Topic]

    public init(status: Status, topics: [Topic]) {
        self.status = status
        self.topics = topics
    }

    enum CodingKeys: String, CodingKey {
        case status
        case topics
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.status = try c.decode(Status.self, forKey: .status)
        self.topics = try c.decode([Topic].self, forKey: .topics)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.status, forKey: .status)
        try c.encode(self.topics, forKey: .topics)
    }
}

/// `agents.take_over`'s parameters.
public struct TakeOverParams: Codable, Equatable, Hashable, Sendable {
    /// Stop it now, in the middle of a turn if one runs; without it the core
    /// waits for the turn to end first. A second call with `interrupt` while
    /// one waits makes that one stop it at once.
    public let interrupt: Bool
    public let name: String

    public init(interrupt: Bool = false, name: String) {
        self.interrupt = interrupt
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case interrupt
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.interrupt = try c.decodeIfPresent(Bool.self, forKey: .interrupt) ?? false
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.interrupt, forKey: .interrupt)
        try c.encode(self.name, forKey: .name)
    }
}

/// `agents.take_over`'s result: its headless process has stopped, and its
/// session is the person's to resume.
public struct TakenOver: Codable, Equatable, Hashable, Sendable {
    /// The folder the session ran in, to resume it there; `None` when it is
    /// not known.
    public let directory: String?
    /// A turn was running and was interrupted.
    public let interrupted: Bool
    public let name: String
    /// Its session, which resuming continues under the same id.
    public let target: Target

    public init(directory: String? = nil, interrupted: Bool, name: String, target: Target) {
        self.directory = directory
        self.interrupted = interrupted
        self.name = name
        self.target = target
    }

    enum CodingKeys: String, CodingKey {
        case directory
        case interrupted
        case name
        case target
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.directory = try c.decodeIfPresent(String.self, forKey: .directory)
        self.interrupted = try c.decode(Bool.self, forKey: .interrupted)
        self.name = try c.decode(String.self, forKey: .name)
        self.target = try c.decode(Target.self, forKey: .target)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.directory, forKey: .directory)
        try c.encode(self.interrupted, forKey: .interrupted)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.target, forKey: .target)
    }
}

/// One local session a message can be injected into. `id` is the session's
/// own id, never a title, so a message cannot land in whichever session
/// happens to share a name.
public struct Target: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let kind: SessionKind

    public init(id: String, kind: SessionKind) {
        self.id = id
        self.kind = kind
    }

    enum CodingKeys: String, CodingKey {
        case id
        case kind
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.kind = try c.decode(SessionKind.self, forKey: .kind)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.kind, forKey: .kind)
    }
}

public struct TestMessageParams: Codable, Equatable, Hashable, Sendable {
    public let name: String
    public let text: String?

    public init(name: String, text: String? = nil) {
        self.name = name
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case name
        case text
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.text = try c.decodeIfPresent(String.self, forKey: .text)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.name, forKey: .name)
        try c.encodeIfPresent(self.text, forKey: .text)
    }
}

public struct TestMessageSent: Codable, Equatable, Hashable, Sendable {
    public let messageId: String?

    public init(messageId: String? = nil) {
        self.messageId = messageId
    }

    enum CodingKeys: String, CodingKey {
        case messageId = "message_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.messageId, forKey: .messageId)
    }
}

/// Event topics a client subscribes to; `contract::EVENTS` gives each its
/// payload.
public enum Topic: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    /// The full status snapshot, sent on subscribe and after every change.
    case status
    /// Append-only activity lines for the UI's log.
    case activity
    /// The daemon is stopping; the connection closes after this event.
    case shutdown
    /// A collection changed: `{"what": "agents"|"roster"|…}`; re-fetch it.
    case invalidated
    /// A notification for the UI to show: `{"title","body","link"}`.
    case notify
    /// Sign-in progress: the account state, and the link to open.
    case signIn
    /// A value this build does not know, as the core sent it.
    case unknown(String)

    public static let allCases: [Topic] = [.status, .activity, .shutdown, .invalidated, .notify, .signIn]

    public init(rawValue: String) {
        switch rawValue {
        case "status": self = .status
        case "activity": self = .activity
        case "shutdown": self = .shutdown
        case "invalidated": self = .invalidated
        case "notify": self = .notify
        case "sign_in": self = .signIn
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .status: return "status"
        case .activity: return "activity"
        case .shutdown: return "shutdown"
        case .invalidated: return "invalidated"
        case .notify: return "notify"
        case .signIn: return "sign_in"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

public struct TopicsParams: Codable, Equatable, Hashable, Sendable {
    public let topics: [Topic]

    public init(topics: [Topic]) {
        self.topics = topics
    }

    enum CodingKeys: String, CodingKey {
        case topics
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.topics = try c.decode([Topic].self, forKey: .topics)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.topics, forKey: .topics)
    }
}

/// A person in the workspace trusted like the person (`workspace_members`).
public struct TrustedWorkspaceMember: Codable, Equatable, Hashable, Sendable {
    /// Their name in Agent Relay, when it differs.
    public let displayName: String?
    /// Their person identity's relay name.
    public let name: String

    public init(displayName: String? = nil, name: String) {
        self.displayName = displayName
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.displayName, forKey: .displayName)
        try c.encode(self.name, forKey: .name)
    }
}

/// What a spawned agent left undone when its session ended.
public struct UnfinishedWork: Codable, Equatable, Hashable, Sendable {
    /// When its session was seen to have ended (ISO-8601).
    public let endedAt: String
    /// Messages to it Agent Relay has not seen it take; absent until
    /// counted, or when they could not be.
    public let pendingDeliveries: Int?
    /// A turn was running when it ended.
    public let turnInProgress: Bool

    public init(endedAt: String, pendingDeliveries: Int? = nil, turnInProgress: Bool) {
        self.endedAt = endedAt
        self.pendingDeliveries = pendingDeliveries
        self.turnInProgress = turnInProgress
    }

    enum CodingKeys: String, CodingKey {
        case endedAt = "ended_at"
        case pendingDeliveries = "pending_deliveries"
        case turnInProgress = "turn_in_progress"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.endedAt = try c.decode(String.self, forKey: .endedAt)
        self.pendingDeliveries = try c.decodeIfPresent(Int.self, forKey: .pendingDeliveries)
        self.turnInProgress = try c.decode(Bool.self, forKey: .turnInProgress)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.endedAt, forKey: .endedAt)
        try c.encode(self.pendingDeliveries, forKey: .pendingDeliveries)
        try c.encode(self.turnInProgress, forKey: .turnInProgress)
    }
}

public struct Unsubscribed: Codable, Equatable, Hashable, Sendable {
    /// The topics that remain subscribed.
    public let topics: [Topic]

    public init(topics: [Topic]) {
        self.topics = topics
    }

    enum CodingKeys: String, CodingKey {
        case topics
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.topics = try c.decode([Topic].self, forKey: .topics)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.topics, forKey: .topics)
    }
}

/// What Relaycast said about the discovered key.
public enum Verification: String, Codable, CaseIterable, Hashable, Sendable {
    case verified
    /// Not asked yet.
    case pending
    /// Relaycast refused the key.
    case rejected
    /// Relaycast could not be reached; retried on the next refresh.
    case unreachable

    /// A value this build does not know reads as `pending`.
    public init(from decoder: Decoder) throws {
        self = Verification(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .pending
    }
}

/// A spawned agent's harness work state, as of `at`.
public struct WorkEvidence: Codable, Equatable, Hashable, Sendable {
    public let at: String?
    public let state: WorkState

    public init(at: String? = nil, state: WorkState) {
        self.at = at
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case at
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.at = try c.decodeIfPresent(String.self, forKey: .at)
        self.state = try c.decode(WorkState.self, forKey: .state)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.at, forKey: .at)
        try c.encode(self.state, forKey: .state)
    }
}

/// What a spawned agent's harness is doing.
public enum WorkState: String, Codable, CaseIterable, Hashable, Sendable {
    case unknown
    /// A turn is running.
    case working
    /// No turn is running; ready for a message.
    case idle
    /// Blocked on something other than a message, such as a permission.
    case waiting
    /// Finished and ended on its own.
    case completed

    /// A value this build does not know reads as `unknown`.
    public init(from decoder: Decoder) throws {
        self = WorkState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// One worker row of `fleet.list`.
public struct WorkerRow: Codable, Equatable, Hashable, Sendable {
    public let channels: [String]
    /// What `fleet.release` must send back; `null` cannot be released.
    public let generation: String?
    /// `<node>|<name>`: stable across listings, so a restart is not a rename.
    public let id: String
    /// When the worker last acted, epoch milliseconds.
    public let lastActivityMs: Int64?
    public let model: String?
    public let name: String
    public let pendingMessages: Int?
    /// The provider key (`codex`, `claude`, `devin`, …).
    public let provider: String
    public let providerLabel: String
    public let runtimeKind: String?
    public let sessionId: String?
    public let state: WorkerState
    /// The local session the worker owns, which is not offered as an
    /// injectable agent.
    public let target: Target?

    public init(channels: [String], generation: String? = nil, id: String, lastActivityMs: Int64? = nil, model: String? = nil, name: String, pendingMessages: Int? = nil, provider: String, providerLabel: String, runtimeKind: String? = nil, sessionId: String? = nil, state: WorkerState, target: Target? = nil) {
        self.channels = channels
        self.generation = generation
        self.id = id
        self.lastActivityMs = lastActivityMs
        self.model = model
        self.name = name
        self.pendingMessages = pendingMessages
        self.provider = provider
        self.providerLabel = providerLabel
        self.runtimeKind = runtimeKind
        self.sessionId = sessionId
        self.state = state
        self.target = target
    }

    enum CodingKeys: String, CodingKey {
        case channels
        case generation
        case id
        case lastActivityMs = "last_activity_ms"
        case model
        case name
        case pendingMessages = "pending_messages"
        case provider
        case providerLabel = "provider_label"
        case runtimeKind = "runtime_kind"
        case sessionId = "session_id"
        case state
        case target
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.channels = try c.decode([String].self, forKey: .channels)
        self.generation = try c.decodeIfPresent(String.self, forKey: .generation)
        self.id = try c.decode(String.self, forKey: .id)
        self.lastActivityMs = try c.decodeIfPresent(Int64.self, forKey: .lastActivityMs)
        self.model = try c.decodeIfPresent(String.self, forKey: .model)
        self.name = try c.decode(String.self, forKey: .name)
        self.pendingMessages = try c.decodeIfPresent(Int.self, forKey: .pendingMessages)
        self.provider = try c.decode(String.self, forKey: .provider)
        self.providerLabel = try c.decode(String.self, forKey: .providerLabel)
        self.runtimeKind = try c.decodeIfPresent(String.self, forKey: .runtimeKind)
        self.sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        self.state = try c.decode(WorkerState.self, forKey: .state)
        self.target = try c.decodeIfPresent(Target.self, forKey: .target)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.channels, forKey: .channels)
        try c.encode(self.generation, forKey: .generation)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.lastActivityMs, forKey: .lastActivityMs)
        try c.encode(self.model, forKey: .model)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.pendingMessages, forKey: .pendingMessages)
        try c.encode(self.provider, forKey: .provider)
        try c.encode(self.providerLabel, forKey: .providerLabel)
        try c.encode(self.runtimeKind, forKey: .runtimeKind)
        try c.encode(self.sessionId, forKey: .sessionId)
        try c.encode(self.state, forKey: .state)
        try c.encode(self.target, forKey: .target)
    }
}

/// What a worker is doing, as the broker last saw it.
public enum WorkerState: String, Codable, CaseIterable, Hashable, Sendable {
    case working
    case idle
    /// Spawned, not yet seen ready.
    case starting
    /// `blocked_on_send`: alive and held up mid-turn.
    case waiting
    /// The broker did not say; the worker still lists.
    case unknown

    /// A value this build does not know reads as `unknown`.
    public init(from decoder: Decoder) throws {
        self = WorkerState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// A workspace the authenticated person can choose before setup begins.
public struct WorkspaceChoice: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let organizationName: String?

    public init(id: String, name: String, organizationName: String? = nil) {
        self.id = id
        self.name = name
        self.organizationName = organizationName
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case organizationName = "organization_name"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.organizationName = try c.decodeIfPresent(String.self, forKey: .organizationName)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.id, forKey: .id)
        try c.encode(self.name, forKey: .name)
        try c.encode(self.organizationName, forKey: .organizationName)
    }
}

/// A workspace member, as `people.list` reports them.
public struct WorkspacePerson: Codable, Equatable, Hashable, Sendable {
    public let avatarUrl: String?
    public let identityHash: String
    /// The signed-in person.
    public let isSelf: Bool
    public let name: String

    public init(avatarUrl: String? = nil, identityHash: String, isSelf: Bool, name: String) {
        self.avatarUrl = avatarUrl
        self.identityHash = identityHash
        self.isSelf = isSelf
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case avatarUrl = "avatar_url"
        case identityHash = "identity_hash"
        case isSelf = "is_self"
        case name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        self.identityHash = try c.decode(String.self, forKey: .identityHash)
        self.isSelf = try c.decode(Bool.self, forKey: .isSelf)
        self.name = try c.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.avatarUrl, forKey: .avatarUrl)
        try c.encode(self.identityHash, forKey: .identityHash)
        try c.encode(self.isSelf, forKey: .isSelf)
        try c.encode(self.name, forKey: .name)
    }
}

/// The plan Cloud reports for the account's workspace.
public struct WorkspacePlan: Codable, Equatable, Hashable, Sendable {
    /// `intro`, `pro` or `enterprise`.
    public let key: String
    public let limits: PlanLimits
    /// The plan's display name (`Intro`).
    public let name: String
    /// Where to change the plan; absent when Cloud sent none.
    public let upgradeUrl: String?

    public init(key: String, limits: PlanLimits, name: String, upgradeUrl: String? = nil) {
        self.key = key
        self.limits = limits
        self.name = name
        self.upgradeUrl = upgradeUrl
    }

    enum CodingKeys: String, CodingKey {
        case key
        case limits
        case name
        case upgradeUrl = "upgrade_url"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.key = try c.decode(String.self, forKey: .key)
        self.limits = try c.decode(PlanLimits.self, forKey: .limits)
        self.name = try c.decode(String.self, forKey: .name)
        self.upgradeUrl = try c.decodeIfPresent(String.self, forKey: .upgradeUrl)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.key, forKey: .key)
        try c.encode(self.limits, forKey: .limits)
        try c.encode(self.name, forKey: .name)
        try c.encodeIfPresent(self.upgradeUrl, forKey: .upgradeUrl)
    }
}

/// Whether a workspace key was found.
public enum WorkspaceState: String, Codable, CaseIterable, Hashable, Sendable {
    case missing
    case found

    /// A value this build does not know reads as `missing`.
    public init(from decoder: Decoder) throws {
        self = WorkspaceState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .missing
    }
}

/// The workspace as discovered, without its key.
public struct WorkspaceStatus: Codable, Equatable, Hashable, Sendable {
    public let baseUrl: String?
    public let checkedAtMs: Int64?
    /// The Agent Relay plan Cloud reports for the account's workspace, with
    /// its caps; absent until read, and when the organization has no plan.
    public let plan: WorkspacePlan?
    /// `missing` (no key found) or `found`.
    public let state: WorkspaceState
    /// How much of the plan is used, as far as this core has read.
    public let usage: WorkspaceUsage?
    public let verification: Verification
    public let workspaceId: String?
    public let workspaceName: String?
    /// The workspace's Relaycast plan (`free`, `pro`, `enterprise`,
    /// `selfhost`), once verification read it.
    public let workspacePlan: String?

    public init(baseUrl: String? = nil, checkedAtMs: Int64? = nil, plan: WorkspacePlan? = nil, state: WorkspaceState, usage: WorkspaceUsage? = nil, verification: Verification, workspaceId: String? = nil, workspaceName: String? = nil, workspacePlan: String? = nil) {
        self.baseUrl = baseUrl
        self.checkedAtMs = checkedAtMs
        self.plan = plan
        self.state = state
        self.usage = usage
        self.verification = verification
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.workspacePlan = workspacePlan
    }

    enum CodingKeys: String, CodingKey {
        case baseUrl = "base_url"
        case checkedAtMs = "checked_at_ms"
        case plan
        case state
        case usage
        case verification
        case workspaceId = "workspace_id"
        case workspaceName = "workspace_name"
        case workspacePlan = "workspace_plan"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.baseUrl = try c.decodeIfPresent(String.self, forKey: .baseUrl)
        self.checkedAtMs = try c.decodeIfPresent(Int64.self, forKey: .checkedAtMs)
        self.plan = try c.decodeIfPresent(WorkspacePlan.self, forKey: .plan)
        self.state = try c.decode(WorkspaceState.self, forKey: .state)
        self.usage = try c.decodeIfPresent(WorkspaceUsage.self, forKey: .usage)
        self.verification = try c.decode(Verification.self, forKey: .verification)
        self.workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        self.workspaceName = try c.decodeIfPresent(String.self, forKey: .workspaceName)
        self.workspacePlan = try c.decodeIfPresent(String.self, forKey: .workspacePlan)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.baseUrl, forKey: .baseUrl)
        try c.encode(self.checkedAtMs, forKey: .checkedAtMs)
        try c.encodeIfPresent(self.plan, forKey: .plan)
        try c.encode(self.state, forKey: .state)
        try c.encodeIfPresent(self.usage, forKey: .usage)
        try c.encode(self.verification, forKey: .verification)
        try c.encode(self.workspaceId, forKey: .workspaceId)
        try c.encode(self.workspaceName, forKey: .workspaceName)
        try c.encode(self.workspacePlan, forKey: .workspacePlan)
    }
}

/// How much of the plan the workspace uses, as far as this core has read:
/// agents from the full roster, humans from the member list. Absent
/// counters were not read yet.
public struct WorkspaceUsage: Codable, Equatable, Hashable, Sendable {
    public let agents: Int?
    public let humans: Int?

    public init(agents: Int? = nil, humans: Int? = nil) {
        self.agents = agents
        self.humans = humans
    }

    enum CodingKeys: String, CodingKey {
        case agents
        case humans
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.agents = try c.decodeIfPresent(Int.self, forKey: .agents)
        self.humans = try c.decodeIfPresent(Int.self, forKey: .humans)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.agents, forKey: .agents)
        try c.encodeIfPresent(self.humans, forKey: .humans)
    }
}

/// One event the core published, by topic.
public enum CoreEvent: Sendable {
    case status(Status)
    case activity(ActivityLine)
    case shutdown(ShutdownNotice)
    case invalidated(Invalidation)
    case notify(CoreNotification)
    case signIn(SignInReport)

    /// The event `topic` carries, or nil for a topic or payload this build
    /// does not read.
    public static func decode(topic: String, data: Data) -> CoreEvent? {
        let decoder = JSONDecoder()
        switch Topic(rawValue: topic) {
        case .status: return (try? decoder.decode(Status.self, from: data)).map(CoreEvent.status)
        case .activity: return (try? decoder.decode(ActivityLine.self, from: data)).map(CoreEvent.activity)
        case .shutdown: return (try? decoder.decode(ShutdownNotice.self, from: data)).map(CoreEvent.shutdown)
        case .invalidated: return (try? decoder.decode(Invalidation.self, from: data)).map(CoreEvent.invalidated)
        case .notify: return (try? decoder.decode(CoreNotification.self, from: data)).map(CoreEvent.notify)
        case .signIn: return (try? decoder.decode(SignInReport.self, from: data)).map(CoreEvent.signIn)
        case .unknown: return nil
        }
    }
}

/// One typed call per method a pooled connection answers.
extension CoreClient {
    /// `diagnostics.requests`.
    @discardableResult
    public func diagnosticsRequests() async throws -> RequestLog {
        try await call(CoreMethod.diagnosticsRequests, NoParams())
    }

    /// `status.get`.
    @discardableResult
    public func statusGet() async throws -> Status {
        try await call(CoreMethod.statusGet, NoParams())
    }

    /// `workspace.refresh`.
    @discardableResult
    public func workspaceRefresh() async throws -> WorkspaceStatus {
        try await call(CoreMethod.workspaceRefresh, NoParams())
    }

    /// `workspace.verify`.
    @discardableResult
    public func workspaceVerify() async throws -> WorkspaceStatus {
        try await call(CoreMethod.workspaceVerify, NoParams())
    }

    /// `sessions.list`.
    @discardableResult
    public func sessionsList() async throws -> LocalSessions {
        try await call(CoreMethod.sessionsList, NoParams())
    }

    /// `sessions.title.capability`.
    @discardableResult
    public func sessionsTitleCapability(_ params: SessionTitleIdentity) async throws -> SessionTitleCapability {
        try await call(CoreMethod.sessionsTitleCapability, params)
    }

    /// `sessions.title.set`.
    @discardableResult
    public func sessionsTitleSet(_ params: SessionTitleSetParams) async throws -> SessionTitleUpdated {
        try await call(CoreMethod.sessionsTitleSet, params)
    }

    /// `sessions.managed.launch`.
    @discardableResult
    public func sessionsManagedLaunch(_ params: ManagedLaunchParams) async throws -> ManagedSessionStarted {
        try await call(CoreMethod.sessionsManagedLaunch, params)
    }

    /// `sessions.existing.register`.
    @discardableResult
    public func sessionsExistingRegister(_ params: ExistingRegisterParams) async throws -> ManagedSessionStarted {
        try await call(CoreMethod.sessionsExistingRegister, params)
    }

    /// `spawn.targets`.
    @discardableResult
    public func spawnTargets() async throws -> SpawnTargets {
        try await call(CoreMethod.spawnTargets, NoParams())
    }

    /// `spawn.invoke`.
    @discardableResult
    public func spawnInvoke(_ params: SpawnInvokeParams) async throws -> SpawnControlInvocation {
        try await call(CoreMethod.spawnInvoke, params)
    }

    /// `spawn.status`.
    @discardableResult
    public func spawnStatus(_ params: SpawnInvocationParams) async throws -> SpawnControlInvocation {
        try await call(CoreMethod.spawnStatus, params)
    }

    /// `spawn.release`.
    @discardableResult
    public func spawnRelease(_ params: SpawnReleaseParams) async throws -> SpawnControlInvocation {
        try await call(CoreMethod.spawnRelease, params)
    }

    /// `spawn.claim.retry`.
    @discardableResult
    public func spawnClaimRetry() async throws -> Done {
        try await call(CoreMethod.spawnClaimRetry, NoParams())
    }

    /// `agents.list`.
    @discardableResult
    public func agentsList() async throws -> Agents {
        try await call(CoreMethod.agentsList, NoParams())
    }

    /// `agents.register`.
    @discardableResult
    public func agentsRegister(_ params: RegisterParams) async throws -> Registered {
        try await call(CoreMethod.agentsRegister, params)
    }

    /// `agents.unregister`.
    @discardableResult
    public func agentsUnregister(_ params: NameParams) async throws -> Done {
        try await call(CoreMethod.agentsUnregister, params)
    }

    /// `agents.end`.
    @discardableResult
    public func agentsEnd(_ params: NameParams) async throws -> Done {
        try await call(CoreMethod.agentsEnd, params)
    }

    /// `agents.rename`.
    @discardableResult
    public func agentsRename(_ params: RenameParams) async throws -> Renamed {
        try await call(CoreMethod.agentsRename, params)
    }

    /// `agents.test_message`.
    @discardableResult
    public func agentsTestMessage(_ params: TestMessageParams) async throws -> TestMessageSent {
        try await call(CoreMethod.agentsTestMessage, params)
    }

    /// `agents.reply_setting`.
    @discardableResult
    public func agentsReplySetting(_ params: ReplySettingParams) async throws -> Done {
        try await call(CoreMethod.agentsReplySetting, params)
    }

    /// `agents.transcript`.
    @discardableResult
    public func agentsTranscript(_ params: AgentTranscriptParams) async throws -> LocalTranscriptPage {
        try await call(CoreMethod.agentsTranscript, params)
    }

    /// `agents.take_over`.
    @discardableResult
    public func agentsTakeOver(_ params: TakeOverParams) async throws -> TakenOver {
        try await call(CoreMethod.agentsTakeOver, params)
    }

    /// `agents.webhook.create`.
    @discardableResult
    public func agentsWebhookCreate(_ params: NameParams) async throws -> CreatedWebhook {
        try await call(CoreMethod.agentsWebhookCreate, params)
    }

    /// `agents.webhook.revoke`.
    @discardableResult
    public func agentsWebhookRevoke(_ params: NameParams) async throws -> RevokedWebhook {
        try await call(CoreMethod.agentsWebhookRevoke, params)
    }

    /// `agents.integrations.subscribe`.
    @discardableResult
    public func agentsIntegrationsSubscribe(_ params: IntegrationParams) async throws -> IntegrationChange {
        try await call(CoreMethod.agentsIntegrationsSubscribe, params)
    }

    /// `agents.integrations.unsubscribe`.
    @discardableResult
    public func agentsIntegrationsUnsubscribe(_ params: IntegrationParams) async throws -> IntegrationChange {
        try await call(CoreMethod.agentsIntegrationsUnsubscribe, params)
    }

    /// `agents.integrations.clean_up`.
    @discardableResult
    public func agentsIntegrationsCleanUp(_ params: IntegrationParams) async throws -> IntegrationChange {
        try await call(CoreMethod.agentsIntegrationsCleanUp, params)
    }

    /// `settings.get`.
    @discardableResult
    public func settingsGet() async throws -> SettingsValues {
        try await call(CoreMethod.settingsGet, NoParams())
    }

    /// `settings.set`.
    @discardableResult
    public func settingsSet(_ params: SettingsChange) async throws -> SettingsValues {
        try await call(CoreMethod.settingsSet, params)
    }

    /// `activity.list`.
    @discardableResult
    public func activityList(_ params: LimitParams) async throws -> ActivityLog {
        try await call(CoreMethod.activityList, params)
    }

    /// `claude_delivery.status`.
    @discardableResult
    public func claudeDeliveryStatus() async throws -> ClaudeDeliveryStatus {
        try await call(CoreMethod.claudeDeliveryStatus, NoParams())
    }

    /// `claude_delivery.restrict`.
    @discardableResult
    public func claudeDeliveryRestrict(_ params: ClaudeRestrictionParams) async throws -> Done {
        try await call(CoreMethod.claudeDeliveryRestrict, params)
    }

    /// `claude_delivery.session`.
    @discardableResult
    public func claudeDeliverySession(_ params: ClaudeSessionDeliveryParams) async throws -> Done {
        try await call(CoreMethod.claudeDeliverySession, params)
    }

    /// `claude_delivery.sender`.
    @discardableResult
    public func claudeDeliverySender(_ params: ClaudeSenderDeliveryParams) async throws -> Done {
        try await call(CoreMethod.claudeDeliverySender, params)
    }

    /// `claude_delivery.approve`.
    @discardableResult
    public func claudeDeliveryApprove(_ params: ClaudeHeldParams) async throws -> ClaudeDeliveryChanged {
        try await call(CoreMethod.claudeDeliveryApprove, params)
    }

    /// `claude_delivery.dismiss`.
    @discardableResult
    public func claudeDeliveryDismiss(_ params: ClaudeHeldParams) async throws -> ClaudeDeliveryChanged {
        try await call(CoreMethod.claudeDeliveryDismiss, params)
    }

    /// `openclaw.relay_tools.status`.
    @discardableResult
    public func openclawRelayToolsStatus() async throws -> OpenClawToolsStatus {
        try await call(CoreMethod.openclawRelayToolsStatus, NoParams())
    }

    /// `openclaw.relay_tools.connect`.
    @discardableResult
    public func openclawRelayToolsConnect() async throws -> OpenClawToolsConnect {
        try await call(CoreMethod.openclawRelayToolsConnect, NoParams())
    }

    /// `roster.list`.
    @discardableResult
    public func rosterList(_ params: RosterParams) async throws -> Roster {
        try await call(CoreMethod.rosterList, params)
    }

    /// `roster.get`.
    @discardableResult
    public func rosterGet(_ params: RecipientParams) async throws -> Recipient {
        try await call(CoreMethod.rosterGet, params)
    }

    /// `fleet.list`.
    @discardableResult
    public func fleetList() async throws -> FleetListing {
        try await call(CoreMethod.fleetList, NoParams())
    }

    /// `fleet.release`.
    @discardableResult
    public func fleetRelease(_ params: ReleaseParams) async throws -> Done {
        try await call(CoreMethod.fleetRelease, params)
    }

    /// `messages.conversations`.
    @discardableResult
    public func messagesConversations() async throws -> Conversations {
        try await call(CoreMethod.messagesConversations, NoParams())
    }

    /// `messages.history`.
    @discardableResult
    public func messagesHistory(_ params: HistoryParams) async throws -> History {
        try await call(CoreMethod.messagesHistory, params)
    }

    /// `messages.send`.
    @discardableResult
    public func messagesSend(_ params: SendParams) async throws -> SentMessage {
        try await call(CoreMethod.messagesSend, params)
    }

    /// `people.list`.
    @discardableResult
    public func peopleList() async throws -> People {
        try await call(CoreMethod.peopleList, NoParams())
    }

    /// `links.parse`.
    @discardableResult
    public func linksParse(_ params: LinkParams) async throws -> DeepLink {
        try await call(CoreMethod.linksParse, params)
    }
}
