import XCTest
@testable import RelayDesktopCore

final class AgentSummaryTests: XCTestCase {
    func testSummaryPriority() {
        XCTAssertEqual(AgentSummary.line(summary: "Fixing cloud#4136", latestOutgoing: "Review posted",
                                         description: "Old task", status: "active", lastSeenMs: nil),
                       "Fixing cloud#4136")
        XCTAssertEqual(AgentSummary.line(latestOutgoing: "Review posted", description: "Old task",
                                         status: "active", lastSeenMs: nil), "Review posted")
    }

    func testSpawnPromptUsesDeclaredSummaryOnly() {
        XCTAssertEqual(AgentSummary.useful("You are do-messages. Your full brief is ~/relay-briefs/do-messages.md. Summary: Fixing review findings on cloud#4136. Send an acknowledgement."),
                       "Fixing review findings on cloud#4136.")
        XCTAssertNil(AgentSummary.useful("You are do-messages. Your full brief is ~/relay-briefs/do-messages.md."))
        XCTAssertEqual(AgentSummary.line(description: "You are do-messages. Read the brief.",
                                         status: "active", lastSeenMs: nil),
                       "Active · task details unavailable")
    }

    func testKeepsUsefulObjectiveAndIdleStatus() {
        XCTAssertEqual(AgentSummary.useful("  Fixing review findings on cloud#4136. Run tests afterward.  "),
                       "Fixing review findings on cloud#4136.")
        XCTAssertEqual(AgentSummary.line(summary: "Old task", description: "Other task",
                                         status: "idle", lastSeenMs: nil), "Idle")
    }

    func testIdleStatusIncludesDateOnlyWhenItIsNotToday() {
        let calendar = Calendar.current
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 4, hour: 12))!
        let today = calendar.date(from: DateComponents(year: 2026, month: 10, day: 4, hour: 9, minute: 5))!
        let yesterday = calendar.date(from: DateComponents(year: 2026, month: 10, day: 3, hour: 18, minute: 45))!
        let milliseconds: (Date) -> Int64 = { Int64($0.timeIntervalSince1970 * 1_000) }
        XCTAssertEqual(AgentSummary.line(description: "", status: "idle", lastSeenMs: milliseconds(today), now: now),
                       "Idle since \(today.formatted(date: .omitted, time: .shortened))")
        XCTAssertEqual(AgentSummary.line(description: "", status: "idle", lastSeenMs: milliseconds(yesterday), now: now),
                       "Idle since \(yesterday.formatted(date: .abbreviated, time: .shortened))")
    }

    func testMentionsAreBoundedAndDeduplicated() {
        XCTAssertEqual(AgentSummary.mentions("Review cloud#4136 and https://github.com/acme/cloud/pull/4136. Then cloud#4136"),
                       ["cloud#4136", "https://github.com/acme/cloud/pull/4136"])
    }

    func testMachineGroupsAreCaseInsensitiveAndUnknownIsLast() {
        let rows = [
            RosterAgent(address: "z@desktop-id", description: "", host: "sf-frame", isSelf: true,
                        kind: "agent", liveness: .live, name: "same", status: "active", where: .otherDesktop),
            RosterAgent(address: "unknown@not-a-host", description: "", isSelf: true,
                        kind: "agent", liveness: .live, name: "unknown", status: "active", where: .otherDesktop),
            RosterAgent(address: "alpha@desktop-id", description: "", host: "alpha", isSelf: true,
                        kind: "agent", liveness: .live, name: "alpha", status: "active", where: .otherDesktop),
            RosterAgent(address: "a@desktop-id", description: "", host: "SF-FRAME", isSelf: true,
                        kind: "agent", liveness: .live, name: "same", status: "active", where: .otherDesktop),
            RosterAgent(address: "literal@desktop-id", description: "", host: "Unknown machine", isSelf: true,
                        kind: "agent", liveness: .live, name: "literal", status: "active", where: .otherDesktop),
        ]
        let groups = RosterMachineGroup.make(rows)
        XCTAssertEqual(groups.map(\.name), ["alpha", "SF-FRAME", "Unknown machine", "Unknown machine"])
        XCTAssertEqual(groups[1].agents.compactMap(\.address), ["a@desktop-id", "z@desktop-id"])
        XCTAssertEqual(groups[3].agents.first?.address, "unknown@not-a-host")
        XCTAssertNotEqual(groups[2].id, groups[3].id)

        let lowercaseOnly = RosterMachineGroup.make([rows[0]]).first
        XCTAssertEqual(groups[1].id, lowercaseOnly?.id)
        XCTAssertNotEqual(groups[1].name, lowercaseOnly?.name)
    }

    func testFleetAttachCommandUsesCanonicalNodeID() {
        XCTAssertEqual(FleetAttachCommand.make(workerName: "builder", nodeId: "node-1"),
                       "agent-relay node agent attach 'builder' --node 'node-1'")
        XCTAssertEqual(FleetAttachCommand.make(workerName: "builder", nodeId: ""),
                       "agent-relay node agent attach 'builder'")
        XCTAssertEqual(FleetAttachCommand.make(workerName: "builder", nodeId: "/Users/me/.agentworkforce"),
                       "agent-relay node agent attach 'builder'")
    }

    func testRosterRowsDrawTheHarnessMarkOnlyWhenAProviderIsKnown() {
        func agent(_ provider: String?, kind: String = "agent") -> RosterAgent {
            RosterAgent(address: "code-desktop-cool@test-mini", description: "", isSelf: true, kind: kind, liveness: .live,
                        name: "code-desktop-cool", provider: provider, status: "active", where: .otherDesktop)
        }
        XCTAssertEqual(agent("claude").harnessSource, "claude")
        XCTAssertEqual(agent(" codex ").harnessSource, "codex")
        XCTAssertNil(agent(nil).harnessSource)
        XCTAssertNil(agent("  ").harnessSource)
        XCTAssertNil(agent(nil, kind: "human").harnessSource)
    }
}
