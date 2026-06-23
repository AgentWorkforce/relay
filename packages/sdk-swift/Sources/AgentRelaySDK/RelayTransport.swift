import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

protocol HostedEventTransportClient: Sendable {
    var inbound: AsyncStream<Data> { get }

    func setOnConnect(_ handler: @escaping @Sendable () async -> Void) async
    func connect() async throws
    func disconnect() async
    func send(_ message: Data) async throws
}

public actor RelayEventTransport: HostedEventTransportClient {
    public enum ConnectionState: Sendable {
        case disconnected
        case connecting
        case connected
        case reconnecting
    }

    public enum TransportError: Error, Sendable {
        case notConnected
        case sendFailed(String)
        case connectionFailed(String)
    }

    public nonisolated let inbound: AsyncStream<Data>

    private let baseURL: URL
    private let token: String
    private let session: URLSession
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var inboundContinuation: AsyncStream<Data>.Continuation?
    private var state: ConnectionState = .disconnected
    private var manuallyDisconnected = false
    private var reconnectAttempt = 0
    private var onConnect: (@Sendable () async -> Void)?

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        var continuationRef: AsyncStream<Data>.Continuation?
        self.inbound = AsyncStream<Data> { continuation in
            continuationRef = continuation
        }
        self.inboundContinuation = continuationRef
    }

    public func setOnConnect(_ handler: @escaping @Sendable () async -> Void) async {
        self.onConnect = handler
    }

    public func connect() async throws {
        switch state {
        case .connected, .connecting:
            return
        case .disconnected, .reconnecting:
            break
        }

        manuallyDisconnected = false
        state = reconnectAttempt == 0 ? .connecting : .reconnecting
        let isReconnect = reconnectAttempt > 0
        let request = URLRequest(url: Self.resolveWebSocketURL(baseURL: baseURL, token: token) ?? baseURL)
        let task = session.webSocketTask(with: request)
        webSocketTask = task
        task.resume()
        state = .connected
        reconnectAttempt = 0
        startReceiveLoop()
        startPingLoop()
        if isReconnect, let onConnect {
            await onConnect()
        }
    }

    public func disconnect() async {
        manuallyDisconnected = true
        receiveTask?.cancel()
        pingTask?.cancel()
        reconnectTask?.cancel()
        receiveTask = nil
        pingTask = nil
        reconnectTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        state = .disconnected
    }

    public func send(_ message: Data) async throws {
        guard let task = webSocketTask, state == .connected else {
            throw TransportError.notConnected
        }
        do {
            if let string = String(data: message, encoding: .utf8) {
                try await task.send(.string(string))
            } else {
                try await task.send(.data(message))
            }
        } catch {
            throw TransportError.sendFailed(String(describing: error))
        }
    }

    static func resolveWebSocketURL(baseURL: URL, token: String) -> URL? {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        if components?.scheme == "http" { components?.scheme = "ws" }
        if components?.scheme == "https" { components?.scheme = "wss" }

        var path = components?.path ?? ""
        while path.hasSuffix("/") { path = String(path.dropLast()) }
        if path.hasSuffix("/v1/ws") {
            path = String(path.dropLast("/v1/ws".count))
        }
        components?.path = path + "/v1/ws"

        var queryItems = components?.queryItems?.filter { $0.name != "token" } ?? []
        queryItems.append(URLQueryItem(name: "token", value: token))
        queryItems.append(URLQueryItem(name: "origin_client", value: "agent-relay-swift"))
        queryItems.append(URLQueryItem(name: "origin_version", value: "swift-sdk-split"))
        components?.queryItems = queryItems

        return components?.url
    }

    private func startReceiveLoop() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    guard let task = await self.webSocketTask else { return }
                    let message = try await task.receive()
                    await self.handle(message)
                } catch {
                    await self.handleDisconnect(error: error)
                    return
                }
            }
        }
    }

    private func startPingLoop() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { return }
                try? await self.send(Self.encodeSocketMessage(["type": "ping"]))
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .data(let data):
            inboundContinuation?.yield(data)
        case .string(let string):
            if let data = string.data(using: .utf8) {
                inboundContinuation?.yield(data)
            }
        @unknown default:
            break
        }
    }

    private func handleDisconnect(error: Error) async {
        receiveTask?.cancel()
        pingTask?.cancel()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil

        guard !manuallyDisconnected else {
            state = .disconnected
            return
        }

        state = .reconnecting
        let delay = reconnectDelay(for: reconnectAttempt)
        reconnectAttempt += 1
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .milliseconds(delay))
            do {
                try await self.connect()
            } catch {
                await self.handleDisconnect(error: error)
            }
        }
    }

    private func reconnectDelay(for attempt: Int) -> Int {
        switch attempt {
        case 0: return 1_000
        case 1: return 2_000
        case 2: return 4_000
        case 3: return 8_000
        default: return 30_000
        }
    }

    static func encodeSocketMessage(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value)
    }
}
