import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor
final class CapySetupTests: XCTestCase {
    private var root: URL!
    private var home: URL!
    private var applications: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("capy-\(UUID())")
        home = root.appendingPathComponent("home")
        applications = root.appendingPathComponent("Applications")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: applications, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func installed() -> Bool {
        CapySetup.isInstalled(home: home, applications: applications)
    }

    func testNotDetectedWithoutTheAppOrConnector() throws {
        XCTAssertFalse(installed())
        try Data().write(to: home.appendingPathComponent(".capy"))
        XCTAssertFalse(installed(), "a file named .capy is not the connector's directory")
    }

    func testDetectsTheAppInApplications() throws {
        try FileManager.default.createDirectory(at: applications.appendingPathComponent("Capy.app"),
                                                withIntermediateDirectories: true)
        XCTAssertTrue(installed())
    }

    func testDetectsTheAppInTheHomeApplicationsFolder() throws {
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Applications/Capy.app"),
                                                withIntermediateDirectories: true)
        XCTAssertTrue(installed())
    }

    func testDetectsTheDeviceConnectorDirectory() throws {
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".capy"),
                                                withIntermediateDirectories: true)
        XCTAssertTrue(installed())
    }

    func testShowsOnlyWhileDetectedAndNotDismissed() {
        XCTAssertTrue(CapySetup.shows(installed: true, dismissed: false))
        XCTAssertFalse(CapySetup.shows(installed: true, dismissed: true))
        XCTAssertFalse(CapySetup.shows(installed: false, dismissed: false))
    }

    func testNotNowHidesTheCardForGood() {
        let suite = "capy-setup-test-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(manageSystemServices: false, defaults: defaults, capyInstalled: true)
        XCTAssertTrue(model.showsCapySetup)
        XCTAssertFalse(model.capyPromptCopied)
        model.dismissCapySetup()
        XCTAssertFalse(model.showsCapySetup)
        XCTAssertTrue(defaults.bool(forKey: CapySetup.dismissedKey))
        let restarted = AppModel(manageSystemServices: false, defaults: defaults, capyInstalled: true)
        XCTAssertFalse(restarted.showsCapySetup)
        let withoutCapy = AppModel(manageSystemServices: false, defaults: UserDefaults(suiteName: "\(suite)-none")!,
                                   capyInstalled: false)
        XCTAssertFalse(withoutCapy.showsCapySetup)
        UserDefaults(suiteName: "\(suite)-none")?.removePersistentDomain(forName: "\(suite)-none")
    }

    func testWordingMatchesLinux() {
        XCTAssertEqual(CapySetup.title, "Capy detected")
        XCTAssertEqual(CapySetup.message,
                       "Put your Capy threads on Agent Relay so other agents can message them and their conversations appear in Sessions. Capy asks you to approve the Agent Relay plugin once.")
        XCTAssertEqual(CapySetup.setUpAction, "Set up in Capy")
        XCTAssertEqual(CapySetup.notNowAction, "Not now")
        XCTAssertEqual(CapySetup.prompt,
                       "Set me up on Agent Relay: https://github.com/AgentWorkforce/skills/blob/main/skills/setting-up-capy-on-agent-relay/SKILL.md")
        XCTAssertEqual(CapySetup.copied, "Prompt copied. Paste it into a Capy thread.")
        XCTAssertEqual(CapySetup.url.absoluteString, "https://capy.ai")
        XCTAssertEqual(CapySetup.dismissedKey, "capySetupDismissed")
    }
}
