import XCTest
@testable import AgentRelayiPad

@MainActor final class PendingNotificationTests: XCTestCase {
    func testNotificationWaitsForRosterThenOpensOnlyOnce() {
        let state = RelayPushState()
        state.pendingConversationID = "dm_builder"
        XCTAssertNil(state.takePendingConversation { _ in nil })
        XCTAssertEqual(state.pendingConversationID, "dm_builder")
        let builder = RelayAgent(conversation: ["participants": [["agent_name": "builder"]]])
        let opened = state.takePendingConversation { id in id == "dm_builder" ? builder : nil }
        XCTAssertEqual(opened, builder)
        XCTAssertNil(state.pendingConversationID)
        XCTAssertNil(state.takePendingConversation { _ in builder })
    }

    func testNewerNotificationReplacesOneStillWaitingForPresence() {
        let state = RelayPushState()
        state.pendingConversationID = "dm_old"
        XCTAssertNil(state.takePendingConversation { _ in nil })
        state.pendingConversationID = "dm_builder"
        let builder = RelayAgent(conversation: ["participants": [["agent_name": "builder"]]])
        XCTAssertEqual(state.takePendingConversation { id in id == "dm_builder" ? builder : nil }, builder)
    }
}
