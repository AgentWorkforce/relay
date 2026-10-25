import XCTest

final class MessageDeliveryUITests: XCTestCase {
    private func open(_ name: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"]
        app.launch()
        if app.buttons["Messages"].waitForExistence(timeout: 15) { app.buttons["Messages"].firstMatch.tap() }
        let row = app.staticTexts[name].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testLastMessageShowsDeliveredOnceRead() throws {
        let app = open("builder")
        XCTAssertTrue(app.staticTexts["Ship it"].waitForExistence(timeout: 10))
        let status = app.staticTexts["Delivery status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        let delivered = NSPredicate(format: "label == 'Delivered'")
        expectation(for: delivered, evaluatedWith: status)
        waitForExpectations(timeout: 10)
        attach(app, "delivered")
    }

    func testUnreadMessageShowsSent() throws {
        let app = open("reviewer")
        XCTAssertTrue(app.staticTexts["Thanks"].waitForExistence(timeout: 10))
        let status = app.staticTexts["Delivery status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertEqual(status.label, "Sent")
        attach(app, "sent")
    }
}
