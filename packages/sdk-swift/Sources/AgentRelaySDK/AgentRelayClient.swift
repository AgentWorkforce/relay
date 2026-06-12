import Foundation

public enum RelayError: Error, Sendable {
    case invalidBaseURL(String)
    case connectionFailed(String)
    case handshakeFailed(String)
    case protocolError(code: String, message: String, retryable: Bool)
    case encodingFailed(String)
    case decodingFailed(String)
    case notConnected
    case unsupported(String)
    case timeout(String)
}

/// Connection state changes emitted by the SDK.
public enum ConnectionStateChange: Sendable {
    case connected
    case disconnected
    case reconnecting(attempt: Int)
}

public struct RelayChannelEvent: Sendable {
    public let from: String
    public let body: String
    public let threadId: String?
    public let timestamp: Date

    public init(from: String, body: String, threadId: String?, timestamp: Date = Date()) {
        self.from = from
        self.body = body
        self.threadId = threadId
        self.timestamp = timestamp
    }
}

public struct AgentRegistration: Sendable {
    public let agentName: String
    public let token: String
    private let factory: @Sendable (String, String) -> AgentClient

    public init(agentName: String, token: String, factory: @escaping @Sendable (String, String) -> AgentClient) {
        self.agentName = agentName
        self.token = token
        self.factory = factory
    }

    public func asClient() -> AgentClient {
        factory(agentName, token)
    }
}

actor RelayCore {
    let apiKey: String
    let transport: RelayTransport
    let http: RelayHTTP
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    private var routerTask: Task<Void, Never>?
    private var channelContinuations: [String: [AsyncStream<RelayChannelEvent>.Continuation]] = [:]
    private var brokerEventContinuations: [AsyncStream<BrokerEvent>.Continuation] = []
    private var inboundMessageContinuations: [AsyncStream<InboundMessage>.Continuation] = []
    private var connectionStateContinuations: [AsyncStream<ConnectionStateChange>.Continuation] = []

    init(apiKey: String, transport: RelayTransport, http: RelayHTTP) {
        self.apiKey = apiKey
        self.transport = transport
        self.http = http
    }

    func configureTransportCallbacks() async {
        await transport.setOnConnect { [weak self] in
            await self?.transportDidConnect()
        }
    }

    /// Open the read-only event WebSocket if it's not already connected.
    func ensureConnected() async throws {
        if routerTask == nil || routerTask?.isCancelled == true {
            routerTask = Task { [weak self] in await self?.routeFrames() }
        }
        try await transport.connect()
        notifyConnectionState(.connected)
    }

    func transportDidConnect() async {
        notifyConnectionState(.connected)
    }

    func registerChannelContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, for channel: String) {
        channelContinuations[channel, default: []].append(continuation)
    }

    func registerBrokerEventContinuation(_ continuation: AsyncStream<BrokerEvent>.Continuation) {
        brokerEventContinuations.append(continuation)
    }

    func registerInboundMessageContinuation(_ continuation: AsyncStream<InboundMessage>.Continuation) {
        inboundMessageContinuations.append(continuation)
    }

    func registerConnectionStateContinuation(_ continuation: AsyncStream<ConnectionStateChange>.Continuation) {
        connectionStateContinuations.append(continuation)
    }

    func sendChannelPost(channel: String, text: String) async throws {
        _ = try await sendMessage(SendMessagePayload(to: channel, text: text, from: nil, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil, mode: nil))
    }

    func sendAgentMessage(from agentName: String, to target: String, text: String) async throws {
        _ = try await sendMessage(SendMessagePayload(to: target, text: text, from: agentName, threadId: nil, workspaceId: nil, workspaceAlias: nil, priority: nil, data: nil, mode: nil))
    }

    func spawnAgent(_ spec: AgentSpec, initialTask: String? = nil, skipRelayPrompt: Bool? = nil) async throws {
        let body = try encodeJSON(SpawnRequestBody(spec: spec, task: initialTask, skipRelayPrompt: skipRelayPrompt))
        _ = try await http.post(path: "/api/spawn", body: body)
    }

    func releaseAgent(name: String, reason: String? = nil) async throws {
        var pathSegmentAllowed = CharacterSet.urlPathAllowed
        pathSegmentAllowed.remove(charactersIn: "/")
        let escaped = name.addingPercentEncoding(withAllowedCharacters: pathSegmentAllowed) ?? name
        let body: Data?
        if let reason {
            body = try encodeJSON(["reason": reason])
        } else {
            body = nil
        }
        _ = try await http.delete(path: "/api/spawned/\(escaped)", body: body)
    }


    func listAgents() async throws -> [ListAgent] {
        try decodeJSON(try await http.get(path: "/api/spawned"), as: [ListAgent].self)
    }

    func sendInput(name: String, data: String) async throws {
        let body = try encodeJSON(InputRequestBody(data: data))
        _ = try await http.post(path: "/api/spawned/\(escapePathSegment(name))/input", body: body)
    }

    func resizePty(name: String, rows: Int, cols: Int) async throws {
        let body = try encodeJSON(ResizeRequestBody(rows: rows, cols: cols))
        _ = try await http.post(path: "/api/spawned/\(escapePathSegment(name))/resize", body: body)
    }

    func flush(name: String) async throws -> FlushResult {
        try decodeJSON(try await http.post(path: "/api/spawned/\(escapePathSegment(name))/flush", body: nil), as: FlushResult.self)
    }

    func snapshot(name: String, format: SnapshotFormat = .plain) async throws -> PtySnapshot {
        try decodeJSON(
            try await http.get(path: "/api/spawned/\(escapePathSegment(name))/snapshot?format=\(format.rawValue)"),
            as: PtySnapshot.self
        )
    }

    func sendMessage(_ payload: SendMessagePayload) async throws -> SendMessageResult {
        do {
            let body = try encodeJSON(payload)
            return try decodeJSON(try await http.post(path: "/api/send", body: body), as: SendMessageResult.self)
        } catch RelayError.protocolError(let code, _, _) where code == "unsupported_operation" {
            return SendMessageResult(eventId: "unsupported_operation", targets: [])
        }
    }

    func setModel(name: String, model: String, timeoutMs: Int? = nil) async throws -> ModelUpdateResult {
        let body = try encodeJSON(ModelRequestBody(model: model, timeoutMs: timeoutMs))
        return try decodeJSON(
            try await http.post(path: "/api/spawned/\(escapePathSegment(name))/model", body: body),
            as: ModelUpdateResult.self
        )
    }

    func subscribeChannels(name: String, channels: [String]) async throws {
        let body = try encodeJSON(ChannelsRequestBody(channels: channels))
        _ = try await http.post(path: "/api/spawned/\(escapePathSegment(name))/subscribe", body: body)
    }

    func unsubscribeChannels(name: String, channels: [String]) async throws {
        let body = try encodeJSON(ChannelsRequestBody(channels: channels))
        _ = try await http.post(path: "/api/spawned/\(escapePathSegment(name))/unsubscribe", body: body)
    }

    func getStatus() async throws -> BrokerStatus {
        try decodeJSON(try await http.get(path: "/api/status"), as: BrokerStatus.self)
    }

    func getMetrics(agent: String? = nil) async throws -> MetricsResponse {
        let query = agent.map { "?agent=\(escapeQueryValue($0))" } ?? ""
        return try decodeJSON(try await http.get(path: "/api/metrics\(query)"), as: MetricsResponse.self)
    }

    func getCrashInsights() async throws -> CrashInsightsResponse {
        try decodeJSON(try await http.get(path: "/api/crash-insights"), as: CrashInsightsResponse.self)
    }

    func preflight(agents: [[String: String]]) async throws -> PreflightResult {
        guard !agents.isEmpty else { return PreflightResult(queued: 0) }
        let body = try encodeJSON(PreflightRequestBody(agents: agents))
        return try decodeJSON(try await http.post(path: "/api/preflight", body: body), as: PreflightResult.self)
    }

    func renewLease() async throws -> RenewLeaseResult {
        try decodeJSON(try await http.post(path: "/api/session/renew", body: nil), as: RenewLeaseResult.self)
    }

    func registerOrRotate(name: String) async throws -> AgentRegistration {
        try await ensureConnected()
        return AgentRegistration(agentName: name, token: name) { agentName, token in
            AgentClient(core: self, agentName: agentName, token: token)
        }
    }

    func disconnect() async {
        routerTask?.cancel()
        routerTask = nil
        await transport.disconnect()
        notifyConnectionState(.disconnected)
        // Finish all event stream continuations
        for continuation in brokerEventContinuations { continuation.finish() }
        brokerEventContinuations.removeAll()
        for continuation in inboundMessageContinuations { continuation.finish() }
        inboundMessageContinuations.removeAll()
        for continuations in channelContinuations.values {
            for continuation in continuations { continuation.finish() }
        }
        channelContinuations.removeAll()
        for continuation in connectionStateContinuations { continuation.finish() }
        connectionStateContinuations.removeAll()
    }

    private func decodeJSON<T: Decodable>(_ data: Data, as type: T.Type) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw RelayError.decodingFailed(String(describing: error))
        }
    }

    private func encodeJSON<T: Encodable>(_ value: T) throws -> Data {
        do {
            return try encoder.encode(value)
        } catch {
            throw RelayError.encodingFailed(String(describing: error))
        }
    }

    private func notifyConnectionState(_ state: ConnectionStateChange) {
        for continuation in connectionStateContinuations {
            continuation.yield(state)
        }
    }

    private func escapePathSegment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func escapeQueryValue(_ value: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func routeFrames() async {
        for await data in transport.inbound {
            guard let event = try? decoder.decode(BrokerEvent.self, from: data) else {
                continue
            }

            for continuation in inboundMessageContinuations {
                continuation.yield(.event(event))
            }
            for continuation in brokerEventContinuations {
                continuation.yield(event)
            }

            if case .relayInbound(let relayEvent) = event {
                let message = RelayChannelEvent(from: relayEvent.from, body: relayEvent.body, threadId: relayEvent.threadId)
                for continuation in channelContinuations[relayEvent.target] ?? [] {
                    continuation.yield(message)
                }
            }
        }
        notifyConnectionState(.disconnected)
    }
}

private struct InputRequestBody: Encodable {
    let data: String
}

private struct ResizeRequestBody: Encodable {
    let rows: Int
    let cols: Int
}

private struct ModelRequestBody: Encodable {
    let model: String
    let timeoutMs: Int?

    enum CodingKeys: String, CodingKey {
        case model
        case timeoutMs = "timeout_ms"
    }
}

private struct ChannelsRequestBody: Encodable {
    let channels: [String]
}

private struct PreflightRequestBody: Encodable {
    let agents: [[String: String]]
}

/// Body shape for `POST /api/spawn` — flattens the AgentSpec fields onto the
/// request as the broker expects (name, cli, runtime, args, channels, model,
/// cwd, team, etc.) plus optional `task` and `skipRelayPrompt`.
private struct SpawnRequestBody: Encodable {
    let spec: AgentSpec
    let task: String?
    let skipRelayPrompt: Bool?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: SpawnCodingKeys.self)
        try container.encode(spec.name, forKey: .name)
        try container.encode(spec.runtime.rawValue, forKey: .runtime)
        if let provider = spec.provider {
            try container.encode(provider.rawValue, forKey: .cli)
        } else if let cli = spec.cli {
            try container.encode(cli, forKey: .cli)
        }
        if let model = spec.model {
            try container.encode(model, forKey: .model)
        }
        try container.encode(spec.args ?? [], forKey: .args)
        try container.encode(spec.channels ?? [], forKey: .channels)
        if let cwd = spec.cwd {
            try container.encode(cwd, forKey: .cwd)
        }
        if let team = spec.team {
            try container.encode(team, forKey: .team)
        }
        if let shadowOf = spec.shadowOf {
            try container.encode(shadowOf, forKey: .shadowOf)
        }
        if let shadowMode = spec.shadowMode {
            try container.encode(shadowMode, forKey: .shadowMode)
        }
        if let restartPolicy = spec.restartPolicy {
            try container.encode(restartPolicy, forKey: .restartPolicy)
        }
        if let task {
            try container.encode(task, forKey: .task)
        }
        if let skipRelayPrompt {
            try container.encode(skipRelayPrompt, forKey: .skipRelayPrompt)
        }
    }

    enum SpawnCodingKeys: String, CodingKey {
        case name, cli, runtime, model, args, channels, cwd, team, task
        case shadowOf = "shadow_of"
        case shadowMode = "shadow_mode"
        case restartPolicy = "restart_policy"
        case skipRelayPrompt = "skip_relay_prompt"
    }
}

public final class AgentRelayClient: @unchecked Sendable {
    private let core: RelayCore
    public let apiKey: String
    public let baseURL: URL

    public init(apiKey: String, baseURL: URL? = nil) {
        self.apiKey = apiKey
        let resolved = Self.resolveBaseURL(from: baseURL)
        self.baseURL = resolved
        let transport = RelayTransport(baseURL: resolved, authToken: apiKey)
        let http = RelayHTTP(baseURL: resolved, apiKey: apiKey)
        self.core = RelayCore(apiKey: apiKey, transport: transport, http: http)
        Task {
            await self.core.configureTransportCallbacks()
        }
    }

    /// Create a channel handle for subscribing and posting.
    public func channel(_ name: String) -> Channel {
        Channel(name: name, core: core)
    }

    /// Register (or re-register) an agent identity with the broker.
    public func registerOrRotate(name: String) async throws -> AgentRegistration {
        try await core.registerOrRotate(name: name)
    }

    /// Create an agent client from an existing agent name and token.
    public func `as`(agentName: String, token: String) -> AgentClient {
        AgentClient(core: core, agentName: agentName, token: token)
    }

    /// Spawn a new agent process on the broker.
    public func spawnAgent(_ spec: AgentSpec, initialTask: String? = nil, skipRelayPrompt: Bool? = nil) async throws {
        try await core.spawnAgent(spec, initialTask: initialTask, skipRelayPrompt: skipRelayPrompt)
    }

    /// Release (stop) a named agent on the broker.
    public func releaseAgent(name: String, reason: String? = nil) async throws {
        try await core.releaseAgent(name: name, reason: reason)
    }


    /// List agents currently known to the broker.
    public func listAgents() async throws -> [ListAgent] {
        try await core.listAgents()
    }

    /// Send raw input to a PTY-backed agent.
    public func sendInput(name: String, data: String) async throws {
        try await core.sendInput(name: name, data: data)
    }

    /// Resize a PTY-backed agent terminal.
    public func resizePty(name: String, rows: Int, cols: Int) async throws {
        try await core.resizePty(name: name, rows: rows, cols: cols)
    }

    /// Flush queued messages for an agent using manual delivery mode.
    public func flush(name: String) async throws -> FlushResult {
        try await core.flush(name: name)
    }

    /// Capture the latest PTY screen snapshot for an agent.
    public func snapshot(name: String, format: SnapshotFormat = .plain) async throws -> PtySnapshot {
        try await core.snapshot(name: name, format: format)
    }

    /// Send a broker-level Relay message with the full REST payload surface.
    public func sendMessage(
        to: String,
        text: String,
        from: String? = nil,
        threadId: String? = nil,
        workspaceId: String? = nil,
        workspaceAlias: String? = nil,
        priority: Int? = nil,
        data: [String: JSONValue]? = nil,
        mode: RelayMessageMode? = nil
    ) async throws -> SendMessageResult {
        try await core.sendMessage(
            SendMessagePayload(
                to: to,
                text: text,
                from: from,
                threadId: threadId,
                workspaceId: workspaceId,
                workspaceAlias: workspaceAlias,
                priority: priority,
                data: data,
                mode: mode
            )
        )
    }

    /// Change a spawned agent's model when its harness supports runtime model switching.
    public func setModel(name: String, model: String, timeoutMs: Int? = nil) async throws -> ModelUpdateResult {
        try await core.setModel(name: name, model: model, timeoutMs: timeoutMs)
    }

    /// Subscribe an agent to additional broker channels.
    public func subscribeChannels(name: String, channels: [String]) async throws {
        try await core.subscribeChannels(name: name, channels: channels)
    }

    /// Unsubscribe an agent from broker channels.
    public func unsubscribeChannels(name: String, channels: [String]) async throws {
        try await core.unsubscribeChannels(name: name, channels: channels)
    }

    /// Return the broker status snapshot.
    public func getStatus() async throws -> BrokerStatus {
        try await core.getStatus()
    }

    /// Return process and broker metrics, optionally scoped to one agent.
    public func getMetrics(agent: String? = nil) async throws -> MetricsResponse {
        try await core.getMetrics(agent: agent)
    }

    /// Return broker crash/restart diagnostics.
    public func getCrashInsights() async throws -> CrashInsightsResponse {
        try await core.getCrashInsights()
    }

    /// Preflight a batch of agents so the broker can warm registration state.
    public func preflight(agents: [[String: String]]) async throws -> PreflightResult {
        try await core.preflight(agents: agents)
    }

    /// Renew the broker session lease.
    public func renewLease() async throws -> RenewLeaseResult {
        try await core.renewLease()
    }

    /// Disconnect from the broker and cancel all event streams.
    public func disconnect() async {
        await core.disconnect()
    }

    /// Stream of all broker events (agent_spawned, worker_stream, delivery_*, etc.).
    ///
    /// This provides full visibility into broker activity, suitable for building
    /// agent dashboards, monitoring tools, or custom event routing.
    ///
    /// Call `ensureConnected()` on a channel or register an agent first to start
    /// receiving events.
    public var brokerEvents: AsyncStream<BrokerEvent> {
        AsyncStream<BrokerEvent> { continuation in
            Task { await core.registerBrokerEventContinuation(continuation) }
        }
    }

    /// Stream of all raw inbound protocol messages.
    public var inboundMessages: AsyncStream<InboundMessage> {
        AsyncStream<InboundMessage> { continuation in
            Task { await core.registerInboundMessageContinuation(continuation) }
        }
    }

    /// Stream of connection state changes (connected, disconnected, reconnecting).
    public var connectionState: AsyncStream<ConnectionStateChange> {
        AsyncStream<ConnectionStateChange> { continuation in
            Task { await core.registerConnectionStateContinuation(continuation) }
        }
    }

    private static func resolveBaseURL(from baseURL: URL?) -> URL {
        if let baseURL {
            return baseURL
        }
        return URL(string: "http://localhost:3889")!
    }
}

public final class Channel: @unchecked Sendable {
    public let name: String
    private let core: RelayCore
    private let continuationRef: AsyncStream<RelayChannelEvent>.Continuation?
    public let events: AsyncStream<RelayChannelEvent>

    init(name: String, core: RelayCore) {
        self.name = name
        self.core = core
        var continuation: AsyncStream<RelayChannelEvent>.Continuation?
        self.events = AsyncStream<RelayChannelEvent> { incoming in
            continuation = incoming
        }
        self.continuationRef = continuation
    }

    public func subscribe() async throws {
        if let continuationRef {
            await core.registerChannelContinuation(continuationRef, for: name)
        }
        try await core.ensureConnected()
    }

    public func post(_ text: String) async throws {
        try await core.sendChannelPost(channel: name, text: text)
    }
}

public final class AgentClient: @unchecked Sendable {
    private let core: RelayCore
    public let agentName: String
    public let token: String

    init(core: RelayCore, agentName: String, token: String) {
        self.core = core
        self.agentName = agentName
        self.token = token
    }

    public func post(to channel: String, message: String) async throws {
        try await core.sendAgentMessage(from: agentName, to: channel, text: message)
    }

    public func dm(to agentName: String, message: String) async throws {
        try await core.sendAgentMessage(from: self.agentName, to: agentName, text: message)
    }
}
