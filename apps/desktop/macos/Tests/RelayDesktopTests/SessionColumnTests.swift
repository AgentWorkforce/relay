import XCTest
@testable import RelayDesktopCore
@testable import RelayDesktop

final class SessionColumnTests: XCTestCase {
    func testEveryColumnHasAMatchingSort() {
        for column in SessionColumn.allCases {
            XCTAssertEqual(column.sortColumn?.rawValue, column.title)
        }
        XCTAssertFalse(LocalSessionSortColumn.created.startsAscending)
    }

    func testSessionTakesSpareWidthAndDefaultsFitTheWindow() {
        var layout = SessionColumnLayout()
        XCTAssertEqual(layout.expandingColumn, .session)
        XCTAssertGreaterThanOrEqual(layout.width(for: .session), 400)
        XCTAssertLessThanOrEqual(layout.minimumWidth + 48, SessionColumnLayout.defaultWindowSize.width)
        layout.move(.upload, to: .session)
        XCTAssertEqual(layout.expandingColumn, .session)
        layout.setVisible(false, for: .session)
        XCTAssertEqual(layout.expandingColumn, layout.visible.last)
    }

    func testDefaultsAndEveryColumnCanBeHiddenExceptTheLast() {
        var layout = SessionColumnLayout()
        XCTAssertEqual(layout.visible, [.session, .status, .project, .updated, .relay, .upload])
        for column in layout.visible { layout.setVisible(false, for: column) }
        XCTAssertEqual(layout.visible, [.upload])
        layout.setVisible(true, for: .harness)
        layout.setVisible(false, for: .upload)
        XCTAssertEqual(layout.visible, [.harness])
    }
    func testMoveKeepsHiddenColumnsAndPersistsOrder() {
        var layout = SessionColumnLayout()
        layout.move(.updated, to: .session)
        layout.setVisible(false, for: .project)
        layout.setVisible(true, for: .directory)
        let restored = SessionColumnLayout(data: layout.data)
        XCTAssertEqual(restored, layout)
        XCTAssertEqual(restored.visible, [.updated, .session, .status, .relay, .upload, .directory])
        layout.move(.updated, to: .upload)
        XCTAssertEqual(layout.visible, [.session, .status, .relay, .upload, .updated, .directory])
    }
    func testMalformedAndStalePreferencesRecoverWithoutLosingValidChoices() {
        XCTAssertEqual(SessionColumnLayout(data: Data("broken".utf8)), SessionColumnLayout())
        let partial = Data(#"[{"id":"updated","visible":false},{"id":"retired","visible":true},{"id":"updated","visible":true}]"#.utf8)
        let layout = SessionColumnLayout(data: partial)
        XCTAssertEqual(layout.order.first, .updated)
        XCTAssertTrue(layout.hidden.contains(.updated))
        XCTAssertEqual(Set(layout.order), Set(SessionColumn.allCases))
        let empty = SessionColumn.allCases.map { ["id": $0.rawValue, "visible": false] as [String: Any] }
        XCTAssertEqual(SessionColumnLayout(data: try! JSONSerialization.data(withJSONObject: empty)).visible, [.session])
    }
    func testResizedWidthsPersistAcrossHideAndReorderAndClampInvalidSizes() {
        var layout = SessionColumnLayout()
        layout.setWidth(555, for: .session)
        layout.setWidth(-5, for: .project)
        layout.setWidth(9000, for: .updated)
        layout.setWidth(.infinity, for: .status)
        layout.setVisible(false, for: .session)
        layout.move(.session, to: .upload)
        let restored = SessionColumnLayout(data: layout.data)
        XCTAssertEqual(restored.width(for: .session), 555)
        XCTAssertEqual(restored.width(for: .project), 80)
        XCTAssertEqual(restored.width(for: .updated), 1200)
        XCTAssertNil(restored.widths[.status])
        XCTAssertEqual(restored, layout)
        XCTAssertTrue(SessionColumnLayout().widths.isEmpty)
    }

    @MainActor func testAppModelRestoresAndResetsItsOwnPreference() {
        let defaults = UserDefaults(suiteName: "session-columns-\(UUID())")!
        defer { defaults.removeObject(forKey: SessionColumnLayout.preferenceKey) }
        let model = AppModel(manageSystemServices: false, defaults: defaults)
        model.sessionColumns.setWidth(700, for: .session)
        model.sessionColumns.setWidth(350, for: .upload)
        model.sessionColumns.move(.upload, to: .session)
        model.sessionColumns.setVisible(false, for: .project)
        let reopened = AppModel(manageSystemServices: false, defaults: defaults)
        XCTAssertEqual(reopened.sessionColumns, model.sessionColumns)
        reopened.sessionColumns = SessionColumnLayout()
        XCTAssertEqual(SessionColumnLayout(data: defaults.data(forKey: SessionColumnLayout.preferenceKey)), SessionColumnLayout())
    }
}
