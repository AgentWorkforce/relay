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

    // MARK: - Public Properties (thread-safe via queue)

    public var connectionState: ConnectionState {
        queue.sync { _connectionState }
    }
    public var lastEvent: RelayObserverEvent? {
        queue.sync { _lastEvent }
    }
    public var eventCounter: Int {
        queue.sync { _eventCounter }
    }
    public weak var delegate: RelayObserverDelegate?

    // MARK: - AsyncStream

    public var events: AsyncStream<RelayObserverEvent> {
        queue.sync {
            _eventsContinuation?.finish()
            return AsyncStream { continuation in
                self._eventsContinuation = continuation
            }
        }
    }

    // MARK: - Private Properties

    private let queue = DispatchQueue(label: "com.agentrelay.observer", qos: .userInitiated)
    private var _connectionState: ConnectionState = .disconnected
    private var _lastEvent: RelayObserverEvent?
    private var _eventCounter: Int = 0
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
    private var _eventsContinuation: AsyncStream<RelayObserverEvent>.Continuation?

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
        queue.sync {
            self.subscribedChannel = channel
            self._openSocket(url: url)
        }
    }

    /// Connect to a WebSocket proxy URL without channel subscription.
    public func connect(url: URL) {
        queue.sync {
            self.subscribedChannel = nil
            self._openSocket(url: url)
        }
    }

    /// Disconnect — closes socket, cancels reconnect, clears state.
    public func disconnect() {
        queue.sync {
            reconnectTask?.cancel()
            reconnectTask = nil
            reconnectAttempts = 0
            isConnectionReady = false
            subscribedChannel = nil
            pendingOutbound.removeAll()
            activeURL = nil
            _closeSocket(code: .goingAway, reason: nil)
            _connectionState = .disconnected
            _eventsContinuation?.finish()
            _eventsContinuation = nil
        }
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
        try queue.sync {
            try _sendEncodable(msg)
        }
    }

    /// Send a direct message to a specific agent through the proxy.
    public func sendDirect(to: String, text: String) throws {
        let msg = ObserverDirectSendMessage(to: to, text: text)
        try queue.sync {
            try _sendEncodable(msg)
        }
    }

    // MARK: - Private Methods (must be called on queue)

    private func _openSocket(url: URL) {
        _closeSocket(code: .goingAway, reason: nil)
        activeURL = url
        _connectionState = .connecting
        isConnectionReady = false

        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = queue
        delegateQueue.maxConcurrentOperationCount = 1

        let session = URLSession(
            configuration: .default,
            delegate: self,
            delegateQueue: delegateQueue
        )
        self.urlSession = session
        let task = session.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()
        _scheduleReceive()
    }

    private func _closeSocket(code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        webSocketTask?.cancel(with: code, reason: reason)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    private func _scheduleReceive() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            // Callback arrives on our queue via delegateQueue
            switch result {
            case .success(let message):
                self._handleMessage(message)
                self._scheduleReceive()
            case .failure(let error):
                self._handleSocketError(error)
            }
        }
    }

    private func _handleMessage(_ message: URLSessionWebSocketTask.Message) {
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

        _lastEvent = event
        _eventCounter += 1

        if let delegate {
            Task { @MainActor in
                delegate.relayObserver(self, didReceiveEvent: event)
            }
        }

        _eventsContinuation?.yield(event)
    }

    private func _handleSocketError(_ error: Error) {
        guard reconnectAttempts < maxReconnectAttempts else {
            _connectionState = .disconnected
            let delegate = self.delegate
            Task { @MainActor in
                delegate?.relayObserverDidDisconnect(self, error: error)
            }
            return
        }

        reconnectAttempts += 1
        _connectionState = .reconnecting(attempt: reconnectAttempts)

        let delay = baseReconnectDelay * pow(2.0, Double(reconnectAttempts - 1))

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.queue.sync {
                guard let url = self.activeURL else { return }
                self._openSocket(url: url)
            }
        }
    }

    private func _sendSubscription() {
        guard let channel = subscribedChannel else { return }
        let msg = ObserverSubscribeMessage(channel: channel)
        if let data = try? jsonEncoder.encode(msg),
           let str = String(data: data, encoding: .utf8) {
            webSocketTask?.send(.string(str)) { _ in }
        }
    }

    private func _sendEncodable<T: Encodable>(_ value: T) throws {
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

    private func _flushPendingOutbound() {
        guard let task = webSocketTask else { return }
        for str in pendingOutbound {
            task.send(.string(str)) { _ in }
        }
        pendingOutbound.removeAll()
    }

    // MARK: - URLSessionWebSocketDelegate (callbacks arrive on queue via delegateQueue)

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        _connectionState = .connected
        reconnectAttempts = 0
        isConnectionReady = true

        _flushPendingOutbound()
        _sendSubscription()

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
            _handleSocketError(
                NSError(
                    domain: "RelayObserver",
                    code: Int(closeCode.rawValue),
                    userInfo: [NSLocalizedDescriptionKey: "WebSocket closed with code \(closeCode.rawValue)"]
                )
            )
        } else {
            _connectionState = .disconnected
            let delegate = self.delegate
            Task { @MainActor in
                delegate?.relayObserverDidDisconnect(self, error: nil)
            }
        }
    }
}
