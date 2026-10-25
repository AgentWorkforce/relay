import XCTest

final class HiddenConversationsUITests: XCTestCase {
    private var screenshots: [XCUIScreenshot] = []

    private func launch(newMessage: Bool = false, reset: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations"] + (newMessage ? ["-RelayUITestNewMessage"] : [])
        if reset { app.launchArguments.append("-RelayUITestReset") }
        app.launch()
        if app.buttons["Messages"].waitForExistence(timeout: 15) { app.buttons["Messages"].firstMatch.tap() }
        return app
    }

    /// Drags across the whole row: `swipeLeft()` on a short label can land as a tap.
    private func swipeRow(_ app: XCUIApplication, _ name: String) {
        let label = app.staticTexts[name].firstMatch
        // Start inside the row on phone and in the iPad sidebar alike.
        let start = label.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: 150, dy: 0))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -140, dy: 0)))
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSwipeHidesConversationUntilANewMessageArrives() throws {
        var app = launch(reset: true)
        let reviewer = app.staticTexts["reviewer"]
        XCTAssertTrue(reviewer.waitForExistence(timeout: 15))
        attach(app, "1-conversations")

        swipeRow(app, "reviewer")
        let hide = app.buttons["Hide"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        attach(app, "2-swipe-hide")
        hide.tap()
        XCTAssertTrue(app.buttons["Show hidden (1)"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["reviewer"].exists)
        XCTAssertTrue(app.staticTexts["builder"].exists)
        attach(app, "3-hidden")

        // Still hidden after relaunch.
        app.terminate()
        app = launch()
        XCTAssertTrue(app.staticTexts["builder"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Show hidden (1)"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["reviewer"].exists)

        // Shown again from the hidden list, then hidden again.
        app.buttons["Show hidden (1)"].tap()
        XCTAssertTrue(app.staticTexts["reviewer"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["builder"].exists)
        swipeRow(app, "reviewer")
        XCTAssertTrue(app.buttons["Unhide"].waitForExistence(timeout: 5))
        attach(app, "4-swipe-unhide")
        app.buttons["Show conversations"].tap()
        XCTAssertTrue(app.staticTexts["builder"].waitForExistence(timeout: 5))

        // A newer incoming message brings it back by itself.
        app.terminate()
        app = launch(newMessage: true)
        XCTAssertTrue(app.staticTexts["reviewer"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["builder"].exists)
        XCTAssertFalse(app.buttons["Show hidden (1)"].exists)
        attach(app, "5-new-message-reappears")
    }

    func testUnhideRestoresConversation() throws {
        let app = launch(reset: true)
        XCTAssertTrue(app.staticTexts["reviewer"].waitForExistence(timeout: 15))
        let builder = app.staticTexts["builder"]
        XCTAssertTrue(builder.waitForExistence(timeout: 15))
        swipeRow(app, "builder")
        XCTAssertTrue(app.buttons["Hide"].waitForExistence(timeout: 5))
        app.buttons["Hide"].tap()
        XCTAssertTrue(app.buttons["Show hidden (1)"].waitForExistence(timeout: 5))
        app.buttons["Show hidden (1)"].tap()
        XCTAssertTrue(app.staticTexts["builder"].waitForExistence(timeout: 5))
        swipeRow(app, "builder")
        XCTAssertTrue(app.buttons["Unhide"].waitForExistence(timeout: 5))
        app.buttons["Unhide"].tap()
        XCTAssertTrue(app.staticTexts["builder"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["reviewer"].exists)
        XCTAssertFalse(app.buttons["Show hidden (1)"].exists)
    }
}
