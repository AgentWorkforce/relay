import XCTest
@testable import RelayDesktopCore

final class CoreClientTests: XCTestCase {
    private var core: FakeCore!

    override func setUp() {
        core = FakeCore()
    }

    override func tearDown() {
        core.stop()
    }

    func testStalledRequestTimesOutAndFreshConnectionStillWorks() async throws {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        core.on("sessions.list") { _ in held.wait(); return ["sessions": []] }
        let client = CoreClient(socketPath: core.path, requestTimeout: 0.1)
        let finished = expectation(description: "bounded request")
        let request = Task {
            defer { finished.fulfill() }
            do {
                _ = try await client.sessionsList()
                XCTFail("expected a timeout")
            } catch let error as CoreError {
                XCTAssertEqual(error.kind, "core_timeout")
                XCTAssertTrue(error.retryable)
            } catch { XCTFail("unexpected \(error)") }
        }
        await fulfillment(of: [finished], timeout: 1)
        request.cancel()
        await request.value
        // A fresh connection must remain usable while the old reply is held.
        core.on("fleet.list") { _ in ["brokers": []] }
        let fleet = try await client.fleetList()
        XCTAssertTrue(fleet.brokers.isEmpty)
        XCTAssertEqual(core.callCount("hello"), 2)
        held.signal()
    }

    func testReadWaitsForReplacementCoreButCommandIsNotReplayed() async throws {
        let path = core.path
        let client = CoreClient(socketPath: path)
        core.stop()
        let read = Task { try await client.statusGet() }
        try await Task.sleep(for: .milliseconds(350))
        core = FakeCore(path: path)
        let replacementStatus = core.status
        core.on("status.get") { _ in replacementStatus }
        let status = try await read.value
        XCTAssertEqual(status.daemon.pid, 4242)
        XCTAssertEqual(core.callCount("status.get"), 1)

        // The old core receives a command but dies before answering. The
        // client cannot know whether it ran, so the replacement must not
        // receive it a second time.
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        let entered = expectation(description: "command reached the old core")
        core.on("test.write") { _ in ["ok": true] }
        core.beforeReply = { method in
            if method == "test.write" { entered.fulfill(); held.wait() }
        }
        let write = Task { let _: JSONValue = try await client.call("test.write", NoParams()) }
        await fulfillment(of: [entered], timeout: 1)
        core.stop()
        core = FakeCore(path: path)
        core.on("test.write") { _ in ["ok": true] }
        do {
            try await write.value
            XCTFail("expected an interrupted command")
        } catch let error as CoreError {
            XCTAssertEqual(error.message, CoreError.interrupted.message)
        }
        held.signal()
        XCTAssertEqual(core.callCount("test.write"), 0)
    }

    func testCancellingAnInFlightRequestDoesNotWaitForItsDeadline() async throws {
        let held = DispatchSemaphore(value: 0)
        defer { held.signal() }
        let entered = expectation(description: "request received")
        core.on("sessions.list") { _ in
            entered.fulfill()
            held.wait()
            return ["sessions": []]
        }
        let client = CoreClient(socketPath: core.path)
        let finished = expectation(description: "request cancelled")
        let request = Task {
            defer { finished.fulfill() }
            do { _ = try await client.sessionsList(); XCTFail("expected cancellation") }
            catch is CancellationError { }
            catch { XCTFail("unexpected \(error)") }
        }
        await fulfillment(of: [entered], timeout: 1)
        request.cancel()
        await fulfillment(of: [finished], timeout: 1)
        held.signal()
        await request.value
    }

    func testSilentHandshakeAndSubscriptionAreBounded() async {
        for method in ["hello", "subscribe"] {
            let held = DispatchSemaphore(value: 0)
            let fake = FakeCore()
            fake.beforeReply = { current in if current == method { held.wait() } }
            let client = CoreClient(socketPath: fake.path, requestTimeout: 0.1)
            let finished = expectation(description: "bounded \(method)")
            let request = Task {
                defer { finished.fulfill() }
                do { _ = try await client.subscribe(topics: [.status]); XCTFail("expected timeout") }
                catch let error as CoreError { XCTAssertEqual(error.kind, "core_timeout") }
                catch { XCTFail("unexpected \(error)") }
            }
            await fulfillment(of: [finished], timeout: 1)
            request.cancel()
            held.signal()
            await request.value
            fake.stop()
        }
    }

    func testReadAndHandshakeDeadlinesPreserveLongRunningCommands() {
        XCTAssertEqual(CoreClient.timeout(for: "hello"), 5)
        XCTAssertEqual(CoreClient.timeout(for: "subscribe"), 5)
        XCTAssertEqual(CoreClient.timeout(for: "sessions.list"), 30)
        XCTAssertEqual(CoreClient.timeout(for: "settings.get"), 30)
        XCTAssertEqual(CoreClient.timeout(for: "diagnostics.requests"), 30)
        XCTAssertEqual(CoreClient.timeout(for: "uploader.start"), 660)
        XCTAssertEqual(CoreClient.timeout(for: "chat.send"), 660)
        XCTAssertTrue(CoreClient.isRead("settings.get"))
        XCTAssertTrue(CoreClient.isRead(CoreMethod.cursorCloudAgentsGet))
        XCTAssertTrue(CoreClient.isRead(CoreMethod.cursorCloudEnvironmentsList))
        XCTAssertTrue(CoreClient.isRead(CoreMethod.cursorCloudRunsList))
        XCTAssertTrue(CoreClient.isRead(CoreMethod.replicasSpawnGet))
        XCTAssertFalse(CoreClient.isRead(CoreMethod.cursorCloudRunsCreate))
        XCTAssertFalse(CoreClient.isRead(CoreMethod.cursorCloudRunsCancel))
        XCTAssertFalse(CoreClient.isRead("agents.test_message"))
        XCTAssertFalse(CoreClient.isRead("future.status"))
    }

    func testCallsGreetFirstAndDecodeResults() async throws {
        core.on("sessions.list") { _ in
            ["sessions": [["target": ["kind": "codex", "id": "a"], "title": "Fix tests", "project": "relay",
                           "directory": "/src/relay", "live": true, "updated_at_ms": 1_790_000_000_000,
                           "registration": ["name": "fix-tests", "address": "fix-tests@mac", "added_by_session": false,
                                            "push": ["state": "live"]],
                           "suggested_name": "fix-tests"]]]
        }
        let client = CoreClient(socketPath: core.path)
        let result = try await client.sessionsList()
        XCTAssertEqual(result.sessions.first?.registration?.address, "fix-tests@mac")
        XCTAssertEqual(result.sessions.first?.target.uploadKey, "codex:a")
        XCTAssertEqual(result.sessions.first?.directory, "/src/relay")
        XCTAssertTrue(result.sessions.first?.registration?.push?.isLive == true)
        XCTAssertEqual(core.calls.first?.method, "hello")
        XCTAssertEqual(core.calls.first?.params["bridge_version"] as? Int, CoreBridgeVersion.current)
        XCTAssertTrue(client.offers("sessions.list"))
    }

    func testManagedLaunchPickerRowsAndRegistrationUseTheGeneratedContract() async throws {
        core.on("sessions.managed.launch") { params in
            XCTAssertEqual(params["kind"] as? String, "opencode")
            XCTAssertEqual(params["session_id"] as? String, "ses_exact")
            XCTAssertEqual(params["executable"] as? String, "/opt/bin/opencode")
            XCTAssertEqual(params["directory"] as? String, "/src/project")
            return ["target": ["kind": "opencode", "id": "ses_exact"],
                    "title": "OpenCode ses_exact", "directory": "/src/project"]
        }
        core.on("sessions.list") { _ in
            ["sessions": [
                ["target": ["kind": "opencode", "id": "ses_exact"], "title": "OpenCode ses_exact",
                 "directory": "/src/project", "live": true, "registration": NSNull(),
                 "suggested_name": "opencode-project"],
                ["target": ["kind": "grok", "id": "grok_exact"], "title": "Grok grok-4",
                 "directory": "/src/project", "live": true, "registration": NSNull(),
                 "suggested_name": "grok-project"],
            ]]
        }
        core.on("agents.register") { params in
            let target = params["target"] as? [String: Any]
            let id = target?["id"] as? String ?? ""
            return ["name": "managed-\(id)", "address": "managed-\(id)@mac", "already_registered": false]
        }

        let client = CoreClient(socketPath: core.path)
        let started = try await client.sessionsManagedLaunch(
            ManagedLaunchParams(directory: "/src/project", executable: "/opt/bin/opencode",
                                kind: .opencode, sessionId: "ses_exact"))
        XCTAssertEqual(started.target, Target(id: "ses_exact", kind: .opencode))
        let sessions = (try await client.sessionsList()).sessions
        XCTAssertEqual(sessions.map(\.target.kind), [.opencode, .grok])
        for session in sessions {
            let registered = try await client.agentsRegister(RegisterParams(target: session.target))
            XCTAssertEqual(registered.address, "managed-\(session.target.id)@mac")
        }
        XCTAssertEqual(core.callCount("agents.register"), 2)
    }

    func testErrorsCarryTheContractKindAndSentence() async {
        core.on("agents.rename") { _ in throw FakeCore.Failure(kind: "conflict", message: "That name is taken.") }
        let client = CoreClient(socketPath: core.path)
        do {
            try await client.agentsRename(RenameParams(name: "a", newName: "b"))
            XCTFail("expected an error")
        } catch let error as CoreError {
            XCTAssertEqual(error.kind, "conflict")
            XCTAssertEqual(error.localizedDescription, "That name is taken.")
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(core.lastParams("agents.rename")?["new_name"] as? String, "b")
    }

    func testAnotherBridgeVersionIsReported() async {
        core.bridgeVersion = CoreBridgeVersion.current + 1
        let client = CoreClient(socketPath: core.path)
        do {
            try await client.statusGet()
            XCTFail("expected a mismatch")
        } catch let error as CoreError {
            XCTAssertEqual(error.kind, "bridge_version_mismatch")
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testNothingListeningIsUnreachable() async {
        let client = CoreClient(socketPath: "/tmp/rdt-none-\(UUID().uuidString.prefix(6)).sock")
        do {
            try await client.statusGet()
            XCTFail("expected unreachable")
        } catch let error as CoreError {
            XCTAssertEqual(error.kind, "core_unreachable")
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testSlowCallsDoNotBlockEachOther() async throws {
        core.on("chat.send") { _ in
            Thread.sleep(forTimeInterval: 0.5)
            return ["answered": true, "conversation": ["messages": [], "sending": false]]
        }
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "direct_delivery": false,
             "direct_delivery_managed": NSNull(), "analytics_enabled": true, "contractor_access": false]
        }
        let client = CoreClient(socketPath: core.path)
        let started = Date()
        async let slow = client.chatSend(ChatSendParams(text: "hi"))
        try await Task.sleep(nanoseconds: 50_000_000)
        let settings = try await client.settingsGet()
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.45)
        XCTAssertNil(settings.directDeliveryManaged)
        _ = try await slow
    }

    /// The Grok leader setting rides on `settings.get`/`settings.set`: absent
    /// where Grok never ran, a bool otherwise, and set with only its own key.
    func testGrokLeaderSettingDecodesAndSetsOnlyItsOwnKey() async throws {
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "direct_delivery": false,
             "analytics_enabled": true, "contractor_access": false, "grok_leader": false]
        }
        core.on("settings.set") { params in
            XCTAssertEqual(params as? [String: Bool], ["grok_leader": true])
            return ["allow_self_registration": true, "auto_activate": false, "direct_delivery": false,
                    "analytics_enabled": true, "contractor_access": false, "grok_leader": true]
        }
        let client = CoreClient(socketPath: core.path)
        let before = try await client.settingsGet()
        XCTAssertEqual(before.grokLeader, false)
        let after = try await client.settingsSet(SettingsChange(grokLeader: true))
        XCTAssertEqual(after.grokLeader, true)
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true]
        }
        let withoutGrok = try await client.settingsGet()
        XCTAssertNil(withoutGrok.grokLeader)
    }

    func testClaudeSessionHookSettingDecodesAndSetsOnlyItsOwnKey() async throws {
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true,
             "claude_session_hook": false]
        }
        core.on("settings.set") { params in
            XCTAssertEqual(params as? [String: Bool], ["claude_session_hook": true])
            return ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true,
                    "claude_session_hook": true]
        }
        let client = CoreClient(socketPath: core.path)
        let before = try await client.settingsGet()
        XCTAssertEqual(before.claudeSessionHook, false)
        let after = try await client.settingsSet(SettingsChange(claudeSessionHook: true))
        XCTAssertEqual(after.claudeSessionHook, true)
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true]
        }
        let withoutClaude = try await client.settingsGet()
        XCTAssertNil(withoutClaude.claudeSessionHook)
    }

    /// The Devin hooks setting rides on `settings.get`/`settings.set`:
    /// absent where Devin never ran, a bool otherwise, and set with only
    /// its own key.
    func testDevinDirectDeliverySettingDecodesAndSetsOnlyItsOwnKey() async throws {
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true,
             "devin_direct_delivery": false]
        }
        core.on("settings.set") { params in
            XCTAssertEqual(params as? [String: Bool], ["devin_direct_delivery": true])
            return ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true,
                    "devin_direct_delivery": true]
        }
        let client = CoreClient(socketPath: core.path)
        let before = try await client.settingsGet()
        XCTAssertEqual(before.devinDirectDelivery, false)
        let after = try await client.settingsSet(SettingsChange(devinDirectDelivery: true))
        XCTAssertEqual(after.devinDirectDelivery, true)
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true]
        }
        let withoutDevin = try await client.settingsGet()
        XCTAssertNil(withoutDevin.devinDirectDelivery)
    }

    func testCodexStopHookSettingDecodesAndSetsOnlyItsOwnKey() async throws {
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true,
             "codex_stop_hook": false]
        }
        core.on("settings.set") { params in
            XCTAssertEqual(params as? [String: Bool], ["codex_stop_hook": true])
            return ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true,
                    "codex_stop_hook": true]
        }
        let client = CoreClient(socketPath: core.path)
        let before = try await client.settingsGet()
        XCTAssertEqual(before.codexStopHook, false)
        let after = try await client.settingsSet(SettingsChange(codexStopHook: true))
        XCTAssertEqual(after.codexStopHook, true)
        core.on("settings.get") { _ in
            ["allow_self_registration": true, "auto_activate": false, "analytics_enabled": true]
        }
        let withoutConductor = try await client.settingsGet()
        XCTAssertNil(withoutConductor.codexStopHook)
    }

    /// A core of another version than the app (launchd runs the old one
    /// until the app retires it) can send values this build does not know;
    /// the handshake and the snapshot still decode, keeping those values.
    func testAnotherCoresUnknownTopicsAndActionsStillDecode() async throws {
        core.topics = ["status", "telepathy.changed"]
        core.status = FakeCore.snapshot(revision: 1, account: ["state": "error", "action": "reinstall_the_core"])
        let client = CoreClient(socketPath: core.path)
        let (hello, events) = try await client.subscribe(topics: [.status])
        XCTAssertEqual(hello.topics, [.status, .unknown("telepathy.changed")])
        var iterator = events.makeAsyncIterator()
        guard case .status(let snapshot)? = await iterator.next() else { return XCTFail("no snapshot") }
        XCTAssertEqual(snapshot.account.action, .unknown("reinstall_the_core"))
        XCTAssertEqual(snapshot.account.action?.rawValue, "reinstall_the_core")

        XCTAssertNil(CoreEvent.decode(topic: "telepathy.changed", data: Data("{}".utf8)))
        XCTAssertEqual(Topic(rawValue: "status"), .status)
        XCTAssertFalse(Topic.allCases.contains(.unknown("telepathy.changed")))
        let encoded = try JSONEncoder().encode([Topic.unknown("telepathy.changed")])
        XCTAssertEqual(String(decoding: encoded, as: UTF8.self), #"["telepathy.changed"]"#)
    }

    func testSubscriptionStartsWithTheSnapshotAndCarriesEvents() async throws {
        let client = CoreClient(socketPath: core.path)
        let (hello, events) = try await client.subscribe(topics: [.status, .invalidated, .signIn, .notify])
        XCTAssertEqual(hello.daemonVersion, "1.0.0")
        var iterator = events.makeAsyncIterator()
        guard case .status(let first)? = await iterator.next() else { return XCTFail("no snapshot") }
        XCTAssertEqual(first.account.state, .signedOut)
        XCTAssertTrue(first.workspace.isFound)

        core.publish("invalidated", ["what": "agents"])
        guard case .invalidated(Invalidation(what: .agents))? = await iterator.next() else { return XCTFail("no invalidation") }

        core.publish("sign_in", ["state": "pending_approval", "phase": "waiting_for_browser",
                                 "verification_url": "https://agentrelay.com/login",
                                 "verification_url_complete": "https://agentrelay.com/login?x=1", "user_code": NSNull()])
        guard case .signIn(let signIn)? = await iterator.next() else { return XCTFail("no sign-in") }
        XCTAssertEqual(signIn.account.state, .pendingApproval)
        XCTAssertEqual(signIn.link, "https://agentrelay.com/login?x=1")

        core.publish("notify", ["title": "Connect GitHub", "body": "Approve in the browser.", "link": NSNull()])
        guard case .notify(let note)? = await iterator.next() else { return XCTFail("no notification") }
        XCTAssertEqual(note.title, "Connect GitHub")

        core.stop()
        let ended = await iterator.next()
        XCTAssertNil(ended)
    }

    /// The snapshot exactly as the real core printed it for a fresh home.
    func testDecodesTheCoresSnapshot() throws {
        let json = """
        {"account":{"action":null,"error":null,"person":null,"phase":null,"progress":null,"reused_login":null,"site_url":null,"state":"signed_out","workspace_id":null,"workspace_name":null},"agents":{"delivery_error":null,"store_error":null},"daemon":{"bridge_version":2,"pid":93671,"socket":"/tmp/ar4/core.sock","started_at_ms":1790822262759,"version":"0.26.2"},"machine":{"host_name":"Wills-MacBook-Pro-2.local","machine_prefix":"wills-macbook-pro-2"},"push":{"codex-api-3f72":{"state":"waiting","retry_in_ms":3712}},"revision":1,"workspace":{"base_url":null,"checked_at_ms":null,"state":"missing","verification":"pending","workspace_id":null,"workspace_name":null}}
        """
        let status = try CoreClient.decoder.decode(Status.self, from: Data(json.utf8))
        XCTAssertEqual(status.daemon.version, "0.26.2")
        XCTAssertFalse(status.workspace.isFound)
        XCTAssertEqual(status.push["codex-api-3f72"], .waiting(retryInMs: 3712))
    }

    func testIntegersAboveInt64MaxStayExact() throws {
        let large = try CoreClient.decoder.decode(JSONValue.self, from: Data("18446744073709551615".utf8))
        XCTAssertEqual(large, .unsigned(UInt64.max))
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(large), as: UTF8.self), "18446744073709551615")
        XCTAssertEqual(try CoreClient.decoder.decode(JSONValue.self, from: Data("-1".utf8)), .integer(-1))
    }

    /// The app writes parameters; a required nullable one is sent as `null`,
    /// never left out.
    func testARequiredNullableParameterIsSentAsNull() throws {
        let json = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(ReplySettingParams(enabled: nil, name: "codex-api"))) as? [String: Any]
        XCTAssertEqual(json?.keys.sorted(), ["enabled", "name"])
        XCTAssertTrue(json?["enabled"] is NSNull)
    }
}
