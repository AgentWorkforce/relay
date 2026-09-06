import Foundation
import XCTest
@testable import AgentRelayBrokerSDK

private actor MockRelayHTTP: RelayHTTPClient {
    struct Request: Sendable {
        let method: String
        let path: String
        let body: Data?
    }

    private var requests: [Request] = []
    private var responses: [String: Data] = [:]
    private var nextError: RelayError?

    /// Stub the response body returned for an exact request `path`.
    func setResponse(_ json: String, for path: String) {
        responses[path] = Data(json.utf8)
    }

    /// Make the next request throw the given protocol error.
    func setNextError(_ error: RelayError) {
        nextError = error
    }

    func post(path: String, body: Data?) async throws -> Data {
        requests.append(Request(method: "POST", path: path, body: body))
        return try respond(for: path)
    }

    func delete(path: String, body: Data?) async throws -> Data {
        requests.append(Request(method: "DELETE", path: path, body: body))
        return try respond(for: path)
    }

    func get(path: String) async throws -> Data {
        requests.append(Request(method: "GET", path: path, body: nil))
        return try respond(for: path)
    }

    private func respond(for path: String) throws -> Data {
        if let error = nextError {
            nextError = nil
            throw error
        }
        return responses[path] ?? Data()
    }

    func allRequests() -> [Request] {
        requests
    }
}

private actor MockRelayTransport: RelayTransportClient {
    nonisolated let inbound: AsyncStream<Data>

    private let continuation: AsyncStream<Data>.Continuation
    private var sent: [Data] = []
    private var connectCount = 0
    private var onConnect: (@Sendable () async -> Void)?

    init() {
        var continuationRef: AsyncStream<Data>.Continuation?
        self.inbound = AsyncStream<Data> { continuation in
            continuationRef = continuation
        }
        self.continuation = continuationRef!
    }

    func setOnConnect(_ handler: @escaping @Sendable () async -> Void) async {
        onConnect = handler
    }

    func connect() async throws {
        connectCount += 1
    }

    func disconnect() async {
        continuation.finish()
    }

    func send(_ message: Data) async throws {
        sent.append(message)
    }

    func emit(_ json: String) {
        continuation.yield(Data(json.utf8))
    }

    func sentMessages() -> [Data] {
        sent
    }
}

private actor BrokerChannelRecorder {
    private var events: [RelayChannelEvent] = []

    func append(_ event: RelayChannelEvent) {
        events.append(event)
    }

    func all() -> [RelayChannelEvent] {
        events
    }
}

private func jsonObject(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

final class AgentRelayBrokerSDKTests: XCTestCase {
    private enum AsyncTestTimeout: Error {
        case exceeded
    }

    private func waitUntil(_ predicate: @escaping () async -> Bool) async throws {
        for _ in 0..<2_000 {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("Timed out waiting for async condition")
        throw AsyncTestTimeout.exceeded
    }

    private func withTimeout<T: Sendable>(
        _ operation: @escaping @Sendable () async -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                throw AsyncTestTimeout.exceeded
            }
            guard let result = try await group.next() else {
                throw AsyncTestTimeout.exceeded
            }
            group.cancelAll()
            return result
        }
    }

    func testAgentRelayBrokerClientInit() {
        let client = AgentRelayBrokerClient(apiKey: "rk_test_key")
        XCTAssertEqual(client.apiKey, "rk_test_key")
    }

    func testCompatibilityAliasInit() {
        let client = AgentRelayClient(apiKey: "rk_test_key")
        XCTAssertEqual(client.apiKey, "rk_test_key")
    }

    func testChannelCreation() {
        let client = AgentRelayBrokerClient(apiKey: "rk_test_key")
        let channel = client.channel("test-channel")
        XCTAssertEqual(channel.name, "test-channel")
    }

    func testDefaultLocalBrokerURL() {
        let client = AgentRelayBrokerClient(apiKey: "rk_test_key")
        XCTAssertEqual(client.baseURL.host, "localhost")
        XCTAssertEqual(client.baseURL.port, 3889)
    }

    func testBrokerEventDecodesBarePayload() throws {
        let json = """
        {
          "kind": "relay_inbound",
          "event_id": "evt_1",
          "from": "alice",
          "target": "wf-test",
          "body": "hello",
          "thread_id": "t1"
        }
        """.data(using: .utf8)!
        let event = try JSONDecoder().decode(BrokerEvent.self, from: json)
        if case .relayInbound(let inbound) = event {
            XCTAssertEqual(inbound.from, "alice")
            XCTAssertEqual(inbound.target, "wf-test")
            XCTAssertEqual(inbound.body, "hello")
            XCTAssertEqual(inbound.threadId, "t1")
        } else {
            XCTFail("expected relayInbound, got \(event)")
        }
    }

    func testWebSocketURLAppendsWS() {
        let url = RelayTransport.resolveWebSocketURL(baseURL: URL(string: "http://localhost:3889")!)
        XCTAssertEqual(url?.absoluteString, "ws://localhost:3889/ws")
    }

    func testWebSocketURLUpgradesHTTPS() {
        let url = RelayTransport.resolveWebSocketURL(baseURL: URL(string: "https://broker.example.com")!)
        XCTAssertEqual(url?.absoluteString, "wss://broker.example.com/ws")
    }

    func testWebSocketURLNormalizesTrailingSlash() {
        let url = RelayTransport.resolveWebSocketURL(baseURL: URL(string: "http://localhost:3889/ws/")!)
        XCTAssertEqual(url?.absoluteString, "ws://localhost:3889/ws")
    }

    func testWebSocketURLDoesNotDoubleAppendWS() {
        let url = RelayTransport.resolveWebSocketURL(baseURL: URL(string: "http://localhost:3889/ws")!)
        XCTAssertEqual(url?.absoluteString, "ws://localhost:3889/ws")
    }

    func testWebSocketURLRewritesLegacyV1WS() {
        let url = RelayTransport.resolveWebSocketURL(baseURL: URL(string: "http://localhost:3889/v1/ws")!)
        XCTAssertEqual(url?.absoluteString, "ws://localhost:3889/ws")
    }

    func testWebSocketURLStripsLegacyTokenQuery() {
        let url = RelayTransport.resolveWebSocketURL(baseURL: URL(string: "http://localhost:3889/?token=secret")!)
        XCTAssertEqual(url?.absoluteString, "ws://localhost:3889/ws")
    }

    func testAPIURLAppendsPath() {
        let url = RelayHTTP.resolveAPIURL(baseURL: URL(string: "http://localhost:3889")!, path: "/api/send")
        XCTAssertEqual(url?.absoluteString, "http://localhost:3889/api/send")
    }

    func testAPIURLStripsWSBasePath() {
        let url = RelayHTTP.resolveAPIURL(baseURL: URL(string: "http://localhost:3889/ws")!, path: "/api/send")
        XCTAssertEqual(url?.absoluteString, "http://localhost:3889/api/send")
    }

    func testAPIURLStripsLegacyV1WSBasePath() {
        let url = RelayHTTP.resolveAPIURL(baseURL: URL(string: "http://localhost:3889/v1/ws")!, path: "/api/send")
        XCTAssertEqual(url?.absoluteString, "http://localhost:3889/api/send")
    }

    func testAPIURLDowngradesWSScheme() {
        let url = RelayHTTP.resolveAPIURL(baseURL: URL(string: "ws://localhost:3889/ws")!, path: "/api/send")
        XCTAssertEqual(url?.absoluteString, "http://localhost:3889/api/send")
    }

    func testAPIURLDowngradesWSSScheme() {
        let url = RelayHTTP.resolveAPIURL(baseURL: URL(string: "wss://broker.example.com/ws")!, path: "/api/spawn")
        XCTAssertEqual(url?.absoluteString, "https://broker.example.com/api/spawn")
    }

    func testSpawnAgentSerializesSessionId() async throws {
        let http = MockRelayHTTP()
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)
        let spec = AgentSpec(
            name: "Worker1",
            runtime: .pty,
            cli: "codex",
            sessionId: "ses_123"
        )

        try await core.spawnAgent(spec, initialTask: "ship it", skipRelayPrompt: true)

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/spawn")
        let body = try jsonObject(try XCTUnwrap(request.body))
        XCTAssertEqual(body["name"] as? String, "Worker1")
        XCTAssertEqual(body["session_id"] as? String, "ses_123")
        XCTAssertEqual(body["task"] as? String, "ship it")
        XCTAssertEqual(body["skip_relay_prompt"] as? Bool, true)
    }

    func testChannelSubscribeIsIdempotent() async throws {
        let transport = MockRelayTransport()
        let core = BrokerCore(apiKey: "rk_test", transport: transport, http: MockRelayHTTP())
        let channel = Channel(name: "ops", core: core)
        let recorder = BrokerChannelRecorder()
        let eventStream = channel.events
        let readTask = Task {
            for await event in eventStream {
                await recorder.append(event)
            }
        }

        try await channel.subscribe()
        let countsAfterSubscribe = await core.continuationCounts()
        XCTAssertEqual(countsAfterSubscribe.channels, 1)
        try await channel.subscribe()
        await transport.emit(
            """
            {
              "kind": "relay_inbound",
              "event_id": "evt_1",
              "from": "alice",
              "target": "ops",
              "body": "hello",
              "thread_id": "t1"
            }
            """
        )
        // Wait deterministically for the event to be delivered rather than
        // relying on a fixed sleep window, which is flaky on slower runners.
        var events = await recorder.all()
        for _ in 0..<500 where events.isEmpty {
            try await Task.sleep(nanoseconds: 1_000_000)
            events = await recorder.all()
        }
        readTask.cancel()
        _ = await readTask.value

        events = await recorder.all()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.body, "hello")
    }

    func testCancellingPublicStreamsRemovesContinuationsAcrossEpochs() async throws {
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: MockRelayHTTP())
        let client = AgentRelayBrokerClient(
            core: core,
            apiKey: "rk_test",
            baseURL: URL(string: "http://localhost:3889")!
        )

        for _ in 0..<20 {
            let eventTask = Task { for await _ in client.brokerEvents {} }
            let inboundTask = Task { for await _ in client.inboundMessages {} }
            let stateTask = Task { for await _ in client.connectionState {} }
            try await waitUntil {
                let counts = await core.continuationCounts()
                return counts.brokerEvents == 1 && counts.inbound == 1 && counts.connectionState == 1
            }

            eventTask.cancel()
            inboundTask.cancel()
            stateTask.cancel()
            _ = await (eventTask.value, inboundTask.value, stateTask.value)
            try await waitUntil {
                let counts = await core.continuationCounts()
                return counts.brokerEvents == 0 && counts.inbound == 0 && counts.connectionState == 0
            }
        }
    }

    func testJoinOnlyChannelDoesNotRegisterEventContinuation() async throws {
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: MockRelayHTTP())
        let channel = Channel(name: "ops", core: core)

        try await channel.subscribe()
        try await channel.subscribe()

        let counts = await core.continuationCounts()
        XCTAssertEqual(counts.channels, 0)
    }

    func testTerminationBeforeRegistrationDoesNotResurrectContinuation() async throws {
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: MockRelayHTTP())
        let id = UUID()
        var continuationRef: AsyncStream<BrokerEvent>.Continuation?
        _ = AsyncStream<BrokerEvent> { continuationRef = $0 }

        let continuation = try XCTUnwrap(continuationRef)
        let generation = core.streamLifecycle.snapshot()
        await Task {
            withUnsafeCurrentTask { $0?.cancel() }
            await core.registerBrokerEventContinuation(continuation, id: id, generation: generation)
        }.value

        let counts = await core.continuationCounts()
        XCTAssertEqual(counts.brokerEvents, 0)
    }

    func testRegistrationFromBeforeDisconnectCannotResurrectStream() async throws {
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: MockRelayHTTP())
        let id = UUID()
        let staleGeneration = core.streamLifecycle.snapshot()
        var continuationRef: AsyncStream<BrokerEvent>.Continuation?
        let stream = AsyncStream<BrokerEvent> { continuationRef = $0 }

        await core.disconnect()
        await core.registerBrokerEventContinuation(try XCTUnwrap(continuationRef), id: id, generation: staleGeneration)

        let first = try await withTimeout { await stream.first(where: { _ in true }) }
        XCTAssertNil(first)
        let counts = await core.continuationCounts()
        XCTAssertEqual(counts.brokerEvents, 0)
    }

    func testDisconnectIsIdempotentAndFinishesLiveStreams() async throws {
        let transport = MockRelayTransport()
        let core = BrokerCore(apiKey: "rk_test", transport: transport, http: MockRelayHTTP())
        let channel = Channel(name: "ops", core: core)
        let task = Task { for await _ in channel.events {} }
        try await waitUntil { await core.continuationCounts().channels == 1 }

        await core.disconnect()
        await core.disconnect()
        _ = await task.value

        let counts = await core.continuationCounts()
        XCTAssertEqual(counts.channels, 0)
    }

    func testDisconnectDoesNotLeaveEmptyChannelRegistries() async throws {
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: MockRelayHTTP())

        for epoch in 0..<20 {
            let channel = Channel(name: "ops-\(epoch)", core: core)
            let task = Task { for await _ in channel.events {} }
            try await waitUntil { await core.continuationCounts().channels == 1 }

            await core.disconnect()
            _ = await task.value
            try await waitUntil {
                let counts = await core.continuationCounts()
                return counts.channels == 0 && counts.channelRegistries == 0
            }
        }
    }

    func testEventAndConnectionStateBuffersDropOldestValues() async throws {
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: MockRelayHTTP())
        let client = AgentRelayBrokerClient(
            core: core,
            apiKey: "rk_test",
            baseURL: URL(string: "http://localhost:3889")!
        )
        let eventStream = client.brokerEvents
        let stateStream = client.connectionState
        try await waitUntil {
            let counts = await core.continuationCounts()
            return counts.brokerEvents == 1 && counts.connectionState == 1
        }

        for index in 0..<300 {
            await core.routeBrokerEvent(.unknown(kind: "event.\(index)", rawJSON: nil))
        }
        await core.notifyConnectionState(.connected)
        await core.notifyConnectionState(.disconnected)

        let eventKinds = try await withTimeout {
            var eventIterator = eventStream.makeAsyncIterator()
            var kinds: [String] = []
            for _ in 0..<256 {
                guard case .unknown(let kind, _)? = await eventIterator.next() else { break }
                kinds.append(kind)
            }
            return kinds
        }
        XCTAssertEqual(eventKinds.count, 256)
        XCTAssertEqual(eventKinds.first, "event.44")
        XCTAssertEqual(eventKinds.last, "event.299")

        let state = try await withTimeout {
            var stateIterator = stateStream.makeAsyncIterator()
            return await stateIterator.next()
        }
        guard case .disconnected? = state else {
            return XCTFail("Expected only the newest connection state")
        }
    }

    // MARK: - Broker control & observability

    func testResolveAPIURLPreservesEmbeddedQuery() {
        let url = RelayHTTP.resolveAPIURL(
            baseURL: URL(string: "http://localhost:3889")!,
            path: "/api/spawned/worker-a/snapshot?format=ansi"
        )
        XCTAssertEqual(url?.absoluteString, "http://localhost:3889/api/spawned/worker-a/snapshot?format=ansi")
    }

    func testResolveAPIURLDoesNotDoubleEncodePathSegments() {
        // A pre-encoded segment (agent name "Worker 1" -> "Worker%201") must
        // survive as a single encoding layer, not become "Worker%2520 1".
        let url = RelayHTTP.resolveAPIURL(
            baseURL: URL(string: "http://localhost:3889")!,
            path: "/api/input/Worker%201"
        )
        XCTAssertEqual(url?.absoluteString, "http://localhost:3889/api/input/Worker%201")
    }

    func testSendInputEncodesSpacedAgentNameOnce() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "name": "Worker 1", "bytes_written": 1 }"#, for: "/api/input/Worker%201")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        _ = try await core.sendInput(name: "Worker 1", data: "x")

        let requests = await http.allRequests()
        XCTAssertEqual(requests.first?.path, "/api/input/Worker%201")
    }

    func testSendMessagePayloadEncodesFullParityFields() throws {
        let payload = SendMessagePayload(
            to: "Builder",
            text: "Please continue",
            from: "Lead",
            threadId: "thread-1",
            workspaceId: "workspace-1",
            workspaceAlias: "default",
            priority: 5,
            data: ["ticket": .string("ENG-123")],
            mode: .steer
        )
        let object = try jsonObject(try JSONEncoder().encode(payload))
        XCTAssertEqual(object["thread_id"] as? String, "thread-1")
        XCTAssertEqual(object["workspace_id"] as? String, "workspace-1")
        XCTAssertEqual(object["workspace_alias"] as? String, "default")
        XCTAssertEqual(object["mode"] as? String, "steer")
        XCTAssertEqual((object["data"] as? [String: Any])?["ticket"] as? String, "ENG-123")
    }

    func testListAgentsUnwrapsAgentsAndDecodesWireKeys() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(
            """
            { "agents": [{
              "name": "Builder",
              "runtime": "pty",
              "cli": "codex",
              "sessionId": "ses_1",
              "channels": ["dev"],
              "last_activity_ms": 42,
              "context_budget_pct": 12.5,
              "current_state": "blocked_on_send"
            }] }
            """,
            for: "/api/spawned"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let agents = try await core.listAgents()

        XCTAssertEqual(agents.count, 1)
        XCTAssertEqual(agents.first?.name, "Builder")
        // The broker emits `sessionId` in camelCase, not `session_id`.
        XCTAssertEqual(agents.first?.sessionId, "ses_1")
        XCTAssertEqual(agents.first?.lastActivityMs, 42)
        XCTAssertEqual(agents.first?.contextBudgetPct, 12.5)
        XCTAssertEqual(agents.first?.currentState, .blockedOnSend)
    }

    func testListAgentsDecodesUnknownCurrentStateAsUnrecognized() async throws {
        // A future broker state must degrade to `.unrecognized`, not fail the
        // whole listAgents() decode.
        let http = MockRelayHTTP()
        await http.setResponse(
            #"{ "agents": [{ "name": "W", "runtime": "pty", "channels": [], "current_state": "hibernating" }] }"#,
            for: "/api/spawned"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let agents = try await core.listAgents()

        XCTAssertEqual(agents.first?.currentState, .unrecognized)
    }

    func testSendInputPostsToInputEndpoint() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "name": "Worker1", "bytes_written": 5 }"#, for: "/api/input/Worker1")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.sendInput(name: "Worker1", data: "hello")

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/input/Worker1")
        XCTAssertEqual(try jsonObject(try XCTUnwrap(request.body))["data"] as? String, "hello")
        XCTAssertEqual(result.bytesWritten, 5)
    }

    func testResizePtyUsesResizeEndpointAndOmitsNilDimensions() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "name": "Worker1", "released": true }"#, for: "/api/resize/Worker1")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.resizePty(name: "Worker1", rows: nil, cols: nil, sessionId: "sess-1", release: true)

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/resize/Worker1")
        let body = try jsonObject(try XCTUnwrap(request.body))
        XCTAssertEqual(body["session_id"] as? String, "sess-1")
        XCTAssertEqual(body["release"] as? Bool, true)
        XCTAssertNil(body["rows"])
        XCTAssertNil(body["cols"])
        XCTAssertEqual(result.released, true)
    }

    func testSnapshotBuildsFormatQuery() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(
            #"{ "format": "ansi", "rows": 24, "cols": 80, "cursor": [1, 2], "screen": "AA==", "offset": 99 }"#,
            for: "/api/spawned/Worker1/snapshot?format=ansi"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let snapshot = try await core.snapshot(name: "Worker1", format: .ansi)

        let requests = await http.allRequests()
        XCTAssertEqual(requests.first?.path, "/api/spawned/Worker1/snapshot?format=ansi")
        XCTAssertEqual(snapshot.format, .ansi)
        XCTAssertEqual(snapshot.cursor, [1, 2])
        XCTAssertEqual(snapshot.offset, 99)
    }

    func testSendMessageDecodesResult() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "event_id": "evt_1", "targets": ["Builder"] }"#, for: "/api/send")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.sendMessage(SendMessagePayload(to: "Builder", text: "hi", mode: .wait))

        let requests = await http.allRequests()
        XCTAssertEqual(requests.first?.path, "/api/send")
        XCTAssertEqual(result.eventId, "evt_1")
        XCTAssertEqual(result.targets, ["Builder"])
    }

    func testSendMessageDecodesBrokerSuccessWithoutTargets() async throws {
        // The broker's real /api/send success response omits `targets`
        // (crates/broker/src/runtime/api.rs); decoding must not throw.
        let http = MockRelayHTTP()
        await http.setResponse(
            #"{ "success": true, "event_id": "http_abc", "relaycast_published": true, "delivery_status": "published_unconfirmed", "recipient_live": false, "recipient_status": "offline", "local": false, "workspace_id": "ws_1", "workspace_alias": "default" }"#,
            for: "/api/send"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.sendMessage(SendMessagePayload(to: "Builder", text: "hi"))

        XCTAssertEqual(result.eventId, "http_abc")
        XCTAssertTrue(result.targets.isEmpty)
        XCTAssertEqual(result.success, true)
        XCTAssertEqual(result.relaycastPublished, true)
        XCTAssertEqual(result.deliveryStatus, "published_unconfirmed")
        XCTAssertEqual(result.recipientLive, false)
        XCTAssertEqual(result.recipientStatus, "offline")
        XCTAssertEqual(result.local, false)
        XCTAssertEqual(result.workspaceId, "ws_1")
        XCTAssertEqual(result.workspaceAlias, "default")
    }

    func testSendMessageSwallowsUnsupportedOperation() async throws {
        let http = MockRelayHTTP()
        await http.setNextError(.protocolError(code: "unsupported_operation", message: "n/a", retryable: false))
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.sendMessage(SendMessagePayload(to: "Builder", text: "hi"))

        XCTAssertEqual(result.eventId, "unsupported_operation")
        XCTAssertTrue(result.targets.isEmpty)
    }

    func testSetModelPostsBody() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "name": "Worker1", "model": "opus", "success": true }"#, for: "/api/spawned/Worker1/model")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.setModel(name: "Worker1", model: "opus", timeoutMs: 2000)

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/spawned/Worker1/model")
        let body = try jsonObject(try XCTUnwrap(request.body))
        XCTAssertEqual(body["model"] as? String, "opus")
        XCTAssertEqual(body["timeout_ms"] as? Int, 2000)
        XCTAssertTrue(result.success)
    }

    func testGetModelReturnsReceipt() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(
            #"{ "name": "Worker1", "requested_model": "opus", "effective_model": "opus", "applied": true, "status": "applied", "request_id": "model_1", "generation": "gen-1", "revision": 1, "effective_revision": 1, "success": true, "accepted": true, "pending": false }"#,
            for: "/api/spawned/Worker1/model"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.getModel(name: "Worker1")

        XCTAssertEqual(result.status, "applied")
        XCTAssertEqual(result.effectiveModel, "opus")
        XCTAssertEqual(result.effectiveRevision, 1)
        let requests = await http.allRequests()
        XCTAssertEqual(requests.first?.method, "GET")
        XCTAssertEqual(requests.first?.path, "/api/spawned/Worker1/model")
    }

    func testGetModelCanPollCorrelatedReceipt() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(
            #"{ "name": "Worker1", "request_id": "model_1", "status": "applied", "applied": true, "success": true }"#,
            for: "/api/spawned/Worker1/model?request_id=model_1"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.getModel(name: "Worker1", requestId: "model_1")

        XCTAssertEqual(result.requestId, "model_1")
        let requests = await http.allRequests()
        XCTAssertEqual(requests.first?.path, "/api/spawned/Worker1/model?request_id=model_1")
    }

    func testSubscribeChannelsPostsChannels() async throws {
        let http = MockRelayHTTP()
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        try await core.subscribeChannels(name: "Worker1", channels: ["dev", "ops"])

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/spawned/Worker1/subscribe")
        XCTAssertEqual(try jsonObject(try XCTUnwrap(request.body))["channels"] as? [String], ["dev", "ops"])
    }

    func testUnsubscribeChannelsPostsChannels() async throws {
        let http = MockRelayHTTP()
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        try await core.unsubscribeChannels(name: "Worker1", channels: ["dev", "ops"])

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/spawned/Worker1/unsubscribe")
        XCTAssertEqual(try jsonObject(try XCTUnwrap(request.body))["channels"] as? [String], ["dev", "ops"])
    }

    func testFlushPendingPostsAndDecodesResult() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "flushed": 3 }"#, for: "/api/spawned/Worker1/flush")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.flushPending(name: "Worker1")

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/spawned/Worker1/flush")
        XCTAssertEqual(result.flushed, 3)
    }

    func testGetMetricsBuildsAgentQuery() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(
            #"{ "agents": [{ "name": "Worker1", "pid": 10, "memory_bytes": 2048, "uptime_secs": 30 }] }"#,
            for: "/api/metrics?agent=Worker1"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let metrics = try await core.getMetrics(agent: "Worker1")

        let requests = await http.allRequests()
        XCTAssertEqual(requests.first?.path, "/api/metrics?agent=Worker1")
        XCTAssertEqual(metrics.agents.first?.memoryBytes, 2048)
        XCTAssertEqual(metrics.agents.first?.uptimeSecs, 30)
    }

    func testGetStatusDecodesParityFields() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(
            """
            {
              "agent_count": 1,
              "agents": [{
                "name": "Builder", "runtime": "pty", "cli": "codex", "sessionId": "ses_9", "channels": ["dev"],
                "last_activity_ms": 42, "context_budget_pct": 12.5, "current_state": "blocked_on_send"
              }],
              "pending_delivery_count": 1,
              "pending_deliveries": [{
                "delivery_id": "del_1", "worker_name": "Builder", "event_id": "evt_1", "attempts": 2
              }]
            }
            """,
            for: "/api/status"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let status = try await core.getStatus()

        XCTAssertEqual(status.agentCount, 1)
        XCTAssertEqual(status.agents.first?.currentState, .blockedOnSend)
        XCTAssertEqual(status.agents.first?.sessionId, "ses_9")
        XCTAssertEqual(status.pendingDeliveries.first?.deliveryId, "del_1")
        XCTAssertEqual(status.pendingDeliveries.first?.workerName, "Builder")
    }

    func testGetCrashInsightsDecodesBrokerShape() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(
            """
            {
              "total_crashes": 2,
              "health_score": 80,
              "recent": [{
                "agent_name": "Builder", "exit_code": 137, "timestamp": 1700,
                "uptime_secs": 12, "category": "oom", "description": "Exit code 137 (likely OOM killed)"
              }],
              "patterns": [{ "category": "oom", "count": 2, "agents": ["Builder"] }]
            }
            """,
            for: "/api/crash-insights"
        )
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let insights = try await core.getCrashInsights()

        XCTAssertEqual(insights.totalCrashes, 2)
        XCTAssertEqual(insights.healthScore, 80)
        XCTAssertEqual(insights.recent.first?.agentName, "Builder")
        XCTAssertEqual(insights.recent.first?.exitCode, 137)
        XCTAssertEqual(insights.recent.first?.category, .oom)
        XCTAssertEqual(insights.patterns.first?.count, 2)
        XCTAssertEqual(insights.patterns.first?.agents, ["Builder"])
    }

    func testPreflightSkipsRequestWhenEmpty() async throws {
        let http = MockRelayHTTP()
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.preflight(agents: [])

        let requests = await http.allRequests()
        XCTAssertEqual(result.queued, 0)
        XCTAssertTrue(requests.isEmpty)
    }

    func testPreflightPostsAgents() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "queued": 2 }"#, for: "/api/preflight")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.preflight(agents: [
            PreflightAgent(name: "A", cli: "codex"),
            PreflightAgent(name: "B", cli: "claude")
        ])

        let requests = await http.allRequests()
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/preflight")
        let agents = try jsonObject(try XCTUnwrap(request.body))["agents"] as? [[String: Any]]
        XCTAssertEqual(agents?.count, 2)
        XCTAssertEqual(agents?.first?["cli"] as? String, "codex")
        XCTAssertEqual(result.queued, 2)
    }

    func testRenewLeaseDecodes() async throws {
        let http = MockRelayHTTP()
        await http.setResponse(#"{ "renewed": true, "expires_in_secs": 600 }"#, for: "/api/session/renew")
        let core = BrokerCore(apiKey: "rk_test", transport: MockRelayTransport(), http: http)

        let result = try await core.renewLease()

        let requests = await http.allRequests()
        XCTAssertEqual(requests.first?.path, "/api/session/renew")
        XCTAssertTrue(result.renewed)
        XCTAssertEqual(result.expiresInSecs, 600)
    }
}
