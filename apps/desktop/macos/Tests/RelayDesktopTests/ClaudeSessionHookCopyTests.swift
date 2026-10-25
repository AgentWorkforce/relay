import RelayDesktopCore
import XCTest

final class ClaudeSessionHookCopyTests: XCTestCase {
    func testWordingMatchesLinux() {
        XCTAssertEqual(ClaudeSessionHookCopy.title, "Claude Code activation")
        XCTAssertEqual(
            ClaudeSessionHookCopy.turnedOff,
            "A Claude Code session stays off the relay until you put it on. Turn this on to add a SessionStart hook to each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes."
        )
        XCTAssertEqual(
            ClaudeSessionHookCopy.turnedOn,
            "Agent Relay's SessionStart hook is in each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes."
        )
        XCTAssertEqual(
            ClaudeSessionHookCopy.turnOnHelp,
            "Add Agent Relay's SessionStart hook to each Claude login"
        )
        XCTAssertEqual(
            ClaudeSessionHookCopy.turnOffHelp,
            "Remove Agent Relay's SessionStart hook from each Claude login"
        )
        XCTAssertFalse(ClaudeSessionHookCopy.turnedOn.contains("auto_activate"))
        XCTAssertTrue(ClaudeSessionHookCopy.turnedOff.contains("unless you say yes"))
    }
}
