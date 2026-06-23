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
        XCTAssertEqual(client.baseURL.absoluteString, "https://gateway.relaycast.dev")
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

    func testErrorBridgingMapsConflictToAlreadyExists() {
        let relaycastError = Relaycast.RelayError.api(
            code: "some_code",
            message: "name_taken",
            statusCode: 409,
            retryable: false
        )
        let bridged = RelayError(relaycastError)
        guard case .protocolError(let code, let message, _) = bridged else {
            return XCTFail("Expected protocolError")
        }
        XCTAssertEqual(code, "agent_already_exists")
        XCTAssertEqual(message, "name_taken")
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

    // MARK: - Action handle lifecycle

    func testActionHandleExposesName() async {
        let handle = ActionHandle(name: "echo") { }
        XCTAssertEqual(handle.name, "echo")
        await handle.unregister()
    }
}
