import XCTest
@testable import AgentRelaySDK

final class AgentRelaySDKTests: XCTestCase {
    func testRelayCastInit() {
        let relay = RelayCast(apiKey: "rk_test_key")
        XCTAssertEqual(relay.apiKey, "rk_test_key")
    }

    func testChannelCreation() {
        let relay = RelayCast(apiKey: "rk_test_key")
        let channel = relay.channel("test-channel")
        XCTAssertEqual(channel.name, "test-channel")
    }

    func testRelayCastUsesDefaultLocalBrokerURL() {
        let relay = RelayCast(apiKey: "rk_test_key")
        XCTAssertEqual(relay.baseURL.host, "localhost")
        XCTAssertEqual(relay.baseURL.port, 3889)
    }

    /// v7 broker emits each event as a bare `{kind: ...}` JSON object on `/ws`.
    /// Make sure the SDK can still decode the broker's wire format.
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
