import XCTest
@testable import RelayDesktopCore

final class LocalSessionQueryTests: XCTestCase {
    private func row(at: String = "2026-10-11T23:59:59Z", live: Bool = true) -> LocalSessionRow {
        let ms = Int64(ISO8601DateFormatter().date(from: at)!.timeIntervalSince1970 * 1000)
        let upload = UploadSession(cwd: "/work/cloud", included: false, isAgent: false, lastActivityMs: ms,
                                   sessionId: "one", source: "codex", status: .notShared, title: "Fix login")
        let local = LocalSession(live: live, suggestedName: "session", target: Target(id: "one", kind: .codex), title: "Local work")
        return LocalSessionRow.merge(uploads: [upload], sessions: [local])[0]
    }

    func testSharedSearchContract() throws {
        struct Case: Decodable { let query: String; let matches: Bool?; let invalid: Bool? }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("shared/session-search-cases.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
        for test in cases {
            let query = LocalSessionQuery(test.query)
            if let expected = test.matches { XCTAssertEqual(query.matches(row()), expected, test.query) }
            XCTAssertEqual(query.error != nil, test.invalid == true, test.query)
        }
    }

    func testSharedFilterMenuActions() throws {
        struct Action: Decodable { let query: String; let field: String; let value: String; let expected: String }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("shared/session-filter-actions.json")
        let actions = try JSONDecoder().decode([Action].self, from: Data(contentsOf: file))
        for action in actions {
            XCTAssertEqual(LocalSessionQuery(action.query).applyingFilter(action.field, to: action.value), action.expected)
        }
    }

    func testDateMidnightBoundariesAndMissingDates() {
        XCTAssertTrue(row(at: "2026-10-11T00:00:00Z").matches("updated:2026-10-11"))
        XCTAssertFalse(row(at: "2026-10-12T00:00:00Z").matches("updated:2026-10-11"))
        let undated = LocalSessionRow.merge(uploads: [], sessions: [LocalSession(live: true, suggestedName: "a", target: Target(id: "a", kind: .codex), title: "Undated")])[0]
        XCTAssertFalse(undated.matches("updated:>=2026-10-01"))
        XCTAssertTrue(undated.matches("is:active upload:none"))
        XCTAssertTrue(row(live: false).matches("is:inactive"))
    }

    func testMenuEditsReplaceOnlyTheirQualifierAndPreserveQuotes() {
        let original = "title: \"Fix login\" -harness:claude harness:codex updated:>=2026-10-01"
        let changed = LocalSessionQuery(original).setting("harness", to: "cursor")
        XCTAssertEqual(changed, "title:\"Fix login\" updated:>=2026-10-01 harness:cursor")
        XCTAssertEqual(LocalSessionQuery(changed).setting("harness", to: nil), "title:\"Fix login\" updated:>=2026-10-01")
        XCTAssertEqual(LocalSessionQuery("title: \"Fix: login\"").value(for: "title"), "Fix: login")
        XCTAssertEqual(LocalSessionQuery("title:\"Fix \\\"login\\\"\"").value(for: "title"), "Fix \"login\"")
    }

    func testLiveUploadStateIsUsedAndAllFiltersIntersect() {
        XCTAssertTrue(LocalSessionQuery("is:active upload:paused project:cloud").matches(row(), uploadState: .paused))
        XCTAssertFalse(LocalSessionQuery("is:active upload:uploaded project:cloud").matches(row(), uploadState: .paused))
        XCTAssertFalse(LocalSessionQuery("is:active harness:claude").matches(row()))
    }
}
