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
}
