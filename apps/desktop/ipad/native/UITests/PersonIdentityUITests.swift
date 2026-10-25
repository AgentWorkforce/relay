import XCTest

final class PersonIdentityUITests: XCTestCase {
    func testPersonConversationShowsNameHandleAndAvatar() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"]
        app.launch()
        if app.buttons["Messages"].waitForExistence(timeout: 15) { app.buttons["Messages"].firstMatch.tap() }
        // The display name arrives with the agent metadata, after the list.
        XCTAssertTrue(app.staticTexts["Sam Lee"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["sam-lee"].firstMatch.exists)
        // Both the image and initials have the same accessible person label.
        let avatar = app.descendants(matching: .any).matching(identifier: "Person avatar").firstMatch
        XCTAssertTrue(avatar.exists)
        XCTAssertEqual(avatar.label, "Sam Lee")
        XCTAssertEqual(avatar.value as? String, "Initials")
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "person-conversation"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testPersonPhotoLoadsInRosterConversationAndOpenHeader() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset", "-RelayUITestProfilePhoto"]
        app.launch()
        let rosterAvatar = app.descendants(matching: .any).matching(identifier: "Person avatar").firstMatch
        expectation(for: NSPredicate(format: "value == %@", "Profile photo"), evaluatedWith: rosterAvatar)
        waitForExpectations(timeout: 20)
        XCTAssertEqual(rosterAvatar.label, "Sam Lee")
        if app.buttons["Messages"].waitForExistence(timeout: 15) { app.buttons["Messages"].firstMatch.tap() }
        let name = app.staticTexts["Sam Lee"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 20))
        let avatar = app.descendants(matching: .any).matching(identifier: "Person avatar").firstMatch
        expectation(for: NSPredicate(format: "value == %@", "Profile photo"), evaluatedWith: avatar)
        waitForExpectations(timeout: 20)
        XCTAssertEqual(avatar.label, "Sam Lee")
        name.tap()
        let header = app.descendants(matching: .any).matching(identifier: "Person header avatar").firstMatch
        expectation(for: NSPredicate(format: "value == %@", "Profile photo"), evaluatedWith: header)
        waitForExpectations(timeout: 20)
        XCTAssertEqual(header.label, "Sam Lee")
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "person-profile-photo"
        attachment.lifetime = .keepAlways
        add(attachment)
    }


    func testAlreadyOpenHeaderUpdatesWhenProfileArrives() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset", "-RelayUITestProfilePhoto",
                               "-RelayUITestDelayedProfilePhoto"]
        app.launch()
        let name = app.staticTexts["Sam Lee"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        name.tap()
        let header = app.descendants(matching: .any).matching(identifier: "Person header avatar").firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertEqual(header.value as? String, "Initials")
        expectation(for: NSPredicate(format: "value == %@", "Profile photo"), evaluatedWith: header)
        waitForExpectations(timeout: 20)
        XCTAssertEqual(header.label, "Sam Lee")
    }

}
