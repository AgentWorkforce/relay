import XCTest
@testable import AgentRelayiPad

final class SpawnFailureTests: XCTestCase {
    private func message(_ detail: String, harness: String = "claude") -> String {
        SpawnFailure.message(detail, node: "test-mini", name: "helper", harness: harness)
    }

    func testCloudPressureAsksToRetryLater() {
        let text = message("spawn_failed: node agent.register failed for agent 'helper': d1_pressure: Node liveness retry pending")
        XCTAssertTrue(text.hasPrefix("Agent Relay is busy and could not register helper."))
        XCTAssertTrue(text.contains("Details: spawn_failed"))
    }

    func testReadinessTimeoutComesBeforePressure() {
        let text = message("spawn_readiness_timeout; owned identity cleanup unconfirmed; retry retained: d1_pressure: Node liveness retry pending")
        XCTAssertTrue(text.hasPrefix("Agent Relay is busy"), text)
    }

    func testReadinessTimeout() {
        XCTAssertTrue(message("spawn_readiness_timeout").hasPrefix("helper did not become ready on test-mini in time."))
    }

    func testPreflightFailure() {
        XCTAssertTrue(message("MCP preflight failed: relaycast unreachable").hasPrefix("test-mini could not set up Agent Relay tools"))
    }

    func testCodexLockOnlyForCodex() {
        XCTAssertTrue(message("~/.codex is locked", harness: "codex").hasPrefix("Codex on test-mini is in use"))
        XCTAssertTrue(message("lock held", harness: "claude").hasPrefix("test-mini did not start helper."))
        XCTAssertTrue(message("server busy, try later", harness: "codex").hasPrefix("test-mini did not start helper."))
        XCTAssertTrue(message("d1_pressure: Node liveness retry pending", harness: "codex").hasPrefix("Agent Relay is busy"))
    }

    func testUnreadableFolder() {
        XCTAssertTrue(message("chdir: Operation not permitted").hasPrefix("test-mini cannot open that project folder."))
    }

    func testNameInUse() {
        XCTAssertTrue(message("spawn_agent_name_in_use").hasPrefix("The name helper is already in use"))
    }

    func testEmptyDetail() {
        XCTAssertEqual(message(""), "test-mini did not start helper.")
    }

    func testProjectPathRules() {
        XCTAssertNil(SpawnProjectPath.problem("", node: "test-mini"))
        XCTAssertNil(SpawnProjectPath.problem(" /Users/me/app ", node: "test-mini"))
        XCTAssertEqual(SpawnProjectPath.problem("~/app", node: "test-mini"),
                       "Enter the full path on test-mini, such as /Users/name/project. ~ is not expanded.")
        XCTAssertEqual(SpawnProjectPath.problem("Users/me", node: "test-mini"),
                       "Enter the full path on test-mini, starting with /.")
    }
}
