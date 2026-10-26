import RelayDesktopCore
import XCTest

final class HistoryRetentionCopyTests: XCTestCase {
    func testChoicesReadAsLinuxReadsThem() {
        XCTAssertEqual(HistoryRetentionCopy.choices.map(HistoryRetentionCopy.label),
                       ["7 days", "30 days (default)", "90 days", "Forever"])
    }

    func testAShortChoiceWarnsAndAnyLimitWarnsWhileUploadsAreHeld() {
        XCTAssertEqual(HistoryRetentionCopy.warning(7, uploadsHeld: false),
                       "Sessions that haven’t uploaded within 7 days can be removed from this computer before they upload, for example while you’re signed out or uploads are paused.")
        for days in [30, 90, 0] {
            XCTAssertNil(HistoryRetentionCopy.warning(days, uploadsHeld: false), "\(days)")
        }
        XCTAssertEqual(HistoryRetentionCopy.warning(30, uploadsHeld: true),
                       "While you’re signed out or uploads are paused, sessions that haven’t uploaded within 30 days can be removed from this computer before they upload.")
        XCTAssertNotNil(HistoryRetentionCopy.warning(90, uploadsHeld: true))
        XCTAssertNil(HistoryRetentionCopy.warning(0, uploadsHeld: true))
    }

    func testAChoiceShowsAtOnceWhileItSaves() {
        let values = SettingsValues(allowSelfRegistration: true, autoActivate: true, historyRetentionDays: 30)
        let applied = values.applying(SettingsChange(historyRetentionDays: 7))
        XCTAssertEqual(applied.historyRetentionDays, 7)
        XCTAssertEqual(SettingsChange(historyRetentionDays: 0).fields, ["history_retention_days"])
    }
}
