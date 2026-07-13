import Foundation
import XCTest
import Relaycast
@testable import AgentRelaySDK

/// Unit coverage for the rich facade layer (#1144, #1150–#1159): the
/// translation from relaycast wire types into relay-owned types, and the typed
/// listener hub's selector matching. Network behaviour is covered by relaycast's
/// own test suite; here we exercise the pure translation/matching glue.
final class RelayFacadeTests: XCTestCase {

    // Relaycast decodes with `.convertFromSnakeCase`; these fixtures use
    // camelCase keys and a plain decoder, which is equivalent for our purposes.
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: - Threads (#1150)

    func testThreadTranslationMapsParentAndReplies() throws {
        let response = try decode(Relaycast.ThreadResponse.self, """
        {
          "parent": {"id":"m1","agentId":"a1","agentName":"alice","text":"root","createdAt":"2026-07-01T00:00:00Z"},
          "replies": [
            {"id":"m2","agentId":"a2","agentName":"bob","text":"reply","createdAt":"2026-07-01T00:01:00Z","threadId":"m1"}
          ]
        }
        """)
        let thread = RelayThread(response)
        XCTAssertEqual(thread.parent.messageId, "m1")
        XCTAssertEqual(thread.parent.from.name, "alice")
        XCTAssertEqual(thread.replies.count, 1)
        XCTAssertEqual(thread.replies[0].text, "reply")
        XCTAssertEqual(thread.replies[0].threadId, "m1")
    }

    // MARK: - Attachments (#1144)

    func testAttachmentTranslationFromFileAttachment() throws {
        let file = try decode(Relaycast.FileAttachment.self, """
        {"fileId":"f1","filename":"diagram.png","contentType":"image/png","sizeBytes":2048}
        """)
        let attachment = RelayAttachment(file)
        XCTAssertEqual(attachment.id, "f1")
        XCTAssertEqual(attachment.filename, "diagram.png")
        XCTAssertEqual(attachment.contentType, "image/png")
        XCTAssertEqual(attachment.sizeBytes, 2048)
    }

    func testMessageDecodesInboundAttachments() throws {
        // Inbound event payloads carry attachments in snake_case.
        let message = try decode(RelayMessage.self, """
        {"id":"m1","message_id":"m1","body":"see attached","from":{"name":"alice"},
         "attachments":[{"file_id":"f9","filename":"a.txt","content_type":"text/plain","size_bytes":12}]}
        """)
        XCTAssertEqual(message.attachments.count, 1)
        XCTAssertEqual(message.attachments[0].id, "f9")
        XCTAssertEqual(message.attachments[0].filename, "a.txt")
    }

    func testAttachmentInputStringLiteralIsStoredId() {
        let input: RelayAttachmentInput = "file_123"
        XCTAssertEqual(input.fileId, "file_123")
    }

    // MARK: - Inbox (#1151)

    func testInboxTranslation() throws {
        let response = try decode(Relaycast.InboxResponse.self, """
        {
          "unreadChannels":[{"channelName":"general","unreadCount":3}],
          "mentions":[{"id":"m1","channelName":"general","agentName":"alice","text":"@bob hi","createdAt":"2026-07-01T00:00:00Z"}],
          "unreadDms":[{"conversationId":"dm1","from":"carol","unreadCount":2,"lastMessage":"ping"}]
        }
        """)
        let inbox = RelayInbox(response)
        XCTAssertEqual(inbox.unreadChannels.first?.channelName, "general")
        XCTAssertEqual(inbox.unreadChannels.first?.unreadCount, 3)
        XCTAssertEqual(inbox.mentions.first?.from, "alice")
        XCTAssertEqual(inbox.unreadDms.first?.conversationId, "dm1")
        XCTAssertEqual(inbox.unreadDms.first?.lastMessage, "ping")
    }

    // MARK: - Deliveries (#1152)

    func testDeliveryResultTranslationForDefer() throws {
        let delivery = try decode(Relaycast.Delivery.self, """
        {"id":"d1","messageId":"m1","channelId":"c1","agentId":"a1","status":"queued",
         "mode":"push","availableAt":"2026-07-02T00:00:00Z","createdAt":"2026-07-01T00:00:00Z"}
        """)
        let result = RelayDeliveryResult(action: .defer, delivery: delivery)
        XCTAssertEqual(result.action, .defer)
        XCTAssertEqual(result.deliveryId, "d1")
        XCTAssertEqual(result.messageId, "m1")
        XCTAssertEqual(result.state, .queued)
        XCTAssertEqual(result.deferUntil, "2026-07-02T00:00:00Z")
    }

    func testDeliveryResultAckOmitsDeferUntil() throws {
        let delivery = try decode(Relaycast.Delivery.self, """
        {"id":"d2","messageId":"m2","channelId":"c1","agentId":"a1","status":"acked",
         "mode":"push","availableAt":"2026-07-02T00:00:00Z","createdAt":"2026-07-01T00:00:00Z"}
        """)
        let result = RelayDeliveryResult(action: .ack, delivery: delivery)
        XCTAssertEqual(result.state, .acked)
        XCTAssertNil(result.deferUntil)
    }

    func testDeliveryStateMapsDeadLettered() {
        XCTAssertEqual(RelayDeliveryState("dead_lettered"), .deadLettered)
        XCTAssertEqual(RelayDeliveryState("bogus"), .unknown)
    }

    // MARK: - Channels (#1158)

    func testChannelTranslationWithMembers() throws {
        let channel = try decode(Relaycast.ChannelWithMembers.self, """
        {"id":"c1","name":"general","topic":"chatter","createdAt":"2026-07-01T00:00:00Z",
         "isArchived":false,"memberCount":2,
         "members":[{"agentId":"a1","agentName":"alice","role":"owner","joinedAt":"2026-07-01T00:00:00Z"}]}
        """)
        let info = RelayChannelInfo(channel)
        XCTAssertEqual(info.name, "general")
        XCTAssertEqual(info.topic, "chatter")
        XCTAssertFalse(info.archived)
        XCTAssertEqual(info.members.count, 1)
        XCTAssertEqual(info.members[0].agentName, "alice")
        XCTAssertEqual(info.members[0].role, "owner")
    }

    // MARK: - Agents (#1157)

    func testAgentTranslation() throws {
        let agent = try decode(Relaycast.Agent.self, """
        {"id":"a1","name":"alice","type":"agent","status":"online","persona":"reviewer","createdAt":"2026-07-01T00:00:00Z"}
        """)
        let relayAgent = RelayAgent(agent)
        XCTAssertEqual(relayAgent.id, "a1")
        XCTAssertEqual(relayAgent.type, .agent)
        XCTAssertEqual(relayAgent.status, .online)
        XCTAssertEqual(relayAgent.persona, "reviewer")
    }

    func testAgentPresenceTranslation() throws {
        let presence = try decode(Relaycast.AgentPresenceInfo.self, """
        {"agentId":"a1","agentName":"alice","status":"offline"}
        """)
        let relayPresence = RelayAgentPresence(presence)
        XCTAssertEqual(relayPresence.agentName, "alice")
        XCTAssertEqual(relayPresence.status, .offline)
    }

    // MARK: - Nodes (#1154)

    func testNodeTranslation() throws {
        let node = try decode(Relaycast.NodeRosterEntry.self, """
        {"id":"n1","name":"worker","capabilities":[{"name":"spawn:claude","kind":"spawn"}],
         "tags":["gpu"],"version":"1.0.0","status":"online","live":true,"handlersLive":true,
         "load":0.2,"activeAgents":1,"maxAgents":4,"createdAt":"2026-07-01T00:00:00Z"}
        """)
        let relayNode = RelayNode(node)
        XCTAssertEqual(relayNode.name, "worker")
        XCTAssertTrue(relayNode.live)
        XCTAssertEqual(relayNode.capabilities.first?.name, "spawn:claude")
        XCTAssertEqual(relayNode.activeAgents, 1)
        XCTAssertEqual(relayNode.maxAgents, 4)
    }

    // MARK: - Triggers (#1155)

    func testTriggerTranslation() throws {
        let trigger = try decode(Relaycast.Trigger.self, """
        {"id":"t1","channel":"general","pattern":"deploy","mention":false,"actionName":"deploy.staging",
         "enabled":true,"createdAt":"2026-07-01T00:00:00Z"}
        """)
        let relayTrigger = RelayTrigger(trigger)
        XCTAssertEqual(relayTrigger.id, "t1")
        XCTAssertEqual(relayTrigger.actionName, "deploy.staging")
        XCTAssertTrue(relayTrigger.enabled)
    }

    // MARK: - Integrations (#1153)

    func testWebhookTranslationFromCreateResponse() throws {
        let response = try decode(Relaycast.CreateWebhookResponse.self, """
        {"webhookId":"wh1","name":"github","channel":"general","url":"https://cast/hooks/wh1",
         "token":"whsec_123","isActive":true,"createdAt":"2026-07-01T00:00:00Z"}
        """)
        let webhook = RelayWebhook(response)
        XCTAssertEqual(webhook.id, "wh1")
        XCTAssertEqual(webhook.channel, "general")
        XCTAssertEqual(webhook.token, "whsec_123")
    }

    func testSubscriptionTranslation() throws {
        let subscription = try decode(Relaycast.EventSubscription.self, """
        {"id":"sub1","url":"https://example.test/hook","events":["message.created","action.completed"],"isActive":true}
        """)
        let relaySub = RelayEventSubscription(subscription)
        XCTAssertEqual(relaySub.id, "sub1")
        XCTAssertEqual(relaySub.events, ["message.created", "action.completed"])
    }

    // MARK: - Workspace (#1156)

    func testWorkspaceInfoTranslation() throws {
        let workspace = try decode(Relaycast.Workspace.self, """
        {"id":"ws1","name":"Acme","plan":"pro","systemPrompt":"be nice","createdAt":"2026-07-01T00:00:00Z"}
        """)
        let info = RelayWorkspaceInfo(workspace)
        XCTAssertEqual(info.id, "ws1")
        XCTAssertEqual(info.name, "Acme")
        XCTAssertEqual(info.plan, "pro")
        XCTAssertEqual(info.systemPrompt, "be nice")
    }

    // MARK: - Typed listener hub selectors (#1159)

    func testSelectorStringLiteralParsing() {
        func event(_ type: String) -> RelayEvent { RelayEvent(type: type) }

        let exact: RelayEventSelector = "message.created"
        XCTAssertTrue(exact.matches(event("message.created")))
        XCTAssertFalse(exact.matches(event("message.updated")))

        let wildcard: RelayEventSelector = "*"
        XCTAssertTrue(wildcard.matches(event("anything.at.all")))

        let prefix: RelayEventSelector = "message.*"
        XCTAssertTrue(prefix.matches(event("message.created")))
        XCTAssertTrue(prefix.matches(event("message.updated")))
        // The retained trailing dot prevents `messages.*` from matching.
        XCTAssertFalse(prefix.matches(event("messages.created")))
        XCTAssertFalse(prefix.matches(event("dm.received")))
    }

    func testSelectorPredicate() {
        let selector: RelayEventSelector = .predicate { $0.type.hasPrefix("action.") }
        XCTAssertTrue(selector.matches(RelayEvent(type: "action.invoked")))
        XCTAssertFalse(selector.matches(RelayEvent(type: "message.created")))
    }

    func testNamespaceSelector() {
        let selector = RelayEventSelector.namespace("agent")
        XCTAssertTrue(selector.matches(RelayEvent(type: "agent.status.changed")))
        XCTAssertFalse(selector.matches(RelayEvent(type: "agentx.status")))
    }

    // MARK: - Listener hub dispatch

    func testListenerHubDispatchesMatchingEventsOnly() async {
        let core = HostedParticipantCore(
            engineSource: .deferred(
                relayResult: Result { try Relaycast.RelayCast(options: Relaycast.RelayCastOptions(apiKey: "rk_test")) },
                token: "at_test"
            ),
            agentId: "a1",
            agentName: "alice",
            token: "at_test",
            baseURL: URL(string: "https://cast.agentrelay.com")!
        )

        let box = MatchBox()
        _ = await core.registerTypedListener(selector: .type("message.created"), once: false) { event in
            box.record(event.type)
        }

        await core.dispatchToTypedListeners(RelayEvent(type: "message.created"))
        await core.dispatchToTypedListeners(RelayEvent(type: "message.updated"))
        await core.dispatchToTypedListeners(RelayEvent(type: "message.created"))

        XCTAssertEqual(box.matched, ["message.created", "message.created"])
    }

    func testCancelAndWaitGuaranteesRemovalBeforeReturning() async {
        // Unlike `cancel()` (which dispatches removal via an unstructured
        // Task and can race an in-flight event), `cancelAndWait()` must not
        // return until the actor-side removal has actually happened.
        let box = MatchBox()
        let token = RelayListenerToken(
            onCancel: { XCTFail("cancel() should not be exercised by this test") },
            onCancelAsync: { box.record("removed") }
        )

        await token.cancelAndWait()

        XCTAssertEqual(box.matched, ["removed"])
    }

    func testCancelAndWaitIsIdempotent() async {
        let box = MatchBox()
        let token = RelayListenerToken(
            onCancel: {},
            onCancelAsync: { box.record("removed") }
        )

        await token.cancelAndWait()
        await token.cancelAndWait()

        XCTAssertEqual(box.matched, ["removed"])
    }

    func testOnceListenerFiresOnlyOnce() async {
        let core = HostedParticipantCore(
            engineSource: .deferred(
                relayResult: Result { try Relaycast.RelayCast(options: Relaycast.RelayCastOptions(apiKey: "rk_test")) },
                token: "at_test"
            ),
            agentId: "a1",
            agentName: "alice",
            token: "at_test",
            baseURL: URL(string: "https://cast.agentrelay.com")!
        )

        let box = MatchBox()
        _ = await core.registerTypedListener(selector: .any, once: true) { event in
            box.record(event.type)
        }

        await core.dispatchToTypedListeners(RelayEvent(type: "a"))
        await core.dispatchToTypedListeners(RelayEvent(type: "b"))

        XCTAssertEqual(box.matched, ["a"])
    }
}

/// Thread-safe recorder used to assert which events reached a listener handler.
private final class MatchBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func record(_ value: String) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    var matched: [String] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}
