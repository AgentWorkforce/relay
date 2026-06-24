import Foundation

public final class AgentRelay: @unchecked Sendable {
    private let core: HostedWorkspaceCore
    public let workspaceKey: String
    public let baseURL: URL

    public init(workspaceKey: String, baseURL: URL) {
        self.workspaceKey = workspaceKey
        self.baseURL = baseURL
        let http = HostedHTTP(baseURL: baseURL, apiKey: workspaceKey)
        self.core = HostedWorkspaceCore(workspaceKey: workspaceKey, baseURL: baseURL, http: http)
    }

    public convenience init(apiKey: String, baseURL: URL) {
        self.init(workspaceKey: apiKey, baseURL: baseURL)
    }

    /// Register a hosted workspace participant. This mirrors the TypeScript
    /// `relay.workspace.register(...)` default: register first, and if the
    /// hosted API reports a name conflict, adopt the existing identity and
    /// rotate its token.
    public func registerOrRotate(name: String, type: RelayAgentType = .agent) async throws -> AgentRegistration {
        try await core.registerOrRotate(name: name, type: type)
    }

    public func register(name: String, type: RelayAgentType = .agent, strict: Bool = false) async throws -> AgentRegistration {
        if strict {
            return try await core.register(name: name, type: type)
        }
        return try await core.registerOrRotate(name: name, type: type)
    }

    public func reconnect(apiToken: String) async throws -> AgentClient {
        try await core.reconnect(apiToken: apiToken)
    }

    public func `as`(agentName: String, token: String) -> AgentClient {
        // Compatibility rehydration for callers that already persisted a name
        // and token. The hosted API exposes the canonical id through `/v1/agent`;
        // use `reconnect(apiToken:)` when the id is required.
        core.agentClient(id: agentName, name: agentName, token: token)
    }

    public func workspaceInfo() async throws -> JSONValue {
        try await core.workspaceInfo()
    }
}

/// Compatibility alias for existing Swift consumers. In this module the client
/// is the hosted participant SDK, not the local broker protocol client.
public typealias AgentRelayClient = AgentRelay

final class HostedWorkspaceCore: @unchecked Sendable {
    let workspaceKey: String
    let baseURL: URL
    let http: any HostedHTTPClient
    let encoder = JSONEncoder()

    init(workspaceKey: String, baseURL: URL, http: any HostedHTTPClient) {
        self.workspaceKey = workspaceKey
        self.baseURL = baseURL
        self.http = http
    }

    func register(name: String, type: RelayAgentType) async throws -> AgentRegistration {
        let body = try encode(RegisterAgentRequest(name: name, type: type))
        let response = try await http.post(path: "/v1/agents", body: body)
        let registration = try decodeAPIData(response, as: AgentRegistrationResponse.self)
        return makeRegistration(registration)
    }

    func registerOrRotate(name: String, type: RelayAgentType) async throws -> AgentRegistration {
        do {
            return try await register(name: name, type: type)
        } catch RelayError.protocolError(code: let code, message: let message, retryable: _) where isNameConflict(code: code, message: message) {
            let agent = try await getAgent(name: name)
            let token = try await rotateToken(name: agent.name)
            return AgentRegistration(
                id: agent.id,
                name: agent.name,
                token: token,
                status: agent.status,
                createdAt: agent.createdAt ?? agent.lastSeenAt
            ) { [baseURL, http] id, agentName, token in
                let agentHTTP = HostedHTTP(baseURL: baseURL, apiKey: token)
                let transport = RelayEventTransport(baseURL: baseURL, token: token)
                let core = HostedParticipantCore(
                    agentId: id,
                    agentName: agentName,
                    token: token,
                    baseURL: baseURL,
                    workspaceHTTP: http,
                    agentHTTP: agentHTTP,
                    transport: transport
                )
                return AgentClient(core: core, id: id, name: agentName, token: token)
            }
        }
    }

    func reconnect(apiToken: String) async throws -> AgentClient {
        let agentHTTP = HostedHTTP(baseURL: baseURL, apiKey: apiToken)
        let data = try await agentHTTP.get(path: "/v1/agent", query: nil)
        let agent = try decodeAPIData(data, as: RelayAgent.self)
        return agentClient(id: agent.id, name: agent.name, token: apiToken)
    }

    func agentClient(id: String, name: String, token: String) -> AgentClient {
        let agentHTTP = HostedHTTP(baseURL: baseURL, apiKey: token)
        let transport = RelayEventTransport(baseURL: baseURL, token: token)
        let core = HostedParticipantCore(
            agentId: id,
            agentName: name,
            token: token,
            baseURL: baseURL,
            workspaceHTTP: http,
            agentHTTP: agentHTTP,
            transport: transport
        )
        return AgentClient(core: core, id: id, name: name, token: token)
    }

    func workspaceInfo() async throws -> JSONValue {
        let data = try await http.get(path: "/v1/workspace", query: nil)
        return try decodeAPIData(data, as: JSONValue.self)
    }

    private func getAgent(name: String) async throws -> RelayAgent {
        let data = try await http.get(path: "/v1/agents/\(Self.escapePath(name))", query: nil)
        return try decodeAPIData(data, as: RelayAgent.self)
    }

    private func rotateToken(name: String) async throws -> String {
        let data = try await http.post(path: "/v1/agents/\(Self.escapePath(name))/rotate-token", body: encodeEmptyObject())
        return try decodeAPIData(data, as: RotateTokenResponse.self).token
    }

    private func makeRegistration(_ response: AgentRegistrationResponse) -> AgentRegistration {
        AgentRegistration(
            id: response.id,
            name: response.name,
            token: response.token,
            status: response.status,
            createdAt: response.createdAt
        ) { [baseURL, http] id, agentName, token in
            let agentHTTP = HostedHTTP(baseURL: baseURL, apiKey: token)
            let transport = RelayEventTransport(baseURL: baseURL, token: token)
            let core = HostedParticipantCore(
                agentId: id,
                agentName: agentName,
                token: token,
                baseURL: baseURL,
                workspaceHTTP: http,
                agentHTTP: agentHTTP,
                transport: transport
            )
            return AgentClient(core: core, id: id, name: agentName, token: token)
        }
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
        do {
            return try encoder.encode(value)
        } catch {
            throw RelayError.encodingFailed(String(describing: error))
        }
    }

    private func encodeEmptyObject() -> Data {
        Data("{}".utf8)
    }

    private static func escapePath(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private func isNameConflict(code: String, message: String) -> Bool {
        let normalizedCode = code.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["agent_already_exists", "name_conflict", "name_taken", "agent_exists", "conflict", "duplicate", "http_409"].contains(normalizedCode) {
            return true
        }
        return message.lowercased().contains("already exists")
    }
}

private struct RegisterAgentRequest: Encodable {
    let name: String
    let type: RelayAgentType
}

public final class AgentClient: @unchecked Sendable {
    private let core: HostedParticipantCore
    public let id: String
    public let name: String
    public let token: String

    public var agentName: String { name }

    init(core: HostedParticipantCore, id: String, name: String, token: String) {
        self.core = core
        self.id = id
        self.name = name
        self.token = token
    }

    public func connect() async throws {
        try await core.ensureConnected()
    }

    public func disconnect() async {
        await core.disconnect()
    }

    public func channel(_ name: String) -> RelayChannel {
        RelayChannel(name: name, core: core)
    }

    public func post(to channel: String, message: String) async throws {
        try await core.post(channel: channel, text: message)
    }

    public func dm(to agentName: String, message: String) async throws {
        try await core.dm(to: agentName, text: message)
    }

    public func registerAction(
        name: String,
        description: String,
        inputSchemaJSON: String,
        handler: @escaping @Sendable (String) async -> String
    ) async throws -> ActionHandle {
        try await core.registerAction(
            name: name,
            description: description,
            inputSchemaJSON: inputSchemaJSON,
            handler: handler
        )
    }

    public var events: AsyncStream<RelayEvent> {
        AsyncStream<RelayEvent> { continuation in
            Task { await core.registerEventContinuation(continuation) }
        }
    }

    public var inboundMessages: AsyncStream<RelayChannelEvent> {
        AsyncStream<RelayChannelEvent> { continuation in
            Task { await core.registerInboundMessageContinuation(continuation) }
        }
    }

    public var connectionState: AsyncStream<ConnectionStateChange> {
        AsyncStream<ConnectionStateChange> { continuation in
            Task { await core.registerConnectionStateContinuation(continuation) }
        }
    }
}

public final class RelayChannel: @unchecked Sendable {
    public let name: String
    private let core: HostedParticipantCore
    private let continuationRef: AsyncStream<RelayChannelEvent>.Continuation?
    public let events: AsyncStream<RelayChannelEvent>

    init(name: String, core: HostedParticipantCore) {
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
        try await core.subscribe(channel: name)
    }

    public func post(_ text: String) async throws {
        try await core.post(channel: name, text: text)
    }
}

typealias RelayActionHandler = @Sendable (String) async -> String

private struct RegisteredAction: Sendable {
    let id: String
    let handler: RelayActionHandler
}

actor HostedParticipantCore {
    let agentId: String
    let agentName: String
    let token: String
    let baseURL: URL
    let workspaceHTTP: any HostedHTTPClient
    let agentHTTP: any HostedHTTPClient
    let transport: any HostedEventTransportClient
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    private var routerTask: Task<Void, Never>?
    private var subscribedChannels: Set<String> = []
    private var channelContinuations: [String: [AsyncStream<RelayChannelEvent>.Continuation]] = [:]
    private var inboundMessageContinuations: [AsyncStream<RelayChannelEvent>.Continuation] = []
    private var eventContinuations: [AsyncStream<RelayEvent>.Continuation] = []
    private var connectionStateContinuations: [AsyncStream<ConnectionStateChange>.Continuation] = []
    private var actionHandlers: [String: RegisteredAction] = [:]

    init(
        agentId: String,
        agentName: String,
        token: String,
        baseURL: URL,
        workspaceHTTP: any HostedHTTPClient,
        agentHTTP: any HostedHTTPClient,
        transport: any HostedEventTransportClient
    ) {
        self.agentId = agentId
        self.agentName = agentName
        self.token = token
        self.baseURL = baseURL
        self.workspaceHTTP = workspaceHTTP
        self.agentHTTP = agentHTTP
        self.transport = transport
    }

    func ensureConnected() async throws {
        if routerTask == nil || routerTask?.isCancelled == true {
            routerTask = Task { [weak self] in await self?.routeFrames() }
        }
        await transport.setOnConnect { [weak self] in
            await self?.transportDidReconnect()
        }
        try await transport.connect()
        notifyConnectionState(.connected)
        try await syncSubscriptions()
    }

    func transportDidReconnect() async {
        notifyConnectionState(.connected)
        try? await syncSubscriptions()
    }

    func disconnect() async {
        routerTask?.cancel()
        routerTask = nil
        await transport.disconnect()
        _ = try? await agentHTTP.post(path: "/v1/agents/disconnect", body: Data("{}".utf8))
        notifyConnectionState(.disconnected)
        for continuations in channelContinuations.values {
            for continuation in continuations { continuation.finish() }
        }
        channelContinuations.removeAll()
        for continuation in inboundMessageContinuations { continuation.finish() }
        inboundMessageContinuations.removeAll()
        for continuation in eventContinuations { continuation.finish() }
        eventContinuations.removeAll()
        for continuation in connectionStateContinuations { continuation.finish() }
        connectionStateContinuations.removeAll()
    }

    func registerChannelContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation, for channel: String) {
        channelContinuations[Self.normalizeChannel(channel), default: []].append(continuation)
    }

    func registerInboundMessageContinuation(_ continuation: AsyncStream<RelayChannelEvent>.Continuation) {
        inboundMessageContinuations.append(continuation)
    }

    func registerEventContinuation(_ continuation: AsyncStream<RelayEvent>.Continuation) {
        eventContinuations.append(continuation)
    }

    func registerConnectionStateContinuation(_ continuation: AsyncStream<ConnectionStateChange>.Continuation) {
        connectionStateContinuations.append(continuation)
    }

    func subscribe(channel: String) async throws {
        subscribedChannels.insert(Self.normalizeChannel(channel))
        try await ensureConnected()
    }

    func post(channel: String, text: String) async throws {
        let path = "/v1/channels/\(Self.escapePath(Self.normalizeChannel(channel)))/messages"
        let body = try encode(SendChannelMessageRequest(text: text, mode: "wait"))
        _ = try await agentHTTP.post(path: path, body: body)
    }

    func dm(to target: String, text: String) async throws {
        let body = try encode(SendDirectMessageRequest(to: Self.stripSigil(target), text: text, mode: "wait"))
        _ = try await agentHTTP.post(path: "/v1/dm", body: body)
    }

    func registerAction(
        name: String,
        description: String,
        inputSchemaJSON: String,
        handler: @escaping RelayActionHandler
    ) async throws -> ActionHandle {
        let actionName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !actionName.isEmpty else {
            throw RelayError.protocolError(code: "invalid_action_name", message: "Action name cannot be empty", retryable: false)
        }
        let inputSchema = try decodeJSONValue(inputSchemaJSON)

        let registrationId = UUID().uuidString
        actionHandlers[actionName] = RegisteredAction(id: registrationId, handler: handler)

        do {
            try await registerActionDescriptor(name: actionName, description: description, inputSchema: inputSchema)
            try await ensureConnected()
        } catch {
            actionHandlers.removeValue(forKey: actionName)
            throw error
        }

        return ActionHandle(name: actionName) { [weak self] in
            await self?.unregisterAction(name: actionName, registrationId: registrationId)
        }
    }

    func unregisterAction(name: String, registrationId: String) async {
        guard actionHandlers[name]?.id == registrationId else { return }
        do {
            try await unregisterActionDescriptor(name: name)
            actionHandlers.removeValue(forKey: name)
        } catch {
            // Keep the handler if the relay descriptor could not be removed so
            // advertised invocations are still handled instead of silently dropped.
        }
    }

    private func registerActionDescriptor(name: String, description: String, inputSchema: JSONValue) async throws {
        let request = RegisterActionDescriptorRequest(
            name: name,
            description: description,
            handlerAgent: agentName,
            inputSchema: inputSchema
        )
        let body = try encode(request)
        _ = try await workspaceHTTP.post(path: "/v1/actions", body: body)
    }

    private func unregisterActionDescriptor(name: String) async throws {
        _ = try await workspaceHTTP.delete(path: "/v1/actions/\(Self.escapePath(name))")
    }

    private func syncSubscriptions() async throws {
        guard !subscribedChannels.isEmpty else { return }
        let body = try encode(SocketSubscribeMessage(channels: Array(subscribedChannels).sorted()))
        try await transport.send(body)
    }

    private func routeFrames() async {
        for await data in transport.inbound {
            guard let event = try? decoder.decode(RelayEvent.self, from: data) else {
                continue
            }
            routeEvent(event)
        }
        notifyConnectionState(.disconnected)
    }

    private func routeEvent(_ event: RelayEvent) {
        for continuation in eventContinuations {
            continuation.yield(event)
        }

        if event.type == "action.invoked" || event.type == "actionInvoked" {
            routeActionInvocation(event)
            return
        }

        guard let message = channelEvent(from: event) else { return }
        for continuation in inboundMessageContinuations {
            continuation.yield(message)
        }
        if let channel = message.channel {
            for continuation in channelContinuations[Self.normalizeChannel(channel)] ?? [] {
                continuation.yield(message)
            }
        }
    }

    private func channelEvent(from event: RelayEvent) -> RelayChannelEvent? {
        switch event.type {
        case "message.created", "messageCreated", "message.received", "messageReceived", "thread.reply", "threadReply", "dm.received", "dmReceived", "group_dm.received", "groupDmReceived":
            break
        default:
            return nil
        }

        let sender = event.message?.from.name ?? event.agentName ?? "unknown"
        let channel = event.channel ?? event.message?.channel?.name
        return RelayChannelEvent(
            from: sender,
            body: event.message?.text ?? "",
            channel: channel,
            threadId: event.message?.threadId ?? event.message?.parentId,
            messageId: event.message?.messageId,
            timestamp: Self.date(from: event.message?.createdAt),
            rawEvent: event
        )
    }

    private func routeActionInvocation(_ event: RelayEvent) {
        guard let actionName = event.actionName,
              let invocationId = event.invocationId,
              let registration = actionHandlers[actionName] else {
            return
        }

        Task.detached {
            await self.handleActionInvocation(
                actionName: actionName,
                invocationId: invocationId,
                callerName: event.callerName,
                registration: registration
            )
        }
    }

    private func handleActionInvocation(
        actionName: String,
        invocationId: String,
        callerName: String?,
        registration: RegisteredAction
    ) async {
        do {
            let invocation = try await loadInvocation(actionName: actionName, invocationId: invocationId)
            let input = invocation.input ?? .object([:])
            let inputString = actionInputString(input)
            let output = await registration.handler(inputString)
            try await completeInvocation(actionName: actionName, invocationId: invocationId, output: parseHandlerOutput(output))
        } catch {
            try? await completeInvocation(actionName: actionName, invocationId: invocationId, error: Self.describe(error))
        }
    }

    private func loadInvocation(actionName: String, invocationId: String) async throws -> RelayActionInvocation {
        let path = "/v1/actions/\(Self.escapePath(actionName))/invocations/\(Self.escapePath(invocationId))"
        let data = try await agentHTTP.get(path: path, query: nil)
        return try decodeAPIData(data, as: RelayActionInvocation.self)
    }

    private func completeInvocation(actionName: String, invocationId: String, output: JSONValue) async throws {
        try await completeInvocation(
            actionName: actionName,
            invocationId: invocationId,
            body: CompleteInvocationRequest(output: Self.outputRecord(output), error: nil)
        )
    }

    private func completeInvocation(actionName: String, invocationId: String, error: String) async throws {
        try await completeInvocation(actionName: actionName, invocationId: invocationId, body: CompleteInvocationRequest(output: nil, error: error))
    }

    private func completeInvocation(actionName: String, invocationId: String, body value: CompleteInvocationRequest) async throws {
        let path = "/v1/actions/\(Self.escapePath(actionName))/invocations/\(Self.escapePath(invocationId))/complete"
        _ = try await agentHTTP.post(path: path, body: try encode(value))
    }

    private func decodeJSONValue(_ json: String) throws -> JSONValue {
        guard let data = json.data(using: .utf8) else {
            throw RelayError.encodingFailed("Input schema is not valid UTF-8")
        }
        do {
            return try decoder.decode(JSONValue.self, from: data)
        } catch {
            throw RelayError.decodingFailed("Invalid inputSchemaJSON: \(error)")
        }
    }

    private func actionInputString(_ input: JSONValue) -> String {
        guard let data = try? encoder.encode(input), let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }

    private func parseHandlerOutput(_ output: String) -> JSONValue {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty,
           let data = trimmed.data(using: .utf8),
           let value = try? decoder.decode(JSONValue.self, from: data) {
            return value
        }
        return .string(output)
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
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

    private static func stripSigil(_ value: String) -> String {
        if value.hasPrefix("@") || value.hasPrefix("#") {
            return String(value.dropFirst())
        }
        return value
    }

    private static func normalizeChannel(_ value: String) -> String {
        stripSigil(value).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func escapePath(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private static func date(from timestamp: String?) -> Date {
        guard let timestamp,
              let date = ISO8601DateFormatter().date(from: timestamp)
        else { return Date() }
        return date
    }

    private static func describe(_ error: Error) -> String {
        if let relayError = error as? RelayError {
            switch relayError {
            case .invalidBaseURL(let message),
                 .connectionFailed(let message),
                 .handshakeFailed(let message),
                 .encodingFailed(let message),
                 .decodingFailed(let message),
                 .unsupported(let message),
                 .timeout(let message):
                return message
            case .protocolError(let code, let message, _):
                return "\(code): \(message)"
            case .notConnected:
                return "Relay is not connected."
            }
        }
        return error.localizedDescription
    }

    private static func outputRecord(_ value: JSONValue) -> JSONValue {
        if case .object = value {
            return value
        }
        return .object(["value": value])
    }
}

private struct SendChannelMessageRequest: Encodable {
    let text: String
    let mode: String
}

private struct SendDirectMessageRequest: Encodable {
    let to: String
    let text: String
    let mode: String
}

private struct SocketSubscribeMessage: Encodable {
    let type = "subscribe"
    let channels: [String]
}

private struct RegisterActionDescriptorRequest: Encodable {
    let name: String
    let description: String
    let handlerAgent: String
    let inputSchema: JSONValue

    enum CodingKeys: String, CodingKey {
        case name, description
        case handlerAgent = "handler_agent"
        case inputSchema = "input_schema"
    }
}

private struct CompleteInvocationRequest: Encodable {
    let output: JSONValue?
    let error: String?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch (output, error) {
        case (.some(let output), .none):
            try container.encode(output, forKey: .output)
        case (.none, .some(let error)):
            try container.encode(error, forKey: .error)
        default:
            throw EncodingError.invalidValue(
                self,
                EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "completion requires output or error")
            )
        }
    }

    enum CodingKeys: String, CodingKey {
        case output, error
    }
}
