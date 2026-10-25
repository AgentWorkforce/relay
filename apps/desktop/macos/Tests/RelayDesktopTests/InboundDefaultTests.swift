import XCTest
@testable import RelayDesktopCore

final class InboundDefaultTests: XCTestCase {
    private func settings(_ json: String) throws -> SettingsValues {
        try JSONDecoder().decode(SettingsValues.self, from: Data(json.utf8))
    }

    func testOfferedOnceWhereDirectDeliveryIsOnAndUnmanaged() throws {
        let on = try settings(#"{"allow_self_registration":true,"auto_activate":false,"direct_delivery":true}"#)
        XCTAssertEqual(InboundDefault.offer(on, alreadyOffered: false), .offer)
        XCTAssertNil(InboundDefault.offer(on, alreadyOffered: true))
        let off = try settings(#"{"allow_self_registration":true,"auto_activate":false,"direct_delivery":false}"#)
        XCTAssertNil(InboundDefault.offer(off, alreadyOffered: false), "an explicit hold is kept")
        XCTAssertEqual(InboundDefault.offer(nil, alreadyOffered: false), .offer, "settings not read yet")
        let withoutClaude = try settings(#"{"allow_self_registration":true,"auto_activate":false}"#)
        XCTAssertNil(InboundDefault.offer(withoutClaude, alreadyOffered: false))
        let managed = try settings(#"{"allow_self_registration":true,"auto_activate":false,"direct_delivery":false,"direct_delivery_managed":"hold"}"#)
        XCTAssertEqual(InboundDefault.offer(managed, alreadyOffered: false), .managed("hold"))
    }

    func testAManagedRefusalSaysMessagesAreDropped() {
        XCTAssertTrue(InboundDefault.managedDetail("refuse").contains("drops relayed messages"))
        XCTAssertTrue(InboundDefault.managedDetail("hold").contains("asks before showing each message"))
    }

    func testWordingMatchesLinux() {
        XCTAssertEqual(InboundDefault.label, "Deliver relayed messages to Claude Code directly")
        XCTAssertEqual(InboundDefault.detail,
                       "Sets \"crossSessionInbound\": \"accept\" in ~/.claude/settings.json unless you already chose a value.")
    }
}
