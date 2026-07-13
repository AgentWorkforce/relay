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

public enum RelayAgentType: String, Codable, Sendable {
    case agent
    case human
    case system
}

public enum RelayAgentStatus: String, Codable, Sendable {
    case online
    case offline
    case away
    case unknown
}

public enum ConnectionStateChange: Sendable {
    case connected
    case disconnected
    case reconnecting(attempt: Int)
}

public enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct AgentRegistration: Sendable {
    public let id: String
    public let name: String
    public let token: String
    public let status: RelayAgentStatus
    public let createdAt: String?
    private let factory: @Sendable (String, String, String) -> AgentClient

    public var agentName: String { name }

    public init(
        id: String,
        name: String,
        token: String,
        status: RelayAgentStatus = .unknown,
        createdAt: String? = nil,
        factory: @escaping @Sendable (String, String, String) -> AgentClient
    ) {
        self.id = id
        self.name = name
        self.token = token
        self.status = status
        self.createdAt = createdAt
        self.factory = factory
    }

    public func asClient() -> AgentClient {
        factory(id, name, token)
    }
}

public struct RelayAgent: Decodable, Sendable {
    public let id: String
    public let name: String
    public let type: RelayAgentType
    public let status: RelayAgentStatus
    public let persona: String?
    public let createdAt: String?
    public let lastSeenAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, type, status, persona
        case createdAt = "created_at"
        case createdAtCamel = "createdAt"
        case lastSeenAt = "last_seen_at"
        case lastSeenAtCamel = "lastSeenAt"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        type = (try? container.decode(RelayAgentType.self, forKey: .type)) ?? .agent
        status = (try? container.decode(RelayAgentStatus.self, forKey: .status)) ?? .unknown
        persona = try container.decodeIfPresent(String.self, forKey: .persona)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
            ?? container.decodeIfPresent(String.self, forKey: .createdAtCamel)
        lastSeenAt = try container.decodeIfPresent(String.self, forKey: .lastSeenAt)
            ?? container.decodeIfPresent(String.self, forKey: .lastSeenAtCamel)
    }
}

public struct RelayChannelEvent: Sendable {
    public let from: String
    public let body: String
    public let channel: String?
    public let threadId: String?
    public let messageId: String?
    public let timestamp: Date
    public let rawEvent: RelayEvent?

    public init(
        from: String,
        body: String,
        channel: String?,
        threadId: String? = nil,
        messageId: String? = nil,
        timestamp: Date = Date(),
        rawEvent: RelayEvent? = nil
    ) {
        self.from = from
        self.body = body
        self.channel = channel
        self.threadId = threadId
        self.messageId = messageId
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

public struct RelayMessageSender: Decodable, Sendable, Equatable {
    public let id: String?
    public let name: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case agentName = "agent_name"
        case agentNameCamel = "agentName"
    }

    public init(id: String? = nil, name: String? = nil) {
        self.id = id
        self.name = name
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name)
            ?? container.decodeIfPresent(String.self, forKey: .agentName)
            ?? container.decodeIfPresent(String.self, forKey: .agentNameCamel)
    }
}

public struct RelayMessageChannelRef: Decodable, Sendable, Equatable {
    public let id: String?
    public let name: String?
}

public struct RelayMessage: Decodable, Sendable, Equatable {
    public let id: String
    public let messageId: String
    public let text: String
    public let from: RelayMessageSender
    public let channel: RelayMessageChannelRef?
    public let conversationId: String?
    public let threadId: String?
    public let parentId: String?
    public let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, text, from, channel
        case body
        case messageId = "message_id"
        case messageIdCamel = "messageId"
        case conversationId = "conversation_id"
        case conversationIdCamel = "conversationId"
        case threadId = "thread_id"
        case threadIdCamel = "threadId"
        case parentId = "parent_id"
        case parentIdCamel = "parentId"
        case createdAt = "created_at"
        case createdAtCamel = "createdAt"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        messageId = try container.decodeIfPresent(String.self, forKey: .messageId)
            ?? container.decodeIfPresent(String.self, forKey: .messageIdCamel)
            ?? id
        text = (try? container.decode(String.self, forKey: .text))
            ?? (try? container.decode(String.self, forKey: .body))
            ?? ""
        from = (try? container.decode(RelayMessageSender.self, forKey: .from)) ?? RelayMessageSender()
        channel = try container.decodeIfPresent(RelayMessageChannelRef.self, forKey: .channel)
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
            ?? container.decodeIfPresent(String.self, forKey: .conversationIdCamel)
        threadId = try container.decodeIfPresent(String.self, forKey: .threadId)
            ?? container.decodeIfPresent(String.self, forKey: .threadIdCamel)
        parentId = try container.decodeIfPresent(String.self, forKey: .parentId)
            ?? container.decodeIfPresent(String.self, forKey: .parentIdCamel)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
            ?? container.decodeIfPresent(String.self, forKey: .createdAtCamel)
    }
}

public struct RelayEvent: Decodable, Sendable {
    public let type: String
    public let id: String?
    public let channel: String?
    public let message: RelayMessage?
    public let invocationId: String?
    public let actionName: String?
    public let callerName: String?
    public let agentName: String?
    public let status: String?
    public let rawJSON: JSONValue?

    init(
        type: String,
        id: String? = nil,
        channel: String? = nil,
        message: RelayMessage? = nil,
        invocationId: String? = nil,
        actionName: String? = nil,
        callerName: String? = nil,
        agentName: String? = nil,
        status: String? = nil,
        rawJSON: JSONValue? = nil
    ) {
        self.type = type
        self.id = id
        self.channel = channel
        self.message = message
        self.invocationId = invocationId
        self.actionName = actionName
        self.callerName = callerName
        self.agentName = agentName
        self.status = status
        self.rawJSON = rawJSON
    }

    enum CodingKeys: String, CodingKey {
        case type, id, channel, message, status, payload
        case invocationId = "invocation_id"
        case invocationIdCamel = "invocationId"
        case actionName = "action_name"
        case actionNameCamel = "actionName"
        case callerName = "caller_name"
        case callerNameCamel = "callerName"
        case agentName = "agent_name"
        case agentNameCamel = "agentName"
        case agent
    }

    public init(from decoder: Decoder) throws {
        rawJSON = try? JSONValue(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let payload = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .payload)
        type = try container.decode(String.self, forKey: .type)
        id = Self.decodeIfPresent(String.self, from: container, payload: payload, keys: [.id])
        channel = Self.decodeIfPresent(String.self, from: container, payload: payload, keys: [.channel])
        message = Self.decodeIfPresent(RelayMessage.self, from: container, payload: payload, keys: [.message])
        invocationId = Self.decodeIfPresent(String.self, from: container, payload: payload, keys: [.invocationId, .invocationIdCamel])
        actionName = Self.decodeIfPresent(String.self, from: container, payload: payload, keys: [.actionName, .actionNameCamel])
        callerName = Self.decodeIfPresent(String.self, from: container, payload: payload, keys: [.callerName, .callerNameCamel])
        agentName = Self.decodeIfPresent(String.self, from: container, payload: payload, keys: [.agentName, .agentNameCamel])
            ?? RelayEvent.decodeAgentName(from: container)
            ?? payload.flatMap { RelayEvent.decodeAgentName(from: $0) }
        status = Self.decodeIfPresent(String.self, from: container, payload: payload, keys: [.status])
    }

    private static func decodeIfPresent<T: Decodable>(
        _ type: T.Type,
        from container: KeyedDecodingContainer<CodingKeys>,
        payload: KeyedDecodingContainer<CodingKeys>?,
        keys: [CodingKeys]
    ) -> T? {
        for key in keys {
            if let value = try? container.decodeIfPresent(type, forKey: key) {
                return value
            }
        }
        guard let payload else { return nil }
        for key in keys {
            if let value = try? payload.decodeIfPresent(type, forKey: key) {
                return value
            }
        }
        return nil
    }

    private static func decodeAgentName(from container: KeyedDecodingContainer<CodingKeys>) -> String? {
        guard let agent = try? container.decodeIfPresent(RelaycastEventAgent.self, forKey: .agent) else {
            return nil
        }
        return agent.name
    }
}

private struct RelaycastEventAgent: Decodable {
    let name: String?
}

public actor ActionHandle {
    public nonisolated let name: String

    private var active = true
    private let unregisterAction: @Sendable () async -> Void

    init(name: String, unregisterAction: @escaping @Sendable () async -> Void) {
        self.name = name
        self.unregisterAction = unregisterAction
    }

    public func unregister() async {
        await performUnregister()
    }

    public func unsubscribe() async {
        await performUnregister()
    }

    private func performUnregister() async {
        guard active else { return }
        active = false
        await unregisterAction()
    }
}
