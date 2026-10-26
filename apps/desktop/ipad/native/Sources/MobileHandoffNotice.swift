import Foundation

/// Display-only state published by the desktop after a verified handoff
/// transition. A receipt, an open conversation, or a local send is not proof.
struct MobileHandoffNotice: Equatable, Hashable, Sendable {
    enum State: String, Sendable { case connecting, ready, failed }
    let state: State
    let detail: String

    init?(metadata: [String: Any]) {
        guard let raw = metadata["mobile_handoff_state"] as? String,
              let state = State(rawValue: raw) else { return nil }
        self.state = state
        detail = state == .failed
            ? String(((metadata["mobile_handoff_error"] as? String) ?? "").prefix(500))
            : ""
    }

    var title: String {
        switch state {
        case .connecting: return "Connecting to Claude…"
        case .ready: return "Continuing in Claude"
        case .failed: return "Could not continue Claude"
        }
    }
}


extension RelayAgent {
    /// A provider name alone does not opt this session into native handoff.
    func deliveryLabel(delivered: Bool) -> String {
        if delivered { return "Delivered" }
        return mobileHandoffEnabled && isDesktopRegistration && ["claude", "claudecode"].contains(cli)
            ? "Queued" : "Sent"
    }
}
