import XCTest
import RelayDesktopCore

final class AgentNameTests: XCTestCase {
    func testARenamedAgentIsShownByItsAliasAndExplainsItsName() {
        XCTAssertEqual(AgentNameText.displayName(name: "codex-api", alias: nil), "codex-api")
        XCTAssertEqual(AgentNameText.displayName(name: "codex-api", alias: "reviewer"), "reviewer")
        XCTAssertNil(AgentNameText.aliasDetail(name: "codex-api", alias: nil))
        XCTAssertEqual(AgentNameText.aliasDetail(name: "codex-api", alias: "reviewer"),
                       "Renamed from @codex-api. Only @reviewer is shown and replies come from it; messages still sent to @codex-api arrive here.")
        XCTAssertEqual(AgentNameText.renameNote(name: "codex-api", alias: nil),
                       "Renaming replaces this name: only the new one is shown, and replies come from it. Messages already sent to @codex-api still arrive.")
        XCTAssertEqual(AgentNameText.renameNote(name: "codex-api", alias: "reviewer"),
                       "Renamed from @codex-api, which only forwards messages sent to it. Renaming again replaces @reviewer, which keeps forwarding for 24 hours.")
        XCTAssertEqual(AgentNameText.renamed(name: "codex-api", previousAlias: nil, requested: "reviewer"),
                       "Now @reviewer. Messages already sent to @codex-api still arrive.")
        XCTAssertEqual(AgentNameText.renamed(name: "codex-api", previousAlias: "reviewer", requested: "lead"),
                       "Now @lead. Messages sent to @reviewer still arrive for 24 hours.")
        XCTAssertEqual(AgentNameText.renamed(name: "codex-api", previousAlias: "reviewer", requested: "codex-api"),
                       "Back to @codex-api. Messages sent to @reviewer still arrive for 24 hours.")
    }

    func testTheSessionListShowsAndFindsTheAgentByEitherName() throws {
        let rows = LocalSessionRow.merge(uploads: [], sessions: [
            LocalSession(live: true, suggestedName: "one", target: Target(id: "one", kind: .codex), title: "One"),
            LocalSession(live: true, registration: SessionRegistration(addedBySession: false, address: "codex-api@mac", alias: "reviewer", name: "codex-api"),
                         suggestedName: "two", target: Target(id: "two", kind: .codex), title: "Two"),
        ])
        let off = try XCTUnwrap(rows.first { $0.title == "One" })
        let renamed = try XCTUnwrap(rows.first { $0.title == "Two" })
        XCTAssertNil(off.agentName)
        XCTAssertEqual(renamed.agentName, "reviewer")
        XCTAssertEqual(renamed.agentDetail, "Renamed from @codex-api. Only @reviewer is shown and replies come from it; messages still sent to @codex-api arrive here.")
        // Partial or exact, by alias, name or address, with or without `@`.
        for query in ["agent:reviewer", "agent:codex-api", "reviewer", "revi", "@reviewer", "@codex",
                      "agent:@codex-api", "codex-api@mac", "@codex-api@mac"] {
            XCTAssertEqual(rows.filter { LocalSessionQuery(query).matches($0) }.map(\.title), ["Two"], query)
        }
    }
}
