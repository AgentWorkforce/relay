import AppKit
import SwiftUI
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor
final class SettingsLayoutTests: XCTestCase {
    func testClaudeMessageApprovalsStartCollapsed() {
        let delivery = ClaudeDeliveryModel(client: CoreClient(socketPath: "/unused"))
        let host = NSHostingView(rootView: ClaudeDeliverySettings(delivery: delivery).frame(width: 900))
        // Only the disclosure heading occupies space until the person expands it.
        XCTAssertLessThan(host.fittingSize.height, 60)
    }

    func testUploadedWorkspaceAvatarUsesBoundedRasterData() {
        let image = URL(string: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
        XCTAssertNotNil(PersonAvatar.inlineImage(image))
        XCTAssertNil(PersonAvatar.inlineImage(URL(string: "data:image/svg+xml;base64,PHN2Zz4=")))
        XCTAssertNil(PersonAvatar.inlineImage(URL(string: "data:image/png;base64,invalid!")))
    }

    func testEverySettingsDestinationHasOneTaskGroup() {
        let groups = SettingsPane.groups
        XCTAssertEqual(groups.first { $0.title == "Preferences" }?.panes, [.general])
        let panes = groups.flatMap(\.panes)
        XCTAssertEqual(Set(panes), Set(SettingsPane.allCases))
        XCTAssertEqual(panes.count, Set(panes).count)
        XCTAssertEqual(groups.first { $0.title == "Sessions" }?.panes, [.opening, .sharing, .relay])
        XCTAssertEqual(groups.first { $0.title == "Account & app" }?.panes, [.account, .about, .diagnostics])
    }

    func testSettingsTextContrastInBothAppearances() throws {
        func luminance(_ color: Color, _ appearance: NSAppearance) -> Double {
            var value = 0.0
            appearance.performAsCurrentDrawingAppearance {
                let rgb = NSColor(color).usingColorSpace(.sRGB)!
                func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
                value = 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
            }
            return value
        }
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let appearance = try XCTUnwrap(NSAppearance(named: name))
            for (foreground, background, minimum) in [(AgentRelayButtonTheme.foreground, AgentRelayButtonTheme.background, 4.5),
                                                      (AgentRelayButtonTheme.foreground, AgentRelayButtonTheme.hover, 4.5),
                                                      (CloudTheme.secondary, CloudTheme.card, 7.0),
                                                      (CloudTheme.settingsDanger, CloudTheme.background, 7.0)] {
                let a = luminance(foreground, appearance), b = luminance(background, appearance)
                XCTAssertGreaterThanOrEqual((max(a, b) + 0.05) / (min(a, b) + 0.05), minimum, "\(name)")
            }
        }
    }

    /// Opt-in native renders for visual review, using a fake socket and no system services.
    func testSettingsFitNarrowAndWideWindows() async throws {
        let core = FakeCore()
        var account = FakeCore.signedIn
        account["workspace_name"] = "Agent Relay"
        account["workspace_count"] = 2
        account["person"] = ["id": "user_1", "name": "Alex Morgan", "email": "alex.morgan@example.com", "avatar_url": NSNull()]
        core.setStatus(FakeCore.snapshot(revision: 2, account: account))
        let suite = "settings-layout-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        let model = AppModel(client: CoreClient(socketPath: core.path), service: FakeService(status: .enabled),
                             bundledCoreVersion: "1.0.0", manageSystemServices: false, defaults: defaults)
        core.on("settings.get") { _ in AppModelTests.settings(analytics: true) }
        core.on("settings.set") { params in AppModelTests.settings(analytics: params["analytics_enabled"] as? Bool ?? true) }
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
        core.on("chat.conversation") { _ in ["messages": [], "sending": false] }
        core.on("chat.projects") { _ in ["report": NSNull(), "stale": false, "refreshing": false] }
        core.on("contractors.status") { _ in AppModelTests.contractors }
        core.on("contractors.refresh") { _ in AppModelTests.contractors }
        core.on("uploader.sessions.include") { params in ["updated": (params["session_keys"] as? [String])?.count ?? 0] }
        core.on("uploader.pause") { _ in ["paused": true] }
        core.on("uploader.sharing.set") { params in ["sharing_mode": params["mode"] ?? "new"] }
        defaults.set(Date(), forKey: "lastAppUpdateCheck")
        defaults.set(try JSONEncoder().encode(AppRelease(version: "2026.10.12", downloadURL: URL(string: "https://example.com/update")!, checksumURL: URL(string: "https://example.com/checksum")!)), forKey: "cachedAppUpdateRelease")
        let updater = AppUpdater(defaults: defaults, currentVersion: "2026.10.11", terminate: {})
        await model.bootstrapIfNeeded()
        for _ in 0..<100 where model.phase != .attached { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(model.phase, .attached)
        for count in [0, 1, 2] {
            account["workspace_count"] = count
            core.setStatus(FakeCore.snapshot(revision: count + 10, account: account))
            // Account metadata arrives on the status event stream, independently
            // of uploader.status. Wait for that snapshot before checking the menu.
            for _ in 0..<100 where model.account.workspaceCount != count {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(model.account.workspaceCount, count)
            XCTAssertEqual(model.hasMultipleWorkspaces, count > 1)
        }
        defer { model.shutdown(); core.stop(); defaults.removePersistentDomain(forName: suite) }
        for dark in [true, false] {
            for width in [900.0, 1200.0] {
                for page in [SettingsPane.account, .general, .about, .diagnostics, .sharing, .relay, .opening].map(DesktopPage.settings) + [.sessions] {
                    model.page = page
                    let name = { if case .settings(let pane) = page { return pane.rawValue }; return "sessions" }()
                    let view = WorkspaceShell(relay: model.relay, updater: updater, confirmUpdate: {}) {
                        if case .settings(let pane) = page {
                            SettingsPaneView(pane: pane, updater: updater)
                        } else {
                            LocalSessionsView(relay: model.relay)
                        }
                    }
                    .environmentObject(model)
                    .background(CloudTheme.background)
                    .preferredColorScheme(dark ? .dark : .light)
                    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 780),
                                          styleMask: [.titled], backing: .buffered, defer: false)
                    window.isReleasedWhenClosed = false
                    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                    let host = NSHostingView(rootView: view)
                    window.contentView = host
                    window.orderFront(nil)
                    try await Task.sleep(for: .milliseconds(80))
                    host.layoutSubtreeIfNeeded()
                    XCTAssertEqual(host.bounds.width, width, accuracy: 1, "\(name) expands the window")
                    func checkScroll(_ view: NSView) {
                        if let scroll = view as? NSScrollView, let document = scroll.documentView,
                           !(page == .sessions && scroll.hasHorizontalScroller) {
                            XCTAssertLessThanOrEqual(document.frame.width, scroll.contentSize.width + 1, "\(name) horizontal overflow")
                        }
                        view.subviews.forEach(checkScroll)
                    }
                    checkScroll(host)
                    if let directory = ProcessInfo.processInfo.environment["SETTINGS_RENDER_DIR"] {
                        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                        host.cacheDisplay(in: host.bounds, to: bitmap)
                        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        try data.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light")-\(Int(width)).png"))
                    }
                    window.close()
                }
            }
        }
    }
}
