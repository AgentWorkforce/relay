import XCTest
import RelayDesktopCore
@testable import RelayDesktop

@MainActor
final class SessionSearchProjectionTests: XCTestCase {
    func testPaginationRejectsEmptyInitialAndStaleResultLayouts() {
        XCTAssertFalse(SessionListEndSignal(visible: true, generation: 0)
            .canLoadMore(generation: 0, isPending: false), "The initial empty projection is not a loaded page")
        let shortResults = SessionListEndSignal(visible: true, generation: 1)
        XCTAssertFalse(shortResults.canLoadMore(generation: 2, isPending: false),
            "Old end-of-list geometry must not page newly committed results")
        XCTAssertFalse(shortResults.canLoadMore(generation: 1, isPending: true))
        XCTAssertTrue(shortResults.canLoadMore(generation: 1, isPending: false),
            "A settled filtered viewport must still fill itself")
        XCTAssertFalse(SessionListEndSignal(visible: false, generation: 2)
            .canLoadMore(generation: 2, isPending: false))
    }

    func testPaginationPreferenceDoesNotMixVisibilityAcrossGenerations() {
        let stale = SessionListEndSignal(visible: true, generation: 1)
        let current = SessionListEndSignal(visible: false, generation: 2)
        for measurements in [[stale, current], [current, stale]] {
            var combined = SessionListEndPreference.defaultValue
            for measurement in measurements {
                SessionListEndPreference.reduce(value: &combined) { measurement }
            }
            XCTAssertEqual(combined, current, "Only the newest layout may decide whether to page")
            XCTAssertFalse(combined.canLoadMore(generation: 2, isPending: false))
        }
        var combined = current
        SessionListEndPreference.reduce(value: &combined) {
            SessionListEndSignal(visible: true, generation: 2)
        }
        XCTAssertTrue(combined.canLoadMore(generation: 2, isPending: false))
    }

    private func snapshot(_ query: String) -> SessionSearchSnapshot {
        let rows = LocalSessionRow.merge(uploads: [], sessions: [
            LocalSession(live: true, suggestedName: "one", target: Target(id: "one", kind: .codex), title: "One"),
            LocalSession(live: false, registration: SessionRegistration(addedBySession: false, address: "two@mac", name: "two"), suggestedName: "two", target: Target(id: "two", kind: .codex), title: "Two")
        ])
        return SessionSearchSnapshot(entries: rows.map {
            SessionSearchSnapshot.Entry(row: $0, uploadState: nil, status: nil, onRelay: false, uploadEnabled: nil)
        }, query: query, sort: LocalSessionSort())
    }
    func testHiddenSessionsAreExcludedBeforeSearchAndGroupingUnlessShown() {
        var input = snapshot("")
        input.hiddenSessionIDs = ["codex:one"]
        input.grouping = .harness
        XCTAssertEqual(input.results().rows.map(\.title), ["Two"])
        XCTAssertEqual(input.results().groups.flatMap(\.rows).count, 1)
        input.showHiddenSessions = true
        XCTAssertEqual(input.results().rows.count, 2)
        input.showHiddenSessions = false
        input.hiddenSessionIDs = ["codex:one", "codex:two"]
        XCTAssertTrue(input.results().groups.isEmpty)
    }

    func testMessageFiltersComposeWithSearchAndIncludeOfflineRegistrations() {
        XCTAssertEqual(snapshot("is:on-relay").results().rows.map(\.title), ["Two"])
        XCTAssertEqual(snapshot("is:off-relay").results().rows.map(\.title), ["One"])
        XCTAssertTrue(snapshot("One is:on-relay").results().rows.isEmpty)
        XCTAssertEqual(snapshot("One is:off-relay").results().rows.map(\.title), ["One"])
        XCTAssertEqual(snapshot("").results().rows.count, 2)
        let query = LocalSessionQuery.suggesting("is:active is:on-relay ", field: "is", value: "off-relay")
        XCTAssertEqual(query, "is:active is:off-relay ")
        XCTAssertEqual(snapshot(query).results().rows.map(\.title), ["One"])
        XCTAssertEqual(LocalSessionQuery("is:off-relay").terms.first?.displayTitle, "Does not receive messages")
        XCTAssertEqual(LocalSessionQuery("-is:off-relay").terms.first?.displayTitle, "Receives messages")
    }

    func testLiveRelayShortcutExcludesOfflineRegistrations() {
        let sessions = [
            LocalSession(live: true, registration: SessionRegistration(addedBySession: false, address: "live@mac", name: "live"), suggestedName: "live", target: Target(id: "live", kind: .claudeTerminal), title: "Live"),
            LocalSession(live: false, registration: SessionRegistration(addedBySession: false, address: "offline@mac", name: "offline"), suggestedName: "offline", target: Target(id: "offline", kind: .claudeTerminal), title: "Offline"),
            LocalSession(live: true, suggestedName: "off", target: Target(id: "off", kind: .codex), title: "Off")
        ]
        let rows = LocalSessionRow.merge(uploads: [], sessions: sessions)
        let input = SessionSearchSnapshot(entries: rows.map {
            SessionSearchSnapshot.Entry(row: $0, uploadState: nil, status: nil, onRelay: nil, uploadEnabled: nil)
        }, query: "is:active is:on-relay", sort: LocalSessionSort())
        XCTAssertEqual(input.results().rows.map(\.title), ["Live"])
        XCTAssertEqual(input.results().rows.count, sessions.filter { $0.live && $0.registration != nil }.count)
    }

    func testEditingDoesNotComputeSynchronouslyAndRapidEditsApplyOnlyLatestQuery() async {
        let projection = SessionSearchProjection()
        projection.schedule(delay: 0) { self.snapshot("") }
        await projection.waitUntilSettled()
        XCTAssertEqual(projection.rows.count, 2)
        var reads = 0
        projection.schedule { reads += 1; return self.snapshot("One") }
        projection.schedule { reads += 1; return self.snapshot("Two") }
        XCTAssertEqual(reads, 0, "The editing turn must not read or filter the session snapshot")
        XCTAssertEqual(projection.rows.count, 2, "Keep the previous results while optimistic edits render")
        await projection.waitUntilSettled()
        XCTAssertEqual(reads, 1, "Coalesce rapid edits before snapshotting or filtering")
        XCTAssertEqual(projection.rows.map(\.title), ["Two"])
    }
    func testCancelledProjectionNeverCommitsPendingQuery() async {
        let projection = SessionSearchProjection()
        projection.schedule { self.snapshot("One") }
        projection.cancel()
        await projection.waitUntilSettled()
        XCTAssertTrue(projection.rows.isEmpty)
    }
    func testGroupingIsPreparedWithTheResultSet() async {
        let projection = SessionSearchProjection()
        projection.schedule(delay: 0) {
            var input = self.snapshot("")
            input.grouping = .harness
            input.harnessNames = ["codex": "Codex"]
            return input
        }
        await projection.waitUntilSettled()
        XCTAssertEqual(projection.appliedGrouping, .harness)
        XCTAssertEqual(projection.groups.map(\.key), ["Codex"])
        XCTAssertEqual(projection.groups.first?.rows.count, 2)
        projection.schedule(delay: 0) { self.snapshot("Two") }
        await projection.waitUntilSettled()
        XCTAssertEqual(projection.appliedGrouping, .none)
        XCTAssertEqual(projection.groups.map(\.key), [""])
        XCTAssertEqual(projection.groups.first?.rows.map(\.title), ["Two"])
    }

}
