import Foundation
import Relaycast

/// Hosted-participant client. This is a thin facade over the relaycast Swift
/// engine SDK (`Relaycast`): registration, reconnect, workspace lookup, channel
/// posting, DMs, action handling, and the realtime event stream are all served
/// by `Relaycast.RelayCast` / `Relaycast.AgentClient` / `Relaycast.WsClient`.
/// Outbound action invocation and message history are served directly over the
/// hosted REST API by the internal `RelayRestClient`.
///
/// The public surface (types, method signatures, AsyncStream APIs) is preserved
/// so existing callers keep working; only the transport implementation changed.
public final class AgentRelay: @unchecked Sendable {
    private let core: HostedWorkspaceCore
    public let workspaceKey: String
    public let baseURL: URL

    public init(workspaceKey: String, baseURL: URL? = nil) {
        self.workspaceKey = workspaceKey
        let resolved = Self.resolveBaseURL(from: baseURL)
        self.baseURL = resolved
        self.core = HostedWorkspaceCore(workspaceKey: workspaceKey, baseURL: resolved)
    }

    public convenience init(apiKey: String, baseURL: URL? = nil) {
        self.init(workspaceKey: apiKey, baseURL: baseURL)
    }

    /// Register a hosted workspace participant. This mirrors the TypeScript
    /// `relay.workspace.register(...)` default: register first, and if the
    /// hosted API reports a name conflict, adopt the existing identity and
    /// rotate its token.
    public func registerOrRotate(name: String, type: RelayAgentType = .agent) async throws -> AgentRegistration {
        try await core.registerOrRotate(name: name, type: type)
    }

    public func register(name: String, type: RelayAgentType = .agent, strict: Bool = false) async throws -> AgentRegistration {
        if strict {
            return try await core.register(name: name, type: type)
        }
        return try await core.registerOrRotate(name: name, type: type)
    }

    public func reconnect(apiToken: String) async throws -> AgentClient {
        try await core.reconnect(apiToken: apiToken)
    }

    public func `as`(agentName: String, token: String) -> AgentClient {
        // Compatibility rehydration for callers that already persisted a name
        // and token. The hosted API exposes the canonical id through `/v1/agent`;
        // use `reconnect(apiToken:)` when the id is required.
        core.agentClient(id: agentName, name: agentName, token: token)
    }

    public func workspaceInfo() async throws -> JSONValue {
        try await core.workspaceInfo()
    }

    /// Consolidated workspace facade (#1156): `register`/`reconnect`/`info`/
    /// `update`/`delete` in one place, mirroring the TS SDK `relay.workspace`.
    public var workspace: RelayWorkspace {
        RelayWorkspace(relay: self)
    }

    /// Create a hosted workspace and return an `AgentRelay` bound to its key.
    /// Mirrors the TS SDK `AgentRelay.createWorkspace(...)`.
    public static func createWorkspace(name: String, baseURL: URL? = nil) async throws -> AgentRelay {
        let resolved = resolveBaseURL(from: baseURL)
        do {
            let response = try await Relaycast.RelayCast.createWorkspace(
                name,
                options: Relaycast.WorkspaceBootstrapOptions(baseURL: resolved.absoluteString)
            )
            guard let apiKey = response.apiKey, !apiKey.isEmpty else {
                throw RelayError.protocolError(
                    code: "workspace_missing_key",
                    message: "Workspace created, but the response did not include a workspace key.",
                    retryable: false
                )
            }
            return AgentRelay(workspaceKey: apiKey, baseURL: resolved)
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func workspaceInfoDetail() async throws -> RelayWorkspaceInfo {
        try await core.workspaceInfoDetail()
    }

    func workspaceUpdate(_ input: RelayUpdateWorkspaceInput) async throws -> RelayWorkspaceInfo {
        try await core.workspaceUpdate(input)
    }

    func workspaceDelete() async throws {
        try await core.workspaceDelete()
    }

    private static func resolveBaseURL(from baseURL: URL?) -> URL {
        if let baseURL {
            return baseURL
        }
        return URL(string: "https://cast.agentrelay.com")!
    }
}

/// Compatibility alias for existing Swift consumers. In this module the client
/// is the hosted participant SDK, not the local broker protocol client.
public typealias AgentRelayClient = AgentRelay

final class HostedWorkspaceCore: @unchecked Sendable {
    let workspaceKey: String
    let baseURL: URL
    // `Relaycast.RelayCast(options:)` can throw (e.g. empty apiKey, invalid
    // baseURL). The public `AgentRelay` initializers are non-throwing, so we
    // capture the construction result eagerly and rethrow a translated
    // `RelayError` on first use instead of force-unwrapping (which would crash
    // the process on bad configuration).
    private let relayResult: Result<Relaycast.RelayCast, Error>

    init(workspaceKey: String, baseURL: URL) {
        self.workspaceKey = workspaceKey
        self.baseURL = baseURL
        // PRESERVE the configured host: pass it explicitly into relaycast.
        self.relayResult = Result {
            try Relaycast.RelayCast(
                options: Relaycast.RelayCastOptions(
                    apiKey: workspaceKey,
                    baseURL: baseURL.absoluteString
                )
            )
        }
    }

    /// Resolve the wrapped relaycast engine, surfacing configuration errors as
    /// `RelayError` rather than crashing.
    func relayCast() throws -> Relaycast.RelayCast {
        do {
            return try relayResult.get()
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func register(name: String, type: RelayAgentType) async throws -> AgentRegistration {
        let relay = try relayCast()
        do {
            let created = try await relay.agents.register(
                Relaycast.CreateAgentRequest(name: name, type: type.relaycastType)
            )
            return makeRegistration(created)
        } catch let error as Relaycast.RelayError {
            throw Self.registrationConflictAwareError(error)
        }
    }

    func registerOrRotate(name: String, type: RelayAgentType) async throws -> AgentRegistration {
        let relay = try relayCast()
        do {
            let created = try await relay.registerOrRotate(
                Relaycast.RegisterAgentRequest(name: name, type: type.relaycastType)
            )
            return makeRegistration(created)
        } catch let error as Relaycast.RelayError {
            throw Self.registrationConflictAwareError(error)
        }
    }

    /// Agent registration is the one operation where a bare HTTP 409 is
    /// unambiguous: it means the requested agent name is already taken. Every
    /// other relaycast call bridges through the generic, non-guessing
    /// `RelayError(_:)` mapping instead, since a 409 elsewhere (channel,
    /// trigger, node, webhook, ...) means a different kind of conflict.
    static func registrationConflictAwareError(_ error: Relaycast.RelayError) -> RelayError {
        if case .api(_, let message, let statusCode, let retryable) = error, statusCode == 409 {
            return .protocolError(code: "agent_already_exists", message: message, retryable: retryable)
        }
        return RelayError(error)
    }

    func reconnect(apiToken: String) async throws -> AgentClient {
        let relay = try relayCast()
        do {
            let engine = try await relay.reconnect(Relaycast.AgentReconnectOptions(apiToken: apiToken))
            let me = try await engine.me()
            let core = HostedParticipantCore(engineSource: .ready(engine: engine, relay: relay), agentId: me.id, agentName: me.name, token: apiToken, baseURL: baseURL)
            return AgentClient(core: core, id: me.id, name: me.name, token: apiToken)
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func agentClient(id: String, name: String, token: String) -> AgentClient {
        let core = makeParticipantCore(id: id, name: name, token: token)
        return AgentClient(core: core, id: id, name: name, token: token)
    }

    func workspaceInfo() async throws -> JSONValue {
        let relay = try relayCast()
        do {
            let workspace = try await relay.workspace.info()
            return Self.workspaceJSON(workspace)
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func workspaceInfoDetail() async throws -> RelayWorkspaceInfo {
        let relay = try relayCast()
        do {
            return RelayWorkspaceInfo(try await relay.workspace.info())
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func workspaceUpdate(_ input: RelayUpdateWorkspaceInput) async throws -> RelayWorkspaceInfo {
        let relay = try relayCast()
        do {
            let workspace = try await relay.workspace.update(
                Relaycast.UpdateWorkspaceRequest(name: input.name, systemPrompt: input.systemPrompt)
            )
            return RelayWorkspaceInfo(workspace)
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func workspaceDelete() async throws {
        let relay = try relayCast()
        do {
            try await relay.workspace.delete()
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func makeParticipantCore(id: String, name: String, token: String) -> HostedParticipantCore {
        Self.makeParticipantCore(relayResult: relayResult, baseURL: baseURL, id: id, name: name, token: token)
    }

    static func makeParticipantCore(relayResult: Result<Relaycast.RelayCast, Error>, baseURL: URL, id: String, name: String, token: String) -> HostedParticipantCore {
        // Defer the per-agent engine build (`relay.asAgent`) into the actor so
        // that configuration/handshake errors propagate through the first async
        // call as `RelayError` instead of force-unwrapping and crashing.
        return HostedParticipantCore(engineSource: .deferred(relayResult: relayResult, token: token), agentId: id, agentName: name, token: token, baseURL: baseURL)
    }

    func makeRegistration(_ response: Relaycast.CreateAgentResponse) -> AgentRegistration {
        // Capture the transport state (`relayResult`, `baseURL`) strongly so a
        // persisted `AgentRegistration` stays usable even if the owning
        // `AgentRelay`/`HostedWorkspaceCore` is released before `asClient()` is
        // called. `Relaycast.RelayCast` is the only shared, reusable state; the
        // per-agent engine is created lazily from it in the closure.
        let relayResult = self.relayResult
        let baseURL = self.baseURL
        return AgentRegistration(
            id: response.id,
            name: response.name,
            token: response.token,
            status: RelayAgentStatus(response.status),
            createdAt: response.createdAt
        ) { id, agentName, token in
            let core = HostedWorkspaceCore.makeParticipantCore(
                relayResult: relayResult,
                baseURL: baseURL,
                id: id,
                name: agentName,
                token: token
            )
            return AgentClient(core: core, id: id, name: agentName, token: token)
        }
    }

    private static func workspaceJSON(_ workspace: Relaycast.Workspace) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(workspace.id),
            "name": .string(workspace.name),
            "created_at": .string(workspace.createdAt)
        ]
        if let systemPrompt = workspace.systemPrompt {
            object["system_prompt"] = .string(systemPrompt)
        }
        if let plan = workspace.plan {
            object["plan"] = .string(plan)
        }
        if let metadata = workspace.metadata {
            object["metadata"] = .object(metadata.mapValues { JSONValue($0) })
        }
        return .object(object)
    }
}

public final class AgentClient: @unchecked Sendable {
    private let core: HostedParticipantCore
    private let rest: RelayRestClient
    public let id: String
    public let name: String
    public let token: String

    public var agentName: String { name }

    init(core: HostedParticipantCore, id: String, name: String, token: String) {
        self.core = core
        // Outbound action invocation and message history are served directly
        // over the hosted REST API (agent-token auth), independent of the
        // realtime engine held by `core`.
        self.rest = RelayRestClient(baseURL: core.baseURL, token: token)
        self.id = id
        self.name = name
        self.token = token
    }

    public func connect() async throws {
        try await core.ensureConnected()
    }

    public func disconnect() async {
        await core.disconnect()
    }

    public func channel(_ name: String) -> RelayChannel {
        RelayChannel(name: name, core: core)
    }

    public func post(to channel: String, message: String, attachments: [RelayAttachmentInput] = []) async throws {
        try await core.post(channel: channel, text: message, attachments: attachments.map { $0.fileId })
    }

    public func dm(to agentName: String, message: String, attachments: [RelayAttachmentInput] = []) async throws {
        try await core.dm(to: agentName, text: message, attachments: attachments.map { $0.fileId })
    }

    // MARK: - Rich facades (#1150–#1158)

    /// Message threads: fetch a thread or post a reply.
    public var threads: RelayThreads { RelayThreads(core: core) }

    /// Unread inbox summary plus delivery ack/fail/defer.
    public var inbox: RelayInboxService { RelayInboxService(core: core) }

    /// Durable per-recipient delivery ledger.
    public var deliveries: RelayDeliveries { RelayDeliveries(core: core) }

    /// Rich channels facade: list/get/create/update/archive/join/leave/invite/members/mute/unmute.
    public var channels: RelayChannels { RelayChannels(core: core) }

    /// Rich agents facade: list/get/me/update/delete/presence.
    public var agents: RelayAgents { RelayAgents(core: core) }

    /// Fleet nodes: list/get/bind/unbind.
    public var nodes: RelayNodes { RelayNodes(core: core) }

    /// Broker-backed fleet terminal sessions over the authenticated hosted
    /// transport. No workspace key or broker credential is exposed.
    public var terminals: RelayTerminals { RelayTerminals(core: core, rest: rest) }

    /// Message triggers: list/create/update/delete.
    public var triggers: RelayTriggers { RelayTriggers(core: core) }

    /// Inbound webhooks and outbound event subscriptions.
    public var integrations: RelayIntegrations { RelayIntegrations(core: core) }

    /// File uploads for message attachments (#1144).
    public var files: RelayFiles { RelayFiles(core: core) }

    /// Workspace admin available to an agent-scoped client (info/update/delete).
    public var workspace: RelayWorkspaceAdmin { RelayWorkspaceAdmin(core: core) }

    // MARK: - Typed listener hub (#1159)

    /// Subscribe to realtime events by selector (exact `message.created`,
    /// wildcard `message.*`/`*`, or a predicate). The returned token
    /// unsubscribes on `cancel()`. Complements the `events` AsyncStream.
    @discardableResult
    public func addListener(_ selector: RelayEventSelector, handler: @escaping RelayEventHandler) async -> RelayListenerToken {
        let core = self.core
        let id = await core.registerTypedListener(selector: selector, once: false, handler: handler)
        return RelayListenerToken(
            onCancel: { Task { await core.removeTypedListener(id) } },
            onCancelAsync: { await core.removeTypedListener(id) }
        )
    }

    /// Like `addListener`, but auto-unsubscribes after the first matching event.
    @discardableResult
    public func once(_ selector: RelayEventSelector, handler: @escaping RelayEventHandler) async -> RelayListenerToken {
        let core = self.core
        let id = await core.registerTypedListener(selector: selector, once: true, handler: handler)
        return RelayListenerToken(
            onCancel: { Task { await core.removeTypedListener(id) } },
            onCancelAsync: { await core.removeTypedListener(id) }
        )
    }

    /// Register a hook that receives typed-listener handler errors. Returns a
    /// token whose `cancel()` removes the hook.
    @discardableResult
    public func onError(_ hook: @escaping RelayErrorHook) async -> RelayListenerToken {
        let core = self.core
        let id = await core.registerErrorHook(hook)
        return RelayListenerToken(
            onCancel: { Task { await core.removeErrorHook(id) } },
            onCancelAsync: { await core.removeErrorHook(id) }
        )
    }

    public func registerAction(
        name: String,
        description: String,
        inputSchemaJSON: String,
        handler: @escaping @Sendable (String) async -> String
    ) async throws -> ActionHandle {
        try await core.registerAction(
            name: name,
            description: description,
            inputSchemaJSON: inputSchemaJSON,
            handler: handler
        )
    }

    /// Invoke a relay action registered by another agent and wait for its
    /// output.
    ///
    /// Two-phase async RPC: `POST /v1/actions/{name}/invoke` returns an ack
    /// (without the output), then the invocation record is polled until it
    /// reaches a terminal status. Polling keeps the call deterministic and
    /// does not require the realtime socket to be connected; listening for
    /// the WS `action.completed` event instead is a future latency
    /// optimization.
    ///
    /// - Parameters:
    ///   - name: Registered action name. May contain dots (e.g.
    ///     `deploy.staging`); dots are preserved in the request path.
    ///   - input: JSON object passed to the action handler.
    ///   - timeout: Maximum time to wait for completion, measured on a
    ///     monotonic clock. The budget also bounds each underlying HTTP
    ///     request and clamps the final poll sleep, so a large `pollInterval`
    ///     cannot extend the wait past the deadline.
    ///   - pollInterval: Delay between invocation-status polls.
    /// - Returns: The action output, or `.null` when the action completed
    ///   without output.
    /// - Throws: `RelayError.protocolError` with code `action_failed` /
    ///   `action_denied` when the invocation fails, is denied, or reports an
    ///   unknown terminal status; `RelayError.timeout` when `timeout` elapses
    ///   first.
    public func invokeAction(_ name: String, input: JSONValue = .object([:]), timeout: TimeInterval = 30, pollInterval: TimeInterval = 0.4) async throws -> JSONValue {
        try await rest.invokeAction(name, input: input, timeout: timeout, pollInterval: pollInterval)
    }

    /// Fetch recent messages for a channel, oldest-first.
    ///
    /// A leading `#` is accepted and stripped (`"#general"` and `"general"`
    /// are equivalent). The wire does not guarantee ordering, so results are
    /// stably sorted ascending by timestamp.
    ///
    /// - Parameters:
    ///   - channel: Channel name, with or without a leading `#`.
    ///   - limit: Maximum number of messages to fetch.
    ///   - before: Only fetch messages older than this message id.
    /// - Returns: Channel messages as `RelayChannelEvent`s (`channel` is the
    ///   normalized channel name; `rawEvent` is `nil` for history rows).
    public func channelHistory(_ channel: String, limit: Int = 50, before: String? = nil) async throws -> [RelayChannelEvent] {
        try await rest.channelHistory(channel: channel, limit: limit, before: before)
    }

    /// Fetch the 1:1 DM history with a named agent, oldest-first.
    ///
    /// The conversation is resolved via `GET /v1/dm/conversations` first
    /// (there is no single-shot endpoint); when no 1:1 conversation with the
    /// agent exists yet, an empty array is returned rather than an error.
    ///
    /// - Parameters:
    ///   - agent: Agent name, with or without a leading `@`.
    ///   - limit: Maximum number of messages to fetch.
    ///   - before: Only fetch messages older than this message id.
    /// - Returns: DM messages as `RelayChannelEvent`s (`channel` and
    ///   `threadId` are `nil`; `rawEvent` is `nil` for history rows).
    public func dmHistory(with agent: String, limit: Int = 50, before: String? = nil) async throws -> [RelayChannelEvent] {
        try await rest.dmHistory(with: agent, limit: limit, before: before)
    }

    /// Realtime events. If the consumer falls behind, the oldest event is
    /// dropped so that at most the newest 256 events are buffered.
    public var events: AsyncStream<RelayEvent> {
        let id = UUID()
        let core = self.core
        let generation = core.streamLifecycle.snapshot()
        return AsyncStream<RelayEvent>(bufferingPolicy: .bufferingNewest(256)) { continuation in
            let registrationTask = Task {
                await core.registerEventContinuation(continuation, id: id, generation: generation)
            }
            continuation.onTermination = { @Sendable _ in
                registrationTask.cancel()
                Task { await core.unregisterEventContinuation(id: id) }
            }
        }
    }

    /// Inbound messages. If the consumer falls behind, the oldest message is
    /// dropped so that at most the newest 256 messages are buffered.
    public var inboundMessages: AsyncStream<RelayChannelEvent> {
        let id = UUID()
        let core = self.core
        let generation = core.streamLifecycle.snapshot()
        return AsyncStream<RelayChannelEvent>(bufferingPolicy: .bufferingNewest(256)) { continuation in
            let registrationTask = Task {
                await core.registerInboundMessageContinuation(continuation, id: id, generation: generation)
            }
            continuation.onTermination = { @Sendable _ in
                registrationTask.cancel()
                Task { await core.unregisterInboundMessageContinuation(id: id) }
            }
        }
    }

    /// Connection changes are latest-state-only: an unread state is replaced
    /// when a newer state arrives, so at most one value is buffered.
    public var connectionState: AsyncStream<ConnectionStateChange> {
        let id = UUID()
        let core = self.core
        let generation = core.streamLifecycle.snapshot()
        return AsyncStream<ConnectionStateChange>(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let registrationTask = Task {
                await core.registerConnectionStateContinuation(continuation, id: id, generation: generation)
            }
            continuation.onTermination = { @Sendable _ in
                registrationTask.cancel()
                Task { await core.unregisterConnectionStateContinuation(id: id) }
            }
        }
    }
}

public final class RelayChannel: @unchecked Sendable {
    public let name: String
    private let core: HostedParticipantCore
    private let streamRegistrations = StreamRegistrationTasks()

    /// Channel delivery is registered only when the stream is requested.
    /// Slow consumers retain at most the newest 256 events.
    ///
    /// Request this stream before calling ``subscribe()`` when events emitted
    /// immediately after subscription must be retained. `subscribe()` waits
    /// for every stream requested up to that point to finish registering.
    public var events: AsyncStream<RelayChannelEvent> {
        let id = UUID()
        let core = self.core
        let name = self.name
        let streamRegistrations = self.streamRegistrations
        let generation = core.streamLifecycle.snapshot()
        return AsyncStream<RelayChannelEvent>(bufferingPolicy: .bufferingNewest(256)) { continuation in
            let registrationTask = Task {
                await core.registerChannelContinuation(continuation, id: id, generation: generation, for: name)
            }
            streamRegistrations.insert(registrationTask, id: id)
            continuation.onTermination = { @Sendable _ in
                registrationTask.cancel()
                streamRegistrations.remove(id: id)
                Task { await core.unregisterChannelContinuation(id: id, for: name) }
            }
        }
    }

    init(name: String, core: HostedParticipantCore) {
        self.name = name
        self.core = core
    }

    public func subscribe() async throws {
        for registrationTask in streamRegistrations.takeAll() {
            await registrationTask.value
        }
        try await core.subscribe(channel: name)
    }

    public func post(_ text: String) async throws {
        try await core.post(channel: name, text: text)
    }
}

typealias RelayActionHandler = @Sendable (String) async -> String

private struct RegisteredAction: Sendable {
    let id: String
    let handler: RelayActionHandler
}

private struct ContinuationRegistry<Element: Sendable> {
    typealias Continuation = AsyncStream<Element>.Continuation

    private(set) var active: [UUID: Continuation] = [:]

    var count: Int { active.count }
    var continuations: Dictionary<UUID, Continuation>.Values { active.values }

    mutating func register(_ continuation: Continuation, id: UUID) {
        active[id] = continuation
    }

    mutating func unregister(id: UUID) {
        active.removeValue(forKey: id)
    }

    mutating func finishAll() {
        for continuation in active.values { continuation.finish() }
        active.removeAll()
    }
}

final class StreamLifecycle: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0

    func snapshot() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return generation
    }

    func advance() {
        lock.lock()
        generation &+= 1
        lock.unlock()
    }
}

private final class StreamRegistrationTasks: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [UUID: Task<Void, Never>] = [:]

    func insert(_ task: Task<Void, Never>, id: UUID) {
        lock.lock()
        tasks[id] = task
        lock.unlock()
    }

    func remove(id: UUID) {
        lock.lock()
        tasks.removeValue(forKey: id)
        lock.unlock()
    }

    func takeAll() -> [Task<Void, Never>] {
        lock.lock()
        defer { lock.unlock() }
        let pending = Array(tasks.values)
        tasks.removeAll()
        return pending
    }
}

/// Higher-level glue kept ON TOP of the relaycast engine SDK: the
/// action-dispatch loop, channel-event normalization into `RelayChannelEvent`,
/// AsyncStream fan-out, and subscription bookkeeping. The realtime socket and
/// HTTP calls are delegated to the wrapped `Relaycast.AgentClient` /
/// `Relaycast.RelayCast`.
actor HostedParticipantCore {
    nonisolated let streamLifecycle = StreamLifecycle()
    /// How the per-agent engine is obtained. `.ready` is used by `reconnect`,
    /// which already has a live engine; `.deferred` builds the engine lazily via
    /// `relay.asAgent(token)` on first connect so that `asAgent`/configuration
    /// errors propagate as `RelayError` instead of crashing at construction.
    enum EngineSource {
        case ready(engine: Relaycast.AgentClient, relay: Relaycast.RelayCast)
        case deferred(relayResult: Result<Relaycast.RelayCast, Error>, token: String)
    }

    let agentId: String
    let agentName: String
    let token: String
    let baseURL: URL
    private let engineSource: EngineSource
    private var resolvedEngine: Relaycast.AgentClient?
    private var resolvedRelay: Relaycast.RelayCast?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var connected = false
    private var listenersInstalled = false
    private var subscribedChannels: Set<String> = []
    private var channelContinuations: [String: ContinuationRegistry<RelayChannelEvent>] = [:]
    private var inboundMessageContinuations = ContinuationRegistry<RelayChannelEvent>()
    private var eventContinuations = ContinuationRegistry<RelayEvent>()
    private var connectionStateContinuations = ContinuationRegistry<ConnectionStateChange>()
    private var actionHandlers: [String: RegisteredAction] = [:]
    private var unsubscribeHandlers: [() -> Void] = []

    // Typed listener hub (#1159): registrations keyed by id, plus error hooks.
    // Declared `internal` (not `private`) so the hub methods in
    // `RelayListeners.swift` can register/dispatch across files.
    var typedListeners: [UUID: TypedListenerRegistration] = [:]
    var listenerErrorHooks: [UUID: RelayErrorHook] = [:]

    // Serialized inbound-event pipeline. The engine delivers events in order
    // from a single receive loop; we yield them (synchronously, FIFO) into this
    // stream and drain them through `routeEvent` on one consumer task so that
    // ordering is preserved end-to-end. (Spawning an unstructured `Task` per
    // event would let the scheduler reorder closely-spaced events.)
    private var eventBuffer: AsyncStream<RelayEvent>.Continuation?
    private var eventPump: Task<Void, Never>?

    init(engineSource: EngineSource, agentId: String, agentName: String, token: String, baseURL: URL) {
        self.engineSource = engineSource
        self.agentId = agentId
        self.agentName = agentName
        self.token = token
        self.baseURL = baseURL
    }

    /// Resolve (and cache) the relaycast `RelayCast` engine wrapper. Surfaces
    /// configuration errors as `RelayError`. Internal so the rich facade
    /// services (`RelayFacades.swift`) can reach workspace-scoped endpoints.
    func relayCast() throws -> Relaycast.RelayCast {
        if let resolvedRelay { return resolvedRelay }
        switch engineSource {
        case .ready(_, let relay):
            resolvedRelay = relay
            return relay
        case .deferred(let relayResult, _):
            do {
                let relay = try relayResult.get()
                resolvedRelay = relay
                return relay
            } catch let error as Relaycast.RelayError {
                throw RelayError(error)
            }
        }
    }

    /// Resolve (and cache) the per-agent engine, building it lazily for the
    /// `.deferred` source. Surfaces `asAgent`/configuration errors as `RelayError`.
    /// Internal so the rich facade services can reach agent-scoped endpoints.
    func engine() throws -> Relaycast.AgentClient {
        if let resolvedEngine { return resolvedEngine }
        switch engineSource {
        case .ready(let engine, _):
            resolvedEngine = engine
            return engine
        case .deferred(_, let token):
            let relay = try relayCast()
            do {
                let engine = try relay.asAgent(token)
                resolvedEngine = engine
                return engine
            } catch let error as Relaycast.RelayError {
                throw RelayError(error)
            }
        }
    }

    func ensureConnected() async throws {
        let engine = try engine()
        installListenersIfNeeded(engine: engine)
        if !connected {
            engine.connect()
            connected = true
        }
        notifyConnectionState(.connected)
        syncSubscriptions(engine: engine)
    }

    func disconnect() async {
        // Invalidate registrations scheduled before this disconnect, including
        // tasks that have not reached the actor yet.
        streamLifecycle.advance()
        // Only tear down an engine that was actually built/connected; building
        // one here just to disconnect it would be pointless (and could throw).
        if let resolvedEngine {
            await resolvedEngine.disconnect()
        }
        connected = false
        for unsubscribe in unsubscribeHandlers { unsubscribe() }
        unsubscribeHandlers.removeAll()
        listenersInstalled = false
        eventBuffer?.finish()
        eventBuffer = nil
        eventPump?.cancel()
        eventPump = nil
        notifyConnectionState(.disconnected)
        for key in channelContinuations.keys {
            channelContinuations[key]?.finishAll()
        }
        channelContinuations.removeAll()
        inboundMessageContinuations.finishAll()
        eventContinuations.finishAll()
        connectionStateContinuations.finishAll()
    }

    func registerChannelContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, id: UUID, generation: UInt64, for channel: String) {
        guard !Task.isCancelled, generation == streamLifecycle.snapshot() else {
            continuation.finish()
            return
        }
        let channel = Self.normalizeChannel(channel)
        channelContinuations[channel, default: ContinuationRegistry()].register(continuation, id: id)
    }

    func unregisterChannelContinuation(id: UUID, for channel: String) {
        let channel = Self.normalizeChannel(channel)
        guard var registry = channelContinuations[channel] else { return }
        registry.unregister(id: id)
        channelContinuations[channel] = registry.count > 0 ? registry : nil
    }

    func registerInboundMessageContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, id: UUID, generation: UInt64) {
        guard !Task.isCancelled, generation == streamLifecycle.snapshot() else {
            continuation.finish()
            return
        }
        inboundMessageContinuations.register(continuation, id: id)
    }

    func unregisterInboundMessageContinuation(id: UUID) {
        inboundMessageContinuations.unregister(id: id)
    }

    func registerEventContinuation(_ continuation: AsyncStream<RelayEvent>.Continuation, id: UUID, generation: UInt64) {
        guard !Task.isCancelled, generation == streamLifecycle.snapshot() else {
            continuation.finish()
            return
        }
        eventContinuations.register(continuation, id: id)
    }

    func unregisterEventContinuation(id: UUID) {
        eventContinuations.unregister(id: id)
    }

    func registerConnectionStateContinuation(_ continuation: AsyncStream<ConnectionStateChange>.Continuation, id: UUID, generation: UInt64) {
        guard !Task.isCancelled, generation == streamLifecycle.snapshot() else {
            continuation.finish()
            return
        }
        connectionStateContinuations.register(continuation, id: id)
    }

    func unregisterConnectionStateContinuation(id: UUID) {
        connectionStateContinuations.unregister(id: id)
    }

    func continuationCounts() -> (channels: Int, channelRegistries: Int, inbound: Int, events: Int, connectionState: Int) {
        (
            channels: channelContinuations.values.reduce(0) { $0 + $1.count },
            channelRegistries: channelContinuations.count,
            inbound: inboundMessageContinuations.count,
            events: eventContinuations.count,
            connectionState: connectionStateContinuations.count
        )
    }

    func subscribe(channel: String) async throws {
        subscribedChannels.insert(Self.normalizeChannel(channel))
        try await ensureConnected()
    }

    func post(channel: String, text: String, attachments: [String] = []) async throws {
        let engine = try engine()
        do {
            _ = try await engine.send(
                Self.normalizeChannel(channel),
                text: text,
                options: Relaycast.SendMessageOptions(attachments: attachments.isEmpty ? nil : attachments, mode: .wait)
            )
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func dm(to target: String, text: String, attachments: [String] = []) async throws {
        let engine = try engine()
        do {
            _ = try await engine.dm(
                Self.stripSigil(target),
                text: text,
                options: Relaycast.DMOptions(mode: .wait, attachments: attachments.isEmpty ? nil : attachments)
            )
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func registerAction(
        name: String,
        description: String,
        inputSchemaJSON: String,
        handler: @escaping RelayActionHandler
    ) async throws -> ActionHandle {
        let actionName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actionName.isEmpty else {
            throw RelayError.protocolError(code: "invalid_action_name", message: "Action name cannot be empty", retryable: false)
        }
        let inputSchema = try decodeRelaycastObject(inputSchemaJSON)

        let registrationId = UUID().uuidString
        actionHandlers[actionName] = RegisteredAction(id: registrationId, handler: handler)

        do {
            try await registerActionDescriptor(name: actionName, description: description, inputSchema: inputSchema)
            try await ensureConnected()
        } catch {
            actionHandlers.removeValue(forKey: actionName)
            throw error
        }

        return ActionHandle(name: actionName) { [weak self] in
            await self?.unregisterAction(name: actionName, registrationId: registrationId)
        }
    }

    func unregisterAction(name: String, registrationId: String) async {
        guard actionHandlers[name]?.id == registrationId else { return }
        do {
            try await unregisterActionDescriptor(name: name)
            actionHandlers.removeValue(forKey: name)
        } catch {
            // Keep the handler if the relay descriptor could not be removed so
            // advertised invocations are still handled instead of silently dropped.
        }
    }

    private func registerActionDescriptor(name: String, description: String, inputSchema: [String: Relaycast.JSONValue]) async throws {
        let relay = try relayCast()
        do {
            _ = try await relay.actions.register(
                Relaycast.RegisterActionRequest(
                    name: name,
                    description: description,
                    handlerAgent: agentName,
                    inputSchema: inputSchema
                )
            )
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    private func unregisterActionDescriptor(name: String) async throws {
        let relay = try relayCast()
        do {
            try await relay.actions.delete(name)
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    private func syncSubscriptions(engine: Relaycast.AgentClient) {
        guard !subscribedChannels.isEmpty else { return }
        engine.subscribe(Array(subscribedChannels).sorted())
    }

    // MARK: - Realtime listeners

    private func installListenersIfNeeded(engine: Relaycast.AgentClient) {
        guard !listenersInstalled else { return }
        listenersInstalled = true

        // Build the serialized event pipeline before wiring engine callbacks so
        // the first delivered event already has a place to queue.
        var continuation: AsyncStream<RelayEvent>.Continuation!
        let stream = AsyncStream<RelayEvent> { continuation = $0 }
        eventBuffer = continuation
        eventPump = Task { [weak self] in
            for await event in stream {
                await self?.routeEvent(event)
            }
        }

        // `engine.on.*` fire in order from the engine's single receive loop;
        // yielding into `buffer` (synchronously) preserves that order, and the
        // single `eventPump` consumer drains them sequentially.
        let buffer = continuation!
        let ingest: @Sendable (Relaycast.WsEvent) -> Void = { event in
            buffer.yield(RelayEvent(event))
        }
        unsubscribeHandlers.append(engine.on.messageCreated(ingest))
        unsubscribeHandlers.append(engine.on.threadReply(ingest))
        unsubscribeHandlers.append(engine.on.dmReceived(ingest))
        unsubscribeHandlers.append(engine.on.groupDMReceived(ingest))
        unsubscribeHandlers.append(engine.on.actionInvoked(ingest))

        unsubscribeHandlers.append(engine.on.connected { [weak self] in
            guard let self else { return }
            Task { await self.transportDidConnect() }
        })
        unsubscribeHandlers.append(engine.on.disconnected { [weak self] in
            guard let self else { return }
            Task { await self.handleEngineDisconnect() }
        })
        unsubscribeHandlers.append(engine.on.reconnecting { [weak self] attempt in
            guard let self else { return }
            Task { await self.notifyConnectionStateAsync(.reconnecting(attempt: attempt)) }
        })
    }

    private func transportDidConnect() async {
        notifyConnectionState(.connected)
        // The engine is necessarily resolved here: this fires from the engine's
        // own `connected` callback, which is only installed after `engine()` ran.
        if let resolvedEngine {
            syncSubscriptions(engine: resolvedEngine)
        }
    }

    private func notifyConnectionStateAsync(_ state: ConnectionStateChange) async {
        notifyConnectionState(state)
    }

    /// Handle an engine-initiated disconnect. Reset `connected` so that a later
    /// `ensureConnected()` will actually re-issue `engine.connect()`, matching
    /// the manual `disconnect()` path (which also clears the flag). Without this
    /// the flag stays `true` after an engine drop and reconnection is skipped.
    private func handleEngineDisconnect() async {
        connected = false
        notifyConnectionState(.disconnected)
    }

    // MARK: - Event routing (glue kept on top of the engine)

    func routeEvent(_ event: RelayEvent) {
        for continuation in eventContinuations.continuations {
            continuation.yield(event)
        }

        // Fan out to the typed listener hub (#1159) alongside the back-compat
        // AsyncStreams above.
        dispatchToTypedListeners(event)

        if event.type == "action.invoked" || event.type == "actionInvoked" {
            routeActionInvocation(event)
            return
        }

        guard let message = channelEvent(from: event) else { return }
        for continuation in inboundMessageContinuations.continuations {
            continuation.yield(message)
        }
        if let channel = message.channel {
            if let continuations = channelContinuations[Self.normalizeChannel(channel)]?.continuations {
                for continuation in continuations {
                    continuation.yield(message)
                }
            }
        }
    }

    private func channelEvent(from event: RelayEvent) -> RelayChannelEvent? {
        switch event.type {
        case "message.created", "messageCreated", "message.received", "messageReceived", "thread.reply", "threadReply", "dm.received", "dmReceived", "group_dm.received", "groupDmReceived":
            break
        default:
            return nil
        }

        let sender = event.message?.from.name ?? event.agentName ?? "unknown"
        let channel = event.channel ?? event.message?.channel?.name
        return RelayChannelEvent(
            from: sender,
            body: event.message?.text ?? "",
            channel: channel,
            threadId: event.message?.threadId ?? event.message?.parentId,
            messageId: event.message?.messageId,
            timestamp: Self.date(from: event.message?.createdAt),
            rawEvent: event
        )
    }

    private func routeActionInvocation(_ event: RelayEvent) {
        guard let actionName = event.actionName,
              let invocationId = event.invocationId,
              let registration = actionHandlers[actionName] else {
            return
        }

        Task.detached {
            await self.handleActionInvocation(
                actionName: actionName,
                invocationId: invocationId,
                callerName: event.callerName,
                registration: registration
            )
        }
    }

    private func handleActionInvocation(
        actionName: String,
        invocationId: String,
        callerName: String?,
        registration: RegisteredAction
    ) async {
        do {
            let invocation = try await loadInvocation(actionName: actionName, invocationId: invocationId)
            let input = invocation.input ?? [:]
            let inputString = actionInputString(input)
            let output = await registration.handler(inputString)
            try await completeInvocation(actionName: actionName, invocationId: invocationId, output: parseHandlerOutput(output))
        } catch {
            try? await completeInvocation(actionName: actionName, invocationId: invocationId, error: Self.describe(error))
        }
    }

    private func loadInvocation(actionName: String, invocationId: String) async throws -> Relaycast.ActionInvocation {
        let engine = try engine()
        do {
            return try await engine.actions.getInvocation(name: actionName, invocationID: invocationId)
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    private func completeInvocation(actionName: String, invocationId: String, output: [String: Relaycast.JSONValue]) async throws {
        let engine = try engine()
        do {
            _ = try await engine.actions.completeInvocation(
                name: actionName,
                invocationID: invocationId,
                data: Relaycast.CompleteInvocationRequest(output: output)
            )
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    private func completeInvocation(actionName: String, invocationId: String, error: String) async throws {
        let engine = try engine()
        do {
            _ = try await engine.actions.completeInvocation(
                name: actionName,
                invocationID: invocationId,
                data: Relaycast.CompleteInvocationRequest(error: error)
            )
        } catch let relayError as Relaycast.RelayError {
            throw RelayError(relayError)
        }
    }

    // MARK: - JSON helpers

    private func decodeRelaycastObject(_ json: String) throws -> [String: Relaycast.JSONValue] {
        guard let data = json.data(using: .utf8) else {
            throw RelayError.encodingFailed("Input schema is not valid UTF-8")
        }
        do {
            let value = try decoder.decode(Relaycast.JSONValue.self, from: data)
            guard case .object(let object) = value else {
                throw RelayError.decodingFailed("Input schema must be a JSON object")
            }
            return object
        } catch let error as RelayError {
            throw error
        } catch {
            throw RelayError.decodingFailed("Invalid inputSchemaJSON: \(error)")
        }
    }

    private func actionInputString(_ input: [String: Relaycast.JSONValue]) -> String {
        guard let data = try? encoder.encode(Relaycast.JSONValue.object(input)),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }

    private func parseHandlerOutput(_ output: String) -> [String: Relaycast.JSONValue] {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty,
           let data = trimmed.data(using: .utf8),
           let value = try? decoder.decode(Relaycast.JSONValue.self, from: data) {
            if case .object(let object) = value {
                return object
            }
            return ["value": value]
        }
        return ["value": .string(output)]
    }

    func notifyConnectionState(_ state: ConnectionStateChange) {
        for continuation in connectionStateContinuations.continuations {
            continuation.yield(state)
        }
    }

    // Internal (not private): `RelayRestClient` reuses the same channel/agent
    // name normalization for the history endpoints.
    static func stripSigil(_ value: String) -> String {
        if value.hasPrefix("@") || value.hasPrefix("#") {
            return String(value.dropFirst())
        }
        return value
    }

    static func normalizeChannel(_ value: String) -> String {
        stripSigil(value).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func date(from timestamp: String?) -> Date {
        guard let timestamp,
              let date = ISO8601DateFormatter().date(from: timestamp)
        else { return Date() }
        return date
    }

    private static func describe(_ error: Error) -> String {
        if let relayError = error as? RelayError {
            switch relayError {
            case .invalidBaseURL(let message),
                 .connectionFailed(let message),
                 .handshakeFailed(let message),
                 .encodingFailed(let message),
                 .decodingFailed(let message),
                 .unsupported(let message),
                 .timeout(let message):
                return message
            case .protocolError(let code, let message, _):
                return "\(code): \(message)"
            case .notConnected:
                return "Relay is not connected."
            }
        }
        return error.localizedDescription
    }
}
