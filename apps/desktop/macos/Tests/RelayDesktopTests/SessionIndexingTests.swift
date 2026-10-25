import AppKit
import SwiftUI
import Vision
import XCTest
@testable import RelayDesktop
import RelayDesktopCore

@MainActor
final class SessionIndexingTests: XCTestCase {
    func testDiscoveredSessionIndexesThenShowsCatalogStateInListAndSidebar() async throws {
        let suite = "session-indexing-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(manageSystemServices: false, defaults: defaults)
        let relay = RelayModel(client: CoreClient(socketPath: "/tmp/session-indexing-unused.sock"))
        let local = LocalSession(live: true, suggestedName: "session",
                                 target: Target(id: "indexing", kind: .codex), title: "New session")
        let upload = UploadSession(included: false, isAgent: false, sessionId: "indexing",
                                   source: "codex", status: .notShared, title: "New session")
        func content(indexed: Bool) -> some View {
            let row = LocalSessionRow.merge(uploads: indexed ? [upload] : [], sessions: [local])[0]
            return VStack {
                SessionRowHost(model: model, relay: relay, row: row, selected: .constant(false), open: {})
                LocalSessionSidebar(row: row, relay: relay, loading: false, refresh: {})
                    .frame(width: 300, height: 420)
            }.environmentObject(model).background(CloudTheme.background)
        }
        let host = NSHostingView(rootView: content(indexed: false))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 540),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        host.frame = NSRect(x: 0, y: 0, width: 1400, height: 540)
        for indexed in [false, true] {
            host.rootView = content(indexed: indexed)
            try await Task.sleep(for: .milliseconds(120))
            host.layoutSubtreeIfNeeded()
            let bitmap = try SessionRenderFixture.bitmap(for: host)
            if let directory = ProcessInfo.processInfo.environment["SESSION_COLUMNS_PREVIEW"] {
                try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("session-indexing-\(indexed).png"))
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
            let words = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            let text = words.joined(separator: " ")
            XCTAssertFalse(text.contains("Upload unavailable"), text)
            let expected = indexed ? "Local only" : "Indexing"
            XCTAssertEqual(words.filter { $0.contains(expected) }.count, 2, "List and sidebar: \(text)")
            if indexed { XCTAssertFalse(text.contains("Indexing"), text) }
        }
    }
}
