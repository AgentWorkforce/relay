import XCTest
@testable import AgentRelayiPad

final class MessageDeliveryTests: XCTestCase {
    func testNoReadersIsNotDelivered() {
        XCTAssertFalse(MessageDelivery.delivered(readers: [], sender: "ada-lovelace"))
    }

    func testRecipientReaderIsDelivered() {
        let readers: [[String: Any]] = [["agent_name": "ios-app", "agent_id": "1", "read_at": "2026-10-08T12:55:15.000Z"]]
        XCTAssertTrue(MessageDelivery.delivered(readers: readers, sender: "ada-lovelace"))
    }

    func testSenderReadingOwnMessageIsNotDelivered() {
        XCTAssertFalse(MessageDelivery.delivered(readers: [["agent_name": "ada-lovelace"]], sender: "ada-lovelace"))
    }

    func testCamelCaseReaderName() {
        XCTAssertTrue(MessageDelivery.delivered(readers: [["agentName": "ios-app"]], sender: "ada-lovelace"))
    }
}
