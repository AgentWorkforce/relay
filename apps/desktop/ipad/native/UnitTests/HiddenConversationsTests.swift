import XCTest
@testable import AgentRelayiPad

final class HiddenConversationsTests: XCTestCase {
    func testHideAndUnhide() {
        var hidden = HiddenConversations()
        hidden.hide("dm_1", latestMessageID: "m1")
        XCTAssertTrue(hidden.contains("dm_1"))
        XCTAssertFalse(hidden.contains("dm_2"))
        hidden.unhide("dm_1")
        XCTAssertTrue(hidden.isEmpty)
    }

    func testStaysHiddenWithoutNewMessage() {
        var hidden = HiddenConversations()
        hidden.hide("dm_1", latestMessageID: "m1")
        XCTAssertFalse(hidden.reveal(newerThan: ["dm_1": "m1"]))
        XCTAssertFalse(hidden.reveal(newerThan: [:]))
        XCTAssertTrue(hidden.contains("dm_1"))
    }

    func testNewMessageRevealsConversation() {
        var hidden = HiddenConversations()
        hidden.hide("dm_1", latestMessageID: "m1")
        hidden.hide("dm_2", latestMessageID: "m7")
        XCTAssertTrue(hidden.reveal(newerThan: ["dm_1": "m2", "dm_2": "m7"]))
        XCTAssertFalse(hidden.contains("dm_1"))
        XCTAssertTrue(hidden.contains("dm_2"))
    }

    func testFirstMessageRevealsConversationHiddenWithoutOne() {
        var hidden = HiddenConversations()
        hidden.hide("dm_1", latestMessageID: nil)
        XCTAssertFalse(hidden.reveal(newerThan: ["dm_1": ""]))
        XCTAssertTrue(hidden.reveal(newerThan: ["dm_1": "m1"]))
        XCTAssertTrue(hidden.isEmpty)
    }

    func testOwnLaterMessageStillRevealsAMissedReply() {
        // Hidden at m1; the agent replied (m2) and the person answered from
        // another device (m3) before this device refreshed.
        var hidden = HiddenConversations()
        hidden.hide("dm_1", latestMessageID: "m1")
        XCTAssertTrue(hidden.reveal(newerThan: ["dm_1": "m3"]))
        XCTAssertTrue(hidden.isEmpty)
    }

    func testIgnoresEmptyConversationID() {
        var hidden = HiddenConversations()
        hidden.hide("", latestMessageID: "m1")
        XCTAssertTrue(hidden.isEmpty)
    }
}
