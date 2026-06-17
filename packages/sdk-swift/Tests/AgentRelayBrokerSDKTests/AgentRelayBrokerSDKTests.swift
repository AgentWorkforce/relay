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
        try await Task.sleep(nanoseconds: 50_000_000)
        readTask.cancel()

        let events = await recorder.all()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.body, "hello")
    }
}
