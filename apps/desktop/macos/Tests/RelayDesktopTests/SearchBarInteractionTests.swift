import XCTest
@testable import RelayDesktop

final class SearchBarInteractionTests: XCTestCase {
    func testRapidFilterChangesKeepIdentityAcrossSuggestionExpansion() {
        let navigation = SessionSearchNavigation()
        let filtered = ["project:cloud"]
        let expanded = ["harness:codex", "is:active", "project:cloud", "upload:uploaded"]
        navigation.move(1, ids: filtered, query: "clo")
        for iteration in 0..<100 {
            let query = iteration.isMultiple(of: 2) ? "project:cloud " : ""
            navigation.preserve(id: "project:cloud", query: query)
            XCTAssertEqual(navigation.index(in: expanded), 2)
            XCTAssertEqual(navigation.index(in: filtered), 0)
            XCTAssertTrue(navigation.accepts(query: query))
            // Receiving a callback does not consume the identity or preservation marker.
            XCTAssertTrue(navigation.accepts(query: query))
        }
        navigation.move(1, ids: expanded, query: "")
        XCTAssertEqual(navigation.highlightedID, "upload:uploaded")
        navigation.move(-1, ids: expanded, query: "")
        XCTAssertEqual(navigation.highlightedID, "project:cloud")
    }

    func testExpandedSearchOverlapsAndCentersOnBarWithinWindow() {
        let window = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let anchor = CGRect(x: 210, y: 700, width: 620, height: 46)
        let panel = SearchPanelAnchor.frame(anchor: anchor, container: window)
        XCTAssertEqual(panel.midX, anchor.midX)
        XCTAssertTrue(panel.intersects(anchor))
        XCTAssertEqual(panel.maxY, anchor.maxY + 12)
        XCTAssertTrue(window.contains(panel))
    }

    func testBarPaddingAndChipLabelsOpenButRemoveTargetsAndDragsDoNot() {
        let bar = CGRect(x: 0, y: 0, width: 700, height: 46)
        let excluded = [CGRect(x: 160, y: 9, width: 18, height: 20), CGRect(x: 640, y: 9, width: 24, height: 26)]
        for point in [CGPoint(x: 3, y: 3), CGPoint(x: 100, y: 20), CGPoint(x: 400, y: 20)] {
            XCTAssertTrue(SearchBarClickView.isOpenClick(start: point, end: point, bounds: bar, exclusions: excluded))
        }
        for point in [CGPoint(x: 168, y: 18), CGPoint(x: 650, y: 20), CGPoint(x: 710, y: 20)] {
            XCTAssertFalse(SearchBarClickView.isOpenClick(start: point, end: point, bounds: bar, exclusions: excluded))
        }
        XCTAssertFalse(SearchBarClickView.isOpenClick(start: CGPoint(x: 400, y: 20), end: CGPoint(x: 420, y: 20), bounds: bar, exclusions: excluded))
    }
}
