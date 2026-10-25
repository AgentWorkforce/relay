@testable import RelayDesktopCore
import XCTest

final class AgentSettingsCopyTests: XCTestCase {
    func testAutoJoinGeneralWordingMatchesLinux() {
        XCTAssertEqual(AutoJoinGeneral.title, "New agents join #general")
        XCTAssertEqual(AutoJoinGeneral.explanation, "Agents you put on the relay are reached by direct message. Turn this on to have each agent put on the relay from now on join #general and get its posts.")
        XCTAssertEqual(AutoJoinGeneral.joinedExplanation, "Each agent put on the relay from now on joins #general and gets its posts. Agents already on the relay keep the channels they are in.")
        XCTAssertEqual(AutoJoinGeneral.turnOnHelp, "Have agents put on the relay from now on join #general")
        XCTAssertEqual(AutoJoinGeneral.turnOffHelp, "Keep agents put on the relay from now on out of #general")
        XCTAssertEqual(AgentSettingsChanges.title, "Changed by agents")
    }

    func testAChangeNamesTheAgentTheSettingBothValuesAndTheLocalTime() throws {
        let change = AgentSettingsChange(at: "2026-10-16T12:02:00Z", by: "api", from: "false", key: "auto_join_general", to: "true")
        let zone = try XCTUnwrap(TimeZone(secondsFromGMT: 2 * 3_600))
        XCTAssertEqual(AgentSettingsChanges.line(change), "api changed auto_join_general from false to true")
        XCTAssertEqual(AgentSettingsChanges.row(change, timeZone: zone), "api changed auto_join_general from false to true · Oct 16 2026, 14:02")
        let unset = AgentSettingsChange(at: "yesterday", by: "api", key: "auto_join_general", to: "true")
        XCTAssertEqual(AgentSettingsChanges.row(unset, timeZone: zone), "api changed auto_join_general from unset to true")
    }

    func testAutoJoinGeneralIsOffByDefaultAndSetsOnlyItsOwnKey() async throws {
        let core = FakeCore()
        defer { core.stop() }
        core.on("settings.get") { _ in
            let values: [String: Any] = ["allow_self_registration": true, "auto_activate": false,
                                         "auto_join_general": false, "agent_changes": [[String: String]]()]
            return values
        }
        core.on("settings.set") { params in
            XCTAssertEqual(params as? [String: Bool], ["auto_join_general": true])
            let change = ["at": "2026-10-16T12:02:00Z", "by": "api", "key": "auto_join_general", "from": "false", "to": "true"]
            let values: [String: Any] = ["allow_self_registration": true, "auto_activate": false,
                                         "auto_join_general": true, "agent_changes": [change]]
            return values
        }
        let client = CoreClient(socketPath: core.path)
        let before = try await client.settingsGet()
        XCTAssertEqual(before.autoJoinGeneral, false)
        XCTAssertEqual(before.agentChanges, [])
        let after = try await client.settingsSet(SettingsChange(autoJoinGeneral: true))
        XCTAssertEqual(after.autoJoinGeneral, true)
        XCTAssertEqual(after.agentChanges?.first?.by, "api")
    }
}
