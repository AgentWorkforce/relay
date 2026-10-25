import XCTest

#if SWIFT_PACKAGE
@testable import AttachmentUploadState
#else
@testable import AgentRelayiPad
#endif

final class AttachmentUploadStateTests: XCTestCase {
    func testLeavingConversationStopsBlockingItsComposer() {
        var state = AttachmentUploadState()
        let alice = state.begin(for: "alice")

        XCTAssertTrue(state.isUploading(for: "alice"))
        XCTAssertFalse(state.isUploading(for: "bob"))

        state.invalidate()

        XCTAssertFalse(state.isUploading(for: "alice"))
        XCTAssertFalse(state.isCurrent(alice))
    }

    func testOldCompletionCannotClearNewerUpload() {
        var state = AttachmentUploadState()
        let alice = state.begin(for: "alice")
        state.invalidate()
        let bob = state.begin(for: "bob")

        XCTAssertFalse(state.finish(alice))
        XCTAssertTrue(state.isUploading(for: "bob"))
        XCTAssertTrue(state.isCurrent(bob))

        XCTAssertTrue(state.finish(bob))
        XCTAssertFalse(state.isUploading(for: "bob"))
    }

    func testSupersededUploadCannotAppendToSameConversation() {
        var state = AttachmentUploadState()
        let first = state.begin(for: "alice")
        let second = state.begin(for: "alice")

        XCTAssertFalse(state.isCurrent(first))
        XCTAssertTrue(state.isCurrent(second))
    }
}
