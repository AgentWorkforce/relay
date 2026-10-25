import AppKit
import SwiftUI
import Vision
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor final class SessionColumnLayoutTests: XCTestCase {
    func testGroupingUsesFullWidthNativeDropdownAndUpdatesSelection() async throws {
        var selection = "none"
        let host = NSHostingView(rootView: CloudSelect(title: "Group by", selection: Binding(
            get: { selection }, set: { selection = $0 }
        ), options: [("none", "None"), ("harness", "Harness"), ("project", "Project")]))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 28),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        host.frame = NSRect(x: 0, y: 0, width: 340, height: 28)
        try await Task.sleep(for: .milliseconds(100))
        host.layoutSubtreeIfNeeded()
        func findDropdown(_ view: NSView) -> CloudDropdownButton? {
            (view as? CloudDropdownButton) ?? view.subviews.lazy.compactMap(findDropdown).first
        }
        let dropdown = try XCTUnwrap(findDropdown(host))
        XCTAssertTrue(dropdown.pullsDown)
        XCTAssertEqual(dropdown.preferredEdge, .minY)
        XCTAssertEqual(dropdown.bounds.width, 340, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(dropdown.menu).minimumWidth, dropdown.bounds.width, accuracy: 1)
        XCTAssertEqual(Array(dropdown.itemTitles.dropFirst()), ["None", "Harness", "Project"])
        XCTAssertEqual(dropdown.item(at: 0)?.title, "None")
        XCTAssertEqual(dropdown.item(at: 1)?.state, .on)
        dropdown.selectItem(at: 2)
        dropdown.sendAction(dropdown.action, to: dropdown.target)
        XCTAssertEqual(selection, "harness")
    }

    func testColumnPickerShowsEveryOptionWithoutClipping() async throws {
        for dark in [false, true] {
            let host = NSHostingView(rootView: SessionColumnEditor(layout: .constant(SessionColumnLayout()), grouping: .constant(.none), showHidden: .constant(false), close: {})
                .environment(\.colorScheme, dark ? .dark : .light)
                .background(CloudTheme.background))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 840), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = host
            defer { window.close() }
            host.frame = NSRect(x: 0, y: 0, width: 380, height: 840)
            try await Task.sleep(for: .milliseconds(100))
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
            let words = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            for label in ["Group by", "None", "Show hidden", "Messages", "Directory", "Session ID", "Model", "Reasoning", "Created", "Reset to default", "Done"] {
                XCTAssertTrue(words.contains(label), "Missing or clipped: \(label): \(words)")
            }
            if let directory = ProcessInfo.processInfo.environment["SESSION_COLUMNS_PREVIEW"] {
                try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("session-columns-\(dark ? "dark" : "light").png"))
            }
        }
    }
}
