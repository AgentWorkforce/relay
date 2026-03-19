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
    private var handshakeContinuation: CheckedContinuation<Void, Error>?
    private var routerTask: Task<Void, Never>?
    private var channelContinuations: [String: [AsyncStream<RelayChannelEvent>.Continuation]] = [:]

    init(apiKey: String, transport: RelayTransport) {
        self.apiKey = apiKey
        self.transport = transport
        Task { [weak self] in
            await transport.setOnConnect {
                await self?.transportDidConnect()
            }
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
        try await transport.connect()
        try await send(.hello(HelloPayload(clientName: "AgentRelaySDK.Swift", clientVersion: "0.1.0")))
        try await waitForHandshake()
    }

    func transportDidConnect() async {
        handshakeInFlight = true
        handshakeContinuation?.resume(throwing: RelayError.connectionFailed("Transport reconnected before previous handshake completed"))
        handshakeContinuation = nil
        do {
            try await send(.hello(HelloPayload(clientName: "AgentRelaySDK.Swift", clientVersion: "0.1.0")))
        } catch {
            finishHandshake(with: error)
        }
    }

    func registerChannelContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, for channel: String) {
        channelContinuations[channel, default: []].append(continuation)
    }

    func sendChannelPost(channel: String, text: String) async throws {
        try await ensureConnected()
        try await send(.sendMessage(SendMessagePayload(to: channel, text: text, from: nil, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil)))
    }

    func sendAgentMessage(from agentName: String, to target: String, text: String) async throws {
        try await ensureConnected()
        try await send(.sendMessage(SendMessagePayload(to: target, text: text, from: agentName, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil)))
    }

    func registerOrRotate(name: String) async throws -> AgentRegistration {
        try await ensureConnected()
        return AgentRegistration(agentName: name, token: name) { agentName, token in
            AgentClient(core: self, agentName: agentName, token: token)
        }
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
        try await withCheckedThrowingContinuation { continuation in
            handshakeContinuation = continuation
            Task {
                try? await Task.sleep(for: .seconds(10))
                await self.failHandshakeIfPending(with: RelayError.timeout("Timed out waiting for hello_ack"))
            }
        }
    }

    private func finishHandshake() {
        handshakeInFlight = false
        handshakeContinuation?.resume(returning: ())
        handshakeContinuation = nil
    }

    private func finishHandshake(with error: Error) {
        handshakeInFlight = false
        handshakeContinuation?.resume(throwing: error)
        handshakeContinuation = nil
    }

    private func failHandshakeIfPending(with error: Error) {
        guard handshakeInFlight else { return }
        finishHandshake(with: error)
    }

    private func routeFrames() async {
        for await data in transport.inbound {
            do {
                let inbound = try decoder.decode(InboundMessage.self, from: data)
                switch inbound {
                case .helloAck:
                    finishHandshake()
                case .event(let event):
                    if case .relayInbound(let relayEvent) = event {
                        let message = RelayChannelEvent(from: relayEvent.from, body: relayEvent.body, threadId: relayEvent.threadId)
                        for continuation in channelContinuations[relayEvent.target] ?? [] {
                            continuation.yield(message)
                        }
                    }
                case .deliverRelay(let relayEvent):
                    let message = RelayChannelEvent(from: relayEvent.from, body: relayEvent.body, threadId: relayEvent.threadId)
                    for continuation in channelContinuations[relayEvent.target] ?? [] {
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
        self.core = RelayCore(apiKey: apiKey, transport: RelayTransport(baseURL: resolved, authToken: apiKey))
    }

    public func channel(_ name: String) -> Channel {
        Channel(name: name, core: core)
    }

    public func registerOrRotate(name: String) async throws -> AgentRegistration {
        try await core.registerOrRotate(name: name)
    }

    public func `as`(agentName: String, token: String) -> AgentClient {
        AgentClient(core: core, agentName: agentName, token: token)
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
