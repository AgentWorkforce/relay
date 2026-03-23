import XCTest
@testable import AgentRelaySDK

// MARK: - Helpers

private func jsonData(_ jsonString: String) -> Data {
    jsonString.data(using: .utf8)!
}

private func decodeEvent(_ json: String) throws -> RelayObserverEvent {
    let decoder = JSONDecoder()
    return try decoder.decode(RelayObserverEvent.self, from: jsonData(json))
}

private func encodeToDict<T: Encodable>(_ value: T) throws -> [String: Any] {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    let data = try encoder.encode(value)
    return try JSONSerialization.jsonObject(with: data) as! [String: Any]
}

// MARK: - Event Type Raw Values

final class RelayObserverEventTypeTests: XCTestCase {

    func testAllRawValues() {
        let expected: [(RelayObserverEventType, String)] = [
            (.agentSpawned, "agent_spawned"),
            (.agentReleased, "agent_released"),
            (.agentIdle, "agent_idle"),
            (.agentStatus, "agent_status"),
            (.workerStream, "worker_stream"),
            (.delivery, "delivery"),
            (.channelMessage, "channel_message"),
            (.stepStarted, "step_started"),
            (.stepCompleted, "step_completed"),
            (.runCompleted, "run_completed"),
            (.relayConfig, "relay_config"),
            (.relayWorkspace, "relay_workspace"),
            (.commentPollTick, "comment_poll_tick"),
            (.commentDetected, "comment_detected"),
            (.error, "error"),
            (.ack, "ack"),
            (.connected, "connected"),
            (.subscribed, "subscribed"),
            (.pong, "pong"),
        ]

        XCTAssertEqual(expected.count, 19, "Should cover all 19 event types")

        for (eventType, rawValue) in expected {
            XCTAssertEqual(eventType.rawValue, rawValue, "Raw value mismatch for \(eventType)")
        }
    }

    func testRoundTripCodable() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        for eventType in [RelayObserverEventType.agentSpawned, .delivery, .pong, .error] {
            let data = try encoder.encode(eventType)
            let decoded = try decoder.decode(RelayObserverEventType.self, from: data)
            XCTAssertEqual(decoded, eventType)
        }
    }
}

// MARK: - Event Decoding Tests

final class RelayObserverEventDecodingTests: XCTestCase {

    // MARK: agent_spawned

    func testAgentSpawnedWithName() throws {
        let event = try decodeEvent("""
        {
            "type": "agent_spawned",
            "name": "worker-1",
            "cli": "claude",
            "channels": ["ch-1", "ch-2"]
        }
        """)
        XCTAssertEqual(event.type, .agentSpawned)
        XCTAssertEqual(event.name, "worker-1")
        XCTAssertNil(event.agentName)
        XCTAssertEqual(event.cli, "claude")
        XCTAssertEqual(event.channels, ["ch-1", "ch-2"])
    }

    func testAgentSpawnedWithAgentName() throws {
        let event = try decodeEvent("""
        {
            "type": "agent_spawned",
            "agent_name": "worker-2",
            "cli": "codex",
            "channels": ["ch-3"]
        }
        """)
        XCTAssertEqual(event.type, .agentSpawned)
        XCTAssertNil(event.name)
        XCTAssertEqual(event.agentName, "worker-2")
        XCTAssertEqual(event.cli, "codex")
        XCTAssertEqual(event.channels, ["ch-3"])
    }

    func testAgentSpawnedWithBothNames() throws {
        let event = try decodeEvent("""
        {
            "type": "agent_spawned",
            "name": "worker-a",
            "agent_name": "worker-b",
            "cli": "claude",
            "channels": []
        }
        """)
        XCTAssertEqual(event.name, "worker-a")
        XCTAssertEqual(event.agentName, "worker-b")
    }

    // MARK: agent_released

    func testAgentReleased() throws {
        let event = try decodeEvent("""
        {"type": "agent_released", "name": "worker-1", "reason": "task_complete"}
        """)
        XCTAssertEqual(event.type, .agentReleased)
        XCTAssertEqual(event.name, "worker-1")
        XCTAssertEqual(event.reason, "task_complete")
    }

    // MARK: agent_idle

    func testAgentIdle() throws {
        let event = try decodeEvent("""
        {"type": "agent_idle", "name": "worker-1", "idle_secs": 120}
        """)
        XCTAssertEqual(event.type, .agentIdle)
        XCTAssertEqual(event.name, "worker-1")
        XCTAssertEqual(event.idleSecs, 120)
    }

    // MARK: agent_status

    func testAgentStatus() throws {
        let event = try decodeEvent("""
        {"type": "agent_status", "name": "worker-1", "status": "busy"}
        """)
        XCTAssertEqual(event.type, .agentStatus)
        XCTAssertEqual(event.name, "worker-1")
        XCTAssertEqual(event.status, "busy")
    }

    // MARK: worker_stream

    func testWorkerStream() throws {
        let event = try decodeEvent("""
        {"type": "worker_stream", "agent": "worker-1", "data": "hello world", "stream": "stdout"}
        """)
        XCTAssertEqual(event.type, .workerStream)
        XCTAssertEqual(event.agent, "worker-1")
        XCTAssertEqual(event.data, "hello world")
        XCTAssertEqual(event.stream, "stdout")
    }

    // MARK: delivery

    func testDeliveryCompleted() throws {
        let event = try decodeEvent("""
        {
            "type": "delivery",
            "id": "msg-1",
            "from": "lead",
            "to": "worker-1",
            "text": "do this task",
            "state": "completed"
        }
        """)
        XCTAssertEqual(event.type, .delivery)
        XCTAssertEqual(event.id, "msg-1")
        XCTAssertEqual(event.from, "lead")
        XCTAssertEqual(event.to, "worker-1")
        XCTAssertEqual(event.text, "do this task")
        XCTAssertEqual(event.state, "completed")
    }

    func testDeliveryFailed() throws {
        let event = try decodeEvent("""
        {
            "type": "delivery",
            "id": "msg-2",
            "from": "lead",
            "to": "worker-2",
            "text": "another task",
            "state": "failed"
        }
        """)
        XCTAssertEqual(event.type, .delivery)
        XCTAssertEqual(event.state, "failed")
    }

    // MARK: channel_message

    func testChannelMessage() throws {
        let event = try decodeEvent("""
        {
            "type": "channel_message",
            "channel": "general",
            "from": "user-1",
            "text": "hey team",
            "timestamp": "2026-03-23T10:00:00Z"
        }
        """)
        XCTAssertEqual(event.type, .channelMessage)
        XCTAssertEqual(event.channel, "general")
        XCTAssertEqual(event.from, "user-1")
        XCTAssertEqual(event.text, "hey team")
        XCTAssertEqual(event.timestamp, "2026-03-23T10:00:00Z")
    }

    // MARK: step_started

    func testStepStartedWithStep() throws {
        let event = try decodeEvent("""
        {"type": "step_started", "step": "build"}
        """)
        XCTAssertEqual(event.type, .stepStarted)
        XCTAssertEqual(event.step, "build")
        XCTAssertNil(event.stepName)
    }

    func testStepStartedWithStepName() throws {
        let event = try decodeEvent("""
        {"type": "step_started", "step_name": "compile"}
        """)
        XCTAssertEqual(event.type, .stepStarted)
        XCTAssertNil(event.step)
        XCTAssertEqual(event.stepName, "compile")
    }

    func testStepStartedWithBothStepFields() throws {
        let event = try decodeEvent("""
        {"type": "step_started", "step": "step-1", "step_name": "Build App"}
        """)
        XCTAssertEqual(event.step, "step-1")
        XCTAssertEqual(event.stepName, "Build App")
    }

    // MARK: step_completed

    func testStepCompleted() throws {
        let event = try decodeEvent("""
        {"type": "step_completed", "step": "build", "step_name": "Build App", "output": "success"}
        """)
        XCTAssertEqual(event.type, .stepCompleted)
        XCTAssertEqual(event.step, "build")
        XCTAssertEqual(event.stepName, "Build App")
        XCTAssertEqual(event.output, "success")
    }

    // MARK: run_completed

    func testRunCompleted() throws {
        let event = try decodeEvent("""
        {"type": "run_completed", "run_id": "run-abc-123"}
        """)
        XCTAssertEqual(event.type, .runCompleted)
        XCTAssertEqual(event.runId, "run-abc-123")
    }

    // MARK: relay_config

    func testRelayConfig() throws {
        let event = try decodeEvent("""
        {"type": "relay_config", "observer_url": "wss://relay.example.com/observe"}
        """)
        XCTAssertEqual(event.type, .relayConfig)
        XCTAssertEqual(event.observerUrl, "wss://relay.example.com/observe")
    }

    // MARK: relay_workspace

    func testRelayWorkspace() throws {
        let event = try decodeEvent("""
        {"type": "relay_workspace", "workspace_id": "ws-42"}
        """)
        XCTAssertEqual(event.type, .relayWorkspace)
        XCTAssertEqual(event.workspaceId, "ws-42")
    }

    // MARK: comment_poll_tick

    func testCommentPollTick() throws {
        let event = try decodeEvent("""
        {"type": "comment_poll_tick", "checked_at": "2026-03-23T12:00:00Z", "interval_seconds": 30}
        """)
        XCTAssertEqual(event.type, .commentPollTick)
        XCTAssertEqual(event.checkedAt, "2026-03-23T12:00:00Z")
        XCTAssertEqual(event.intervalSeconds, 30)
    }

    // MARK: comment_detected

    func testCommentDetected() throws {
        let event = try decodeEvent("""
        {"type": "comment_detected", "message": "New comment on PR #42"}
        """)
        XCTAssertEqual(event.type, .commentDetected)
        XCTAssertEqual(event.message, "New comment on PR #42")
    }

    // MARK: error

    func testError() throws {
        let event = try decodeEvent("""
        {"type": "error", "message": "something went wrong"}
        """)
        XCTAssertEqual(event.type, .error)
        XCTAssertEqual(event.message, "something went wrong")
    }

    // MARK: ack

    func testAck() throws {
        let event = try decodeEvent("""
        {"type": "ack"}
        """)
        XCTAssertEqual(event.type, .ack)
    }

    // MARK: connected

    func testConnected() throws {
        let event = try decodeEvent("""
        {"type": "connected"}
        """)
        XCTAssertEqual(event.type, .connected)
    }

    // MARK: subscribed

    func testSubscribed() throws {
        let event = try decodeEvent("""
        {"type": "subscribed", "channel": "ops"}
        """)
        XCTAssertEqual(event.type, .subscribed)
        XCTAssertEqual(event.channel, "ops")
    }

    // MARK: pong

    func testPong() throws {
        let event = try decodeEvent("""
        {"type": "pong"}
        """)
        XCTAssertEqual(event.type, .pong)
    }
}

// MARK: - Optional Fields (minimal event)

final class RelayObserverEventOptionalFieldsTests: XCTestCase {

    func testMinimalAckHasAllOptionalsNil() throws {
        let event = try decodeEvent("""
        {"type": "ack"}
        """)
        XCTAssertEqual(event.type, .ack)
        XCTAssertNil(event.name)
        XCTAssertNil(event.agentName)
        XCTAssertNil(event.cli)
        XCTAssertNil(event.channels)
        XCTAssertNil(event.reason)
        XCTAssertNil(event.idleSecs)
        XCTAssertNil(event.status)
        XCTAssertNil(event.agent)
        XCTAssertNil(event.data)
        XCTAssertNil(event.stream)
        XCTAssertNil(event.id)
        XCTAssertNil(event.from)
        XCTAssertNil(event.to)
        XCTAssertNil(event.text)
        XCTAssertNil(event.state)
        XCTAssertNil(event.channel)
        XCTAssertNil(event.timestamp)
        XCTAssertNil(event.step)
        XCTAssertNil(event.stepName)
        XCTAssertNil(event.output)
        XCTAssertNil(event.runId)
        XCTAssertNil(event.observerUrl)
        XCTAssertNil(event.workspaceId)
        XCTAssertNil(event.checkedAt)
        XCTAssertNil(event.intervalSeconds)
        XCTAssertNil(event.message)
    }
}

// MARK: - Outbound Message Encoding

final class RelayObserverOutboundEncodingTests: XCTestCase {

    func testSubscribeMessage() throws {
        let msg = ObserverSubscribeMessage(channel: "ops")
        let dict = try encodeToDict(msg)
        XCTAssertEqual(dict["type"] as? String, "subscribe")
        XCTAssertEqual(dict["channel"] as? String, "ops")
        XCTAssertEqual(dict.count, 2)
    }

    func testChannelSendMessageFull() throws {
        let msg = ObserverChannelSendMessage(
            channel: "general",
            text: "hello",
            personas: ["lead", "worker"],
            cliPreferences: ["model": "opus"]
        )
        let dict = try encodeToDict(msg)
        XCTAssertEqual(dict["type"] as? String, "channel_send")
        XCTAssertEqual(dict["channel"] as? String, "general")
        XCTAssertEqual(dict["text"] as? String, "hello")
        XCTAssertEqual(dict["personas"] as? [String], ["lead", "worker"])
        let prefs = dict["cli_preferences"] as? [String: String]
        XCTAssertEqual(prefs?["model"], "opus")
    }

    func testChannelSendMessageMinimal() throws {
        let msg = ObserverChannelSendMessage(
            channel: "ops",
            text: "ping",
            personas: nil,
            cliPreferences: nil
        )
        let dict = try encodeToDict(msg)
        XCTAssertEqual(dict["type"] as? String, "channel_send")
        XCTAssertEqual(dict["channel"] as? String, "ops")
        XCTAssertEqual(dict["text"] as? String, "ping")
        // nil optionals should not be present
        XCTAssertNil(dict["personas"])
        XCTAssertNil(dict["cli_preferences"])
    }

    func testDirectSendMessage() throws {
        let msg = ObserverDirectSendMessage(to: "worker-1", text: "do it")
        let dict = try encodeToDict(msg)
        XCTAssertEqual(dict["type"] as? String, "send")
        XCTAssertEqual(dict["to"] as? String, "worker-1")
        XCTAssertEqual(dict["text"] as? String, "do it")
        XCTAssertEqual(dict.count, 3)
    }
}

// MARK: - RelayObserverError Tests

final class RelayObserverErrorTests: XCTestCase {

    func testNotConnectedDescription() {
        let error = RelayObserverError.notConnected
        XCTAssertEqual(error.errorDescription, "Relay not connected")
        XCTAssertEqual(error.localizedDescription, "Relay not connected")
    }

    func testEncodingFailedDescription() {
        let error = RelayObserverError.encodingFailed
        XCTAssertEqual(error.errorDescription, "Message encoding failed")
        XCTAssertEqual(error.localizedDescription, "Message encoding failed")
    }
}

// MARK: - ConnectionState Tests

final class RelayObserverConnectionStateTests: XCTestCase {

    func testEquatable() {
        XCTAssertEqual(RelayObserver.ConnectionState.disconnected, .disconnected)
        XCTAssertEqual(RelayObserver.ConnectionState.connecting, .connecting)
        XCTAssertEqual(RelayObserver.ConnectionState.connected, .connected)
        XCTAssertEqual(
            RelayObserver.ConnectionState.reconnecting(attempt: 3),
            .reconnecting(attempt: 3)
        )
    }

    func testNotEqual() {
        XCTAssertNotEqual(RelayObserver.ConnectionState.disconnected, .connecting)
        XCTAssertNotEqual(RelayObserver.ConnectionState.connected, .disconnected)
        XCTAssertNotEqual(
            RelayObserver.ConnectionState.reconnecting(attempt: 1),
            .reconnecting(attempt: 2)
        )
        XCTAssertNotEqual(
            RelayObserver.ConnectionState.reconnecting(attempt: 1),
            .connected
        )
    }
}

// MARK: - RelayObserver Init Tests

final class RelayObserverInitTests: XCTestCase {

    func testDefaultState() {
        let observer = RelayObserver()
        XCTAssertEqual(observer.connectionState, .disconnected)
        XCTAssertEqual(observer.eventCounter, 0)
        XCTAssertNil(observer.lastEvent)
    }

    func testCustomInit() {
        let observer = RelayObserver(maxReconnectAttempts: 3, baseReconnectDelay: 2.0)
        XCTAssertEqual(observer.connectionState, .disconnected)
        XCTAssertEqual(observer.eventCounter, 0)
        XCTAssertNil(observer.lastEvent)
    }

    func testSendChannelThrowsWhenDisconnected() {
        let observer = RelayObserver()
        XCTAssertThrowsError(try observer.sendChannel(channel: "ops", text: "hi")) { error in
            XCTAssertEqual(error as? RelayObserverError, .notConnected)
        }
    }

    func testSendDirectThrowsWhenDisconnected() {
        let observer = RelayObserver()
        XCTAssertThrowsError(try observer.sendDirect(to: "agent", text: "hi")) { error in
            XCTAssertEqual(error as? RelayObserverError, .notConnected)
        }
    }
}
