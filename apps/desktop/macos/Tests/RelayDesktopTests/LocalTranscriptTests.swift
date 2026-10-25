import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

final class LocalTranscriptTests: XCTestCase {
    @MainActor
    func testOpeningLocalTranscriptPaginatesAndRefreshesWithoutUploading() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.transcript") { params in
            let more = params["cursor"] is [String: Any]
            return ["entries": [["id": more ? "second" : "first", "role": more ? "assistant" : "user",
                "kind": "text", "text": more ? "## Answer\n```swift\nlet x = 1\n```" : "Fix this locally",
                "timestamp_ms": 1, "truncated": false]],
                "next_cursor": more ? NSNull() : ["id": 1, "ts_ms": 1]] as [String: Any]
        }
        let upload = UploadSession(included: false, isAgent: false, sessionId: "local", source: "codex", status: .notShared, title: "Local work")
        let row = LocalSessionRow.merge(uploads: [upload], sessions: [])[0]
        let model = LocalTranscriptModel(row: row, client: CoreClient(socketPath: core.path))
        await model.load()
        XCTAssertEqual(model.entries.map(\.id), ["first", "second"])
        XCTAssertNil(model.cursor)
        XCTAssertEqual(core.callCount("sessions.transcript"), 2)
        XCTAssertEqual(core.lastParams("sessions.transcript")?["source"] as? String, "codex")
        XCTAssertEqual(core.lastParams("sessions.transcript")?["session_id"] as? String, "local")
        await model.load()
        XCTAssertEqual(model.entries.map(\.id), ["first", "second"])
        XCTAssertEqual(core.callCount("sessions.transcript"), 4)
        XCTAssertFalse(model.loading)
        XCTAssertNil(model.error)
        XCTAssertEqual(core.callCount("uploader.sessions.include"), 0)
        XCTAssertEqual(core.callCount("agents.register"), 0)
    }

    @MainActor
    func testResetRefusalExplainsPreservedSourceTranscript() async {
        let core = FakeCore()
        defer { core.stop() }
        let reason = "This session was removed from Relay by Reset all sessions. Its original transcript is unchanged; open it in the source app to read it."
        core.on("sessions.transcript") { _ in throw FakeCore.Failure(kind: "unavailable", message: reason) }
        let session = LocalSession(live: false, suggestedName: "local", target: Target(id: "local", kind: .codex), title: "Local work")
        let row = LocalSessionRow.merge(uploads: [], sessions: [session])[0]
        let model = LocalTranscriptModel(row: row, client: CoreClient(socketPath: core.path))
        await model.load()
        XCTAssertEqual(model.error, reason)
        XCTAssertTrue(model.entries.isEmpty)
        XCTAssertFalse(model.loading)
        XCTAssertEqual(core.callCount("uploader.sessions.include"), 0)
    }

    @MainActor
    func testFailedReadCanRetryAndEmptyTranscriptIsNotAnError() async {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.transcript") { _ in throw FakeCore.Failure(kind: "unavailable", message: "Transcript missing") }
        let session = LocalSession(live: false, suggestedName: "local", target: Target(id: "local", kind: .codex), title: "Local work")
        let row = LocalSessionRow.merge(uploads: [], sessions: [session])[0]
        let model = LocalTranscriptModel(row: row, client: CoreClient(socketPath: core.path))
        await model.load()
        XCTAssertNotNil(model.error)
        XCTAssertFalse(model.loading)
        core.on("sessions.transcript") { _ in ["entries": [], "next_cursor": NSNull()] as [String: Any] }
        await model.load()
        XCTAssertNil(model.error)
        XCTAssertTrue(model.entries.isEmpty)
    }

    @MainActor
    func testAutomaticPagingPreservesPartialReadAndRetriesFailedPage() async {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.transcript") { params in
            if params["cursor"] is [String: Any] {
                throw FakeCore.Failure(kind: "unavailable", message: "Read interrupted")
            }
            return ["entries": [["id": "first", "role": "user", "kind": "text", "text": "Hello", "timestamp_ms": 1, "truncated": false]],
                    "next_cursor": ["id": 1, "ts_ms": 1]] as [String: Any]
        }
        let session = LocalSession(live: false, suggestedName: "local", target: Target(id: "local", kind: .codex), title: "Local work")
        let model = LocalTranscriptModel(row: LocalSessionRow.merge(uploads: [], sessions: [session])[0], client: CoreClient(socketPath: core.path))
        await model.load()
        XCTAssertEqual(core.callCount("sessions.transcript"), 2)
        XCTAssertEqual(model.entries.map(\.id), ["first"])
        XCTAssertNotNil(model.error)
        XCTAssertNotNil(model.cursor)
        core.on("sessions.transcript") { params in
            XCTAssertNotNil(params["cursor"] as? [String: Any])
            return ["entries": [["id": "second", "role": "assistant", "kind": "text", "text": "Hi", "timestamp_ms": 2, "truncated": false]], "next_cursor": NSNull()] as [String: Any]
        }
        await model.load(more: true)
        XCTAssertEqual(model.entries.map(\.id), ["first", "second"])
        XCTAssertNil(model.error)
        XCTAssertNil(model.cursor)
    }

    @MainActor
    func testRepeatedCursorStopsAutomaticPaging() async {
        let core = FakeCore()
        defer { core.stop() }
        core.on("sessions.transcript") { _ in
            ["entries": [], "next_cursor": ["id": 1, "ts_ms": 1]] as [String: Any]
        }
        let session = LocalSession(live: false, suggestedName: "local", target: Target(id: "local", kind: .codex), title: "Local work")
        let model = LocalTranscriptModel(row: LocalSessionRow.merge(uploads: [], sessions: [session])[0], client: CoreClient(socketPath: core.path))
        await model.load()
        XCTAssertEqual(core.callCount("sessions.transcript"), 2)
        XCTAssertEqual(model.error, "The transcript stopped advancing. Try refreshing this session.")
        XCTAssertFalse(model.loading)
    }

    @MainActor
    func testImageCopyDecodesWithTheTranscriptAndLoadsWithoutTheOriginal() throws {
        let bytes = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try bytes.write(to: copy)
        defer { try? FileManager.default.removeItem(at: copy) }
        let wire: [String: Any] = ["id": "image", "role": "user", "kind": "text", "text": "", "image_path": copy.path, "timestamp_ms": 1, "truncated": false]
        let entry = try JSONDecoder().decode(LocalTranscriptEntry.self, from: JSONSerialization.data(withJSONObject: wire))
        XCTAssertEqual(entry.imagePath, copy.path)
        XCTAssertEqual(NSImage(contentsOfFile: entry.imagePath!)?.size, NSSize(width: 1, height: 1))
    }

    func testToolRunsKeepResultsAndStopAtConversationBoundaries() throws {
        func entry(_ id: String, _ kind: String, role: String = "assistant") throws -> LocalTranscriptEntry {
            try JSONDecoder().decode(LocalTranscriptEntry.self, from: JSONSerialization.data(withJSONObject:
                ["id": id, "kind": kind, "role": role, "text": id, "timestamp_ms": 1, "truncated": false]))
        }
        let firstPage = try [entry("a", "tool_use"), entry("b", "tool_result"), entry("c", "tool_use")]
        let secondPage = try [entry("d", "text", role: "tool_result"), entry("e", "text"),
                              entry("f", "tool_use"), entry("g", "thinking"), entry("h", "tool_use")]
        XCTAssertEqual(transcriptGroups(firstPage).map { $0.map(\.id) }, [["a", "b", "c"]])
        XCTAssertEqual(transcriptGroups(firstPage + secondPage).map { $0.map(\.id) },
                       [["a", "b", "c", "d"], ["e"], ["f"], ["g"], ["h"]])
        XCTAssertTrue(transcriptGroups([]).isEmpty)
    }

    func testMarkdownKeepsCodeAndConversationStructure() {
        XCTAssertEqual(ChatMarkdownParser.parse("# Heading\n\n**Answer**\n\n```swift\nlet x = 1\n```\n\n> Note\n- Next"), [
            .heading(1, "Heading"), .paragraph("**Answer**"), .code("let x = 1"), .quote("Note"), .unorderedItem("Next")
        ])
    }
}
