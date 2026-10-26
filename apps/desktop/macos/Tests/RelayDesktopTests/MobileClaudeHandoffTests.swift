import XCTest
@testable import RelayDesktopCore

final class MobileClaudeHandoffTests: XCTestCase {
    func testOlderCoresDoNotOfferHandoffAndOptInIsExplicit() throws {
        let values = try JSONDecoder().decode(SettingsValues.self, from: Data(#"{"allow_self_registration":true,"auto_activate":false}"#.utf8))
        XCTAssertNil(values.mobileClaudeHandoff)
        XCTAssertNil(values.mobileClaudeHandoffSupported)
        let unavailable = try JSONDecoder().decode(SettingsValues.self, from: Data(#"{"allow_self_registration":true,"auto_activate":false,"mobile_claude_handoff":false,"mobile_claude_handoff_supported":false}"#.utf8))
        XCTAssertEqual(unavailable.mobileClaudeHandoff, false)
        XCTAssertEqual(unavailable.mobileClaudeHandoffSupported, false)
        XCTAssertTrue(MobileClaudeHandoffCopy.unavailable.contains("Not available"))
        let change = SettingsChange(mobileClaudeHandoff: true)
        XCTAssertEqual(change.fields, ["mobile_claude_handoff"])
        XCTAssertEqual(values.applying(change).mobileClaudeHandoff, true)
        XCTAssertTrue(MobileClaudeHandoffCopy.title.contains("Experimental"))
        XCTAssertTrue(MobileClaudeHandoffCopy.detail.contains("Reading a session sends no message."))
    }
}
