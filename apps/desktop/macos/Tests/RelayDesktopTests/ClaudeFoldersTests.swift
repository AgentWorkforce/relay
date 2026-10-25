import XCTest
@testable import RelayDesktopCore

final class ClaudeFoldersTests: XCTestCase {
    private func settings(_ json: String) throws -> SettingsValues {
        try JSONDecoder().decode(SettingsValues.self, from: Data(json.utf8))
    }

    func testTheWatchedFoldersDecodeWithWhyEachIsWatched() throws {
        let values = try settings(#"{"allow_self_registration":true,"auto_activate":false,"claude_config_dirs":[{"path":"/Users/m/.claude","origin":"default","shared":false},{"path":"/Users/m/.seclaude","origin":"running","shared":true},{"path":"/opt/claude","origin":"added","shared":true}]}"#)
        let folders = try XCTUnwrap(values.claudeConfigDirs)
        XCTAssertEqual(folders.map(\.origin).map(ClaudeFolders.originLabel),
                       ["Default", "Seen on a running session", "Added here"])
        XCTAssertEqual(folders.filter(ClaudeFolders.isRemovable).map(\.path), ["/opt/claude"])
        XCTAssertEqual(folders.map(ClaudeFolders.rowDetail),
                       ["Default · Not shared", "Seen on a running session", "Added here"])
        XCTAssertEqual(ClaudeFolders.adding("/Users/m/.work", to: folders), ["/opt/claude", "/Users/m/.work"])
        XCTAssertEqual(ClaudeFolders.adding("/opt/claude", to: folders), ["/opt/claude"])
        XCTAssertEqual(ClaudeFolders.removing("/opt/claude", from: folders), [])
        let without = try settings(#"{"allow_self_registration":true,"auto_activate":false}"#)
        XCTAssertNil(without.claudeConfigDirs)
        XCTAssertNil(without.claudeCloudSessions)
    }

    func testCloudSessionsAreAnOptInSetting() throws {
        let values = try settings(#"{"allow_self_registration":true,"auto_activate":false,"claude_cloud_sessions":false}"#)
        XCTAssertEqual(values.claudeCloudSessions, false)
        let change = try JSONEncoder().encode(SettingsChange(claudeCloudSessions: true))
        XCTAssertEqual(String(decoding: change, as: UTF8.self), #"{"claude_cloud_sessions":true}"#)
    }

    func testPathsUnderHomeAreShortened() {
        XCTAssertEqual(ClaudeFolders.displayPath("/Users/m/.seclaude", home: "/Users/m"), "~/.seclaude")
        XCTAssertEqual(ClaudeFolders.displayPath("/Users/m", home: "/Users/m"), "~")
        XCTAssertEqual(ClaudeFolders.displayPath("/Users/mo/.claude", home: "/Users/m"), "/Users/mo/.claude")
        XCTAssertEqual(ClaudeFolders.displayPath("/opt/claude", home: ""), "/opt/claude")
    }

    func testWordingMatchesLinux() {
        XCTAssertEqual(ClaudeFolders.title, "Claude Code folders")
        XCTAssertEqual(ClaudeFolders.detail,
                       "Agent Relay finds Claude Code sessions and uploads their transcripts from each shared folder. A folder a running session uses through CLAUDE_CONFIG_DIR is added when it is seen. Turn a folder off to keep its sessions off the relay and out of uploads.")
        XCTAssertEqual(ClaudeFolders.cloudTitle, "Claude Code cloud sessions")
        XCTAssertTrue(ClaudeFolders.cloudDetail.hasPrefix(
            "Also upload your claude.ai cloud sessions, read with the Claude Code login in ~/.claude while that folder is shared. "))
        XCTAssertEqual(ClaudeFolders.originLabel("sibling"), "Another Claude login")
        XCTAssertEqual(ClaudeFolders.originLabel("environment"), "Set by AGENT_RELAY_CLAUDE_CONFIG_DIRS")
    }
}
