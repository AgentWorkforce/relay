import XCTest
@testable import RelayDesktopCore

final class CursorCloudContractTests: XCTestCase {
    func testBoundAgentAndRunResultDecodeWithoutCredentials() throws {
        let agent = try JSONDecoder().decode(CursorCloudAgent.self, from: Data(#"{
            "id":"bc-agent","name":"Review auth","status":"IDLE",
            "url":"https://cursor.com/agents/bc-agent",
            "created_at":"2026-10-24T00:00:00Z","updated_at":"2026-10-24T00:01:00Z",
            "latest_run_id":"run-1","repositories":[],
            "binding":{"state":"bound","agent":"cursor-cloud-review"}
        }"#.utf8))
        XCTAssertEqual(agent.binding.agent, "cursor-cloud-review")
        XCTAssertEqual(agent.status, "IDLE")

        let run = try JSONDecoder().decode(CursorCloudRun.self, from: Data(#"{
            "id":"run-1","agent_id":"bc-agent","status":"FINISHED",
            "created_at":"2026-10-24T00:00:00Z","updated_at":"2026-10-24T00:01:00Z",
            "duration_ms":60000,"result":"Fixed it","branches":[]
        }"#.utf8))
        XCTAssertEqual(run.result, "Fixed it")
        XCTAssertEqual(CoreMethod.cursorCloudRunsCreate, "cursor_cloud.runs.create")
    }

    func testSteerIsTheDefaultFollowUpDelivery() {
        let request = CursorCloudRunCreateParams(
            agentId: "bc-agent", clientRequestId: "message-1", task: "Check the error path"
        )
        XCTAssertNil(request.delivery)
        XCTAssertTrue(CoreClient.isRead(CoreMethod.cursorCloudAgentsList))
        XCTAssertFalse(CoreClient.isRead(CoreMethod.cursorCloudAgentsArchive))
    }

    func testIdlessSteerAcknowledgementDecodes() throws {
        let run = try JSONDecoder().decode(CursorCloudRun.self, from: Data(#"{
            "id":null,"agent_id":"bc-agent","status":"QUEUED",
            "created_at":null,"updated_at":null,"duration_ms":null,
            "result":null,"branches":[]
        }"#.utf8))
        XCTAssertNil(run.id)
        XCTAssertEqual(run.agentId, "bc-agent")
        XCTAssertEqual(run.status, "QUEUED")
    }
}
