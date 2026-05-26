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
}
