import Foundation

/// A route keeps its original snapshot for restoration, but identity belongs
/// to the conversation. Presence and handoff updates must not replace a screen.
struct MobileConversationRoute: Hashable {
    let agent: RelayAgent
    var id: String { agent.id }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// Pending and persisted rows have separate identities even if their raw IDs
/// happen to match. A completed send therefore always changes the scroll target.
enum MobileChatScrollTarget: Hashable {
    case pending(String)
    case message(String)

    static func latest(pending: [String], messages: [String]) -> Self? {
        if let id = pending.last { return .pending(id) }
        return messages.last.map(Self.message)
    }
}

/// The destination can stay on a retained (even failed) pending bubble while
/// server history changes beneath it. Those changes still need reconciliation.
struct MobileChatScrollRequest: Hashable {
    let target: MobileChatScrollTarget?
    let latestMessageID: String?

    init(pending: [String], messages: [String]) {
        target = MobileChatScrollTarget.latest(pending: pending, messages: messages)
        latestMessageID = messages.last
    }
}
