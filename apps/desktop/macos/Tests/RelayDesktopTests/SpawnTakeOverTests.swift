import AppKit
import SwiftUI
import Vision
import XCTest
@testable import RelayDesktop
import RelayDesktopCore

@MainActor
final class SpawnTakeOverTests: XCTestCase {
    func testTakeOverErrorsStayWithTheirSessionWhenSwitchingSidebars() async throws {
        let core = FakeCore()
        let model = AppModel(client: CoreClient(socketPath: core.path), manageSystemServices: false)
        defer { model.shutdown(); core.stop() }
        let relay = model.relay
        func session(_ name: String) -> LocalSession {
            LocalSession(directory: "/work/api", live: true,
                         registration: SessionRegistration(addedBySession: false, address: "\(name)@desk", name: name,
                                                           spawn: SessionSpawn(canTakeOver: true, harness: "claude", takenOver: false)),
                         suggestedName: name, target: Target(id: name, kind: .claudeTerminal), title: name)
        }
        let first = session("first"), second = session("second")
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let listed = try JSONSerialization.jsonObject(with: encoder.encode([first, second]))
        core.on("sessions.list") { _ in ["sessions": listed] }
        try await relay.loadSessions()
        relay.takeOverErrors[first.id] = "Still working"
        func content(_ session: LocalSession) -> some View {
            LocalSessionSidebar(row: LocalSessionRow.merge(uploads: [], sessions: [session])[0],
                                relay: relay, loading: false, refresh: {})
                .frame(width: 360, height: 700)
                .environmentObject(model).background(CloudTheme.background)
        }
        let host = NSHostingView(rootView: content(first))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 700),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        for selected in [first, second, first] {
            host.rootView = content(selected)
            try await Task.sleep(for: .milliseconds(150))
            host.layoutSubtreeIfNeeded()
            let bitmap = try SessionRenderFixture.bitmap(for: host)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            XCTAssertEqual(text.contains("Still working"), selected.id == first.id, text)
        }
    }
}
