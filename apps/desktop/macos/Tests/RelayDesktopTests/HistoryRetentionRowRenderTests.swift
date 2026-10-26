import AppKit
import SwiftUI
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

/// Renders the Session history section in its states for the change's
/// description (CI uploads `REQUEST_RENDER_DIR` as an artifact).
@MainActor
final class HistoryRetentionRowRenderTests: XCTestCase {
    func testRendersEachState() throws {
        let states: [(name: String, days: Int, held: Bool)] = [
            ("session-history-mac-30-days-default", 30, false),
            ("session-history-mac-7-days-preview", 7, false),
            ("session-history-mac-30-days-uploads-paused-preview", 30, true),
        ]
        for scheme in [NSAppearance.Name.aqua, .darkAqua] {
            for state in states {
                let view = SettingsSection(title: HistoryRetentionCopy.section) {
                    HistoryRetentionRow(days: state.days, uploadsHeld: state.held, set: { _ in })
                }
                .padding(28)
                .frame(width: 720)
                .background(CloudTheme.background)
                let host = NSHostingView(rootView: view)
                host.appearance = NSAppearance(named: scheme)
                host.frame = NSRect(origin: .zero, size: host.fittingSize)
                host.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                XCTAssertGreaterThan(host.bounds.height, 100, state.name)
                if let directory = ProcessInfo.processInfo.environment["REQUEST_RENDER_DIR"] {
                    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                    let suffix = scheme == .aqua ? "light" : "dark"
                    try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(state.name)-\(suffix).png"))
                }
            }
        }
    }
}
