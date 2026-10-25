import XCTest
@testable import RelayDesktop

final class AgentMachineFilterTests: XCTestCase {
    func testAnotherMachineIsShownAsItsOwnOnTheRelayList() {
        // All machines, or this Mac under any spelling: this Mac's sessions.
        XCTAssertFalse(AgentMachineFilter.showsElsewhereAsRelay(thisMachine: "Ada's Laptop", selected: ""))
        XCTAssertFalse(AgentMachineFilter.showsElsewhereAsRelay(thisMachine: "Ada's Laptop",
                                                                selected: "ada-s-laptop"))
        // Another machine: its agents on the relay are its On the relay list.
        XCTAssertTrue(AgentMachineFilter.showsElsewhereAsRelay(thisMachine: "Ada's Laptop", selected: "test-mini"))
    }
}
