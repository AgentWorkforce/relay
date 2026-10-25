import Foundation

/// Quota errors require a plan change; ordinary rate limits should simply retry.
/// A Free or Pro workspace whose write capacity stays saturated is offered
/// an upgrade too.
public enum RelaycastUpgrade {
    public static let title = "Agent Relay plan limit reached"
    public static let message = "Review upgrade options in Cloud Billing to raise your workspace’s limit."
    public static let action = "Review upgrade"
    public static let capacityTitle = "Workspace at capacity"
    /// Busy answers that must occur close together before the capacity
    /// notice shows: one busy write is ordinary contention, a run is not.
    public static let capacityThreshold = 3

    public enum Reason: Equatable, Sendable {
        case planLimit
        case capacity(plan: String)

        public var title: String {
            switch self {
            case .planLimit: RelaycastUpgrade.title
            case .capacity: RelaycastUpgrade.capacityTitle
            }
        }

        public var message: String {
            switch self {
            case .planLimit: RelaycastUpgrade.message
            case .capacity(let plan):
                "Your team is using all of the \(planName(plan)) plan’s write capacity, so messages may be delayed while Agent Relay retries. Upgrade to raise your workspace’s capacity."
            }
        }

        var billingReason: String {
            switch self {
            case .planLimit: "relaycast-plan-limit"
            case .capacity: "relaycast-capacity"
            }
        }
    }

    /// Plans whose write capacity an upgrade raises.
    public static let upgradablePlans: Set<String> = ["free", "pro"]
    /// Calls on lanes whose capacity no plan raises (connection tokens,
    /// heartbeats, delivery acknowledgements and agent or node lifecycle).
    /// SDK rows log the operation as their method and only the origin as
    /// endpoint.
    static let fixedLaneSDKMethods: Set<String> = ["SDK: heartbeat", "SDK: ack", "SDK: delete_agent", "SDK: join_channel"]
    static let fixedLanePathPrefixes = ["/v1/agent/node-token", "/v1/agents/heartbeat", "/v1/nodes"]
    static let fixedLanePathSuffixes = ["/ack", "/takeover", "/release"]

    static func isFixedLane(_ entry: RequestEntry) -> Bool {
        let path = URLComponents(string: entry.endpoint)?.path ?? entry.endpoint
        return fixedLaneSDKMethods.contains(entry.method)
            || (entry.method == "POST" && path == "/v1/agents")
            || fixedLanePathPrefixes.contains(where: path.hasPrefix)
            || fixedLanePathSuffixes.contains(where: path.hasSuffix)
    }

    public static func isPlanLimit(_ entry: RequestEntry) -> Bool {
        body(entry)?["error_code"] as? String == "plan_limit_exceeded"
    }

    /// A busy answer for a write an upgrade would admit. Relaycast's own
    /// `upgrade_available` decides when the answer carries it.
    public static func isCapacityBusy(_ entry: RequestEntry) -> Bool {
        guard let body = body(entry), body["error_code"] as? String == "workspace_busy" else { return false }
        if let available = body["upgrade_available"] as? Bool { return available }
        return !isFixedLane(entry)
    }

    /// Why to offer an upgrade for `entries` (the failures recent enough to
    /// count for this workspace) on `plan`, if at all. At least one must be
    /// `unseen`, so a notice is offered for new failures only.
    public static func reason(for entries: [RequestEntry], plan: String?, unseen: (RequestEntry) -> Bool) -> Reason? {
        if entries.contains(where: { unseen($0) && isPlanLimit($0) }) { return .planLimit }
        let busy = entries.filter(isCapacityBusy)
        // The plan Relaycast names in its answer, else the one verification read.
        let named = busy.lazy.compactMap { body($0)?["plan"] as? String }.first
        guard let plan = (named ?? plan)?.lowercased(), upgradablePlans.contains(plan) else { return nil }
        guard busy.count >= capacityThreshold, busy.contains(where: unseen) else { return nil }
        return .capacity(plan: plan)
    }

    public static func billingURL(siteURL: String, reason: Reason = .planLimit) -> URL? {
        guard var url = URLComponents(string: siteURL),
              ["http", "https"].contains(url.scheme ?? ""), url.host != nil else { return nil }
        url.user = nil
        url.password = nil
        url.path = "/cloud/dashboard/settings"
        url.query = "reason=\(reason.billingReason)"
        url.fragment = "billing"
        return url.url
    }

    /// A Relay Connect room's request is that room's workspace, not the team's.
    private static func body(_ entry: RequestEntry) -> [String: Any]? {
        guard entry.service == "Relaycast", entry.failed, entry.connect != true, entry.status == 429,
              let data = entry.response.data(using: .utf8)
        else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func planName(_ plan: String) -> String {
        switch plan.lowercased() {
        case "free": "Free"
        case "pro": "Pro"
        default: plan.prefix(1).uppercased() + plan.dropFirst()
        }
    }
}
