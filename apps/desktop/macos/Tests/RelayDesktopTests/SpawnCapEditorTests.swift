import XCTest
@testable import RelayDesktop

final class SpawnCapEditorTests: XCTestCase {
    @MainActor
    func testFailedSaveRestoresConfirmedCapAndShowsError() async {
        for (confirmed, draft) in [(0, "2"), (12, "")] {
            let editor = SpawnCapEditor()
            editor.confirm(confirmed)
            editor.draft = draft
            await editor.commit { _ in "Could not save the cap." }
            XCTAssertEqual(editor.draft, confirmed == 0 ? "" : "12")
            XCTAssertEqual(editor.error, "Could not save the cap.")
            XCTAssertFalse(editor.saving)
        }
    }

    @MainActor
    func testSuccessAndRetryFollowConfirmedSettings() async {
        let editor = SpawnCapEditor()
        editor.confirm(12)
        editor.draft = ""
        await editor.commit { next in
            XCTAssertEqual(next, 0)
            editor.confirm(next)
            return nil
        }
        XCTAssertEqual(editor.draft, "")
        XCTAssertNil(editor.error)
        await editor.commit { _ in XCTFail("Unchanged cap must not save again"); return nil }
    }
}
