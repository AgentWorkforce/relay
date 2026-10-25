import Foundation

/// Wording for the OpenClaw setting, on wherever OpenClaw is set up. The
/// Linux app's `OPENCLAW_*` constants match these word for word.
public enum OpenClawCopy {
    public static let title = "OpenClaw agents"
    public static let onDetail = "Agent Relay reaches OpenClaw's Gateway on this computer, so its agents appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only, never to your other channels."
    public static let offDetail = "Turn this on so the agents of the OpenClaw Gateway on this computer appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only."
    public static let turnOnHelp = "List and message the agents of OpenClaw's Gateway"
    public static let turnOffHelp = "Stop listing and messaging OpenClaw's agents"

    /// Shown while the connected Gateway cannot limit relay sessions
    /// (`openclaw_unlimited_version`): older than 2026.8.1, it gives relay
    /// senders the agent's usual tools.
    public static func unlimitedNotice(_ version: String) -> String {
        "OpenClaw \(version) can't limit relay sessions, so anyone on the relay who messages your agents gets a session with your agent's usual tools. Updating OpenClaw to 2026.8.1 or later makes them answer-only."
    }
}

/// Wording and state for the Agent Relay tools row under OpenClaw's, shown
/// while OpenClaw is on (`openclaw.relay_tools.*`). The Linux app's
/// `OPENCLAW_TOOLS_*` constants and `OpenClawToolsRow` match these word for
/// word.
public enum OpenClawToolsCopy {
    public static let title = "Agent Relay tools"
    public static let notConnectedDetail = "Let your OpenClaw agents list agents on the relay, message them and spawn new ones. Messages from people who aren't trusted senders never get these tools."
    public static let waitingDetail = "Approve Agent Relay in your browser to finish connecting."
    public static let connectedDetail = "Your OpenClaw agents can use Agent Relay's tools. Messages from people who aren't trusted senders never get them."
    public static let connect = "Connect"
    public static let openAgain = "Open Again"
    /// How often the row reads the status again while the browser is open.
    public static let pollNanoseconds: UInt64 = 2_000_000_000

    /// The row's button.
    public enum Action: Equatable, Sendable {
        /// Primary: adds the server and opens the consent page.
        case connect
        /// Secondary: opens the waiting login's consent page again.
        case openAgain

        public var label: String {
            switch self {
            case .connect: return OpenClawToolsCopy.connect
            case .openAgain: return OpenClawToolsCopy.openAgain
            }
        }
    }

    /// What the row shows for a status.
    public struct Row: Equatable, Sendable {
        public let detail: String
        public let action: Action?
        /// Why the last sign-in failed, under the detail.
        public let error: String?
    }

    public static func row(for status: OpenClawToolsStatus) -> Row {
        switch status.state {
        case .notConnected:
            return Row(detail: notConnectedDetail, action: .connect, error: status.detail)
        case .waiting:
            return Row(detail: waitingDetail, action: .openAgain, error: nil)
        case .connected:
            return Row(detail: connectedDetail, action: nil, error: nil)
        case .unavailable, .unknown:
            return Row(detail: status.detail ?? "", action: nil, error: nil)
        }
    }

    /// Whether the row reads the status again: only while the browser is open.
    public static func polls(_ status: OpenClawToolsStatus?) -> Bool {
        status?.state == .waiting
    }
}
