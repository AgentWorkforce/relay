import Foundation
import XCTest
@testable import AgentRelaySDK

private actor MockHostedHTTP: HostedHTTPClient {
    struct Request: Sendable {
        let method: String
        let path: String
        let body: Data?
    }

    private var requests: [Request] = []
    private var getResponses: [String: Data]
    private var postResponses: [String: Data]
    private var postErrors: [String: Error]

    init(getResponses: [String: Data] = [:], postResponses: [String: Data] = [:], postErrors: [String: Error] = [:]) {
        self.getResponses = getResponses
        self.postResponses = postResponses
        self.postErrors = postErrors
    }

    func get(path: String, query: [String: String]?) async throws -> Data {
        requests.append(Request(method: "GET", path: path, body: nil))
        return getResponses[path] ?? Self.envelope(#"{}"#)
    }

    func post(path: String, body: Data?) async throws -> Data {
        requests.append(Request(method: "POST", path: path, body: body))
        if let error = postErrors[path] {
            throw error
        }
        return postResponses[path] ?? Self.envelope(#"{}"#)
    }

    func delete(path: String) async throws -> Data {
        requests.append(Request(method: "DELETE", path: path, body: nil))
        return Self.envelope(#"{}"#)
    }

    func allRequests() -> [Request] {
        requests
    }

    static func envelope(_ dataJSON: String) -> Data {
        Data(#"{"ok":true,"data":\#(dataJSON)}"#.utf8)
    }
}

private actor MockHostedTransport: HostedEventTransportClient {
    nonisolated let inbound: AsyncStream<Data>

    private let continuation: AsyncStream<Data>.Continuation
    private var sent: [Data] = []
    private var connectCount = 0
    private var onConnect: (@Sendable () async -> Void)?

    init() {
        var continuationRef: AsyncStream<Data>.Continuation?
        self.inbound = AsyncStream<Data> { continuation in
            continuationRef = continuation
        }
        self.continuation = continuationRef!
    }

    func setOnConnect(_ handler: @escaping @Sendable () async -> Void) async {
        onConnect = handler
    }

    func connect() async throws {
        connectCount += 1
    }

    func disconnect() async {
        continuation.finish()
    }

    func send(_ message: Data) async throws {
        sent.append(message)
    }

    func emit(_ json: String) {
        continuation.yield(Data(json.utf8))
    }

    func sentMessages() -> [Data] {
        sent
    }

    func connections() -> Int {
        connectCount
    }

    func triggerReconnect() async {
        await onConnect?()
    }
}

private actor StringRecorder {
    private var values: [String] = []

    func append(_ value: String) {
        values.append(value)
    }

    func all() -> [String] {
        values
    }
}

private func jsonObject(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func waitForRequest(
    in http: MockHostedHTTP,
    timeout: TimeInterval = 1.0,
    matching predicate: (MockHostedHTTP.Request) throws -> Bool
) async throws -> MockHostedHTTP.Request {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        let requests = await http.allRequests()
        for request in requests.reversed() {
            if try predicate(request) {
                return request
            }
        }
        try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("Timed out waiting for matching request")
    return MockHostedHTTP.Request(method: "GET", path: "", body: nil)
}

final class HostedParticipantSDKTests: XCTestCase {
    func testClientInitUsesProvidedBaseURL() {
        let client = AgentRelayClient(apiKey: "rk_test_key", baseURL: URL(string: "https://relay.example.com")!)
        XCTAssertEqual(client.workspaceKey, "rk_test_key")
        XCTAssertEqual(client.baseURL.absoluteString, "https://relay.example.com")
    }

    func testHostedWebSocketURLUsesV1WSAndToken() {
        let url = RelayEventTransport.resolveWebSocketURL(
            baseURL: URL(string: "https://relay.example.com")!,
            token: "at_test"
        )
        XCTAssertEqual(url?.scheme, "wss")
        XCTAssertEqual(url?.path, "/v1/ws")
        XCTAssertTrue(url?.query?.contains("token=at_test") == true)
    }

    func testHostedAPIURLAppendsV1Path() {
        let url = HostedHTTP.resolveAPIURL(baseURL: URL(string: "https://relay.example.com")!, path: "/v1/dm")
        XCTAssertEqual(url?.absoluteString, "https://relay.example.com/v1/dm")
    }

    func testRegisterOrRotateTreatsAgentAlreadyExistsAsConflict() async throws {
        let workspaceHTTP = MockHostedHTTP(
            getResponses: [
                "/v1/agents/swift-agent": MockHostedHTTP.envelope(
                    #"{"id":"ag_existing","name":"swift-agent","type":"agent","status":"online","created_at":"2026-01-01T00:00:00Z"}"#
                )
            ],
            postResponses: [
                "/v1/agents/swift-agent/rotate-token": MockHostedHTTP.envelope(#"{"token":"at_rotated"}"#)
            ],
            postErrors: [
                "/v1/agents": RelayError.protocolError(
                    code: "agent_already_exists",
                    message: "name_taken",
                    retryable: false
                )
            ]
        )
        let core = HostedWorkspaceCore(
            workspaceKey: "rk_test",
            baseURL: URL(string: "https://relay.example.com")!,
            http: workspaceHTTP
        )

        let registration = try await core.registerOrRotate(name: "swift-agent", type: .agent)

        XCTAssertEqual(registration.id, "ag_existing")
        XCTAssertEqual(registration.name, "swift-agent")
        XCTAssertEqual(registration.token, "at_rotated")
        let requests = await workspaceHTTP.allRequests()
        XCTAssertEqual(
            requests.map { "\($0.method) \($0.path)" },
            [
                "POST /v1/agents",
                "GET /v1/agents/swift-agent",
                "POST /v1/agents/swift-agent/rotate-token"
            ]
        )
    }

    func testAgentClientPostsChannelAndDirectMessagesToHostedEndpoints() async throws {
        let workspaceHTTP = MockHostedHTTP()
        let agentHTTP = MockHostedHTTP()
        let transport = MockHostedTransport()
        let core = HostedParticipantCore(
            agentId: "ag_1",
            agentName: "swift-agent",
            token: "at_test",
            baseURL: URL(string: "https://relay.example.com")!,
            workspaceHTTP: workspaceHTTP,
            agentHTTP: agentHTTP,
            transport: transport
        )
        let client = AgentClient(core: core, id: "ag_1", name: "swift-agent", token: "at_test")

        try await client.post(to: "#general", message: "hello")
        try await client.dm(to: "@reviewer", message: "ping")

        let requests = await agentHTTP.allRequests()
        XCTAssertEqual(requests.map(\.path), ["/v1/channels/general/messages", "/v1/dm"])
        let channelBody = try jsonObject(try XCTUnwrap(requests[0].body))
        XCTAssertEqual(channelBody["text"] as? String, "hello")
        XCTAssertEqual(channelBody["mode"] as? String, "wait")
        let dmBody = try jsonObject(try XCTUnwrap(requests[1].body))
        XCTAssertEqual(dmBody["to"] as? String, "reviewer")
        XCTAssertEqual(dmBody["text"] as? String, "ping")
    }

    func testChannelSubscribeSendsHostedSubscribeFrameAndRoutesMessages() async throws {
        let transport = MockHostedTransport()
        let core = HostedParticipantCore(
            agentId: "ag_1",
            agentName: "swift-agent",
            token: "at_test",
            baseURL: URL(string: "https://relay.example.com")!,
            workspaceHTTP: MockHostedHTTP(),
            agentHTTP: MockHostedHTTP(),
            transport: transport
        )
        let client = AgentClient(core: core, id: "ag_1", name: "swift-agent", token: "at_test")
        let channel = client.channel("general")
        try await channel.subscribe()
        var sentMessages = await transport.sentMessages()
        XCTAssertEqual(sentMessages.count, 1)
        await transport.triggerReconnect()
        sentMessages = await transport.sentMessages()
        XCTAssertEqual(sentMessages.count, 2)

        let messages = channel.events
        let task = Task { () -> RelayChannelEvent? in
            for await event in messages {
                return event
            }
            return nil
        }

        await transport.emit(
            """
            {
              "type": "message.received",
              "payload": {
                "channel": "general",
                "message": {
                  "id": "msg_1",
                  "body": "hello",
                  "from": {"name": "alice"},
                  "channel": {"name": "general"}
                }
              }
            }
            """
        )

        let maybeEvent = await task.value
        let event = try XCTUnwrap(maybeEvent)
        XCTAssertEqual(event.from, "alice")
        XCTAssertEqual(event.body, "hello")
        XCTAssertEqual(event.channel, "general")
    }

    func testRegisterActionPostsDescriptorAndCompletesHostedInvocation() async throws {
        let invocationPath = "/v1/actions/echo/invocations/inv_1"
        let completionPath = "\(invocationPath)/complete"
        let workspaceHTTP = MockHostedHTTP()
        let agentHTTP = MockHostedHTTP(
            getResponses: [
                invocationPath: MockHostedHTTP.envelope(
                    #"{"invocation_id":"inv_1","action_name":"echo","caller_name":"alice","input":{"text":"hello"},"status":"invoked"}"#
                )
            ],
            postResponses: [
                completionPath: MockHostedHTTP.envelope(
                    #"{"invocation_id":"inv_1","action_name":"echo","status":"completed","output":{"ok":true},"error":null,"duration_ms":1,"completed_at":"2026-01-01T00:00:00Z"}"#
                )
            ]
        )
        let transport = MockHostedTransport()
        let core = HostedParticipantCore(
            agentId: "ag_1",
            agentName: "swift-agent",
            token: "at_test",
            baseURL: URL(string: "https://relay.example.com")!,
            workspaceHTTP: workspaceHTTP,
            agentHTTP: agentHTTP,
            transport: transport
        )
        let client = AgentClient(core: core, id: "ag_1", name: "swift-agent", token: "at_test")
        let recorder = StringRecorder()

        _ = try await client.registerAction(
            name: "echo",
            description: "Echo input",
            inputSchemaJSON: #"{"type":"object","properties":{"text":{"type":"string"}}}"#
        ) { input in
            await recorder.append(input)
            return #"{"ok":true}"#
        }

        let descriptor = try await waitForRequest(in: workspaceHTTP) { request in
            request.method == "POST" && request.path == "/v1/actions"
        }
        let descriptorBody = try jsonObject(try XCTUnwrap(descriptor.body))
        XCTAssertEqual(descriptorBody["name"] as? String, "echo")
        XCTAssertEqual(descriptorBody["description"] as? String, "Echo input")
        XCTAssertEqual(descriptorBody["handler_agent"] as? String, "swift-agent")
        XCTAssertEqual((descriptorBody["input_schema"] as? [String: Any])?["type"] as? String, "object")

        await transport.emit(
            """
            {
              "type": "action.invoked",
              "payload": {
                "type": "action.invoked",
                "invocation_id": "inv_1",
                "action_name": "echo",
                "caller_name": "alice"
              }
            }
            """
        )

        let completion = try await waitForRequest(in: agentHTTP) { request in
            request.method == "POST" && request.path == completionPath
        }
        let completionBody = try jsonObject(try XCTUnwrap(completion.body))
        XCTAssertEqual((completionBody["output"] as? [String: Any])?["ok"] as? Bool, true)

        let inputs = await recorder.all()
        XCTAssertEqual(inputs.count, 1)
        let input = try jsonObject(Data(inputs[0].utf8))
        XCTAssertEqual(input["text"] as? String, "hello")
    }

    func testRegisterActionWrapsScalarHandlerOutput() async throws {
        let invocationPath = "/v1/actions/plain/invocations/inv_scalar"
        let completionPath = "\(invocationPath)/complete"
        let workspaceHTTP = MockHostedHTTP()
        let agentHTTP = MockHostedHTTP(
            getResponses: [
                invocationPath: MockHostedHTTP.envelope(
                    #"{"invocation_id":"inv_scalar","action_name":"plain","caller_name":"alice","input":{},"status":"invoked"}"#
                )
            ],
            postResponses: [
                completionPath: MockHostedHTTP.envelope(
                    #"{"invocation_id":"inv_scalar","action_name":"plain","status":"completed","output":{"value":"done"},"error":null}"#
                )
            ]
        )
        let transport = MockHostedTransport()
        let core = HostedParticipantCore(
            agentId: "ag_1",
            agentName: "swift-agent",
            token: "at_test",
            baseURL: URL(string: "https://relay.example.com")!,
            workspaceHTTP: workspaceHTTP,
            agentHTTP: agentHTTP,
            transport: transport
        )
        let client = AgentClient(core: core, id: "ag_1", name: "swift-agent", token: "at_test")

        _ = try await client.registerAction(
            name: "plain",
            description: "Plain output",
            inputSchemaJSON: #"{"type":"object"}"#
        ) { _ in
            "done"
        }

        await transport.emit(
            """
            {
              "type": "action.invoked",
              "payload": {
                "action_name": "plain",
                "invocation_id": "inv_scalar",
                "caller_name": "alice"
              }
            }
            """
        )

        let completion = try await waitForRequest(in: agentHTTP) { request in
            request.method == "POST" && request.path == completionPath
        }
        let completionBody = try jsonObject(try XCTUnwrap(completion.body))
        XCTAssertEqual((completionBody["output"] as? [String: Any])?["value"] as? String, "done")
    }

    func testUnregisterActionDeletesHostedDescriptor() async throws {
        let workspaceHTTP = MockHostedHTTP()
        let core = HostedParticipantCore(
            agentId: "ag_1",
            agentName: "swift-agent",
            token: "at_test",
            baseURL: URL(string: "https://relay.example.com")!,
            workspaceHTTP: workspaceHTTP,
            agentHTTP: MockHostedHTTP(),
            transport: MockHostedTransport()
        )
        let client = AgentClient(core: core, id: "ag_1", name: "swift-agent", token: "at_test")

        let handle = try await client.registerAction(
            name: "cleanup",
            description: "Cleanup",
            inputSchemaJSON: #"{"type":"object"}"#
        ) { _ in
            "{}"
        }
        await handle.unregister()

        let requests = await workspaceHTTP.allRequests()
        XCTAssertTrue(requests.contains { $0.method == "DELETE" && $0.path == "/v1/actions/cleanup" })
    }
}

private extension HostedParticipantCore {
    func transportAsMock() -> MockHostedTransport? {
        transport as? MockHostedTransport
    }
}
