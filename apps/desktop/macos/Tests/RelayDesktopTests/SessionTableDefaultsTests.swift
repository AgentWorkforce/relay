import AppKit
import SwiftUI
import Vision
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

/// The rendered row count a LocalSessionCountPreference reports.
private final class RowCountProbe {
    var count = 0
}

@MainActor final class SessionTableDefaultsTests: XCTestCase {
    func testDefaultTableCentersUploadAndGivesTitlesSpareSpace() async throws {
        let core = FakeCore()
        defer { core.stop() }
        let client = CoreClient(socketPath: core.path)
        let suite = "session-table-defaults-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(client: client, service: FakeService(status: .enabled), bundledCoreVersion: "1.0.0", manageSystemServices: false, defaults: defaults)
        core.on("uploader.sessions.list") { _ in
            ["sharing_mode": "new", "sessions": [["source": "codex", "session_id": "defaults", "title": "Simplify sign-in screen and improve session navigation", "cwd": "/workspace/cloud", "is_agent": false, "included": false, "status": "not_shared"]]]
        }
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        await model.bootstrapIfNeeded()
        defer { model.shutdown() }
        for _ in 0..<100 where model.sessions.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.sessions.count, 1)
        for width: CGFloat in [SessionColumnLayout.defaultWindowSize.width, 1600] {
            let rendered = RowCountProbe()
            let host = NSHostingView(rootView: LocalSessionsView(relay: RelayModel(client: client))
                .environmentObject(model).environment(\.colorScheme, .dark).background(CloudTheme.background)
                .onPreferenceChange(LocalSessionCountPreference.self) { rendered.count = $0 ?? 0 })
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 180), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            window.contentView = host
            defer { window.close() }
            // The table fills asynchronously — the session answer plus the
            // search projection's debounce — so a fixed sleep loses on a
            // slow runner: the frame still reads "No sessions". Wait until
            // the rendered table reports the row before measuring it.
            for _ in 0..<200 where rendered.count < 1 {
                try await Task.sleep(for: .milliseconds(10))
                host.layoutSubtreeIfNeeded()
            }
            host.layoutSubtreeIfNeeded()
            XCTAssertEqual(rendered.count, 1, "the session never reached the rendered table")
            let bitmap = try SessionRenderFixture.bitmap(for: host)
            if let folder = ProcessInfo.processInfo.environment["SESSION_COLUMNS_PREVIEW"] {
                try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: folder).appendingPathComponent("session-table-default-\(Int(width)).png"))
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            // Wide full-frame recognition drops small headers and misreads the
            // title on CI. Recognize the title column at its rendered scale.
            request.regionOfInterest = CGRect(x: 0, y: 0, width: 0.5, height: 1)
            try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([request])
            let observations = request.results ?? []
            let words = observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            XCTAssertTrue(words.contains("Simplify sign-in screen and improve session navigation"), words)
            // OCR the compact upload column without downscaling the whole wide
            // table. Vision returns bounds relative to this region; map them
            // back to the original table before the unchanged alignment check.
            let region = CGRect(x: 0.75, y: 0, width: 0.25, height: 1)
            let uploadRequest = VNRecognizeTextRequest()
            uploadRequest.recognitionLevel = .accurate
            uploadRequest.regionOfInterest = region
            try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage), options: [:]).perform([uploadRequest])
            let uploadWords = (uploadRequest.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            XCTAssertTrue(uploadWords.contains("Messages"), uploadWords)
            let upload = try XCTUnwrap(uploadRequest.results?.first { $0.topCandidates(1).first?.string == "Local only" }, uploadWords)
            XCTAssertEqual((region.minX + upload.boundingBox.midX * region.width) * width, width - 86, accuracy: 6,
                           "Upload status must be centered in its compact column at every window width")
        }
    }
}
