import AppKit
import SwiftUI
import XCTest
import Vision
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor private func titleText(in host: NSView) throws -> [String: CGRect] {
    let bitmap = try SessionRenderFixture.bitmap(for: host)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
    var result: [String: CGRect] = [:]
    for observation in request.results ?? [] {
        guard let text = observation.topCandidates(1).first else { continue }
        // Extract individual labels even when Vision combines adjacent controls.
        for label in ["Rename", "Done", "Cancel", "Polish session titles", "Codex", "Back to sessions"] {
            guard let range = text.string.range(of: label), let box = try text.boundingBox(for: range) else { continue }
            result[label] = CGRect(x: box.boundingBox.minX * host.bounds.width,
                y: box.boundingBox.minY * host.bounds.height,
                width: box.boundingBox.width * host.bounds.width, height: box.boundingBox.height * host.bounds.height)
        }
    }
    return result
}

@MainActor private func clickTitleControl(_ point: CGPoint, window: NSWindow) {
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        window.sendEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!)
    }
}

@MainActor final class SessionTitleHeaderTests: XCTestCase {
    func testTableHasNoRenameControlsAndDoesNotPreloadTitles() async throws {
        let core = FakeCore()
        defer { core.stop() }
        let client = CoreClient(socketPath: core.path)
        let defaults = UserDefaults(suiteName: "title-table-\(UUID())")!
        let app = AppModel(client: client, manageSystemServices: false, defaults: defaults)
        let relay = RelayModel(client: client)
        let row = LocalSessionRow.merge(uploads: [Fixture.uploadSession(sessionId: "table", title: "Read this session", status: .uploaded)], sessions: [])[0]
        let host = NSHostingView(rootView: SessionRowHost(model: app, relay: relay, row: row,
            selected: .constant(false), open: {}))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 64),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(200))
        host.layoutSubtreeIfNeeded()
        let labels = try titleText(in: host)
        for label in ["Rename", "Done", "Cancel"] {
            XCTAssertNil(labels[label], "Table must not contain \(label)")
        }
        XCTAssertEqual(core.callCount("sessions.title.capability"), 0)
        XCTAssertEqual(core.callCount("sessions.overview.get"), 0)
    }

    func testActualHeaderRendersSeamlesslyAndReloadsCapabilityAfterReconnect() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.title.capability") { _ in ["supported": true] }
        core.on("sessions.overview.get") { params in
            ["sessionId": params["session_id"]!, "requests": [], "analyses": [[
                "id": "brief", "sessionId": params["session_id"]!, "sourceProvider": "codex", "status": "completed",
                "result": ["brief": ["title": "Polish the session title editor", "description": "Saved summary"]]]]]
        }
        let client = CoreClient(socketPath: core.path)
        let defaults = UserDefaults(suiteName: "title-header-\(UUID())")!
        let app = AppModel(client: client, manageSystemServices: false, defaults: defaults)
        let updater = AppUpdater(defaults: defaults, currentVersion: "1.0.0", terminate: {})
        let title = "Polish session titles"
        let row = LocalSessionRow.merge(uploads: [Fixture.uploadSession(sessionId: "header", title: title, cwd: "/work/relay-desktop", status: .uploaded)], sessions: [])[0]
        app.page = .sessions
        app.selectedLocalSession = row
        let directory = URL(fileURLWithPath: "/tmp/relay-title-polish", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (dark, width) in [(false, 1100.0), (true, 1100.0), (false, 900.0)] {
            let host = NSHostingView(rootView: WorkspaceShell(relay: app.relay, updater: updater, confirmUpdate: {}) {
                Color.clear
            }.environmentObject(app).environment(\.colorScheme, dark ? .dark : .light))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 240),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = host
            window.makeKeyAndOrderFront(nil)
            defer { window.close() }
            func settle() async throws {
                try await Task.sleep(for: .milliseconds(180))
                host.layoutSubtreeIfNeeded()
            }
            func snapshot(_ state: String) throws {
                let bitmap = try SessionRenderFixture.bitmap(for: host)
                let image = try XCTUnwrap(bitmap.cgImage)
                let scale = CGFloat(image.width) / width
                let header = try XCTUnwrap(image.cropping(to: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: 64 * scale)))
                let png = try XCTUnwrap(NSBitmapImageRep(cgImage: header).representation(using: .png, properties: [:]))
                let theme = dark ? "dark" : "light"
                try png.write(to: directory.appendingPathComponent("\(theme)-\(Int(width))-\(state).png"))
            }
            try await settle()
            for _ in 0..<100 where app.relay.titleState(for: row).supported != true || app.relay.titleState(for: row).generatedTitle == nil {
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertEqual(app.relay.titleState(for: row).supported, true)
            XCTAssertEqual(app.relay.titleState(for: row).generatedTitle, "Polish the session title editor")
            let resting = try titleText(in: host)
            let rename = try XCTUnwrap(resting["Rename"])
            XCTAssertNotNil(resting["Back to sessions"])
            XCTAssertNotNil(resting["Codex"])
            try snapshot("resting")
            let beforeTitle = try XCTUnwrap(resting[title])
            clickTitleControl(CGPoint(x: rename.midX, y: rename.midY), window: window)
            try await settle()
            let field = try XCTUnwrap(window.firstResponder as? NSTextView)
            XCTAssertEqual(field.string, title)
            field.setSelectedRange(NSRange(location: 0, length: 0))
            let editing = try titleText(in: host)
            let editedTitle = try XCTUnwrap(editing[title])
            XCTAssertEqual(editedTitle.minX, beforeTitle.minX, accuracy: 2)
            XCTAssertEqual(editedTitle.midY, beforeTitle.midY, accuracy: 3)
            try snapshot("editing")
            let cancel = try XCTUnwrap(editing["Cancel"])
            clickTitleControl(CGPoint(x: cancel.midX, y: cancel.midY), window: window)
            try await settle()
            app.relay.connectionInterrupted()
            app.relay.connectionRecovered()
            for _ in 0..<100 where app.relay.titleState(for: row).supported != true || app.relay.titleState(for: row).generatedTitle == nil {
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertEqual(app.relay.titleState(for: row).supported, true,
                "A mounted session header reloads capability without hover")
            if width == 900 {
                app.selectedLocalSession = row.withTitle("A longer session title about polishing the native editor and preserving the subtitle position")
                try await settle()
                try snapshot("long-title")
                let labels = try titleText(in: host)
                XCTAssertNotNil(labels["Rename"], "Long titles must leave the edit control visible")
                XCTAssertNotNil(labels["Codex"], "The subtitle remains visible below a truncated title")
            }
        }
        XCTAssertEqual(core.callCount("sessions.title.set"), 0)
        XCTAssertEqual(core.callCount("sessions.overview.request"), 0)
    }
}
