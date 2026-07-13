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

actor BrokerCore {
    let apiKey: String
    let transport: any RelayTransportClient
    let http: any RelayHTTPClient
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    private var routerTask: Task<Void, Never>?
    private var channelContinuations: [String: [AsyncStream<RelayChannelEvent>.Continuation]] = [:]
    private var brokerEventContinuations: [AsyncStream<BrokerEvent>.Continuation] = []
    private var inboundMessageContinuations: [AsyncStream<InboundMessage>.Continuation] = []
    private var connectionStateContinuations: [AsyncStream<ConnectionStateChange>.Continuation] = []

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

    func registerChannelContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, for channel: String) {
        channelContinuations[channel, default: []].append(continuation)
    }

    func registerBrokerEventContinuation(_ continuation: AsyncStream<BrokerEvent>.Continuation) {
        brokerEventContinuations.append(continuation)
    }

    func registerInboundMessageContinuation(_ continuation: AsyncStream<InboundMessage>.Continuation) {
        inboundMessageContinuations.append(continuation)
    }

    func registerConnectionStateContinuation(_ continuation: AsyncStream<ConnectionStateChange>.Continuation) {
        connectionStateContinuations.append(continuation)
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
        routerTask?.cancel()
        routerTask = nil
        await transport.disconnect()
        notifyConnectionState(.disconnected)
        for continuation in brokerEventContinuations { continuation.finish() }
        brokerEventContinuations.removeAll()
        for continuation in inboundMessageContinuations { continuation.finish() }
        inboundMessageContinuations.removeAll()
        for continuations in channelContinuations.values {
            for continuation in continuations { continuation.finish() }
        }
        channelContinuations.removeAll()
        for continuation in connectionStateContinuations { continuation.finish() }
        connectionStateContinuations.removeAll()
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

    private func notifyConnectionState(_ state: ConnectionStateChange) {
        for continuation in connectionStateContinuations {
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
        for continuation in inboundMessageContinuations {
            continuation.yield(message)
        }
        if case .event(let event) = message {
            routeBrokerEvent(event, alreadyYieldedInbound: true)
        }
    }

    private func routeBrokerEvent(_ event: BrokerEvent, alreadyYieldedInbound: Bool = false) {
        if !alreadyYieldedInbound {
            for continuation in inboundMessageContinuations {
                continuation.yield(.event(event))
            }
        }
        for continuation in brokerEventContinuations {
            continuation.yield(event)
        }

        if case .relayInbound(let relayEvent) = event {
            let message = RelayChannelEvent(from: relayEvent.from, body: relayEvent.body, threadId: relayEvent.threadId)
            for continuation in channelContinuations[relayEvent.target] ?? [] {
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

    public var brokerEvents: AsyncStream<BrokerEvent> {
        AsyncStream<BrokerEvent> { continuation in
            Task { await core.registerBrokerEventContinuation(continuation) }
        }
    }

    public var inboundMessages: AsyncStream<InboundMessage> {
        AsyncStream<InboundMessage> { continuation in
            Task { await core.registerInboundMessageContinuation(continuation) }
        }
    }

    public var connectionState: AsyncStream<ConnectionStateChange> {
        AsyncStream<ConnectionStateChange> { continuation in
            Task { await core.registerConnectionStateContinuation(continuation) }
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
    private let continuationRef: AsyncStream<RelayChannelEvent>.Continuation?
    private let subscriptionLock = NSLock()
    private var subscribed = false
    public let events: AsyncStream<RelayChannelEvent>

    init(name: String, core: BrokerCore) {
        self.name = name
        self.core = core
        var continuation: AsyncStream<RelayChannelEvent>.Continuation?
        self.events = AsyncStream<RelayChannelEvent> { incoming in
            continuation = incoming
        }
        self.continuationRef = continuation
    }

    public func subscribe() async throws {
        if markSubscribed(), let continuationRef {
            await core.registerChannelContinuation(continuationRef, for: name)
        }
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
