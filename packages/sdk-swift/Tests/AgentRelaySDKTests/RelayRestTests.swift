import Foundation
import XCTest
@testable import AgentRelaySDK

/// Tests for the internal `RelayRestClient` that serves outbound action
/// invocation and message history. All responses are scripted through a
/// `URLProtocol` stub registered on an ephemeral `URLSession` — no network.
final class RelayRestTests: XCTestCase {

    private var client: RelayRestClient!

    override func setUp() {
        super.setUp()
        StubURLProtocol.store.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: configuration)
        client = RelayRestClient(
            baseURL: URL(string: "https://stub.test")!,
            token: "at_test_token",
            session: session
        )
    }

    // MARK: - Envelope

    func testEnvelopeOkDataDecodesAndSendsAgentBearerToken() async throws {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":[
            {"id":"conv_1","type":"1:1","name":null,
             "participants":[{"agent_id":"agent_1","agent_name":"alice"}],
             "last_message":null,"unread_count":0,"created_at":"2026-07-01T09:00:00Z"}
        ]}
        """))

        let rows: [DmConversationSummaryRow] = try await client.get("/v1/dm/conversations")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].id, "conv_1")
        XCTAssertEqual(rows[0].type, "1:1")
        XCTAssertEqual(rows[0].participants?.first?.agentName, "alice")

        let request = try XCTUnwrap(StubURLProtocol.store.recordedRequests().first)
        XCTAssertEqual(request.url?.path, "/v1/dm/conversations")
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.headers["Authorization"], "Bearer at_test_token")
    }

    func testErrorEnvelopeMapsToProtocolError() async {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":false,"error":{"code":"not_found","message":"channel missing"}}
        """))

        do {
            let _: [ChannelMessageRow] = try await client.get("/v1/channels/nope/messages")
            XCTFail("Expected RelayError")
        } catch let error as RelayError {
            guard case .protocolError(let code, let message, let retryable) = error else {
                return XCTFail("Expected protocolError, got \(error)")
            }
            XCTAssertEqual(code, "not_found")
            XCTAssertEqual(message, "channel missing")
            XCTAssertFalse(retryable)
        } catch {
            XCTFail("Expected RelayError, got \(error)")
        }
    }

    func testErrorEnvelopeRateLimitedIsRetryable() async {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":false,"error":{"code":"rate_limited","message":"slow down"}}
        """))

        do {
            let _: [DmConversationSummaryRow] = try await client.get("/v1/dm/conversations")
            XCTFail("Expected RelayError")
        } catch let error as RelayError {
            guard case .protocolError(let code, _, let retryable) = error else {
                return XCTFail("Expected protocolError, got \(error)")
            }
            XCTAssertEqual(code, "rate_limited")
            XCTAssertTrue(retryable)
        } catch {
            XCTFail("Expected RelayError, got \(error)")
        }
    }

    func testTerminalTicketUsesScopedParticipantCredentialAndTypedBody() async throws {
        StubURLProtocol.store.enqueue(StubResponse(statusCode: 201, json: """
        {"ok":true,"data":{
          "session_id":"term_1",
          "terminal_url":"https://stub.test/v1/nodes/sf-mini/terminal/connect?ticket=tt_live_redacted",
          "resume_token":"tr_live_redacted",
          "expires_at":"2026-08-13T14:00:00Z"
        }}
        """))

        let ticket = try await client.createTerminalSession(
            node: "sf mini/primary",
            agent: "chief",
            mode: .drive
        )

        XCTAssertEqual(ticket.sessionId, "term_1")
        XCTAssertEqual(ticket.resumeToken, "tr_live_redacted")
        let request = try XCTUnwrap(StubURLProtocol.store.recordedRequests().first)
        XCTAssertEqual(request.url?.path, "/v1/nodes/sf mini/primary/terminal/sessions")
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["Authorization"], "Bearer at_test_token")
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(object, ["agent": "chief", "mode": "drive"])
    }

    func testRetries429ThenSucceedsWithSecondRequest() async throws {
        // First attempt is rate limited (Retry-After: 0 keeps the test fast);
        // the retry succeeds and the caller only observes the success.
        StubURLProtocol.store.enqueue(StubResponse(
            statusCode: 429,
            headers: ["Retry-After": "0"],
            json: """
            {"ok":false,"error":{"code":"rate_limited","message":"slow down"}}
            """
        ))
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":[
            {"id":"conv_1","type":"1:1","name":null,
             "participants":[{"agent_id":"agent_1","agent_name":"alice"}],
             "last_message":null,"unread_count":0,"created_at":"2026-07-01T09:00:00Z"}
        ]}
        """))

        let rows: [DmConversationSummaryRow] = try await client.get("/v1/dm/conversations")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].id, "conv_1")
        // Retry-and-recover really executed: two requests hit the wire.
        XCTAssertEqual(StubURLProtocol.store.recordedRequests().count, 2)
    }

    // MARK: - invokeAction

    func testInvokeActionHappyPathPollsUntilCompleted() async throws {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_1","action_name":"demo.echo",
         "handler_agent_id":"agent_9","input":{"message":"hi"},
         "status":"invoked","created_at":"2026-07-01T10:00:00Z"}}
        """))
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_1","action_name":"demo.echo",
         "caller_id":"agent_1","caller_name":"alice","input":{"message":"hi"},
         "output":null,"status":"invoked","error":null,
         "duration_ms":null,"completed_at":null}}
        """))
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_1","action_name":"demo.echo",
         "caller_id":"agent_1","caller_name":"alice","input":{"message":"hi"},
         "output":{"echo":"hi"},"status":"completed","error":null,
         "duration_ms":42,"completed_at":"2026-07-01T10:00:01Z"}}
        """))

        let output = try await client.invokeAction(
            "demo.echo",
            input: .object(["message": .string("hi")]),
            timeout: 5,
            pollInterval: 0.01
        )
        XCTAssertEqual(output, .object(["echo": .string("hi")]))

        let requests = StubURLProtocol.store.recordedRequests()
        XCTAssertEqual(requests.count, 3)
        // Dots in the action name are preserved in the request path.
        XCTAssertEqual(requests[0].url?.path, "/v1/actions/demo.echo/invoke")
        XCTAssertEqual(requests[0].method, "POST")
        XCTAssertEqual(requests[0].headers["Content-Type"], "application/json")
        XCTAssertEqual(requests[1].url?.path, "/v1/actions/demo.echo/invocations/inv_1")
        XCTAssertEqual(requests[1].method, "GET")
        XCTAssertEqual(requests[2].url?.path, "/v1/actions/demo.echo/invocations/inv_1")

        // The invoke body wraps the payload under "input".
        let body = try XCTUnwrap(requests[0].body)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: body)
        XCTAssertEqual(decoded, .object(["input": .object(["message": .string("hi")])]))
    }

    func testInvokeActionFailedStatusThrowsActionFailed() async {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_2","action_name":"demo.echo",
         "input":{},"status":"invoked","created_at":"2026-07-01T10:00:00Z"}}
        """))
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_2","action_name":"demo.echo",
         "caller_id":null,"input":{},"output":null,"status":"failed",
         "error":"boom","duration_ms":7,"completed_at":"2026-07-01T10:00:01Z"}}
        """))

        do {
            _ = try await client.invokeAction("demo.echo", input: .object([:]), timeout: 5, pollInterval: 0.01)
            XCTFail("Expected RelayError")
        } catch let error as RelayError {
            guard case .protocolError(let code, let message, let retryable) = error else {
                return XCTFail("Expected protocolError, got \(error)")
            }
            XCTAssertEqual(code, "action_failed")
            XCTAssertEqual(message, "boom")
            XCTAssertFalse(retryable)
        } catch {
            XCTFail("Expected RelayError, got \(error)")
        }
    }

    func testInvokeActionDeniedStatusThrowsActionDenied() async {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_3","action_name":"demo.echo",
         "input":{},"status":"invoked","created_at":"2026-07-01T10:00:00Z"}}
        """))
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_3","action_name":"demo.echo",
         "input":{},"output":null,"status":"denied","error":null,
         "duration_ms":null,"completed_at":null}}
        """))

        do {
            _ = try await client.invokeAction("demo.echo", input: .object([:]), timeout: 5, pollInterval: 0.01)
            XCTFail("Expected RelayError")
        } catch let error as RelayError {
            guard case .protocolError(let code, let message, _) = error else {
                return XCTFail("Expected protocolError, got \(error)")
            }
            XCTAssertEqual(code, "action_denied")
            // With a null wire error the status is used as the message.
            XCTAssertEqual(message, "denied")
        } catch {
            XCTFail("Expected RelayError, got \(error)")
        }
    }

    func testInvokeActionTimesOutWhileInvoked() async {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_4","action_name":"demo.echo",
         "input":{},"status":"invoked","created_at":"2026-07-01T10:00:00Z"}}
        """))
        // Every poll keeps reporting "invoked".
        StubURLProtocol.store.setFallback(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_4","action_name":"demo.echo",
         "input":{},"output":null,"status":"invoked","error":null,
         "duration_ms":null,"completed_at":null}}
        """))

        do {
            _ = try await client.invokeAction("demo.echo", input: .object([:]), timeout: 0.05, pollInterval: 0.01)
            XCTFail("Expected RelayError.timeout")
        } catch let error as RelayError {
            guard case .timeout = error else {
                return XCTFail("Expected timeout, got \(error)")
            }
        } catch {
            XCTFail("Expected RelayError, got \(error)")
        }
    }

    func testInvokeActionUnknownTerminalStatusFailsFast() async {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_5","action_name":"demo.echo",
         "input":{},"status":"invoked","created_at":"2026-07-01T10:00:00Z"}}
        """))
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_5","action_name":"demo.echo",
         "input":{},"output":null,"status":"cancelled","error":null,
         "duration_ms":null,"completed_at":null}}
        """))

        do {
            _ = try await client.invokeAction("demo.echo", input: .object([:]), timeout: 5, pollInterval: 0.01)
            XCTFail("Expected RelayError")
        } catch let error as RelayError {
            guard case .protocolError(let code, let message, let retryable) = error else {
                return XCTFail("Expected protocolError, got \(error)")
            }
            XCTAssertEqual(code, "action_failed")
            XCTAssertTrue(message.contains("cancelled"), "message should name the unexpected status: \(message)")
            XCTAssertFalse(retryable)
        } catch {
            XCTFail("Expected RelayError, got \(error)")
        }
        // Fails fast: one invoke plus a single poll, no further polling.
        XCTAssertEqual(StubURLProtocol.store.recordedRequests().count, 2)
    }

    func testInvokeActionTimeoutNotExtendedByLargePollInterval() async {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_6","action_name":"demo.echo",
         "input":{},"status":"invoked","created_at":"2026-07-01T10:00:00Z"}}
        """))
        // Every poll keeps reporting "invoked".
        StubURLProtocol.store.setFallback(StubResponse(json: """
        {"ok":true,"data":{"invocation_id":"inv_6","action_name":"demo.echo",
         "input":{},"output":null,"status":"invoked","error":null,
         "duration_ms":null,"completed_at":null}}
        """))

        let start = ProcessInfo.processInfo.systemUptime
        do {
            _ = try await client.invokeAction("demo.echo", input: .object([:]), timeout: 0.2, pollInterval: 60)
            XCTFail("Expected RelayError.timeout")
        } catch let error as RelayError {
            guard case .timeout = error else {
                return XCTFail("Expected timeout, got \(error)")
            }
        } catch {
            XCTFail("Expected RelayError, got \(error)")
        }
        // The poll sleep is clamped to the remaining budget, so the call must
        // finish near the 0.2s timeout rather than after the 60s pollInterval.
        // The bound is generous to absorb CI scheduling noise.
        let elapsed = ProcessInfo.processInfo.systemUptime - start
        XCTAssertLessThan(elapsed, 5)
    }

    // MARK: - channelHistory

    func testChannelHistoryStripsHashMapsRowsAndSortsAscending() async throws {
        // Newest-first on the wire; the client must return oldest-first.
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":[
            {"id":"msg_3","channel_id":"ch_1","agent_id":"agent_2","agent_name":"bob",
             "agent_type":"agent","text":"newest","thread_id":null,
             "created_at":"2026-07-01T10:00:02Z"},
            {"id":"msg_2","channel_id":"ch_1","agent_id":"agent_1",
             "text":"middle","thread_id":"msg_1",
             "created_at":"2026-07-01T10:00:01Z"},
            {"id":"msg_1","channel_id":"ch_1","agent_id":"agent_1","agent_name":"alice",
             "agent_type":"human","text":"oldest","thread_id":null,
             "created_at":"2026-07-01T10:00:00.500Z"}
        ]}
        """))

        let events = try await client.channelHistory(channel: "#general", limit: 3, before: "msg_9")

        // '#' is stripped from the request path; pagination goes via query.
        let request = try XCTUnwrap(StubURLProtocol.store.recordedRequests().first)
        XCTAssertEqual(request.url?.path, "/v1/channels/general/messages")
        let components = try XCTUnwrap(request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(query["limit"], "3")
        XCTAssertEqual(query["before"], "msg_9")

        XCTAssertEqual(events.map(\.messageId), ["msg_1", "msg_2", "msg_3"])
        XCTAssertEqual(events.map(\.body), ["oldest", "middle", "newest"])
        XCTAssertEqual(events[2].from, "bob")
        // Missing agent_name falls back to agent_id.
        XCTAssertEqual(events[1].from, "agent_1")
        XCTAssertEqual(events[1].threadId, "msg_1")
        XCTAssertEqual(events[0].channel, "general")
        XCTAssertNil(events[0].rawEvent)

        let formatter = ISO8601DateFormatter()
        XCTAssertEqual(events[2].timestamp, formatter.date(from: "2026-07-01T10:00:02Z"))
        // Fractional-second timestamps are tolerated.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertEqual(events[0].timestamp, fractional.date(from: "2026-07-01T10:00:00.500Z"))
    }

    func testChannelHistoryStableSortKeepsWireOrderOnTies() async throws {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":[
            {"id":"msg_a","channel_id":"ch_1","agent_id":"agent_1","agent_name":"alice",
             "text":"first on wire","created_at":"2026-07-01T10:00:00Z"},
            {"id":"msg_b","channel_id":"ch_1","agent_id":"agent_1","agent_name":"alice",
             "text":"second on wire","created_at":"2026-07-01T10:00:00Z"}
        ]}
        """))

        let events = try await client.channelHistory(channel: "general", limit: 2, before: nil)
        XCTAssertEqual(events.map(\.messageId), ["msg_a", "msg_b"])
    }

    // MARK: - dmHistory

    func testDmHistoryResolvesOneToOneConversationAndMapsRows() async throws {
        // The group conversation containing bob must be ignored; only the
        // 1:1 whose participants include bob resolves.
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":[
            {"id":"conv_group","type":"group","name":"team",
             "participants":[{"agent_id":"agent_1","agent_name":"alice"},
                             {"agent_id":"agent_2","agent_name":"bob"},
                             {"agent_id":"agent_3","agent_name":"carol"}],
             "last_message":null,"unread_count":0,"created_at":"2026-07-01T08:00:00Z"},
            {"id":"conv_11","type":"1:1","name":null,
             "participants":[{"agent_id":"agent_1","agent_name":"alice"},
                             {"agent_id":"agent_2","agent_name":"bob"}],
             "last_message":null,"unread_count":0,"created_at":"2026-07-01T09:00:00Z"}
        ]}
        """))
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":[
            {"id":"dm_2","agent_id":"agent_2","agent_name":"bob","agent_type":"agent",
             "text":"newer","created_at":"2026-07-01T09:31:00Z"},
            {"id":"dm_1","agent_id":"agent_1","agent_name":"alice","agent_type":"agent",
             "text":"older","created_at":"2026-07-01T09:30:00Z"}
        ]}
        """))

        let events = try await client.dmHistory(with: "@bob", limit: 10, before: nil)

        let requests = StubURLProtocol.store.recordedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.path, "/v1/dm/conversations")
        XCTAssertEqual(requests[1].url?.path, "/v1/dm/conv_11/messages")

        XCTAssertEqual(events.map(\.messageId), ["dm_1", "dm_2"])
        XCTAssertEqual(events.map(\.from), ["alice", "bob"])
        XCTAssertEqual(events.map(\.body), ["older", "newer"])
        // DM history rows have no channel and no thread.
        XCTAssertNil(events[0].channel)
        XCTAssertNil(events[0].threadId)
    }

    func testDmHistoryWithoutConversationReturnsEmptyWithoutSecondRequest() async throws {
        StubURLProtocol.store.enqueue(StubResponse(json: """
        {"ok":true,"data":[
            {"id":"conv_group","type":"group","name":"team",
             "participants":[{"agent_id":"agent_1","agent_name":"alice"},
                             {"agent_id":"agent_2","agent_name":"bob"}],
             "last_message":null,"unread_count":0,"created_at":"2026-07-01T08:00:00Z"}
        ]}
        """))

        let events = try await client.dmHistory(with: "bob", limit: 10, before: nil)
        XCTAssertEqual(events.count, 0)
        XCTAssertEqual(StubURLProtocol.store.recordedRequests().count, 1)
    }

    // MARK: - Pure row decoding

    func testActionInvokeAckDecodes() throws {
        let json = """
        {"invocation_id":"inv_1","action_name":"demo.echo","handler_agent_id":"agent_9",
         "input":{"message":"hi"},"status":"invoked","created_at":"2026-07-01T10:00:00Z"}
        """
        let ack = try JSONDecoder().decode(ActionInvokeAck.self, from: Data(json.utf8))
        XCTAssertEqual(ack.invocationId, "inv_1")
        XCTAssertEqual(ack.actionName, "demo.echo")
        XCTAssertEqual(ack.handlerAgentId, "agent_9")
        XCTAssertEqual(ack.input, .object(["message": .string("hi")]))
        XCTAssertEqual(ack.status, "invoked")
        XCTAssertEqual(ack.createdAt, "2026-07-01T10:00:00Z")
    }

    func testActionInvocationRecordDecodes() throws {
        let json = """
        {"invocation_id":"inv_1","action_name":"demo.echo","caller_id":"agent_1",
         "caller_name":"alice","input":{"message":"hi"},"output":{"echo":"hi"},
         "status":"completed","error":null,"duration_ms":42,
         "completed_at":"2026-07-01T10:00:01Z"}
        """
        let record = try JSONDecoder().decode(ActionInvocationRecord.self, from: Data(json.utf8))
        XCTAssertEqual(record.invocationId, "inv_1")
        XCTAssertEqual(record.callerName, "alice")
        XCTAssertEqual(record.output, .object(["echo": .string("hi")]))
        XCTAssertEqual(record.status, "completed")
        XCTAssertNil(record.error)
        XCTAssertEqual(record.durationMs, 42)
        XCTAssertEqual(record.completedAt, "2026-07-01T10:00:01Z")
    }

    func testChannelMessageRowDecodesAndIgnoresUnknownFields() throws {
        let json = """
        {"id":"msg_1","channel_id":"ch_1","agent_id":"agent_1","agent_name":"alice",
         "agent_type":"human","text":"hello","thread_id":"msg_0",
         "created_at":"2026-07-01T10:00:00Z","blocks":null,"workspace_id":"ws_1"}
        """
        let row = try JSONDecoder().decode(ChannelMessageRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.id, "msg_1")
        XCTAssertEqual(row.channelId, "ch_1")
        XCTAssertEqual(row.agentId, "agent_1")
        XCTAssertEqual(row.agentName, "alice")
        XCTAssertEqual(row.agentType, "human")
        XCTAssertEqual(row.text, "hello")
        XCTAssertEqual(row.threadId, "msg_0")
        XCTAssertEqual(row.createdAt, "2026-07-01T10:00:00Z")
    }

    func testDmConversationSummaryRowDecodes() throws {
        let json = """
        {"id":"conv_1","type":"1:1","name":null,
         "participants":[{"agent_id":"agent_1","agent_name":"alice"},
                         {"agent_id":"agent_2","agent_name":"bob"}],
         "last_message":{"id":"dm_9","text":"latest","agent_id":"agent_2",
                         "created_at":"2026-07-01T09:59:00Z"},
         "unread_count":2,"created_at":"2026-07-01T09:00:00Z"}
        """
        let row = try JSONDecoder().decode(DmConversationSummaryRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.id, "conv_1")
        XCTAssertEqual(row.type, "1:1")
        XCTAssertEqual(row.participants?.count, 2)
        XCTAssertEqual(row.participants?[1].agentId, "agent_2")
        XCTAssertEqual(row.participants?[1].agentName, "bob")
    }

    func testDmMessageRowDecodes() throws {
        let json = """
        {"id":"dm_1","agent_id":"agent_2","agent_name":"bob","agent_type":"agent",
         "text":"hi","injection_mode":"wait","created_at":"2026-07-01T09:30:00Z"}
        """
        let row = try JSONDecoder().decode(DmMessageRow.self, from: Data(json.utf8))
        XCTAssertEqual(row.id, "dm_1")
        XCTAssertEqual(row.agentId, "agent_2")
        XCTAssertEqual(row.agentName, "bob")
        XCTAssertEqual(row.agentType, "agent")
        XCTAssertEqual(row.text, "hi")
        XCTAssertEqual(row.createdAt, "2026-07-01T09:30:00Z")
    }
}

// MARK: - URLProtocol stub

/// A scripted HTTP response for `StubURLProtocol`.
struct StubResponse {
    let statusCode: Int
    let headers: [String: String]
    let body: Data

    init(statusCode: Int = 200, headers: [String: String] = [:], json: String) {
        self.statusCode = statusCode
        var merged = ["Content-Type": "application/json"]
        for (key, value) in headers {
            merged[key] = value
        }
        self.headers = merged
        self.body = Data(json.utf8)
    }
}

/// A request as observed by the stub, with the body materialized (URLSession
/// exposes outbound bodies to `URLProtocol` as a stream).
struct RecordedRequest {
    let url: URL?
    let method: String?
    let headers: [String: String]
    let body: Data?
}

/// Thread-safe FIFO script of responses plus recorded requests. Responses are
/// consumed in order; when the queue is empty the optional fallback response
/// is served repeatedly (used for poll-forever scenarios).
final class StubResponseStore: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [StubResponse] = []
    private var fallback: StubResponse?
    private var requests: [RecordedRequest] = []

    func enqueue(_ response: StubResponse) {
        lock.lock()
        defer { lock.unlock() }
        queue.append(response)
    }

    func setFallback(_ response: StubResponse) {
        lock.lock()
        defer { lock.unlock() }
        fallback = response
    }

    func next() -> StubResponse? {
        lock.lock()
        defer { lock.unlock() }
        if queue.isEmpty {
            return fallback
        }
        return queue.removeFirst()
    }

    func record(_ request: RecordedRequest) {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
    }

    func recordedRequests() -> [RecordedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        queue.removeAll()
        fallback = nil
        requests.removeAll()
    }
}

final class StubURLProtocol: URLProtocol {
    static let store = StubResponseStore()

    static override func canInit(with request: URLRequest) -> Bool { true }

    static override func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.store.record(
            RecordedRequest(
                url: request.url,
                method: request.httpMethod,
                headers: request.allHTTPHeaderFields ?? [:],
                body: Self.bodyData(of: request)
            )
        )

        guard let stub = Self.store.next(), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: stub.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: stub.headers
        ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func bodyData(of request: URLRequest) -> Data? {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 1024
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
