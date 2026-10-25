import RelayDesktopCore
import SwiftUI

/// The sidebar's key for agents whose owner isn't a known teammate.
enum TeamSelection {
    static let unowned = "unowned"
}

/// Teammates in the workspace and the agents each has on the relay, one
/// card per person. The sidebar narrows it to one person.
struct TeamView: View {
    @ObservedObject var relay: RelayModel
    @EnvironmentObject private var model: AppModel
    @State private var machineFilter = ""

    private static let contentWidth: CGFloat = 820

    private var search: String { model.agentSearch }

    private func agents(for hash: String) -> [RosterAgent] {
        let groups = relay.rosterGroups
        let all = hash == TeamSelection.unowned ? groups.other : (groups.teammates[hash] ?? [])
        return all.filter { AgentMachineFilter.matches(AgentMachineFilter.host($0), selected: machineFilter) &&
            AgentSessionFilter.matches($0, query: search) }
    }

    /// Teammates with agents first, then by name.
    private var people: [WorkspacePerson] {
        let groups = relay.rosterGroups
        return relay.teammates
            .filter { model.teamPerson == nil || model.teamPerson == $0.identityHash }
            .sorted {
                let a = groups.teammates[$0.identityHash]?.count ?? 0
                let b = groups.teammates[$1.identityHash]?.count ?? 0
                return a != b ? a > b : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
    }

    /// Whether the sidebar still lists the selected row: a teammate who left,
    /// or Other live agents going idle, removes it.
    private var selectionExists: Bool {
        guard let hash = model.teamPerson else { return true }
        if hash == TeamSelection.unowned { return !relay.rosterGroups.other.isEmpty }
        return relay.teammates.contains { $0.identityHash == hash }
    }

    private var showsUnowned: Bool {
        (model.teamPerson == nil || model.teamPerson == TeamSelection.unowned) && !relay.rosterGroups.other.isEmpty
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 14) {
                RelayBanners(relay: relay) {
                    Task { await relay.connectWorkspace() }
                }
                AgentMachinePicker(selection: $machineFilter,
                                   names: relay.roster.compactMap(AgentMachineFilter.host))
                if relay.teammates.isEmpty && !showsUnowned {
                    emptyState
                }
                ForEach(people, id: \.identityHash) { person in
                    PersonCard(
                        relay: relay,
                        name: person.name,
                        avatarURL: person.avatarUrl.flatMap(URL.init(string:)),
                        agents: agents(for: person.identityHash),
                        searching: !search.isEmpty,
                        openChat: openChat
                    )
                }
                if showsUnowned {
                    PersonCard(
                        relay: relay,
                        name: "Other live agents",
                        avatarURL: nil,
                        agents: agents(for: TeamSelection.unowned),
                        searching: !search.isEmpty,
                        openChat: openChat
                    )
                }
                if let error = relay.peopleError {
                    Label(error, systemImage: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(.orange)
                }
                if let error = relay.rosterError {
                    Label(error, systemImage: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: Self.contentWidth, alignment: .leading)
            .padding(.horizontal, 24).padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .pollsRoster(relay)
        // A selection whose row is gone falls back to everyone.
        .onChange(of: selectionExists) { if !$0 { model.teamPerson = nil } }
        .onAppear { if !selectionExists { model.teamPerson = nil } }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "person.2").font(.system(size: 30)).foregroundStyle(.secondary)
            Text("No teammates yet").font(.headline)
            Text("People who join your workspace appear here with the agents they put on the relay.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }

    private func openChat(_ agent: RosterAgent) {
        model.messageEndpoint = agent.address ?? "@\(agent.name)"
        model.agentsSheet = .message
    }
}

private struct PersonCard: View {
    @ObservedObject var relay: RelayModel
    let name: String
    let avatarURL: URL?
    let agents: [RosterAgent]
    let searching: Bool
    let openChat: (RosterAgent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                PersonAvatar(name: name, url: avatarURL, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.system(size: 13, weight: .semibold))
                    Text(agents.isEmpty ? (searching ? "No matching agents" : "No agents on the relay") : "\(agents.count) on the relay")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer()
                if !agents.isEmpty {
                    PresenceCount(count: agents.count)
                }
            }
            .padding(12)
            if !agents.isEmpty {
                Divider().padding(.horizontal, 12)
                VStack(spacing: 0) {
                    ForEach(RosterMachineGroup.make(agents)) { machine in
                        SectionHeader(title: machine.name, detail: "\(machine.agents.count)")
                        ForEach(machine.agents) { agent in
                            RelayRosterRow(relay: relay, agent: agent) { openChat(agent) }
                        }
                    }
                }
                .padding(6)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
    }
}

/// A green dot with a count: how many agents someone has live.
struct PresenceCount: View {
    let count: Int

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(Color.green).frame(width: 6, height: 6)
            Text(count.formatted()).font(.caption.monospacedDigit())
        }
        .padding(.horizontal, 7).padding(.vertical, 2)
        .background(Color.green.opacity(0.12), in: Capsule())
        .accessibilityLabel("\(count) online")
    }
}
