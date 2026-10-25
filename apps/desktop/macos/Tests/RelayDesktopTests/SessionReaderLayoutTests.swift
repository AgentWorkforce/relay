import AppKit
import SwiftUI
import XCTest
import Vision
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor
final class SessionReaderLayoutTests: XCTestCase {
    func testSettingsBackButtonMatchesSessionHeaderPosition() async throws {
        let core = FakeCore()
        defer { core.stop() }
        let suite = "settings-back-layout-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(client: CoreClient(socketPath: core.path), service: FakeService(status: .enabled),
                             manageSystemServices: false, defaults: defaults)
        let updater = AppUpdater(defaults: defaults, currentVersion: "1.0.0", terminate: {})
        let row = LocalSessionRow.merge(uploads: [Fixture.uploadSession(sessionId: "reader", title: "Read a session")], sessions: [])[0]
        for width in [900.0, 1200.0] {
            var positions: [CGRect] = []
            for page in [DesktopPage.sessions, .settings(.general)] {
                model.page = page
                // Settings can be opened while a transcript is still selected.
                model.selectedLocalSession = row
                let host = NSHostingView(rootView: WorkspaceShell(relay: model.relay, updater: updater, confirmUpdate: {}) {
                    Color.clear
                }.environmentObject(model))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 650),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                defer { window.close() }
                host.frame = NSRect(x: 0, y: 0, width: width, height: 650)
                try await Task.sleep(for: .milliseconds(150))
                host.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.recognitionLanguages = ["en-US"]
                try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
                let matches = (request.results ?? []).filter {
                    $0.topCandidates(1).first?.string.contains("Back to sessions") == true
                }
                XCTAssertEqual(matches.count, 1, "Show exactly one back button")
                let match = try XCTUnwrap(matches.first)
                let candidate = try XCTUnwrap(match.topCandidates(1).first)
                let range = try XCTUnwrap(candidate.string.range(of: "Back to sessions"))
                positions.append(try XCTUnwrap(candidate.boundingBox(for: range)).boundingBox)
            }
            XCTAssertGreaterThan(positions[1].minY, 0.9, "Settings back belongs in the global header")
            XCTAssertEqual(positions[0].minX * width, positions[1].minX * width, accuracy: 2)
            XCTAssertEqual(positions[0].midY * 650, positions[1].midY * 650, accuracy: 2)
        }
    }

    func testTitleUsesSharedHeaderAndActionsUseRightPane() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.transcript") { _ in ["entries": [[
            "id": "message", "role": "assistant", "kind": "text", "text": "The session is ready to read.",
            "timestamp_ms": 1, "truncated": false]], "next_cursor": NSNull()] as [String: Any] }
        core.on("sessions.list") { _ in ["sessions": [["target": ["kind": "codex", "id": "reader"], "title": "Redesign settings page", "live": true,
            "registration": ["name": "session-helper", "address": "session-helper@desk", "added_by_session": false], "suggested_name": "session-helper"]]] }
        core.on("agents.list") { _ in ["agents": [["name": "session-helper", "address": "session-helper@desk", "added_by_session": false,
            "integrations": [], "registered_at": "2026-10-01T00:00:00Z", "title": "Redesign settings page", "target": ["kind": "codex", "id": "reader"]]], "archived": []] }
        let suite = "session-reader-layout-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(client: CoreClient(socketPath: core.path), service: FakeService(status: .enabled),
                             manageSystemServices: false, defaults: defaults)
        await model.relay.refresh(.sessions)
        await model.relay.refresh(.agents)
        XCTAssertEqual(model.relay.agents.count, 1)
        let row = LocalSessionRow.merge(uploads: [Fixture.uploadSession(sessionId: "reader", title: "Redesign settings page", cwd: "/work/cloud")], sessions: model.relay.sessions)[0]
        let updater = AppUpdater(defaults: defaults, currentVersion: "1.0.0", terminate: {})
        model.page = .sessions
        model.selectedLocalSession = row
        for (dark, messagingEnabled) in [(false, true), (true, true), (false, false)] {
            if !messagingEnabled {
                core.on("sessions.list") { _ in ["sessions": []] }
                core.on("agents.list") { _ in ["agents": [], "archived": []] }
                await model.relay.refresh(.sessions)
                await model.relay.refresh(.agents)
            }
            let host = NSHostingView(rootView: WorkspaceShell(relay: model.relay, updater: updater, confirmUpdate: {}) {
                LocalSessionsView(relay: model.relay)
            }.environmentObject(model).environment(\.colorScheme, dark ? .dark : .light))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 650),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = host
            defer { window.close() }
            host.frame = NSRect(x: 0, y: 0, width: 980, height: 650)
            try await Task.sleep(nanoseconds: 150_000_000)
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
            let words = (request.results ?? []).compactMap { observation -> (String, CGRect)? in
                guard let text = observation.topCandidates(1).first?.string else { return nil }
                return (text, observation.boundingBox)
            }
            let titles = words.filter { $0.0.contains(row.title) }
            XCTAssertEqual(titles.count, 1, "Render the session title once")
            let title = try XCTUnwrap(titles.first)
            let refresh = try XCTUnwrap(words.first { $0.0.contains("Refresh transcript") })
            let back = try XCTUnwrap(words.first { $0.0.contains("Back to sessions") })
            // Vision uses normalized coordinates with the origin at the bottom left.
            XCTAssertGreaterThan(title.1.minY, 0.9, "Title belongs in the 64-point shared header")
            XCTAssertGreaterThan(refresh.1.minX, 0.74, "Refresh belongs in the 250-point right pane")
            XCTAssertGreaterThan(back.1.minY, 0.9, "Back belongs in the shared header")
            XCTAssertLessThan(back.1.maxX, title.1.minX, "Back precedes the session icon and title")
            XCTAssertGreaterThan(back.1.minX, 0.15, "Back follows the wordmark")
            XCTAssertTrue(words.contains { $0.0 == "Messaging" })
            if !messagingEnabled {
                XCTAssertFalse(words.contains { $0.1.minY < 0.9 && ($0.0.contains("Agent name") || $0.0.contains("Rename") || $0.0.contains("Enable messages to set")) }, "Hide the entire name section when messaging is disabled")
                continue
            }
            let rename = try XCTUnwrap(words.first { $0.0.contains("Rename") && $0.1.minY < 0.9 }, "Rename must be visible without scrolling")
            let agentName = try XCTUnwrap(words.first { $0.0.contains("session-helper") }, "Agent name field must be visible without scrolling")
            XCTAssertGreaterThan(rename.1.minY, 0.25, "Keep agent naming visible at minimum window height")
            let receive = try XCTUnwrap(words.first { $0.0.contains("Receive messages") })
            let upload = try XCTUnwrap(words.first { $0.0.contains("Upload session") })
            XCTAssertGreaterThan(receive.1.minY, agentName.1.maxY, "Receive messages comes before Agent name")
            XCTAssertGreaterThan(agentName.1.minY, upload.1.maxY, "Upload session follows Agent name")
            XCTAssertFalse(words.contains { $0.0.contains("Save session") })
            XCTAssertTrue(words.contains { $0.0.contains("Open in") }, "Open action has a visible title")
            XCTAssertEqual(rename.1.midY, agentName.1.midY, accuracy: 0.02, "Name and Rename share one row")
            if let folder = ProcessInfo.processInfo.environment["RELAY_SESSION_READER_PREVIEW"] {
                try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: folder).appendingPathComponent("session-header-\(dark ? "dark" : "light").png"))
            }
        }
    }
}
