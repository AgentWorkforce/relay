import XCTest
@testable import AgentRelayiPad

final class RecipientSelectionTests: XCTestCase {
    private let builder = RelayAgent(relay: ["name": "builder", "address": "builder@test-mini-456", "status": "active"])

    func testBareHandleUsesCanonicalRosterIdentity() {
        let recipient = RelayAgent.recipient(" @builder ", in: [builder])
        XCTAssertEqual(recipient.id, builder.id)
        XCTAssertEqual(recipient.address, builder.address)
    }

    func testComposedHandleReconcilesWhenRosterArrivesLater() {
        let composed = RelayAgent.recipient("builder", in: [])
        XCTAssertEqual(composed.rosterMatch(in: [builder]), builder)
        XCTAssertNil(composed.rosterMatch(in: []))
    }

    func testExactAddressDoesNotSwitchToAnotherRegistration() {
        let composed = RelayAgent.recipient("builder@other-host", in: [builder])
        XCTAssertEqual(composed.name, "builder")
        XCTAssertEqual(composed.address, "builder@other-host")
        XCTAssertNil(composed.rosterMatch(in: [builder]))
    }
    func testPersonConversationSurvivesAnOfflineOrMissingRegistration() {
        let person = RelayAgent(relay: ["name": "sam", "type": "human", "status": "offline"])
        XCTAssertEqual(person.rosterMatch(in: [person]), person)
        XCTAssertEqual(person.rosterMatch(in: []), person)
        XCTAssertEqual(RelayAgent.recipient("sam", in: [person]).isHuman, true)
    }

}
