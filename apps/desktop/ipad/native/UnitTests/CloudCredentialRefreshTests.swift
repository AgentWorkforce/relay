import XCTest
@testable import AgentRelayiPad

final class CloudCredentialRefreshTests: XCTestCase {
    func testOnlyCurrentCredentialOwnerCanCommit() {
        let request = CloudCredentialRefresh(sessionGeneration: 1, refreshToken: "old-refresh")
        XCTAssertTrue(request.isCurrent(requestID: request.id, sessionGeneration: 1, refreshToken: "old-refresh", signingOut: false))
        XCTAssertFalse(request.isCurrent(requestID: request.id, sessionGeneration: 1, refreshToken: "old-refresh", signingOut: true))
        XCTAssertFalse(request.isCurrent(requestID: nil, sessionGeneration: 1, refreshToken: "old-refresh", signingOut: false))
        XCTAssertFalse(request.isCurrent(requestID: UUID(), sessionGeneration: 1, refreshToken: "old-refresh", signingOut: false))
        XCTAssertFalse(request.isCurrent(requestID: request.id, sessionGeneration: 2, refreshToken: "old-refresh", signingOut: false))
        XCTAssertFalse(request.isCurrent(requestID: request.id, sessionGeneration: 1, refreshToken: nil, signingOut: false))
        XCTAssertFalse(request.isCurrent(requestID: request.id, sessionGeneration: 1, refreshToken: "new-refresh", signingOut: false))
    }
}
