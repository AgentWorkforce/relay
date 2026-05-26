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
