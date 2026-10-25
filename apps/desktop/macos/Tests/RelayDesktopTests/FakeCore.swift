import Darwin
import Foundation
@testable import RelayDesktop
@testable import RelayDesktopCore

/// An in-process stand-in for `agent-relay-probe relay serve`: the bridge's
/// NDJSON JSON-RPC over a real Unix socket, with handlers per method and
/// events pushed to subscribed connections. No core, broker or harness runs.
final class FakeCore: @unchecked Sendable {
    struct Failure: Error {
        let kind: String
        let message: String
    }

    typealias Handler = ([String: Any]) throws -> Any

    let path: String
    private let listener: Int32
    private let lock = NSLock()
    private let writeLock = NSLock()
    private var handlers: [String: Handler] = [:]
    private var subscribers: [Int32] = []
    private var connections: [Int32] = []
    private var seq = 0
    private var stopped = false
    private(set) var calls: [(method: String, params: [String: Any])] = []
    var beforeReply: ((String) -> Void)?
    var daemonVersion = "1.0.0"
    var pid = 4242
    var bridgeVersion = CoreBridgeVersion.current
    var topics = ["status"]
    var status: [String: Any]

    init(path: String = "/tmp/rdt-\(UUID().uuidString.prefix(8)).sock", pid: Int = 4242) {
        self.path = path
        self.pid = pid
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        _ = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        listen(fd, 16)
        listener = fd
        status = FakeCore.snapshot(revision: 1, account: ["state": "signed_out"], pid: pid)
        let thread = Thread { [weak self] in self?.acceptLoop() }
        thread.start()
    }

    deinit { stop() }

    /// Stops once. Every descriptor is closed exactly once, by the thread
    /// that uses it: closing one another thread may still use would let it
    /// act on whatever reuses the number, such as the next test's listener.
    /// Connections are shut down here and closed by their serving threads;
    /// a connection to the socket wakes the accept loop, which closes the
    /// listener.
    func stop() {
        lock.lock()
        guard !stopped else {
            lock.unlock()
            return
        }
        stopped = true
        let open = connections
        subscribers = []
        lock.unlock()
        for fd in open { shutdown(fd, SHUT_RDWR) }
        if let wake = try? CoreConnection(path: path) { wake.close() }
        unlink(path)
    }

    static func snapshot(revision: Int, account: [String: Any], pid: Int = 4242, push: [String: Any] = [:]) -> [String: Any] {
        var fullAccount: [String: Any] = [:]
        fullAccount.merge(account) { $1 }
        return [
            "revision": revision,
            "daemon": ["version": "1.0.0", "bridge_version": 2, "pid": pid, "started_at_ms": 1, "socket": "/tmp/x"],
            "machine": ["host_name": "Mac.local", "machine_prefix": "mac"],
            "workspace": ["state": "found", "base_url": "https://cast.agentrelay.com",
                          "workspace_id": "rw_1", "workspace_name": "Acme", "verification": "verified", "checked_at_ms": 1],
            "push": push,
            "agents": ["store_error": NSNull(), "delivery_error": NSNull()],
            "account": fullAccount,
        ]
    }

    static let signedIn: [String: Any] = [
        "state": "signed_in", "site_url": "https://agentrelay.com", "workspace_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
        "person": ["id": "user_1", "name": "Ada", "email": "ada@example.com", "avatar_url": NSNull()],
    ]

    func on(_ method: String, _ handler: @escaping Handler) {
        lock.withLock { handlers[method] = handler }
    }

    func callCount(_ method: String) -> Int {
        lock.withLock { calls.filter { $0.method == method }.count }
    }

    func lastParams(_ method: String) -> [String: Any]? {
        lock.withLock { calls.last { $0.method == method }?.params }
    }

    /// Publishes one event to every subscribed connection.
    func publish(_ topic: String, _ data: Any) {
        lock.lock()
        seq += 1
        let event: [String: Any] = ["jsonrpc": "2.0", "method": "event", "params": ["topic": topic, "seq": seq, "data": data]]
        let targets = subscribers
        lock.unlock()
        for fd in targets { send(event, to: fd) }
    }

    func setStatus(_ snapshot: [String: Any]) {
        lock.withLock { status = snapshot }
        publish("status", snapshot)
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listener, nil, nil)
            let stopping = lock.withLock { stopped }
            if fd < 0 && errno == EINTR && !stopping { continue }
            if fd < 0 || stopping {
                if fd >= 0 { close(fd) }
                close(listener)
                return
            }
            var noSigPipe: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            lock.withLock { connections.append(fd) }
            Thread { [weak self] in self?.serve(fd) }.start()
        }
    }

    private func serve(_ fd: Int32) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = read(fd, &chunk, chunk.count)
            if count <= 0 { break }
            buffer.append(chunk, count: count)
            while let newline = buffer.firstIndex(of: 0x0A) {
                // Keep the test server's temporary Foundation objects out of
                // the client's memory measurements during sustained traffic.
                autoreleasepool {
                    let line = Data(buffer[buffer.startIndex..<newline])
                    buffer = Data(buffer[buffer.index(after: newline)...])
                    guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
                    respond(to: request, on: fd)
                }
            }
        }
        // Under the write lock: a publish never writes to this number once
        // it is closed and reused.
        writeLock.withLock {
            lock.withLock {
                subscribers.removeAll { $0 == fd }
                connections.removeAll { $0 == fd }
            }
            close(fd)
        }
    }

    private func respond(to request: [String: Any], on fd: Int32) {
        let id = request["id"] ?? NSNull()
        let method = request["method"] as? String ?? ""
        let params = request["params"] as? [String: Any] ?? [:]
        lock.withLock { calls.append((method, params)) }
        beforeReply?(method)
        var reply: [String: Any] = ["jsonrpc": "2.0", "id": id]
        switch method {
        case "hello":
            guard params["bridge_version"] as? Int == bridgeVersion else {
                reply["error"] = ["code": -32000, "message": "Bridge versions differ.",
                                  "data": ["kind": "bridge_version_mismatch", "retryable": false]]
                send(reply, to: fd)
                return
            }
            reply["result"] = ["bridge_version": bridgeVersion, "daemon_version": daemonVersion, "pid": pid,
                               "methods": Array(lock.withLock { handlers.keys }), "topics": topics]
        case "subscribe":
            // Subscribed before the reply goes out, as the core does, so no
            // event published meanwhile is lost.
            let snapshot = lock.withLock { () -> [String: Any] in
                subscribers.append(fd)
                return status
            }
            reply["result"] = ["topics": params["topics"] ?? [], "status": snapshot]
            send(reply, to: fd)
            return
        default:
            let handler = lock.withLock { handlers[method] }
            if let handler {
                do {
                    reply["result"] = try handler(params)
                } catch let failure as Failure {
                    reply["error"] = ["code": -32000, "message": failure.message, "data": ["kind": failure.kind, "retryable": false]]
                } catch {
                    reply["error"] = ["code": -32603, "message": "\(error)", "data": ["kind": "internal", "retryable": false]]
                }
            } else {
                reply["result"] = [String: Any]()
            }
        }
        send(reply, to: fd)
    }

    private func send(_ object: [String: Any], to fd: Int32) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        // One line per write call, whole: a partial write would split the frame.
        writeLock.withLock {
            guard lock.withLock({ connections.contains(fd) }) else { return }
            data.withUnsafeBytes { raw in
                guard var pointer = raw.baseAddress else { return }
                var remaining = raw.count
                while remaining > 0 {
                    let written = write(fd, pointer, remaining)
                    if written < 0 {
                        if errno == EINTR { continue }
                        return
                    }
                    remaining -= written
                    pointer = pointer.advanced(by: written)
                }
            }
        }
    }
}

/// The LaunchAgent, without launchd.
final class FakeService: CoreService {
    var status: CoreServiceStatus
    var installationProblem: String?
    var registrationStatus: CoreServiceStatus = .enabled
    var registrationError: Error?
    var repairsSpawnFailure = false
    var spawnRepairStatus: CoreServiceStatus?
    private(set) var spawnRepairChecks = 0
    var spawnRepairError: Error?
    var binaryIdentity: String? = "build-1"
    private(set) var registered = 0
    private(set) var unregistered = 0
    private(set) var openedSettings = 0

    init(status: CoreServiceStatus) { self.status = status }

    func register() throws {
        registered += 1
        if let registrationError { throw registrationError }
        status = registrationStatus
    }

    func unregister() throws {
        unregistered += 1
        status = .notRegistered
    }

    func recoverSpawnFailure() throws -> Bool {
        spawnRepairChecks += 1
        if let spawnRepairError { throw spawnRepairError }
        if repairsSpawnFailure {
            repairsSpawnFailure = false
            if let spawnRepairStatus { status = spawnRepairStatus }
            return true
        }
        return false
    }

    func openSystemSettings() { openedSettings += 1 }

}

/// Waits for `condition` on the main actor, up to `timeout`.
@MainActor
func eventually(_ timeout: TimeInterval = 5, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}
