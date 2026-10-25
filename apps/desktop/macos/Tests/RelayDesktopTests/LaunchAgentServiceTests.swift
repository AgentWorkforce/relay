import Foundation
import ServiceManagement
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

final class LaunchAgentServiceTests: XCTestCase {
    func testMovedFallbackReloadsTheLoadedProgramAndPreservesBundleAssociation() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.selectFallback()
        fixture.os.loadedProgram = "/old/Applications/Agent Relay.app/Contents/Helpers/Agent Relay Helper"
        XCTAssertEqual(fixture.service.status, .notRegistered)

        try fixture.service.register()

        XCTAssertEqual(fixture.os.loadedProgram, fixture.helper.path)
        XCTAssertEqual(fixture.service.status, .enabled)
        XCTAssertEqual(fixture.os.events, ["bootout", "bootstrap", "unregisterBundled"])
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: Data(contentsOf: fixture.fallback), format: nil) as? [String: Any])
        XCTAssertEqual(plist["AssociatedBundleIdentifiers"] as? [String], ["com.agentrelay.desktop"])
    }

    func testExplicitRegistrationWaitsForOldJobToDisappearEvenAtTheSamePath() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.selectFallback()
        fixture.os.loadedProgram = fixture.helper.path
        fixture.os.lingeringPrintsOnBootout = 2

        try fixture.service.register()

        XCTAssertEqual(fixture.os.events, ["bootout", "bootstrap", "unregisterBundled"])
        XCTAssertEqual(fixture.os.pauses, 2)
        XCTAssertEqual(fixture.os.loadedProgram, fixture.helper.path)
    }

    func testLingeringOldJobFailsInsteadOfBeingMistakenForNewRegistration() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.selectFallback()
        fixture.os.loadedProgram = fixture.helper.path
        fixture.os.lingeringPrintsOnBootout = 100

        XCTAssertThrowsError(try fixture.service.register())
        XCTAssertEqual(fixture.os.events, ["bootout"])
        XCTAssertEqual(fixture.os.pauses, 20)
    }

    func testFailedBootstrapKeepsBundledJobEligibleForTheNextEarlyRetry() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.os.bootstrapFailures = 1

        XCTAssertThrowsError(try fixture.service.recoverSpawnFailure())
        XCTAssertEqual(fixture.os.bundledStatus, .enabled)
        XCTAssertTrue(fixture.defaults.bool(forKey: fixture.fallbackKey))
        XCTAssertEqual(fixture.service.status, .notRegistered)
        XCTAssertEqual(fixture.os.events, ["bootstrap"])

        XCTAssertTrue(try fixture.service.recoverSpawnFailure())
        XCTAssertEqual(fixture.os.events, ["bootstrap", "bootstrap", "unregisterBundled"])
        XCTAssertEqual(fixture.os.loadedProgram, fixture.helper.path)
        XCTAssertEqual(fixture.service.status, .enabled)
    }

    func testSelectedFallbackCanRetryBootstrapWithoutAnEnabledBundledJob() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.selectFallback()
        fixture.os.bundledStatus = .notRegistered
        fixture.os.bootstrapFailures = 1
        XCTAssertThrowsError(try fixture.service.recoverSpawnFailure())
        XCTAssertTrue(try fixture.service.recoverSpawnFailure())
        XCTAssertFalse(try fixture.service.recoverSpawnFailure())
        XCTAssertEqual(fixture.os.events, ["bootstrap", "bootstrap"])
    }

    func testStopAfterFailedBootstrapAlsoUnregistersTheBrokenOriginal() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.os.bootstrapFailures = 1
        XCTAssertThrowsError(try fixture.service.recoverSpawnFailure())

        try fixture.service.unregister()

        XCTAssertEqual(fixture.os.bundledStatus, .notRegistered)
        XCTAssertNil(fixture.os.loadedProgram)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.fallback.path))
        XCTAssertEqual(fixture.os.events, ["bootstrap", "unregisterBundled"])
    }

    func testApprovalRequiredIsReportedEvenWithALoadedJobAndNeverBypassed() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.selectFallback()
        fixture.os.bundledStatus = .notRegistered
        fixture.os.loadedProgram = fixture.helper.path
        fixture.os.legacyStatus = .requiresApproval

        XCTAssertEqual(fixture.service.status, .requiresApproval)
        try fixture.service.register()
        XCTAssertFalse(try fixture.service.recoverSpawnFailure())
        XCTAssertTrue(fixture.os.events.isEmpty)
    }

    func testApprovalDiscoveredDuringBootstrapSurfacesWithoutRetriedRegistration() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        fixture.os.approvalDuringBootstrap = true

        XCTAssertTrue(try fixture.service.recoverSpawnFailure())
        XCTAssertEqual(fixture.service.status, .requiresApproval)
        XCTAssertFalse(try fixture.service.recoverSpawnFailure())
        XCTAssertEqual(fixture.os.events, ["bootstrap", "unregisterBundled"])
    }

    private final class Fixture {
        let home: URL
        let helper: URL
        let fallback: URL
        let defaults: UserDefaults
        let suite = "launch-agent-test-\(UUID())"
        let os = FakeSystem()
        let service: LaunchAgentService
        var fallbackKey: String { "\(FakeSystem.label).usesLocalLaunchAgent" }

        init() throws {
            home = FileManager.default.temporaryDirectory.appendingPathComponent("launch-agent-\(UUID())")
            let bundle = home.appendingPathComponent("Applications/Agent Relay.app")
            helper = bundle.appendingPathComponent("Contents/Helpers/Agent Relay Helper")
            fallback = home.appendingPathComponent("Library/LaunchAgents/\(FakeSystem.label).local.plist")
            defaults = UserDefaults(suiteName: suite)!
            let plistURL = bundle.appendingPathComponent("Contents/Library/LaunchAgents/\(LaunchAgentService.plistName)")
            try FileManager.default.createDirectory(at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: helper)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)
            try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let plist: [String: Any] = ["BundleProgram": "Contents/Helpers/Agent Relay Helper",
                                        "ProgramArguments": ["Agent Relay Helper", "relay", "serve"]]
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: plistURL)
            service = LaunchAgentService(bundleURL: bundle, homeDirectory: home,
                                         bundleIdentifier: "com.agentrelay.desktop", defaults: defaults,
                                         system: os.operations)
        }

        func selectFallback() { defaults.set(true, forKey: fallbackKey) }
        func remove() {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: home)
        }
    }

    private final class FakeSystem {
        static var label: String { LaunchAgentService.plistName.replacingOccurrences(of: ".plist", with: "") }
        var bundledStatus: SMAppService.Status = .enabled
        var legacyStatus: SMAppService.Status = .enabled
        var loadedProgram: String?
        var bootstrapFailures = 0
        var approvalDuringBootstrap = false
        var lingeringPrintsOnBootout = 0
        var remainingPrints: Int?
        var pauses = 0
        var events: [String] = []

        var operations: LaunchAgentService.System {
            .init(bundledStatus: { self.bundledStatus }, registerBundled: { self.bundledStatus = .enabled },
                  unregisterBundled: {
                      self.events.append("unregisterBundled")
                      self.bundledStatus = .notRegistered
                  }, legacyStatus: { _ in self.legacyStatus }, launchctl: { self.run($0) },
                  pause: { _ in self.pauses += 1 })
        }

        func run(_ arguments: [String]) -> (success: Bool, output: String) {
            switch arguments.first {
            case "print":
                guard arguments[1].hasSuffix(".local") else {
                    return (bundledStatus == .enabled, "job state = spawn failed\nlast exit code = 78: EX_CONFIG\nprogram identifier = Contents/Helpers/Agent Relay Helper")
                }
                if let remaining = remainingPrints {
                    if remaining == 0 { loadedProgram = nil; remainingPrints = nil }
                    else { remainingPrints = remaining - 1 }
                }
                return (loadedProgram != nil, loadedProgram.map { "job = {\n\tprogram = \($0)\n}" } ?? "not found")
            case "bootout":
                events.append("bootout")
                remainingPrints = lingeringPrintsOnBootout
                return (true, "")
            case "bootstrap":
                events.append("bootstrap")
                if approvalDuringBootstrap { legacyStatus = .requiresApproval; return (false, "approval required") }
                if bootstrapFailures > 0 { bootstrapFailures -= 1; return (false, "temporary bootstrap failure") }
                guard loadedProgram == nil,
                      let data = try? Data(contentsOf: URL(fileURLWithPath: arguments[2])),
                      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                      let program = plist["Program"] as? String else { return (false, "old job still loaded or invalid plist") }
                loadedProgram = program
                return (true, "")
            default:
                return (false, "unexpected command")
            }
        }
    }
}
