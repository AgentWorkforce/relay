import Foundation
import Relaycast

// MARK: - Rich relay facades layered on top of the relaycast engine SDK.
//
// These are the Swift counterpart to the TypeScript SDK's `RelayMessaging`
// sub-surfaces (`threads`, `inbox`, `deliveries`, `channels`, `agents`,
// `nodes`, `triggers`, `integrations`, `workspace`). Each facade is a thin
// value type that delegates to the shared `HostedParticipantCore` actor, which
// calls straight through to the native relaycast transport and translates the
// response into relay-owned types (never leaking `Relaycast.*` through the
// public surface). See #1150–#1158.

// MARK: - Threads (#1150)

public struct RelayThreads: Sendable {
    let core: HostedParticipantCore

    /// Fetch a message thread (parent + ordered replies).
    public func get(_ messageId: String, limit: Int? = nil, before: String? = nil, after: String? = nil) async throws -> RelayThread {
        try await core.threadGet(messageId: messageId, limit: limit, before: before, after: after)
    }

    /// Post a reply onto a message. (The hosted reply endpoint does not accept
    /// attachments; upload + post to the channel to share files in a thread.)
    @discardableResult
    public func reply(to messageId: String, text: String) async throws -> RelayMessage {
        try await core.threadReply(messageId: messageId, text: text)
    }
}

// MARK: - Inbox (#1151)

public struct RelayInboxService: Sendable {
    let core: HostedParticipantCore

    /// The unread summary: unread channels, mentions, and unread DMs.
    public func get(limit: Int? = nil) async throws -> RelayInbox {
        try await core.inboxGet(limit: limit)
    }

    /// The per-recipient delivery ledger (the durable "inbox items").
    public func list(state: RelayDeliveryState? = nil, limit: Int? = nil) async throws -> [RelayDelivery] {
        try await core.deliveriesList(state: state, limit: limit)
    }

    /// Mark a message read by id.
    public func markRead(_ messageId: String) async throws {
        try await core.markRead(messageId: messageId)
    }

    @discardableResult
    public func ack(_ deliveryId: String) async throws -> RelayDeliveryResult {
        try await core.deliveryAck(deliveryId: deliveryId)
    }

    @discardableResult
    public func fail(_ deliveryId: String, reason: String? = nil) async throws -> RelayDeliveryResult {
        try await core.deliveryFail(deliveryId: deliveryId, reason: reason)
    }

    @discardableResult
    public func `defer`(_ deliveryId: String, until: String) async throws -> RelayDeliveryResult {
        try await core.deliveryDefer(deliveryId: deliveryId, until: until)
    }
}

// MARK: - Deliveries (#1152)

public struct RelayDeliveries: Sendable {
    let core: HostedParticipantCore

    public func list(state: RelayDeliveryState? = nil, limit: Int? = nil) async throws -> [RelayDelivery] {
        try await core.deliveriesList(state: state, limit: limit)
    }

    @discardableResult
    public func ack(_ deliveryId: String) async throws -> RelayDeliveryResult {
        try await core.deliveryAck(deliveryId: deliveryId)
    }

    @discardableResult
    public func fail(_ deliveryId: String, reason: String? = nil) async throws -> RelayDeliveryResult {
        try await core.deliveryFail(deliveryId: deliveryId, reason: reason)
    }

    @discardableResult
    public func `defer`(_ deliveryId: String, until: String) async throws -> RelayDeliveryResult {
        try await core.deliveryDefer(deliveryId: deliveryId, until: until)
    }
}

// MARK: - Channels (rich facade, #1158)

public struct RelayChannels: Sendable {
    let core: HostedParticipantCore

    public func list(includeArchived: Bool = false) async throws -> [RelayChannelInfo] {
        try await core.channelsList(includeArchived: includeArchived)
    }

    public func get(_ name: String) async throws -> RelayChannelInfo {
        try await core.channelGet(name: name)
    }

    @discardableResult
    public func create(_ input: RelayCreateChannelInput) async throws -> RelayChannelInfo {
        try await core.channelCreate(input)
    }

    @discardableResult
    public func update(_ name: String, _ input: RelayUpdateChannelInput) async throws -> RelayChannelInfo {
        try await core.channelUpdate(name: name, input)
    }

    public func archive(_ name: String) async throws {
        try await core.channelArchive(name: name)
    }

    public func join(_ name: String) async throws {
        try await core.channelJoin(name: name)
    }

    public func leave(_ name: String) async throws {
        try await core.channelLeave(name: name)
    }

    public func invite(_ name: String, agent: String) async throws {
        try await core.channelInvite(name: name, agent: agent)
    }

    public func members(_ name: String) async throws -> [RelayChannelMember] {
        try await core.channelMembers(name: name)
    }

    public func mute(_ name: String) async throws {
        try await core.channelMute(name: name)
    }

    public func unmute(_ name: String) async throws {
        try await core.channelUnmute(name: name)
    }
}

// MARK: - Agents (rich facade, #1157)

public struct RelayAgents: Sendable {
    let core: HostedParticipantCore

    public func list(status: RelayAgentStatus? = nil) async throws -> [RelayAgent] {
        try await core.agentsList(status: status)
    }

    public func get(_ name: String) async throws -> RelayAgent {
        try await core.agentGet(name: name)
    }

    /// Resolve the identity of the agent this client is authenticated as.
    public func me() async throws -> RelayAgent {
        try await core.agentMe()
    }

    @discardableResult
    public func update(_ name: String, _ input: RelayUpdateAgentInput) async throws -> RelayAgent {
        try await core.agentUpdate(name: name, input)
    }

    public func delete(_ name: String) async throws {
        try await core.agentDelete(name: name)
    }

    public func presence() async throws -> [RelayAgentPresence] {
        try await core.agentsPresence()
    }
}

// MARK: - Nodes (#1154)

public struct RelayNodes: Sendable {
    let core: HostedParticipantCore

    public func list(_ options: RelayListNodesOptions = RelayListNodesOptions()) async throws -> [RelayNode] {
        try await core.nodesList(options)
    }

    public func get(_ name: String) async throws -> RelayNode {
        try await core.nodeGet(name: name)
    }

    public func agents(_ name: String) async throws -> [RelayNodeAgentBinding] {
        try await core.nodeAgents(name: name)
    }

    public func bind(_ name: String, agent: String) async throws {
        try await core.nodeBind(name: name, agent: agent)
    }

    public func unbind(_ name: String, agent: String) async throws {
        try await core.nodeUnbind(name: name, agent: agent)
    }
}

// MARK: - Triggers (#1155)

public struct RelayTriggers: Sendable {
    let core: HostedParticipantCore

    public func list() async throws -> [RelayTrigger] {
        try await core.triggersList()
    }

    @discardableResult
    public func create(_ input: RelayTriggerInput) async throws -> RelayTrigger {
        try await core.triggerCreate(input)
    }

    @discardableResult
    public func update(_ id: String, _ input: RelayTriggerUpdate) async throws -> RelayTrigger {
        try await core.triggerUpdate(id: id, input)
    }

    public func delete(_ id: String) async throws {
        try await core.triggerDelete(id: id)
    }
}

// MARK: - Integrations: webhooks + subscriptions (#1153)

public struct RelayWebhooks: Sendable {
    let core: HostedParticipantCore

    /// Create an inbound webhook that posts external payloads into a channel.
    @discardableResult
    public func create(_ input: RelayCreateWebhookInput) async throws -> RelayWebhook {
        try await core.webhookCreate(input)
    }

    public func list() async throws -> [RelayWebhook] {
        try await core.webhooksList()
    }

    public func delete(_ id: String) async throws {
        try await core.webhookDelete(id: id)
    }
}

public struct RelaySubscriptions: Sendable {
    let core: HostedParticipantCore

    @discardableResult
    public func create(_ input: RelayCreateSubscriptionInput) async throws -> RelayEventSubscription {
        try await core.subscriptionCreate(input)
    }

    public func list() async throws -> [RelayEventSubscription] {
        try await core.subscriptionsList()
    }

    public func get(_ id: String) async throws -> RelayEventSubscription {
        try await core.subscriptionGet(id: id)
    }

    public func delete(_ id: String) async throws {
        try await core.subscriptionDelete(id: id)
    }
}

public struct RelayIntegrations: Sendable {
    public let webhooks: RelayWebhooks
    public let subscriptions: RelaySubscriptions

    init(core: HostedParticipantCore) {
        self.webhooks = RelayWebhooks(core: core)
        self.subscriptions = RelaySubscriptions(core: core)
    }
}

// MARK: - Workspace facade, workspace-scoped (#1156)

/// Consolidated workspace entry point exposed as `AgentRelay.workspace`:
/// participant registration, reconnection, and workspace admin. Mirrors the TS
/// SDK's `relay.workspace`.
public struct RelayWorkspace: Sendable {
    private let relay: AgentRelay

    init(relay: AgentRelay) {
        self.relay = relay
    }

    /// Register a participant, adopting + rotating an existing identity on a
    /// name conflict (matching the TS default).
    @discardableResult
    public func register(name: String, type: RelayAgentType = .agent) async throws -> AgentRegistration {
        try await relay.registerOrRotate(name: name, type: type)
    }

    /// Rehydrate a live client from a persisted agent token.
    public func reconnect(apiToken: String) async throws -> AgentClient {
        try await relay.reconnect(apiToken: apiToken)
    }

    public func info() async throws -> RelayWorkspaceInfo {
        try await relay.workspaceInfoDetail()
    }

    @discardableResult
    public func update(_ input: RelayUpdateWorkspaceInput) async throws -> RelayWorkspaceInfo {
        try await relay.workspaceUpdate(input)
    }

    public func delete() async throws {
        try await relay.workspaceDelete()
    }
}

// MARK: - Workspace admin, agent-scoped (#1156)

public struct RelayWorkspaceAdmin: Sendable {
    let core: HostedParticipantCore

    public func info() async throws -> RelayWorkspaceInfo {
        try await core.workspaceInfoDetail()
    }

    @discardableResult
    public func update(_ input: RelayUpdateWorkspaceInput) async throws -> RelayWorkspaceInfo {
        try await core.workspaceUpdate(input)
    }

    public func delete() async throws {
        try await core.workspaceDelete()
    }
}

// MARK: - Files (#1144 upload support)

public struct RelayFiles: Sendable {
    let core: HostedParticipantCore

    /// Request an upload ticket (file id + signed URL). PUT the bytes to
    /// `uploadURL`, then pass the returned `fileId` as a `RelayAttachmentInput`.
    public func upload(filename: String, contentType: String, sizeBytes: Int) async throws -> RelayUploadTicket {
        try await core.fileUpload(filename: filename, contentType: contentType, sizeBytes: sizeBytes)
    }

    /// Finalize an upload once the bytes have been PUT to the signed URL.
    public func complete(fileId: String) async throws {
        try await core.fileComplete(fileId: fileId)
    }
}

// MARK: - Core delegation

extension HostedParticipantCore {
    private func run<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as Relaycast.RelayError {
            throw RelayError(error)
        }
    }

    // Threads ---------------------------------------------------------------

    func threadGet(messageId: String, limit: Int?, before: String?, after: String?) async throws -> RelayThread {
        let engine = try engine()
        return try await run {
            let response = try await engine.thread(messageId, options: Relaycast.MessageListQuery(limit: limit, before: before, after: after))
            return RelayThread(response)
        }
    }

    func threadReply(messageId: String, text: String) async throws -> RelayMessage {
        let engine = try engine()
        return try await run {
            let meta = try await engine.reply(messageId, text: text)
            return RelayMessage(meta)
        }
    }

    // Inbox / deliveries ----------------------------------------------------

    func inboxGet(limit: Int?) async throws -> RelayInbox {
        let engine = try engine()
        return try await run {
            let response = try await engine.inbox(options: Relaycast.InboxOptions(limit: limit))
            return RelayInbox(response)
        }
    }

    func markRead(messageId: String) async throws {
        let engine = try engine()
        try await run { _ = try await engine.markRead(messageID: messageId) }
    }

    func deliveriesList(state: RelayDeliveryState?, limit: Int?) async throws -> [RelayDelivery] {
        // relaycast's `DeliveryStatus` has no `.deferred` case (a deferred
        // delivery is represented as `queued` with a future `deferUntil` on
        // its own model, not a distinct filterable status). Silently dropping
        // the filter would return every delivery when the caller asked for
        // deferred-only ones, so reject the request instead of widening it.
        if state == .deferred {
            throw RelayError.unsupported("relaycast does not support filtering deliveries by \"deferred\" status; fetch unfiltered and check `deferUntil`/`deferredAt` on each delivery instead.")
        }
        let engine = try engine()
        return try await run {
            let options = Relaycast.ListDeliveriesOptions(status: state.flatMap(Self.deliveryStatus), limit: limit)
            let items = try await engine.deliveries(options: options)
            return items.map { RelayDelivery($0) }
        }
    }

    func deliveryAck(deliveryId: String) async throws -> RelayDeliveryResult {
        let engine = try engine()
        return try await run {
            let delivery = try await engine.ackDelivery(deliveryId)
            return RelayDeliveryResult(action: .ack, delivery: delivery)
        }
    }

    func deliveryFail(deliveryId: String, reason: String?) async throws -> RelayDeliveryResult {
        let engine = try engine()
        return try await run {
            let delivery = try await engine.failDelivery(deliveryId, options: Relaycast.FailDeliveryRequest(error: reason))
            return RelayDeliveryResult(action: .fail, delivery: delivery)
        }
    }

    func deliveryDefer(deliveryId: String, until: String) async throws -> RelayDeliveryResult {
        let engine = try engine()
        return try await run {
            let delivery = try await engine.deferDelivery(deliveryId, options: Relaycast.DeferDeliveryRequest(availableAt: until))
            return RelayDeliveryResult(action: .defer, delivery: delivery)
        }
    }

    // Channels --------------------------------------------------------------

    func channelsList(includeArchived: Bool) async throws -> [RelayChannelInfo] {
        let engine = try engine()
        return try await run {
            let channels = try await engine.channels.list(Relaycast.ChannelListOptions(includeArchived: includeArchived))
            return channels.map { RelayChannelInfo($0) }
        }
    }

    func channelGet(name: String) async throws -> RelayChannelInfo {
        let engine = try engine()
        return try await run {
            let channel = try await engine.channels.get(Self.normalizeChannel(name))
            return RelayChannelInfo(channel)
        }
    }

    func channelCreate(_ input: RelayCreateChannelInput) async throws -> RelayChannelInfo {
        let engine = try engine()
        return try await run {
            let channel = try await engine.channels.create(Relaycast.CreateChannelRequest(name: Self.normalizeChannel(input.name), topic: input.topic))
            return RelayChannelInfo(channel)
        }
    }

    func channelUpdate(name: String, _ input: RelayUpdateChannelInput) async throws -> RelayChannelInfo {
        let engine = try engine()
        return try await run {
            let channel = try await engine.channels.update(Self.normalizeChannel(name), data: Relaycast.UpdateChannelRequest(topic: input.topic))
            return RelayChannelInfo(channel)
        }
    }

    func channelArchive(name: String) async throws {
        let engine = try engine()
        try await run { try await engine.channels.archive(Self.normalizeChannel(name)) }
    }

    func channelJoin(name: String) async throws {
        let engine = try engine()
        try await run { _ = try await engine.channels.join(Self.normalizeChannel(name)) }
    }

    func channelLeave(name: String) async throws {
        let engine = try engine()
        try await run { try await engine.channels.leave(Self.normalizeChannel(name)) }
    }

    func channelInvite(name: String, agent: String) async throws {
        let engine = try engine()
        try await run { _ = try await engine.channels.invite(channel: Self.normalizeChannel(name), agent: Self.stripSigil(agent)) }
    }

    func channelMembers(name: String) async throws -> [RelayChannelMember] {
        let engine = try engine()
        return try await run {
            let members = try await engine.channels.members(Self.normalizeChannel(name))
            return members.map { RelayChannelMember($0) }
        }
    }

    func channelMute(name: String) async throws {
        let engine = try engine()
        try await run { try await engine.channels.mute(Self.normalizeChannel(name)) }
    }

    func channelUnmute(name: String) async throws {
        let engine = try engine()
        try await run { try await engine.channels.unmute(Self.normalizeChannel(name)) }
    }

    // Agents ----------------------------------------------------------------

    func agentsList(status: RelayAgentStatus?) async throws -> [RelayAgent] {
        let relay = try relayCast()
        let statusFilter = status.flatMap { $0 == .unknown ? nil : $0.rawValue }
        return try await run {
            let agents = try await relay.agents.list(Relaycast.AgentListQuery(status: statusFilter))
            return agents.map { RelayAgent($0) }
        }
    }

    func agentGet(name: String) async throws -> RelayAgent {
        let relay = try relayCast()
        return try await run {
            let agent = try await relay.agents.get(Self.stripSigil(name))
            return RelayAgent(agent)
        }
    }

    func agentMe() async throws -> RelayAgent {
        let engine = try engine()
        return try await run {
            let agent = try await engine.me()
            return RelayAgent(agent)
        }
    }

    func agentUpdate(name: String, _ input: RelayUpdateAgentInput) async throws -> RelayAgent {
        let relay = try relayCast()
        return try await run {
            let agent = try await relay.agents.update(
                Self.stripSigil(name),
                data: Relaycast.UpdateAgentRequest(status: input.status?.relaycastStatus, persona: input.persona)
            )
            return RelayAgent(agent)
        }
    }

    func agentDelete(name: String) async throws {
        let relay = try relayCast()
        try await run { try await relay.agents.delete(Self.stripSigil(name)) }
    }

    func agentsPresence() async throws -> [RelayAgentPresence] {
        let relay = try relayCast()
        return try await run {
            let presence = try await relay.agents.presence()
            return presence.map { RelayAgentPresence($0) }
        }
    }

    // Nodes -----------------------------------------------------------------

    func nodesList(_ options: RelayListNodesOptions) async throws -> [RelayNode] {
        let relay = try relayCast()
        return try await run {
            let nodes = try await relay.nodes.list(Relaycast.NodeListQuery(capability: options.capability, name: options.name))
            return nodes.map { RelayNode($0) }
        }
    }

    func nodeGet(name: String) async throws -> RelayNode {
        let relay = try relayCast()
        return try await run {
            let node = try await relay.nodes.get(name)
            return RelayNode(node)
        }
    }

    func nodeAgents(name: String) async throws -> [RelayNodeAgentBinding] {
        let relay = try relayCast()
        return try await run {
            let bindings = try await relay.nodes.listAgents(name)
            return bindings.map { RelayNodeAgentBinding($0) }
        }
    }

    func terminalTarget(agent name: String) async throws -> RelayTerminalTarget {
        let cleanName = Self.normalizeTerminalAgent(name)
        guard !cleanName.isEmpty else {
            throw RelayError.protocolError(
                code: "invalid_terminal_target",
                message: "Terminal agent name cannot be empty",
                retryable: false
            )
        }

        let relay = try relayCast()
        return try await run {
            let liveNodes = try await relay.nodes.list(Relaycast.NodeListQuery())
                .filter(\.live)
                .sorted { $0.name < $1.name }
            let nodes = relay.nodes
            var remaining = liveNodes.makeIterator()
            var candidates: [Relaycast.NodeAgentBinding] = []
            try await withThrowingTaskGroup(of: [Relaycast.NodeAgentBinding].self) { group in
                for _ in 0..<min(4, liveNodes.count) {
                    guard let node = remaining.next() else { break }
                    let nodeName = node.name
                    group.addTask { try await nodes.listAgents(nodeName) }
                }
                while let bindings = try await group.next() {
                    candidates.append(contentsOf: bindings.filter {
                        $0.agentName.caseInsensitiveCompare(cleanName) == .orderedSame
                            && $0.status == "active"
                    })
                    if let node = remaining.next() {
                        let nodeName = node.name
                        group.addTask { try await nodes.listAgents(nodeName) }
                    }
                }
            }
            guard let binding = candidates.sorted(by: {
                if $0.priority != $1.priority { return $0.priority > $1.priority }
                return $0.nodeName < $1.nodeName
            }).first else {
                throw RelayError.protocolError(
                    code: "terminal_target_unavailable",
                    message: "No live fleet node is hosting agent '\(cleanName)'",
                    retryable: true
                )
            }
            return RelayTerminalTarget(
                nodeId: binding.nodeId,
                nodeName: binding.nodeName,
                agentId: binding.agentId,
                agentName: binding.agentName,
                sessionRef: binding.sessionRef
            )
        }
    }

    func nodeBind(name: String, agent: String) async throws {
        let relay = try relayCast()
        try await run { _ = try await relay.nodes.bindAgent(name, request: Relaycast.BindAgentToNodeRequest(agentName: Self.stripSigil(agent))) }
    }

    func nodeUnbind(name: String, agent: String) async throws {
        let relay = try relayCast()
        try await run { try await relay.nodes.unbindAgent(name, agentName: Self.stripSigil(agent)) }
    }

    // Triggers --------------------------------------------------------------

    func triggersList() async throws -> [RelayTrigger] {
        let relay = try relayCast()
        return try await run {
            let triggers = try await relay.triggers.list()
            return triggers.map { RelayTrigger($0) }
        }
    }

    func triggerCreate(_ input: RelayTriggerInput) async throws -> RelayTrigger {
        let relay = try relayCast()
        return try await run {
            let trigger = try await relay.triggers.create(Relaycast.CreateTriggerRequest(
                actionName: input.actionName,
                channel: input.channel,
                pattern: input.pattern,
                mention: input.mention,
                enabled: input.enabled
            ))
            return RelayTrigger(trigger)
        }
    }

    func triggerUpdate(id: String, _ input: RelayTriggerUpdate) async throws -> RelayTrigger {
        let relay = try relayCast()
        return try await run {
            let trigger = try await relay.triggers.update(id, data: Relaycast.UpdateTriggerRequest(
                channel: input.channel,
                pattern: input.pattern,
                mention: input.mention,
                actionName: input.actionName,
                enabled: input.enabled
            ))
            return RelayTrigger(trigger)
        }
    }

    func triggerDelete(id: String) async throws {
        let relay = try relayCast()
        try await run { try await relay.triggers.delete(id) }
    }

    // Integrations ----------------------------------------------------------

    func webhookCreate(_ input: RelayCreateWebhookInput) async throws -> RelayWebhook {
        let relay = try relayCast()
        return try await run {
            let response = try await relay.webhooks.create(Relaycast.CreateWebhookRequest(channel: Self.normalizeChannel(input.channel), name: input.name))
            return RelayWebhook(response)
        }
    }

    func webhooksList() async throws -> [RelayWebhook] {
        let relay = try relayCast()
        return try await run {
            let webhooks = try await relay.webhooks.list()
            return webhooks.map { RelayWebhook($0) }
        }
    }

    func webhookDelete(id: String) async throws {
        let relay = try relayCast()
        try await run { try await relay.webhooks.delete(id) }
    }

    func subscriptionCreate(_ input: RelayCreateSubscriptionInput) async throws -> RelayEventSubscription {
        let relay = try relayCast()
        return try await run {
            let response = try await relay.subscriptions.create(Relaycast.CreateSubscriptionRequest(url: input.url, events: input.events, secret: input.secret))
            return RelayEventSubscription(response)
        }
    }

    func subscriptionsList() async throws -> [RelayEventSubscription] {
        let relay = try relayCast()
        return try await run {
            let subscriptions = try await relay.subscriptions.list()
            return subscriptions.map { RelayEventSubscription($0) }
        }
    }

    func subscriptionGet(id: String) async throws -> RelayEventSubscription {
        let relay = try relayCast()
        return try await run {
            let subscription = try await relay.subscriptions.get(id)
            return RelayEventSubscription(subscription)
        }
    }

    func subscriptionDelete(id: String) async throws {
        let relay = try relayCast()
        try await run { try await relay.subscriptions.delete(id) }
    }

    // Workspace -------------------------------------------------------------

    func workspaceInfoDetail() async throws -> RelayWorkspaceInfo {
        let relay = try relayCast()
        return try await run {
            let workspace = try await relay.workspace.info()
            return RelayWorkspaceInfo(workspace)
        }
    }

    func workspaceUpdate(_ input: RelayUpdateWorkspaceInput) async throws -> RelayWorkspaceInfo {
        let relay = try relayCast()
        return try await run {
            let workspace = try await relay.workspace.update(Relaycast.UpdateWorkspaceRequest(name: input.name, systemPrompt: input.systemPrompt))
            return RelayWorkspaceInfo(workspace)
        }
    }

    func workspaceDelete() async throws {
        let relay = try relayCast()
        try await run { try await relay.workspace.delete() }
    }

    // Files -----------------------------------------------------------------

    func fileUpload(filename: String, contentType: String, sizeBytes: Int) async throws -> RelayUploadTicket {
        let engine = try engine()
        return try await run {
            let response = try await engine.files.upload(Relaycast.UploadRequest(filename: filename, contentType: contentType, sizeBytes: sizeBytes))
            return RelayUploadTicket(response)
        }
    }

    func fileComplete(fileId: String) async throws {
        let engine = try engine()
        try await run { _ = try await engine.files.complete(fileID: fileId) }
    }

    // Helpers ---------------------------------------------------------------

    static func deliveryStatus(_ state: RelayDeliveryState) -> Relaycast.DeliveryStatus? {
        switch state {
        case .queued: return .queued
        case .delivered: return .delivered
        case .acked: return .acked
        case .failed: return .failed
        case .deadLettered: return .deadLettered
        case .deferred, .unknown: return nil
        }
    }
}
