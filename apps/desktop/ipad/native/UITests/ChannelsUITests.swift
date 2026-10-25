import XCTest

final class ChannelsUITests: XCTestCase {
    func testChannelShowsEveryMembersMessagesWithTheirAvatars() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"]
        app.launch()
        let channels = app.buttons["Channels"].firstMatch
        XCTAssertTrue(channels.waitForExistence(timeout: 15))
        channels.tap()
        let launch = app.staticTexts["#launch"].firstMatch
        XCTAssertTrue(launch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["#general"].firstMatch.exists)
        launch.tap()
        XCTAssertTrue(app.staticTexts["Are we on track?"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Build is green"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Shipping Friday"].firstMatch.exists)
        // Each incoming message names its sender, by display name for people.
        XCTAssertTrue(app.staticTexts["Sam Lee"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["builder"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["You"].firstMatch.exists)
        // A sender no longer on the roster is looked up and still shown as a person.
        XCTAssertTrue(app.staticTexts["Pat Doe"].firstMatch.waitForExistence(timeout: 10))
        // A person's message shows their avatar; agents show their artwork.
        let avatar = app.descendants(matching: .any).matching(identifier: "Message sender avatar").firstMatch
        XCTAssertTrue(avatar.exists)
        XCTAssertEqual(avatar.label, "Sam Lee")
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "channel-group-chat"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testUnjoinedChannelOffersJoin() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-RelayUITestConversations", "-RelayUITestReset"]
        app.launch()
        let channels = app.buttons["Channels"].firstMatch
        XCTAssertTrue(channels.waitForExistence(timeout: 15))
        channels.tap()
        let general = app.staticTexts["#general"].firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 20))
        general.tap()
        XCTAssertTrue(app.buttons["Join channel"].firstMatch.waitForExistence(timeout: 10))
    }
}
