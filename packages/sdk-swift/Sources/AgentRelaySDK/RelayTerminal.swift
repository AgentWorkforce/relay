import Foundation

public enum RelayTerminalMode: String, Codable, Hashable, Sendable {
    case view
    case drive
    case passthrough
}

public enum RelayTerminalDeliveryMode: String, Codable, Equatable, Sendable {
    case autoInject = "auto_inject"
    case manualFlush = "manual_flush"
}

public struct RelayTerminalSnapshot: Equatable, Sendable {
    public let data: Data
    public let rows: Int
    public let columns: Int
    public let offset: UInt64

    public init(data: Data, rows: Int, columns: Int, offset: UInt64) {
        self.data = data
        self.rows = rows
        self.columns = columns
        self.offset = offset
    }
}

public struct RelayTerminalFailure: Error, Equatable, LocalizedError, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public enum RelayTerminalEvent: Equatable, Sendable {
    case ready(
        snapshot: RelayTerminalSnapshot,
        deliveryMode: RelayTerminalDeliveryMode?,
        deliveryRevision: String?
    )
    case output(data: Data, offset: UInt64?)
    case inputAcknowledged(bytesWritten: Int)
    case failure(RelayTerminalFailure)
    case closed(code: String?, message: String?)
}

public enum RelayTerminalRestorationStatus: Equatable, Sendable {
    case notRequired
    case restored
    case skippedConcurrentChange
    case unconfirmed(RelayTerminalFailure)
}

public struct RelayTerminalCloseOutcome: Equatable, Sendable {
    public let alreadyClosed: Bool
    public let remoteCloseConfirmed: Bool
    public let restoration: RelayTerminalRestorationStatus

    public init(
        alreadyClosed: Bool,
        remoteCloseConfirmed: Bool,
        restoration: RelayTerminalRestorationStatus
    ) {
        self.alreadyClosed = alreadyClosed
        self.remoteCloseConfirmed = remoteCloseConfirmed
        self.restoration = restoration
    }
}

public struct RelayTerminalTarget: Equatable, Sendable {
    public let nodeId: String
    public let nodeName: String
    public let agentId: String
    public let agentName: String
    public let sessionRef: String?

    public init(
        nodeId: String,
        nodeName: String,
        agentId: String,
        agentName: String,
        sessionRef: String?
    ) {
        self.nodeId = nodeId
        self.nodeName = nodeName
        self.agentId = agentId
        self.agentName = agentName
        self.sessionRef = sessionRef
    }
}

/// Fleet terminal entry point available on every hosted `AgentClient`.
/// Authentication uses that client's scoped participant credential.
public struct RelayTerminals: Sendable {
    let core: HostedParticipantCore
    let rest: RelayRestClient

    public func resolve(agent: String) async throws -> RelayTerminalTarget {
        try await core.terminalTarget(agent: agent)
    }

    /// Resolve the live fleet node hosting `agent`, then open a terminal there.
    /// Applications do not need to reproduce fleet placement discovery.
    public func open(
        agent: String,
        mode: RelayTerminalMode
    ) async throws -> RelayTerminalSession {
        let target = try await resolve(agent: agent)
        return try await open(node: target.nodeName, agent: target.agentName, mode: mode)
    }

    public func open(
        node: String,
        agent: String,
        mode: RelayTerminalMode
    ) async throws -> RelayTerminalSession {
        let cleanNode = node.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanAgent = HostedParticipantCore.normalizeTerminalAgent(agent)
        guard !cleanNode.isEmpty, !cleanAgent.isEmpty else {
            throw RelayError.protocolError(
                code: "invalid_terminal_target",
                message: "Terminal node and agent names cannot be empty",
                retryable: false
            )
        }
        let ticket = try await rest.createTerminalSession(
            node: cleanNode,
            agent: cleanAgent,
            mode: mode
        )
        return try await RelayTerminalSession.open(
            ticket: ticket,
            node: cleanNode,
            agent: cleanAgent,
            mode: mode,
            baseURL: rest.baseURL,
            urlSession: rest.session
        )
    }
}

/// A broker-backed terminal session. The SDK owns the ticket, websocket,
/// reconnect, input ordering, authoritative snapshots, and delivery-mode
/// restoration; applications provide only a renderer and user intent.
public final class RelayTerminalSession: @unchecked Sendable {
    public let id: String
    public let node: String
    public let agent: String
    public let mode: RelayTerminalMode
    public let initialSnapshot: RelayTerminalSnapshot

    private let core: RelayTerminalCore

    private init(
        id: String,
        node: String,
        agent: String,
        mode: RelayTerminalMode,
        initialSnapshot: RelayTerminalSnapshot,
        core: RelayTerminalCore
    ) {
        self.id = id
        self.node = node
        self.agent = agent
        self.mode = mode
        self.initialSnapshot = initialSnapshot
        self.core = core
    }

    static func open(
        ticket: RelayTerminalTicket,
        node: String,
        agent: String,
        mode: RelayTerminalMode,
        baseURL: URL,
        urlSession: URLSession
    ) async throws -> RelayTerminalSession {
        let core = try RelayTerminalCore(
            ticket: ticket,
            mode: mode,
            baseURL: baseURL,
            urlSession: urlSession
        )
        let ready = try await core.connect()
        if mode != .view {
            try await core.acquireDrive(previous: ready)
        }
        return RelayTerminalSession(
            id: ticket.sessionId,
            node: node,
            agent: agent,
            mode: mode,
            initialSnapshot: ready.snapshot,
            core: core
        )
    }

    public func events() async -> AsyncThrowingStream<RelayTerminalEvent, Error> {
        await core.events()
    }

    public func snapshot() async throws -> RelayTerminalSnapshot {
        try await core.snapshot()
    }

    public func sendInput(_ data: Data) async throws {
        guard mode != .view else {
            throw RelayTerminalFailure(code: "read_only", message: "View terminal sessions cannot send input")
        }
        try await core.sendInput(data)
    }

    public func resize(rows: Int, columns: Int) async throws {
        guard mode != .view else {
            throw RelayTerminalFailure(code: "read_only", message: "View terminal sessions cannot resize the PTY")
        }
        guard rows > 0, rows <= Int(UInt16.max), columns > 0, columns <= Int(UInt16.max) else {
            throw RelayTerminalFailure(code: "invalid_dimensions", message: "Terminal dimensions must be positive 16-bit integers")
        }
        try await core.resize(rows: rows, columns: columns)
    }

    public func close() async -> RelayTerminalCloseOutcome {
        await core.close()
    }
}

private struct RelayTerminalReady: Sendable {
    let snapshot: RelayTerminalSnapshot
    let deliveryMode: RelayTerminalDeliveryMode?
    let deliveryRevision: String?
}

private struct RelayTerminalWireFrame: Decodable {
    let type: String
    let sessionId: String?
    let requestId: String?
    let screen: String?
    let chunk: String?
    let rows: Int?
    let columns: Int?
    let offset: UInt64?
    let bytesWritten: Int?
    let code: String?
    let message: String?
    let deliveryMode: RelayTerminalDeliveryMode?
    let mode: RelayTerminalDeliveryMode?
    let deliveryRevision: String?
    let revision: String?
    let matched: Bool?

    enum CodingKeys: String, CodingKey {
        case type, screen, chunk, rows, offset, code, message, mode, revision, matched
        case sessionId = "session_id"
        case requestId = "request_id"
        case columns = "cols"
        case bytesWritten = "bytes_written"
        case deliveryMode = "delivery_mode"
        case deliveryRevision = "delivery_revision"
    }

    var snapshot: RelayTerminalSnapshot? {
        guard let screen, let rows, let columns else { return nil }
        return RelayTerminalSnapshot(
            data: Data(screen.utf8),
            rows: rows,
            columns: columns,
            offset: offset ?? 0
        )
    }
}

private struct RelayTerminalInputFrame: Encodable {
    let type = "terminal.input"
    let sessionId: String
    let dataBase64: String

    enum CodingKeys: String, CodingKey {
        case type
        case sessionId = "session_id"
        case dataBase64 = "data_base64"
    }
}

private struct RelayTerminalResizeFrame: Encodable {
    let type = "terminal.resize"
    let sessionId: String
    let rows: Int
    let columns: Int

    enum CodingKeys: String, CodingKey {
        case type, rows
        case sessionId = "session_id"
        case columns = "cols"
    }
}

private struct RelayTerminalSnapshotFrame: Encodable {
    let type = "terminal.snapshot"
    let sessionId: String
    let requestId: String

    enum CodingKeys: String, CodingKey {
        case type
        case sessionId = "session_id"
        case requestId = "request_id"
    }
}

private struct RelayTerminalSetDeliveryModeFrame: Encodable {
    let type = "terminal.set_delivery_mode"
    let sessionId: String
    let requestId: String
    let mode: RelayTerminalDeliveryMode
    let expectedMode: RelayTerminalDeliveryMode?
    let expectedRevision: String?

    enum CodingKeys: String, CodingKey {
        case type, mode
        case sessionId = "session_id"
        case requestId = "request_id"
        case expectedMode = "expected_mode"
        case expectedRevision = "expected_revision"
    }
}

private struct RelayTerminalCloseFrame: Encodable {
    let type = "terminal.close"
    let sessionId: String

    enum CodingKeys: String, CodingKey {
        case type
        case sessionId = "session_id"
    }
}

private struct RelayTerminalDeliveryModeResult: Sendable {
    let mode: RelayTerminalDeliveryMode
    let matched: Bool
    let revision: String
}

private actor RelayTerminalCore {
    private let ticket: RelayTerminalTicket
    private let mode: RelayTerminalMode
    private let baseURL: URL
    private let urlSession: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let stream: AsyncThrowingStream<RelayTerminalEvent, Error>
    private let continuation: AsyncThrowingStream<RelayTerminalEvent, Error>.Continuation

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var closed = false
    private var closeReported = false
    private var inputContinuation: CheckedContinuation<Void, Error>?
    private var inputTimeoutTask: Task<Void, Never>?
    private var inputUncertainty: RelayTerminalFailure?
    private var snapshotContinuations: [String: CheckedContinuation<RelayTerminalSnapshot, Error>] = [:]
    private var snapshotTimeoutTasks: [String: Task<Void, Never>] = [:]
    private var deliveryContinuations: [String: CheckedContinuation<RelayTerminalDeliveryModeResult, Error>] = [:]
    private var deliveryTimeoutTasks: [String: Task<Void, Never>] = [:]
    private var closeContinuation: CheckedContinuation<Bool, Never>?
    private var closeTimeoutTask: Task<Void, Never>?
    private var closeInProgress = false
    private var closeWaiters: [CheckedContinuation<RelayTerminalCloseOutcome, Never>] = []
    private var completedCloseOutcome: RelayTerminalCloseOutcome?
    private var priorDeliveryMode: RelayTerminalDeliveryMode?
    private var assertedDeliveryMode: RelayTerminalDeliveryMode?
    private var assertedDeliveryRevision: String?

    init(
        ticket: RelayTerminalTicket,
        mode: RelayTerminalMode,
        baseURL: URL,
        urlSession: URLSession
    ) throws {
        guard let terminalURL = URL(string: ticket.terminalUrl) else {
            throw RelayError.protocolError(
                code: "invalid_terminal_url",
                message: "Terminal session response contained an invalid URL",
                retryable: false
            )
        }
        guard Self.sameOrigin(terminalURL, baseURL) else {
            throw RelayError.protocolError(
                code: "invalid_terminal_origin",
                message: "Terminal session URL did not match the configured Relay origin",
                retryable: false
            )
        }
        self.ticket = ticket
        self.mode = mode
        self.baseURL = baseURL
        self.urlSession = urlSession
        var captured: AsyncThrowingStream<RelayTerminalEvent, Error>.Continuation!
        stream = AsyncThrowingStream(bufferingPolicy: .bufferingNewest(256)) { captured = $0 }
        continuation = captured
    }

    func events() -> AsyncThrowingStream<RelayTerminalEvent, Error> { stream }

    func connect() async throws -> RelayTerminalReady {
        let ready: RelayTerminalReady
        do {
            ready = try await openSocket(url: try websocketURL(ticket.terminalUrl))
        } catch let failure as RelayTerminalFailure {
            throw failure
        } catch let error as RelayError {
            throw error
        } catch {
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
            throw RelayTerminalFailure(
                code: "node_unreachable",
                message: "Terminal transport could not connect to the fleet node"
            )
        }
        yield(.ready(
            snapshot: ready.snapshot,
            deliveryMode: ready.deliveryMode,
            deliveryRevision: ready.deliveryRevision
        ))
        startReceiveLoop()
        return ready
    }

    func acquireDrive(previous: RelayTerminalReady) async throws {
        guard let previousMode = previous.deliveryMode,
              let previousRevision = previous.deliveryRevision else {
            _ = await close()
            throw RelayTerminalFailure(
                code: "delivery_mode_unavailable",
                message: "The broker did not provide delivery-mode state required for safe drive attach"
            )
        }
        priorDeliveryMode = previousMode
        let result: RelayTerminalDeliveryModeResult
        do {
            result = try await setDeliveryMode(
                .autoInject,
                expectedMode: previousMode,
                expectedRevision: previousRevision
            )
        } catch {
            _ = await close()
            throw error
        }
        guard result.matched else {
            _ = await close()
            throw RelayTerminalFailure(
                code: "delivery_mode_conflict",
                message: "The terminal delivery mode changed while drive attach was opening"
            )
        }
        assertedDeliveryMode = result.mode
        assertedDeliveryRevision = result.revision
    }

    func sendInput(_ data: Data) async throws {
        try requireOpen()
        if let inputUncertainty { throw inputUncertainty }
        guard inputContinuation == nil else {
            throw RelayTerminalFailure(
                code: "input_backpressure",
                message: "A terminal input write is already awaiting acknowledgement"
            )
        }
        let frame = RelayTerminalInputFrame(
            sessionId: ticket.sessionId,
            dataBase64: data.base64EncodedString()
        )
        try await withCheckedThrowingContinuation { continuation in
            inputContinuation = continuation
            inputTimeoutTask = operationTimeoutTask { [weak self] in
                await self?.markInputUncertain(RelayTerminalFailure(
                    code: "input_timeout",
                    message: "Terminal input acknowledgement timed out"
                ))
            }
            sendRequest(frame) { [weak self] error in
                guard let error else { return }
                Task { await self?.markInputUncertain(error) }
            }
        }
    }

    func resize(rows: Int, columns: Int) async throws {
        try requireOpen()
        try await send(
            RelayTerminalResizeFrame(
                sessionId: ticket.sessionId,
                rows: rows,
                columns: columns
            )
        )
    }

    func snapshot() async throws -> RelayTerminalSnapshot {
        try requireOpen()
        let requestID = "snapshot_\(UUID().uuidString.lowercased())"
        let frame = RelayTerminalSnapshotFrame(
            sessionId: ticket.sessionId,
            requestId: requestID
        )
        return try await withCheckedThrowingContinuation { continuation in
            snapshotContinuations[requestID] = continuation
            snapshotTimeoutTasks[requestID] = operationTimeoutTask { [weak self] in
                await self?.failSnapshot(
                    requestID: requestID,
                    error: RelayTerminalFailure(
                        code: "snapshot_timeout",
                        message: "Terminal snapshot request timed out"
                    )
                )
            }
            sendRequest(frame) { [weak self] error in
                guard let error else { return }
                Task { await self?.failSnapshot(requestID: requestID, error: error) }
            }
        }
    }

    func close() async -> RelayTerminalCloseOutcome {
        if closeInProgress {
            return await withCheckedContinuation { continuation in
                closeWaiters.append(continuation)
            }
        }
        if let completedCloseOutcome {
            return RelayTerminalCloseOutcome(
                alreadyClosed: true,
                remoteCloseConfirmed: completedCloseOutcome.remoteCloseConfirmed,
                restoration: completedCloseOutcome.restoration
            )
        }
        guard !closed else {
            return RelayTerminalCloseOutcome(
                alreadyClosed: true,
                remoteCloseConfirmed: closeReported,
                restoration: mode == .view ? .notRequired : .unconfirmed(
                    RelayTerminalFailure(code: "already_closed", message: "Terminal session was already closed")
                )
            )
        }

        closeInProgress = true
        let outcome = await performClose()
        completedCloseOutcome = outcome
        closeInProgress = false
        let waiters = closeWaiters
        closeWaiters.removeAll()
        waiters.forEach { $0.resume(returning: outcome) }
        return outcome
    }

    private func performClose() async -> RelayTerminalCloseOutcome {
        let restoration: RelayTerminalRestorationStatus
        if mode == .view {
            restoration = .notRequired
        } else if let priorDeliveryMode,
                  let assertedDeliveryMode,
                  let assertedDeliveryRevision {
            do {
                let result = try await setDeliveryMode(
                    priorDeliveryMode,
                    expectedMode: assertedDeliveryMode,
                    expectedRevision: assertedDeliveryRevision
                )
                restoration = result.matched ? .restored : .skippedConcurrentChange
            } catch {
                restoration = .unconfirmed(Self.failure(error))
            }
        } else {
            restoration = .unconfirmed(
                RelayTerminalFailure(
                    code: "delivery_mode_unavailable",
                    message: "The drive session did not retain enough state to confirm restoration"
                )
            )
        }

        let remoteCloseConfirmed = await requestCloseConfirmation()
        finish()
        return RelayTerminalCloseOutcome(
            alreadyClosed: false,
            remoteCloseConfirmed: remoteCloseConfirmed,
            restoration: restoration
        )
    }

    private func setDeliveryMode(
        _ mode: RelayTerminalDeliveryMode,
        expectedMode: RelayTerminalDeliveryMode,
        expectedRevision: String
    ) async throws -> RelayTerminalDeliveryModeResult {
        try requireOpen()
        let requestID = "mode_\(UUID().uuidString.lowercased())"
        let frame = RelayTerminalSetDeliveryModeFrame(
            sessionId: ticket.sessionId,
            requestId: requestID,
            mode: mode,
            expectedMode: expectedMode,
            expectedRevision: expectedRevision
        )
        return try await withCheckedThrowingContinuation { continuation in
            deliveryContinuations[requestID] = continuation
            deliveryTimeoutTasks[requestID] = operationTimeoutTask { [weak self] in
                await self?.failDeliveryMode(
                    requestID: requestID,
                    error: RelayTerminalFailure(
                        code: "delivery_mode_timeout",
                        message: "Terminal delivery-mode request timed out"
                    )
                )
            }
            sendRequest(frame) { [weak self] error in
                guard let error else { return }
                Task { await self?.failDeliveryMode(requestID: requestID, error: error) }
            }
        }
    }

    private func startReceiveLoop() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    private func receiveLoop() async {
        var reconnectAttempt = 0
        while !closed {
            guard let socket else { return }
            do {
                let message = try await socket.receive()
                try await handle(message)
            } catch is CancellationError {
                return
            } catch {
                guard !closed else { return }
                if inputContinuation != nil {
                    markInputUncertain(Self.failure(error), closeSession: false)
                }
                failPending(Self.failure(error))
                guard reconnectAttempt < 5 else {
                    finish(throwing: RelayTerminalFailure(
                        code: "terminal_reconnect_failed",
                        message: "Terminal transport could not reconnect"
                    ))
                    return
                }
                let delay = min(0.5 * pow(2.0, Double(reconnectAttempt)), 8)
                reconnectAttempt += 1
                do {
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    let ready = try await openSocket(url: try resumeURL())
                    try refreshDriveAssertion(after: ready)
                    if inputUncertainty != nil {
                        Task { [weak self] in
                            _ = await self?.close()
                        }
                    } else {
                        yield(.ready(
                            snapshot: ready.snapshot,
                            deliveryMode: ready.deliveryMode,
                            deliveryRevision: ready.deliveryRevision
                        ))
                    }
                    reconnectAttempt = 0
                } catch is CancellationError {
                    return
                } catch let failure as RelayTerminalFailure where failure.code == "delivery_mode_conflict" {
                    finish(throwing: failure)
                    return
                } catch {
                    continue
                }
            }
        }
    }

    /// A resumed lane reports the broker's current delivery-mode revision in
    /// its fresh Ready frame. Accept a drive resume only while the asserted
    /// mode remains in force, then advance the CAS revision used at close.
    /// If an operator changed the mode during the disconnect, ending this
    /// session preserves that concurrent change instead of overwriting it.
    private func refreshDriveAssertion(after ready: RelayTerminalReady) throws {
        guard mode != .view else { return }
        guard ready.deliveryMode == .autoInject,
              let revision = ready.deliveryRevision else {
            assertedDeliveryMode = nil
            assertedDeliveryRevision = nil
            throw RelayTerminalFailure(
                code: "delivery_mode_conflict",
                message: "The terminal delivery mode changed while the drive session was reconnecting"
            )
        }
        assertedDeliveryMode = .autoInject
        assertedDeliveryRevision = revision
    }

    private func openSocket(url: URL) async throws -> RelayTerminalReady {
        let task = urlSession.webSocketTask(with: url)
        socket = task
        task.resume()
        let frame = try decode(try await task.receive())
        guard frame.type == "terminal.ready",
              frame.sessionId == ticket.sessionId,
              let snapshot = frame.snapshot else {
            task.cancel(with: .protocolError, reason: nil)
            throw RelayTerminalFailure(
                code: "terminal_handshake_failed",
                message: "Terminal transport did not provide a valid ready frame"
            )
        }
        return RelayTerminalReady(
            snapshot: snapshot,
            deliveryMode: frame.deliveryMode,
            deliveryRevision: frame.deliveryRevision
        )
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) async throws {
        let frame = try decode(message)
        guard frame.sessionId == ticket.sessionId else { return }
        switch frame.type {
        case "terminal.ready":
            guard let snapshot = frame.snapshot else { return }
            yield(.ready(
                snapshot: snapshot,
                deliveryMode: frame.deliveryMode,
                deliveryRevision: frame.deliveryRevision
            ))
        case "terminal.snapshot":
            guard let requestID = frame.requestId,
                  let snapshot = frame.snapshot,
                  let pending = snapshotContinuations.removeValue(forKey: requestID) else { return }
            snapshotTimeoutTasks.removeValue(forKey: requestID)?.cancel()
            pending.resume(returning: snapshot)
        case "terminal.output":
            guard let chunk = frame.chunk else { return }
            yield(.output(data: Data(chunk.utf8), offset: frame.offset))
        case "terminal.input_ack":
            let pending = inputContinuation
            inputContinuation = nil
            inputTimeoutTask?.cancel()
            inputTimeoutTask = nil
            pending?.resume()
            yield(.inputAcknowledged(bytesWritten: frame.bytesWritten ?? 0))
        case "terminal.delivery_mode":
            guard let requestID = frame.requestId,
                  let pending = deliveryContinuations.removeValue(forKey: requestID),
                  let mode = frame.mode,
                  let revision = frame.revision else { return }
            deliveryTimeoutTasks.removeValue(forKey: requestID)?.cancel()
            pending.resume(returning: RelayTerminalDeliveryModeResult(
                mode: mode,
                matched: frame.matched ?? true,
                revision: revision
            ))
        case "terminal.error":
            let failure = RelayTerminalFailure(
                code: frame.code ?? "terminal_error",
                message: frame.message ?? "Terminal operation failed"
            )
            if let requestID = frame.requestId {
                snapshotTimeoutTasks.removeValue(forKey: requestID)?.cancel()
                deliveryTimeoutTasks.removeValue(forKey: requestID)?.cancel()
                snapshotContinuations.removeValue(forKey: requestID)?.resume(throwing: failure)
                deliveryContinuations.removeValue(forKey: requestID)?.resume(throwing: failure)
            } else if let pending = inputContinuation {
                inputContinuation = nil
                inputTimeoutTask?.cancel()
                inputTimeoutTask = nil
                pending.resume(throwing: failure)
            }
            yield(.failure(failure))
        case "terminal.closed":
            closeReported = true
            let closeWaiter = closeContinuation
            closeContinuation = nil
            closeTimeoutTask?.cancel()
            closeTimeoutTask = nil
            closeWaiter?.resume(returning: true)
            yield(.closed(code: frame.code, message: frame.message))
            finish()
        default:
            return
        }
    }

    private func send<T: Encodable>(_ frame: T) async throws {
        try requireOpen()
        guard let socket else {
            throw RelayTerminalFailure(code: "not_connected", message: "Terminal transport is not connected")
        }
        let data = try encoder.encode(frame)
        guard let string = String(data: data, encoding: .utf8) else {
            throw RelayError.encodingFailed("Could not encode terminal frame")
        }
        try await socket.send(.string(string))
    }

    private func sendRequest<T: Encodable>(_ frame: T, completion: @escaping @Sendable (Error?) -> Void) {
        guard !closed, let socket else {
            completion(RelayTerminalFailure(code: "not_connected", message: "Terminal transport is not connected"))
            return
        }
        do {
            let data = try encoder.encode(frame)
            guard let string = String(data: data, encoding: .utf8) else {
                completion(RelayError.encodingFailed("Could not encode terminal frame"))
                return
            }
            socket.send(.string(string), completionHandler: completion)
        } catch {
            completion(error)
        }
    }

    private func decode(_ message: URLSessionWebSocketTask.Message) throws -> RelayTerminalWireFrame {
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default:
            throw RelayTerminalFailure(code: "invalid_frame", message: "Terminal transport returned an unknown frame type")
        }
        do {
            return try decoder.decode(RelayTerminalWireFrame.self, from: data)
        } catch {
            throw RelayTerminalFailure(code: "invalid_frame", message: "Terminal transport returned malformed data")
        }
    }

    private func requireOpen() throws {
        guard !closed else {
            throw RelayTerminalFailure(code: "closed", message: "Terminal session is closed")
        }
    }

    private func failInput(_ error: Error) -> Bool {
        let pending = inputContinuation
        inputContinuation = nil
        inputTimeoutTask?.cancel()
        inputTimeoutTask = nil
        pending?.resume(throwing: error)
        return pending != nil
    }

    private func markInputUncertain(_ error: Error, closeSession: Bool = true) {
        guard inputUncertainty == nil else { return }
        guard inputContinuation != nil else { return }
        let source = Self.failure(error)
        let failure = RelayTerminalFailure(
            code: "input_result_uncertain",
            message: "Terminal input result became uncertain (\(source.message)); the SDK is closing this session to prevent duplicate keystrokes."
        )
        inputUncertainty = failure
        _ = failInput(failure)
        yield(.failure(failure))
        if closeSession {
            Task { [weak self] in
                _ = await self?.close()
            }
        }
    }

    private func failSnapshot(requestID: String, error: Error) {
        snapshotTimeoutTasks.removeValue(forKey: requestID)?.cancel()
        snapshotContinuations.removeValue(forKey: requestID)?.resume(throwing: error)
    }

    private func failDeliveryMode(requestID: String, error: Error) {
        deliveryTimeoutTasks.removeValue(forKey: requestID)?.cancel()
        deliveryContinuations.removeValue(forKey: requestID)?.resume(throwing: error)
    }

    private func failPending(_ error: Error) {
        _ = failInput(error)
        let snapshots = snapshotContinuations.values
        snapshotContinuations.removeAll()
        snapshotTimeoutTasks.values.forEach { $0.cancel() }
        snapshotTimeoutTasks.removeAll()
        snapshots.forEach { $0.resume(throwing: error) }
        let deliveries = deliveryContinuations.values
        deliveryContinuations.removeAll()
        deliveryTimeoutTasks.values.forEach { $0.cancel() }
        deliveryTimeoutTasks.removeAll()
        deliveries.forEach { $0.resume(throwing: error) }
    }

    private func yield(_ event: RelayTerminalEvent) {
        if case .dropped = continuation.yield(event) {
            finish(throwing: RelayTerminalFailure(
                code: "output_backpressure",
                message: "Terminal output exceeded the SDK event buffer"
            ))
        }
    }

    private func finish(throwing error: Error? = nil) {
        guard !closed else { return }
        closed = true
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        let failure = error ?? RelayTerminalFailure(code: "closed", message: "Terminal session closed")
        failPending(failure)
        let closeWaiter = closeContinuation
        closeContinuation = nil
        closeTimeoutTask?.cancel()
        closeTimeoutTask = nil
        closeWaiter?.resume(returning: closeReported)
        if let error {
            continuation.finish(throwing: error)
        } else {
            continuation.finish()
        }
    }

    private func websocketURL(_ value: String) throws -> URL {
        guard var components = URLComponents(string: value) else {
            throw RelayTerminalFailure(code: "invalid_terminal_url", message: "Terminal session URL is invalid")
        }
        switch components.scheme?.lowercased() {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        case "wss", "ws": break
        default:
            throw RelayTerminalFailure(code: "invalid_terminal_url", message: "Terminal session URL must use HTTP or WebSocket transport")
        }
        guard let url = components.url else {
            throw RelayTerminalFailure(code: "invalid_terminal_url", message: "Terminal session URL is invalid")
        }
        return url
    }

    private func resumeURL() throws -> URL {
        guard var components = URLComponents(string: ticket.terminalUrl) else {
            throw RelayTerminalFailure(code: "invalid_terminal_url", message: "Terminal session URL is invalid")
        }
        var items = (components.queryItems ?? []).filter { $0.name != "ticket" }
        items.append(URLQueryItem(name: "session_id", value: ticket.sessionId))
        items.append(URLQueryItem(name: "resume", value: ticket.resumeToken))
        components.queryItems = items
        guard let value = components.string else {
            throw RelayTerminalFailure(code: "invalid_terminal_url", message: "Terminal resume URL is invalid")
        }
        return try websocketURL(value)
    }

    private func requestCloseConfirmation() async -> Bool {
        guard !closed, socket != nil else { return closeReported }
        return await withCheckedContinuation { continuation in
            closeContinuation = continuation
            closeTimeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled else { return }
                await self?.finishCloseWait(confirmed: false)
            }
            sendRequest(RelayTerminalCloseFrame(sessionId: ticket.sessionId)) { [weak self] error in
                guard error != nil else { return }
                Task { await self?.finishCloseWait(confirmed: false) }
            }
        }
    }

    private func finishCloseWait(confirmed: Bool) {
        let pending = closeContinuation
        closeContinuation = nil
        closeTimeoutTask?.cancel()
        closeTimeoutTask = nil
        pending?.resume(returning: confirmed)
    }

    private func operationTimeoutTask(
        _ action: @escaping @Sendable () async -> Void
    ) -> Task<Void, Never> {
        Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled else { return }
            await action()
        }
    }

    private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        func defaultPort(_ url: URL) -> Int? {
            if let port = url.port { return port }
            switch url.scheme?.lowercased() {
            case "https", "wss": return 443
            case "http", "ws": return 80
            default: return nil
            }
        }
        return lhs.host?.lowercased() == rhs.host?.lowercased()
            && defaultPort(lhs) == defaultPort(rhs)
            && ((lhs.scheme == "https" || lhs.scheme == "wss") == (rhs.scheme == "https" || rhs.scheme == "wss"))
    }

    private static func failure(_ error: Error) -> RelayTerminalFailure {
        if let failure = error as? RelayTerminalFailure { return failure }
        if case RelayError.protocolError(let code, let message, _) = error {
            return RelayTerminalFailure(code: code, message: message)
        }
        return RelayTerminalFailure(code: "terminal_error", message: error.localizedDescription)
    }
}
