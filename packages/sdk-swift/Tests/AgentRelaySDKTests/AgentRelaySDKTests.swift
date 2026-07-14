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
}
