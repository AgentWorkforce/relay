import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

final class SessionTitleEditsTests: XCTestCase {
    func testOptimisticTitleSurvivesOldCatalogUntilConfirmed() {
        var edits = SessionTitleEdits()
        let request = edits.begin("codex:a", title: "New title")
        XCTAssertEqual(edits.title(for: "codex:a"), "New title")
        edits.observe("codex:a", title: "New title")
        XCTAssertTrue(edits.isSaving("codex:a"), "An early read cannot acknowledge a write")
        edits.succeed("codex:a", token: request, title: "New title")
        edits.observe("codex:a", title: "Old title")
        XCTAssertEqual(edits.title(for: "codex:a"), "New title")
        edits.observe("codex:a", title: "New title")
        XCTAssertNil(edits.title(for: "codex:a"))
    }

    func testFailureRollsBackToLastConfirmedEditWithoutClobberingNewerRequest() {
        var edits = SessionTitleEdits()
        let first = edits.begin("codex:a", title: "First")
        edits.succeed("codex:a", token: first, title: "First")
        let second = edits.begin("codex:a", title: "Second")
        edits.fail("codex:a", token: first)
        XCTAssertEqual(edits.title(for: "codex:a"), "Second")
        edits.fail("codex:a", token: second)
        XCTAssertEqual(edits.title(for: "codex:a"), "First")
        XCTAssertFalse(edits.isSaving("codex:a"))
    }

    func testFirstFailureAndHarnessIdentity() {
        var edits = SessionTitleEdits()
        let request = edits.begin("codex:same", title: "Changed")
        XCTAssertNil(edits.title(for: "claude:same"))
        edits.fail("codex:same", token: request)
        XCTAssertNil(edits.title(for: "codex:same"))
    }

    func testConfirmedOverlayExpiresAfterOneMinuteWithoutExpiringNewerEdits() {
        var edits = SessionTitleEdits()
        let start = Date(timeIntervalSince1970: 100)
        let first = edits.begin("codex:a", title: "First")
        edits.succeed("codex:a", token: first, title: "First", now: start)
        XCTAssertFalse(edits.expire("codex:a", token: first, now: start.addingTimeInterval(59)))
        XCTAssertTrue(edits.expire("codex:a", token: first, now: start.addingTimeInterval(60)))
        XCTAssertNil(edits.title(for: "codex:a"))
        let second = edits.begin("codex:a", title: "Second")
        edits.succeed("codex:a", token: second, title: "Second", now: start.addingTimeInterval(60))
        XCTAssertFalse(edits.expire("codex:a", token: first, now: start.addingTimeInterval(120)))
        XCTAssertEqual(edits.title(for: "codex:a"), "Second")
        edits.observe("codex:a", title: "Changed in harness", now: start.addingTimeInterval(120))
        XCTAssertNil(edits.title(for: "codex:a"))
    }

    func testFailedSecondEditPreservesFirstConfirmationDeadline() {
        var edits = SessionTitleEdits()
        let start = Date(timeIntervalSince1970: 100)
        let first = edits.begin("codex:a", title: "First")
        edits.succeed("codex:a", token: first, title: "First", now: start)
        let second = edits.begin("codex:a", title: "Second")
        edits.fail("codex:a", token: second)
        XCTAssertEqual(edits.expiration(for: "codex:a")?.date, start.addingTimeInterval(60))
        XCTAssertEqual(edits.expiration(for: "codex:a")?.token, first)
        XCTAssertTrue(edits.expire("codex:a", token: first, now: start.addingTimeInterval(60)))
    }

    func testProjectedTitleIsUsedBySearchAndSortWithoutChangingIdentity() {
        let upload = UploadSession(included: true, isAgent: false, sessionId: "a", source: "codex", status: .uploaded, title: "Old")
        let row = LocalSessionRow.merge(uploads: [upload], sessions: [])[0]
        let updated = row.withTitle("Fix signup")
        XCTAssertEqual(updated.id, row.id)
        XCTAssertEqual(updated.upload?.title, "Old")
        XCTAssertTrue(updated.matches("signup"))
        XCTAssertEqual(updated.withTitle(nil).title, "Old")
    }
}

@MainActor final class SessionTitleModelTests: XCTestCase {
    private func row(_ id: String = "a", source: String = "codex") -> LocalSessionRow {
        LocalSessionRow.merge(uploads: [UploadSession(included: true, isAgent: false,
            sessionId: id, source: source, status: .uploaded, title: "Original")], sessions: [])[0]
    }

    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<100 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    func testRowUsesLatestConfirmedTitleBeforeSearchProjectionCatchesUp() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Confirmed native title",
                "live": true, "suggested_name": "session"]]]
        }
        let client = CoreClient(socketPath: core.path)
        let relay = RelayModel(client: client)
        let defaults = UserDefaults(suiteName: "session-title-stale-\(UUID())")!
        let app = AppModel(client: client, manageSystemServices: false, defaults: defaults)
        let old = LocalSession(live: true, suggestedName: "session", target: Target(id: "a", kind: .codex), title: "Old projected title")
        let projected = LocalSessionRow.merge(uploads: [], sessions: [old])[0].withTitle("Old optimistic title")
        try await relay.loadSessions()
        let state = SessionRowIndex(model: app, relay: relay).state(for: projected)
        XCTAssertEqual(state.title, "Confirmed native title")
        XCTAssertEqual(state.row.title, "Old optimistic title", "Projection is intentionally still stale")
    }

    func testPreloadUsesSavedBriefAndDeduplicatesWithoutGeneratingOrRenaming() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.title.capability") { _ in ["supported": true] }
        core.on("sessions.overview.get") { params in
            ["sessionId": params["session_id"]!, "requests": [], "analyses": [["id": "brief", "sessionId": params["session_id"]!,
                "sourceProvider": "codex", "status": "completed", "result": ["brief": ["title": "Saved pipeline title", "description": "Summary"]]]]]
        }
        let model = RelayModel(client: CoreClient(socketPath: core.path))
        let row = row()
        for _ in 0..<10 { model.preloadTitle(row) }
        let loaded = await waitUntil { model.titleState(for: row).generatedTitle != nil }
        XCTAssertTrue(loaded)
        XCTAssertEqual(model.titleState(for: row).generatedTitle, "Saved pipeline title")
        XCTAssertEqual(core.callCount("sessions.overview.get"), 1)
        XCTAssertEqual(core.callCount("sessions.title.capability"), 1)
        XCTAssertEqual(core.callCount("sessions.overview.request"), 0)
        XCTAssertEqual(core.callCount("sessions.title.set"), 0)
    }

    func testGeneratedTitlesAreScopedToHarnessWhenNativeIDsCollide() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.title.capability") { _ in ["supported": true] }
        core.on("sessions.overview.get") { _ in
            ["sessionId": "a", "requests": [], "analyses": [
                ["id": "codex-brief", "sessionId": "a", "sourceProvider": "codex", "status": "completed",
                 "result": ["brief": ["title": "Codex title", "description": "Codex summary"]]],
                ["id": "claude-brief", "sessionId": "a", "sourceProvider": "claude", "status": "completed",
                 "result": ["brief": ["title": "Claude title", "description": "Claude summary"]]]]]
        }
        let model = RelayModel(client: CoreClient(socketPath: core.path))
        let codex = row(), claude = row(source: "claude")
        model.preloadTitle(codex)
        model.preloadTitle(claude)
        let loaded = await waitUntil { model.titleState(for: codex).generatedTitle != nil && model.titleState(for: claude).generatedTitle != nil }
        XCTAssertTrue(loaded)
        XCTAssertEqual(model.titleState(for: codex).generatedTitle, "Codex title")
        XCTAssertEqual(model.titleState(for: claude).generatedTitle, "Claude title")
    }

    func testReconnectReplacesInFlightPreloadAndDiscardsRetiredReply() async throws {
        let core = FakeCore()
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal(); core.stop() }
        core.on("sessions.title.capability") { _ in
            _ = gate.wait(timeout: .now() + 5)
            return ["supported": false, "reason": "Retired core"]
        }
        core.on("sessions.overview.get") { params in
            ["sessionId": params["session_id"]!, "requests": [], "analyses": []]
        }
        let model = RelayModel(client: CoreClient(socketPath: core.path))
        let row = row()
        model.preloadTitle(row)
        let started = await waitUntil { core.callCount("sessions.title.capability") == 1 }
        XCTAssertTrue(started)
        model.connectionInterrupted()
        core.on("sessions.title.capability") { _ in ["supported": true] }
        model.connectionRecovered()
        model.preloadTitle(row)
        let replaced = await waitUntil { model.titleState(for: row).supported == true }
        XCTAssertTrue(replaced, "An old request must not block preloading after reconnect")
        gate.signal()
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(model.titleState(for: row).supported, true)
        XCTAssertNil(model.titleState(for: row).reason)
        XCTAssertEqual(core.callCount("sessions.title.capability"), 2)
        XCTAssertEqual(core.callCount("sessions.overview.get"), 1, "Retired requests stop before loading summaries")
    }

    func testPreloadConcurrencyIsBounded() async throws {
        let core = FakeCore()
        let gate = DispatchSemaphore(value: 0)
        defer {
            for _ in 0..<100 { gate.signal() }
            core.stop()
        }
        core.on("sessions.title.capability") { _ in
            _ = gate.wait(timeout: .now() + 5)
            return ["supported": true]
        }
        core.on("sessions.overview.get") { params in ["sessionId": params["session_id"]!, "requests": [], "analyses": []] }
        let model = RelayModel(client: CoreClient(socketPath: core.path))
        for index in 0..<100 { model.preloadTitle(row("session-\(index)")) }
        let started = await waitUntil { core.callCount("sessions.title.capability") == 4 }
        XCTAssertTrue(started)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(core.callCount("sessions.title.capability"), 4)
    }

    func testSaveIsOptimisticAndFailureRestoresOriginalWithError() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.title.capability") { _ in ["supported": true] }
        core.on("sessions.overview.get") { _ in ["sessionId": "a", "requests": [], "analyses": []] }
        let gate = DispatchSemaphore(value: 0)
        core.on("sessions.title.set") { _ in
            _ = gate.wait(timeout: .now() + 5)
            throw FakeCore.Failure(kind: "unavailable", message: "Harness unavailable")
        }
        let model = RelayModel(client: CoreClient(socketPath: core.path))
        let row = row()
        model.preloadTitle(row)
        let loaded = await waitUntil { model.titleState(for: row).supported == true }
        XCTAssertTrue(loaded)
        let saving = Task { await model.setSessionTitle("  Better title  ", for: row) }
        let optimistic = await waitUntil { model.titleState(for: row).saving }
        XCTAssertTrue(optimistic)
        XCTAssertEqual(model.titleState(for: row).title, "Better title")
        gate.signal()
        await saving.value
        XCTAssertEqual(model.titleState(for: row).title, "Original")
        XCTAssertEqual(model.titleState(for: row).error, "Harness unavailable")
        XCTAssertEqual(core.lastParams("sessions.title.set")?["title"] as? String, "Better title")
        XCTAssertEqual(core.lastParams("sessions.title.set")?["source"] as? String, "codex")
    }

    func testUnsupportedHarnessDoesNotWriteOrOptimisticallyLie() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.title.capability") { _ in ["supported": false, "reason": "This harness cannot rename sessions"] }
        core.on("sessions.overview.get") { _ in ["sessionId": "a", "requests": [], "analyses": []] }
        let model = RelayModel(client: CoreClient(socketPath: core.path))
        let row = row()
        model.preloadTitle(row)
        let loaded = await waitUntil { model.titleState(for: row).supported != nil }
        XCTAssertTrue(loaded)
        await model.setSessionTitle("Changed", for: row)
        XCTAssertEqual(model.titleState(for: row).title, "Original")
        XCTAssertEqual(model.titleState(for: row).reason, "This harness cannot rename sessions")
        XCTAssertEqual(core.callCount("sessions.title.set"), 0)
    }
}
