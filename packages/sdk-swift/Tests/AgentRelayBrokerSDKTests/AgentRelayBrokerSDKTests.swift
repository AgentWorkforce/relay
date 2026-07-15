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

    func post(path: String, body: Data?) async throws -> Data {
        requests.append(Request(method: "POST", path: path, body: body))
        return Data()
    }

    func delete(path: String, body: Data?) async throws -> Data {
        requests.append(Request(method: "DELETE", path: path, body: body))
        return Data()
    }

    func get(path: String) async throws -> Data {
        requests.append(Request(method: "GET", path: path, body: nil))
        return Data()
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
    private func waitUntil(_ predicate: @escaping () async -> Bool) async throws {
        for _ in 0..<500 {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("Timed out waiting for async condition")
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
        let readTask = Task {
            for await event in channel.events {
                await recorder.append(event)
            }
        }

        try await waitUntil { await core.continuationCounts().channels == 1 }

        try await channel.subscribe()
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

        let first = await stream.first(where: { _ in true })
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

        var eventIterator = eventStream.makeAsyncIterator()
        var eventKinds: [String] = []
        for _ in 0..<256 {
            guard case .unknown(let kind, _)? = await eventIterator.next() else {
                return XCTFail("Expected buffered unknown event")
            }
            eventKinds.append(kind)
        }
        XCTAssertEqual(eventKinds.first, "event.44")
        XCTAssertEqual(eventKinds.last, "event.299")

        var stateIterator = stateStream.makeAsyncIterator()
        guard case .disconnected? = await stateIterator.next() else {
            return XCTFail("Expected only the newest connection state")
        }
    }
}
