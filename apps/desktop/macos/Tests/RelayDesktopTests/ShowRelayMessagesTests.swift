@testable import RelayDesktopCore
import XCTest

final class ShowRelayMessagesTests: XCTestCase {
    func testWordingMatchesLinux() {
        XCTAssertEqual(ShowRelayMessages.title, "Show me relay messages in full")
        XCTAssertEqual(ShowRelayMessages.explanation, "Relay messages are hidden from you, or shown as a short pointer in a terminal. The agent still gets each one in full and can reply.")
        XCTAssertEqual(ShowRelayMessages.shownExplanation, "You see each relay message in full in the agent's chat. The agent gets them either way.")
        XCTAssertEqual(ShowRelayMessages.turnOffHelp, "Hide relay messages from you; the agent still gets them in full")
        XCTAssertEqual(ShowRelayMessages.turnOnHelp, "Show me each relay message in full in agent chats")
    }

    func testSettingIsOffByDefaultAndSetsOnlyItsOwnKey() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "show_relay_messages": false]
        }
        core.on("settings.set") { params in
            XCTAssertEqual(params as? [String: Bool], ["show_relay_messages": true])
            return ["allow_self_registration": true, "auto_activate": false, "show_relay_messages": true]
        }
        let client = CoreClient(socketPath: core.path)
        let before = try await client.settingsGet()
        XCTAssertEqual(before.showRelayMessages, false)
        let after = try await client.settingsSet(SettingsChange(showRelayMessages: true))
        XCTAssertEqual(after.showRelayMessages, true)
    }
}
