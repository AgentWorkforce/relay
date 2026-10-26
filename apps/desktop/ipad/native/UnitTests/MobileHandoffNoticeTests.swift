import XCTest
@testable import AgentRelayiPad

final class MobileHandoffNoticeTests: XCTestCase {
    func testMissingAndUnknownMetadataNeverClaimAContinuation() {
        XCTAssertNil(MobileHandoffNotice(metadata: [:]))
        XCTAssertNil(MobileHandoffNotice(metadata: ["mobile_handoff_state": "authorized"]))
        XCTAssertNil(MobileHandoffNotice(metadata: ["mobile_handoff_state": "returning"]))
        XCTAssertNil(MobileHandoffNotice(metadata: ["status": "active", "read": true]))
    }

    func testPublishedStatePreservesSessionAndConversationIdentity() {
        let identity: JSONObject = ["source": "relay-desktop", "session_kind": "claude-terminal", "session_id": "original"]
        let before = RelayAgent(relay: ["name": "reviewer", "address": "reviewer@desk-id", "metadata": identity])
        var metadata = identity
        metadata["mobile_handoff_state"] = "ready"
        let after = RelayAgent(relay: ["name": "reviewer", "address": "reviewer@desk-id", "metadata": metadata])
        XCTAssertEqual(before.id, after.id)
        XCTAssertEqual(before.sessionID, after.sessionID)
        XCTAssertNil(before.mobileHandoff)
        XCTAssertEqual(after.mobileHandoff?.state, .ready)
        XCTAssertFalse(MessageDelivery.delivered(readers: [], sender: "person"))
    }

    func testQueuedRequiresExplicitNativeHandoffCapability() {
        var metadata: JSONObject = ["source": "relay-desktop", "session_kind": "claude-terminal", "session_id": "original"]
        let olderCore = RelayAgent(relay: ["name": "reviewer", "metadata": metadata])
        XCTAssertFalse(olderCore.mobileHandoffEnabled)
        XCTAssertEqual(olderCore.deliveryLabel(delivered: false), "Sent")
        metadata["mobile_handoff_enabled"] = false
        let disabled = RelayAgent(relay: ["name": "reviewer", "metadata": metadata])
        XCTAssertEqual(disabled.deliveryLabel(delivered: false), "Sent")
        metadata["mobile_handoff_enabled"] = true
        let enabled = RelayAgent(relay: ["name": "reviewer", "metadata": metadata])
        XCTAssertEqual(enabled.deliveryLabel(delivered: false), "Queued")
        XCTAssertEqual(enabled.deliveryLabel(delivered: true), "Delivered")
        XCTAssertEqual(disabled.deliveryLabel(delivered: true), "Delivered")
    }

    func testFailureDetailsOnlyAccompanyFailedTransitionsAndAreBounded() {
        let detail = String(repeating: "a", count: 700)
        let failed = MobileHandoffNotice(metadata: ["mobile_handoff_state": "failed", "mobile_handoff_error": detail])
        XCTAssertEqual(failed?.detail.count, 500)
        let connecting = MobileHandoffNotice(metadata: ["mobile_handoff_state": "connecting", "mobile_handoff_error": detail])
        XCTAssertEqual(connecting?.detail, "")
    }
}
