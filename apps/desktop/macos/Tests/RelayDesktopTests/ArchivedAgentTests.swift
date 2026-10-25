import XCTest
@testable import RelayDesktopCore

final class ArchivedAgentTests: XCTestCase {
    private let agent = ArchivedAgent(address: "codex-api@desk-1", archivedAt: "2026-10-10T12:00:00Z",
                                      name: "codex-api", target: Target(id: "t", kind: .codex), title: "Fix tests")

    func testDetailSaysWhenAndThatTheNameWasReleased() {
        let now = ISO8601DateFormatter().date(from: "2026-10-10T12:05:00Z")!
        XCTAssertEqual(ArchivedAgentText.detail(archivedAt: agent.archivedAt, now: now),
                       "Session archived 5 minutes ago · name released")
        XCTAssertEqual(ArchivedAgentText.detail(archivedAt: "not a time", now: now),
                       "Session archived · name released")
    }

    func testSearchFindsNameTitleOrAddress() {
        XCTAssertTrue(ArchivedAgentText.matches(agent, search: ""))
        XCTAssertTrue(ArchivedAgentText.matches(agent, search: "CODEX"))
        XCTAssertTrue(ArchivedAgentText.matches(agent, search: "fix"))
        XCTAssertTrue(ArchivedAgentText.matches(agent, search: "desk-1"))
        XCTAssertFalse(ArchivedAgentText.matches(agent, search: "claude"))
    }
}
