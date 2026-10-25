import XCTest
@testable import RelayDesktopCore

final class MessageDeliveryTests: XCTestCase {
    private func agent(_ liveness: Liveness, lastSeenMs: Int64? = nil) -> RosterAgent {
        RosterAgent(address: "bot@box", description: "", isSelf: false, kind: "agent", lastSeenMs: lastSeenMs,
                    liveness: liveness, name: "bot", status: liveness == .live ? "active" : "idle", where: .otherDesktop)
    }

    func testANoteSaysWhatRelaycastHoldsNeverWhatPresenceSuggests() {
        let live = Recipient(agent: agent(.live), known: true)
        let offline = Recipient(agent: agent(.offline), known: true)
        XCTAssertEqual(MessageDelivery.note(.queued, recipient: live).text, "Queued — not yet handed to the agent")
        XCTAssertEqual(MessageDelivery.note(.queued, recipient: offline).text, "Queued — agent not running")
        XCTAssertEqual(MessageDelivery.note(.queued, recipient: offline).tone, .waiting)
        XCTAssertEqual(MessageDelivery.note(.delivered, recipient: offline).text, "Delivered")
        XCTAssertEqual(MessageDelivery.note(.pickedUp, recipient: nil).text, "Picked up by the agent")
        XCTAssertEqual(MessageDelivery.note(.noSuchAgent, recipient: nil).tone, .failed)
        XCTAssertEqual(MessageDelivery.note(nil, recipient: live).text, "Sent — delivery unknown")
    }

    func testARecipientThatIsNotRunningIsWarnedAbout() {
        XCTAssertNil(MessageDelivery.warning(for: Recipient(agent: agent(.live), known: true)))
        XCTAssertNil(MessageDelivery.warning(for: Recipient(agent: agent(.idle), known: true)))
        XCTAssertEqual(MessageDelivery.warning(for: Recipient(agent: agent(.offline), known: true)),
                       "@bot is not running right now. Queue anyway?")
        XCTAssertTrue(MessageDelivery.queues(Recipient(agent: agent(.offline), known: true)))
        XCTAssertEqual(MessageDelivery.warning(for: Recipient(known: true)), "No agent has this name or address.")
        XCTAssertNil(MessageDelivery.warning(for: Recipient(known: false)), "another workspace says nothing")
    }

    func testTheConversationSaysWhetherAReplyIsExpected() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let seen = Int64(now.timeIntervalSince1970 * 1_000) - 3_600_000
        let offline = MessageDelivery.replyNote(for: Recipient(agent: agent(.offline, lastSeenMs: seen), known: true), now: now)
        XCTAssertEqual(offline, "Not running, last seen 1 hour ago — no reply until it runs again.")
        XCTAssertEqual(MessageDelivery.replyNote(for: Recipient(agent: agent(.live), known: true), now: now),
                       "Running — a reply can come any time.")
        XCTAssertTrue(MessageDelivery.replyNote(for: Recipient(agent: agent(.idle), known: true), now: now)?.hasPrefix("Idle") == true)
        XCTAssertEqual(MessageDelivery.replyNote(for: Recipient(known: true), now: now), "No such agent — no reply is expected.")
        XCTAssertNil(MessageDelivery.replyNote(for: Recipient(known: false), now: now))
    }
}
