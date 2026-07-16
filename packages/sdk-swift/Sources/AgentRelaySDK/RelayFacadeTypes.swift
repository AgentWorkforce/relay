import Foundation

// MARK: - Attachments & reactions (#1144)

/// A file attachment carried by a message. On the outbound path callers pass
/// stored file ids (`RelayAttachmentInput`); on the inbound path attachments
/// are surfaced here, translated from relaycast's `FileAttachment`.
public struct RelayAttachment: Sendable, Equatable, Decodable {
    public let id: String
    public let filename: String?
    public let contentType: String?
    public let sizeBytes: Int?

    public init(id: String, filename: String? = nil, contentType: String? = nil, sizeBytes: Int? = nil) {
        self.id = id
        self.filename = filename
        self.contentType = contentType
        self.sizeBytes = sizeBytes
    }

    enum CodingKeys: String, CodingKey {
        case id, filename
        case fileId = "file_id"
        case fileIdCamel = "fileId"
        case contentType = "content_type"
        case contentTypeCamel = "contentType"
        case sizeBytes = "size_bytes"
        case sizeBytesCamel = "sizeBytes"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // No `""` fallback: an attachment payload with none of these id
        // aliases is malformed, and a usable-looking attachment with an empty
        // id would let callers attempt file operations against it. Throwing
        // here surfaces as "no attachments" on the message (`RelayMessage`
        // decodes its `attachments` array with `try?`), matching how other
        // malformed realtime shapes are handled.
        guard let resolvedId = try container.decodeIfPresent(String.self, forKey: .fileId)
            ?? container.decodeIfPresent(String.self, forKey: .fileIdCamel)
            ?? container.decodeIfPresent(String.self, forKey: .id) else {
            throw DecodingError.dataCorruptedError(
                forKey: .fileId,
                in: container,
                debugDescription: "Attachment is missing a file id (file_id/fileId/id)"
            )
        }
        id = resolvedId
        filename = try container.decodeIfPresent(String.self, forKey: .filename)
        contentType = try container.decodeIfPresent(String.self, forKey: .contentType)
            ?? container.decodeIfPresent(String.self, forKey: .contentTypeCamel)
        sizeBytes = try container.decodeIfPresent(Int.self, forKey: .sizeBytes)
            ?? container.decodeIfPresent(Int.self, forKey: .sizeBytesCamel)
    }
}

/// Outbound attachment reference. Only stored file ids (obtained from
/// `AgentClient.files.upload`) are supported by the hosted transport, mirroring
/// relaycast `SendMessageOptions.attachments: [String]`.
public enum RelayAttachmentInput: Sendable, Equatable {
    /// A stored file id (e.g. `file_...`).
    case stored(String)

    var fileId: String {
        switch self {
        case .stored(let id): return id
        }
    }
}

extension RelayAttachmentInput: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .stored(value)
    }
}

public struct RelayMessageReaction: Sendable, Equatable, Decodable {
    public let emoji: String
    public let count: Int
    public let agents: [String]

    public init(emoji: String, count: Int, agents: [String]) {
        self.emoji = emoji
        self.count = count
        self.agents = agents
    }
}

// MARK: - Threads (#1150)

/// A message thread: the parent message plus its ordered replies. Mirrors the
/// TS SDK `RelayThread`.
public struct RelayThread: Sendable, Equatable {
    public let parent: RelayMessage
    public let replies: [RelayMessage]

    public init(parent: RelayMessage, replies: [RelayMessage]) {
        self.parent = parent
        self.replies = replies
    }
}

// MARK: - Inbox (#1151)

public struct RelayInboxChannelSummary: Sendable, Equatable {
    public let channelName: String
    public let unreadCount: Int
}

public struct RelayInboxDirectSummary: Sendable, Equatable {
    public let conversationId: String
    public let from: String
    public let unreadCount: Int
    public let lastMessage: String?
}

public struct RelayInboxMention: Sendable, Equatable {
    public let id: String
    public let channelName: String
    public let from: String
    public let text: String
    public let createdAt: String?
}

/// The unread summary returned by `AgentClient.inbox.get()`. Mirrors relaycast's
/// `InboxResponse`, translated into relay-owned types.
public struct RelayInbox: Sendable, Equatable {
    public let unreadChannels: [RelayInboxChannelSummary]
    public let mentions: [RelayInboxMention]
    public let unreadDms: [RelayInboxDirectSummary]
}

// MARK: - Deliveries (#1152)

public enum RelayDeliveryState: String, Sendable, Equatable {
    case queued
    case delivered
    case acked
    case failed
    case deadLettered = "dead_lettered"
    case deferred
    case unknown

    init(_ status: String) {
        self = RelayDeliveryState(rawValue: status) ?? .unknown
    }
}

/// A durable delivery-ledger row, translated from relaycast's `Delivery` /
/// `DeliveryItem`.
public struct RelayDelivery: Sendable, Equatable {
    public let id: String
    public let messageId: String
    public let agentId: String?
    public let state: RelayDeliveryState
    public let mode: String?
    public let reason: String?
    public let error: String?
    public let availableAt: String?
    public let createdAt: String?
    /// The message the delivery carries, when the transport included it.
    public let message: RelayMessage?
}

/// Result of an ack/fail/defer transition. Mirrors the TS SDK
/// `RelayDeliveryResult` (supported variant).
public struct RelayDeliveryResult: Sendable, Equatable {
    public enum Action: String, Sendable, Equatable {
        case ack, fail, `defer`
    }

    public let action: Action
    public let deliveryId: String
    public let messageId: String
    public let state: RelayDeliveryState
    /// When the delivery becomes available again (defer transitions).
    public let deferUntil: String?

    public init(action: Action, deliveryId: String, messageId: String, state: RelayDeliveryState, deferUntil: String? = nil) {
        self.action = action
        self.deliveryId = deliveryId
        self.messageId = messageId
        self.state = state
        self.deferUntil = deferUntil
    }
}

// MARK: - Channels (rich facade, #1158)

public struct RelayChannelMember: Sendable, Equatable {
    public let agentId: String
    public let agentName: String
    public let role: String
    public let joinedAt: String?
}

/// A channel record returned by the rich channels facade. Named `…Info` to
/// avoid colliding with the realtime `RelayChannel` subscription helper.
public struct RelayChannelInfo: Sendable, Equatable {
    public let id: String
    public let name: String
    public let topic: String?
    public let createdBy: String?
    public let createdAt: String?
    public let archived: Bool
    public let memberCount: Int?
    public let members: [RelayChannelMember]
}

public struct RelayCreateChannelInput: Sendable, Equatable {
    public let name: String
    public let topic: String?

    public init(name: String, topic: String? = nil) {
        self.name = name
        self.topic = topic
    }
}

public struct RelayUpdateChannelInput: Sendable, Equatable {
    public let topic: String?

    public init(topic: String? = nil) {
        self.topic = topic
    }
}

// MARK: - Agents (rich facade, #1157)

public struct RelayAgentPresence: Sendable, Equatable {
    public let agentId: String
    public let agentName: String
    public let status: RelayAgentStatus
}

public struct RelayUpdateAgentInput: Sendable, Equatable {
    public let status: RelayAgentStatus?
    public let persona: String?

    public init(status: RelayAgentStatus? = nil, persona: String? = nil) {
        self.status = status
        self.persona = persona
    }
}

// MARK: - Nodes (#1154)

public struct RelayNodeCapability: Sendable, Equatable {
    public let name: String
    public let kind: String?
}

public struct RelayNode: Sendable, Equatable {
    public let id: String
    public let name: String
    public let status: String
    public let live: Bool
    public let capabilities: [RelayNodeCapability]
    public let tags: [String]
    public let activeAgents: Int?
    public let maxAgents: Int?
    public let version: String?
    public let lastHeartbeatAt: String?
}

public struct RelayListNodesOptions: Sendable, Equatable {
    public let capability: String?
    public let name: String?

    public init(capability: String? = nil, name: String? = nil) {
        self.capability = capability
        self.name = name
    }
}

// MARK: - Triggers (#1155)

public struct RelayTrigger: Sendable, Equatable {
    public let id: String
    public let channel: String?
    public let pattern: String?
    public let mention: Bool?
    public let actionName: String
    public let enabled: Bool
}

public struct RelayTriggerInput: Sendable, Equatable {
    public let actionName: String
    public let channel: String?
    public let pattern: String?
    public let mention: Bool?
    public let enabled: Bool?

    public init(actionName: String, channel: String? = nil, pattern: String? = nil, mention: Bool? = nil, enabled: Bool? = nil) {
        self.actionName = actionName
        self.channel = channel
        self.pattern = pattern
        self.mention = mention
        self.enabled = enabled
    }
}

public struct RelayTriggerUpdate: Sendable, Equatable {
    public let actionName: String?
    public let channel: String?
    public let pattern: String?
    public let mention: Bool?
    public let enabled: Bool?

    public init(actionName: String? = nil, channel: String? = nil, pattern: String? = nil, mention: Bool? = nil, enabled: Bool? = nil) {
        self.actionName = actionName
        self.channel = channel
        self.pattern = pattern
        self.mention = mention
        self.enabled = enabled
    }
}

// MARK: - Integrations / webhooks (#1153)

/// An inbound webhook that posts external payloads into a channel.
public struct RelayWebhook: Sendable, Equatable {
    public let id: String
    public let name: String?
    public let channel: String?
    public let url: String
    public let token: String?
    public let createdAt: String?
}

public struct RelayCreateWebhookInput: Sendable, Equatable {
    public let channel: String
    public let name: String?

    public init(channel: String, name: String? = nil) {
        self.channel = channel
        self.name = name
    }
}

/// An outbound event subscription (delivers workspace events to a URL).
public struct RelayEventSubscription: Sendable, Equatable {
    public let id: String
    public let url: String
    public let events: [String]
    public let createdAt: String?
}

public struct RelayCreateSubscriptionInput: Sendable, Equatable {
    public let url: String
    /// Canonical dotted event names, e.g. `message.created`, `action.completed`.
    public let events: [String]
    public let secret: String?

    public init(url: String, events: [String], secret: String? = nil) {
        self.url = url
        self.events = events
        self.secret = secret
    }
}

// MARK: - Workspace admin (#1156)

public struct RelayWorkspaceInfo: Sendable, Equatable {
    public let id: String
    public let name: String
    public let plan: String?
    public let systemPrompt: String?
    public let createdAt: String?
}

public struct RelayUpdateWorkspaceInput: Sendable, Equatable {
    public let name: String?
    public let systemPrompt: String?

    public init(name: String? = nil, systemPrompt: String? = nil) {
        self.name = name
        self.systemPrompt = systemPrompt
    }
}

// MARK: - Files (#1144 upload support)

public struct RelayUploadTicket: Sendable, Equatable {
    public let fileId: String
    public let uploadURL: String
    public let expiresAt: String?
}
