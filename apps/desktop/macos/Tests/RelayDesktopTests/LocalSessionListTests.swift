import XCTest
@testable import RelayDesktopCore

final class LocalSessionListTests: XCTestCase {
    private func upload(_ source: String, _ id: String, at: Int64 = 100) -> UploadSession {
        UploadSession(cwd: "/work/cloud", included: false, isAgent: false, lastActivityMs: at,
                      sessionId: id, source: source, status: .notShared, title: "Fix login")
    }
    private func session(_ kind: SessionKind, _ id: String, at: Int64 = 200) -> LocalSession {
        LocalSession(live: true, project: "desktop", suggestedName: "session", target: Target(id: id, kind: kind), title: "Local work", updatedAtMs: at)
    }

    func testHeaderHoverPreviewsTheNextClickAndRestoresCurrentDirection() {
        XCTAssertEqual(SessionColumn.harness.sortColumn, .harness)
        XCTAssertEqual(SessionColumn.model.sortColumn, .model)
        XCTAssertEqual(SessionColumn.reasoning.sortColumn, .reasoning)
        var sort = LocalSessionSort()
        for column in LocalSessionSortColumn.allCases {
            XCTAssertEqual(sort.headerDirection(for: column, previewNext: false), column == .updated ? false : nil)
            var clicked = sort
            clicked.select(column)
            XCTAssertEqual(sort.headerDirection(for: column, previewNext: true), clicked.ascending)
        }
        sort.select(.session)
        XCTAssertEqual(sort.headerDirection(for: .session, previewNext: false), true)
        XCTAssertEqual(sort.headerDirection(for: .session, previewNext: true), false)
        sort.select(.session)
        XCTAssertEqual(sort.headerDirection(for: .session, previewNext: false), false)
        XCTAssertEqual(sort.headerDirection(for: .session, previewNext: true), true)
    }

    func testALiveWindowWinsOverAStoppedManagedSessionWithItsKey() {
        for (managed, open, source) in [(SessionKind.grok, SessionKind.grokOpen, "grok"), (.opencode, .opencodeOpen, "opencode")] {
            let stopped = LocalSession(live: false, project: "desktop", suggestedName: "session",
                                       target: Target(id: "s1", kind: managed), title: "Local work", updatedAtMs: 200)
            let live = session(open, "s1")
            for sessions in [[stopped, live], [live, stopped]] {
                for uploads in [[], [upload(source, "s1")]] {
                    let rows = LocalSessionRow.merge(uploads: uploads, sessions: sessions)
                    XCTAssertEqual(rows.count, 1)
                    XCTAssertEqual(rows.first?.relay?.target, live.target)
                }
                XCTAssertEqual(LocalSessionRow.relaySession(for: "\(source):s1", in: sessions)?.target, live.target)
            }
            XCTAssertEqual(LocalSessionRow.relaySession(for: "\(source):s1", in: [stopped])?.target, stopped.target)
        }
    }

    func testHiddenSessionsSavedUnderARelayRowIDStayHidden() {
        let id = "01a15bca-891b-7ce2-9318-d0683ee0163a"
        let row = LocalSessionRow.merge(uploads: [], sessions: [session(.grokOpen, id)])[0]
        XCTAssertEqual(LocalSessionRow.currentHiddenID("grok-open:\(id)"), row.id)
        for (kind, id) in [(SessionKind.opencodeOpen, "ses_1"), (.museOpen, "m1")] {
            let row = LocalSessionRow.merge(uploads: [], sessions: [session(kind, id)])[0]
            XCTAssertEqual(LocalSessionRow.currentHiddenID("\(kind.rawValue):\(id)"), row.id)
        }
        XCTAssertEqual(LocalSessionRow.currentHiddenID("codex:same"), "codex:same")
        XCTAssertEqual(LocalSessionRow.currentHiddenID("claude-cloud:cse_1"), "claude-cloud:cse_1")
    }

    func testJoinsHistoryWithoutDroppingRelayOnlySessionsOrMixingHarnesses() {
        let rows = LocalSessionRow.merge(uploads: [upload("codex", "same"), upload("claude", "same")],
                                        sessions: [session(.codex, "same"), session(.claudeTerminal, "same"), session(.claudeCloud, "app")])
        XCTAssertEqual(rows.count, 3)
        XCTAssertNil(rows.first?.upload)
        XCTAssertEqual(rows.first?.relay?.target.kind, .claudeCloud)
        XCTAssertEqual(rows.first { $0.id == "codex:same" }?.relay?.target.kind, .codex)
        XCTAssertEqual(rows.first { $0.id == "claude:same" }?.relay?.target.kind, .claudeTerminal)
    }

    func testIdentityStaysStableWhenHistoryArrivesAndSearchIncludesProjectAndSource() {
        let local = session(.codex, "a")
        let before = LocalSessionRow.merge(uploads: [], sessions: [local])
        let after = LocalSessionRow.merge(uploads: [upload("codex", "a")], sessions: [local])
        XCTAssertEqual(before.first?.id, after.first?.id)
        XCTAssertTrue(before[0].matches("upload:discovering"))
        XCTAssertEqual(LocalSessionQuery.suggesting("upload:uploaded", field: "upload", value: "discovering"), "upload:discovering ")
        XCTAssertEqual(LocalSessionQuery.suggesting("upload:discovering", field: "upload", value: "local"), "upload:local ")
        XCTAssertFalse(before[0].matches("upload:local"))
        XCTAssertFalse(before[0].matches("upload:in-progress"))
        XCTAssertFalse(after[0].matches("upload:discovering"))
        XCTAssertTrue(after[0].matches("upload:local"))
        XCTAssertTrue(after[0].matches("LOGIN cloud codex"))
        XCTAssertFalse(after[0].matches("other-machine"))
    }

    func testResolvedProjectWinsAndControllerSuppressionFallsBackToLiveEvidence() throws {
        func upload(project: String?) -> UploadSession {
            UploadSession(cwd: "/relay/test-mini-node", included: false, isAgent: false,
                          project: project, sessionId: "a", source: "codex", status: .notShared,
                          title: "Work")
        }
        let resolved = upload(project: "relay-desktop")
        XCTAssertEqual(LocalSessionRow.merge(uploads: [resolved], sessions: [session(.codex, "a")])[0].project,
                       "relay-desktop")

        let suppressed = upload(project: "")
        XCTAssertEqual(LocalSessionRow.merge(uploads: [suppressed], sessions: [session(.codex, "a")])[0].project,
                       "desktop")

        let legacy = upload(project: nil)
        XCTAssertEqual(LocalSessionRow.merge(uploads: [legacy], sessions: [])[0].project,
                       "test-mini-node")
    }

    func testExecutionDetailsOmitUnknownSettings() throws {
        let upload = try JSONDecoder().decode(UploadSession.self, from: Data(#"{"source":"codex","session_id":"a","title":"Work","is_agent":false,"included":false,"status":"not_shared","models":["gpt-6"],"reasoning_effort":"high","first_activity_ms":1700000000000}"#.utf8))
        let row = LocalSessionRow.merge(uploads: [upload], sessions: [session(.codex, "a")])[0]
        XCTAssertEqual(row.executionDetails(harness: "Codex"), "gpt-6 · Codex · high reasoning")
        XCTAssertEqual(row.modelName, "gpt-6")
        XCTAssertEqual(row.reasoning, "high")
        XCTAssertEqual(row.createdAt?.timeIntervalSince1970, 1_700_000_000)
        XCTAssertEqual(upload.withInclusion(true).models, ["gpt-6"])
        XCTAssertEqual(upload.withInclusion(true).reasoningEffort, "high")
        let unknown = LocalSessionRow.merge(uploads: [], sessions: [session(.codex, "a")])[0]
        XCTAssertEqual(unknown.executionDetails(harness: "Codex"), "Codex")
        XCTAssertEqual(unknown.modelName, "—")
        XCTAssertEqual(unknown.reasoning, "—")
        XCTAssertNil(unknown.createdAt)
    }

    func testColumnSortingMatchesSharedContractInBothDirections() throws {
        struct Input: Decodable { let session: UploadSession; let status: String?; let relay: Bool?; let upload: Bool? }
        struct Case: Decodable { let column: String; let ascending: [String]; let descending: [String] }
        struct Fixture: Decodable { let rows: [Input]; let cases: [Case] }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("shared/session-sort-cases.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file))
        let rows = LocalSessionRow.merge(uploads: fixture.rows.map(\.session), sessions: [])
        let byID = Dictionary(uniqueKeysWithValues: fixture.rows.map { ($0.session.id, $0) })
        for test in fixture.cases {
            let column = try XCTUnwrap(LocalSessionSortColumn(rawValue: test.column))
            var sort = LocalSessionSort()
            sort.select(column)
            for _ in 0..<2 {
                let result = sort.sorted(rows, status: { byID[$0.id]?.status },
                                         onRelay: { byID[$0.id]?.relay }, uploadEnabled: { byID[$0.id]?.upload })
                XCTAssertEqual(result.map(\.id), sort.ascending ? test.ascending : test.descending, test.column)
                sort.select(column)
            }
        }
        var sort = LocalSessionSort()
        XCTAssertEqual(sort.column, .updated)
        XCTAssertFalse(sort.ascending)
        sort.select(.session)
        XCTAssertTrue(sort.ascending)
        sort.select(.session)
        XCTAssertFalse(sort.ascending)
        sort.select(.updated)
        XCTAssertFalse(sort.ascending)
    }

    func testWeekMatchesCloudMondayUTCIncludingYearBoundary() {
        let formatter = ISO8601DateFormatter()
        XCTAssertEqual(LocalSessionGrouping.week(formatter.date(from: "2026-01-04T23:59:59Z")), "Week of Dec 29, 2025")
        XCTAssertEqual(LocalSessionGrouping.week(formatter.date(from: "2026-01-05T00:00:00Z")), "Week of Jan 5, 2026")
        XCTAssertEqual(LocalSessionGrouping.week(nil), "Unknown week")
    }
}
