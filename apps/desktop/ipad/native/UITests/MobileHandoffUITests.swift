import XCTest

final class MobileHandoffUITests: XCTestCase {
    private func open(scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset", "-RelayUITestMobileHandoff", scenario]
        app.launch()
        let messages = app.buttons["Messages"].firstMatch
        XCTAssertTrue(messages.waitForExistence(timeout: 15))
        messages.tap()
        let reviewer = app.staticTexts["reviewer"].firstMatch
        XCTAssertTrue(reviewer.waitForExistence(timeout: 15))
        reviewer.tap()
        XCTAssertTrue(app.staticTexts["Reading this conversation sends no message."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["Mobile handoff status"].exists)
        return app
    }

    private func send(_ app: XCUIApplication) {
        let composer = app.textFields["Message composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard composer.exists else { return false }
            let frame = composer.frame
            return !frame.isEmpty && !frame.isInfinite && !frame.isNull &&
                app.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
        }, object: nil)
        guard XCTWaiter.wait(for: [visible], timeout: 10) == .completed else {
            XCTFail("The message composer must have an onscreen center before sending")
            return
        }
        guard focusComposer(composer, in: app) else {
            XCTFail("Tapping the composer must give it keyboard focus before typing")
            return
        }
        composer.typeText("Continue the task")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Continue the task"].firstMatch.waitForExistence(timeout: 10))
        let queued = NSPredicate(format: "label == 'Queued'")
        expectation(for: queued, evaluatedWith: app.staticTexts["Delivery status"])
        waitForExpectations(timeout: 10)
    }

    private func focusComposer(_ composer: XCUIElement, in app: XCUIApplication) -> Bool {
        // SwiftUI's existing control appears only while messageFocused is true.
        // Wait for that focus transition, including when a simulator tap lands
        // during a layout change; do not type into an unfocused element.
        for _ in 0..<2 {
            // iOS 26 can reject a valid TextField activation point while its
            // measured frame is onscreen. Tap that center, then prove focus.
            composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let focused = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                app.buttons["Hide keyboard"].exists
            }, object: nil)
            if XCTWaiter.wait(for: [focused], timeout: 5) == .completed { return true }
        }
        return false
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testReadingDoesNothingAndFirstMessageShowsConnecting() {
        let app = open(scenario: "connecting")
        send(app)
        XCTAssertTrue(app.staticTexts["Connecting to Claude…"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Authorize"].exists)
        capture(app, "mobile-handoff-connecting")
    }

    func testQueuedMessageDoesNotClaimAContinuationOrDelivery() {
        let app = open(scenario: "queued")
        send(app)
        XCTAssertFalse(app.descendants(matching: .any)["Mobile handoff status"].exists)
        XCTAssertFalse(app.staticTexts["Delivered"].exists)
        capture(app, "mobile-handoff-queued")
    }

    func testConfirmedContinuationKeepsTheSameConversation() {
        let app = open(scenario: "ready")
        send(app)
        XCTAssertTrue(app.staticTexts["Continuing in Claude"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["reviewer"].firstMatch.exists)
        XCTAssertFalse(app.staticTexts["Delivered"].exists)
        capture(app, "mobile-handoff-resumed")
    }

    func testFailureExplainsTheProblemWithoutInventingPermission() {
        let app = open(scenario: "failed")
        send(app)
        XCTAssertTrue(app.staticTexts["Could not continue Claude"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Claude's mobile connection could not be confirmed. Check the message status before sending again."].exists)
        XCTAssertFalse(app.buttons["Authorize"].exists)
        capture(app, "mobile-handoff-failure")
    }
}
