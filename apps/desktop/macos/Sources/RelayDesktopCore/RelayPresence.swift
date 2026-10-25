import Foundation

/// Whether a session can receive relay messages right now, as its row shows it.
public enum RelayPresence: Equatable, Sendable {
    /// Not on the relay: no name, nothing delivered.
    case off
    /// On the relay and Relaycast pushes messages to it as they are sent.
    case online
    /// On the relay while the push channel (re)connects; messages still
    /// arrive through the queue check.
    case connecting
    /// On the relay but the session is not running; messages wait.
    case offline
    /// Asked to go on the relay; registering.
    case joining
    /// Asked to leave the relay; releasing its name.
    case leaving

    /// `wanted` is the state last asked for while it differs from the
    /// relay's. `pushLive` is nil before the push channel reports a state.
    public static func of(onRelay: Bool, wanted: Bool? = nil, isLive: Bool, pushLive: Bool?) -> RelayPresence {
        if let wanted, wanted != onRelay { return wanted ? .joining : .leaving }
        guard onRelay else { return .off }
        guard isLive else { return .offline }
        return pushLive == true ? .online : .connecting
    }

    public var messageStatus: String {
        switch self {
        case .online: return "Receiving"
        case .joining, .connecting: return "Connecting…"
        case .off: return "Off"
        case .offline: return "Offline"
        case .leaving: return "Turning off…"
        }
    }

    public var messageSymbol: String {
        switch self {
        case .online: return "checkmark.circle.fill"
        case .joining, .connecting, .leaving: return "arrow.triangle.2.circlepath"
        case .offline: return "pause.circle"
        case .off: return "stop.circle"
        }
    }

    public var messageHelp: String {
        switch self {
        case .online: return "Receiving messages. Click to go offline."
        case .joining, .connecting: return "Connecting to receive messages. Click to go offline."
        case .offline: return "Offline — this session is not running. Messages wait until it starts. Click to turn off."
        case .off: return "Off. Click to receive messages."
        case .leaving: return "Turning off message delivery. Click to reconnect."
        }
    }

    public var label: String {
        switch self {
        case .off: return "Not on the relay"
        case .online: return "Online"
        case .connecting: return "Connecting"
        case .offline: return "Offline"
        case .joining: return "Joining the relay…"
        case .leaving: return "Leaving the relay…"
        }
    }

    /// On, as the switch shows it: the state asked for wins.
    public var isOn: Bool {
        switch self {
        case .off, .leaving: return false
        case .online, .connecting, .offline, .joining: return true
        }
    }

    public var isChanging: Bool { self == .joining || self == .leaving }

    public var detail: String {
        switch self {
        case .off: return "Turn on to make this session reachable on the relay."
        case .online: return "Receiving messages as they are sent."
        case .connecting: return "Connecting to the relay. Messages still arrive within 30 seconds."
        case .offline: return "The session isn't running. Messages wait until it is."
        case .joining: return "Registering a name on the relay."
        case .leaving: return "Releasing its name on the relay."
        }
    }
}

/// The workspace roster grouped under people: the signed-in person's agents
/// elsewhere, each teammate's, and those whose owner is unknown. Agents on
/// this computer are listed with its sessions instead; an agent that is not
/// running is not offered.
public struct RosterGroups: Equatable {
    public let mine: [RosterAgent]
    public let teammates: [String: [RosterAgent]]
    public let other: [RosterAgent]

    public init(_ roster: [RosterAgent], people: [WorkspacePerson], localNames: Set<String>) {
        let teammateHashes = Set(people.filter { !$0.isSelf }.map(\.identityHash))
        var mine: [RosterAgent] = []
        var teammates: [String: [RosterAgent]] = [:]
        var other: [RosterAgent] = []
        for agent in roster where agent.liveness.isRunning && agent.where != .thisComputer && !localNames.contains(agent.name) {
            if agent.isSelf { mine.append(agent) }
            else if let hash = agent.ownerHash, teammateHashes.contains(hash) { teammates[hash, default: []].append(agent) }
            else { other.append(agent) }
        }
        self.mine = mine
        self.teammates = teammates
        self.other = other
    }
}

/// Stable machine buckets for the people roster. Desktop addresses end in an
/// agent id, not necessarily a host, so only published host metadata is used.
public struct RosterMachineGroup: Identifiable, Equatable {
    public let id: String
    public let name: String
    public let agents: [RosterAgent]

    public static func make(_ agents: [RosterAgent]) -> [RosterMachineGroup] {
        var buckets: [String: [RosterAgent]] = [:]
        var names: [String: String] = [:]
        var unknown: [RosterAgent] = []
        for agent in agents {
            guard let host = agent.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
                unknown.append(agent)
                continue
            }
            let key = host.lowercased()
            buckets[key, default: []].append(agent)
            names[key] = min(names[key] ?? host, host)
        }

        func ordered(_ lhs: RosterAgent, _ rhs: RosterAgent) -> Bool {
            let left = (lhs.name.lowercased(), (lhs.address ?? "").lowercased(), lhs.name, lhs.address ?? "")
            let right = (rhs.name.lowercased(), (rhs.address ?? "").lowercased(), rhs.name, rhs.address ?? "")
            return left < right
        }

        var result = buckets.keys.sorted {
            let left = names[$0] ?? $0
            let right = names[$1] ?? $1
            return (left.lowercased(), left) < (right.lowercased(), right)
        }.map { key in
            RosterMachineGroup(id: "host:\(key)", name: names[key] ?? key,
                               agents: (buckets[key] ?? []).sorted(by: ordered))
        }
        if !unknown.isEmpty {
            result.append(RosterMachineGroup(id: "unknown", name: "Unknown machine",
                                             agents: unknown.sorted(by: ordered)))
        }
        return result
    }
}

/// The CLI needs the broker's canonical node id; its display name may be a
/// friendly fallback such as "local broker" and is not a valid `--node`.
public enum FleetAttachCommand {
    public static func make(workerName: String, nodeId: String) -> String {
        let attach = "agent-relay node agent attach \(shellQuote(workerName))"
        // `fleet.list` uses the local broker's absolute state-directory path
        // as its scope when no enrolled node id exists. That scope is valid
        // for core RPCs such as release, but not for the CLI's `--node`.
        let hasCanonicalNodeID = !nodeId.isEmpty && !nodeId.hasPrefix("/")
        return hasCanonicalNodeID ? "\(attach) --node \(shellQuote(nodeId))" : attach
    }

    private static func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}
