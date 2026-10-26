import XCTest
@testable import AgentRelayiPad

final class MobileConversationNavigationTests: XCTestCase {
    func testMetadataRefreshRetainsNavigationIdentityWithoutFreezingAgentMetadata() {
        let original = RelayAgent(relay: ["name": "reviewer", "status": "active",
                                          "metadata": ["session_title": "Original task"]])
        let refreshed = RelayAgent(relay: ["name": "reviewer", "status": "idle",
                                           "metadata": ["session_title": "Updated task", "mobile_handoff_state": "ready"]])
        XCTAssertNotEqual(original, refreshed)
        XCTAssertEqual(MobileConversationRoute(agent: original), MobileConversationRoute(agent: refreshed))
        XCTAssertEqual(Set([MobileConversationRoute(agent: original), MobileConversationRoute(agent: refreshed)]).count, 1)
        XCTAssertEqual(MobileConversationRoute(agent: refreshed).agent.mobileHandoff?.state, .ready)
        XCTAssertNotEqual(MobileConversationRoute(agent: original),
                          MobileConversationRoute(agent: RelayAgent(relay: ["name": "builder"])))
    }

    func testReconciledSendMovesFromPendingToPersistedEvenWhenHistoryCountIsUnchanged() {
        let pending = MobileChatScrollTarget.latest(pending: ["outgoing"], messages: ["previous"])
        // The server may replace its history window rather than grow it. The
        // pending removal must still target the persisted row and its receipt.
        let completed = MobileChatScrollTarget.latest(pending: [], messages: ["outgoing"])
        XCTAssertEqual(pending, .pending("outgoing"))
        XCTAssertEqual(completed, .message("outgoing"))
        XCTAssertNotEqual(pending, completed)
    }

    func testNewerPendingSendKeepsPriorityWhileEarlierSendReconciles() {
        XCTAssertEqual(MobileChatScrollTarget.latest(pending: ["second"], messages: ["original", "first"]),
                       .pending("second"))
        XCTAssertEqual(MobileChatScrollTarget.latest(pending: [], messages: ["original", "first", "second"]),
                       .message("second"))
        XCTAssertNil(MobileChatScrollTarget.latest(pending: [], messages: []))
    }

    func testNewServerHistoryRetriggersScrollWhileRetainedPendingRowStillWins() {
        let before = MobileChatScrollRequest(pending: ["failed-send"], messages: ["original"])
        let incoming = MobileChatScrollRequest(pending: ["failed-send"], messages: ["original", "reply"])
        XCTAssertEqual(before.target, .pending("failed-send"))
        XCTAssertEqual(incoming.target, before.target)
        XCTAssertNotEqual(incoming, before)
        XCTAssertEqual(incoming.latestMessageID, "reply")
    }

}
