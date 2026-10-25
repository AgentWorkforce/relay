import AppKit
import SwiftUI
import XCTest
@testable import RelayDesktop

@MainActor
final class AgentRelayPrimaryButtonTests: XCTestCase {
    func testBrandTailIsOnlyAtBottomLeft() {
        let path = AgentRelayButtonShape().path(in: CGRect(x: 0, y: 0, width: 180, height: 32))
        XCTAssertTrue(path.contains(CGPoint(x: 2, y: 30)))
        XCTAssertFalse(path.contains(CGPoint(x: 2, y: 2)))
        XCTAssertFalse(path.contains(CGPoint(x: 178, y: 2)))
        XCTAssertFalse(path.contains(CGPoint(x: 178, y: 30)))
    }

    func testRenderedPrimaryUsesBrandBlueInBothThemes() throws {
        for scheme in [ColorScheme.light, .dark] {
            // ImageRenderer initializes Metal, which can abort on Intel CI VMs.
            // Use the same AppKit capture path as the other native UI fixtures.
            let host = NSHostingView(rootView:
                Button("Save current view") {}
                    .buttonStyle(AgentRelayPrimaryButtonStyle(height: 32, expands: true))
                    .frame(width: 180)
                    .environment(\.colorScheme, scheme)
            )
            host.frame = NSRect(x: 0, y: 0, width: 180, height: 32)
            host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            host.layoutSubtreeIfNeeded()
            let bitmap = try SessionRenderFixture.bitmap(for: host)
            // SessionRenderFixture captures at 2x resolution.
            let fill = try XCTUnwrap(bitmap.colorAt(x: 24, y: 32))
            XCTAssertEqual(fill.redComponent, 45 / 255, accuracy: 0.01)
            XCTAssertEqual(fill.greenComponent, 106 / 255, accuracy: 0.01)
            XCTAssertEqual(fill.blueComponent, 156 / 255, accuracy: 0.01)
            if let directory = ProcessInfo.processInfo.environment["BUTTON_RENDER_DIR"] {
                let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try data.write(to: URL(fileURLWithPath: directory).appendingPathComponent("agent-relay-button-\(scheme).png"))
            }
        }
    }
}
