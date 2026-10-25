import AppKit
import SwiftUI
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor final class SessionColumnResizeTests: XCTestCase {
    func testHeaderDragPersistsWidthAndBodyDoesNotResize() async throws {
        let core = FakeCore()
        defer { core.stop() }
        let client = CoreClient(socketPath: core.path)
        let suite = "session-resize-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(client: client, service: FakeService(status: .enabled), bundledCoreVersion: "1.0.0", manageSystemServices: false, defaults: defaults)
        model.sessionGrouping = .none
        for column in [SessionColumn.harness, .model, .reasoning] { model.sessionColumns.setVisible(true, for: column) }
        for column in [SessionColumn.updated, .relay, .upload] { model.sessionColumns.setVisible(false, for: column) }
        model.sessionColumns.move(.harness, to: .project)
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "new", "sessions": [["source": "codex", "session_id": "resize", "title": "Resize this session", "is_agent": false, "included": false, "status": "not_shared"]]]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        for _ in 0..<100 where model.sessions.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.sessions.count, 1)
        let host = NSHostingView(rootView: LocalSessionsView(relay: RelayModel(client: client)).environmentObject(model))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(200))
        host.layoutSubtreeIfNeeded()
        func event(_ type: NSEvent.EventType, x: CGFloat, y: CGFloat, count: Int = 1) {
            window.sendEvent(NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: type == .leftMouseUp ? 0 : 1)!)
        }
        let initial = SessionColumn.session.width + max(0, 1352 - model.sessionColumns.minimumWidth)
        let edge = 24 + 88 + initial + 3
        // Compare the rendered divider strokes, including plain-text headers.
        // A short text header must not shift its overlay below button headers.
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let scale = CGFloat(bitmap.pixelsWide) / host.bounds.width
        func strokeRows(at x: CGFloat) throws -> [Int] {
            try (0..<36).filter { y in
                let stroke = try XCTUnwrap(bitmap.colorAt(x: Int(x * scale), y: Int(CGFloat(y) * scale))?.usingColorSpace(.deviceRGB))
                let background = try XCTUnwrap(bitmap.colorAt(x: Int((x + 6) * scale), y: Int(CGFloat(y) * scale))?.usingColorSpace(.deviceRGB))
                return abs(stroke.redComponent - background.redComponent) > 0.02
            }
        }
        let reference = try strokeRows(at: edge)
        XCTAssertFalse(reference.isEmpty, "The reference divider must be visible")
        var dividerX = edge
        for column in model.sessionColumns.visible.dropFirst() {
            dividerX += 16 + model.sessionColumns.width(for: column)
            XCTAssertEqual(try strokeRows(at: dividerX), reference, "\(column.title) divider must align with Session")
        }
        let resting = window.firstResponder
        event(.leftMouseDown, x: edge, y: 282)
        event(.leftMouseDragged, x: edge + 80, y: 282)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertTrue(model.sessionColumns.widths.isEmpty, "Dragging previews before persisting")
        XCTAssertTrue(window.firstResponder === resting, "A pointer resize leaves keyboard focus alone")
        event(.leftMouseUp, x: edge + 80, y: 282)
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(window.firstResponder === resting, "A finished pointer resize leaves the grip unfocused")
        XCTAssertEqual(model.sessionColumns.width(for: .session), initial + 80, accuracy: 2)
        XCTAssertNil(model.selectedLocalSession, "Resizing must not open a session")
        XCTAssertEqual(SessionColumnLayout(data: defaults.data(forKey: SessionColumnLayout.preferenceKey)), model.sessionColumns)
        let saved = model.sessionColumns
        event(.leftMouseDown, x: edge + 80, y: 282)
        event(.leftMouseDragged, x: edge + 140, y: 282)
        try await Task.sleep(for: .milliseconds(30))
        // Escape goes through the application, where the drag's key monitor sees it.
        NSApp.sendEvent(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!)
        event(.leftMouseUp, x: edge + 140, y: 282)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(model.sessionColumns, saved, "Escape cancels instead of persisting the drag")
        XCTAssertTrue(window.firstResponder === resting, "A cancelled pointer resize leaves the grip unfocused")
        event(.leftMouseDown, x: edge + 80, y: 282)
        event(.leftMouseUp, x: edge + 80, y: 282)
        event(.leftMouseDown, x: edge + 80, y: 282, count: 2)
        event(.leftMouseUp, x: edge + 80, y: 282, count: 2)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(model.sessionColumns.width(for: .session), SessionColumn.session.width, "Double-click resets just this column")
        let reset = model.sessionColumns
        event(.leftMouseDown, x: edge + 80, y: 232)
        event(.leftMouseDragged, x: edge + 140, y: 232)
        event(.leftMouseUp, x: edge + 140, y: 232)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(model.sessionColumns, reset, "Body column boundaries never resize")
    }
}
