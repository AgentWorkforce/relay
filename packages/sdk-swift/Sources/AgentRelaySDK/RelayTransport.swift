import Foundation

public actor RelayTransport {
    public enum ConnectionState: Sendable {
        case disconnected
        case connecting
        case connected
        case reconnecting
    }

    public enum TransportError: Error, Sendable {
        case invalidResponse
        case notConnected
        case sendFailed(String)
        case connectionFailed(String)
    }

    public nonisolated let inbound: AsyncStream<Data>

    private let url: URL
    private let session: URLSession
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var inboundContinuation: AsyncStream<Data>.Continuation?
    private var state: ConnectionState = .disconnected
    private var manuallyDisconnected = false
    private var reconnectAttempt = 0
    private var lastPongAt = Date()

    public init(url: URL, session: URLSession = .shared) {
        self.url = url
        self.session = session
        var continuationRef: AsyncStream<Data>.Continuation?
        self.inbound = AsyncStream<Data> { continuation in
            continuationRef = continuation
        }
        self.inboundContinuation = continuationRef
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

        let task = session.webSocketTask(with: url)
        webSocketTask = task
        task.resume()
        state = .connected
        reconnectAttempt = 0
        lastPongAt = Date()

        startReceiveLoop()
        startPingLoop()
    }

    public func disconnect() {
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
            try await task.send(.data(message))
        } catch {
            throw TransportError.sendFailed(String(describing: error))
        }
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
                try? await Task.sleep(for: .seconds(20))
                if Task.isCancelled { return }
                do {
                    try await self.sendPing()
                } catch {
                    await self.handleDisconnect(error: error)
                    return
                }
            }
        }
    }

    private func sendPing() async throws {
        guard let task = webSocketTask else { throw TransportError.notConnected }
        let before = Date()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
        lastPongAt = Date()
        if lastPongAt.timeIntervalSince(before) > 10 {
            throw TransportError.connectionFailed("Pong exceeded watchdog")
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
        reconnectAttempt += 1
        let delay = reconnectDelay(for: reconnectAttempt)
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
        case 0: return 500
        case 1: return 1_000
        case 2: return 2_000
        case 3: return 4_000
        case 4: return 8_000
        case 5: return 16_000
        default: return 30_000
        }
    }
}
