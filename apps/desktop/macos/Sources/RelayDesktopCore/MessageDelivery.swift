import Foundation

/// How a delivery note reads.
public enum DeliveryTone: Equatable, Sendable {
    case delivered
    case waiting
    case failed
    case unknown
}

/// What the composer says about a recipient and a message sent to it. The
/// message's state is what Relaycast holds for it (`roster.get` with its
/// id); the recipient's liveness is only a hint shown beside it.
public enum MessageDelivery {
    /// The note after a send. `recipient` is the latest lookup, for why a
    /// message is queued.
    public static func note(_ state: MessageState?, recipient: Recipient?) -> (text: String, tone: DeliveryTone) {
        switch state {
        case nil: return ("Sent — delivery unknown", .unknown)
        case .queued?:
            return recipient?.agent?.liveness == .offline
                ? ("Queued — agent not running", .waiting)
                : ("Queued — not yet handed to the agent", .waiting)
        case .delivered?: return ("Delivered", .delivered)
        case .pickedUp?: return ("Picked up by the agent", .delivered)
        case .noSuchAgent?: return ("No such agent", .failed)
        }
    }

    /// Whether a message to `recipient` would wait for an agent that is not
    /// running.
    public static func queues(_ recipient: Recipient?) -> Bool {
        recipient?.known == true && recipient?.agent?.liveness == .offline
    }

    /// The inline warning before a send. Nothing when the roster of the
    /// workspace messages go to cannot be read.
    public static func warning(for recipient: Recipient) -> String? {
        guard recipient.known else { return nil }
        guard let agent = recipient.agent else { return "No agent has this name or address." }
        return agent.liveness == .offline ? "@\(agent.name) is not running right now. Queue anyway?" : nil
    }

    /// Whether a reply is expected, and when the recipient was last seen.
    public static func replyNote(for recipient: Recipient, now: Date = Date()) -> String? {
        guard recipient.known else { return nil }
        guard let agent = recipient.agent else { return "No such agent — no reply is expected." }
        let seen = agent.lastSeenMs.map { ", last seen \(RelativeTime.string(milliseconds: $0, relativeTo: now))" } ?? ""
        switch agent.liveness {
        case .live: return "Running\(seen) — a reply can come any time."
        case .idle: return "Idle\(seen) — it replies when it picks the message up."
        case .offline: return "Not running\(seen) — no reply until it runs again."
        }
    }
}

extension Liveness {
    /// Whether it is running now.
    public var isRunning: Bool { self == .live || self == .idle }
}
