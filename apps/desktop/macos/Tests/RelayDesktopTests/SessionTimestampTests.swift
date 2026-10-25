import XCTest
@testable import RelayDesktopCore

final class SessionTimestampTests: XCTestCase {
    func testRecentDatesReadJustNowAndOldDatesRemainRelative() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(RelativeTime.string(for: date, relativeTo: date.addingTimeInterval(30)), "Just now")
        XCTAssertEqual(RelativeTime.string(for: date, relativeTo: date.addingTimeInterval(120)), "2 minutes ago")
        XCTAssertEqual(RelativeTime.string(for: nil), "—")
    }
    func testHoverIncludesExactDateSecondsAndTimeZone() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(RelativeTime.exactString(for: date), "Nov 14, 2023, 10:13:20 PM UTC")
        XCTAssertEqual(RelativeTime.exactString(for: nil), "—")
    }
}
