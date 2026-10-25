import XCTest
@testable import AgentRelayiPad

final class MobileMachineFilterTests: XCTestCase {
    func testHostAndAddressVariantsShareOneOptionAndFilter() {
        let names = ["Test Mini.local", "test-mini", "TEST_MINI.LOCAL.", " test mini "]
        XCTAssertEqual(MobileMachineFilter.options(names).count, 1)
        for selected in names {
            for name in names { XCTAssertTrue(MobileMachineFilter.matches(name, selected: selected)) }
        }
    }

    func testNormalizationKeepsDifferentMachinesSeparate() {
        let names = ["mini-1", "mini-2", "mini.local.example", "mini", "", " "]
        XCTAssertEqual(MobileMachineFilter.options(names).count, 4)
        XCTAssertFalse(MobileMachineFilter.matches("mini-1", selected: "mini-2"))
        XCTAssertFalse(MobileMachineFilter.matches("mini.local.example", selected: "mini"))
        XCTAssertTrue(MobileMachineFilter.matches("", selected: ""))
    }

    func testDisplayChoiceIsStableAndFoldsHostDiacritics() {
        let names = ["Café Wide.local", "cafe-wide", "CAFÉ Ｗｉｄｅ"]
        XCTAssertEqual(MobileMachineFilter.options(names).count, 1)
        XCTAssertEqual(MobileMachineFilter.options(names), MobileMachineFilter.options(Array(names.reversed())))
    }
}
