import RelayDesktopCore
import XCTest

final class PiSessionTests: XCTestCase {
    func testPiSetupDiagnosticSurvivesDecodingAndOldCoreCompatibility() throws {
        let message = "Pi extension could not be installed: a different extension uses agent-relay.js."
        let encoded = try JSONSerialization.data(withJSONObject: ["integration_error": message])
        let status = try JSONDecoder().decode(AgentsStatus.self, from: encoded)
        XCTAssertEqual(status.integrationError, message)
        let oldCore = try JSONDecoder().decode(AgentsStatus.self, from: Data("{}".utf8))
        XCTAssertNil(oldCore.integrationError)
    }

    func testPiSessionContractMatchesLinux() throws {
        let target = try JSONDecoder().decode(Target.self, from: Data(
            #"{"kind":"pi","id":"12345678-1234-4234-8234-123456789abc"}"#.utf8))
        XCTAssertEqual(target.kind, .pi)
        XCTAssertEqual(target.kind.label, "Pi")
        XCTAssertEqual(target.kind.source, "pi")
        XCTAssertEqual(target.key, "pi:12345678-1234-4234-8234-123456789abc")
        XCTAssertNil(target.uploadKey)
    }
}
