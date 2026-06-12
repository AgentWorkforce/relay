import XCTest
@testable import AgentRelaySDK

final class AgentRelaySDKTests: XCTestCase {
    func testAgentRelayClientInit() {
        let client = AgentRelayClient(apiKey: "rk_test_key")
        XCTAssertEqual(client.apiKey, "rk_test_key")
    }

    func testChannelCreation() {
        let client = AgentRelayClient(apiKey: "rk_test_key")
        let channel = client.channel("test-channel")
        XCTAssertEqual(channel.name, "test-channel")
    }

    func testDefaultLocalBrokerURL() {
        let client = AgentRelayClient(apiKey: "rk_test_key")
        XCTAssertEqual(client.baseURL.host, "localhost")
        XCTAssertEqual(client.baseURL.port, 3889)
    }

    /// The broker emits each event as a bare `{kind: ...}` JSON object on `/ws`.
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



    func testSendMessagePayloadIncludesFullParityFields() throws {
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
        let data = try JSONEncoder().encode(payload)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["thread_id"] as? String, "thread-1")
        XCTAssertEqual(object["workspace_id"] as? String, "workspace-1")
        XCTAssertEqual(object["workspace_alias"] as? String, "default")
        XCTAssertEqual(object["mode"] as? String, "steer")
        XCTAssertEqual((object["data"] as? [String: Any])?["ticket"] as? String, "ENG-123")
    }

    func testBrokerStatusDecodesParityFields() throws {
        let json = """
        {
          "agent_count": 1,
          "agents": [{
            "name": "Builder",
            "runtime": "pty",
            "cli": "codex",
            "channels": ["dev"],
            "last_activity_ms": 42,
            "context_budget_pct": 12.5,
            "current_state": "blocked_on_send"
          }],
          "pending_delivery_count": 1,
          "pending_deliveries": [{
            "delivery_id": "del_1",
            "worker_name": "Builder",
            "event_id": "evt_1",
            "attempts": 2
          }]
        }
        """.data(using: .utf8)!
        let status = try JSONDecoder().decode(BrokerStatus.self, from: json)
        XCTAssertEqual(status.agentCount, 1)
        XCTAssertEqual(status.agents.first?.currentState, .blockedOnSend)
        XCTAssertEqual(status.pendingDeliveries.first?.deliveryId, "del_1")
    }

    // MARK: - WebSocket URL resolution

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

    // MARK: - REST API URL resolution

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
}
