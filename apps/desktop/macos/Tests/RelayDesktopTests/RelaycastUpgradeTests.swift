import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor
final class RelaycastUpgradeTests: XCTestCase {
    private func entry(code: String = "plan_limit_exceeded", service: String = "Relaycast", status: Int = 429) -> RequestEntry {
        RequestEntry(endpoint: "https://cast.agentrelay.com/v1/workspace", failed: true, id: "1",
                     method: "GET", request: "null", response: "{\"error_code\":\"\(code)\"}",
                     service: service, startedAtMs: 0, status: status)
    }

    func testOnlyExplicitRelaycastQuotaErrorsOfferUpgrade() {
        XCTAssertEqual(RelaycastUpgrade.title, "Agent Relay plan limit reached")
        XCTAssertTrue(RelaycastUpgrade.isPlanLimit(entry()))
        XCTAssertFalse(RelaycastUpgrade.isPlanLimit(entry(code: "rate_limit_exceeded")))
        XCTAssertFalse(RelaycastUpgrade.isPlanLimit(entry(service: "Cloud")))
        XCTAssertFalse(RelaycastUpgrade.isPlanLimit(entry(status: 503)))
        // A Relay Connect room's limit is that room's, not the team's.
        let connect = RequestEntry(connect: true, endpoint: "https://cast.agentrelay.com/v1/workspace", failed: true, id: "2",
                                   method: "GET", request: "null", response: "{\"error_code\":\"plan_limit_exceeded\"}",
                                   service: "Relaycast", startedAtMs: 0, status: 429)
        XCTAssertFalse(RelaycastUpgrade.isPlanLimit(connect))
    }

    private func busy(_ id: String, endpoint: String = "https://cast.agentrelay.com/v1/dm", body: String = "{\"error_code\":\"workspace_busy\"}") -> RequestEntry {
        RequestEntry(endpoint: endpoint, failed: true, id: id, method: "POST", request: "{}",
                     response: body, service: "Relaycast", startedAtMs: 0, status: 429)
    }

    func testSustainedBusyOnUpgradablePlanOffersCapacityNotice() {
        let all: (RequestEntry) -> Bool = { _ in true }
        let three = [busy("1"), busy("2"), busy("3")]
        XCTAssertNil(RelaycastUpgrade.reason(for: Array(three.prefix(2)), plan: "free", unseen: all), "Two busy answers are ordinary contention")
        let reason = RelaycastUpgrade.reason(for: three, plan: "free", unseen: all)
        XCTAssertEqual(reason, .capacity(plan: "free"))
        XCTAssertEqual(reason?.title, "Workspace at capacity")
        XCTAssertEqual(reason?.message, "Your team is using all of the Free plan’s write capacity, so messages may be delayed while Agent Relay retries. Upgrade to raise your workspace’s capacity.")
        XCTAssertEqual(RelaycastUpgrade.reason(for: three, plan: "Pro", unseen: all), .capacity(plan: "pro"))
        XCTAssertNil(RelaycastUpgrade.reason(for: three, plan: "enterprise", unseen: all), "No upgrade above Pro")
        XCTAssertNil(RelaycastUpgrade.reason(for: three, plan: nil, unseen: all), "An unknown plan offers nothing")
        XCTAssertNil(RelaycastUpgrade.reason(for: three, plan: "free", unseen: { _ in false }), "Only new failures offer a notice")
        let tokens = (1...3).map { busy("t\($0)", endpoint: "https://cast.agentrelay.com/v1/agent/node-token") }
        XCTAssertNil(RelaycastUpgrade.reason(for: tokens, plan: "free", unseen: all), "An upgrade does not raise the node-token lane")
        func sdk(_ method: String) -> RequestEntry {
            RequestEntry(endpoint: "https://cast.agentrelay.com", failed: true, id: method, method: method, request: "{}",
                         response: "{\"error_code\":\"workspace_busy\"}", service: "Relaycast", startedAtMs: 0, status: 429)
        }
        XCTAssertNil(RelaycastUpgrade.reason(for: ["SDK: heartbeat", "SDK: ack", "SDK: join_channel"].map(sdk), plan: "free", unseen: all),
                     "SDK rows log only the origin; their method names the control or lifecycle lane")
        XCTAssertEqual(RelaycastUpgrade.reason(for: ["SDK: send_dm", "SDK: reply", "SDK: send_channel"].map(sdk), plan: "free", unseen: all),
                       .capacity(plan: "free"))
        let declined = (1...3).map { busy("d\($0)", body: "{\"error_code\":\"workspace_busy\",\"upgrade_available\":false}") }
        XCTAssertNil(RelaycastUpgrade.reason(for: declined, plan: "free", unseen: all), "Relaycast's own answer wins when present")
        XCTAssertEqual(RelaycastUpgrade.reason(for: [busy("1"), entry()], plan: "free", unseen: all), .planLimit)
        XCTAssertEqual(RelaycastUpgrade.billingURL(siteURL: "https://agentrelay.com", reason: .capacity(plan: "pro"))?.absoluteString,
                       "https://agentrelay.com/cloud/dashboard/settings?reason=relaycast-capacity#billing")
    }

    func testBillingKeepsEnvironmentAndRemovesCredentials() {
        XCTAssertEqual(RelaycastUpgrade.billingURL(siteURL: "http://user:secret@local.test:3000/old?token=x#old")?.absoluteString,
                       "http://local.test:3000/cloud/dashboard/settings?reason=relaycast-plan-limit#billing")
        XCTAssertNil(RelaycastUpgrade.billingURL(siteURL: "file:///tmp/test"))
    }

    func testQuotaToastIsDismissibleAndDoesNotRepeatForParallelFailures() async throws {
        let core = FakeCore()
        var sequence = 0
        core.on("diagnostics.requests") { _ in
            sequence += 1
            return ["entries": [[
                "id": "quota-\(sequence)", "started_at_ms": Int(Date().timeIntervalSince1970 * 1000),
                "service": "Relaycast", "method": "GET", "endpoint": "https://cast.agentrelay.com/v1/workspace",
                "request": "null", "response": "{\"error_code\":\"plan_limit_exceeded\"}",
                "status": 429, "duration_ms": 244, "failed": true
            ]]]
        }
        let model = AppModel(client: CoreClient(socketPath: core.path), manageSystemServices: false)
        defer { model.shutdown(); core.stop() }
        await model.refreshRequestLog()
        XCTAssertTrue(model.showRelaycastUpgrade)
        model.dismissRelaycastUpgrade()
        await model.refreshRequestLog()
        XCTAssertNil(model.requestLogError)
        XCTAssertFalse(model.showRelaycastUpgrade)
        XCTAssertEqual(model.requestFailure?.id, "quota-2")
    }

    func testHistoricalQuotaFailureDoesNotShowToast() async {
        let core = FakeCore()
        core.on("diagnostics.requests") { _ in ["entries": [[
            "id": "old-quota", "started_at_ms": 123, "service": "Relaycast", "method": "GET",
            "endpoint": "https://cast.agentrelay.com/v1/workspace", "request": "null",
            "response": "{\"error_code\":\"plan_limit_exceeded\"}", "status": 429, "failed": true
        ]]] }
        let model = AppModel(client: CoreClient(socketPath: core.path), manageSystemServices: false)
        defer { model.shutdown(); core.stop() }
        await model.refreshRequestLog()
        XCTAssertFalse(model.showRelaycastUpgrade)
    }
    func testWorkspaceChangeClearsNoticeAndAllowsFreshQuota() async {
        let core = FakeCore()
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        var sequence = 0
        core.on("diagnostics.requests") { _ in
            sequence += 1
            return ["entries": [["id": "identity-quota-\(sequence)", "started_at_ms": Int(Date().timeIntervalSince1970 * 1000), "service": "Relaycast", "method": "GET", "endpoint": "https://cast.agentrelay.com/v1/workspace", "request": "null", "response": "{\"error_code\":\"plan_limit_exceeded\"}", "status": 429, "failed": true]]]
        }
        let model = AppModel(client: CoreClient(socketPath: core.path), manageSystemServices: false)
        defer { model.shutdown(); core.stop() }
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.workspaceID == FakeCore.signedIn["workspace_id"] as? String }
        XCTAssertTrue(ready, "The initial identity must be applied before the quota scenario starts")
        await model.refreshRequestLog()
        XCTAssertTrue(model.showRelaycastUpgrade)
        var account = FakeCore.signedIn
        account["workspace_id"] = "another-workspace"
        core.setStatus(FakeCore.snapshot(revision: 3, account: account))
        let changed = await eventually { model.workspaceID == "another-workspace" }
        XCTAssertTrue(changed)
        XCTAssertFalse(model.showRelaycastUpgrade, "Previous workspace's notice must clear")
        await model.refreshRequestLog()
        XCTAssertTrue(model.showRelaycastUpgrade, "A fresh quota in the new workspace must not inherit the old cooldown")
    }

    func testQuotaPollFromOldWorkspaceCannotShowNotice() async {
        let core = FakeCore()
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("diagnostics.requests") { _ in
            held.wait()
            return ["entries": [["id": "held-quota", "started_at_ms": Int(Date().timeIntervalSince1970 * 1000), "service": "Relaycast", "method": "GET", "endpoint": "https://cast.agentrelay.com/v1/workspace", "request": "null", "response": "{\"error_code\":\"plan_limit_exceeded\"}", "status": 429, "failed": true]]]
        }
        let model = AppModel(client: CoreClient(socketPath: core.path), manageSystemServices: false)
        defer { model.shutdown(); core.stop() }
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.workspaceID == FakeCore.signedIn["workspace_id"] as? String }
        XCTAssertTrue(ready, "The initial identity must be applied before the quota scenario starts")
        let poll = Task { await model.refreshRequestLog() }
        let started = await eventually { core.callCount("diagnostics.requests") == 1 }
        XCTAssertTrue(started)
        var account = FakeCore.signedIn
        account["workspace_id"] = "another-workspace"
        core.setStatus(FakeCore.snapshot(revision: 3, account: account))
        let changed = await eventually { model.workspaceID == "another-workspace" }
        XCTAssertTrue(changed)
        held.signal()
        await poll.value
        XCTAssertFalse(model.showRelaycastUpgrade, "A delayed old-workspace poll must not reopen its notice")
    }

    func testFirstNewWorkspacePollIgnoresUnseenOlderQuota() async {
        let core = FakeCore()
        core.setStatus(FakeCore.snapshot(revision: 2, account: FakeCore.signedIn))
        let model = AppModel(client: CoreClient(socketPath: core.path), manageSystemServices: false)
        defer { model.shutdown(); core.stop() }
        await model.bootstrapIfNeeded()
        let ready = await eventually { model.workspaceID == FakeCore.signedIn["workspace_id"] as? String }
        XCTAssertTrue(ready, "The initial identity must be applied before the quota scenario starts")
        let oldStartedAtMs = Int(Date().addingTimeInterval(-1).timeIntervalSince1970 * 1000)
        var account = FakeCore.signedIn
        account["workspace_id"] = "another-workspace"
        core.setStatus(FakeCore.snapshot(revision: 3, account: account))
        let changed = await eventually { model.workspaceID == "another-workspace" }
        XCTAssertTrue(changed)
        core.on("diagnostics.requests") { _ in ["entries": [["id": "unseen-old-quota", "started_at_ms": oldStartedAtMs, "service": "Relaycast", "method": "GET", "endpoint": "https://cast.agentrelay.com/v1/workspace", "request": "null", "response": "{\"error_code\":\"plan_limit_exceeded\"}", "status": 429, "failed": true]]] }
        await model.refreshRequestLog()
        XCTAssertFalse(model.showRelaycastUpgrade, "Unseen global-log entries before the identity boundary cannot be attributed to the new workspace")
        core.on("diagnostics.requests") { _ in ["entries": [["id": "new-workspace-quota", "started_at_ms": Int(Date().timeIntervalSince1970 * 1000), "service": "Relaycast", "method": "GET", "endpoint": "https://cast.agentrelay.com/v1/workspace", "request": "null", "response": "{\"error_code\":\"plan_limit_exceeded\"}", "status": 429, "failed": true]]] }
        await model.refreshRequestLog()
        XCTAssertTrue(model.showRelaycastUpgrade)
    }

}
