import Foundation
import Relaycast

// MARK: - Translation from the relaycast engine SDK's wire types into
// AgentRelaySDK's relay-owned public types. This is the Swift counterpart to
// the TypeScript SDK's `relaycast-translate.ts`: raw relaycast responses never
// leak through the facade's public surface — every rich getter returns a
// `Relay*` type built here.

extension RelayAgentStatus {
    /// Map hosted presence and lifecycle states onto the legacy public enum.
    ///
    /// Relaycast 6.1 added lifecycle states while this SDK still supports
    /// 6.0.5, so bridge by raw value instead of naming cases that older
    /// Relaycast releases do not compile against.
    init(hosted status: String) {
        switch status {
        case "active", "online": self = .online
        case "idle", "blocked", "waiting", "away": self = .away
        case "offline": self = .offline
        default: self = .unknown
        }
    }

    var relaycastStatus: Relaycast.AgentStatus? {
        switch self {
        case .online: return .online
        case .offline: return .offline
        case .away: return .away
        case .unknown: return nil
        }
    }
}

extension RelayAttachment {
    init(_ file: Relaycast.FileAttachment) {
        self.init(
            id: file.fileId,
            filename: file.filename,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes
        )
    }
}

extension RelayMessageReaction {
    init(_ group: Relaycast.ReactionGroup) {
        self.init(emoji: group.emoji, count: group.count, agents: group.agents)
    }
}

extension RelayMessage {
    /// Build a `RelayMessage` from a relaycast `MessageWithMeta`. `MessageWithMeta`
    /// carries a channel id but no channel name, so `channel.name` is left `nil`
    /// (callers that know the channel name set it separately).
    init(_ meta: Relaycast.MessageWithMeta) {
        self.init(
            id: meta.id,
            messageId: meta.id,
            text: meta.text,
            from: RelayMessageSender(id: meta.agentId, name: meta.agentName),
            channel: meta.channelId.map { RelayMessageChannelRef(id: $0, name: nil) },
            threadId: meta.threadId,
            createdAt: meta.createdAt,
            attachments: (meta.attachments ?? []).map { RelayAttachment($0) },
            reactions: meta.reactions?.map { RelayMessageReaction($0) },
            replyCount: meta.replyCount,
            readByCount: meta.readByCount,
            mentions: meta.mentions
        )
    }
}

extension RelayThread {
    init(_ response: Relaycast.ThreadResponse) {
        self.init(
            parent: RelayMessage(response.parent),
            replies: response.replies.map { RelayMessage($0) }
        )
    }
}

extension RelayInbox {
    init(_ response: Relaycast.InboxResponse) {
        self.init(
            unreadChannels: response.unreadChannels.map {
                RelayInboxChannelSummary(channelName: $0.channelName, unreadCount: $0.unreadCount)
            },
            mentions: response.mentions.map {
                RelayInboxMention(
                    id: $0.id,
                    channelName: $0.channelName,
                    from: $0.agentName,
                    text: $0.text,
                    createdAt: $0.createdAt
                )
            },
            unreadDms: response.unreadDms.map {
                RelayInboxDirectSummary(
                    conversationId: $0.conversationId,
                    from: $0.from,
                    unreadCount: $0.unreadCount,
                    lastMessage: $0.lastMessage
                )
            }
        )
    }
}

extension RelayDelivery {
    init(_ item: Relaycast.DeliveryItem) {
        self.init(
            id: item.id,
            messageId: item.messageId,
            agentId: item.agentId,
            state: RelayDeliveryState(item.status.rawValue),
            mode: item.mode,
            reason: item.reason,
            error: item.error,
            availableAt: item.availableAt,
            createdAt: item.createdAt,
            message: item.message.map { RelayMessage($0) }
        )
    }

    init(_ delivery: Relaycast.Delivery) {
        self.init(
            id: delivery.id,
            messageId: delivery.messageId,
            agentId: delivery.agentId,
            state: RelayDeliveryState(delivery.status.rawValue),
            mode: delivery.mode,
            reason: delivery.reason,
            error: delivery.error,
            availableAt: delivery.availableAt,
            createdAt: delivery.createdAt,
            message: nil
        )
    }
}

extension RelayMessage {
    /// Build a `RelayMessage` from a relaycast `DeliveryMessage` payload.
    init(_ delivery: Relaycast.DeliveryMessage) {
        self.init(
            id: delivery.id,
            messageId: delivery.id,
            text: delivery.text,
            from: RelayMessageSender(id: delivery.agentId, name: delivery.agentName),
            channel: RelayMessageChannelRef(id: delivery.channelId, name: nil),
            threadId: delivery.threadId,
            createdAt: delivery.createdAt
        )
    }
}

extension RelayDeliveryResult {
    init(action: Action, delivery: Relaycast.Delivery) {
        self.init(
            action: action,
            deliveryId: delivery.id,
            messageId: delivery.messageId,
            state: RelayDeliveryState(delivery.status.rawValue),
            deferUntil: action == .defer ? delivery.availableAt : nil
        )
    }
}

extension RelayChannelMember {
    init(_ member: Relaycast.ChannelMemberInfo) {
        self.init(
            agentId: member.agentId,
            agentName: member.agentName,
            role: member.role,
            joinedAt: member.joinedAt
        )
    }
}

extension RelayChannelInfo {
    init(_ channel: Relaycast.Channel) {
        self.init(
            id: channel.id,
            name: channel.name,
            topic: channel.topic,
            createdBy: channel.createdBy,
            createdAt: channel.createdAt,
            archived: channel.isArchived ?? false,
            memberCount: channel.memberCount,
            members: []
        )
    }

    init(_ channel: Relaycast.ChannelWithMembers) {
        self.init(
            id: channel.id,
            name: channel.name,
            topic: channel.topic,
            createdBy: channel.createdBy,
            createdAt: channel.createdAt,
            archived: channel.isArchived ?? false,
            memberCount: channel.memberCount,
            members: channel.members.map { RelayChannelMember($0) }
        )
    }
}

extension RelayAgent {
    init(_ agent: Relaycast.Agent) {
        self.init(
            id: agent.id,
            name: agent.name,
            type: RelayAgentType(rawValue: agent.type.rawValue) ?? .agent,
            status: RelayAgentStatus(agent.status),
            persona: agent.persona,
            createdAt: agent.createdAt,
            lastSeenAt: agent.lastSeen
        )
    }
}

extension RelayAgentPresence {
    init(_ presence: Relaycast.AgentPresenceInfo) {
        self.init(
            agentId: presence.agentId,
            agentName: presence.agentName,
            status: RelayAgentStatus(hosted: presence.status)
        )
    }
}

extension RelayNode {
    init(_ node: Relaycast.NodeRosterEntry) {
        self.init(
            id: node.id,
            name: node.name,
            status: node.status,
            live: node.live,
            capabilities: node.capabilities.map { RelayNodeCapability(name: $0.name, kind: $0.kind) },
            tags: node.tags,
            activeAgents: node.activeAgents,
            maxAgents: node.maxAgents,
            version: node.version,
            lastHeartbeatAt: node.lastHeartbeatAt
        )
    }
}

extension RelayNodeAgentBinding {
    init(_ binding: Relaycast.NodeAgentBinding) {
        self.init(
            id: binding.id,
            agentId: binding.agentId,
            agentName: binding.agentName,
            nodeId: binding.nodeId,
            nodeName: binding.nodeName,
            nodeKind: binding.nodeKind,
            nodeRole: binding.nodeRole,
            status: binding.status,
            sessionRef: binding.sessionRef,
            priority: binding.priority
        )
    }
}

extension RelayTrigger {
    init(_ trigger: Relaycast.Trigger) {
        self.init(
            id: trigger.id,
            channel: trigger.channel,
            pattern: trigger.pattern,
            mention: trigger.mention,
            actionName: trigger.actionName,
            enabled: trigger.enabled
        )
    }
}

extension RelayWebhook {
    init(_ webhook: Relaycast.Webhook) {
        self.init(
            id: webhook.id,
            name: webhook.name,
            channel: webhook.channelName,
            url: webhook.url,
            token: nil,
            createdAt: webhook.createdAt
        )
    }

    init(_ response: Relaycast.CreateWebhookResponse) {
        self.init(
            id: response.webhookId,
            name: response.name,
            channel: response.channel,
            url: response.url,
            token: response.token,
            createdAt: response.createdAt
        )
    }
}

extension RelayEventSubscription {
    init(_ subscription: Relaycast.EventSubscription) {
        self.init(
            id: subscription.id,
            url: subscription.url,
            events: subscription.events,
            createdAt: subscription.createdAt
        )
    }

    init(_ response: Relaycast.CreateSubscriptionResponse) {
        self.init(
            id: response.id,
            url: response.url,
            events: response.events,
            createdAt: response.createdAt
        )
    }
}

extension RelayWorkspaceInfo {
    init(_ workspace: Relaycast.Workspace) {
        self.init(
            id: workspace.id,
            name: workspace.name,
            plan: workspace.plan,
            systemPrompt: workspace.systemPrompt,
            createdAt: workspace.createdAt
        )
    }
}

extension RelayUploadTicket {
    init(_ response: Relaycast.UploadResponse) {
        self.init(
            fileId: response.fileId,
            uploadURL: response.uploadUrl,
            expiresAt: response.expiresAt
        )
    }
}
