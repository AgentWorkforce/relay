import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor
final class DevinSetupTests: XCTestCase {
    private var core: FakeCore!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        core = FakeCore()
        suite = "devin-setup-test-\(UUID())"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        core.stop()
        defaults.removePersistentDomain(forName: suite)
    }

    nonisolated private static func settings(devin: Bool?) -> [String: Any] {
        var settings: [String: Any] = ["allow_self_registration": true, "auto_activate": false,
                                       "analytics_enabled": true]
        if let devin { settings["devin_direct_delivery"] = devin }
        return settings
    }

    private func model() -> AppModel {
        AppModel(client: CoreClient(socketPath: core.path), manageSystemServices: false, defaults: defaults)
    }

    func testShowsOnlyWhileTheHooksAreOffAndNotDismissed() {
        XCTAssertTrue(DevinSetup.shows(hooks: false, dismissed: false))
        XCTAssertFalse(DevinSetup.shows(hooks: false, dismissed: true))
        XCTAssertFalse(DevinSetup.shows(hooks: true, dismissed: false))
        XCTAssertFalse(DevinSetup.shows(hooks: nil, dismissed: false))
    }

    func testHiddenWhereDevinNeverRanOrItsHooksAreOn() async {
        core.on("settings.get") { _ in Self.settings(devin: nil) }
        let model = model()
        XCTAssertFalse(model.showsDevinSetup, "nothing is known before settings load")
        await model.loadSettings()
        XCTAssertFalse(model.showsDevinSetup)
        core.on("settings.get") { _ in Self.settings(devin: true) }
        await model.loadSettings()
        XCTAssertFalse(model.showsDevinSetup)
        core.on("settings.get") { _ in Self.settings(devin: false) }
        await model.loadSettings()
        XCTAssertTrue(model.showsDevinSetup)
    }

    func testTurnOnSendsTheChangeAndTheCardGoes() async {
        core.on("settings.get") { _ in Self.settings(devin: false) }
        core.on("settings.set") { _ in Self.settings(devin: true) }
        let model = model()
        await model.loadSettings()
        XCTAssertTrue(model.showsDevinSetup)
        await model.turnOnDevin()
        XCTAssertEqual(core.lastParams("settings.set") as? [String: Bool], ["devin_direct_delivery": true])
        XCTAssertFalse(model.showsDevinSetup)
        XCTAssertNil(model.devinSetupError)
        XCTAssertFalse(defaults.bool(forKey: DevinSetup.dismissedKey))
    }

    func testTurnOnFailureShowsTheCoresSentenceAndKeepsTheCard() async {
        core.on("settings.get") { _ in Self.settings(devin: false) }
        core.on("settings.set") { _ in
            throw FakeCore.Failure(kind: "refused", message: "~/.config/devin/config.json cannot be written")
        }
        let model = model()
        await model.loadSettings()
        await model.turnOnDevin()
        XCTAssertTrue(model.devinSetupError?.contains("~/.config/devin/config.json cannot be written") == true,
                      model.devinSetupError ?? "no error")
        XCTAssertTrue(model.showsDevinSetup)
    }

    func testNotNowHidesTheCardForGood() async {
        core.on("settings.get") { _ in Self.settings(devin: false) }
        let model = model()
        await model.loadSettings()
        XCTAssertTrue(model.showsDevinSetup)
        model.dismissDevinSetup()
        XCTAssertFalse(model.showsDevinSetup)
        XCTAssertTrue(defaults.bool(forKey: DevinSetup.dismissedKey))
        XCTAssertEqual(core.callCount("settings.set"), 0)
        let restarted = self.model()
        await restarted.loadSettings()
        XCTAssertFalse(restarted.showsDevinSetup)
    }

    func testWordingMatchesLinux() {
        XCTAssertEqual(DevinSetup.title, "Devin found")
        XCTAssertEqual(DevinSetup.message,
                       "Put the Devin sessions you open on the relay, so they appear here and can be messaged, the way Claude Code and Codex sessions are? This adds Agent Relay's hooks to ~/.config/devin/config.json.")
        XCTAssertEqual(DevinSetup.turnOnAction, "Turn On")
        XCTAssertEqual(DevinSetup.notNowAction, "Not now")
        XCTAssertEqual(DevinSetup.dismissedKey, "devinSetupDismissed")
    }
}
