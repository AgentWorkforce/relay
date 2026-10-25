import XCTest
@testable import RelayDesktop

final class AgentIconViewTests: XCTestCase {
    func testACapyThreadIsNamedCapy() {
        XCTAssertEqual(AgentIconView.name(for: "capy"), "Capy")
        XCTAssertEqual(AgentIconView.name(for: "Capy"), "Capy")
        XCTAssertEqual(AgentIconView.name(for: "cursor-cloud"), "Cursor Cloud")
    }
}
