import RelayDesktopCore
import XCTest

final class TrustedSendersCopyTests: XCTestCase {
    func testWordingMatchesLinux() {
        XCTAssertEqual(TrustedSendersCopy.title, "Trusted senders")
        XCTAssertEqual(TrustedSendersCopy.detail, "Relay names or addresses trusted like you: their messages reach your own OpenClaw and Hermes, with their memory and tools. Everyone else gets an answer-only chat of their own. Separate them with commas.")
        XCTAssertEqual(TrustedSendersCopy.placeholder, "teammate, name@machine")
    }

    func testFieldParsesToTheList() {
        XCTAssertEqual(TrustedSendersCopy.senders(from: " ada-lovelace, ,bot@node-9 "), ["ada-lovelace", "bot@node-9"])
        XCTAssertEqual(TrustedSendersCopy.senders(from: ""), [])
    }
}
