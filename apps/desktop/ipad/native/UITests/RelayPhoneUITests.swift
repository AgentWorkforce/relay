import XCTest

final class RelayPhoneUITests: XCTestCase {
    func testCloudSignInStartsWithoutBridgePairing() throws {
        let app = XCUIApplication()
        app.launch()
        let signIn = app.buttons["Sign in"]
        guard signIn.waitForExistence(timeout: 10) else {
            throw XCTSkip("Simulator is already signed in")
        }
        XCTAssertFalse(app.textFields["Mac bridge URL"].exists)
        XCTAssertFalse(app.textFields["Pairing code"].exists)
        signIn.tap()
        XCTAssertTrue(app.links["Continue in Safari"].waitForExistence(timeout: 20))
    }

    func testCloudSignInEndToEnd() throws {
        guard ProcessInfo.processInfo.environment["RELAY_TEST_INTERACTIVE"] == "1" else {
            throw XCTSkip("Requires approval in the Agent Relay browser")
        }
        let app = XCUIApplication()
        app.launch()
        let signIn = app.buttons["Sign in"]
        guard signIn.waitForExistence(timeout: 10) else {
            throw XCTSkip("Simulator is already signed in")
        }
        signIn.tap()
        XCTAssertTrue(app.links["Continue in Safari"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Agents"].waitForExistence(timeout: 120))
    }

    func testAgentsDefaultToActiveFilter() throws {
        let app = XCUIApplication()
        app.launch()
        guard app.buttons["Agents"].waitForExistence(timeout: 15) else {
            throw XCTSkip("Sign in to the test workspace first")
        }
        app.buttons["Agents"].firstMatch.tap()
        let active = app.buttons["Active"]
        XCTAssertTrue(active.waitForExistence(timeout: 15))
        XCTAssertTrue(active.isSelected)
        XCTAssertFalse(app.buttons["All"].isSelected)
    }

    func testRosterExcludesOwnIdentityAndForwardingNamesEvenInAll() {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"]
        app.launch()
        XCTAssertTrue(app.staticTexts["reviewer"].firstMatch.waitForExistence(timeout: 15))
        for showAll in [false, true] {
            if showAll { app.buttons["All"].tap() }
            XCTAssertTrue(app.staticTexts["builder"].firstMatch.exists)
            XCTAssertTrue(app.staticTexts["Sam Lee"].firstMatch.exists)
            XCTAssertFalse(app.staticTexts["ui-test-person"].exists)
            XCTAssertFalse(app.staticTexts["My Own Profile"].exists)
            XCTAssertFalse(app.staticTexts["reviewer-before-rename"].exists)
        }
    }

    func testWorkspaceHasTwoTabsAndLogoStaysLeading() {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"]
        app.launch()
        XCTAssertTrue(app.buttons["Messages"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Agents"].exists)
        XCTAssertFalse(app.buttons["Drive"].exists)
        if app.frame.width < 700 {
            let logo = app.images["Workspace logo"]
            XCTAssertTrue(logo.waitForExistence(timeout: 5))
            XCTAssertLessThan(logo.frame.midX, app.frame.width / 3)
            app.buttons["Messages"].firstMatch.tap()
            XCTAssertLessThan(logo.frame.midX, app.frame.width / 3)
        }
    }

    func testMachineMenuCombinesHostVariantsAndFiltersBothAgents() {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"]
        app.launch()
        XCTAssertTrue(app.staticTexts["reviewer"].firstMatch.waitForExistence(timeout: 15))
        app.buttons["All machines"].firstMatch.tap()
        let machine = app.buttons["Test Mini"]
        XCTAssertTrue(machine.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["test-mini"].exists)
        machine.tap()
        XCTAssertTrue(app.staticTexts["reviewer"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["builder"].firstMatch.exists)
        XCTAssertFalse(app.staticTexts["sam-lee"].exists)
    }

    func testMessagesExcludeDepartedAgentsEvenWithAllRosterSelected() {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset", "-RelayUITestDepartedPeer"]
        app.launch()
        XCTAssertTrue(app.buttons["All"].waitForExistence(timeout: 15))
        app.buttons["All"].tap()
        XCTAssertTrue(app.staticTexts["reviewer"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["Messages"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["builder"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["reviewer"].exists)
        XCTAssertTrue(app.staticTexts["Sam Lee"].firstMatch.exists)
    }
    func testMessagesKeepReachablePeersWithNonActiveStatuses() {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset", "-RelayUITestMixedPresence"]
        app.launch()
        XCTAssertTrue(app.staticTexts["builder"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["reviewer"].firstMatch.exists)
        app.buttons["Messages"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["builder"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["reviewer"].firstMatch.exists)
    }

    func testComposedBareHandleKeepsItsChatAndDraftAfterRefresh() {
        assertComposedDraftSurvivesRefresh(recipient: "builder")
    }

    func testComposedOfflinePersonKeepsChatAndDraftAfterRefresh() {
        assertComposedDraftSurvivesRefresh(recipient: "sam-lee", arguments: ["-RelayUITestOfflinePerson"])
    }

    private func assertComposedDraftSurvivesRefresh(recipient name: String, arguments: [String] = []) {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"] + arguments
        app.launch()
        XCTAssertTrue(app.buttons["Messages"].waitForExistence(timeout: 15))
        app.buttons["Messages"].firstMatch.tap()
        app.buttons["New message"].firstMatch.tap()
        let recipient = app.textFields["Agent name or Relay address"]
        XCTAssertTrue(recipient.waitForExistence(timeout: 5))
        recipient.tap()
        recipient.typeText(name)
        app.buttons["Open conversation"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "Message composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("Keep this draft")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let lostDraft = expectation(for: NSPredicate(format: "value != %@", "Keep this draft"), evaluatedWith: composer)
        lostDraft.isInverted = true
        wait(for: [lostDraft], timeout: 2)
        XCTAssertEqual(composer.value as? String, "Keep this draft")
    }

}
