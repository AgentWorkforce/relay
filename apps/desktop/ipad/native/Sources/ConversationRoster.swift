import Foundation

/// DM history outlives relay registrations. Only the current roster can say
/// whether an agent is reachable; a cached lookup cannot bring one back.
struct ConversationRoster {
    private var agents: [String: RelayAgent] = [:]
    private var ownName = ""
    private(set) var listedAgents: [RelayAgent] = []

    mutating func replace(_ roster: [RelayAgent], excluding ownName: String = "") {
        self.ownName = ownName
        agents = Dictionary(roster.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        var seen: Set<String> = []
        listedAgents = roster.filter {
            !$0.name.isEmpty && $0.name != ownName && $0.isListed && seen.insert($0.name).inserted
        }
    }

    func includes(_ name: String, metadata: RelayAgent?, at now: Date = Date()) -> Bool {
        guard !name.isEmpty, name != ownName else { return false }
        if let agent = agents[name] {
            return agent.isListed && (agent.isHuman || agent.isReachable(at: now))
        }
        // People share one identity across devices and need not be online to
        // keep their conversation. Historical agents do not get this exception.
        return metadata?.isHuman == true && metadata?.isListed == true
    }
}
