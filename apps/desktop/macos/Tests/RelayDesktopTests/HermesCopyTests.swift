import RelayDesktopCore
import XCTest

final class HermesCopyTests: XCTestCase {
    func testWordingMatchesLinux() {
        XCTAssertEqual(HermesCopy.title, "Hermes")
        XCTAssertEqual(HermesCopy.onDetail, "Agent Relay reaches Hermes's relay profile on this computer, so it appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only.")
        XCTAssertEqual(HermesCopy.offDetail, "Turn this on so Hermes's relay profile on this computer appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only.")
        XCTAssertEqual(HermesCopy.turnOnHelp, "List and message Hermes on this computer")
        XCTAssertEqual(HermesCopy.turnOffHelp, "Stop listing and messaging Hermes")
    }

    func testSessionKindNamesHermes() {
        XCTAssertEqual(SessionKind(rawValue: "hermes"), .hermes)
        XCTAssertEqual(SessionKind.hermes.label, "Hermes")
        XCTAssertEqual(SessionKind.hermes.source, "hermes")
        XCTAssertNil(Target(id: "relay", kind: .hermes).uploadKey)
    }
}
