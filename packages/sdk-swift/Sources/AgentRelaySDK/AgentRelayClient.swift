import Foundation
import Relaycast

/// Hosted-participant client. This is a thin facade over the relaycast Swift
/// engine SDK (`Relaycast`): registration, reconnect, workspace lookup, channel
/// posting, DMs, action handling, and the realtime event stream are all served
/// by `Relaycast.RelayCast` / `Relaycast.AgentClient` / `Relaycast.WsClient`.
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

    private static func resolveBaseURL(from baseURL: URL?) -> URL {
        if let baseURL {
            return baseURL
        }
        return URL(string: "https://gateway.relaycast.dev")!
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
            throw RelayError(error)
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
            throw RelayError(error)
        }
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
    public let id: String
    public let name: String
    public let token: String

    public var agentName: String { name }

    init(core: HostedParticipantCore, id: String, name: String, token: String) {
        self.core = core
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

    public func post(to channel: String, message: String) async throws {
        try await core.post(channel: channel, text: message)
    }

    public func dm(to agentName: String, message: String) async throws {
        try await core.dm(to: agentName, text: message)
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

    public var events: AsyncStream<RelayEvent> {
        AsyncStream<RelayEvent> { continuation in
            Task { await core.registerEventContinuation(continuation) }
        }
    }

    public var inboundMessages: AsyncStream<RelayChannelEvent> {
        AsyncStream<RelayChannelEvent> { continuation in
            Task { await core.registerInboundMessageContinuation(continuation) }
        }
    }

    public var connectionState: AsyncStream<ConnectionStateChange> {
        AsyncStream<ConnectionStateChange> { continuation in
            Task { await core.registerConnectionStateContinuation(continuation) }
        }
    }
}

public final class RelayChannel: @unchecked Sendable {
    public let name: String
    private let core: HostedParticipantCore
    private let continuationRef: AsyncStream<RelayChannelEvent>.Continuation?
    public let events: AsyncStream<RelayChannelEvent>

    init(name: String, core: HostedParticipantCore) {
        self.name = name
        self.core = core
        var continuation: AsyncStream<RelayChannelEvent>.Continuation?
        self.events = AsyncStream<RelayChannelEvent> { incoming in
            continuation = incoming
        }
        self.continuationRef = continuation
    }

    public func subscribe() async throws {
        if let continuationRef {
            await core.registerChannelContinuation(continuationRef, for: name)
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

/// Higher-level glue kept ON TOP of the relaycast engine SDK: the
/// action-dispatch loop, channel-event normalization into `RelayChannelEvent`,
/// AsyncStream fan-out, and subscription bookkeeping. The realtime socket and
/// HTTP calls are delegated to the wrapped `Relaycast.AgentClient` /
/// `Relaycast.RelayCast`.
actor HostedParticipantCore {
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
    private var channelContinuations: [String: [AsyncStream<RelayChannelEvent>.Continuation]] = [:]
    private var inboundMessageContinuations: [AsyncStream<RelayChannelEvent>.Continuation] = []
    private var eventContinuations: [AsyncStream<RelayEvent>.Continuation] = []
    private var connectionStateContinuations: [AsyncStream<ConnectionStateChange>.Continuation] = []
    private var actionHandlers: [String: RegisteredAction] = [:]
    private var unsubscribeHandlers: [() -> Void] = []

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
    /// configuration errors as `RelayError`.
    private func relayCast() throws -> Relaycast.RelayCast {
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
    private func engine() throws -> Relaycast.AgentClient {
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
        for continuations in channelContinuations.values {
            for continuation in continuations { continuation.finish() }
        }
        channelContinuations.removeAll()
        for continuation in inboundMessageContinuations { continuation.finish() }
        inboundMessageContinuations.removeAll()
        for continuation in eventContinuations { continuation.finish() }
        eventContinuations.removeAll()
        for continuation in connectionStateContinuations { continuation.finish() }
        connectionStateContinuations.removeAll()
    }

    func registerChannelContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, for channel: String) {
        channelContinuations[Self.normalizeChannel(channel), default: []].append(continuation)
    }

    func registerInboundMessageContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation) {
        inboundMessageContinuations.append(continuation)
    }

    func registerEventContinuation(_ continuation: AsyncStream<RelayEvent>.Continuation) {
        eventContinuations.append(continuation)
    }

    func registerConnectionStateContinuation(_ continuation: AsyncStream<ConnectionStateChange>.Continuation) {
        connectionStateContinuations.append(continuation)
    }

    func subscribe(channel: String) async throws {
        subscribedChannels.insert(Self.normalizeChannel(channel))
        try await ensureConnected()
    }

    func post(channel: String, text: String) async throws {
        let engine = try engine()
        do {
            _ = try await engine.send(Self.normalizeChannel(channel), text: text, options: Relaycast.SendMessageOptions(mode: .wait))
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    func dm(to target: String, text: String) async throws {
        let engine = try engine()
        do {
            _ = try await engine.dm(Self.stripSigil(target), text: text, options: Relaycast.DMOptions(mode: .wait))
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

    private func routeEvent(_ event: RelayEvent) {
        for continuation in eventContinuations {
            continuation.yield(event)
        }

        if event.type == "action.invoked" || event.type == "actionInvoked" {
            routeActionInvocation(event)
            return
        }

        guard let message = channelEvent(from: event) else { return }
        for continuation in inboundMessageContinuations {
            continuation.yield(message)
        }
        if let channel = message.channel {
            for continuation in channelContinuations[Self.normalizeChannel(channel)] ?? [] {
                continuation.yield(message)
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

    private func notifyConnectionState(_ state: ConnectionStateChange) {
        for continuation in connectionStateContinuations {
            continuation.yield(state)
        }
    }

    private static func stripSigil(_ value: String) -> String {
        if value.hasPrefix("@") || value.hasPrefix("#") {
            return String(value.dropFirst())
        }
        return value
    }

    private static func normalizeChannel(_ value: String) -> String {
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
