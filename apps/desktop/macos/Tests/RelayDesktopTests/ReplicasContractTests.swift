import XCTest
@testable import RelayDesktopCore

final class ReplicasContractTests: XCTestCase {
    func testUncertainCreateDoesNotBecomeBound() throws {
        let data = Data(#"{"spawn_id":"operation","replica_id":null,"chat_id":null,"status":"creating","binding":{"state":"pending"},"outcome_unknown":true,"recovery":"Inspect the replica before retrying."}"#.utf8)
        let result = try JSONDecoder().decode(ReplicasSpawn.self, from: data)
        XCTAssertEqual(result.outcomeUnknown, true)
        XCTAssertEqual(result.binding.state, "pending")
        XCTAssertNil(result.binding.agent)
    }

    func testBoundIdentityAndCleanupDecodeWithoutProviderCredentials() throws {
        let data = Data(#"{"spawn_id":"operation","replica_id":"replica","chat_id":"chat","status":"bound","binding":{"state":"bound","agent":"replicas-example"}}"#.utf8)
        let result = try JSONDecoder().decode(ReplicasSpawn.self, from: data)
        XCTAssertEqual(result.binding.agent, "replicas-example")
        XCTAssertEqual(CoreMethod.replicasSpawn, "replicas.spawn")
        XCTAssertEqual(CoreMethod.replicasRelease, "replicas.release")
    }
}
