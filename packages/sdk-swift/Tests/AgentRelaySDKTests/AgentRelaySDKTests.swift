import Foundation
import XCTest
import Relaycast
@testable import AgentRelaySDK

/// These tests cover the hosted-participant facade that now wraps the relaycast
/// Swift engine SDK. Network-dependent behaviour (registration, posting, the
/// realtime socket) is exercised by the relaycast package's own test suite; here
/// we verify the facade configuration and the bridging glue that keeps
/// AgentRelaySDK's public surface intact on top of relaycast.
final class HostedParticipantSDKTests: XCTestCase {
    private enum AsyncTestTimeout: Error {
        case exceeded
    }

    private func makeParticipantCore() throws -> HostedParticipantCore {
        HostedParticipantCore(
            engineSource: .deferred(
                relayResult: Result { try Relaycast.RelayCast(options: Relaycast.RelayCastOptions(apiKey: "rk_test")) },
                token: "at_test"
            ),
            agentId: "a1",
            agentName: "alice",
            token: "at_test",
            baseURL: URL(string: "https://cast.agentrelay.com")!
        )
    }

    private func waitUntil(_ predicate: @escaping () async -> Bool) async throws {
        for _ in 0..<2_000 {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("Timed out waiting for async condition")
        throw AsyncTestTimeout.exceeded
    }

    private func withTimeout<T: Sendable>(
        _ operation: @escaping @Sendable () async -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                throw AsyncTestTimeout.exceeded
            }
            guard let result = try await group.next() else {
                throw AsyncTestTimeout.exceeded
            }
            group.cancelAll()
            return result
        }
    }

    // MARK: - Facade configuration

    func testClientInitDefaultsToHostedGateway() {
        let client = AgentRelayClient(apiKey: "rk_test_key")
        XCTAssertEqual(client.workspaceKey, "rk_test_key")
        XCTAssertEqual(client.baseURL.absoluteString, "https://cast.agentrelay.com")
    }

    func testClientHonoursExplicitBaseURL() {
        let client = AgentRelayClient(apiKey: "rk_test_key", baseURL: URL(string: "https://example.test")!)
        XCTAssertEqual(client.baseURL.absoluteString, "https://example.test")
    }

    func testRelayCastInitUsesConfiguredHost() throws {
        // Sanity-check that relaycast accepts the preserved host explicitly.
        let relay = try Relaycast.RelayCast(
            options: Relaycast.RelayCastOptions(apiKey: "rk_test", baseURL: "https://gateway.relaycast.dev")
        )
        XCTAssertEqual(relay.client.baseURL.absoluteString, "https://gateway.relaycast.dev")
    }

    // MARK: - Type bridging

    func testAgentTypeBridging() {
        XCTAssertEqual(RelayAgentType.agent.relaycastType, .agent)
        XCTAssertEqual(RelayAgentType.human.relaycastType, .human)
        XCTAssertEqual(RelayAgentType.system.relaycastType, .system)
    }

    func testAgentStatusBridging() {
        XCTAssertEqual(RelayAgentStatus(Relaycast.AgentStatus.online), .online)
        XCTAssertEqual(RelayAgentStatus(Relaycast.AgentStatus.offline), .offline)
        XCTAssertEqual(RelayAgentStatus(Relaycast.AgentStatus.away), .away)

        let lifecycleStatuses: [(String, RelayAgentStatus)] = [
            ("active", .online),
            ("idle", .away),
            ("blocked", .away),
            ("waiting", .away),
        ]
        for (rawValue, expected) in lifecycleStatuses {
            XCTAssertEqual(RelayAgentStatus(hosted: rawValue), expected)
            if let relaycastStatus = Relaycast.AgentStatus(rawValue: rawValue) {
                XCTAssertEqual(RelayAgentStatus(relaycastStatus), expected)
            }
        }
        XCTAssertEqual(RelayAgentStatus(hosted: "future-status"), .unknown)
    }

    func testJSONValueBridgingPreservesShape() {
        let relaycastValue: Relaycast.JSONValue = .object([
            "text": .string("hi"),
            "count": .int(3),
            "ratio": .double(1.5),
            "flag": .bool(true),
            "items": .array([.string("a"), .int(2)]),
            "nothing": .null
        ])
        let bridged = JSONValue(relaycastValue)
        guard case .object(let object) = bridged else {
            return XCTFail("Expected object")
        }
        XCTAssertEqual(object["text"], .string("hi"))
        XCTAssertEqual(object["count"], .number(3))
        XCTAssertEqual(object["ratio"], .number(1.5))
        XCTAssertEqual(object["flag"], .bool(true))
        XCTAssertEqual(object["items"], .array([.string("a"), .number(2)]))
        XCTAssertEqual(object["nothing"], .null)
    }

    func testErrorBridgingIsLiteralForGenericAPIErrors() {
        // The generic bridge must not guess: a bare 409 means different
        // things on different endpoints (channel/trigger/node conflicts,
        // not just agent registration), so it passes the original code
        // through unchanged.
        let relaycastError = Relaycast.RelayError.api(
            code: "channel_already_exists",
            message: "name_taken",
            statusCode: 409,
            retryable: false
        )
        let bridged = RelayError(relaycastError)
        guard case .protocolError(let code, let message, _) = bridged else {
            return XCTFail("Expected protocolError")
        }
        XCTAssertEqual(code, "channel_already_exists")
        XCTAssertEqual(message, "name_taken")
    }

    func testRegistrationConflictAwareErrorMapsBareConflictToAlreadyExists() {
        // Agent registration is the one place a bare 409 unambiguously means
        // a name conflict, even when relaycast's own `code` is generic.
        let relaycastError = Relaycast.RelayError.api(
            code: "some_code",
            message: "name_taken",
            statusCode: 409,
            retryable: false
        )
        let bridged = HostedWorkspaceCore.registrationConflictAwareError(relaycastError)
        guard case .protocolError(let code, let message, _) = bridged else {
            return XCTFail("Expected protocolError")
        }
        XCTAssertEqual(code, "agent_already_exists")
        XCTAssertEqual(message, "name_taken")
    }

    func testRegistrationConflictAwareErrorLeavesNonConflictsAlone() {
        let relaycastError = Relaycast.RelayError.api(
            code: "rate_limited",
            message: "slow down",
            statusCode: 429,
            retryable: true
        )
        let bridged = HostedWorkspaceCore.registrationConflictAwareError(relaycastError)
        guard case .protocolError(let code, let message, let retryable) = bridged else {
            return XCTFail("Expected protocolError")
        }
        XCTAssertEqual(code, "rate_limited")
        XCTAssertEqual(message, "slow down")
        XCTAssertTrue(retryable)
    }

    func testErrorBridgingMapsNotConnected() {
        if case .notConnected = RelayError(Relaycast.RelayError.notConnected) {
            // ok
        } else {
            XCTFail("Expected notConnected")
        }
    }

    // MARK: - Realtime event glue

    func testRelayEventFromWsEventExtractsMessageFields() {
        // relaycast emits flat events: type plus payload fields at the top level.
        let wsEvent = Relaycast.WsEvent(type: "message.created", payload: [
            "channel": .string("general"),
            "message": .object([
                "id": .string("msg_1"),
                "message_id": .string("msg_1"),
                "body": .string("hello"),
                "from": .object(["name": .string("alice")]),
                "channel": .object(["name": .string("general")])
            ])
        ])

        let event = RelayEvent(wsEvent)
        XCTAssertEqual(event.type, "message.created")
        XCTAssertEqual(event.channel, "general")
        XCTAssertEqual(event.message?.text, "hello")
        XCTAssertEqual(event.message?.from.name, "alice")
        XCTAssertEqual(event.message?.channel?.name, "general")
    }

    func testRelayEventFromWsEventResolvesSenderFromMessageLevelAgentFields() {
        // relaycast's actual realtime wire shape carries the sender as
        // `agent_id`/`agent_name` directly on the message object rather than
        // a nested `from` object. Without a fallback here, `from` silently
        // resolves to an empty sender ("unknown" once surfaced as a
        // `RelayChannelEvent`).
        let wsEvent = Relaycast.WsEvent(type: "message.created", payload: [
            "channel": .string("general"),
            "message": .object([
                "id": .string("msg_1"),
                "message_id": .string("msg_1"),
                "body": .string("hello"),
                "agent_id": .string("agent_1"),
                "agent_name": .string("bob"),
                "channel": .object(["name": .string("general")])
            ])
        ])

        let event = RelayEvent(wsEvent)
        XCTAssertEqual(event.message?.from.id, "agent_1")
        XCTAssertEqual(event.message?.from.name, "bob")
    }

    func testRelayEventFromWsEventExtractsActionInvocationFields() {
        let wsEvent = Relaycast.WsEvent(type: "action.invoked", payload: [
            "invocation_id": .string("inv_1"),
            "action_name": .string("echo"),
            "caller_name": .string("alice")
        ])

        let event = RelayEvent(wsEvent)
        XCTAssertEqual(event.type, "action.invoked")
        XCTAssertEqual(event.invocationId, "inv_1")
        XCTAssertEqual(event.actionName, "echo")
        XCTAssertEqual(event.callerName, "alice")
    }

    func testRelayEventFromWsEventPreservesTypeWithEmptyPayload() {
        let event = RelayEvent(Relaycast.WsEvent(type: "pong"))
        XCTAssertEqual(event.type, "pong")
        XCTAssertNil(event.message)
    }

    // MARK: - Registration lifecycle

    /// A persisted `AgentRegistration` must stay usable even if the owning
    /// `AgentRelay`/`HostedWorkspaceCore` is released before `asClient()` is
    /// called. The factory captures the relay/baseURL transport state strongly,
    /// so this must not trap.
    func testRegistrationAsClientSurvivesCoreRelease() throws {
        let response = try makeCreateAgentResponse(id: "agent_1", name: "swift-agent", token: "rk_token")

        var core: HostedWorkspaceCore? = HostedWorkspaceCore(
            workspaceKey: "rk_test_key",
            baseURL: URL(string: "https://gateway.relaycast.dev")!
        )
        let registration = core!.makeRegistration(response)

        // Drop the owning core before using the persisted registration.
        core = nil

        let client = registration.asClient()
        XCTAssertEqual(client.id, "agent_1")
        XCTAssertEqual(client.name, "swift-agent")
        XCTAssertEqual(client.token, "rk_token")
    }

    private func makeCreateAgentResponse(id: String, name: String, token: String) throws -> Relaycast.CreateAgentResponse {
        let json = """
        {"id":"\(id)","name":"\(name)","token":"\(token)","status":"online","createdAt":"2026-06-20T00:00:00Z"}
        """
        return try JSONDecoder().decode(Relaycast.CreateAgentResponse.self, from: Data(json.utf8))
    }

    // MARK: - Action handle lifecycle

    func testActionHandleExposesName() async {
        let handle = ActionHandle(name: "echo") { }
        XCTAssertEqual(handle.name, "echo")
        await handle.unregister()
    }

    // MARK: - AsyncStream lifecycle

    func testCancellingPublicStreamsRemovesContinuationsAcrossEpochs() async throws {
        let core = try makeParticipantCore()
        let client = AgentClient(core: core, id: "a1", name: "alice", token: "at_test")

        for _ in 0..<20 {
            let eventTask = Task { for await _ in client.events {} }
            let inboundTask = Task { for await _ in client.inboundMessages {} }
            let stateTask = Task { for await _ in client.connectionState {} }

            try await waitUntil {
                let counts = await core.continuationCounts()
                return counts.events == 1 && counts.inbound == 1 && counts.connectionState == 1
            }

            eventTask.cancel()
            inboundTask.cancel()
            stateTask.cancel()
            _ = await (eventTask.value, inboundTask.value, stateTask.value)

            try await waitUntil {
                let counts = await core.continuationCounts()
                return counts.events == 0 && counts.inbound == 0 && counts.connectionState == 0
            }
        }
    }

    func testChannelDoesNotRegisterUntilEventsAreRequested() async throws {
        let core = try makeParticipantCore()
        let channel = RelayChannel(name: "ops", core: core)
        let initialCounts = await core.continuationCounts()
        XCTAssertEqual(initialCounts.channels, 0)

        let task = Task { for await _ in channel.events {} }
        try await waitUntil { await core.continuationCounts().channels == 1 }

        task.cancel()
        _ = await task.value
        try await waitUntil { await core.continuationCounts().channels == 0 }
    }

    func testTerminationBeforeRegistrationDoesNotResurrectContinuation() async throws {
        let core = try makeParticipantCore()
        let id = UUID()
        var continuationRef: AsyncStream<RelayEvent>.Continuation?
        _ = AsyncStream<RelayEvent> { continuationRef = $0 }

        let continuation = try XCTUnwrap(continuationRef)
        let generation = core.streamLifecycle.snapshot()
        await Task {
            withUnsafeCurrentTask { $0?.cancel() }
            await core.registerEventContinuation(continuation, id: id, generation: generation)
        }.value

        let counts = await core.continuationCounts()
        XCTAssertEqual(counts.events, 0)
    }

    func testRegistrationFromBeforeDisconnectCannotResurrectStream() async throws {
        let core = try makeParticipantCore()
        let id = UUID()
        let staleGeneration = core.streamLifecycle.snapshot()
        var continuationRef: AsyncStream<RelayEvent>.Continuation?
        let stream = AsyncStream<RelayEvent> { continuationRef = $0 }

        await core.disconnect()
        await core.registerEventContinuation(try XCTUnwrap(continuationRef), id: id, generation: staleGeneration)

        let first = try await withTimeout { await stream.first(where: { _ in true }) }
        XCTAssertNil(first)
        let counts = await core.continuationCounts()
        XCTAssertEqual(counts.events, 0)
    }

    func testDisconnectIsIdempotentAndFinishesLiveStreams() async throws {
        let core = try makeParticipantCore()
        let client = AgentClient(core: core, id: "a1", name: "alice", token: "at_test")
        let task = Task { for await _ in client.events {} }
        try await waitUntil { await core.continuationCounts().events == 1 }

        await client.disconnect()
        await client.disconnect()
        _ = await task.value

        let counts = await core.continuationCounts()
        XCTAssertEqual(counts.events, 0)
    }

    func testDisconnectDoesNotLeaveEmptyChannelRegistries() async throws {
        let core = try makeParticipantCore()

        for epoch in 0..<20 {
            let channel = RelayChannel(name: "ops-\(epoch)", core: core)
            let task = Task { for await _ in channel.events {} }
            try await waitUntil { await core.continuationCounts().channels == 1 }

            await core.disconnect()
            _ = await task.value
            try await waitUntil {
                let counts = await core.continuationCounts()
                return counts.channels == 0 && counts.channelRegistries == 0
            }
        }
    }

    func testEventAndConnectionStateBuffersDropOldestValues() async throws {
        let core = try makeParticipantCore()
        let client = AgentClient(core: core, id: "a1", name: "alice", token: "at_test")
        let eventStream = client.events
        let stateStream = client.connectionState
        try await waitUntil {
            let counts = await core.continuationCounts()
            return counts.events == 1 && counts.connectionState == 1
        }

        for index in 0..<300 {
            await core.routeEvent(RelayEvent(type: "event.\(index)"))
        }
        await core.notifyConnectionState(.connected)
        await core.notifyConnectionState(.disconnected)

        let eventTypes = try await withTimeout {
            var eventIterator = eventStream.makeAsyncIterator()
            var types: [String] = []
            for _ in 0..<256 {
                guard let event = await eventIterator.next() else { break }
                types.append(event.type)
            }
            return types
        }
        XCTAssertEqual(eventTypes.count, 256)
        XCTAssertEqual(eventTypes.first, "event.44")
        XCTAssertEqual(eventTypes.last, "event.299")

        let state = try await withTimeout {
            var stateIterator = stateStream.makeAsyncIterator()
            return await stateIterator.next()
        }
        guard case .disconnected? = state else {
            return XCTFail("Expected only the newest connection state")
        }
    }
}
