import AppKit
import XCTest
@testable import RelayDesktop

@MainActor
final class ActionCursorTests: XCTestCase {
    func testDisablingAndReenablingUnderStationaryPointer() async {
        let original = NSCursor.current
        defer { original.set() }
        var pointer = ActionCursorState()
        pointer.enter(enabled: true)
        XCTAssertEqual(NSCursor.current, .pointingHand)
        pointer.enabledChanged(false)
        XCTAssertEqual(NSCursor.current, .arrow)
        pointer.enabledChanged(true)
        XCTAssertEqual(NSCursor.current, .pointingHand)
        pointer.leave()
        XCTAssertEqual(NSCursor.current, .arrow)
    }

    func testInactiveOrRemovedControlDoesNotStealAnotherCursor() async {
        let original = NSCursor.current
        defer { original.set() }
        var pointer = ActionCursorState()
        pointer.enter(enabled: false)
        XCTAssertEqual(NSCursor.current, .arrow)
        pointer.leave()
        NSCursor.iBeam.set()
        pointer.enabledChanged(true)
        pointer.leave()
        XCTAssertEqual(NSCursor.current, .iBeam)
        pointer.enter(enabled: true)
        XCTAssertEqual(NSCursor.current, .pointingHand)
        pointer.leave()
        XCTAssertEqual(NSCursor.current, .arrow)
    }
}
