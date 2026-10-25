import XCTest
import SwiftUI
import AppKit
import Vision
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor
final class AppModelTests: XCTestCase {
    private var core: FakeCore!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        core = FakeCore()
        suite = "app-model-test-\(UUID())"
        defaults = UserDefaults(suiteName: suite)
        core.on("settings.get") { _ in Self.settings(analytics: true) }
        core.on("settings.set") { params in Self.settings(analytics: params["analytics_enabled"] as? Bool ?? true) }
        core.on("uploader.status") { _ in
            ["running": true, "paused": false, "sharing_mode": "new", "directory": "/tmp/install",
             "collector_replacing": false, "collector_outdated": false,
             "delivery": ["bootstrap_complete": true, "pending_records": 0, "acknowledged_records": 4, "quarantined_records": 0, "skipped_records": 0,
                          "unqueued_changes": 0, "last_acknowledged_ms": NSNull(), "failure": NSNull(), "stopped": false],
             "sessions": ["total": 2, "shared": 1, "excluded": 1], "stage": "up_to_date", "stage_message": NSNull(),
             "needs_start": false, "journal_full": false, "upgrading": false, "stalled": false]
        }
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "new", "sessions": [
                ["source": "codex", "session_id": "a", "title": "Fix tests", "is_agent": false, "included": true,
                 "status": "uploaded"],
                ["source": "claude", "session_id": "b", "title": "Docs", "is_agent": false, "included": false,
                 "status": "not_shared"],
            ]]
        }
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Fix tests", "live": true,
                           "registration": NSNull(), "suggested_name": "fix-tests"]]]
        }
        core.on("agents.list") { _ in ["agents": [], "archived": []] }
        core.on("fleet.list") { _ in ["brokers": []] }
        core.on("activity.list") { _ in ["activity": []] }
        core.on("roster.list") { _ in ["agents": [], "fetched_at_ms": 1, "unread_statuses": []] }
        core.on("people.list") { _ in ["people": []] }
        core.on("incoming.status") { _ in ["state": "stopped", "error": NSNull(), "threads": [], "held": [], "can_approve": false] }
        core.on("claude_delivery.status") { _ in
            ["restricted": true,
             "sessions": [["id": "c-1", "agent": "review", "title": "Review", "direct": false]],
             "allowed_senders": [["address": "ada@desk", "name": "Ada"]],
             "held": [["id": "del-1", "agent": "review", "session_id": "c-1", "sender": "bo@desk",
                       "sender_name": "Bo", "text": "Please review", "held_at_ms": 1]]]
        }
        core.on("claude_delivery.restrict") { _ in [:] }
        core.on("claude_delivery.session") { _ in [:] }
        core.on("claude_delivery.sender") { _ in [:] }
        core.on("claude_delivery.approve") { _ in ["changed": true] }
        core.on("claude_delivery.dismiss") { _ in ["changed": true] }
        core.on("chat.conversation") { _ in ["messages": [], "sending": false] }
        core.on("chat.projects") { _ in ["report": NSNull(), "stale": false, "refreshing": false] }
        core.on("contractors.status") { _ in Self.contractors }
        core.on("contractors.refresh") { _ in Self.contractors }
        core.on("uploader.sessions.include") { params in ["updated": (params["session_keys"] as? [String])?.count ?? 0] }
        core.on("uploader.pause") { _ in ["paused": true] }
        core.on("uploader.sharing.set") { params in ["sharing_mode": params["mode"] ?? "new"] }
    }

    func testAccountMenuKeepsSettingsWithoutOfferingAgentThreadCreation() async throws {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.phase == .attached }
        XCTAssertTrue(ready)

        let updater = AppUpdater(defaults: defaults, currentVersion: "development build", terminate: {})
        let menu = HeaderAccountMenu(model: model, updater: updater,
                                     connection: WorkspaceConnection(model: model, relay: model.relay),
                                     name: "Alex Morgan", email: "alex@example.com",
                                     isShowingMenu: .constant(true), isConfirmingLogOut: .constant(false),
                                     isConfirmingWorkspaceSignOut: .constant(false))
        let host = NSHostingView(rootView: menu)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 270, height: 320),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(100))
        host.layoutSubtreeIfNeeded()

        let bitmap = try SessionRenderFixture.bitmap(for: host)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        XCTAssertTrue(text.localizedCaseInsensitiveContains("Settings"), text)
        XCTAssertTrue(text.localizedCaseInsensitiveContains("Log out"), text)
        XCTAssertFalse(text.localizedCaseInsensitiveContains("Capy"), text)
    }

    func testMenuPanelSummarizesAgentsAndUploads() async throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var sessions: [[String: Any]] = []
        for index in 0..<12 {
            var session: [String: Any] = ["is_agent": false, "included": index < 5, "status": index < 5 ? "uploaded" : "not_shared"]
            session["source"] = index % 2 == 0 ? "codex" : "claude"
            session["session_id"] = "recent-\(index)"
            session["title"] = index == 11 ? "Add signup buttons to homepage" : "Recent session \(index)"
            session["cwd"] = "/work/agentrelay.com"
            session["last_activity_ms"] = now - Int64((12 - index) * 60000)
            sessions.append(session)
        }
        core.on("uploader.sessions.list") { _ in ["sharing_mode": "new", "sessions": sessions] }
        core.on("sessions.list") { _ in
            ["sessions": [("a", true), ("b", true), ("c", false)].map { id, onRelay -> [String: Any] in
                ["target": ["kind": "codex", "id": id], "title": id, "live": true,
                 "registration": onRelay ? ["name": id, "address": "\(id)@mac", "added_by_session": false] as Any : NSNull(),
                 "suggested_name": id]
            }]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.phase == .attached && model.sessions.count == 12 }
        XCTAssertTrue(ready)
        await model.relay.refreshSessions()
        let rows = model.menuSessionRows(relay: model.relay)
        let count = { (filter: MenuSummaryFilter) in filter.count(rows) { $0.upload.map(model.uploadState) } }
        XCTAssertEqual(count(.receiving), 2)
        XCTAssertEqual(count(.localOnly), 1)
        XCTAssertEqual(count(.uploaded), 5)
        XCTAssertEqual(count(.notUploaded), rows.count - 5)
        XCTAssertEqual(model.sessionCount(for: .uploaded), 5)
        let host = NSHostingView(rootView: MenuPanelView(relay: model.relay)
            .environmentObject(model).preferredColorScheme(.dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 560),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(100))
        host.layoutSubtreeIfNeeded()
        XCTAssertEqual(host.fittingSize.width, 260, accuracy: 1)
        XCTAssertLessThanOrEqual(host.fittingSize.height, 300)
        if let directory = ProcessInfo.processInfo.environment["MENU_RENDER_DIR"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try data.write(to: URL(fileURLWithPath: directory).appendingPathComponent("menu-summary.png"))
        }
    }

    func testSessionSearchClosesOnNavigationAndAccountReset() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.phase == .attached }
        XCTAssertTrue(ready)
        model.showsSessionSearch = true
        model.showSettingsWindow()
        XCTAssertFalse(model.showsSessionSearch)
        model.showLocalSessions()
        XCTAssertFalse(model.showsSessionSearch)
        model.showsSessionSearch = true
        model.selectedLocalSession = LocalSessionRow.merge(uploads: [UploadSession(included: false, isAgent: false,
            sessionId: "selected", source: "codex", status: .notShared, title: "Selected")], sessions: [])[0]
        XCTAssertFalse(model.showsSessionSearch)
        model.showLocalSessions()
        model.showsSessionSearch = true
        core.setStatus(FakeCore.snapshot(revision: 3, account: ["state": "signed_out"]))
        let signedOut = await eventually { model.phase == .signedOut }
        XCTAssertTrue(signedOut)
        XCTAssertFalse(model.showsSessionSearch)
    }

    func testStaleMenuClickCannotOpenHiddenSession() {
        defaults.set(["codex:hidden"], forKey: "hiddenSessions.v1")
        let model = model()
        var opened: [String] = []
        model.registerOpenWindow { opened.append($0) }
        let row = LocalSessionRow.merge(uploads: [UploadSession(included: false, isAgent: false,
            sessionId: "hidden", source: "codex", status: .notShared, title: "Hidden")], sessions: [])[0]
        model.openSessionFromMenu(row)
        XCTAssertNil(model.selectedLocalSession)
        XCTAssertTrue(opened.isEmpty)
    }

    func testMenuBarIconTurnsOrangeWhenSomethingNeedsAttention() throws {
        XCTAssertTrue(BrandMark.menuBarImage(state: .normal).isTemplate)
        XCTAssertTrue(BrandMark.menuBarImage(state: .paused).isTemplate)
        let attention = BrandMark.menuBarImage(state: .attention, tint: .systemGreen)
        XCTAssertFalse(attention.isTemplate)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(attention.tiffRepresentation)))
        let painted = (0..<bitmap.pixelsWide).flatMap { x in (0..<bitmap.pixelsHigh).compactMap { bitmap.colorAt(x: x, y: $0) } }
            .first { $0.alphaComponent == 1 }
        let pixel = try XCTUnwrap(painted?.usingColorSpace(.sRGB))
        // The warning orange in either appearance, not the Dev build's green.
        XCTAssertGreaterThan(pixel.redComponent, pixel.greenComponent + 0.2)
        XCTAssertGreaterThan(pixel.greenComponent, pixel.blueComponent)
    }

    func testMenuOpensExactSessionAndFilteredSessions() {
        let model = model()
        var opened: [String] = []
        model.registerOpenWindow { opened.append($0) }
        let row = LocalSessionRow.merge(uploads: [UploadSession(included: false, isAgent: false,
            sessionId: "menu-session", source: "codex", status: .notShared, title: "Recent")], sessions: [])[0]
        model.page = .settings(.general)
        model.openSessionFromMenu(row)
        XCTAssertEqual(model.page, .sessions)
        XCTAssertEqual(model.selectedLocalSession?.id, "codex:menu-session")
        XCTAssertFalse(model.showsSessionSearch)
        model.showSessionsFromMenu(search: MenuSummaryFilter.receiving.search)
        XCTAssertEqual(model.page, .sessions)
        XCTAssertNil(model.selectedLocalSession)
        XCTAssertEqual(model.sessionSearch, "is:active is:on-relay")
        model.showDiagnosticsFromMenu()
        XCTAssertEqual(model.page, .settings(.diagnostics))
        XCTAssertEqual(opened, [AppInfo.mainWindowID, AppInfo.mainWindowID, AppInfo.mainWindowID])
    }

    func testHidingStopsSharingWithoutDeletingAndBlocksReenableUntilUnhidden() async {
        var registered = true
        var included = true
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Fix tests", "live": true,
                "registration": registered ? ["name": "fix-tests", "address": "fix-tests@mac", "added_by_session": false] as Any : NSNull(), "suggested_name": "fix-tests"]]]
        }
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "new", "sessions": [["source": "codex", "session_id": "a", "title": "Fix tests", "is_agent": false, "included": included, "status": included ? "uploaded" : "not_shared"]]]
        }
        core.on("agents.unregister") { _ in registered = false; return [:] }
        core.on("uploader.sessions.exclude") { params in
            XCTAssertFalse(registered, "Relay must stop before excluding uploads")
            XCTAssertEqual(params["session_keys"] as? [String], ["codex:a"])
            included = false
            return ["updated": 1]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { !model.sessions.isEmpty && !model.relay.sessions.isEmpty }
        XCTAssertTrue(ready)
        let session = model.relay.sessions[0]
        await model.setSessionsHidden(keys: ["codex:a"], hidden: true)
        XCTAssertEqual(core.callCount("agents.unregister"), 1)
        XCTAssertEqual(core.callCount("uploader.sessions.exclude"), 1)
        XCTAssertEqual(core.callCount("uploader.sessions.delete"), 0)
        XCTAssertTrue(model.hiddenSessionIDs.contains("codex:a"))
        XCTAssertFalse(model.sessions[0].included)
        model.showHiddenSessions = true
        let restored = AppModel(manageSystemServices: false, defaults: defaults)
        XCTAssertTrue(restored.hiddenSessionIDs.contains("codex:a"))
        XCTAssertTrue(restored.showHiddenSessions)
        let accepted = await model.includeSessions(keys: ["codex:a"])
        XCTAssertFalse(accepted)
        model.relay.requestRelay(true, for: session)
        await model.relay.register(session, as: "hidden")
        XCTAssertEqual(core.callCount("uploader.sessions.include"), 0)
        XCTAssertEqual(core.callCount("agents.register"), 0)
        await model.setSessionsHidden(keys: ["codex:a"], hidden: false)
        XCTAssertFalse(model.hiddenSessionIDs.contains("codex:a"))
        XCTAssertEqual(core.callCount("uploader.sessions.include"), 0, "Unhiding does not resume sharing")
    }

    func testHideStopsAnExplicitRegistrationAlreadyInFlight() async {
        let registered = Locked(false)
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Fix tests", "live": true,
                "registration": registered.value ? ["name": "fix-tests", "address": "fix-tests@mac", "added_by_session": false] as Any : NSNull(), "suggested_name": "fix-tests"]]]
        }
        core.on("agents.register") { _ in
            held.wait()
            registered.value = true
            return ["name": "fix-tests", "address": "fix-tests@mac", "already_registered": false]
        }
        core.on("agents.unregister") { _ in registered.value = false; return [:] }
        core.on("uploader.sessions.exclude") { _ in
            XCTAssertFalse(registered.value, "Hide must stop an explicit registration before excluding uploads")
            return ["updated": 1]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { !model.relay.sessions.isEmpty && !model.sessions.isEmpty }
        let session = model.relay.sessions[0]
        let registration = Task { await model.relay.register(session, as: "fix-tests") }
        _ = await eventually { core.callCount("agents.register") == 1 }
        let hide = Task { await model.setSessionsHidden(keys: ["codex:a"], hidden: true) }
        _ = await eventually { model.hidingSessionIDs.contains("codex:a") }
        held.signal()
        await registration.value
        await hide.value
        XCTAssertEqual(core.callCount("agents.unregister"), 1)
        XCTAssertFalse(registered.value)
        XCTAssertTrue(model.hiddenSessionIDs.contains("codex:a"))
    }

    func testHideSurvivesFailedListAfterExplicitRegistration() async {
        let registered = Locked(false)
        let failOnce = Locked(true)
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("sessions.list") { _ in
            if registered.value && failOnce.value {
                failOnce.value = false
                throw FakeCore.Failure(kind: "internal", message: "Cannot read registered sessions")
            }
            return ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Fix tests", "live": true,
                "registration": registered.value ? ["name": "fix-tests", "address": "fix-tests@mac", "added_by_session": false] as Any : NSNull(), "suggested_name": "fix-tests"]]]
        }
        core.on("agents.register") { _ in
            held.wait()
            registered.value = true
            return ["name": "fix-tests", "address": "fix-tests@mac", "already_registered": false]
        }
        core.on("agents.unregister") { _ in registered.value = false; return [:] }
        core.on("uploader.sessions.exclude") { _ in
            XCTAssertFalse(registered.value, "Hide must stop an explicit registration before excluding uploads")
            return ["updated": 1]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { !model.relay.sessions.isEmpty && !model.sessions.isEmpty }
        let session = model.relay.sessions[0]
        let registration = Task { await model.relay.register(session, as: "fix-tests") }
        _ = await eventually { core.callCount("agents.register") == 1 }
        let hide = Task { await model.setSessionsHidden(keys: ["codex:a"], hidden: true) }
        _ = await eventually { model.hidingSessionIDs.contains("codex:a") }
        held.signal()
        await registration.value
        await hide.value
        XCTAssertEqual(core.callCount("agents.unregister"), 1)
        XCTAssertFalse(registered.value)
        XCTAssertTrue(model.hiddenSessionIDs.contains("codex:a"))
    }

    func testHideWaitsForAnUploadAlreadyInFlight() async {
        let included = Locked(false)
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "selected", "sessions": [["source": "codex", "session_id": "a", "title": "Fix tests", "is_agent": false, "included": included.value, "status": included.value ? "shared" : "not_shared"]]]
        }
        core.on("uploader.sessions.include") { _ in held.wait(); included.value = true; return ["updated": 1] }
        core.on("uploader.sessions.exclude") { _ in
            XCTAssertTrue(included.value, "Exclude must run after the held include finishes")
            included.value = false
            return ["updated": 1]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { !model.sessions.isEmpty }
        let upload = Task { await model.includeSessions(keys: ["codex:a"]) }
        _ = await eventually { self.core.callCount("uploader.sessions.include") == 1 }
        let hide = Task { await model.setSessionsHidden(keys: ["codex:a"], hidden: true) }
        _ = await eventually { model.hidingSessionIDs.contains("codex:a") }
        XCTAssertEqual(core.callCount("uploader.sessions.exclude"), 0)
        held.signal()
        _ = await upload.value
        await hide.value
        XCTAssertFalse(included.value)
        XCTAssertTrue(model.hiddenSessionIDs.contains("codex:a"))
        XCTAssertEqual(core.callCount("uploader.sessions.exclude"), 1)
    }

    func testRestoredHiddenSessionIsExcludedWhenDiscoveredStillUploading() async {
        defaults.set(["codex:a"], forKey: "hiddenSessions.v1")
        let included = Locked(true)
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "new", "sessions": [["source": "codex", "session_id": "a", "title": "Fix tests", "is_agent": false, "included": included.value, "status": included.value ? "shared" : "not_shared"]]]
        }
        core.on("uploader.sessions.exclude") { _ in included.value = false; return ["updated": 1] }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let stopped = await eventually { !included.value && model.hidingSessionIDs.isEmpty }
        XCTAssertTrue(stopped)
        XCTAssertTrue(model.hiddenSessionIDs.contains("codex:a"))
        XCTAssertFalse(model.sessions.first?.included ?? true)
    }

    func testFailedHideReturnsSessionToTableWithError() async {
        core.on("uploader.sessions.exclude") { _ in throw FakeCore.Failure(kind: "internal", message: "Cannot stop uploads") }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { !model.sessions.isEmpty }
        XCTAssertTrue(ready)
        await model.setSessionsHidden(keys: ["codex:a"], hidden: true)
        XCTAssertFalse(model.hiddenSessionIDs.contains("codex:a"))
        XCTAssertTrue(model.uploadErrors["codex:a"]?.contains("Cannot stop uploads") == true)
        XCTAssertTrue(model.hidingSessionIDs.isEmpty)
    }

    func testWorkspaceHeaderUsesUploadWorkspaceInsteadOfRelayWorkspace() async {
        var account = FakeCore.signedIn
        account["workspace_name"] = "Upload workspace"
        account["workspace_id"] = "0f8fad5b-d9cb-469f-a165-70867728950e"
        var snapshot = FakeCore.snapshot(revision: 2, account: account)
        var relay = snapshot["workspace"] as? [String: Any] ?? [:]
        relay["workspace_name"] = "Another relay"
        snapshot["workspace"] = relay
        core.setStatus(snapshot)
        let model = model()
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.workspaceName == "Upload workspace" }
        XCTAssertTrue(ready)
        model.shutdown()
    }

    func testWorkspaceHeaderDoesNotDisplayAnIDWhileNameIsUnavailable() async {
        var account = FakeCore.signedIn
        account["workspace_name"] = "  "
        account["workspace_id"] = "0f8fad5b-d9cb-469f-a165-70867728950e"
        core.setStatus(FakeCore.snapshot(revision: 2, account: account))
        let model = model()
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.workspaceID != nil }
        XCTAssertTrue(ready)
        XCTAssertEqual(model.workspaceName, "Workspace")
        model.shutdown()
    }

    override func tearDown() async throws {
        core.stop()
        defaults.removePersistentDomain(forName: suite)
    }

    nonisolated static func settings(analytics: Bool) -> [String: Any] {
        ["allow_self_registration": true, "auto_activate": false, "direct_delivery": false,
         "direct_delivery_managed": NSNull(), "analytics_enabled": analytics, "contractor_access": false]
    }

    func testStalledHandshakeShowsRecoveryThenClearsOnReady() async {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.beforeReply = { method in if method == "subscribe" { held.wait() } }
        let service = FakeService(status: .enabled)
        defaults.set(service.binaryIdentity, forKey: AppModel.registeredCoreKey)
        let model = AppModel(client: CoreClient(socketPath: core.path), service: service,
                             bundledCoreVersion: "1.0.0", startupTimeout: 100_000_000,
                             manageSystemServices: false, defaults: defaults)
        defer { model.shutdown() }
        await model.bootstrapIfNeeded()
        let timedOut = await eventually(1) { model.coreProblem == StartupPresentation.timeoutMessage }
        XCTAssertTrue(timedOut)
        XCTAssertEqual(model.phase, .launching)
        held.signal()
        let ready = await eventually { model.phase == .signedOut && model.coreProblem == nil }
        XCTAssertTrue(ready)
    }

    func testCoreRestartShowsReconnectingUntilTheNewSnapshotArrives() async {
        let model = model()
        defer { model.shutdown() }
        await model.bootstrapIfNeeded()
        let connected = await eventually { model.isCoreConnected && model.core != nil }
        XCTAssertTrue(connected)
        let path = core.path
        core.stop()
        let disconnected = await eventually { !model.isCoreConnected }
        XCTAssertTrue(disconnected)
        XCTAssertEqual(WorkspaceConnection(model: model, relay: model.relay).label, "Reconnecting")
        XCTAssertEqual(WorkspaceConnection(model: model, relay: model.relay).help,
                       "Agent Relay is reconnecting to its background service.")
        core = FakeCore(path: path, pid: 4243)
        let recovered = await eventually { model.isCoreConnected && model.core?.daemon.pid == 4243 }
        XCTAssertTrue(recovered)
        XCTAssertNotEqual(WorkspaceConnection(model: model, relay: model.relay).label, "Reconnecting")
    }

    func testCoreRestartReleasesInterruptedUploaderAction() async throws {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("uploader.pause") { _ in held.wait(); return ["paused": true] }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        defer { model.shutdown() }
        await model.bootstrapIfNeeded()
        let attached = await eventually { model.phase == .attached && model.status != nil }
        XCTAssertTrue(attached)
        let overviewReloads = model.relay.overviewReloads
        // The replacement must report paused for Resume to change its state.
        var restartedStatus = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(XCTUnwrap(model.status))) as? [String: Any])
        restartedStatus["paused"] = true
        let pausedStatus = restartedStatus
        let pause = Task { await model.setPaused(true) }
        let started = await eventually { model.isWorking && self.core.callCount("uploader.pause") == 1 }
        XCTAssertTrue(started)
        let path = core.path
        core.stop()
        let disconnected = await eventually { !model.isCoreConnected && !model.isWorking }
        XCTAssertTrue(disconnected)
        core = FakeCore(path: path, pid: 4243)
        core.on("uploader.status") { _ in pausedStatus }
        core.on("uploader.resume") { _ in ["paused": false] }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn, pid: 4243))
        let reconnected = await eventually { model.isCoreConnected && model.core?.daemon.pid == 4243 && model.status?.paused == true }
        XCTAssertTrue(reconnected)
        XCTAssertFalse(model.pausedWanted.isPending, "restarting clears the interrupted optimistic choice")
        XCTAssertEqual(model.relay.overviewReloads, overviewReloads + 1)
        await model.setPaused(false)
        XCTAssertEqual(core.callCount("uploader.resume"), 1)
        held.signal()
        await pause.value
    }

    func testCoreRestartRestoresAnInterruptedChatDraft() async {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("chat.send") { _ in ["conversation": ["messages": [], "sending": false]] }
        core.beforeReply = { method in if method == "chat.send" { held.wait() } }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        defer { model.shutdown() }
        await model.bootstrapIfNeeded()
        let attached = await eventually { model.phase == .attached }
        XCTAssertTrue(attached)
        model.chat.draft = "Please check the restart"
        let send = Task { await model.chat.send() }
        let sending = await eventually { model.chat.isSending && self.core.callCount("chat.send") == 1 }
        XCTAssertTrue(sending)
        core.stop()
        let interrupted = await eventually { !model.isCoreConnected && !model.chat.isSending }
        XCTAssertTrue(interrupted)
        XCTAssertEqual(model.chat.draft, "Please check the restart")
        XCTAssertEqual(model.chat.error, CoreError.interrupted.message)
        held.signal()
        await send.value
    }

    func testCachedHistoryAppearsWhileUploaderStatusIsHeld() async {
        let held = DispatchSemaphore(value: 0)
        defer { for _ in 0..<4 { held.signal() } }
        core.on("uploader.status") { _ in held.wait(); return [:] }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        defer { model.shutdown() }
        await model.bootstrapIfNeeded()
        let visible = await eventually(0.5) { !model.sessions.isEmpty }
        XCTAssertTrue(visible, "Cached history must not wait for uploader status")
    }

    func testSignInAndStatusEventsDoNotWaitForSessionDiscovery() async {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("sessions.list") { _ in
            held.wait()
            return ["sessions": []]
        }
        let model = model()
        defer { model.shutdown() }
        await model.bootstrapIfNeeded()
        let listing = await eventually { self.core.callCount("sessions.list") > 0 }
        XCTAssertTrue(listing)
        let ready = await eventually(0.5) { model.phase == .signedOut }
        XCTAssertTrue(ready, "Sign-in must render while discovery is still held")
        core.setStatus(FakeCore.snapshot(revision: 2, account: ["state": "pending_approval"]))
        let updated = await eventually(0.5) { model.phase == .waitingForBrowser }
        XCTAssertTrue(updated, "Status events must keep flowing during discovery")
    }

    nonisolated static let contractors: [String: Any] = [
        "enabled": false, "availability": "dormant", "failure": NSNull(), "role": NSNull(), "grant": NSNull(),
        "pending_seats": [], "services": [], "grants": [], "provisioning": ["grant_id": NSNull(), "failed": false],
    ]

    func testRequestFailureLinksToExactEntryAndSurvivesLogEviction() async {
        let entry: [String: Any] = ["id": "failure-42", "started_at_ms": 123, "service": "Relaycast",
            "method": "GET", "endpoint": "https://cast.agentrelay.com/v1/workspace",
            "request": "null", "response": "workspace unavailable", "status": 503,
            "duration_ms": 40, "failed": true]
        core.on("diagnostics.requests") { _ in ["entries": [entry]] }
        let model = model()
        await model.refreshRequestLog()
        XCTAssertEqual(model.requestEntries.first?.status, 503)
        XCTAssertEqual(model.requestFailure?.id, "failure-42")
        model.openFailedRequest()
        XCTAssertEqual(model.page, .settings(.diagnostics))
        XCTAssertEqual(model.selectedRequest?.id, "failure-42")
        XCTAssertNil(model.requestFailure)
        await model.refreshRequestLog()
        XCTAssertNil(model.requestFailure, "Reading the same failure should not notify again")
        core.on("diagnostics.requests") { _ in ["entries": []] }
        await model.refreshRequestLog()
        XCTAssertTrue(model.requestEntries.isEmpty)
        XCTAssertEqual(model.selectedRequest?.response, "workspace unavailable")
    }

    func testIdenticalRefreshesPreservePublishedDataAndSearchIndex() async throws {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.sessions.count == 2 && model.relay.sessions.count == 1 && model.status != nil && !model.isLoadingSessions }
        XCTAssertTrue(ready)
        // Settle all initial refreshes before subscribing.
        await model.refreshStatus()
        await model.refreshSessions()
        try await model.relay.loadSessions()
        let cache = model.sessionSearchSource
        _ = cache.snapshot(model: model, relay: model.relay)
        let builds = (cache.rowsBuildCount, cache.metadataBuildCount)
        var publications = 0
        let subscriptions = [
            model.$status.dropFirst().sink { _ in publications += 1 },
            model.$sessions.dropFirst().sink { _ in publications += 1 },
            model.$previewSessionIDs.dropFirst().sink { _ in publications += 1 },
            model.relay.$sessions.dropFirst().sink { _ in publications += 1 },
            model.relay.$roster.dropFirst().sink { _ in publications += 1 },
            model.relay.$archivedAgents.dropFirst().sink { _ in publications += 1 },
        ]
        defer { subscriptions.forEach { $0.cancel() } }
        for _ in 0..<100 {
            await model.refreshStatus()
            await model.refreshSessions()
            try await model.relay.loadSessions()
            await model.relay.refresh(.roster)
            await model.relay.refresh(.agents)
            _ = cache.snapshot(model: model, relay: model.relay)
        }
        XCTAssertEqual(publications, 0, "No-op responses must not republish catalog/status data; loading feedback remains independent")
        XCTAssertEqual(cache.rowsBuildCount, builds.0)
        XCTAssertEqual(cache.metadataBuildCount, builds.1)
    }

    func testEqualFleetListingReconcilesReleaseWithoutRepublishingBrokers() async throws {
        let worker = WorkerRow(channels: [], generation: "g1", id: "node|bot", name: "bot",
                               provider: "codex", providerLabel: "Codex", state: .idle)
        let broker = BrokerListing(name: "Desk", nodeId: "node", workers: [worker])
        let reply = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FleetListing(brokers: [broker])))
        core.on("fleet.list") { _ in reply }
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("fleet.release") { _ in gate.wait(); return [:] }
        let model = model()
        await model.relay.refresh(.fleet)
        XCTAssertEqual(model.relay.brokers, [broker])
        var publications = 0
        let subscription = model.relay.$brokers.dropFirst().sink { _ in publications += 1 }
        defer { subscription.cancel() }
        let release = Task { await model.relay.release(worker, from: broker) }
        let pending = await eventually { model.relay.releasedFleet.contains(worker.id) }
        XCTAssertTrue(pending, "the optimistic release must show while its request is held")
        gate.signal()
        await release.value
        XCTAssertTrue(model.relay.releasedFleet.isEmpty, "even an equal listing reconciles the optimistic release")
        XCTAssertTrue(model.relay.releasingFleet.isEmpty)
        XCTAssertEqual(publications, 0, "reconciling optimistic state must not republish an equal fleet")
        await model.relay.refresh(.fleet)
        XCTAssertEqual(publications, 0)
    }

    func testDiagnosticCoreRevisionsKeepSearchMetadataButPushChangesRebuildIt() async throws {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.sessions.count == 2 && model.relay.sessions.count == 1 && model.status != nil }
        XCTAssertTrue(ready)
        let cache = model.sessionSearchSource
        _ = cache.snapshot(model: model, relay: model.relay)
        let builds = (cache.rowsBuildCount, cache.metadataBuildCount)
        for revision in 3..<103 {
            let snapshot = try JSONDecoder().decode(Status.self, from: JSONSerialization.data(withJSONObject:
                FakeCore.snapshot(revision: revision, account: FakeCore.signedIn)))
            model.handle(.status(snapshot))
            _ = cache.snapshot(model: model, relay: model.relay)
        }
        XCTAssertEqual(model.core?.revision, 102, "Status freshness and event ordering must survive metadata reuse")
        XCTAssertEqual(cache.rowsBuildCount, builds.0)
        XCTAssertEqual(cache.metadataBuildCount, builds.1)
        let changed = try JSONDecoder().decode(Status.self, from: JSONSerialization.data(withJSONObject:
            FakeCore.snapshot(revision: 103, account: FakeCore.signedIn, push: ["fix-tests": ["state": "live"]])))
        model.handle(.status(changed))
        _ = cache.snapshot(model: model, relay: model.relay)
        XCTAssertEqual(cache.metadataBuildCount, builds.1 + 1)
        XCTAssertEqual(cache.rowsBuildCount, builds.0)
    }

    func testDeliveryCounterRefreshKeepsSearchMetadataAndPublishesFreshStatus() async throws {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.status != nil && model.sessions.count == 2 && model.relay.sessions.count == 1 }
        XCTAssertTrue(ready)
        var reply = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(XCTUnwrap(model.status))) as? [String: Any])
        var delivery = try XCTUnwrap(reply["delivery"] as? [String: Any])
        delivery["acknowledged_records"] = 42
        reply["delivery"] = delivery
        let response = reply
        core.on("uploader.status") { _ in response }
        let cache = model.sessionSearchSource
        _ = cache.snapshot(model: model, relay: model.relay)
        let builds = (cache.rowsBuildCount, cache.metadataBuildCount)
        await model.refreshStatus()
        XCTAssertEqual(model.status?.delivery.acknowledgedRecords, 42)
        _ = cache.snapshot(model: model, relay: model.relay)
        XCTAssertEqual(cache.rowsBuildCount, builds.0)
        XCTAssertEqual(cache.metadataBuildCount, builds.1)
    }

    func testUnchangedStatusStillClearsRefreshFailure() async throws {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.status != nil && model.sessions.count == 2 }
        XCTAssertTrue(ready)
        let status = try XCTUnwrap(model.status)
        let reply = try JSONSerialization.jsonObject(with: JSONEncoder().encode(status))
        core.on("uploader.status") { _ in throw FakeCore.Failure(kind: "internal", message: "Transient refresh failure") }
        await model.refreshStatus()
        XCTAssertNotNil(model.lastError)
        core.on("uploader.status") { _ in reply }
        await model.refreshStatus()
        XCTAssertNil(model.lastError, "An equal successful result must still clear a preceding error")
        XCTAssertEqual(model.status, status)
    }

    func testSearchSourceCacheReusesThousandSessionIndexAcrossHundredQueryEdits() async {
        core.on("uploader.sessions.list") { _ in Self.history(1_000) }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.sessions.count == 1_000 && !model.relay.sessions.isEmpty }
        XCTAssertTrue(ready)
        let cache = model.sessionSearchSource
        let source = cache.snapshot(model: model, relay: model.relay)
        XCTAssertEqual(source.rows.count, 1_001)
        let builds = (cache.rowsBuildCount, cache.metadataBuildCount)
        for number in 0..<100 {
            model.sessionSearch = "title:\"Session \(number)\""
            model.showsSessionSearch.toggle()
            let input = cache.snapshot(model: model, relay: model.relay)
            let result = SessionSearchSnapshot(source: input, query: model.sessionSearch, sort: model.sessionSort).results()
            XCTAssertTrue(result.rows.contains { $0.title == "Session \(number)" })
            XCTAssertEqual(cache.rows(model: model, relay: model.relay).harnesses, ["codex"])
            _ = cache.rowIndex(model: model, relay: model.relay).state(for: source.rows[0])
        }
        XCTAssertEqual(cache.rowsBuildCount, builds.0, "100 settled queries, header renders and table lookups must perform zero merges")
        XCTAssertEqual(cache.metadataBuildCount, builds.1, "Query edits must perform zero metadata/index rebuilds")
    }

    func testSearchSourceCacheTracksUploadAndLiveSessionChangesAndSignOut() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.sessions.count == 2 && model.relay.sessions.count == 1 }
        XCTAssertTrue(ready)
        let cache = model.sessionSearchSource
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).rows.count, 2)
        let builds = cache.rowsBuildCount
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "new", "sessions": [["source": "claude", "session_id": "new", "title": "Fresh", "cwd": "/work/new-project", "is_agent": false, "included": false, "status": "not_shared"]]]
        }
        await model.refreshSessions()
        let changed = cache.snapshot(model: model, relay: model.relay)
        XCTAssertEqual(cache.rowsBuildCount, builds + 1)
        XCTAssertTrue(changed.rows.contains { $0.title == "Fresh" })
        XCTAssertEqual(cache.rows(model: model, relay: model.relay).projects, ["new-project"])
        core.on("sessions.list") { _ in ["sessions": []] }
        await model.relay.refreshSessions()
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).rows.map(\.title), ["Fresh"])
        XCTAssertEqual(cache.rowsBuildCount, builds + 2)
        core.setStatus(FakeCore.snapshot(revision: 3, account: ["state": "signed_out"]))
        let signedOut = await eventually { model.phase == .signedOut && model.sessions.isEmpty }
        XCTAssertTrue(signedOut)
        XCTAssertTrue(cache.snapshot(model: model, relay: model.relay).rows.isEmpty)
        XCTAssertTrue(cache.rows(model: model, relay: model.relay).projects.isEmpty)
    }

    func testSearchSourceCacheTracksRosterArchiveAndCorePresenceWithoutRemerging() async {
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Fix tests", "live": true,
                "registration": ["name": "fix-tests", "address": "fix-tests@mac", "added_by_session": false], "suggested_name": "fix-tests"]]]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.sessions.count == 2 && model.relay.sessions.count == 1 }
        XCTAssertTrue(ready)
        let cache = model.sessionSearchSource
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.status, "Active")
        let builds = cache.rowsBuildCount
        core.on("roster.list") { _ in
            var agent = Self.rosterAgent("idle")
            agent["name"] = "fix-tests"
            return ["agents": [agent], "fetched_at_ms": 1, "unread_statuses": []]
        }
        await model.relay.refresh(.roster)
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.status, "Idle")
        core.on("agents.list") { _ in
            ["agents": [], "archived": [["address": "fix-tests@mac", "archived_at": "2026-10-10T12:00:00Z", "name": "fix-tests", "title": "Fix tests", "target": ["kind": "codex", "id": "a"]]]]
        }
        await model.relay.refresh(.agents)
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.status, "Archived")
        let metadataBuilds = cache.metadataBuildCount
        core.setStatus(FakeCore.snapshot(revision: 3, account: FakeCore.signedIn, push: ["fix-tests": ["state": "live"]]))
        let online = await eventually { model.core?.push["fix-tests"]?.isLive == true }
        XCTAssertTrue(online)
        let row = cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]!.row
        XCTAssertEqual(cache.rowIndex(model: model, relay: model.relay).state(for: row).presence, .online)
        XCTAssertGreaterThan(cache.metadataBuildCount, metadataBuilds)
        XCTAssertEqual(cache.rowsBuildCount, builds, "Roster, archives and push metadata must not redo the merge")
        model.relay.accountChanged()
        XCTAssertTrue(model.relay.roster.isEmpty)
        _ = cache.snapshot(model: model, relay: model.relay)
        XCTAssertGreaterThan(cache.metadataBuildCount, metadataBuilds + 1)
    }

    func testSearchSourceCacheTracksOptimisticUploadAndRelayMetadata() async {
        let includeGate = DispatchSemaphore(value: 0)
        let deleteGate = DispatchSemaphore(value: 0)
        let registerGate = DispatchSemaphore(value: 0)
        defer { includeGate.signal(); deleteGate.signal(); registerGate.signal() }
        core.on("uploader.sessions.include") { _ in
            includeGate.wait()
            throw FakeCore.Failure(kind: "unavailable", message: "Exercise rollback")
        }
        core.on("uploader.sessions.delete") { _ in
            deleteGate.wait()
            throw FakeCore.Failure(kind: "unavailable", message: "Exercise rollback")
        }
        core.on("agents.register") { _ in
            registerGate.wait()
            throw FakeCore.Failure(kind: "conflict", message: "Exercise rollback")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.sessions.count == 2 && model.relay.sessions.count == 1 }
        guard ready else { XCTFail("FakeCore sessions did not load"); return }
        let cache = model.sessionSearchSource
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["claude:b"]?.uploadState, .local)
        let include = Task { await model.includeSessions(keys: ["claude:b"]) }
        let requesting = await eventually { model.requestingUploads.contains("claude:b") }
        XCTAssertTrue(requesting)
        let pendingUpload = cache.snapshot(model: model, relay: model.relay).metadata["claude:b"]
        XCTAssertEqual(pendingUpload?.uploadState, .preparing)
        XCTAssertEqual(pendingUpload?.uploadEnabled, true)
        includeGate.signal()
        _ = await include.value
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["claude:b"]?.uploadState, .local)

        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.uploadEnabled, true)
        let deletion = Task { await model.excludeSessions(keys: ["codex:a"]) }
        let stopping = await eventually { model.stoppingUploads.contains("codex:a") }
        XCTAssertTrue(stopping)
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.uploadEnabled, false)
        deleteGate.signal()
        await deletion.value
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.uploadEnabled, true)

        let session = model.relay.sessions[0]
        let registration = Task { await model.relay.register(session, as: "fix-tests") }
        let busy = await eventually { model.relay.busyTargets.contains(session.id) }
        XCTAssertTrue(busy)
        XCTAssertNil(model.relay.wanted[session.id], "An explicit name registration changes busy state alone")
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.onRelay, true)
        // While busy, requesting a different state only changes wanted. Both
        // dependencies independently invalidate the cached sort metadata.
        model.relay.requestRelay(false, for: session)
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.onRelay, false)
        registerGate.signal()
        await registration.value
        XCTAssertFalse(model.relay.busyTargets.contains(session.id))
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.onRelay, false)
    }

    func testSearchSourceCacheTracksUploaderStatusWithoutRemerging() async {
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "new", "sessions": [["source": "codex", "session_id": "a", "title": "Fix tests", "is_agent": false, "included": true, "status": "queued"]]]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.sessions.count == 1 && model.status != nil }
        guard ready else { XCTFail("FakeCore uploader did not load"); return }
        let cache = model.sessionSearchSource
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.uploadState, .queued)
        let builds = cache.rowsBuildCount
        core.on("uploader.status") { _ in
            ["running": true, "paused": true, "sharing_mode": "new", "directory": "/tmp/install",
             "collector_replacing": false, "collector_outdated": false,
             "delivery": ["bootstrap_complete": true, "pending_records": 0, "acknowledged_records": 4, "quarantined_records": 0, "skipped_records": 0,
                          "unqueued_changes": 0, "last_acknowledged_ms": NSNull(), "failure": NSNull(), "stopped": false],
             "sessions": ["total": 1, "shared": 1, "excluded": 0], "stage": "up_to_date", "stage_message": NSNull(),
             "needs_start": false, "journal_full": false, "upgrading": false, "stalled": false]
        }
        await model.refreshStatus()
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:a"]?.uploadState, .paused)
        XCTAssertEqual(cache.rowsBuildCount, builds)
    }

    func testSearchSourceCacheClearsPreviewMetadataWithoutChangingRows() async {
        core.on("uploader.sessions.preview") { _ in Self.history(1) }
        core.on("uploader.sessions.list") { _ in Self.history(1) }
        core.setStatus(FakeCore.snapshot(revision: 2, account: [
            "state": "preparing", "phase": "preparing_local_sessions", "person": ["id": "user_1", "email": "ada@example.com"]
        ]))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.previewSessionIDs.contains("codex:history-0") }
        guard ready else { XCTFail("FakeCore preview did not load"); return }
        let cache = model.sessionSearchSource
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:history-0"]?.uploadState, .discovering)
        let rowsRevision = model.sessionRowsRevision
        core.setStatus(FakeCore.snapshot(revision: 3, account: FakeCore.signedIn))
        let attached = await eventually { model.phase == .attached && model.previewSessionIDs.isEmpty }
        XCTAssertTrue(attached)
        XCTAssertEqual(model.sessionRowsRevision, rowsRevision, "Identical uploaded rows must not hide a missing preview-metadata invalidation")
        XCTAssertEqual(cache.snapshot(model: model, relay: model.relay).metadata["codex:history-0"]?.uploadState, .local)
    }

    private func model(service: FakeService = FakeService(status: .enabled), version: String? = "1.0.0", unregisterSettle: UInt64 = 0) -> AppModel {
        AppModel(client: CoreClient(socketPath: core.path), service: service, bundledCoreVersion: version, unregisterSettle: unregisterSettle,
                 siteURL: "https://agentrelay.com", manageSystemServices: false, defaults: defaults)
    }

    nonisolated private static func history(_ count: Int) -> [String: Any] {
        ["sharing_mode": "new", "sessions": (0..<count).map { index in
            ["source": "codex", "session_id": "history-\(index)", "title": "Session \(index)",
             "is_agent": false, "included": false, "status": "not_shared"] as [String: Any]
        }]
    }

    private func scrollView(in view: NSView) -> NSScrollView? {
        // The toolbar also contains a horizontal scroll view for filter chips.
        if let scroll = view as? NSScrollView, scroll.hasVerticalScroller { return scroll }
        return view.subviews.lazy.compactMap { self.scrollView(in: $0) }.first
    }

    func testSessionListEndIgnoresAnUnmeasuredLazyStack() {
        let row = SessionListEndMeasurement.rowHeight
        XCTAssertFalse(SessionListEndMeasurement.isNearEnd(
            contentHeight: 9 * row, contentMaxY: 9 * row, viewportHeight: 600, renderedRows: 500),
            "A footer placed after the first realized rows is not the end of the list")
        XCTAssertFalse(SessionListEndMeasurement.isNearEnd(
            contentHeight: 500 * row - 1, contentMaxY: 600, viewportHeight: 600, renderedRows: 500),
            "A measurement one point short of the rendered rows is still incomplete")
        XCTAssertFalse(SessionListEndMeasurement.isNearEnd(
            contentHeight: 500 * row, contentMaxY: 500 * row, viewportHeight: 600, renderedRows: 500),
            "The first viewport stays on the first page")
        XCTAssertFalse(SessionListEndMeasurement.isNearEnd(
            contentHeight: 500 * row, contentMaxY: 600 + SessionListEndMeasurement.nearEndSlack + 1,
            viewportHeight: 600, renderedRows: 500),
            "The end just outside the slack must not page")
        XCTAssertTrue(SessionListEndMeasurement.isNearEnd(
            contentHeight: 500 * row, contentMaxY: 600, viewportHeight: 600, renderedRows: 500),
            "Scrolling the measured list to its end loads the next page")
        XCTAssertTrue(SessionListEndMeasurement.isNearEnd(
            contentHeight: 500 * row, contentMaxY: 600 + SessionListEndMeasurement.nearEndSlack,
            viewportHeight: 600, renderedRows: 500),
            "The end within the same slack still loads the next page")
        XCTAssertTrue(SessionListEndMeasurement.isNearEnd(
            contentHeight: 120, contentMaxY: 120, viewportHeight: 600, renderedRows: 0),
            "A short filtered list is at its end and must keep paging")
        XCTAssertFalse(SessionListEndMeasurement.isNearEnd(
            contentHeight: 0, contentMaxY: 0, viewportHeight: 600, renderedRows: 500),
            "A missing coordinate space must not page")
    }

    func testSessionViewportLoadsOnlyWhenScrolledNearEnd() async throws {
        core.on("uploader.sessions.list") { params in
            Self.history(min(params["limit"] as? Int ?? 500, 503))
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.canLoadMoreSessions }
        XCTAssertTrue(ready)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 600),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: LocalSessionsView(relay: model.relay).environmentObject(model))
        window.contentView = host
        window.orderFront(nil)
        defer { window.close(); model.shutdown() }
        let laidOut = await eventually {
            guard let scroll = self.scrollView(in: host) else { return false }
            return (scroll.documentView?.bounds.height ?? 0) > scroll.contentView.bounds.height
        }
        XCTAssertTrue(laidOut)
        XCTAssertEqual(model.sessionLimit, 500, "The first viewport must not load all history")
        let scroll = try XCTUnwrap(scrollView(in: host))
        let document = try XCTUnwrap(scroll.documentView)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: document.bounds.maxY - scroll.contentView.bounds.height))
        scroll.reflectScrolledClipView(scroll.contentView)
        let loaded = await eventually { model.sessions.count == 503 }
        XCTAssertTrue(loaded, "Scrolling to the end must fetch older sessions without a button")
        XCTAssertEqual(model.sessionLimit, 1000)
    }

    func testFilteredViewportLoadsOlderSessionsAutomatically() async {
        core.on("uploader.sessions.list") { params in
            Self.history(min(params["limit"] as? Int ?? 500, 503))
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.canLoadMoreSessions }
        XCTAssertTrue(ready)
        model.sessionSearch = "id:history-502"
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 600),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: LocalSessionsView(relay: model.relay).environmentObject(model))
        window.orderFront(nil)
        defer { window.close(); model.shutdown() }
        let loaded = await eventually { model.sessions.count == 503 }
        XCTAssertTrue(loaded, "An empty filtered viewport must fetch older matching sessions without a button")
        XCTAssertEqual(model.sessionLimit, 1000)
    }

    func testPaginationCoalescesRequestsAndStopsAtEnd() async {
        core.on("uploader.sessions.list") { params in
            Self.history(min(params["limit"] as? Int ?? 500, 503))
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.canLoadMoreSessions }
        XCTAssertTrue(ready)
        async let first: Void = model.loadMoreSessions()
        async let duplicate: Void = model.loadMoreSessions()
        _ = await (first, duplicate)
        XCTAssertEqual(model.sessions.count, 503)
        XCTAssertEqual(model.sessionLimit, 1000)
        XCTAssertFalse(model.canLoadMoreSessions)
        await model.loadMoreSessions()
        XCTAssertEqual(model.sessionLimit, 1000)
        model.shutdown()
    }

    func testFailedPaginationRecoversOnAutomaticRefresh() async {
        core.on("uploader.sessions.list") { _ in Self.history(500) }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.canLoadMoreSessions }
        XCTAssertTrue(ready)
        core.on("uploader.sessions.list") { _ in
            throw FakeCore.Failure(kind: "internal", message: "Temporary outage")
        }
        await model.loadMoreSessions()
        XCTAssertEqual(model.sessions.count, 500)
        XCTAssertNotNil(model.sessionsError)
        XCTAssertFalse(model.canLoadMoreSessions)
        core.on("uploader.sessions.list") { params in
            Self.history(min(params["limit"] as? Int ?? 500, 503))
        }
        model.windowVisibilityChanged(true)
        await model.refreshVisibleState()
        XCTAssertEqual(model.sessions.count, 503)
        XCTAssertNil(model.sessionsError)
        XCTAssertEqual(model.sessionLimit, 1000)
        model.shutdown()
    }

    func testLocalSessionLanding() async throws {
        let model = model()
        XCTAssertEqual(model.page, .sessions)
        XCTAssertEqual(DesktopSection.mine.landing, .sessions)
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        await model.bootstrapIfNeeded()
        await model.refreshVisibleState()
        let loaded = await eventually { model.sessions.count == 2 && model.relay.sessions.count == 1 }
        XCTAssertTrue(loaded)
        let row = try XCTUnwrap(LocalSessionRow.merge(uploads: model.sessions, sessions: model.relay.sessions).first)
        model.selectedLocalSession = row
        model.sessionSearch = "Fix tests"
        model.page = .settings(.account)
        model.showLocalSessions()
        XCTAssertEqual(model.page, .sessions)
        XCTAssertNil(model.selectedLocalSession)
        XCTAssertEqual(model.sessionSearch, "Fix tests")
        model.selectedLocalSession = row
        model.page = .settings(.account)
        model.showLocalSessions(search: "is:active is:on-relay")
        XCTAssertEqual(model.page, .sessions)
        XCTAssertNil(model.selectedLocalSession)
        XCTAssertEqual(model.sessionSearch, "is:active is:on-relay")
        model.showDiagnosticsFromMenu()
        XCTAssertEqual(model.page, .settings(.diagnostics))
        model.shutdown()
    }

    func testRegistersTheCoreWhenItIsNotRegistered() async {
        let service = FakeService(status: .notRegistered)
        let model = model(service: service)
        await model.bootstrapIfNeeded()
        XCTAssertEqual(service.registered, 1)
        XCTAssertFalse(model.coreNeedsApproval)
        model.shutdown()
    }

    func testRequiresAnInstalledAppBeforeRegisteringTheCore() async {
        let service = FakeService(status: .notRegistered)
        service.installationProblem = "Move Agent Relay to Applications before opening it."
        let model = model(service: service)
        await model.bootstrapIfNeeded()
        XCTAssertEqual(service.registered, 0)
        XCTAssertEqual(model.coreProblem, service.installationProblem)
        XCTAssertTrue(model.coreNeedsInstallation)
        XCTAssertFalse(model.isCoreConnected)
        XCTAssertTrue(core.calls.isEmpty)
        await model.retryBackgroundService()
        XCTAssertEqual(service.registered, 0)
        XCTAssertEqual(service.unregistered, 0)
        model.stopBackgroundService()
        XCTAssertEqual(service.unregistered, 0)
        model.shutdown()
        XCTAssertEqual(service.unregistered, 0)
    }

    func testOnlyApplicationsLocationsCanRegisterTheBundledAgent() {
        let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
        XCTAssertTrue(LaunchAgentService.isInstalledInApplications(
            URL(fileURLWithPath: "/Applications/Agent Relay.app"), homeDirectory: home))
        XCTAssertTrue(LaunchAgentService.isInstalledInApplications(
            URL(fileURLWithPath: "/Users/example/Applications/Agent Relay.app"), homeDirectory: home))
        XCTAssertFalse(LaunchAgentService.isInstalledInApplications(
            URL(fileURLWithPath: "/Volumes/Agent Relay/Agent Relay.app"), homeDirectory: home))
        XCTAssertFalse(LaunchAgentService.isInstalledInApplications(
            URL(fileURLWithPath: "/Users/example/Downloads/Agent Relay.app"), homeDirectory: home))
    }

    func testMovingAnUnchangedAppChangesItsCoreRegistrationIdentity() {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        let first = LaunchAgentService.binaryIdentity(
            digest: "same-helper", modified: date,
            bundleURL: URL(fileURLWithPath: "/Users/example/Applications/Agent Relay.app"))
        let moved = LaunchAgentService.binaryIdentity(
            digest: "same-helper", modified: date,
            bundleURL: URL(fileURLWithPath: "/Applications/Agent Relay.app"))
        XCTAssertNotEqual(first, moved)
    }

    func testRegistersAgainForANewCoreBinary() async {
        let service = FakeService(status: .enabled)
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        await model.ensureService()
        XCTAssertEqual(service.unregistered, 0)
        service.binaryIdentity = "build-2"
        await model.ensureService()
        XCTAssertEqual(service.unregistered, 1)
        XCTAssertEqual(service.registered, 1)
        XCTAssertEqual(defaults.string(forKey: AppModel.registeredCoreKey), "build-2")
        await model.ensureService()
        XCTAssertEqual(service.registered, 1)
    }

    func testCancelledBinaryReplacementRestoresRegistration() async {
        let service = FakeService(status: .enabled)
        let model = model(service: service, unregisterSettle: 60_000_000_000)
        let repair = Task { await model.ensureService() }
        let unregistered = await eventually { service.unregistered == 1 }
        XCTAssertTrue(unregistered)
        repair.cancel()
        await repair.value
        XCTAssertEqual(service.status, .enabled)
        XCTAssertEqual(service.registered, 1)
        XCTAssertEqual(defaults.string(forKey: AppModel.registeredCoreKey), "build-1")
    }

    func testCancelledRecoveryRestoresRegistrationWithoutStartingAnotherRepair() async {
        // Cover cancellation in both ensureService and the refusal repair itself.
        for binaryChanged in [false, true] {
            let service = FakeService(status: .enabled)
            defaults.set(binaryChanged ? "old-build" : "build-1", forKey: AppModel.registeredCoreKey)
            let model = model(service: service, unregisterSettle: 60_000_000_000)
            let repair = Task { await model.retryBackgroundService() }
            let unregistered = await eventually { service.unregistered == 1 }
            XCTAssertTrue(unregistered)
            repair.cancel()
            await repair.value
            XCTAssertEqual(service.status, .enabled)
            XCTAssertEqual(service.registered, 1)
            XCTAssertEqual(service.unregistered, 1)
            XCTAssertFalse(model.isRecoveringCore)
        }
    }

    func testShutdownRestoresRegistrationBeforeReturning() async {
        let service = FakeService(status: .enabled)
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service, unregisterSettle: 60_000_000_000)
        let repair = Task { await model.retryBackgroundService() }
        let unregistered = await eventually { service.unregistered == 1 }
        XCTAssertTrue(unregistered)
        model.shutdown()
        // applicationWillTerminate cannot wait for an async repair to resume.
        XCTAssertEqual(service.status, .enabled)
        XCTAssertEqual(service.registered, 1)
        repair.cancel()
        await repair.value
        XCTAssertEqual(service.registered, 1)
    }

    func testExplicitStopDuringRecoveryDoesNotRestoreRegistration() async {
        let service = FakeService(status: .enabled)
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service, unregisterSettle: 60_000_000_000)
        let repair = Task { await model.retryBackgroundService() }
        let unregistered = await eventually { service.unregistered == 1 }
        XCTAssertTrue(unregistered)
        model.stopBackgroundService()
        model.shutdown()
        repair.cancel()
        await repair.value
        XCTAssertEqual(service.status, .notRegistered)
        XCTAssertEqual(service.registered, 0)
    }

    func testQuittingLeavesTheCoreRunningByDefault() async {
        let service = FakeService(status: .enabled)
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        XCTAssertTrue(model.keepsAgentsConnectedAfterQuit)
        await model.bootstrapIfNeeded()
        model.shutdown()
        XCTAssertEqual(service.unregistered, 0)
        XCTAssertEqual(service.status, .enabled)
    }

    func testQuittingStopsTheCoreUntilTheAppOpensAgainWhenChosen() async {
        let service = FakeService(status: .enabled)
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let first = model(service: service)
        first.setKeepsAgentsConnectedAfterQuit(false)
        await first.bootstrapIfNeeded()
        first.shutdown()
        XCTAssertEqual(service.unregistered, 1)
        XCTAssertEqual(service.status, .notRegistered)

        // The choice is remembered, and opening the app registers the core again.
        let second = model(service: service)
        XCTAssertFalse(second.keepsAgentsConnectedAfterQuit)
        await second.bootstrapIfNeeded()
        XCTAssertEqual(service.registered, 1)
        XCTAssertEqual(service.status, .enabled)
        second.shutdown()
    }

    func testWaitsForLoginItemsApproval() async {
        let service = FakeService(status: .requiresApproval)
        let model = model(service: service)
        await model.bootstrapIfNeeded()
        XCTAssertEqual(service.registered, 0)
        XCTAssertTrue(model.coreNeedsApproval)
        model.openLoginItemsSettings()
        XCTAssertEqual(service.openedSettings, 1)
        model.shutdown()
    }

    func testRendersTheSnapshotAndFollowsTheAccount() async {
        let model = model()
        await model.bootstrapIfNeeded()
        let launched = await eventually { model.phase == .signedOut }
        XCTAssertTrue(launched)
        XCTAssertTrue(model.isCoreConnected)

        core.setStatus(FakeCore.snapshot(revision: 2, account: ["state": "pending_approval", "phase": "waiting_for_browser"]))
        let waiting = await eventually { model.phase == .waitingForBrowser }
        XCTAssertTrue(waiting)

        core.setStatus(FakeCore.snapshot(revision: 3, account: FakeCore.signedIn))
        let attached = await eventually { model.phase == .attached && model.status != nil && model.sessions.count == 2 }
        XCTAssertTrue(attached)
        XCTAssertEqual(model.accountEmail, "ada@example.com")
        XCTAssertEqual(model.statusViewModel?.state, .upToDate)
        XCTAssertEqual(model.sessionUploadSummary?.headline, "Uploads up to date")
        XCTAssertEqual(model.uploadState(for: model.sessions[0]), .uploaded)
        XCTAssertEqual(model.uploadState(for: model.sessions[1]), .local)

        // An older revision never replaces a newer one.
        core.setStatus(FakeCore.snapshot(revision: 2, account: ["state": "signed_out"]))
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(model.phase, .attached)

        core.setStatus(FakeCore.snapshot(revision: 4, account: ["state": "error", "error": "The approval expired."]))
        let failed = await eventually { model.phase == .signedOut }
        XCTAssertTrue(failed)
        XCTAssertEqual(model.signInError, "The approval expired.")
        XCTAssertNil(model.status)
        model.shutdown()
    }

    func testSettingsInvalidationsAreCountedForRowsThatReadTheirOwnStatus() async {
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { self.core.callCount("settings.get") >= 1 }
        let reads = core.callCount("settings.get")
        XCTAssertEqual(model.settingsInvalidations, 0)
        core.publish("invalidated", ["what": "settings"])
        let counted = await eventually { model.settingsInvalidations == 1 }
        XCTAssertTrue(counted, "the Agent Relay tools row restarts its read on this")
        let reread = await eventually { self.core.callCount("settings.get") > reads }
        XCTAssertTrue(reread)
        model.shutdown()
    }

    func testInvalidationsRefetchTheirCollection() async {
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { self.core.callCount("agents.list") >= 1 }
        let before = core.callCount("agents.list")
        core.publish("invalidated", ["what": "agents"])
        let refetched = await eventually { self.core.callCount("agents.list") > before }
        XCTAssertTrue(refetched)
        model.shutdown()
    }

    nonisolated static func rosterAgent(_ liveness: String) -> [String: Any] {
        ["name": "bot", "address": "bot@box", "kind": "agent", "where": "other_desktop",
         "status": liveness == "live" ? "active" : "idle", "liveness": liveness, "last_seen_ms": 1,
         "description": "", "host": NSNull(), "owner_hash": NSNull(), "session_id": NSNull(), "is_self": false]
    }

    nonisolated static func recipient(_ liveness: String, message: String?, known: Bool = true) -> [String: Any] {
        guard known else { return ["known": false, "agent": NSNull(), "message": NSNull()] }
        return ["known": true, "agent": rosterAgent(liveness), "message": message ?? NSNull()]
    }

    func testTheComposerShowsWhatRelaycastHoldsForTheMessage() async {
        let message = Locked<String?>("queued")
        core.on("roster.get") { params in
            Self.recipient("live", message: params["message_id"] == nil ? nil : message.value)
        }
        core.on("messages.send") { params in
            ["message_id": "m1", "conversation_id": "c1", "to": params["to"] ?? NSNull(),
             "recipient": Self.recipient("live", message: "queued")]
        }
        core.on("messages.history") { _ in ["identity": "ada", "messages": []] }
        let model = model()
        await model.bootstrapIfNeeded()
        let relay = model.relay
        relay.openComposer("@bot")

        let error = await relay.sendMessage(to: "@bot", text: "status?")
        XCTAssertNil(error)
        // Live, but Relaycast still holds it: never shown as delivered.
        XCTAssertEqual(relay.deliveryNote(at: "bot")?.text, "Queued — not yet handed to the agent")

        message.value = "delivered"
        core.publish("invalidated", ["what": "sessions"])
        let delivered = await eventually { relay.deliveryNote(at: "bot")?.text == "Delivered" }
        XCTAssertTrue(delivered)
        XCTAssertEqual(core.lastParams("roster.get")?["message_id"] as? String, "m1")

        // A read that cannot tell keeps what Relaycast last reported.
        message.value = nil
        await relay.lookUpRecipient("bot")
        XCTAssertEqual(relay.deliveryNote(at: "bot")?.text, "Delivered")

        // Writing the next message gives the note way to the recipient.
        relay.forgetLastSend()
        XCTAssertNil(relay.deliveryNote(at: "bot"))
        relay.closeComposer()
        XCTAssertNil(relay.recipient(at: "bot"))
        let reads = core.callCount("roster.get")
        core.publish("invalidated", ["what": "sessions"])
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(core.callCount("roster.get"), reads, "a closed composer follows nothing")
        model.shutdown()
    }

    func testChangingToRetiresTheLastSendAndItsFollowUp() async {
        core.on("roster.get") { params in
            let offline = params["to"] as? String == "sleeper"
            var agent = Self.rosterAgent(offline ? "offline" : "live")
            agent["name"] = params["to"] ?? "bot"
            return ["known": true, "agent": agent,
                    "message": params["message_id"] == nil ? NSNull() : "queued"] as [String: Any]
        }
        core.on("messages.send") { _ in
            ["message_id": "m1", "conversation_id": "c1", "to": "bot", "recipient": Self.recipient("live", message: "queued")]
        }
        core.on("messages.history") { _ in ["identity": "ada", "messages": []] }
        let model = model()
        await model.bootstrapIfNeeded()
        let relay = model.relay
        relay.openComposer("@bot")

        _ = await relay.sendMessage(to: "@bot", text: "status?")
        XCTAssertNotNil(relay.deliveryNote(at: "bot"))
        // To changes to an agent that is not running before the follow-up fires.
        relay.composerShows("@sleeper")
        XCTAssertNil(relay.deliveryNote(at: "bot"), "the last send is retired")
        await relay.lookUpRecipient("@sleeper")
        let reads = core.callCount("roster.get")
        try? await Task.sleep(nanoseconds: 2_400_000_000)
        XCTAssertEqual(core.callCount("roster.get"), reads, "the retired send's follow-up never reads")
        XCTAssertEqual(relay.recipient(at: "sleeper")?.agent?.name, "sleeper")
        XCTAssertEqual(relay.recipient(at: "sleeper").flatMap { MessageDelivery.warning(for: $0) },
                       "@sleeper is not running right now. Queue anyway?")
        // Invalidations follow the new recipient only.
        core.publish("invalidated", ["what": "sessions"])
        let followed = await eventually { self.core.callCount("roster.get") > reads }
        XCTAssertTrue(followed)
        XCTAssertEqual(core.lastParams("roster.get")?["to"] as? String, "sleeper")
        model.shutdown()
    }

    func testAClosedComposerFollowsNothing() async {
        let held = DispatchSemaphore(value: 0)
        let holding = Locked(true)
        core.on("roster.get") { _ in
            if holding.value { held.wait() }
            return Self.recipient("offline", message: nil)
        }
        let model = model()
        await model.bootstrapIfNeeded()
        let relay = model.relay
        relay.openComposer("@bot")
        // A lookup is in flight when the sheet closes.
        let inFlight = Task { await relay.lookUpRecipient("@bot") }
        let started = await eventually { self.core.callCount("roster.get") == 1 }
        XCTAssertTrue(started)
        relay.closeComposer()
        holding.value = false
        held.signal()
        await inFlight.value
        XCTAssertNil(relay.recipient(at: "bot"), "the answer for a closed composer is dropped")
        // The sheet's task firing after close is only a read, and reads nothing.
        await relay.lookUpRecipient("@bot")
        for what in ["sessions", "fleet", "roster", "messages"] {
            core.publish("invalidated", ["what": what])
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(core.callCount("roster.get"), 1, "nothing is followed after close")
        model.shutdown()
    }

    func testAnotherWorkspaceSaysNothingAboutTheRecipient() async {
        core.on("roster.get") { _ in Self.recipient("live", message: nil, known: false) }
        core.on("messages.send") { _ in
            ["message_id": "m1", "conversation_id": "c1", "to": "alice",
             "recipient": Self.recipient("live", message: nil, known: false)]
        }
        core.on("messages.history") { _ in ["identity": "ada", "messages": []] }
        let model = model()
        await model.bootstrapIfNeeded()
        let relay = model.relay
        relay.openComposer("alice")
        await relay.lookUpRecipient("alice")
        let unknown = relay.recipient(at: "alice")
        XCTAssertEqual(unknown?.known, false)
        XCTAssertNil(unknown.flatMap { MessageDelivery.warning(for: $0) })
        XCTAssertFalse(MessageDelivery.queues(unknown))
        _ = await relay.sendMessage(to: "alice", text: "hi")
        XCTAssertEqual(relay.deliveryNote(at: "alice")?.text, "Sent — delivery unknown")
        model.shutdown()
    }

    func testASendToNoSuchAgentSaysSo() async {
        core.on("messages.send") { _ in throw FakeCore.Failure(kind: "not_found", message: "No agent is at that address.") }
        let model = model()
        await model.bootstrapIfNeeded()
        model.relay.openComposer("ghost@box")
        let error = await model.relay.sendMessage(to: "ghost@box", text: "hello")
        XCTAssertEqual(error, "No such agent")
        XCTAssertEqual(model.relay.recipient(at: "ghost@box").map { MessageDelivery.warning(for: $0) },
                       "No agent has this name or address.")
        XCTAssertEqual(core.lastParams("messages.send")?["address"] as? String, "ghost@box")
        model.shutdown()
    }

    func testCarriesAnOptOutOverOnceAndForgetsTheOldKeys() async {
        defaults.set(false, forKey: LegacyMigration.analyticsEnabledKey)
        defaults.set("old-id", forKey: LegacyMigration.analyticsIdentityKey)
        defaults.set("device", forKey: LegacyMigration.deviceIDKey)
        defaults.set(true, forKey: LegacyMigration.loginItemConfiguredKey)
        defaults.set("digest", forKey: LegacyMigration.incomingRecoveryPrefix + "/x/shares.json")
        let model = model()
        await model.bootstrapIfNeeded()
        let migrated = await eventually { model.settings?.analyticsEnabled == false }
        XCTAssertTrue(migrated)
        XCTAssertEqual(core.callCount("settings.set"), 1)
        XCTAssertEqual(core.lastParams("settings.set")?["analytics_enabled"] as? Bool, false)
        for key in [LegacyMigration.analyticsEnabledKey, LegacyMigration.analyticsIdentityKey,
                    LegacyMigration.deviceIDKey, LegacyMigration.loginItemConfiguredKey,
                    LegacyMigration.incomingRecoveryPrefix + "/x/shares.json"] {
            XCTAssertNil(defaults.object(forKey: key), key)
        }
        model.shutdown()

        let again = self.model()
        await again.bootstrapIfNeeded()
        _ = await eventually { again.settings != nil }
        XCTAssertEqual(core.callCount("settings.set"), 1)
        again.shutdown()
    }

    func testRestartsACoreOfAnotherVersion() async {
        let model = model(version: "2.0.0")
        await model.bootstrapIfNeeded()
        let asked = await eventually { self.core.callCount("daemon.shutdown") == 1 }
        XCTAssertTrue(asked)
        // The core asked to stop still answers while it exits; the app
        // never connects to it.
        let reconnected = await eventually(3) { self.core.callCount("subscribe") >= 3 }
        XCTAssertTrue(reconnected)
        XCTAssertFalse(model.isCoreConnected)
        // launchd's replacement is connected to, and asked nothing.
        core.pid += 1
        let connected = await eventually { model.isCoreConnected && model.phase == .signedOut }
        XCTAssertTrue(connected)
        XCTAssertEqual(core.callCount("daemon.shutdown"), 1)
        model.shutdown()
    }

    func testVersionMismatchDoesNotRestartEveryReplacementProcess() async {
        core.on("daemon.shutdown") { [core] _ in
            core!.pid += 1
            return ["stopping": true]
        }
        let model = model(version: "incorrect-build-metadata")
        await model.bootstrapIfNeeded()
        let connected = await eventually { model.phase == .signedOut }
        XCTAssertTrue(connected, "A bridge-compatible replacement must reach sign-in")
        XCTAssertEqual(core.callCount("daemon.shutdown"), 1)
        model.shutdown()
    }

    func testManualRecoveryRegistersTheServiceAgain() async {
        let service = FakeService(status: .enabled)
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        await model.retryBackgroundService()
        XCTAssertEqual(service.unregistered, 1)
        XCTAssertEqual(service.registered, 1)
        XCTAssertFalse(model.isRecoveringCore)
        XCTAssertNil(model.coreProblem)
    }

    func testBrokenBundleProgramUsesFallbackWithoutReregistering() async {
        let service = FakeService(status: .enabled)
        service.repairsSpawnFailure = true
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        await model.retryBackgroundService()
        XCTAssertEqual(service.unregistered, 0)
        XCTAssertEqual(service.registered, 0)
        XCTAssertFalse(model.isRecoveringCore)
        XCTAssertNil(model.coreProblem)
    }

    func testFallbackApprovalIsShownImmediatelyAfterRecovery() async {
        let service = FakeService(status: .enabled)
        service.repairsSpawnFailure = true
        service.spawnRepairStatus = .requiresApproval
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        await model.retryBackgroundService()
        XCTAssertTrue(model.coreNeedsApproval)
        XCTAssertTrue(model.coreProblem?.contains("Allow Agent Relay") == true)
        XCTAssertEqual(service.registered, 0)
    }

    func testBrokenBundleProgramIsCheckedBeforeGeneralRecovery() async {
        core.stop()
        let service = FakeService(status: .enabled)
        service.repairsSpawnFailure = true
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        await model.bootstrapIfNeeded()
        let checked = await eventually(3) { service.spawnRepairChecks > 0 }
        XCTAssertTrue(checked)
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(service.unregistered, 0)
        XCTAssertEqual(service.registered, 0)
        model.shutdown()
    }

    func testRecognizesOnlyTheBrokenBundleProgramFailure() {
        let broken = """
        program identifier = Contents/Helpers/Agent Relay Helper (mode: 2)
        last exit code = 78: EX_CONFIG
        job state = spawn failed
        """
        XCTAssertTrue(LaunchAgentService.hasBrokenBundleProgram(broken))
        XCTAssertFalse(LaunchAgentService.hasBrokenBundleProgram(
            broken.replacingOccurrences(of: "78: EX_CONFIG", with: "1")))
        XCTAssertFalse(LaunchAgentService.hasBrokenBundleProgram(
            broken.replacingOccurrences(of: "78: EX_CONFIG", with: "780: OTHER")))
        XCTAssertFalse(LaunchAgentService.hasBrokenBundleProgram(
            broken.replacingOccurrences(of: "spawn failed", with: "running")))
    }

    func testFailedFallbackShowsARelevantStartupError() async {
        let service = FakeService(status: .enabled)
        service.spawnRepairError = NSError(domain: "com.agentrelay.desktop.launch-agent", code: 1)
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        await model.retryBackgroundService()
        XCTAssertTrue(model.coreProblem?.contains("backup background service") == true)
        XCTAssertEqual(service.unregistered, 0)
    }

    func testRecoveryPreservesRequiredApproval() async {
        let service = FakeService(status: .requiresApproval)
        let model = model(service: service)
        await model.retryBackgroundService()
        XCTAssertTrue(model.coreNeedsApproval)
        XCTAssertNotNil(model.coreProblem)
        XCTAssertEqual(service.unregistered, 0)
        XCTAssertEqual(service.registered, 0)
    }

    func testMissingServiceHasActionableStartupError() async {
        let model = model(service: FakeService(status: .notFound))
        await model.ensureService()
        XCTAssertNotNil(model.coreProblem)
    }

    func testRecoveryShowsApprovalRequiredByNewRegistration() async {
        let service = FakeService(status: .enabled)
        service.registrationStatus = .requiresApproval
        defaults.set("build-1", forKey: AppModel.registeredCoreKey)
        let model = model(service: service)
        await model.retryBackgroundService()
        XCTAssertTrue(model.coreNeedsApproval)
        XCTAssertNotNil(model.coreProblem)
        XCTAssertFalse(model.isRecoveringCore)
    }

    func testFailedRegistrationIsVisibleAndCanBeRetried() async {
        let service = FakeService(status: .notRegistered)
        service.registrationError = NSError(domain: "test", code: 1)
        let model = model(service: service)
        await model.ensureService()
        XCTAssertNotNil(model.coreProblem)
        service.registrationError = nil
        await model.retryBackgroundService()
        XCTAssertEqual(service.status, .enabled)
        XCTAssertFalse(model.isRecoveringCore)
    }

    func testWorkspacePickerStaysOnWelcomeAndSendsSelectedID() async {
        core.on("account.select_workspace") { _ in [:] }
        core.setStatus(FakeCore.snapshot(revision: 2, account: [
            "state": "preparing", "phase": "selecting_workspace",
            "person": ["id": "u", "email": "ada@example.com"],
            "workspace_choices": [
                ["id": "a", "name": "Alpha", "organization_name": "Company"],
                ["id": "b", "name": "Beta", "organization_name": "Personal"]
            ]
        ]))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.account.workspaceChoices?.count == 2 }
        XCTAssertTrue(ready)
        XCTAssertEqual(model.phase, .signingIn)
        XCTAssertEqual(model.account.phase, "selecting_workspace")
        if let path = ProcessInfo.processInfo.environment["WORKSPACE_PICKER_RENDER_PATH"] {
            let host = NSHostingView(rootView: SignInView().environmentObject(model))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 650), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            defer { window.close() }
            try? await Task.sleep(for: .milliseconds(100))
            host.layoutSubtreeIfNeeded()
            if let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            }
        }
        model.selectWorkspace("b")
        let selected = await eventually { self.core.callCount("account.select_workspace") == 1 }
        XCTAssertTrue(selected)
        XCTAssertEqual(core.lastParams("account.select_workspace")?["workspace_id"] as? String, "b")
        XCTAssertEqual(core.callCount("account.sign_in"), 0)
    }

    func testSignInReusesTheDefaultSessionFlow() async {
        core.on("account.sign_in") { [core] _ in
            core!.setStatus(FakeCore.snapshot(revision: 5, account: ["state": "pending_approval", "phase": "waiting_for_browser"]))
            return ["state": "pending_approval", "phase": "waiting_for_browser",
             "verification_url": "https://agentrelay.com/login", "verification_url_complete": "https://agentrelay.com/login?s=1"]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .signedOut }
        model.signIn()
        let asked = await eventually { model.signInLink == "https://agentrelay.com/login?s=1" && model.phase == .waitingForBrowser }
        XCTAssertTrue(asked)
        let params = core.lastParams("account.sign_in")
        XCTAssertNil(params?["flow"] as? String)
        XCTAssertEqual(params?["sharing"] as? String, "selected")
        XCTAssertEqual(params?["site_url"] as? String, "https://agentrelay.com")
        model.shutdown()
    }

    func testUseAnotherAccountRequestsGoogleAccountSelection() async {
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .signedOut }
        model.signIn(useAnotherAccount: true)
        let asked = await eventually { self.core.callCount("account.sign_in") == 1 }
        XCTAssertTrue(asked)
        XCTAssertEqual(core.lastParams("account.sign_in")?["flow"] as? String, "browser")
        model.shutdown()
    }

    func testAnExpiredSessionOffersToSignInAgainWithoutLeavingTheConnectedView() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        core.on("sessions.overview.get") { _ in
            throw FakeCore.Failure(kind: "not_signed_in",
                                   message: "Your Agent Relay sign-in expired. Sign in again to view session summaries.")
        }
        let pending = FakeCore.signedIn.merging(["state": "pending_approval", "phase": "waiting_for_browser"]) { $1 }
        core.on("account.sign_in") { [core] _ in
            core!.setStatus(FakeCore.snapshot(revision: 3, account: pending))
            return pending.merging(["verification_url": "https://agentrelay.com/login",
                                    "verification_url_complete": "https://agentrelay.com/login?s=1"]) { $1 }
        }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached }
        await model.relay.loadOverview("a")
        XCTAssertTrue(model.relay.overviewNeedsSignIn)
        XCTAssertEqual(model.relay.overviews["a"]?.error,
                       "Your Agent Relay sign-in expired. Sign in again to view session summaries.")

        model.renewSignIn()
        let waiting = await eventually { model.renewingSignIn && model.signInLink == "https://agentrelay.com/login?s=1" }
        XCTAssertTrue(waiting)
        // The browser approval keeps the connected view.
        XCTAssertEqual(model.phase, .attached)

        core.on("sessions.overview.get") { _ in ["sessionId": "a", "analyses": [], "requests": []] }
        core.setStatus(FakeCore.snapshot(revision: 4, account: FakeCore.signedIn))
        let renewed = await eventually { !model.renewingSignIn && model.relay.overviewReloads == 1 }
        XCTAssertTrue(renewed)
        XCTAssertFalse(model.relay.overviewNeedsSignIn)
        XCTAssertNil(model.relay.overviews["a"])
        XCTAssertEqual(model.phase, .attached)
        model.shutdown()
    }

    /// The core has turned Claude Code direct delivery on by default.
    private func directDeliveryOnByDefault() {
        core.on("settings.get") { _ in Self.settings(analytics: true).merging(["direct_delivery": true]) { $1 } }
        core.on("account.sign_in") { _ in ["state": "signed_out"] }
    }

    func testFirstRunPreservesClaudeDirectDeliveryDefault() async {
        directDeliveryOnByDefault()
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .signedOut && model.settings != nil }
        XCTAssertEqual(model.inboundDefaultOffer, .offer)
        model.signIn()
        let applied = await eventually { self.core.lastParams("settings.set")?["direct_delivery_default"] as? Bool == true }
        XCTAssertTrue(applied)
        _ = await eventually { self.core.callCount("account.sign_in") == 1 }
        XCTAssertTrue(defaults.bool(forKey: InboundDefault.offeredKey))
        XCTAssertNil(model.inboundDefaultOffer, "offered once")
        model.shutdown()
    }

    func testAFailedFirstRunDefaultIsOfferedAgain() async {
        directDeliveryOnByDefault()
        core.on("settings.set") { _ in throw FakeCore.Failure(kind: "refused", message: "Your Claude settings file is not valid JSON.") }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .signedOut && model.settings != nil }
        model.signIn()
        let failed = await eventually { model.inboundDefaultError != nil }
        XCTAssertTrue(failed)
        XCTAssertFalse(defaults.bool(forKey: InboundDefault.offeredKey))
        XCTAssertEqual(model.inboundDefaultOffer, .offer)
        model.shutdown()
    }

    func testAnExplicitHoldShowsNoBox() async {
        core.on("account.sign_in") { _ in ["state": "signed_out"] }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .signedOut && model.settings != nil }
        XCTAssertNil(model.inboundDefaultOffer)
        model.signIn()
        _ = await eventually { self.core.callCount("account.sign_in") == 1 }
        XCTAssertEqual(core.callCount("settings.set"), 0)
        model.shutdown()
    }

    func testUploadActionsGoThroughTheCore() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.sessions.count == 2 }
        let included = await model.includeSessions(keys: ["claude:b"])
        XCTAssertTrue(included)
        XCTAssertEqual(core.lastParams("uploader.sessions.include")?["session_keys"] as? [String], ["claude:b"])
        await model.setPaused(true)
        XCTAssertEqual(core.callCount("uploader.pause"), 1)
        await model.setSharingMode(.all)
        XCTAssertEqual(core.lastParams("uploader.sharing.set")?["mode"] as? String, "all")
        model.shutdown()
    }

    func testNameConflictCanBeRetriedWithAnExplicitName() async {
        core.on("agents.register") { params in
            guard params["name"] as? String == "my-new-name" else {
                throw FakeCore.Failure(kind: "conflict", message: "Name already taken")
            }
            return ["name": "my-new-name", "address": "my-new-name@mac", "already_registered": false]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { !model.relay.sessions.isEmpty }
        let session = model.relay.sessions[0]
        model.relay.requestRelay(true, for: session)
        _ = await eventually { model.relay.errors[session.id] != nil }
        await model.relay.register(session, as: "  @@My-New-Name@  ")
        XCTAssertNil(model.relay.errors[session.id])
        XCTAssertEqual(core.lastParams("agents.register")?["name"] as? String, "my-new-name")
        XCTAssertFalse(model.relay.busyTargets.contains(session.id))
        model.shutdown()
    }

    func testSwitchingAManagedPickerSessionRegistersItsExactTarget() async {
        var registered = false
        core.on("agents.register") { [core] params in
            let target = params["target"] as? [String: Any]
            XCTAssertEqual(target?["kind"] as? String, "opencode")
            XCTAssertEqual(target?["id"] as? String, "ses_exact")
            registered = true
            // The push channel's state arrives on the snapshot, not the list.
            core!.setStatus(FakeCore.snapshot(revision: 9, account: ["state": "signed_out"], push: ["managed-opencode": ["state": "live"]]))
            return ["name": "managed-opencode", "address": "managed-opencode@mac", "already_registered": false]
        }
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "opencode", "id": "ses_exact"], "title": "OpenCode ses_exact", "live": true,
                           "directory": "/src/project",
                           "registration": registered ? ["name": "managed-opencode", "address": "managed-opencode@mac",
                                                         "added_by_session": false, "push": ["state": "live"]] as Any : NSNull(),
                           "suggested_name": "managed-opencode"]]]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        let listed = await eventually { model.relay.sessions.count == 1 }
        XCTAssertTrue(listed)
        let session = model.relay.sessions[0]
        XCTAssertEqual(session.target, Target(id: "ses_exact", kind: .opencode))
        XCTAssertEqual(session.target.uploadKey, "opencode:ses_exact")
        XCTAssertEqual(model.relay.presence(of: session), .off)
        model.relay.requestRelay(true, for: session)
        XCTAssertEqual(model.relay.presence(of: session), .joining)
        let online = await eventually { model.relay.sessions.first.map { model.relay.presence(of: $0) } == .online }
        XCTAssertTrue(online)
        XCTAssertEqual(core.callCount("agents.register"), 1)
        model.shutdown()
    }

    func testProjectsPollCachedStateWithoutRequestingInference() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached && model.chat.projects != nil }
        core.on("chat.projects") { _ in ["report": NSNull(), "stale": true, "refreshing": true] }
        await model.chat.readProjects()
        XCTAssertTrue(model.chat.isLoadingProjects)
        core.on("chat.projects") { _ in ["report": NSNull(), "stale": false, "refreshing": false] }
        await model.chat.readProjects()
        XCTAssertFalse(model.chat.isLoadingProjects)
        XCTAssertEqual(core.callCount("chat.projects.refresh"), 0)
        model.shutdown()
    }

    func testProjectsOutageWarningSurvivesReconnectWithoutAutomaticRefresh() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        core.on("chat.projects") { _ in ["report": NSNull(), "stale": true, "refreshing": false,
                                         "error": "Cloud is unavailable. Showing the saved project report."] }
        let model = model()
        await model.bootstrapIfNeeded()
        let loaded = await eventually { model.phase == .attached && model.chat.projectsError != nil }
        XCTAssertTrue(loaded)
        XCTAssertTrue(model.chat.projects?.stale == true)
        XCTAssertNil(model.chat.projects?.durable)
        await model.chat.readProjects()
        XCTAssertNotNil(model.chat.projectsError)
        XCTAssertEqual(core.callCount("chat.projects.refresh"), 0)
        core.on("chat.projects") { _ in ["durable": true, "report": NSNull(), "stale": false, "refreshing": false] }
        await model.chat.readProjects()
        XCTAssertNil(model.chat.projectsError)
        model.shutdown()
    }

    func testQueuedRefreshChangesPollingTaskIdentityDuringIdleSleep() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached && model.chat.projects != nil }
        let idle = model.chat.projectsPollingState
        XCTAssertEqual(idle.delayNanoseconds, 60_000_000_000)
        core.on("chat.projects.refresh") { _ in ["durable": true, "report": NSNull(), "stale": true, "refreshing": true] }
        model.chat.startProjectsRefresh()
        let queued = await eventually { model.chat.isLoadingProjects }
        XCTAssertTrue(queued)
        XCTAssertNotEqual(model.chat.projectsPollingState, idle)
        XCTAssertEqual(model.chat.projectsPollingState.delayNanoseconds, 5_000_000_000)
        core.on("chat.projects") { _ in ["durable": true, "report": NSNull(), "stale": false, "refreshing": false] }
        await model.chat.readProjects()
        XCTAssertEqual(model.chat.projectsPollingState, idle)
        XCTAssertEqual(core.callCount("chat.projects.refresh"), 1)
        model.shutdown()
    }

    func testLegacyProjectsStillRefreshWhenStaleButDurableModeDoesNot() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached && model.chat.projects != nil }
        core.on("chat.projects.refresh") { _ in ["durable": false, "report": NSNull(), "stale": false, "refreshing": false] }
        core.on("chat.projects") { _ in ["durable": false, "report": NSNull(), "stale": true, "refreshing": false] }
        await model.chat.readProjects()
        let refreshed = await eventually { self.core.callCount("chat.projects.refresh") == 1 }
        XCTAssertTrue(refreshed)
        core.on("chat.projects") { _ in ["durable": true, "report": NSNull(), "stale": true, "refreshing": false] }
        await model.chat.readProjects()
        XCTAssertEqual(core.callCount("chat.projects.refresh"), 1)
        model.shutdown()
    }

    func testProjectsConfigurationFailureStopsPendingIndicator() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached && model.chat.projects != nil }
        core.on("chat.projects") { _ in ["report": NSNull(), "stale": true, "refreshing": true] }
        await model.chat.readProjects()
        core.on("chat.projects") { _ in throw FakeCore.Failure(kind: "cloud_failed", message: "Check service configuration") }
        await model.chat.readProjects()
        XCTAssertFalse(model.chat.isLoadingProjects)
        XCTAssertTrue(model.chat.projectsError?.contains("service configuration") == true)
        model.shutdown()
    }

    func testSkipSendsThroughTheCore() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        core.on("chat.send") { params in
            ["answered": true, "conversation": ["sending": false, "messages": [
                ["id": "1", "role": "user", "content": params["text"] as? String ?? "", "references": [], "actions": []],
                ["id": "2", "role": "assistant", "content": "All clear.", "references": [], "actions": [
                    ["id": "act", "type": "send_message", "agent_id": "codex:a", "message": "Keep going", "receipt": NSNull()],
                ]],
            ]]]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached }
        // The attach-time reads include a conversation read; one that starts
        // after the send would be the latest request and replace its answer.
        await model.connectionRefresh?.value
        model.chat.draft = "What's blocked?"
        await model.chat.send()
        XCTAssertEqual(model.chat.messages.count, 2)
        XCTAssertEqual(model.chat.draft, "")
        XCTAssertEqual(core.lastParams("chat.send")?["text"] as? String, "What's blocked?")
        model.shutdown()
    }

    func testLinksBeforeTheFirstSnapshotWaitForIt() async {
        core.on("links.parse") { _ in
            ["kind": "connect", "site_url": "https://agentrelay.com", "account_id": "a",
             "workspace_id": "0f8fad5b-d9cb-469f-a165-70867728950e"]
        }
        core.on("account.sign_in") { _ in ["state": "pending_approval"] }
        let model = model()
        model.openConnection(URL(string: "agentrelay://connect?x=1")!)
        XCTAssertEqual(core.callCount("links.parse"), 0)
        await model.bootstrapIfNeeded()
        let signedIn = await eventually { self.core.callCount("account.sign_in") == 1 }
        XCTAssertTrue(signedIn)
        XCTAssertEqual(core.lastParams("account.sign_in")?["workspace"] as? String, "0f8fad5b-d9cb-469f-a165-70867728950e")
        model.shutdown()
    }

    func testSigningOutForgetsTeamAccess() async {
        let ready: [String: Any] = [
            "enabled": true, "availability": "ready", "failure": NSNull(), "role": "owner", "grant": NSNull(),
            "pending_seats": [["user_id": "u2", "name": "Bo", "avatar_url": NSNull(), "identity_hash": "h_bo", "role": "member",
                               "joined_at_ms": NSNull()]], "services": [], "grants": [],
            "provisioning": ["grant_id": NSNull(), "failed": false],
        ]
        core.on("contractors.status") { _ in ready }
        core.on("contractors.refresh") { _ in ready }
        core.on("incoming.status") { _ in
            ["state": "connected", "error": NSNull(), "held": [], "can_approve": true, "threads": [
                ["id": "t1", "project": "relay", "title": "Fix tests", "open": true, "shared": true, "mode": "hold",
                 "allows_unrestricted": false],
            ]]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        let loaded = await eventually { model.contractors.pendingSeats.count == 1 && model.incoming.status?.threads.count == 1 }
        XCTAssertTrue(loaded)
        model.contractors.startOnboarding(model.contractors.pendingSeats[0])
        XCTAssertNotNil(model.contractors.flow)
        core.on("contractors.status") { _ in Self.contractors }
        core.on("incoming.status") { _ in ["state": "stopped", "error": NSNull(), "threads": [], "held": [], "can_approve": false] }
        core.setStatus(FakeCore.snapshot(revision: 3, account: ["state": "signed_out"]))
        let forgotten = await eventually {
            model.contractors.flow == nil && !model.contractors.isVisible && (model.incoming.status?.threads.isEmpty ?? true)
        }
        XCTAssertTrue(forgotten)
        model.shutdown()
    }

    func testSigningOutLoadsNoTeamAccess() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached }
        await model.connectionRefresh?.value
        core.on("contractors.status") { _ in
            throw FakeCore.Failure(kind: "not_signed_in", message: "Sign in to Agent Relay first.")
        }
        let loads = core.callCount("contractors.status")
        core.setStatus(FakeCore.snapshot(revision: 3, account: ["state": "signed_out"]))
        let signedOut = await eventually { model.phase == .signedOut }
        XCTAssertTrue(signedOut)
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(core.callCount("contractors.status"), loads)
        XCTAssertNil(model.contractors.error)
        XCTAssertFalse(model.contractors.isVisible)
        model.shutdown()
    }

    func testAConversationReadFromBeforeASendNeverReplacesIt() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        core.on("chat.send") { params in
            ["answered": true, "conversation": ["sending": false, "messages": [
                ["id": "1", "role": "user", "content": params["text"] as? String ?? "", "references": [], "actions": []],
                ["id": "2", "role": "assistant", "content": "All clear.", "references": [], "actions": []],
            ]]]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached }
        await model.connectionRefresh?.value
        // A read that leaves before the send and answers after it.
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("chat.conversation") { _ in
            held.wait()
            return ["messages": [], "sending": false]
        }
        let reads = core.callCount("chat.conversation")
        let read = Task { await model.chat.refresh() }
        let reading = await eventually { self.core.callCount("chat.conversation") == reads + 1 }
        XCTAssertTrue(reading)
        await model.chat.send("What's blocked?")
        XCTAssertEqual(model.chat.messages.count, 2)
        held.signal()
        await read.value
        XCTAssertEqual(model.chat.messages.count, 2)
        model.shutdown()
    }

    func testAConversationReadDuringASendNeverReplacesItsAnswer() async {
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        // The send is held until a read that started after it has answered
        // with the pre-send conversation, as the attach-time reads can.
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("chat.send") { params in
            held.wait()
            return ["answered": true, "conversation": ["sending": false, "messages": [
                ["id": "1", "role": "user", "content": params["text"] as? String ?? "", "references": [], "actions": []],
                ["id": "2", "role": "assistant", "content": "All clear.", "references": [], "actions": []],
            ]]]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .attached }
        await model.connectionRefresh?.value
        let sends = core.callCount("chat.send")
        let send = Task { await model.chat.send("What's blocked?") }
        let sending = await eventually { self.core.callCount("chat.send") == sends + 1 }
        XCTAssertTrue(sending)
        await model.chat.refresh()
        XCTAssertEqual(model.chat.messages.count, 0)
        XCTAssertTrue(model.chat.isSending)
        held.signal()
        await send.value
        XCTAssertEqual(model.chat.messages.count, 2)
        XCTAssertFalse(model.chat.isSending)
        model.shutdown()
    }

    func testASignOutDuringTheConnectionReadsEndsThem() async {
        let ready: [String: Any] = [
            "enabled": true, "availability": "ready", "failure": NSNull(), "role": "owner", "grant": NSNull(),
            "pending_seats": [["user_id": "u2", "name": "Bo", "avatar_url": NSNull(), "identity_hash": "h_bo", "role": "member",
                               "joined_at_ms": NSNull()]], "services": [], "grants": [],
            "provisioning": ["grant_id": NSNull(), "failed": false],
        ]
        core.on("contractors.refresh") { _ in ready }
        // Holds the connection's reads at the chat step until signed out.
        let held = DispatchSemaphore(value: 0)
        core.on("chat.conversation") { _ in
            held.wait()
            return ["messages": [], "sending": false]
        }
        defer { for _ in 0..<4 { held.signal() } }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        let holding = await eventually { self.core.callCount("chat.conversation") == 1 }
        XCTAssertTrue(holding)
        core.setStatus(FakeCore.snapshot(revision: 3, account: ["state": "signed_out"]))
        let signedOut = await eventually { model.phase == .signedOut }
        XCTAssertTrue(signedOut)
        held.signal()
        await model.connectionRefresh?.value
        XCTAssertEqual(core.callCount("contractors.refresh"), 0)
        XCTAssertFalse(model.contractors.isVisible)
        model.shutdown()
    }

    // MARK: Changes shown before the core confirms them

    func testTheUploadPolicyMovesAtOnceAndFallsBackWhenTheChangeFails() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("uploader.sharing.set") { _ in
            gate.wait()
            throw FakeCore.Failure(kind: "unavailable", message: "The uploader is restarting.")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { model.status != nil }
        XCTAssertEqual(model.sharingMode, .new)
        let change = Task { await model.setSharingMode(.all) }
        let moved = await eventually { model.sharingMode == .all && model.isChangingSharingMode }
        XCTAssertTrue(moved)
        XCTAssertTrue(model.isSessionTableReadOnly, "the table follows the policy asked for")
        gate.signal()
        await change.value
        XCTAssertEqual(model.sharingMode, .new)
        XCTAssertFalse(model.isChangingSharingMode)
        XCTAssertEqual(model.sessionActionError, "The uploader is restarting.")
    }

    func testPausingShowsAtOnceAndTheLastClickWins() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        let paused = Locked(false)
        core.on("uploader.pause") { _ in gate.wait(); paused.value = true; return ["paused": true] }
        core.on("uploader.resume") { _ in paused.value = false; return ["paused": false] }
        core.on("uploader.status") { _ in
            ["running": true, "paused": paused.value, "sharing_mode": "new", "directory": "/tmp/install",
             "collector_replacing": false, "collector_outdated": false,
             "delivery": ["bootstrap_complete": true, "pending_records": 0, "acknowledged_records": 4, "quarantined_records": 0, "skipped_records": 0,
                          "unqueued_changes": 0, "last_acknowledged_ms": NSNull(), "failure": NSNull(), "stopped": false],
             "sessions": ["total": 2, "shared": 1, "excluded": 1], "stage": paused.value ? "paused" : "up_to_date", "stage_message": NSNull(),
             "needs_start": false, "journal_full": false, "upgrading": false, "stalled": false]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { model.status != nil }
        XCTAssertFalse(model.isPaused)
        let pause = Task { await model.setPaused(true) }
        let shown = await eventually { model.isPaused }
        XCTAssertTrue(shown, "paused from the click")
        XCTAssertTrue(model.canTogglePause, "the button stays usable for a later click")
        // Resume clicked while the pause is still on its way: it is sent
        // once the pause has answered, and the window shows resumed.
        await model.setPaused(false)
        XCTAssertFalse(model.isPaused)
        gate.signal()
        await pause.value
        let resumed = await eventually { self.core.callCount("uploader.resume") == 1 && !model.isPaused }
        XCTAssertTrue(resumed)
        XCTAssertFalse(paused.value)
    }

    func testASettingHoldsTheChangeUntilTheCoreAnswersAndFallsBackOnFailure() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("settings.set") { _ in
            gate.wait()
            throw FakeCore.Failure(kind: "io", message: "The settings file is read-only.")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { model.settings != nil }
        XCTAssertTrue(model.analyticsEnabled)
        let change = Task { await model.setSetting(SettingsChange(analyticsEnabled: false)) }
        let held = await eventually { !model.analyticsEnabled && model.isSettingPending("analytics_enabled") }
        XCTAssertTrue(held, "the switch holds the position asked for")
        XCTAssertFalse(model.isSettingPending("allow_self_registration"))
        gate.signal()
        let failure = await change.value
        XCTAssertEqual(failure, "The settings file is read-only.")
        XCTAssertTrue(model.analyticsEnabled, "a failed change falls back to the core's value")
        XCTAssertFalse(model.isSettingPending("analytics_enabled"))
        XCTAssertEqual(model.settingErrors["analytics_enabled"], "The settings file is read-only.")
        // Changing it again clears the row's error and succeeds.
        core.on("settings.set") { params in Self.settings(analytics: params["analytics_enabled"] as? Bool ?? true) }
        let retried = await model.setSetting(SettingsChange(analyticsEnabled: false))
        XCTAssertNil(retried)
        XCTAssertFalse(model.analyticsEnabled)
        XCTAssertNil(model.settingErrors["analytics_enabled"])
    }

    func testAnOlderSettingsWriteIsKeptWhenANewerOneFails() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("settings.set") { params in
            if params["analytics_enabled"] != nil {
                gate.wait()
                return Self.settings(analytics: false)
            }
            throw FakeCore.Failure(kind: "io", message: "The settings file is read-only.")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { model.settings != nil }
        let first = Task { await model.setSetting(SettingsChange(analyticsEnabled: false)) }
        _ = await eventually { model.isSettingPending("analytics_enabled") }
        // A newer change fails while the first is still on its way.
        let failure = await model.setSetting(SettingsChange(allowSelfRegistration: false))
        XCTAssertNotNil(failure)
        XCTAssertEqual(model.settings?.allowSelfRegistration, true)
        XCTAssertFalse(model.analyticsEnabled, "the first change still shows")
        gate.signal()
        let firstOutcome = await first.value
        XCTAssertNil(firstOutcome)
        XCTAssertFalse(model.analyticsEnabled, "the first change's answer is kept although a newer one started")
        XCTAssertFalse(model.isSettingPending("analytics_enabled"))
    }

    func testARenameShowsTheNewNameAtOnceAndTheOldOneAgainWhenItFails() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Fix tests", "live": true,
                           "registration": ["name": "fix-tests", "address": "fix-tests@mac", "added_by_session": false],
                           "suggested_name": "fix-tests"]]]
        }
        core.on("agents.list") { _ in
            ["agents": [["name": "fix-tests", "address": "fix-tests@mac", "target": ["kind": "codex", "id": "a"], "title": "Fix tests",
                         "registered_at": "2026-10-10T12:00:00Z", "added_by_session": false, "reply_with_final_answer": NSNull(),
                         "webhook": NSNull(), "integrations": [], "push": NSNull(), "delivery_error": NSNull()]], "archived": []]
        }
        core.on("agents.rename") { _ in
            gate.wait()
            throw FakeCore.Failure(kind: "conflict", message: "That name is taken.")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let ready = await eventually { model.relay.agents.count == 1 && model.relay.sessions.first?.registration != nil }
        guard ready else { XCTFail("the agent did not load"); return }
        let agent = model.relay.agents[0]
        let rename = Task { await model.relay.rename(agent, to: "helper") }
        let shown = await eventually { model.relay.agents.first?.displayName == "helper" }
        XCTAssertTrue(shown, "the new name from the click")
        XCTAssertEqual(model.relay.sessions.first?.registration?.displayName, "helper")
        gate.signal()
        let outcome = await rename.value
        XCTAssertEqual(outcome, .failed("That name is taken."))
        XCTAssertEqual(model.relay.agents.first?.displayName, "fix-tests")
        XCTAssertEqual(model.relay.sessions.first?.registration?.displayName, "fix-tests")
    }

    func testAnExplicitRegistrationShowsTheSessionOnTheRelayAtOnce() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("agents.register") { _ in
            gate.wait()
            throw FakeCore.Failure(kind: "conflict", message: "Name already taken")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { !model.relay.sessions.isEmpty }
        let session = model.relay.sessions[0]
        XCTAssertNil(session.registration)
        let registration = Task { await model.relay.register(session, as: "helper") }
        let shown = await eventually { model.relay.sessions.first?.registration?.name == "helper" }
        XCTAssertTrue(shown, "on the relay under the name from the click")
        XCTAssertTrue(model.relay.presence(of: model.relay.sessions[0]).isOn)
        gate.signal()
        await registration.value
        XCTAssertNil(model.relay.sessions.first?.registration)
        XCTAssertEqual(model.relay.errors[session.id], "Name already taken")
    }

    func testASentMessageShowsAsOnItsWayUntilTheHistoryListsIt() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        let sent = Locked(false)
        core.on("roster.get") { _ in Self.recipient("live", message: nil) }
        core.on("messages.send") { params in
            gate.wait()
            sent.value = true
            return ["message_id": "m1", "conversation_id": "c1", "to": params["to"] ?? NSNull(),
                    "recipient": Self.recipient("live", message: "queued")]
        }
        core.on("messages.history") { _ in
            ["identity": "ada", "messages": sent.value
                ? [["id": "m1", "sender": "ada", "sender_id": NSNull(), "sender_address": NSNull(), "text": "status?",
                    "created_at": NSNull(), "thread_id": NSNull(), "mine": true]]
                : []]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        let relay = model.relay
        relay.openComposer("@bot")
        await relay.loadConversation("@bot")
        let send = Task { await relay.sendMessage(to: "@bot", text: "status?") }
        let echoed = await eventually { relay.shownHistory(at: "@bot")?.messages.count == 1 }
        XCTAssertTrue(echoed)
        let echo = relay.shownHistory(at: "@bot")?.messages.first
        XCTAssertEqual(echo?.text, "status?")
        XCTAssertEqual(echo.map(PendingMessages.isPending), true)
        gate.signal()
        let sendError = await send.value
        XCTAssertNil(sendError)
        let listed = relay.shownHistory(at: "@bot")?.messages ?? []
        XCTAssertEqual(listed.map(\.id), ["m1"], "the history's own message replaces the echo")

        // A failed send shows nothing as on its way.
        core.on("messages.send") { _ in throw FakeCore.Failure(kind: "unavailable", message: "Relaycast is unreachable.") }
        let refused = await relay.sendMessage(to: "@bot", text: "again")
        XCTAssertEqual(refused, "Relaycast is unreachable.")
        XCTAssertEqual(relay.shownHistory(at: "@bot")?.messages.map(\.id), ["m1"])
    }

    func testAnApprovalRemovesTheHeldMessageAtOnceAndBringsItBackWhenRefused() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("incoming.status") { _ in
            ["state": "connected", "error": NSNull(), "can_approve": true, "threads": [],
             "held": [["id": "m1", "thread_id": "t1", "text": "hi", "sender_name": "Bo", "enqueued_at_ms": 1, "expires_at_ms": 2]]]
        }
        core.on("incoming.approve") { _ in gate.wait(); return ["approved": false] }
        let model = model()
        await model.incoming.refresh()
        XCTAssertEqual(model.incoming.status?.held.count, 1)
        let approval = Task { await model.incoming.approve("m1") }
        let gone = await eventually { model.incoming.status?.held.isEmpty == true }
        XCTAssertTrue(gone, "the message leaves the list from the click")
        gate.signal()
        await approval.value
        XCTAssertEqual(model.incoming.status?.held.count, 1)
        XCTAssertNotNil(model.incoming.error)
    }

    func testClaudeDeliveryChangesShowAtOnceAndFallBackWhenTheyFail() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("claude_delivery.restrict") { _ in
            gate.wait()
            throw FakeCore.Failure(kind: "io", message: "Could not save.")
        }
        let model = model()
        await model.claudeDelivery.refresh()
        XCTAssertEqual(model.claudeDelivery.status?.restricted, true)
        let change = Task { await model.claudeDelivery.restrict(false) }
        let shown = await eventually { model.claudeDelivery.status?.restricted == false }
        XCTAssertTrue(shown)
        gate.signal()
        await change.value
        XCTAssertEqual(model.claudeDelivery.status?.restricted, true)
        XCTAssertEqual(model.claudeDelivery.error, "Could not save.")
        await model.claudeDelivery.refresh()
        XCTAssertNil(model.claudeDelivery.error, "a later explicit successful read clears the action failure")
        // Always allow: the sender joins the list and the message leaves it at once.
        let heldGate = DispatchSemaphore(value: 0)
        defer { heldGate.signal() }
        core.on("claude_delivery.sender") { _ in heldGate.wait(); return [:] }
        guard let message = model.claudeDelivery.status?.held.first else { XCTFail("no held message"); return }
        let allow = Task { await model.claudeDelivery.alwaysAllow(message) }
        let allowed = await eventually {
            model.claudeDelivery.status?.held.isEmpty == true
                && model.claudeDelivery.status?.allowedSenders.map(\.address) == ["ada@desk", "bo@desk"]
        }
        XCTAssertTrue(allowed)
        heldGate.signal()
        await allow.value
    }

    func testClaudeDeliveryActionErrorSurvivesAFailedReconciliationRead() async {
        let model = model()
        await model.claudeDelivery.refresh()
        core.on("claude_delivery.restrict") { _ in
            throw FakeCore.Failure(kind: "io", message: "Could not save.")
        }
        core.on("claude_delivery.status") { _ in
            throw FakeCore.Failure(kind: "io", message: "Could not read choices.")
        }
        await model.claudeDelivery.restrict(false)
        XCTAssertEqual(model.claudeDelivery.status?.restricted, true, "the failed optimistic change rolls back")
        XCTAssertEqual(model.claudeDelivery.error, "Could not save.", "reconciliation keeps the action's failure")
        await model.claudeDelivery.refresh()
        XCTAssertEqual(model.claudeDelivery.error, "Could not read choices.", "an explicit read reports its own failure")
    }

    func testADismissedSeatLeavesAtOnceAndReturnsWhenTheDismissalFails() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("contractors.dismiss") { _ in
            gate.wait()
            throw FakeCore.Failure(kind: "unavailable", message: "Cloud is unreachable.")
        }
        core.on("contractors.status") { _ in
            ["enabled": true, "availability": "ready", "failure": NSNull(), "role": "owner", "grant": NSNull(),
             "pending_seats": [["user_id": "u2", "name": "Bo", "avatar_url": NSNull(), "identity_hash": "h_bo", "role": "member",
                                "joined_at_ms": NSNull()]], "services": [], "grants": [],
             "provisioning": ["grant_id": NSNull(), "failed": false]]
        }
        let model = model()
        await model.contractors.load()
        guard let seat = model.contractors.pendingSeats.first else { XCTFail("no pending seat"); return }
        model.contractors.dismiss(seat)
        XCTAssertTrue(model.contractors.pendingSeats.isEmpty, "the seat's row goes from the click")
        gate.signal()
        let back = await eventually { model.contractors.pendingSeats == [seat] }
        XCTAssertTrue(back)
        XCTAssertEqual(model.contractors.error, "Cloud is unreachable.")
    }

    func testLoggingOutShowsTheAccountLeavingUntilTheSnapshotNoLongerShowsIt() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("account.sign_out") { [core] _ in
            gate.wait()
            core!.setStatus(FakeCore.snapshot(revision: 3, account: ["state": "signed_out"]))
            return [:]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { model.phase == .attached }
        XCTAssertTrue(model.canLogOut)
        let logOut = Task { await model.disconnect() }
        let leaving = await eventually { model.signingOut }
        XCTAssertTrue(leaving)
        XCTAssertFalse(model.canLogOut, "no second log-out while one runs")
        gate.signal()
        await logOut.value
        let gone = await eventually { model.phase == .signedOut && !model.signingOut }
        XCTAssertTrue(gone)
    }

    func testSigningInStartsOnceUntilTheSnapshotShowsTheAttempt() async {
        let gate = DispatchSemaphore(value: 0)
        defer { gate.signal() }
        core.on("account.sign_in") { [core] _ in
            gate.wait()
            core!.setStatus(FakeCore.snapshot(revision: 5, account: ["state": "pending_approval", "phase": "waiting_for_browser"]))
            return ["state": "pending_approval", "phase": "waiting_for_browser",
                    "verification_url": "https://agentrelay.com/login", "verification_url_complete": "https://agentrelay.com/login?s=1"]
        }
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { model.phase == .signedOut }
        model.signIn()
        XCTAssertTrue(model.startingSignIn)
        model.signIn()
        gate.signal()
        let asked = await eventually { model.phase == .waitingForBrowser && !model.startingSignIn }
        XCTAssertTrue(asked)
        XCTAssertEqual(core.callCount("account.sign_in"), 1, "a second click while the first starts sends nothing")
    }

    func testARefusedApprovalIsShown() async {
        core.on("incoming.approve") { _ in ["approved": false] }
        let model = model()
        await model.incoming.approve("m1")
        XCTAssertNotNil(model.incoming.error)
        core.on("incoming.approve") { _ in ["approved": true] }
        await model.incoming.approve("m1")
        XCTAssertNil(model.incoming.error)
    }

    func testConfirmedCloudDeleteStillRunsAfterHideExcludesUpload() async {
        let included = Locked(true)
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "selected", "sessions": [["source": "codex", "session_id": "a", "title": "Fix tests", "is_agent": false, "included": included.value, "status": included.value ? "shared" : "not_shared"]]]
        }
        core.on("uploader.sessions.exclude") { _ in included.value = false; return ["updated": 1] }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        _ = await eventually { !model.sessions.isEmpty }
        await model.setSessionsHidden(keys: ["codex:a"], hidden: true)
        XCTAssertEqual(core.callCount("uploader.sessions.exclude"), 1)
        XCTAssertFalse(model.sessions.first { $0.id == "codex:a" }?.included ?? true)
        XCTAssertEqual(core.callCount("uploader.sessions.delete"), 0, "Hide only excludes uploads")
        await model.excludeSessions(keys: ["codex:a"])
        XCTAssertEqual(core.callCount("uploader.sessions.delete"), 1, "Confirmed deletion must remove the Cloud copy even after Hide excluded uploads")
    }

    func testUploadTogglesAreIndependentAndLatestClickWins() async {
        let included = Locked(Set(["codex:a"]))
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "selected", "sessions": ["codex:a", "claude:b"].map { key in
                ["source": String(key.split(separator: ":")[0]), "session_id": String(key.split(separator: ":")[1]),
                 "title": key, "is_agent": false, "included": included.value.contains(key),
                 "status": included.value.contains(key) ? "shared" : "not_shared"] as [String: Any]
            }]
        }
        core.on("uploader.sessions.delete") { params in
            held.wait()
            included.value = included.value.subtracting(params["session_keys"] as? [String] ?? [])
            return ["updated": 1]
        }
        core.on("uploader.sessions.include") { params in
            included.value = included.value.union(params["session_keys"] as? [String] ?? [])
            return ["updated": 1]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.sessions.count == 2 }
        let off = Task { await model.excludeSessions(keys: ["codex:a"]) }
        let started = await eventually { self.core.callCount("uploader.sessions.delete") == 1 }
        XCTAssertTrue(started)
        XCTAssertTrue(model.stoppingUploads.contains("codex:a"))
        XCTAssertFalse(model.isWorking)
        XCTAssertTrue(model.canSelectSession(model.sessions[1]))
        let second = Task { await model.includeSessions(keys: ["claude:b"]) }
        let independent = await eventually { self.core.callCount("uploader.sessions.include") == 1 }
        XCTAssertTrue(independent, "Another row must reach the core while the first request is held")
        let on = Task { await model.includeSessions(keys: ["codex:a"]) }
        _ = await eventually { model.requestingUploads.contains("codex:a") }
        XCTAssertFalse(model.stoppingUploads.contains("codex:a"))
        XCTAssertEqual(core.callCount("uploader.sessions.include"), 1, "The same row must serialize opposite requests")
        held.signal()
        await off.value
        _ = await on.value
        _ = await second.value
        XCTAssertEqual(included.value, Set(["codex:a", "claude:b"]))
        XCTAssertTrue(model.sessions.allSatisfy(\.included))
        XCTAssertTrue(model.requestingUploads.isEmpty)
        XCTAssertTrue(model.stoppingUploads.isEmpty)
        XCTAssertTrue(model.uploadErrors.isEmpty)
        model.shutdown()
    }

    func testFailedOptimisticUploadRollsBackOnlyThatRow() async {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("uploader.sessions.include") { _ in
            held.wait()
            throw FakeCore.Failure(kind: "unavailable", message: "Upload service unavailable")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.sessions.count == 2 }
        let change = Task { await model.includeSessions(keys: ["claude:b"]) }
        _ = await eventually { model.requestingUploads.contains("claude:b") }
        XCTAssertFalse(model.isWorking)
        held.signal()
        let accepted = await change.value
        XCTAssertFalse(accepted)
        XCTAssertFalse(model.sessions.first { $0.id == "claude:b" }!.included)
        XCTAssertTrue(model.sessions.first { $0.id == "codex:a" }!.included)
        XCTAssertEqual(model.uploadErrors["claude:b"], "Upload service unavailable")
        XCTAssertTrue(model.requestingUploads.isEmpty)
        model.shutdown()
    }

    func testReenableReconcilesAnUncertainCloudDeletion() async {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("uploader.sessions.delete") { _ in
            held.wait()
            throw FakeCore.Failure(kind: "unavailable", message: "Deletion reply lost")
        }
        core.on("uploader.sessions.include") { _ in ["updated": 1] }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.sessions.count == 2 }
        let off = Task { await model.excludeSessions(keys: ["codex:a"]) }
        _ = await eventually { self.core.callCount("uploader.sessions.delete") == 1 }
        let on = Task { await model.includeSessions(keys: ["codex:a"]) }
        _ = await eventually { model.requestingUploads.contains("codex:a") }
        held.signal()
        await off.value
        _ = await on.value
        XCTAssertEqual(core.callCount("uploader.sessions.include"), 1, "The server may have deleted the copy even though local state still says included")
        XCTAssertTrue(model.uploadErrors.isEmpty)
        model.shutdown()
    }

    func testCloudDeletionFailureAndStaleConfirmationDoNotChangeSelection() async {
        core.on("uploader.sessions.delete") { _ in
            throw FakeCore.Failure(kind: "unavailable", message: "Cloud deletion unavailable")
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.sessions.count == 2 }
        await model.excludeSessions(keys: ["codex:a"], confirmedAt: model.uploadConnectionRevision - 1)
        XCTAssertEqual(core.callCount("uploader.sessions.delete"), 0, "An old workspace's confirmation must not delete this workspace's copy")
        await model.excludeSessions(keys: ["codex:a"], confirmedAt: model.uploadConnectionRevision)
        XCTAssertEqual(core.callCount("uploader.sessions.delete"), 1)
        XCTAssertEqual(core.callCount("uploader.sessions.exclude"), 0, "Deletion cannot silently fall back to stop-only")
        XCTAssertTrue(model.sessions.first { $0.id == "codex:a" }!.included)
        XCTAssertEqual(model.uploadErrors["codex:a"], "Cloud deletion unavailable")
        XCTAssertTrue(model.stoppingUploads.isEmpty)
        XCTAssertFalse(model.isWorking)
        model.shutdown()
    }

    func testClaudeDeliveryChoicesUseTheCorePolicy() async {
        let model = model()
        await model.claudeDelivery.refresh()
        XCTAssertEqual(model.claudeDelivery.status?.held.first?.senderName, "Bo")
        await model.claudeDelivery.restrict(false)
        XCTAssertEqual(core.lastParams("claude_delivery.restrict")?["restricted"] as? Bool, false)
        await model.claudeDelivery.setSession("c-1", direct: true)
        XCTAssertEqual(core.lastParams("claude_delivery.session")?["session_id"] as? String, "c-1")
        await model.claudeDelivery.alwaysAllow(model.claudeDelivery.status!.held[0])
        XCTAssertEqual(core.lastParams("claude_delivery.sender")?["sender"] as? String, "bo@desk")
        XCTAssertEqual(core.lastParams("claude_delivery.approve")?["id"] as? String, "del-1")
    }

    func testSpawnClaimRetryAsksTheCoreAgain() async {
        core.on("spawn.claim.retry") { _ in [:] }
        let model = model()
        await model.retrySpawnClaim()
        XCTAssertNotNil(core.lastParams("spawn.claim.retry"))
        XCTAssertNil(model.lastError)
    }

    func testTheTeammatesToggleSendsItsValueExplicitly() async {
        let model = model()
        _ = await model.setSetting(SettingsChange(spawnAllowTeammates: false))
        XCTAssertEqual(core.lastParams("settings.set")?["spawn_allow_teammates"] as? Bool, false)
        _ = await model.setSetting(SettingsChange(spawnAllowTeammates: true))
        XCTAssertEqual(core.lastParams("settings.set")?["spawn_allow_teammates"] as? Bool, true)
    }

    func testClaudeDeliveryRefreshClearsAnEarlierError() async {
        let model = model()
        core.on("claude_delivery.status") { _ in
            throw FakeCore.Failure(kind: "store_failed", message: "Could not read choices.")
        }
        await model.claudeDelivery.refresh()
        XCTAssertNotNil(model.claudeDelivery.error)

        core.on("claude_delivery.status") { _ in
            ["restricted": false, "sessions": [], "allowed_senders": [], "held": []]
        }
        await model.claudeDelivery.refresh()
        XCTAssertNil(model.claudeDelivery.error)
        XCTAssertEqual(model.claudeDelivery.status?.restricted, false)
    }

    func testUploadActionsRefuseWhenTheyCannotRun() async {
        let model = model()
        await model.bootstrapIfNeeded()
        _ = await eventually { model.phase == .signedOut }
        let included = await model.includeSessions(keys: ["codex:a"])
        XCTAssertFalse(included)
        XCTAssertNotNil(model.sessionActionError)
        XCTAssertEqual(core.callCount("uploader.sessions.include"), 0)
        model.shutdown()
    }
}

/// A value a fake core handler reads while the test changes it.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
