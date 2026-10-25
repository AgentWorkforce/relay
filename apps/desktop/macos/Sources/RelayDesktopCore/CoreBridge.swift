import Darwin
import Foundation

/// A failed bridge call. `kind` is the contract's stable code; `message` is
/// the core's sentence, safe to show a person.
public struct CoreError: Error, LocalizedError, Equatable, Sendable {
    public let kind: String
    public let message: String
    public let retryable: Bool

    public init(kind: String, message: String, retryable: Bool = false) {
        self.kind = kind
        self.message = message
        self.retryable = retryable
    }

    public var errorDescription: String? { message }

    /// The core could not be reached at all.
    public static func unreachable(_ detail: String) -> CoreError {
        CoreError(kind: "core_unreachable", message: "Agent Relay's background service is not running. \(detail)", retryable: true)
    }

    public static let closed = CoreError(kind: "core_unreachable", message: "Agent Relay's background service stopped.", retryable: true)
    public static let starting = CoreError(kind: "core_unreachable", message: "Agent Relay is starting. Try again in a moment.", retryable: true)
    public static let reconnecting = CoreError(kind: "core_unreachable", message: "Agent Relay is reconnecting to its background service. Try again in a moment.", retryable: true)
    public static let interrupted = CoreError(kind: "core_unreachable", message: "Connection to Agent Relay was interrupted. Check whether the action completed before trying again.")
}

/// One NDJSON JSON-RPC 2.0 connection to the core's Unix socket.
///
/// Requests are answered in order on a connection, so a slow call holds
/// only its own connection: `CoreClient` keeps a pool. A reader thread
/// splits the socket into lines; replies resume their callers and event
/// notifications go to `onEvent`.
final class CoreConnection: @unchecked Sendable {
    static let maximumLine = 1 << 20

    private let fd: Int32
    private let lock = NSLock()
    private let writeLock = NSLock()
    private var nextID = 0
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var closed = false
    private var eventHandler: (@Sendable (String, Data) -> Void)?
    private var closeHandler: (@Sendable () -> Void)?
    /// Read by the reader thread, set by the subscriber: under the lock.
    var onEvent: (@Sendable (String, Data) -> Void)? {
        get { lock.withLock { eventHandler } }
        set { lock.withLock { if !closed { eventHandler = newValue } } }
    }
    var onClose: (@Sendable () -> Void)? {
        get { lock.withLock { closeHandler } }
        set { lock.withLock { if !closed { closeHandler = newValue } } }
    }

    init(path: String) throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CoreError.unreachable("No socket could be created.") }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count < capacity else {
            abandon()
            throw CoreError.unreachable("The socket path is too long.")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        // A full Unix-socket backlog must not block the main actor. A
        // connection not ready immediately is retried by the connect loop.
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else {
            abandon()
            throw CoreError.unreachable("The socket could not be configured.")
        }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0, fcntl(fd, F_SETFL, flags) == 0 else {
            abandon()
            throw CoreError.unreachable("Nothing is listening yet.")
        }
        let thread = Thread { self.readLoop() }
        thread.name = "relay-core-reader"
        thread.start()
    }

    deinit { close() }

    /// Closes the socket of an initializer that is about to throw. Swift
    /// still runs `deinit` for it, so it is marked closed first: closing the
    /// number again there would close whatever another thread opened with it
    /// meanwhile (another connection, a listener).
    private func abandon() {
        closed = true
        Darwin.close(fd)
    }

    func close(error: Error = CoreError.closed) {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let waiting = pending
        pending = [:]
        // The callbacks hold the subscription's stream, whose termination
        // holds this connection: dropping them breaks the cycle.
        let ended = closeHandler
        closeHandler = nil
        eventHandler = nil
        lock.unlock()
        // Wake I/O now; the reader owns the final close. Closing the descriptor
        // here could let an in-flight writer use a reused descriptor after a
        // timeout. The reader waits for that writer before releasing it.
        shutdown(fd, SHUT_RDWR)
        for continuation in waiting.values { continuation.resume(throwing: error) }
        ended?()
    }

    var isClosed: Bool {
        lock.lock(); defer { lock.unlock() }
        return closed
    }

    /// Sends one request and returns its `result` as JSON.
    func request(_ method: String, params: Any? = nil, timeout: TimeInterval = 30) async throws -> Data {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if closed {
                    lock.unlock()
                    continuation.resume(throwing: CoreError.closed)
                    return
                }
                nextID += 1
                let id = nextID
                var envelope: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
                envelope["params"] = params ?? [String: Any]()
                guard var line = try? JSONSerialization.data(withJSONObject: envelope) else {
                    lock.unlock()
                    continuation.resume(throwing: CoreError(kind: "invalid_params", message: "The request could not be encoded."))
                    return
                }
                pending[id] = continuation
                lock.unlock()
                line.append(0x0A)
                // This closes only this request's connection. A late answer must
                // never return it to the pool or complete the continuation twice.
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                    self?.expire(id)
                }
                if Task.isCancelled { close(error: CancellationError()); return }
                if !writeAll(line) { close() }
            }
        } onCancel: {
            self.close(error: CancellationError())
        }
    }

    private func expire(_ id: Int) {
        lock.lock()
        guard let continuation = pending.removeValue(forKey: id) else { lock.unlock(); return }
        lock.unlock()
        let error = CoreError(kind: "core_timeout",
                              message: "The background service took too long to respond. Try again.", retryable: true)
        close(error: error)
        continuation.resume(throwing: error)
    }

    private func writeAll(_ data: Data) -> Bool {
        writeLock.lock()
        defer { writeLock.unlock() }
        guard !isClosed else { return false }
        return data.withUnsafeBytes { raw -> Bool in
            guard var pointer = raw.baseAddress else { return true }
            var remaining = raw.count
            while remaining > 0 {
                let written = Darwin.write(fd, pointer, remaining)
                if written < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                remaining -= written
                pointer = pointer.advanced(by: written)
            }
            return true
        }
    }

    private func readLoop() {
        defer { writeLock.withLock { _ = Darwin.close(fd) } }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(fd, &chunk, chunk.count)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { break }
            buffer.append(chunk, count: count)
            while let newline = buffer.firstIndex(of: 0x0A) {
                // This reader lives as long as its pooled/subscribed socket.
                // Foundation's JSON reader/writer creates autoreleased objects;
                // drain them per frame instead of retaining every past reply
                // until the thread exits. Returned data/events retain their
                // own storage beyond this pool.
                autoreleasepool {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer = Data(buffer[buffer.index(after: newline)...])
                    handle(Data(line))
                }
            }
            if buffer.count > Self.maximumLine { break }
        }
        close()
    }

    private func handle(_ line: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
        if let method = object["method"] as? String {
            guard method == CoreMethod.event, let params = object["params"] as? [String: Any],
                  let topic = params["topic"] as? String else { return }
            let data = params["data"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) } ?? Data("{}".utf8)
            onEvent?(topic, data)
            return
        }
        guard let id = object["id"] as? Int else { return }
        lock.lock()
        let continuation = pending.removeValue(forKey: id)
        lock.unlock()
        guard let continuation else { return }
        if let error = object["error"] as? [String: Any] {
            let data = error["data"] as? [String: Any]
            continuation.resume(throwing: CoreError(
                kind: data?["kind"] as? String ?? "internal",
                message: error["message"] as? String ?? "Agent Relay hit a problem.",
                retryable: data?["retryable"] as? Bool ?? false
            ))
            return
        }
        let result = object["result"] ?? NSNull()
        let data = (try? JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])) ?? Data("null".utf8)
        continuation.resume(returning: data)
    }
}

/// The app's client of the relay core: calls over a pool of greeted
/// connections, and one subscribed connection for events.
public final class CoreClient: @unchecked Sendable {
    public let socketPath: String
    private let lock = NSLock()
    private var idle: [CoreConnection] = []
    private var methods: Set<String> = []
    private static let poolLimit = 4
    private static let readRecoveryWindow: TimeInterval = 5

    private let requestTimeout: TimeInterval?

    public init(socketPath: String, requestTimeout: TimeInterval? = nil) {
        self.socketPath = socketPath
        self.requestTimeout = requestTimeout
    }

    /// Reads should never hide a stalled service behind a spinner. Commands
    /// retain the core's existing long-operation budget (uploader start can
    /// take 10.5 minutes); they are never automatically replayed on timeout.
    /// Only audited, repeatable contract reads may run again after a socket
    /// closes. A new method is treated as a command until reviewed here and
    /// in the Linux bridge, regardless of its name.
    private static let repeatableReads: Set<String> = [
        CoreMethod.diagnosticsRequests, CoreMethod.statusGet, CoreMethod.accountStatus,
        CoreMethod.uploaderStatus, CoreMethod.uploaderSessionsList, CoreMethod.uploaderSessionsPreview,
        CoreMethod.sessionsTranscript, CoreMethod.sessionsList, CoreMethod.sessionsTitleCapability, CoreMethod.spawnTargets,
        CoreMethod.spawnStatus, CoreMethod.agentsList, CoreMethod.agentsTranscript,
        CoreMethod.settingsGet, CoreMethod.activityList, CoreMethod.claudeDeliveryStatus,
        CoreMethod.openclawRelayToolsStatus,
        CoreMethod.rosterList, CoreMethod.rosterGet, CoreMethod.fleetList,
        CoreMethod.cursorCloudModelsList, CoreMethod.cursorCloudRepositoriesList,
        CoreMethod.cursorCloudEnvironmentsList, CoreMethod.cursorCloudAgentsList,
        CoreMethod.cursorCloudAgentsGet, CoreMethod.cursorCloudRunsList, CoreMethod.cursorCloudRunsGet,
        CoreMethod.replicasEnvironmentsList, CoreMethod.replicasSpawnGet,
        CoreMethod.capyProjectsList, CoreMethod.capyThreadsGet,
        CoreMethod.messagesConversations, CoreMethod.messagesHistory,
        CoreMethod.sessionsOverviewGet, CoreMethod.sessionsOverviewEvents,
        CoreMethod.peopleList, CoreMethod.linksParse, CoreMethod.loginItemStatus,
        CoreMethod.incomingStatus, CoreMethod.chatConversation, CoreMethod.chatHistory,
        CoreMethod.chatProjects, CoreMethod.contractorsStatus,
    ]

    static func isRead(_ method: String) -> Bool { repeatableReads.contains(method) }

    private static func isRestarting(_ error: CoreError) -> Bool {
        error.kind == "core_unreachable" || error.kind == ErrorKind.shuttingDown.rawValue
    }

    static func timeout(for method: String) -> TimeInterval {
        if [CoreMethod.hello, CoreMethod.subscribe, CoreMethod.daemonShutdown].contains(method) { return 5 }
        if isRead(method) { return 30 }
        return 11 * 60
    }

    private func deadline(_ method: String) -> TimeInterval { requestTimeout ?? Self.timeout(for: method) }

    private var recoveryError: CoreError {
        lock.withLock { methods.isEmpty } ? .starting : .reconnecting
    }

    /// Contract types carry their own wire keys. A coder is made per use:
    /// calls run concurrently, and coders are not documented as thread-safe.
    static var decoder: JSONDecoder { JSONDecoder() }
    static var encoder: JSONEncoder { JSONEncoder() }

    /// Whether the running core offers `method` (from `hello`).
    public func offers(_ method: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return methods.contains(method)
    }

    private func greeted() throws -> CoreConnection {
        try CoreConnection(path: socketPath)
    }

    private func hello(_ connection: CoreConnection, timeout: TimeInterval? = nil) async throws -> HelloResult {
        let data = try await connection.request(CoreMethod.hello, params: try Self.object(HelloParams(bridgeVersion: CoreBridgeVersion.current)), timeout: timeout ?? deadline(CoreMethod.hello))
        let hello = try Self.decoder.decode(HelloResult.self, from: data)
        guard hello.bridgeVersion == CoreBridgeVersion.current else {
            throw CoreError(kind: "bridge_version_mismatch", message: "Agent Relay's background service is a different version.")
        }
        lock.withLock { methods = Set(hello.methods) }
        return hello
    }

    private func checkout(recoverUntil: TimeInterval? = nil) async throws -> CoreConnection {
        let reused: CoreConnection? = lock.withLock {
            while let connection = idle.popLast() { if !connection.isClosed { return connection } }
            return nil
        }
        if let reused { return reused }
        let connection = try greeted()
        do {
            let timeout = recoverUntil.map {
                min(deadline(CoreMethod.hello), max(0.001, $0 - ProcessInfo.processInfo.systemUptime))
            }
            _ = try await hello(connection, timeout: timeout)
            return connection
        } catch {
            connection.close()
            throw error
        }
    }

    private func checkin(_ connection: CoreConnection) {
        guard !connection.isClosed else { return }
        lock.lock()
        if idle.count < Self.poolLimit {
            idle.append(connection)
            lock.unlock()
        } else {
            lock.unlock()
            connection.close()
        }
    }

    /// `params` as the JSON object a request carries.
    static func object<P: Encodable>(_ params: P) throws -> Any {
        do {
            return try JSONSerialization.jsonObject(with: encoder.encode(params))
        } catch {
            throw CoreError(kind: ErrorKind.invalidParams.rawValue, message: "The request could not be encoded.")
        }
    }

    /// Calls `method` on a pooled connection. The generated typed calls
    /// (`agentsList()`, …) are the way in; this is their transport.
    func call<P: Encodable, R: Decodable>(_ method: String, _ params: P) async throws -> R {
        let object = try Self.object(params)
        let data: Data
        let read = Self.isRead(method)
        // A slow read gets its full ordinary timeout. Recovery begins only
        // when that read is actually interrupted by a restart.
        var recoverUntil: TimeInterval?
        while true {
            let connection: CoreConnection
            do {
                if let recoverUntil, ProcessInfo.processInfo.systemUptime >= recoverUntil {
                    throw recoveryError
                }
                connection = try await checkout(recoverUntil: recoverUntil)
            } catch let error as CoreError where Self.isRestarting(error) || (recoverUntil != nil && error.kind == "core_timeout") {
                guard read else { throw recoveryError }
                if recoverUntil == nil {
                    recoverUntil = ProcessInfo.processInfo.systemUptime + Self.readRecoveryWindow
                }
                guard let recoverUntil, ProcessInfo.processInfo.systemUptime < recoverUntil else { throw recoveryError }
                try await Task.sleep(for: .milliseconds(200))
                continue
            }
            do {
                let timeout = recoverUntil.map {
                    min(deadline(method), max(0.001, $0 - ProcessInfo.processInfo.systemUptime))
                } ?? deadline(method)
                data = try await connection.request(method, params: object, timeout: timeout)
                checkin(connection)
                break
            } catch let error as CoreError where !Self.isRestarting(error) {
                checkin(connection)
                if let recoverUntil, ProcessInfo.processInfo.systemUptime >= recoverUntil {
                    throw recoveryError
                }
                throw error
            } catch is CancellationError {
                connection.close(error: CancellationError())
                throw CancellationError()
            } catch {
                connection.close()
                guard read else { throw CoreError.interrupted }
                if recoverUntil == nil {
                    recoverUntil = ProcessInfo.processInfo.systemUptime + Self.readRecoveryWindow
                }
                guard let recoverUntil, ProcessInfo.processInfo.systemUptime < recoverUntil else { throw recoveryError }
                try await Task.sleep(for: .milliseconds(200))
            }
        }
        do {
            return try Self.decoder.decode(R.self, from: data)
        } catch {
            throw CoreError(kind: "malformed_result", message: "Agent Relay could not read the answer to \(method).")
        }
    }

    /// Asks a daemon of another bridge version to stop, without a handshake;
    /// the host starts this app's own.
    public func shutdownDaemon() async {
        guard let connection = try? greeted() else { return }
        _ = try? await connection.request(CoreMethod.daemonShutdown, timeout: deadline(CoreMethod.daemonShutdown))
        connection.close()
    }

    /// Closes every pooled connection.
    public func reset() {
        lock.lock()
        let connections = idle
        idle = []
        lock.unlock()
        connections.forEach { $0.close() }
    }

    /// Greets and subscribes one connection. Events arrive on the returned
    /// stream, beginning with the current snapshot, until the connection
    /// closes; then the stream finishes.
    public func subscribe(topics: [Topic]) async throws -> (hello: HelloResult, events: AsyncStream<CoreEvent>) {
        let connection = try greeted()
        let (stream, continuation) = AsyncStream<CoreEvent>.makeStream(bufferingPolicy: .unbounded)
        connection.onEvent = { topic, data in
            if let event = CoreEvent.decode(topic: topic, data: data) { continuation.yield(event) }
        }
        connection.onClose = { continuation.finish() }
        continuation.onTermination = { _ in connection.close() }
        let hello: HelloResult
        do {
            hello = try await self.hello(connection)
            let data = try await connection.request(CoreMethod.subscribe, params: try Self.object(TopicsParams(topics: topics)), timeout: deadline(CoreMethod.subscribe))
            let subscribed = try Self.decoder.decode(Subscribed.self, from: data)
            continuation.yield(.status(subscribed.status))
        } catch {
            connection.close()
            throw error
        }
        return (hello, stream)
    }
}
