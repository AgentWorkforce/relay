import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

final class DesktopDiagnosticsTests: XCTestCase {
    private func snapshot(verification: String = "verified", push: [String: Any] = [:], found: Bool = true) throws -> Status {
        var json = FakeCore.snapshot(revision: 1, account: FakeCore.signedIn, push: push)
        var workspace = json["workspace"] as! [String: Any]
        workspace["verification"] = verification
        workspace["state"] = found ? "found" : "missing"
        json["workspace"] = workspace
        return try JSONDecoder().decode(Status.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testRelaycastAuthenticationIsNotConfusedWithAnActiveConnection() throws {
        XCTAssertEqual(DesktopDiagnostics.relaycast(try snapshot(), connected: true), "Ready · no active channels")
        XCTAssertEqual(DesktopDiagnostics.relaycast(try snapshot(found: false), connected: true), "Not configured")
        XCTAssertEqual(DesktopDiagnostics.relaycast(try snapshot(verification: "rejected"), connected: true), "Credentials rejected")
        XCTAssertEqual(DesktopDiagnostics.relaycast(try snapshot(verification: "unreachable"), connected: true), "Unreachable")
        XCTAssertEqual(DesktopDiagnostics.relaycast(try snapshot(push: ["a": ["state": "live"]]), connected: false), "Unavailable · service disconnected")
    }

    func testMixedAndReconnectingChannelsAreNotReportedAsFullyConnected() throws {
        let mixed: [String: Any] = ["a": ["state": "live"], "b": ["state": "waiting", "retry_in_ms": 500]]
        XCTAssertEqual(DesktopDiagnostics.relaycast(try snapshot(push: mixed), connected: true), "Partially connected · 1/2 live channels")
        XCTAssertEqual(DesktopDiagnostics.relaycast(try snapshot(push: ["a": ["state": "connecting"]]), connected: true), "Reconnecting · no live channels")
    }

    func testEndpointsExcludeCredentialsAndQuerySecrets() {
        XCTAssertEqual(DesktopDiagnostics.endpoint("https://user:secret@cast.example.com/api?token=secret#secret"), "https://cast.example.com/api")
        XCTAssertNil(DesktopDiagnostics.endpoint("not a URL"))
    }

    func testOldServiceSnapshotsDecodeWithoutBuildMetadata() throws {
        let old = try snapshot()
        XCTAssertNil(old.daemon.historyVersion)
        XCTAssertNil(old.daemon.buildRevision)
    }

    func testNewServiceMetadataReachesDiagnosticsContract() throws {
        var json = FakeCore.snapshot(revision: 1, account: ["state": "signed_out"])
        var daemon = json["daemon"] as! [String: Any]
        daemon["history_version"] = "0.32.3"
        daemon["build_revision"] = "abc123"
        json["daemon"] = daemon
        let decoded = try JSONDecoder().decode(Status.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded.daemon.historyVersion, "0.32.3")
        XCTAssertEqual(decoded.daemon.buildRevision, "abc123")
    }
}
