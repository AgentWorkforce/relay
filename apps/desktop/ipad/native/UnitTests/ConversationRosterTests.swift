import XCTest
@testable import AgentRelayiPad

final class ConversationRosterTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func agent(_ name: String = "builder", status: String = "active", seen: Date? = nil,
                       desktop: Bool = true) -> RelayAgent {
        var data: JSONObject = ["name": name, "status": status,
                                "metadata": ["source": desktop ? "relay-desktop" : "other"]]
        if let seen { data["last_seen"] = seen.ISO8601Format() }
        return RelayAgent(relay: data)
    }

    func testOwnIdentityIsExcludedFromBothListsWithoutHidingOtherPeople() {
        let me = RelayAgent(relay: ["name": "ada", "type": "human", "status": "online"])
        let person = RelayAgent(relay: ["name": "sam", "type": "human", "status": "online"])
        var roster = ConversationRoster()
        roster.replace([me, person, agent()], excluding: "ada")
        XCTAssertEqual(roster.listedAgents.map(\.name), ["sam", "builder"])
        XCTAssertFalse(roster.includes("ada", metadata: me, at: now))
        XCTAssertTrue(roster.includes("sam", metadata: person, at: now))
        roster.replace([], excluding: "ada")
        XCTAssertFalse(roster.includes("ada", metadata: me, at: now))
        roster.replace([me], excluding: "sam")
        XCTAssertEqual(roster.listedAgents.map(\.name), ["ada"])
    }

    func testForwardingNamesAndDuplicateRowsDoNotAppearInEitherList() {
        let old = RelayAgent(relay: ["name": "old-builder", "status": "active",
                                    "metadata": ["renamed_to": "builder"]])
        let current = agent()
        var roster = ConversationRoster()
        roster.replace([old, current, current, agent("")])
        XCTAssertEqual(roster.listedAgents.map(\.name), ["builder"])
        XCTAssertFalse(roster.includes("old-builder", metadata: old, at: now))
        XCTAssertTrue(roster.includes("builder", metadata: current, at: now))
        let restored = RelayAgent(relay: ["name": "old-builder", "status": "active",
                                         "metadata": ["renamed_to": ""]])
        roster.replace([restored])
        XCTAssertEqual(roster.listedAgents.map(\.name), ["old-builder"])
    }

    func testSnapshotRemovalWinsOverCachedMetadataAndLateLookup() {
        let builder = agent()
        var roster = ConversationRoster()
        roster.replace([builder])
        XCTAssertTrue(roster.includes("builder", metadata: builder, at: now))
        roster.replace([])
        XCTAssertFalse(roster.includes("builder", metadata: builder, at: now))
        // The enrichment endpoint may still return an old active record.
        XCTAssertFalse(roster.includes("builder", metadata: agent(), at: now))
        roster.replace([builder])
        XCTAssertTrue(roster.includes("builder", metadata: builder, at: now))
    }

    func testAllAgentsDoesNotBringOfflineThreadsBack() {
        var roster = ConversationRoster()
        let offline = agent(status: "idle")
        roster.replace([offline])
        XCTAssertFalse(roster.includes("builder", metadata: agent(), at: now))
        XCTAssertFalse(offline.isReachable(at: now))
    }

    func testPeopleKeepTheirConversationsWhileOfflineOrAbsent() {
        let person = RelayAgent(relay: ["name": "sam", "type": "human", "status": "offline"])
        var roster = ConversationRoster()
        roster.replace([person])
        XCTAssertTrue(roster.includes("sam", metadata: nil, at: now))
        roster.replace([])
        XCTAssertTrue(roster.includes("sam", metadata: person, at: now))
        XCTAssertFalse(roster.includes("unknown", metadata: nil, at: now))
    }

    func testHeartbeatExpiryMatchesCoreIncludingFutureAndMissingTimestamps() {
        XCTAssertTrue(agent(seen: now.addingTimeInterval(-300)).isReachable(at: now))
        XCTAssertFalse(agent(seen: now.addingTimeInterval(-301)).isReachable(at: now))
        XCTAssertTrue(agent(seen: now.addingTimeInterval(60)).isReachable(at: now))
        XCTAssertTrue(agent().isReachable(at: now))
        let fractional = RelayAgent(relay: ["name": "builder", "status": "online",
                                            "last_seen": Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(now)])
        XCTAssertTrue(fractional.isReachable(at: now))
        XCTAssertNotNil(fractional.lastSeen)
    }

    func testWaitingAgentsAreReachableButEndedDesktopSessionsAreNot() {
        for status in ["active", "online", "waiting", "blocked"] {
            XCTAssertTrue(agent(status: status, seen: now).isReachable(at: now), status)
        }
        XCTAssertTrue(agent(status: "idle", seen: now, desktop: false).isReachable(at: now))
        for status in ["idle", "offline", "deleted", ""] {
            XCTAssertFalse(agent(status: status, seen: now).isReachable(at: now), status)
        }
    }
}
