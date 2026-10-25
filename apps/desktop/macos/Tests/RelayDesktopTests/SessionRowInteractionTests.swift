import AppKit
import SwiftUI
import XCTest
import Vision
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor final class SessionRowInteractionTests: XCTestCase {
    func testRowContextMenuIncludesHideAlongsideOpenActions() async throws {
        let suite = "session-context-menu-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(manageSystemServices: false, defaults: defaults)
        let upload = UploadSession(included: false, isAgent: false, sessionId: "menu", source: "codex", status: .notShared, title: "Menu session")
        let row = LocalSessionRow.merge(uploads: [upload], sessions: [])[0]
        let host = NSHostingView(rootView: SessionRowHost(model: model, relay: RelayModel(client: CoreClient(socketPath: "/tmp/context-menu-unused.sock")), row: row, selected: .constant(false), open: {}))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 64),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(100))
        host.layoutSubtreeIfNeeded()
        let point = NSPoint(x: 300, y: 32)
        let event = try XCTUnwrap(NSEvent.mouseEvent(with: .rightMouseDown, location: point,
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        var view = host.hitTest(point)
        var menu: NSMenu?
        while let candidate = view, menu == nil {
            menu = candidate.menu(for: event)
            view = candidate.superview
        }
        let titles = try XCTUnwrap(menu).items.map(\.title)
        XCTAssertTrue(titles.contains("Open session"), titles.description)
        XCTAssertTrue(titles.contains("Hide session"), titles.description)
    }

    func testGroupCheckboxOnlyChangesItsOwnRows() async throws {
        var selection: Set<String> = ["other-group", "first"]
        func content() -> some View {
            SessionGroupSelectionCheckbox(title: "Codex", ids: ["first", "second"],
                selection: Binding(get: { selection }, set: { selection = $0 }))
                .frame(width: 44, height: 44)
        }
        let host = NSHostingView(rootView: content())
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 44, height: 44), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        func click() async throws {
            try await Task.sleep(for: .milliseconds(100))
            host.layoutSubtreeIfNeeded()
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                window.sendEvent(NSEvent.mouseEvent(with: type, location: NSPoint(x: 22, y: 22), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!)
            }
            try await Task.sleep(for: .milliseconds(30))
        }
        try await click()
        XCTAssertEqual(selection, ["other-group", "first", "second"], "A partial group selects all its rows")
        host.rootView = content()
        try await click()
        XCTAssertEqual(selection, ["other-group"], "Deselecting a group preserves other selections")
    }

    func testSelectedRowHasPersistentHighlight() async throws {
        let defaults = UserDefaults(suiteName: "session-selection-highlight")!
        defer { defaults.removePersistentDomain(forName: "session-selection-highlight") }
        let model = AppModel(manageSystemServices: false, defaults: defaults)
        let relay = RelayModel(client: CoreClient(socketPath: "/tmp/session-highlight-unused.sock"))
        let upload = UploadSession(included: false, isAgent: false, sessionId: "highlight", source: "codex", status: .notShared, title: "Selected session")
        let row = LocalSessionRow.merge(uploads: [upload], sessions: [])[0]
        func content(_ selected: Bool) -> some View {
            SessionRowHost(model: model, relay: relay, row: row, selected: .constant(selected), open: {}).background(CloudTheme.background)
        }
        let host = NSHostingView(rootView: content(false))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 64), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        func backgroundColor() throws -> NSColor {
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            return try XCTUnwrap(bitmap.colorAt(x: 400, y: 5)?.usingColorSpace(.deviceRGB))
        }
        try await Task.sleep(for: .milliseconds(80))
        let normal = try backgroundColor()
        host.rootView = content(true)
        try await Task.sleep(for: .milliseconds(80))
        let selected = try backgroundColor()
        XCTAssertGreaterThan(abs(normal.redComponent - selected.redComponent)
            + abs(normal.greenComponent - selected.greenComponent)
            + abs(normal.blueComponent - selected.blueComponent), 0.04,
            "Selection must visibly tint the row beyond its checkbox")
    }

    func testMetadataAndMessageStatesAreReadable() async throws {
        let defaults = UserDefaults(suiteName: "session-presentation-test")!
        defer { defaults.removePersistentDomain(forName: "session-presentation-test") }
        let model = AppModel(manageSystemServices: false, defaults: defaults)
        for column in [SessionColumn.harness, .model, .reasoning, .created] { model.sessionColumns.setVisible(true, for: column) }
        for column in [SessionColumn.status, .project, .updated] { model.sessionColumns.setVisible(false, for: column) }
        let upload = UploadSession(firstActivityMs: 1_700_000_000_000, included: false, isAgent: false,
            models: ["gpt-6"], reasoningEffort: "high", sessionId: "preview", source: "codex", status: .notShared, title: "Session metadata")
        let row = LocalSessionRow.merge(uploads: [upload], sessions: [])[0]
        let host = NSHostingView(rootView: VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 24) {
                ForEach(Array([RelayPresence.off, .joining, .online, .offline, .leaving].enumerated()), id: \.offset) { _, state in
                    MessageAvailabilityButton(title: "Preview", presence: state, enabled: true, help: state.messageHelp, action: {})
                }
            }.padding(.horizontal, 20)
            SessionRowHost(model: model, relay: RelayModel(client: CoreClient(socketPath: "/tmp/session-presentation-unused.sock")), row: row, selected: .constant(false), open: {})
        }.padding(.vertical, 20).background(CloudTheme.background))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1450, height: 180), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        host.frame = NSRect(x: 0, y: 0, width: 1450, height: 180)
        try await Task.sleep(for: .milliseconds(100))
        host.layoutSubtreeIfNeeded()
        let bitmap = try SessionRenderFixture.bitmap(for: host)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        // Keep the right-hand metadata labels at their rendered scale rather
        // than reducing them together with the entire wide row.
        request.regionOfInterest = CGRect(x: 0.5, y: 0, width: 0.5, height: 0.65)
        try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
        let words = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        for label in ["gpt-6", "high", RelativeTime.string(for: row.createdAt), "Codex"] {
            XCTAssertTrue(words.contains(label), "Missing or clipped: \(label): \(words)")
        }
        // Recognize the small controls in their own region rather than scaling
        // them down as part of the wide metadata row. Keep exact text checks.
        let states = VNRecognizeTextRequest()
        states.recognitionLevel = .accurate
        states.regionOfInterest = CGRect(x: 0, y: 0.5, width: 0.5, height: 0.5)
        try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([states])
        let stateWords = (states.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        for label in ["Off", "Connecting", "Receiving", "Offline", "Turning off"] {
            XCTAssertTrue(stateWords.contains(label), "Missing or clipped: \(label): \(stateWords)")
        }
        if let directory = ProcessInfo.processInfo.environment["SESSION_COLUMNS_PREVIEW"] {
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("session-metadata.png"))
        }
    }

    func testRowSurfaceOpensWhileCheckboxLaneSelects() async throws {
        let core = FakeCore()
        defer { core.stop() }
        let client = CoreClient(socketPath: core.path)
        let suite = "session-row-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(client: client, service: FakeService(status: .enabled),
                             bundledCoreVersion: "1.0.0", manageSystemServices: false, defaults: defaults)
        let relay = RelayModel(client: client)
        let upload = UploadSession(included: false, isAgent: false, sessionId: "row", source: "codex", status: .notShared, title: "Open this session")
        let row = LocalSessionRow.merge(uploads: [upload], sessions: [])[0]
        var selected = false
        var opened = 0
        let host = NSHostingView(rootView: SessionRowHost(model: model, relay: relay, row: row, selected: Binding(get: { selected }, set: { selected = $0 }), open: { opened += 1 }))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 64), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        func click(_ x: CGFloat, y: CGFloat = 32) {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
                window.sendEvent(event)
            }
        }
        click(3) // Padding next to the checkbox.
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(selected)
        XCTAssertEqual(opened, 0)
        click(22) // The checkbox itself.
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(selected)
        XCTAssertEqual(opened, 0)
        for x in [60.0, 82.0, 110.0, 1130.0, 1198.0] { // Harness, gap, title, trailing row padding.
            let before = opened
            click(x)
            try await Task.sleep(for: .milliseconds(30))
            XCTAssertEqual(opened, before + 1, "The row surface at x=\(x) must open exactly once")
        }
        XCTAssertEqual(opened, 5)
        let precedingColumns = model.sessionColumns.visible.prefix { $0 != .relay }
        let messageColumnStart = CGFloat(44 + 4 + 24 + 16) + precedingColumns.reduce(0) {
            $0 + model.sessionColumns.width(for: $1) + 16
        }
        click(messageColumnStart + model.sessionColumns.width(for: .relay) / 2) // Disabled message control stays separate.
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(opened, 5)
        model.sessionColumns.setVisible(false, for: .session)
        try await Task.sleep(for: .milliseconds(60))
        click(82)
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(opened, 6, "Gaps still open when the title column is hidden")
        XCTAssertFalse(selected)
        model.sessionColumns.setVisible(true, for: .session)
        try await Task.sleep(for: .milliseconds(60))
        // The title column includes the full row surface, including the vertical
        // padding around its text. Font metrics vary across macOS releases.
        for y in stride(from: 2.0, through: 62.0, by: 2.0) {
            let before = opened
            click(110, y: y)
            try await Task.sleep(for: .milliseconds(10))
            XCTAssertEqual(opened, before + 1, "Title surface at y=\(y) must open exactly once")
        }
    }
}
