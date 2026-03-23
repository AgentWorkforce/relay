import Foundation

// MARK: - Delegate

@MainActor
public protocol RelayObserverDelegate: AnyObject {
    func relayObserver(_ observer: RelayObserver, didReceiveEvent event: RelayObserverEvent)
    func relayObserverDidConnect(_ observer: RelayObserver)
    func relayObserverDidDisconnect(_ observer: RelayObserver, error: Error?)
}

// MARK: - RelayObserver

public final class RelayObserver: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {

    // MARK: - ConnectionState

    public enum ConnectionState: Equatable, Sendable {
        case disconnected
        case connecting
        case connected
        case reconnecting(attempt: Int)
    }

    // MARK: - Public Properties

    public private(set) var connectionState: ConnectionState = .disconnected
    public private(set) var lastEvent: RelayObserverEvent?
    public private(set) var eventCounter: Int = 0
    public weak var delegate: RelayObserverDelegate?

    // MARK: - AsyncStream

    public var events: AsyncStream<RelayObserverEvent> {
        if let existingContinuation = eventsContinuation {
            _ = existingContinuation // already wired
            return AsyncStream { continuation in
                self.eventsContinuation = continuation
            }
        }
        return AsyncStream { continuation in
            self.eventsContinuation = continuation
        }
    }

    // MARK: - Private Properties

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private let maxReconnectAttempts: Int
    private let baseReconnectDelay: TimeInterval
    private var reconnectAttempts: Int = 0
    private var reconnectTask: Task<Void, Never>?
    private var subscribedChannel: String?
    private var pendingOutbound: [String] = []
    private var isConnectionReady: Bool = false
    private var activeURL: URL?
    private var eventsContinuation: AsyncStream<RelayObserverEvent>.Continuation?

    private let jsonEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    private let jsonDecoder: JSONDecoder = {
        // NOT using convertFromSnakeCase — we use explicit CodingKeys
        // because of dual-name fields (name/agent_name, step/step_name)
        let decoder = JSONDecoder()
        return decoder
    }()

    // MARK: - Init

    public init(maxReconnectAttempts: Int = 8, baseReconnectDelay: TimeInterval = 1.0) {
        self.maxReconnectAttempts = maxReconnectAttempts
        self.baseReconnectDelay = baseReconnectDelay
        super.init()
    }

    // MARK: - Public Methods

    /// Connect to a WebSocket proxy URL and subscribe to a channel on open.
    public func connect(url: URL, channel: String) {
        self.subscribedChannel = channel
        openSocket(url: url)
    }

    /// Connect to a WebSocket proxy URL without channel subscription.
    public func connect(url: URL) {
        self.subscribedChannel = nil
        openSocket(url: url)
    }

    /// Disconnect — closes socket, cancels reconnect, clears state.
    public func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempts = 0
        isConnectionReady = false
        subscribedChannel = nil
        pendingOutbound.removeAll()
        closeSocket(code: .goingAway, reason: nil)
        connectionState = .disconnected
        eventsContinuation?.finish()
        eventsContinuation = nil
    }

    /// Send a message to a channel through the proxy.
    public func sendChannel(
        channel: String,
        text: String,
        personas: [String]? = nil,
        cliPreferences: [String: String]? = nil
    ) throws {
        let msg = ObserverChannelSendMessage(
            channel: channel,
            text: text,
            personas: personas,
            cliPreferences: cliPreferences
        )
        try sendEncodable(msg)
    }

    /// Send a direct message to a specific agent through the proxy.
    public func sendDirect(to: String, text: String) throws {
        let msg = ObserverDirectSendMessage(to: to, text: text)
        try sendEncodable(msg)
    }

    // MARK: - Private Methods

    private func openSocket(url: URL) {
        closeSocket(code: .goingAway, reason: nil)
        activeURL = url
        connectionState = .connecting
        isConnectionReady = false

        let session = URLSession(
            configuration: .default,
            delegate: self,
            delegateQueue: nil
        )
        self.urlSession = session
        let task = session.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()
        scheduleReceive()
    }

    private func closeSocket(code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        webSocketTask?.cancel(with: code, reason: reason)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    private func scheduleReceive() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.handleMessage(message)
                self.scheduleReceive()
            case .failure(let error):
                self.handleSocketError(error)
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text):
            guard let d = text.data(using: .utf8) else { return }
            data = d
        case .data(let d):
            data = d
        @unknown default:
            return
        }

        guard let event = try? jsonDecoder.decode(RelayObserverEvent.self, from: data) else { return }

        lastEvent = event
        eventCounter += 1

        if let delegate {
            Task { @MainActor in
                delegate.relayObserver(self, didReceiveEvent: event)
            }
        }

        eventsContinuation?.yield(event)
    }

    private func handleSocketError(_ error: Error) {
        guard reconnectAttempts < maxReconnectAttempts else {
            connectionState = .disconnected
            let delegate = self.delegate
            Task { @MainActor in
                delegate?.relayObserverDidDisconnect(self, error: error)
            }
            return
        }

        reconnectAttempts += 1
        connectionState = .reconnecting(attempt: reconnectAttempts)

        let delay = baseReconnectDelay * pow(2.0, Double(reconnectAttempts - 1))

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, let url = self.activeURL else { return }
            self.openSocket(url: url)
        }
    }

    private func sendSubscription() {
        guard let channel = subscribedChannel else { return }
        let msg = ObserverSubscribeMessage(channel: channel)
        if let data = try? jsonEncoder.encode(msg),
           let str = String(data: data, encoding: .utf8) {
            webSocketTask?.send(.string(str)) { _ in }
        }
    }

    private func sendEncodable<T: Encodable>(_ value: T) throws {
        guard let task = webSocketTask else {
            throw RelayObserverError.notConnected
        }
        guard let data = try? jsonEncoder.encode(value),
              let str = String(data: data, encoding: .utf8) else {
            throw RelayObserverError.encodingFailed
        }

        if isConnectionReady {
            task.send(.string(str)) { _ in }
        } else {
            pendingOutbound.append(str)
        }
    }

    private func flushPendingOutbound() {
        guard let task = webSocketTask else { return }
        for str in pendingOutbound {
            task.send(.string(str)) { _ in }
        }
        pendingOutbound.removeAll()
    }

    // MARK: - URLSessionWebSocketDelegate

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        connectionState = .connected
        reconnectAttempts = 0
        isConnectionReady = true

        flushPendingOutbound()
        sendSubscription()

        let delegate = self.delegate
        Task { @MainActor in
            delegate?.relayObserverDidConnect(self)
        }
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        isConnectionReady = false

        if closeCode != .goingAway && closeCode != .normalClosure {
            handleSocketError(
                NSError(
                    domain: "RelayObserver",
                    code: Int(closeCode.rawValue),
                    userInfo: [NSLocalizedDescriptionKey: "WebSocket closed with code \(closeCode.rawValue)"]
                )
            )
        } else {
            connectionState = .disconnected
            let delegate = self.delegate
            Task { @MainActor in
                delegate?.relayObserverDidDisconnect(self, error: nil)
            }
        }
    }
}
