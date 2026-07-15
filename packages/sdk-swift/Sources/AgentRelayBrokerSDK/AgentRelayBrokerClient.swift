import Foundation

public enum ConnectionStateChange: Sendable {
    case connected
    case disconnected
    case reconnecting(attempt: Int)
}

public struct RelayChannelEvent: Sendable {
    public let from: String
    public let body: String
    public let threadId: String?
    public let timestamp: Date

    public init(from: String, body: String, threadId: String?, timestamp: Date = Date()) {
        self.from = from
        self.body = body
        self.threadId = threadId
        self.timestamp = timestamp
    }
}

public struct AgentRegistration: Sendable {
    public let agentName: String
    public let token: String
    private let factory: @Sendable (String, String) -> AgentClient

    public init(agentName: String, token: String, factory: @escaping @Sendable (String, String) -> AgentClient) {
        self.agentName = agentName
        self.token = token
        self.factory = factory
    }

    public func asClient() -> AgentClient {
        factory(agentName, token)
    }
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

actor BrokerCore {
    nonisolated let streamLifecycle = StreamLifecycle()
    let apiKey: String
    let transport: any RelayTransportClient
    let http: any RelayHTTPClient
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    private var routerTask: Task<Void, Never>?
    private var channelContinuations: [String: ContinuationRegistry<RelayChannelEvent>] = [:]
    private var brokerEventContinuations = ContinuationRegistry<BrokerEvent>()
    private var inboundMessageContinuations = ContinuationRegistry<InboundMessage>()
    private var connectionStateContinuations = ContinuationRegistry<ConnectionStateChange>()

    init(apiKey: String, transport: any RelayTransportClient, http: any RelayHTTPClient) {
        self.apiKey = apiKey
        self.transport = transport
        self.http = http
    }

    func configureTransportCallbacks() async {
        await transport.setOnConnect { [weak self] in
            await self?.transportDidConnect()
        }
    }

    func ensureConnected() async throws {
        if routerTask == nil || routerTask?.isCancelled == true {
            routerTask = Task { [weak self] in await self?.routeFrames() }
        }
        try await transport.connect()
        notifyConnectionState(.connected)
    }

    func transportDidConnect() async {
        notifyConnectionState(.connected)
    }

    func registerChannelContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, id: UUID, generation: UInt64, for channel: String) {
        guard !Task.isCancelled, generation == streamLifecycle.snapshot() else {
            continuation.finish()
            return
        }
        channelContinuations[channel, default: ContinuationRegistry()].register(continuation, id: id)
    }

    func unregisterChannelContinuation(id: UUID, for channel: String) {
        guard var registry = channelContinuations[channel] else { return }
        registry.unregister(id: id)
        if registry.count == 0 {
            channelContinuations.removeValue(forKey: channel)
        } else {
            channelContinuations[channel] = registry
        }
    }

    func registerBrokerEventContinuation(_ continuation: AsyncStream<BrokerEvent>.Continuation, id: UUID, generation: UInt64) {
        guard !Task.isCancelled, generation == streamLifecycle.snapshot() else {
            continuation.finish()
            return
        }
        brokerEventContinuations.register(continuation, id: id)
    }

    func unregisterBrokerEventContinuation(id: UUID) {
        brokerEventContinuations.unregister(id: id)
    }

    func registerInboundMessageContinuation(_ continuation: AsyncStream<InboundMessage>.Continuation, id: UUID, generation: UInt64) {
        guard !Task.isCancelled, generation == streamLifecycle.snapshot() else {
            continuation.finish()
            return
        }
        inboundMessageContinuations.register(continuation, id: id)
    }

    func unregisterInboundMessageContinuation(id: UUID) {
        inboundMessageContinuations.unregister(id: id)
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

    func continuationCounts() -> (channels: Int, channelRegistries: Int, brokerEvents: Int, inbound: Int, connectionState: Int) {
        (
            channels: channelContinuations.values.reduce(0) { $0 + $1.count },
            channelRegistries: channelContinuations.count,
            brokerEvents: brokerEventContinuations.count,
            inbound: inboundMessageContinuations.count,
            connectionState: connectionStateContinuations.count
        )
    }

    func sendChannelPost(channel: String, text: String) async throws {
        try await sendMessageHTTP(SendMessagePayload(to: channel, text: text, from: nil, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil))
    }

    func sendAgentMessage(from agentName: String, to target: String, text: String) async throws {
        try await sendMessageHTTP(SendMessagePayload(to: target, text: text, from: agentName, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil))
    }

    func spawnAgent(_ spec: AgentSpec, initialTask: String? = nil, skipRelayPrompt: Bool? = nil) async throws {
        let body = try encodeJSON(SpawnRequestBody(spec: spec, task: initialTask, skipRelayPrompt: skipRelayPrompt))
        _ = try await http.post(path: "/api/spawn", body: body)
    }

    func releaseAgent(name: String, reason: String? = nil) async throws {
        var pathSegmentAllowed = CharacterSet.urlPathAllowed
        pathSegmentAllowed.remove(charactersIn: "/")
        let escaped = name.addingPercentEncoding(withAllowedCharacters: pathSegmentAllowed) ?? name
        let body: Data?
        if let reason {
            body = try encodeJSON(["reason": reason])
        } else {
            body = nil
        }
        _ = try await http.delete(path: "/api/spawned/\(escaped)", body: body)
    }

    func registerOrRotate(name: String) async throws -> AgentRegistration {
        try await ensureConnected()
        return AgentRegistration(agentName: name, token: name) { agentName, token in
            AgentClient(core: self, agentName: agentName, token: token)
        }
    }

    func disconnect() async {
        // Invalidate registrations scheduled before this disconnect, including
        // tasks that have not reached the actor yet.
        streamLifecycle.advance()
        routerTask?.cancel()
        routerTask = nil
        await transport.disconnect()
        notifyConnectionState(.disconnected)
        brokerEventContinuations.finishAll()
        inboundMessageContinuations.finishAll()
        for key in channelContinuations.keys {
            channelContinuations[key]?.finishAll()
        }
        channelContinuations.removeAll()
        connectionStateContinuations.finishAll()
    }

    private func sendMessageHTTP(_ payload: SendMessagePayload) async throws {
        let body = try encodeJSON(payload)
        _ = try await http.post(path: "/api/send", body: body)
    }

    private func encodeJSON<T: Encodable>(_ value: T) throws -> Data {
        do {
            return try encoder.encode(value)
        } catch {
            throw RelayError.encodingFailed(String(describing: error))
        }
    }

    func notifyConnectionState(_ state: ConnectionStateChange) {
        for continuation in connectionStateContinuations.continuations {
            continuation.yield(state)
        }
    }

    private func routeFrames() async {
        for await data in transport.inbound {
            if let message = try? decoder.decode(InboundMessage.self, from: data) {
                routeInboundMessage(message)
                continue
            }

            guard let event = try? decoder.decode(BrokerEvent.self, from: data) else {
                continue
            }
            routeBrokerEvent(event)
        }
        notifyConnectionState(.disconnected)
    }

    private func routeInboundMessage(_ message: InboundMessage) {
        for continuation in inboundMessageContinuations.continuations {
            continuation.yield(message)
        }
        if case .event(let event) = message {
            routeBrokerEvent(event, alreadyYieldedInbound: true)
        }
    }

    func routeBrokerEvent(_ event: BrokerEvent, alreadyYieldedInbound: Bool = false) {
        if !alreadyYieldedInbound {
            for continuation in inboundMessageContinuations.continuations {
                continuation.yield(.event(event))
            }
        }
        for continuation in brokerEventContinuations.continuations {
            continuation.yield(event)
        }

        if case .relayInbound(let relayEvent) = event {
            let message = RelayChannelEvent(from: relayEvent.from, body: relayEvent.body, threadId: relayEvent.threadId)
            for continuation in channelContinuations[relayEvent.target]?.continuations ?? [:].values {
                continuation.yield(message)
            }
        }
    }
}

private struct SpawnRequestBody: Encodable {
    let spec: AgentSpec
    let task: String?
    let skipRelayPrompt: Bool?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: SpawnCodingKeys.self)
        try container.encode(spec.name, forKey: .name)
        try container.encode(spec.runtime.rawValue, forKey: .runtime)
        if let provider = spec.provider {
            try container.encode(provider.rawValue, forKey: .cli)
        } else if let cli = spec.cli {
            try container.encode(cli, forKey: .cli)
        }
        if let model = spec.model {
            try container.encode(model, forKey: .model)
        }
        try container.encode(spec.args ?? [], forKey: .args)
        try container.encode(spec.channels ?? [], forKey: .channels)
        if let cwd = spec.cwd {
            try container.encode(cwd, forKey: .cwd)
        }
        if let sessionId = spec.sessionId {
            try container.encode(sessionId, forKey: .sessionId)
        }
        if let team = spec.team {
            try container.encode(team, forKey: .team)
        }
        if let shadowOf = spec.shadowOf {
            try container.encode(shadowOf, forKey: .shadowOf)
        }
        if let shadowMode = spec.shadowMode {
            try container.encode(shadowMode, forKey: .shadowMode)
        }
        if let restartPolicy = spec.restartPolicy {
            try container.encode(restartPolicy, forKey: .restartPolicy)
        }
        if let task {
            try container.encode(task, forKey: .task)
        }
        if let skipRelayPrompt {
            try container.encode(skipRelayPrompt, forKey: .skipRelayPrompt)
        }
    }

    enum SpawnCodingKeys: String, CodingKey {
        case name, cli, runtime, model, args, channels, cwd, team, task
        case sessionId = "session_id"
        case shadowOf = "shadow_of"
        case shadowMode = "shadow_mode"
        case restartPolicy = "restart_policy"
        case skipRelayPrompt = "skip_relay_prompt"
    }
}

public final class AgentRelayBrokerClient: @unchecked Sendable {
    private let core: BrokerCore
    public let apiKey: String
    public let baseURL: URL

    public init(apiKey: String, baseURL: URL? = nil) {
        self.apiKey = apiKey
        let resolved = Self.resolveBaseURL(from: baseURL)
        self.baseURL = resolved
        let transport = RelayTransport(baseURL: resolved, authToken: apiKey)
        let http = RelayHTTP(baseURL: resolved, apiKey: apiKey)
        self.core = BrokerCore(apiKey: apiKey, transport: transport, http: http)
        Task {
            await self.core.configureTransportCallbacks()
        }
    }

    init(core: BrokerCore, apiKey: String, baseURL: URL) {
        self.core = core
        self.apiKey = apiKey
        self.baseURL = baseURL
    }

    public func channel(_ name: String) -> Channel {
        Channel(name: name, core: core)
    }

    /// Register (or re-register) an agent identity with the broker.
    public func registerOrRotate(name: String) async throws -> AgentRegistration {
        try await core.registerOrRotate(name: name)
    }

    public func `as`(agentName: String, token: String) -> AgentClient {
        AgentClient(core: core, agentName: agentName, token: token)
    }

    public func spawnAgent(_ spec: AgentSpec, initialTask: String? = nil, skipRelayPrompt: Bool? = nil) async throws {
        try await core.spawnAgent(spec, initialTask: initialTask, skipRelayPrompt: skipRelayPrompt)
    }

    public func releaseAgent(name: String, reason: String? = nil) async throws {
        try await core.releaseAgent(name: name, reason: reason)
    }

    public func disconnect() async {
        await core.disconnect()
    }

    /// Broker events. If the consumer falls behind, the oldest event is
    /// dropped so that at most the newest 256 events are buffered.
    public var brokerEvents: AsyncStream<BrokerEvent> {
        let id = UUID()
        let core = self.core
        let generation = core.streamLifecycle.snapshot()
        return AsyncStream<BrokerEvent>(bufferingPolicy: .bufferingNewest(256)) { continuation in
            let registrationTask = Task {
                await core.registerBrokerEventContinuation(continuation, id: id, generation: generation)
            }
            continuation.onTermination = { @Sendable _ in
                registrationTask.cancel()
                Task { await core.unregisterBrokerEventContinuation(id: id) }
            }
        }
    }

    /// Inbound messages. If the consumer falls behind, the oldest message is
    /// dropped so that at most the newest 256 messages are buffered.
    public var inboundMessages: AsyncStream<InboundMessage> {
        let id = UUID()
        let core = self.core
        let generation = core.streamLifecycle.snapshot()
        return AsyncStream<InboundMessage>(bufferingPolicy: .bufferingNewest(256)) { continuation in
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

    private static func resolveBaseURL(from baseURL: URL?) -> URL {
        if let baseURL {
            return baseURL
        }
        return URL(string: "http://localhost:3889")!
    }
}

/// Compatibility alias for existing broker consumers after switching imports to
/// `AgentRelayBrokerSDK`.
public typealias AgentRelayClient = AgentRelayBrokerClient

public final class Channel: @unchecked Sendable {
    public let name: String
    private let core: BrokerCore
    private let subscriptionLock = NSLock()
    private var subscribed = false

    /// Channel delivery is registered only when the stream is requested.
    /// Slow consumers retain at most the newest 256 events.
    public var events: AsyncStream<RelayChannelEvent> {
        let id = UUID()
        let core = self.core
        let name = self.name
        let generation = core.streamLifecycle.snapshot()
        return AsyncStream<RelayChannelEvent>(bufferingPolicy: .bufferingNewest(256)) { continuation in
            let registrationTask = Task {
                await core.registerChannelContinuation(continuation, id: id, generation: generation, for: name)
            }
            continuation.onTermination = { @Sendable _ in
                registrationTask.cancel()
                Task { await core.unregisterChannelContinuation(id: id, for: name) }
            }
        }
    }

    init(name: String, core: BrokerCore) {
        self.name = name
        self.core = core
    }

    public func subscribe() async throws {
        _ = markSubscribed()
        try await core.ensureConnected()
    }

    public func post(_ text: String) async throws {
        try await core.sendChannelPost(channel: name, text: text)
    }

    private func markSubscribed() -> Bool {
        subscriptionLock.lock()
        defer { subscriptionLock.unlock() }
        guard !subscribed else { return false }
        subscribed = true
        return true
    }
}

public final class AgentClient: @unchecked Sendable {
    private let core: BrokerCore
    public let agentName: String
    public let token: String

    init(core: BrokerCore, agentName: String, token: String) {
        self.core = core
        self.agentName = agentName
        self.token = token
    }

    public func post(to channel: String, message: String) async throws {
        try await core.sendAgentMessage(from: agentName, to: channel, text: message)
    }

    public func dm(to agentName: String, message: String) async throws {
        try await core.sendAgentMessage(from: self.agentName, to: agentName, text: message)
    }
}
