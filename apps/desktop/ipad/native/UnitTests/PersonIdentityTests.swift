import XCTest
@testable import AgentRelayiPad

final class PersonIdentityTests: XCTestCase {
    func testInitialsFromDisplayNameOrHandle() {
        XCTAssertEqual(PersonIdentity.initials(displayName: "Ada Lovelace", handle: "ada-lovelace"), "AL")
        XCTAssertEqual(PersonIdentity.initials(displayName: "", handle: "ada-lovelace"), "AL")
        XCTAssertEqual(PersonIdentity.initials(displayName: "Ada", handle: "ada"), "A")
        XCTAssertEqual(PersonIdentity.initials(displayName: "Mary Ann Lee", handle: "mal"), "ML")
        XCTAssertEqual(PersonIdentity.initials(displayName: " ", handle: ""), "?")
    }

    func testPersonHasNoMachineAndUsesPersonaAsName() {
        let person = RelayAgent(relay: ["name": "ada-lovelace", "type": "human", "persona": "Ada Lovelace",
                                        "address": "ada-lovelace@linux-host-234069537366298624"])
        XCTAssertTrue(person.isHuman)
        XCTAssertEqual(person.displayName, "Ada Lovelace")
        XCTAssertEqual(person.machine, "")
        XCTAssertEqual(person.subtitle, "ada-lovelace")
    }

    func testAgentKeepsMachineAndPersona() {
        let agent = RelayAgent(relay: ["name": "builder", "type": "agent", "persona": "reviewer",
                                       "address": "builder@test-mini-123", "metadata": ["host": "test-mini"]])
        XCTAssertFalse(agent.isHuman)
        XCTAssertEqual(agent.displayName, "")
        XCTAssertEqual(agent.machine, "test-mini")
        XCTAssertEqual(agent.subtitle, "test-mini · reviewer")
    }

    func testConversationCarriesPersonFromAgentMetadata() {
        let thread: JSONObject = ["id": "dm_1", "is_human": true, "display_name": "Sam Lee",
                                  "participants": [["agent_name": "sam-lee"]]]
        let row = RelayAgent(conversation: thread)
        XCTAssertTrue(row.isHuman)
        XCTAssertEqual(row.displayName, "Sam Lee")
        XCTAssertEqual(row.machine, "")
    }
}
