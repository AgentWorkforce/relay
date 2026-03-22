import Foundation

public enum RelayError: Error, Sendable {
    case invalidBaseURL(String)
    case connectionFailed(String)
    case handshakeFailed(String)
    case protocolError(code: String, message: String, retryable: Bool)
    case encodingFailed(String)
    case decodingFailed(String)
    case notConnected
    case unsupported(String)
    case timeout(String)
}

/// Connection state changes emitted by the SDK.
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

actor RelayCore {
    let apiKey: String
    let transport: RelayTransport
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    private var handshakeInFlight = false
    private var handshakeGeneration = 0
    private var handshakeContinuations: [CheckedContinuation<Void, Error>] = []
    private var routerTask: Task<Void, Never>?
    private var channelContinuations: [String: [AsyncStream<RelayChannelEvent>.Continuation]] = [:]
    private var brokerEventContinuations: [AsyncStream<BrokerEvent>.Continuation] = []
    private var inboundMessageContinuations: [AsyncStream<InboundMessage>.Continuation] = []
    private var connectionStateContinuations: [AsyncStream<ConnectionStateChange>.Continuation] = []

    init(apiKey: String, transport: RelayTransport) {
        self.apiKey = apiKey
        self.transport = transport
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
        if handshakeInFlight {
            return try await waitForHandshake()
        }
        handshakeInFlight = true
        handshakeGeneration &+= 1
        try await transport.connect()
        try await send(.hello(HelloPayload(clientName: "AgentRelaySDK.Swift", clientVersion: "0.1.0", apiKey: apiKey)))
        try await waitForHandshake()
    }

    func transportDidConnect() async {
        if handshakeInFlight {
            finishHandshake(with: RelayError.connectionFailed("Transport reconnected before previous handshake completed"))
        }
        handshakeInFlight = true
        handshakeGeneration &+= 1
        notifyConnectionState(.connected)
        do {
            try await send(.hello(HelloPayload(clientName: "AgentRelaySDK.Swift", clientVersion: "0.1.0", apiKey: apiKey)))
        } catch {
            finishHandshake(with: error)
        }
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
        try await ensureConnected()
        try await send(.sendMessage(SendMessagePayload(to: channel, text: text, from: nil, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil)))
    }

    func sendAgentMessage(from agentName: String, to target: String, text: String) async throws {
        try await ensureConnected()
        try await send(.sendMessage(SendMessagePayload(to: target, text: text, from: agentName, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil)))
    }

    func spawnAgent(_ spec: AgentSpec, initialTask: String? = nil, skipRelayPrompt: Bool? = nil) async throws {
        try await ensureConnected()
        try await send(.spawnAgent(SpawnAgentPayload(agent: spec, initialTask: initialTask, skipRelayPrompt: skipRelayPrompt)))
    }

    func releaseAgent(name: String, reason: String? = nil) async throws {
        try await ensureConnected()
        try await send(.releaseAgent(ReleaseAgentPayload(name: name, reason: reason)))
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
        handshakeInFlight = false
        let pendingHandshakes = handshakeContinuations
        handshakeContinuations.removeAll()
        for continuation in pendingHandshakes {
            continuation.resume(throwing: RelayError.notConnected)
        }
        await transport.disconnect()
        notifyConnectionState(.disconnected)
        // Finish all event stream continuations
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

    private func send(_ message: OutboundMessage) async throws {
        do {
            let data = try encoder.encode(message)
            try await transport.send(data)
        } catch let error as RelayTransport.TransportError {
            switch error {
            case .notConnected: throw RelayError.notConnected
            case .connectionFailed(let message), .sendFailed(let message): throw RelayError.connectionFailed(message)
            case .invalidResponse: throw RelayError.connectionFailed("Invalid response")
            }
        } catch {
            throw RelayError.encodingFailed(String(describing: error))
        }
    }

    private func waitForHandshake() async throws {
        let generation = handshakeGeneration
        try await withCheckedThrowingContinuation { continuation in
            handshakeContinuations.append(continuation)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                await self?.failHandshakeIfPending(generation: generation, with: RelayError.timeout("Timed out waiting for hello_ack"))
            }
        }
    }

    private func finishHandshake() {
        handshakeInFlight = false
        let continuations = handshakeContinuations
        handshakeContinuations.removeAll()
        for continuation in continuations {
            continuation.resume(returning: ())
        }
    }

    private func finishHandshake(with error: Error) {
        handshakeInFlight = false
        let continuations = handshakeContinuations
        handshakeContinuations.removeAll()
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }

    private func failHandshakeIfPending(generation: Int, with error: Error) {
        guard handshakeInFlight, handshakeGeneration == generation else { return }
        finishHandshake(with: error)
    }

    private func notifyConnectionState(_ state: ConnectionStateChange) {
        for continuation in connectionStateContinuations {
            continuation.yield(state)
        }
    }

    private func routeFrames() async {
        for await data in transport.inbound {
            do {
                let inbound = try decoder.decode(InboundMessage.self, from: data)

                // Notify all raw inbound message subscribers
                for continuation in inboundMessageContinuations {
                    continuation.yield(inbound)
                }

                switch inbound {
                case .helloAck:
                    finishHandshake()
                case .event(let event):
                    // Notify all broker event subscribers
                    for continuation in brokerEventContinuations {
                        continuation.yield(event)
                    }

                    // Route relay_inbound events to channel subscribers
                    if case .relayInbound(let relayEvent) = event {
                        let message = RelayChannelEvent(from: relayEvent.from, body: relayEvent.body, threadId: relayEvent.threadId)
                        for continuation in channelContinuations[relayEvent.target] ?? [] {
                            continuation.yield(message)
                        }
                    }
                case .deliverRelay(let delivery):
                    // Route relay deliveries to channel subscribers as RelayChannelEvents
                    let message = RelayChannelEvent(from: delivery.from, body: delivery.body, threadId: delivery.threadId)
                    for continuation in channelContinuations[delivery.target] ?? [] {
                        continuation.yield(message)
                    }
                case .error(let error):
                    finishHandshake(with: RelayError.protocolError(code: error.code, message: error.message, retryable: error.retryable))
                default:
                    break
                }
            } catch {
                continue
            }
        }
        // Transport stream ended (disconnection)
        notifyConnectionState(.disconnected)
    }
}

public final class RelayCast: @unchecked Sendable {
    private let core: RelayCore
    public let apiKey: String
    public let baseURL: URL

    public init(apiKey: String, baseURL: URL? = nil) {
        self.apiKey = apiKey
        let resolved = Self.resolveBaseURL(from: baseURL)
        self.baseURL = resolved
        let transport = RelayTransport(baseURL: resolved, authToken: apiKey)
        self.core = RelayCore(apiKey: apiKey, transport: transport)
        Task {
            await self.core.configureTransportCallbacks()
        }
    }

    /// Create a channel handle for subscribing and posting.
    public func channel(_ name: String) -> Channel {
        Channel(name: name, core: core)
    }

    /// Register (or re-register) an agent identity with the broker.
    public func registerOrRotate(name: String) async throws -> AgentRegistration {
        try await core.registerOrRotate(name: name)
    }

    /// Create an agent client from an existing agent name and token.
    public func `as`(agentName: String, token: String) -> AgentClient {
        AgentClient(core: core, agentName: agentName, token: token)
    }

    /// Spawn a new agent process on the broker.
    public func spawnAgent(_ spec: AgentSpec, initialTask: String? = nil, skipRelayPrompt: Bool? = nil) async throws {
        try await core.spawnAgent(spec, initialTask: initialTask, skipRelayPrompt: skipRelayPrompt)
    }

    /// Release (stop) a named agent on the broker.
    public func releaseAgent(name: String, reason: String? = nil) async throws {
        try await core.releaseAgent(name: name, reason: reason)
    }

    /// Disconnect from the broker and cancel all event streams.
    public func disconnect() async {
        await core.disconnect()
    }

    /// Stream of all broker events (agent_spawned, worker_stream, delivery_*, etc.).
    ///
    /// This provides full visibility into broker activity, suitable for building
    /// agent dashboards, monitoring tools, or custom event routing.
    ///
    /// Call `ensureConnected()` on a channel or register an agent first to start
    /// receiving events.
    public var brokerEvents: AsyncStream<BrokerEvent> {
        AsyncStream<BrokerEvent> { continuation in
            Task { await core.registerBrokerEventContinuation(continuation) }
        }
    }

    /// Stream of all raw inbound protocol messages.
    ///
    /// This is the lowest-level event stream, including hello_ack, ok, error,
    /// event, deliver_relay, worker_stream, worker_exited, and pong frames.
    /// Use this when you need full protocol visibility.
    public var inboundMessages: AsyncStream<InboundMessage> {
        AsyncStream<InboundMessage> { continuation in
            Task { await core.registerInboundMessageContinuation(continuation) }
        }
    }

    /// Stream of connection state changes (connected, disconnected, reconnecting).
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

public final class Channel: @unchecked Sendable {
    public let name: String
    private let core: RelayCore
    private let continuationRef: AsyncStream<RelayChannelEvent>.Continuation?
    public let events: AsyncStream<RelayChannelEvent>

    init(name: String, core: RelayCore) {
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
        try await core.ensureConnected()
    }

    public func post(_ text: String) async throws {
        try await core.sendChannelPost(channel: name, text: text)
    }
}

public final class AgentClient: @unchecked Sendable {
    private let core: RelayCore
    public let agentName: String
    public let token: String

    init(core: RelayCore, agentName: String, token: String) {
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
