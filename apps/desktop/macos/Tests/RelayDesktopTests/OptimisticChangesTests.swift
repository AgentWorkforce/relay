import XCTest
@testable import RelayDesktopCore

/// The state and wording behind every control that shows the change asked
/// for before the core confirms it. The Linux app's `models::pending`,
/// `models::settings` and `models::optimistic` tests mirror these.
final class OptimisticChangesTests: XCTestCase {
    func testThePendingValueShowsTheLatestRequestUntilItsAnswer() {
        var pending = PendingValue<Bool>()
        XCTAssertFalse(pending.isPending)
        XCTAssertEqual(pending.shown(false), false)
        let first = pending.begin(true)
        XCTAssertEqual(pending.shown(false), true)
        // A later click wins: the first answer changes nothing.
        let second = pending.begin(false)
        XCTAssertFalse(pending.finish(first))
        XCTAssertEqual(pending.shown(true), false)
        XCTAssertTrue(pending.isPending)
        XCTAssertTrue(pending.finish(second))
        XCTAssertFalse(pending.isPending)
        XCTAssertEqual(pending.shown(true), true)
        pending.begin(true)
        pending.clear()
        XCTAssertFalse(pending.isPending)
    }

    func testASettingsChangeIsWrittenOverTheValuesItWillReplace() throws {
        let values = SettingsValues(acceptSpawns: true, allowSelfRegistration: true, analyticsEnabled: true, autoActivate: false,
                                    spawnHarnesses: ["codex": SpawnHarnessSettings(billing: "api", fullAccess: true)], spawnMaxAgents: 4)
        let applied = values
            .applying(SettingsChange(analyticsEnabled: false, spawnMaxAgents: 0))
            .applying(SpawnCopy.fullAccessChange("claude", false))
            .applying(SettingsChange(spawnHarnesses: ["codex": SpawnHarnessSettings(fullAccess: false)]))
        XCTAssertEqual(applied.analyticsEnabled, false)
        XCTAssertEqual(applied.spawnMaxAgents, 0)
        XCTAssertEqual(applied.allowSelfRegistration, true, "a value the change does not name is kept")
        XCTAssertEqual(applied.acceptSpawns, true)
        // Harnesses merge: Claude is added, Codex keeps its billing.
        XCTAssertEqual(applied.spawnHarnesses?["claude"]?.fullAccess, false)
        XCTAssertEqual(applied.spawnHarnesses?["codex"], SpawnHarnessSettings(billing: "api", fullAccess: false))
        // Keys that are not settings of their own are not written.
        let unchanged = values.applying(SettingsChange(directDeliveryDefault: true))
        XCTAssertEqual(unchanged, values)
        XCTAssertEqual(SettingsChange(analyticsEnabled: false, spawnMaxAgents: 2).fields, ["analytics_enabled", "spawn_max_agents"])
        XCTAssertEqual(SpawnCopy.fullAccessChange("codex", true).fields, ["spawn_harnesses"])
    }

    func testIncomingAndClaudeDeliveryStatusesShowTheChangeAsked() {
        let thread = IncomingThread(allowsUnrestricted: false, id: "t1", mode: .hold, open: true, project: "relay", shared: true, title: "Fix")
        let held = HeldMessage(enqueuedAtMs: 1, expiresAtMs: 2, id: "m1", senderName: "Bo", text: "hi", threadId: "t1")
        let incoming = IncomingStatus(canApprove: true, error: nil, held: [held], state: .connected, threads: [thread])
        let shared = incoming.sharing("t1", mode: .auto, allowsUnrestricted: true)
        XCTAssertEqual(shared.threads[0].mode, .auto)
        XCTAssertTrue(shared.threads[0].allowsUnrestricted)
        XCTAssertTrue(shared.threads[0].shared)
        let off = incoming.sharing("t1", mode: nil, allowsUnrestricted: true)
        XCTAssertNil(off.threads[0].mode)
        XCTAssertFalse(off.threads[0].shared)
        XCTAssertFalse(off.threads[0].allowsUnrestricted)
        XCTAssertTrue(incoming.withoutHeld("m1").held.isEmpty)
        XCTAssertEqual(incoming.withoutHeld("other").held, [held])

        let session = ClaudeDeliverySession(agent: "review", direct: false, id: "c-1", title: "Review")
        let ada = ClaudeSender(address: "ada@desk", name: "Ada")
        let message = ClaudeHeldDelivery(agent: "review", heldAtMs: 1, id: "d1", sender: "bo@desk", senderName: "Bo", sessionId: "c-1", text: "x")
        let delivery = ClaudeDeliveryStatus(allowedSenders: [ada], held: [message], restricted: true, sessions: [session])
        XCTAssertFalse(delivery.restricting(false).restricted)
        XCTAssertTrue(delivery.withSession("c-1", direct: true).sessions[0].direct)
        XCTAssertTrue(delivery.withoutSender("ada@desk").allowedSenders.isEmpty)
        let bo = ClaudeSender(address: "bo@desk", name: "Bo")
        XCTAssertEqual(delivery.allowing(bo).allowedSenders, [ada, bo])
        XCTAssertEqual(delivery.allowing(ada).allowedSenders, [ada], "a sender already allowed is kept once")
        XCTAssertTrue(delivery.withoutHeld("d1").held.isEmpty)
    }

    func testAgentsAndSessionsShowTheNameAskedFor() {
        let registration = SessionRegistration(addedBySession: false, address: "bot@mac", name: "bot")
        XCTAssertEqual(registration.withAlias("helper").displayName, "helper")
        XCTAssertEqual(registration.withAlias(nil).displayName, "bot")
        let provisional = SessionRegistration.provisional(name: "helper")
        XCTAssertTrue(provisional.isProvisional)
        XCTAssertFalse(registration.isProvisional)
        XCTAssertEqual(provisional.displayName, "helper")
        let echo = PendingMessages.echo("hello")
        XCTAssertTrue(PendingMessages.isPending(echo))
        XCTAssertTrue(echo.mine)
        XCTAssertEqual(echo.text, "hello")
        XCTAssertEqual(PendingMessages.sending, "Sending…")
        XCTAssertFalse(PendingMessages.isPending(DirectMessage(id: "m1", mine: true, sender: "", text: "hello")))
    }

    func testAnUploadActionAskedForShowsAsUnderWay() {
        XCTAssertEqual(UploadStages.pendingDetail(.retry), "Retrying uploads…")
        XCTAssertEqual(UploadStages.pendingDetail(.compact), "Compacting the upload journal…")
    }
}
