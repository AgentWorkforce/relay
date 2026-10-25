@testable import RelayDesktopCore
import XCTest

final class OpenClawCopyTests: XCTestCase {
    func testWordingMatchesLinux() {
        XCTAssertEqual(OpenClawCopy.title, "OpenClaw agents")
        XCTAssertEqual(OpenClawCopy.onDetail, "Agent Relay reaches OpenClaw's Gateway on this computer, so its agents appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only, never to your other channels.")
        XCTAssertEqual(OpenClawCopy.offDetail, "Turn this on so the agents of the OpenClaw Gateway on this computer appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only.")
        XCTAssertEqual(OpenClawCopy.turnOnHelp, "List and message the agents of OpenClaw's Gateway")
        XCTAssertEqual(OpenClawCopy.turnOffHelp, "Stop listing and messaging OpenClaw's agents")
        XCTAssertEqual(OpenClawCopy.unlimitedNotice("2026.3.13"), "OpenClaw 2026.3.13 can't limit relay sessions, so anyone on the relay who messages your agents gets a session with your agent's usual tools. Updating OpenClaw to 2026.8.1 or later makes them answer-only.")
    }

    func testToolsWordingMatchesLinux() {
        XCTAssertEqual(OpenClawToolsCopy.title, "Agent Relay tools")
        XCTAssertEqual(OpenClawToolsCopy.notConnectedDetail, "Let your OpenClaw agents list agents on the relay, message them and spawn new ones. Messages from people who aren't trusted senders never get these tools.")
        XCTAssertEqual(OpenClawToolsCopy.waitingDetail, "Approve Agent Relay in your browser to finish connecting.")
        XCTAssertEqual(OpenClawToolsCopy.connectedDetail, "Your OpenClaw agents can use Agent Relay's tools. Messages from people who aren't trusted senders never get them.")
        XCTAssertEqual(OpenClawToolsCopy.Action.connect.label, "Connect")
        XCTAssertEqual(OpenClawToolsCopy.Action.openAgain.label, "Open Again")
    }

    func testEachToolsStateHasItsDetailAndButton() {
        let notConnected = OpenClawToolsCopy.row(for: OpenClawToolsStatus(state: .notConnected))
        XCTAssertEqual(notConnected, .init(detail: OpenClawToolsCopy.notConnectedDetail, action: .connect, error: nil))
        let failed = "OpenClaw couldn't finish signing in. Try Connect again."
        XCTAssertEqual(OpenClawToolsCopy.row(for: OpenClawToolsStatus(detail: failed, state: .notConnected)).error, failed)
        let waiting = OpenClawToolsCopy.row(for: OpenClawToolsStatus(state: .waiting))
        XCTAssertEqual(waiting, .init(detail: OpenClawToolsCopy.waitingDetail, action: .openAgain, error: nil))
        let connected = OpenClawToolsCopy.row(for: OpenClawToolsStatus(state: .connected))
        XCTAssertEqual(connected, .init(detail: OpenClawToolsCopy.connectedDetail, action: nil, error: nil))
        let missing = "Agent Relay couldn't find OpenClaw's command-line tool on this computer."
        let unavailable = OpenClawToolsCopy.row(for: OpenClawToolsStatus(detail: missing, state: .unavailable))
        XCTAssertEqual(unavailable, .init(detail: missing, action: nil, error: nil))
    }

    func testOnlyAWaitingLoginIsPolled() {
        XCTAssertTrue(OpenClawToolsCopy.polls(OpenClawToolsStatus(state: .waiting)))
        XCTAssertFalse(OpenClawToolsCopy.polls(OpenClawToolsStatus(state: .connected)))
        XCTAssertFalse(OpenClawToolsCopy.polls(nil))
        XCTAssertTrue(CoreClient.isRead(CoreMethod.openclawRelayToolsStatus))
        XCTAssertFalse(CoreClient.isRead(CoreMethod.openclawRelayToolsConnect))
    }

    func testSessionKindNamesOpenClaw() {
        XCTAssertEqual(SessionKind(rawValue: "openclaw"), .openclaw)
        XCTAssertEqual(SessionKind.openclaw.label, "OpenClaw")
        XCTAssertEqual(SessionKind.openclaw.source, "openclaw")
        XCTAssertNil(Target(id: "main", kind: .openclaw).uploadKey)
    }
}
