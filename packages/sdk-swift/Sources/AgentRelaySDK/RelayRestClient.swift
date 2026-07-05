import Foundation

// MARK: - Wire types (snake_case hosted REST API)

/// Ack returned by `POST /v1/actions/{name}/invoke`. The ack does NOT carry
/// the action output; callers poll the invocation record for completion.
struct ActionInvokeAck: Decodable, Sendable {
    let invocationId: String
    let actionName: String?
    let handlerAgentId: String?
    let input: JSONValue?
    let status: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case input, status
        case invocationId = "invocation_id"
        case actionName = "action_name"
        case handlerAgentId = "handler_agent_id"
        case createdAt = "created_at"
    }
}

/// Invocation record returned by
/// `GET /v1/actions/{name}/invocations/{invocationId}`. `status` transitions
/// `invoked` → `completed` | `failed` | `denied`.
struct ActionInvocationRecord: Decodable, Sendable {
    let invocationId: String
    let actionName: String?
    let callerId: String?
    let callerName: String?
    let input: JSONValue?
    let output: JSONValue?
    let status: String
    let error: String?
    let durationMs: Double?
    let completedAt: String?

    enum CodingKeys: String, CodingKey {
        case input, output, status, error
        case invocationId = "invocation_id"
        case actionName = "action_name"
        case callerId = "caller_id"
        case callerName = "caller_name"
        case durationMs = "duration_ms"
        case completedAt = "completed_at"
    }
}

/// Row returned by `GET /v1/channels/{name}/messages`. Unlisted wire fields
/// (blocks, attachments, ...) are ignored; everything but `id` is optional so
/// decoding stays lenient, matching `RelayMessage`'s house style.
struct ChannelMessageRow: Decodable, Sendable {
    let id: String
    let channelId: String?
    let agentId: String?
    let agentName: String?
    let agentType: String?
    let text: String?
    let threadId: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, text
        case channelId = "channel_id"
        case agentId = "agent_id"
        case agentName = "agent_name"
        case agentType = "agent_type"
        case threadId = "thread_id"
        case createdAt = "created_at"
    }
}

/// Row returned by `GET /v1/dm/conversations`.
struct DmConversationSummaryRow: Decodable, Sendable {
    struct Participant: Decodable, Sendable {
        let agentId: String?
        let agentName: String?

        enum CodingKeys: String, CodingKey {
            case agentId = "agent_id"
            case agentName = "agent_name"
        }
    }

    let id: String
    let type: String?
    let participants: [Participant]?

    enum CodingKeys: String, CodingKey {
        case id, type, participants
    }
}

/// Row returned by `GET /v1/dm/{conversationId}/messages`. DM rows carry no
/// `thread_id` or `conversation_id`.
struct DmMessageRow: Decodable, Sendable {
    let id: String
    let agentId: String?
    let agentName: String?
    let agentType: String?
    let text: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, text
        case agentId = "agent_id"
        case agentName = "agent_name"
        case agentType = "agent_type"
        case createdAt = "created_at"
    }
}

// MARK: - RelayRestClient

/// Internal REST client for the hosted API endpoints the facade serves
/// directly over HTTP: outbound action invocation and message history. Owned
/// per-`AgentClient` and authenticated with the AGENT token (`at_...`), not
/// the workspace key.
///
/// Every non-204 response uses the envelope
/// `{"ok": true, "data": ...}` / `{"ok": false, "error": {"code", "message"}}`.
/// HTTP 429/500/502/503/504 are retried up to `maxRetries` times with
/// exponential backoff plus jitter; a `Retry-After` header on 429 overrides
/// the computed backoff.
struct RelayRestClient: Sendable {
    let baseURL: URL
    let token: String
    let session: URLSession

    private static let retryStatuses: Set<Int> = [429, 500, 502, 503, 504]
    private static let maxRetries = 2
    private static let baseBackoff: TimeInterval = 0.25

    init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    // MARK: - Actions

    /// Invoke a relay action and wait for its output via the two-phase async
    /// RPC: `POST .../invoke` returns an ack (no output), then the invocation
    /// record is polled until it reaches a terminal status or `timeout`
    /// elapses. Polling keeps the call deterministic and independent of the
    /// realtime socket; listening for the WS `action.completed` event instead
    /// is a future latency optimization.
    func invokeAction(_ name: String, input: JSONValue, timeout: TimeInterval, pollInterval: TimeInterval) async throws -> JSONValue {
        let actionName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actionName.isEmpty else {
            throw RelayError.protocolError(code: "invalid_action_name", message: "Action name cannot be empty", retryable: false)
        }

        let encodedName = Self.encodePathSegment(actionName)
        let ack: ActionInvokeAck = try await post(
            "/v1/actions/\(encodedName)/invoke",
            body: ActionInvokeRequestBody(input: input)
        )
        let encodedInvocation = Self.encodePathSegment(ack.invocationId)
        let deadline = Date().addingTimeInterval(timeout)

        while true {
            let record: ActionInvocationRecord = try await get(
                "/v1/actions/\(encodedName)/invocations/\(encodedInvocation)"
            )
            switch record.status {
            case "completed":
                return record.output ?? .null
            case "failed":
                throw RelayError.protocolError(code: "action_failed", message: record.error ?? record.status, retryable: false)
            case "denied":
                throw RelayError.protocolError(code: "action_denied", message: record.error ?? record.status, retryable: false)
            default:
                break
            }
            if Date() >= deadline {
                throw RelayError.timeout("Action '\(actionName)' did not complete within \(timeout)s (invocation \(ack.invocationId))")
            }
            // Task.sleep throws CancellationError when the caller is cancelled,
            // which aborts the poll loop promptly.
            try await Self.sleep(seconds: pollInterval)
        }
    }

    // MARK: - History

    /// Fetch channel history mapped to `RelayChannelEvent`, oldest-first.
    /// Nothing on the wire guarantees ordering, so rows are stably sorted
    /// ascending by timestamp to give UIs a consistent contract.
    func channelHistory(channel: String, limit: Int, before: String?, after: String? = nil) async throws -> [RelayChannelEvent] {
        let name = HostedParticipantCore.normalizeChannel(channel)
        let rows: [ChannelMessageRow] = try await get(
            "/v1/channels/\(Self.encodePathSegment(name))/messages",
            query: Self.historyQuery(limit: limit, before: before, after: after)
        )
        let events = rows.map { row in
            RelayChannelEvent(
                from: row.agentName ?? row.agentId ?? "unknown",
                body: row.text ?? "",
                channel: name,
                threadId: row.threadId,
                messageId: row.id,
                timestamp: Self.date(from: row.createdAt),
                rawEvent: nil
            )
        }
        return Self.sortedOldestFirst(events)
    }

    /// Fetch the 1:1 DM history with a named agent, oldest-first. There is no
    /// single-shot endpoint: the 1:1 conversation is resolved from
    /// `GET /v1/dm/conversations` first, then its messages are fetched. No
    /// existing conversation is not an error — it returns `[]`.
    func dmHistory(with agent: String, limit: Int, before: String?, after: String? = nil) async throws -> [RelayChannelEvent] {
        let target = HostedParticipantCore.stripSigil(agent)
        let conversations: [DmConversationSummaryRow] = try await get("/v1/dm/conversations")
        let match = conversations.first { conversation in
            conversation.type == "1:1"
                && (conversation.participants ?? []).contains { $0.agentName == target }
        }
        guard let conversation = match else { return [] }

        let rows: [DmMessageRow] = try await get(
            "/v1/dm/\(Self.encodePathSegment(conversation.id))/messages",
            query: Self.historyQuery(limit: limit, before: before, after: after)
        )
        let events = rows.map { row in
            RelayChannelEvent(
                from: row.agentName ?? row.agentId ?? "unknown",
                body: row.text ?? "",
                channel: nil,
                threadId: nil,
                messageId: row.id,
                timestamp: Self.date(from: row.createdAt),
                rawEvent: nil
            )
        }
        return Self.sortedOldestFirst(events)
    }

    // MARK: - Generic transport

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send(method: "GET", path: path, query: query, body: nil)
    }

    func post<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        let data: Data
        do {
            data = try JSONEncoder().encode(body)
        } catch {
            throw RelayError.encodingFailed("Failed to encode request body for \(path): \(error)")
        }
        return try await send(method: "POST", path: path, query: [], body: data)
    }

    private func send<T: Decodable>(method: String, path: String, query: [URLQueryItem], body: Data?) async throws -> T {
        var attempt = 0
        while true {
            let request = try makeRequest(method: method, path: path, query: query, body: body)
            let result: (Data, URLResponse)
            do {
                result = try await session.data(for: request)
            } catch {
                if attempt < Self.maxRetries {
                    attempt += 1
                    try await Self.sleep(seconds: Self.backoffDelay(attempt: attempt))
                    continue
                }
                throw RelayError.connectionFailed("Request to \(path) failed: \(error.localizedDescription)")
            }
            let (data, response) = result
            guard let http = response as? HTTPURLResponse else {
                throw RelayError.connectionFailed("Non-HTTP response from \(path)")
            }
            if Self.retryStatuses.contains(http.statusCode), attempt < Self.maxRetries {
                attempt += 1
                let delay = http.statusCode == 429
                    ? (Self.retryAfterSeconds(http) ?? Self.backoffDelay(attempt: attempt))
                    : Self.backoffDelay(attempt: attempt)
                try await Self.sleep(seconds: delay)
                continue
            }
            if http.statusCode == 204 {
                throw RelayError.decodingFailed("Unexpected empty (204) response from \(path)")
            }
            return try Self.decodeEnvelope(data: data, statusCode: http.statusCode, path: path)
        }
    }

    private func makeRequest(method: String, path: String, query: [URLQueryItem], body: Data?) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw RelayError.invalidBaseURL(baseURL.absoluteString)
        }
        var basePath = components.percentEncodedPath
        if basePath.hasSuffix("/") { basePath.removeLast() }
        // `path` arrives with its segments already percent-encoded.
        components.percentEncodedPath = basePath + path
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else {
            throw RelayError.invalidBaseURL("\(baseURL.absoluteString)\(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    // MARK: - Envelope

    private struct RestEnvelope<T: Decodable>: Decodable {
        let ok: Bool
        let data: T?
        let error: RestErrorPayload?
    }

    private struct RestErrorPayload: Decodable {
        let code: String?
        let message: String?
    }

    private struct ActionInvokeRequestBody: Encodable {
        let input: JSONValue
    }

    private static func decodeEnvelope<T: Decodable>(data: Data, statusCode: Int, path: String) throws -> T {
        let envelope: RestEnvelope<T>
        do {
            envelope = try JSONDecoder().decode(RestEnvelope<T>.self, from: data)
        } catch {
            if !(200...299).contains(statusCode) {
                throw RelayError.protocolError(
                    code: "http_\(statusCode)",
                    message: "HTTP \(statusCode) from \(path)",
                    retryable: statusCode == 429 || statusCode >= 500
                )
            }
            throw RelayError.decodingFailed("Invalid API envelope from \(path): \(error)")
        }
        if envelope.ok {
            guard let payload = envelope.data else {
                throw RelayError.decodingFailed("API envelope from \(path) is missing data")
            }
            return payload
        }
        let code = envelope.error?.code ?? "unknown_error"
        let message = envelope.error?.message ?? "Unknown error"
        throw RelayError.protocolError(code: code, message: message, retryable: Self.isRetryable(code: code, statusCode: statusCode))
    }

    private static func isRetryable(code: String, statusCode: Int) -> Bool {
        switch code {
        case "rate_limited", "rate_limit_exceeded", "backpressure", "queue_overloaded":
            return true
        default:
            return statusCode == 429 || statusCode >= 500
        }
    }

    // MARK: - Retry / backoff

    private static func backoffDelay(attempt: Int) -> TimeInterval {
        // attempt is 1-based: 0.25s, 0.5s, plus up to 100ms of jitter.
        baseBackoff * pow(2.0, Double(attempt - 1)) + Double.random(in: 0...0.1)
    }

    private static func retryAfterSeconds(_ response: HTTPURLResponse) -> TimeInterval? {
        // Only the delta-seconds form is honored; an HTTP-date value falls
        // back to the computed backoff.
        guard let header = response.value(forHTTPHeaderField: "Retry-After"),
              let seconds = TimeInterval(header), seconds >= 0 else {
            return nil
        }
        return seconds
    }

    private static func sleep(seconds: TimeInterval) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
    }

    // MARK: - Helpers

    /// RFC 3986 unreserved characters. Dots stay unescaped so dotted action
    /// names (e.g. `deploy.staging`) keep their wire form in the path.
    private static let pathSegmentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    static func encodePathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: pathSegmentAllowed) ?? value
    }

    private static func historyQuery(limit: Int, before: String?, after: String?) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let before {
            items.append(URLQueryItem(name: "before", value: before))
        }
        if let after {
            items.append(URLQueryItem(name: "after", value: after))
        }
        return items
    }

    /// Parse an ISO-8601 timestamp, tolerating fractional seconds. Mirrors
    /// `HostedParticipantCore.date(from:)`, falling back to `Date()`.
    private static func date(from timestamp: String?) -> Date {
        guard let timestamp else { return Date() }
        if let date = ISO8601DateFormatter().date(from: timestamp) {
            return date
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: timestamp) ?? Date()
    }

    /// Stable ascending sort by timestamp. `Swift.sort` does not document
    /// stability, so ties are broken by the original wire position.
    private static func sortedOldestFirst(_ events: [RelayChannelEvent]) -> [RelayChannelEvent] {
        events.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.timestamp == rhs.element.timestamp {
                    return lhs.offset < rhs.offset
                }
                return lhs.element.timestamp < rhs.element.timestamp
            }
            .map { $0.element }
    }
}
