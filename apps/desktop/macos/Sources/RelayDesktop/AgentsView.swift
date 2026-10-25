import AppKit
import RelayDesktopCore
import RelaySessionOverview
import SwiftUI

/// The relay sheets any page opens over itself.
enum AgentsSheet: String, Identifiable {
    /// A message to any relay address.
    case message
    /// Messages recently delivered to sessions on the relay.
    case activity
    /// A headless Capy session started through Agent Relay Cloud.
    case capyThread

    var id: String { rawValue }
}

extension View {
    /// Hosts the relay sheets for the whole window.
    func relaySheets(_ relay: RelayModel, model: AppModel) -> some View {
        sheet(item: Binding(get: { model.agentsSheet }, set: { model.agentsSheet = $0 })) { sheet in
            switch sheet {
            case .message: MessageSheet(relay: relay).environmentObject(model)
            case .activity: ActivitySheet(relay: relay)
            case .capyThread: CapyThreadSpawnSheet(relay: relay).environmentObject(model)
            }
        }
    }

    /// The roster has no push: it is read while a page that shows it is open.
    func pollsRoster(_ relay: RelayModel) -> some View {
        task {
            while !Task.isCancelled {
                await relay.refresh(.roster)
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
    }
}

/// My agents: every live session on this Mac, each with the switch that puts
/// it on the relay (and so shares it), this Mac's fleet workers, and the
/// signed-in person's agents on other machines. The sidebar scopes it.
struct AgentsView: View {
    @ObservedObject var relay: RelayModel
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The section each session switched on this page was in (true: on the
    /// relay), so a switched row holds its place until the page is left.
    @State private var heldSection: [String: Bool] = [:]
    @State private var expanded: Set<String> = []
    @State private var copiedName: String?
    @State private var machineFilter = ""

    private static let rowHeight: CGFloat = 50
    private static let contentWidth: CGFloat = 820

    private var search: String { model.agentSearch }
    private var scope: MyAgentScope { model.agentScope }
    private var thisMachine: String { Host.current().localizedName ?? ProcessInfo.processInfo.hostName }
    private var machineNames: [String] {
        [thisMachine] + relay.roster.compactMap(AgentMachineFilter.host) + relay.brokers.map(\.name)
    }

    private func inRelaySection(_ session: LocalSession) -> Bool {
        heldSection[session.id] ?? (session.registration != nil)
    }
    /// Ended sessions leave the list; a registered one keeps its name and
    /// queued messages, and is listed again when it runs again.
    private var matching: [LocalSession] {
        relay.listedSessions.filter {
            AgentMachineFilter.matches(thisMachine, selected: machineFilter) &&
                AgentSessionFilter.matches($0, title: $0.title, query: search)
        }
    }
    private var matchingFleet: [(BrokerListing, WorkerRow)] {
        relay.brokers.flatMap { broker in
            broker.workers.filter { AgentMachineFilter.matches(broker.name, selected: machineFilter) &&
                AgentSessionFilter.matches($0, broker: broker, query: search) }.map { (broker, $0) }
        }
    }
    private var matchingElsewhere: [RosterAgent] {
        relay.rosterGroups.mine.filter { AgentMachineFilter.matches(AgentMachineFilter.host($0), selected: machineFilter) &&
            AgentSessionFilter.matches($0, query: search) }
    }

    private func shows(_ part: MyAgentScope) -> Bool { scope == .all || scope == part }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 16) {
                    RelayBanners(relay: relay) {
                        Task { await relay.connectWorkspace() }
                    }
                    AgentMachinePicker(selection: $machineFilter, names: machineNames)
                    content
                }
                .frame(maxWidth: Self.contentWidth, alignment: .leading)
                .padding(.horizontal, 24).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .pollsRoster(relay)
        // A switched row holds its section only while the same list is shown;
        // another scope sorts every row by where it is now.
        .onChange(of: model.agentScope) { _ in heldSection = [:] }
        .onDisappear {
            heldSection = [:]
            copiedName = nil
        }
    }

    @ViewBuilder private var content: some View {
        let onRelay = matching.filter(inRelaySection)
        let others = matching.filter { !inRelaySection($0) }
        let fleetShown = shows(.fleet) && (!matchingFleet.isEmpty || !relay.fleetErrors.isEmpty)
        // Another machine's agents on the relay are its "On the relay" list:
        // this Mac's sessions are not on that machine.
        let elsewhereAsRelay = AgentMachineFilter.showsElsewhereAsRelay(thisMachine: thisMachine, selected: machineFilter)
        let elsewhereShown = shows(.elsewhere) && !matchingElsewhere.isEmpty && !elsewhereAsRelay
        VStack(alignment: .leading, spacing: 0) {
            if shows(.onRelay) && elsewhereAsRelay {
                SectionHeader(title: "On the relay", detail: matchingElsewhere.isEmpty ? nil : "\(matchingElsewhere.count)")
                if matchingElsewhere.isEmpty {
                    emptyNote(noMatch ?? "None of your agents are on the relay from \(machineFilter).")
                }
                ForEach(RosterMachineGroup.make(matchingElsewhere)) { machine in
                    ForEach(machine.agents) { agent in
                        RelayRosterRow(relay: relay, agent: agent) { openChat(agent) }
                    }
                }
            } else if shows(.onRelay) {
                SectionHeader(title: "On the relay", detail: onRelay.isEmpty ? nil : "\(relay.onlineCount) online")
                if onRelay.isEmpty {
                    emptyNote(onRelayEmptyText(hasOthers: !others.isEmpty))
                } else {
                    ForEach(onRelay) { sessionRow($0) }
                }
            }
            if shows(.offRelay) && (!others.isEmpty || scope == .offRelay) {
                SectionHeader(title: "Not on the relay", detail: "\(others.count)").padding(.top, scope == .all ? 14 : 0)
                if others.isEmpty { emptyNote(noMatch ?? "Every live session is on the relay.") }
                ForEach(others) { sessionRow($0) }
            }
            if shows(.onRelay) && !elsewhereAsRelay { archivedList }
            if fleetShown || scope == .fleet { fleetList }
            if elsewhereShown || scope == .elsewhere {
                SectionHeader(title: "On other machines", detail: "\(matchingElsewhere.count)").padding(.top, scope == .all ? 14 : 0)
                if matchingElsewhere.isEmpty { emptyNote(noMatch ?? "None of your agents are on the relay from another machine.") }
                ForEach(RosterMachineGroup.make(matchingElsewhere)) { machine in
                    SectionHeader(title: machine.name, detail: "\(machine.agents.count)")
                    ForEach(machine.agents) { agent in
                        RelayRosterRow(relay: relay, agent: agent) { openChat(agent) }
                    }
                }
            }
            // The roster also fills another machine's On the relay list.
            if let error = relay.rosterError, shows(.elsewhere) || (shows(.onRelay) && elsewhereAsRelay) {
                Label(error, systemImage: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(.orange)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: onRelay.map(\.id))
    }

    /// Set while a search is filtering: an empty section then means no match,
    /// not an empty inventory.
    private var noMatch: String? { search.isEmpty ? nil : "Nothing here matches “\(search)”." }

    private func onRelayEmptyText(hasOthers: Bool) -> String {
        if let noMatch { return noMatch }
        if !hasOthers && relay.count(of: .offRelay) == 0 {
            return "No live sessions on this Mac yet. Start Claude Code or Codex and it appears here."
        }
        return scope == .onRelay
            ? "None of your sessions are on the relay. Turn one on under Not on the relay to message it by name and share it."
            : "Turn on a session below to message it by name. Sessions on the relay are shared with your workspace."
    }

    private func emptyNote(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11)).foregroundStyle(.secondary)
            .padding(.horizontal, 8).padding(.bottom, 8)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func sessionRow(_ session: LocalSession) -> some View {
        let isExpanded = expanded.contains(session.id)
        return VStack(alignment: .leading, spacing: 0) {
            RelaySessionRow(
                relay: relay, session: session, height: Self.rowHeight, copiedName: $copiedName,
                toggle: { on in
                    if heldSection[session.id] == nil { heldSection[session.id] = inRelaySection(session) }
                    relay.requestRelay(on, for: session)
                },
                accessory: {
                    Button { toggleExpanded(session) } label: {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(NavButtonStyle(kind: .icon))
                    .help(isExpanded ? "Hide details" : "Show details")
                    .accessibilityLabel(isExpanded ? "Hide details" : "Show details")
                },
                menuItems: {
                    Button(isExpanded ? "Hide Details" : "Show Details") { toggleExpanded(session) }
                    if session.registration == nil {
                        Button("Choose Relay Name…") { expanded.insert(session.id) }
                    }
                }
            )
            if isExpanded {
                AgentDetail(relay: relay, session: session)
                    // Aligned with the row's title, past the icon.
                    .padding(.leading, 46).padding(.trailing, 8).padding(.bottom, 12)
                    .transition(.opacity)
            }
        }
    }

    private func toggleExpanded(_ session: LocalSession) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.15)) {
            if expanded.contains(session.id) { expanded.remove(session.id) } else { expanded.insert(session.id) }
        }
    }

    /// Agents that left the relay because their session was archived: their
    /// names were released, so this is the record of where they went.
    @ViewBuilder private var archivedList: some View {
        let archived = relay.archivedAgents.filter { ArchivedAgentText.matches($0, search: search) }
        if !archived.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                SectionHeader(title: ArchivedAgentText.sectionTitle, detail: "\(archived.count)").padding(.top, 14)
                ForEach(archived, id: \.self) { agent in
                    ArchivedAgentRow(agent: agent, height: Self.rowHeight)
                }
            }
        }
    }

    /// Workers this Mac's broker spawned. They already have relay names, so
    /// a row copies the name; releasing one is in its menu.
    private var fleetList: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Fleet workers", detail: "\(relay.brokers.flatMap(\.workers).count)").padding(.top, scope == .all ? 14 : 0)
            if matchingFleet.isEmpty && relay.fleetErrors.isEmpty {
                emptyNote(noMatch ?? "No fleet workers on this Mac. Workers an agent-relay broker spawns appear here.")
            }
            ForEach(matchingFleet, id: \.1.id) { broker, worker in
                FleetAgentRow(relay: relay, broker: broker, worker: worker, height: Self.rowHeight)
            }
            ForEach(Array(relay.fleetErrors.enumerated()), id: \.offset) { _, error in
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 11)).foregroundStyle(.orange)
                    .padding(.horizontal, 8).padding(.vertical, 4)
            }
        }
    }

    private func openChat(_ agent: RosterAgent) {
        model.messageEndpoint = agent.address ?? "@\(agent.name)"
        model.agentsSheet = .message
    }
}

/// The relay pages' top-bar controls: search, compose, and the menu with the
/// rest.
struct RelayToolbar: View {
    @ObservedObject var relay: RelayModel
    var prompt = "Search agents"
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            if relay.isRefreshing {
                ProgressView().controlSize(.small).help("Looking for sessions")
            }
            SearchField(prompt: prompt, text: $model.agentSearch)
            Button {
                model.messageEndpoint = ""
                model.agentsSheet = .message
            } label: {
                Label("Message", systemImage: "square.and.pencil")
            }
            .buttonStyle(MenuPanelButtonStyle(kind: .primary, controlHeight: 28))
            .fixedSize()
            .help("Message an agent by name or exact address")

            Menu {
                Button("Refresh") { Task { await relay.refreshAll() } }
                    .keyboardShortcut("r", modifiers: .command)
                Divider()
                Button("Recent Messages…") { model.agentsSheet = .activity }
                    .disabled(relay.activity.isEmpty)
                Divider()
                Button("Relay Settings…") { model.page = .settings(.relay) }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(NavButtonStyle(kind: .icon))
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More")
            .accessibilityLabel("More")
        }
    }
}

/// A rounded search field; ⌘F focuses it, Escape clears it.
struct SearchField: View {
    let prompt: String
    @Binding var text: String
    var width: CGFloat? = 220
    @FocusState private var focused: Bool
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(CloudTheme.secondary)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .focused($focused)
                .onExitCommand { text = "" }
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(NavButtonStyle(kind: .icon))
                .accessibilityLabel("Clear search")
            }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 8)
        .frame(width: width, height: 28)
        .background(hovered ? CloudTheme.muted : CloudTheme.background, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7)
            .strokeBorder(focused ? CloudTheme.ring : hovered ? CloudTheme.secondary : CloudTheme.input))
        .onHover { hovered = $0 }
        .animation(.easeOut(duration: 0.12), value: hovered)
        .background {
            // ⌘F finds, as it does everywhere on the Mac.
            Button("Search") { focused = true }
                .keyboardShortcut("f", modifiers: .command)
                .hidden()
        }
    }
}

/// What a row keeps out of the list: where the session runs, its ids and
/// upload, then the tools for an agent on the relay.
private struct AgentDetail: View {
    @ObservedObject var relay: RelayModel
    let session: LocalSession
    @EnvironmentObject private var model: AppModel
    @State private var showsTools = false
    @State private var relayName = ""

    var body: some View {
        let registration = session.registration
        let presence = relay.presence(of: session)
        VStack(alignment: .leading, spacing: 10) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 6) {
                if let registration {
                    fact("Address") {
                        HStack(spacing: 6) {
                            Text(registration.address).monospaced().textSelection(.enabled)
                            Button { RelayClipboard.copy(registration.address) } label: {
                                Image(systemName: "doc.on.doc")
                            }
                            .buttonStyle(.borderless)
                            .help("Copy exact address")
                            Button("Message") {
                                model.messageEndpoint = registration.address
                                model.agentsSheet = .message
                            }
                            .buttonStyle(.link)
                            .help("Message this exact endpoint")
                        }
                    }
                }
                fact("Status") { Text(presence == .off ? relay.switchHelp(session, presence: presence) : presence.detail) }
                if SpawnHandover.joins(session) {
                    fact("Transcript") {
                        Button(SpawnHandover.joinTitle) {
                            if let row = LocalSessionRow.mergeUnsorted(uploads: [], sessions: [session]).first {
                                model.openSessionFromMenu(row)
                            }
                        }
                        .buttonStyle(.link)
                        .help(SpawnHandover.joinHelp)
                    }
                }
                if let entry = model.uploadEntry(for: session) {
                    fact("Upload") {
                        HStack(spacing: 6) {
                            Text(model.uploadState(for: entry).title)
                            Button(entry.status == .uploaded ? "Open in Cloud" : "Show in Sessions") { model.openSession(entry) }
                                .buttonStyle(.link)
                        }
                    }
                }
                fact("Kind") { Text(SessionHost.label(provider: session.target.kind.label, host: session.host)) }
                if let directory = session.directory, !directory.isEmpty {
                    fact("Folder") { Text(directory).lineLimit(1).truncationMode(.middle).textSelection(.enabled).help(directory) }
                }
                fact("Session") { Text(session.target.id).monospaced().lineLimit(1).truncationMode(.middle).textSelection(.enabled) }
                if let updated = session.updatedAt, session.target.kind == .codex {
                    fact("Last active") { Text(RelativeTime.string(for: updated)) }
                }
                if registration?.addedBySession == true {
                    Text("added by the session").font(.caption).foregroundStyle(CloudTheme.secondary)
                }
            }
            .font(.system(size: 11))

            if registration == nil {
                HStack(spacing: 6) {
                    Text("@").foregroundStyle(CloudTheme.secondary)
                    TextField("new relay name", text: $relayName)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 240)
                        .onSubmit(registerWithName)
                    Button("Set Name & Retry", action: registerWithName)
                        .disabled(relay.busyTargets.contains(session.id) || relayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Text("Relay names are unique across your workspace. Choose another name to put this session on the relay.")
                    .font(.caption).foregroundStyle(CloudTheme.secondary)
            }

            if registration != nil {
                AgentOverviewCard(relay: relay, sessionID: session.target.id,
                                  publishedDescription: relay.roster.first { $0.sessionId == session.target.id }?.description ?? "")
            }

            if let agent = relay.agent(for: session) {
                DisclosureGroup("Name, replies, webhook and integrations", isExpanded: $showsTools) {
                    AgentToolsPanel(relay: relay, agent: agent).padding(.top, 8)
                }
                .font(.system(size: 11))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
    }

    private func registerWithName() {
        let name = relayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task { await relay.register(session, as: name) }
    }

    private func fact<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        GridRow {
            Text(label).foregroundStyle(CloudTheme.secondary).gridColumnAlignment(.trailing)
            value()
        }
    }
}

struct AgentOverviewCard: View {
    @ObservedObject var relay: RelayModel
    let sessionID: String
    var publishedDescription = ""

    var body: some View {
        let overview = relay.overviews[sessionID]
        let goal = relay.goals[sessionID] ?? ""
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Agent overview", systemImage: "sparkles").font(.system(size: 11, weight: .semibold))
                Spacer()
                Button(overview?.hasBrief == true ? "Regenerate" : "Generate") {
                    Task { await relay.requestOverview(sessionID) }
                }
                .controlSize(.small)
                .disabled(overview?.pending == true || overview?.status == .loading)
            }
            if let overview, overview.hasBrief {
                Text(overview.title).font(.system(size: 12, weight: .medium))
                Text(overview.description).font(.system(size: 11)).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if !publishedDescription.isEmpty {
                    Text("Published description").font(.system(size: 11, weight: .medium)).foregroundStyle(CloudTheme.secondary)
                    Text(publishedDescription).font(.system(size: 11)).foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !goal.isEmpty {
                    Text("Original request").font(.system(size: 11, weight: .medium)).foregroundStyle(CloudTheme.secondary)
                    Text(goal).font(.system(size: 11)).foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(overview?.status == .loading ? "Checking for a saved summary…" :
                     (publishedDescription.isEmpty ? "Generate a short summary to see what this agent is working on." : "Generate a Cloud summary for more detail."))
                    .font(.system(size: 11)).foregroundStyle(CloudTheme.secondary)
            }
            if overview?.pending == true {
                Text(overview?.status == .queued ? "Summary queued. This may take a few minutes." : "Generating summary…")
                    .font(.system(size: 11)).foregroundStyle(CloudTheme.secondary)
            }
            if let error = overview?.error {
                Text(error).font(.system(size: 11)).foregroundStyle(.orange)
                if relay.overviewNeedsSignIn {
                    let renewing = relay.model?.renewingSignIn == true
                    Button(renewing ? "Waiting for the browser…" : "Sign in again") { relay.model?.renewSignIn() }
                        .controlSize(.small)
                        .disabled(renewing)
                }
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.045), in: RoundedRectangle(cornerRadius: 7))
        .task(id: "\(sessionID):\(overview?.pending == true):\(relay.overviewReloads)") {
            await relay.loadOverview(sessionID)
            while !Task.isCancelled && relay.overviews[sessionID]?.pending == true {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if Task.isCancelled { break }
                await relay.loadOverview(sessionID)
            }
        }
        .task(id: sessionID) { await relay.loadGoal(sessionID) }
    }
}

/// Rename, replies, a test message, integrations and the inbound webhook
/// for one agent on the relay.
private struct AgentToolsPanel: View {
    @ObservedObject var relay: RelayModel
    let agent: LocalAgent

    @State private var newName = ""
    @State private var renameStatus: Status?
    @State private var testText = ""
    @State private var testStatus: Status?
    @State private var webhookStatus: Status?
    @State private var integrationStatus: Status?
    @State private var integrationProvider = "github"
    @State private var integrationResource = ""
    @State private var isWorking = false
    /// The secret Agent Relay shows once, right after creating the webhook.
    @State private var webhookSecret: String?

    /// Any change to this session in flight, from here or its switch.
    private var isBusy: Bool { isWorking || relay.busyTargets.contains(agent.target.key) }

    enum Status: Equatable {
        case ok(String)
        case waiting(String)
        case failed(String)
    }

    private var requestedName: String {
        newName.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "@")).lowercased()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            section("Name") {
                HStack(spacing: 6) {
                    Text("@").foregroundStyle(CloudTheme.secondary)
                    TextField("new name", text: $newName)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12).monospaced())
                        .frame(width: 240)
                        .onSubmit(rename)
                        .help(AgentNameText.renameNote(name: agent.name, alias: agent.alias))
                    Button("Rename", action: rename)
                        .disabled(isBusy || requestedName.isEmpty || requestedName == agent.displayName)
                }
                statusLine(renameStatus)
            }

            section("Replies") {
                Picker("Reply with final answer", selection: Binding<Bool?>(
                    get: { agent.replyWithFinalAnswer },
                    set: { value in Task { _ = await relay.setReplyWithFinalAnswer(value, for: agent) } }
                )) {
                    Text("When no reply command is available").tag(Optional<Bool>.none)
                    Text("For unanswered messages").tag(Optional(true))
                    Text("Off").tag(Optional(false))
                }
                .disabled(isBusy || agent.target.kind == .claudeCloud)
                Text(agent.target.kind == .claudeCloud
                     ? "Claude app has no local transcript; automatic replies are unavailable."
                     : "Forwards the completed answer as @\(agent.name), unless the session already replied. Replies longer than 4,000 characters are truncated.")
                    .font(.caption).foregroundStyle(CloudTheme.secondary)
            }

            section("Message this session") {
                HStack(alignment: .top, spacing: 6) {
                    TextField("Message", text: $testText, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                    Button("Send", action: sendTest)
                        .disabled(isWorking || testText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Text("Sent through Agent Relay as a DM to \(agent.address), the same way a teammate's message arrives.")
                    .font(.caption).foregroundStyle(CloudTheme.secondary)
                statusLine(testStatus)
            }

            section("Integrations") {
                Text("Provider events for @\(agent.name) arrive in the session. Its automatic answers are never posted back to the provider.")
                    .font(.caption).foregroundStyle(CloudTheme.secondary)
                HStack {
                    Picker("Provider", selection: $integrationProvider) {
                        ForEach(["github", "linear", "slack", "jira"], id: \.self) { Text($0).tag($0) }
                    }.frame(width: 170)
                    TextField("Resource, e.g. acme/api", text: $integrationResource)
                        .textFieldStyle(.roundedBorder)
                }
                Text("Uses your Agent Relay workspace. If the provider isn't connected yet, Agent Relay opens to connect it.")
                    .font(.caption).foregroundStyle(CloudTheme.secondary)
                Button("Subscribe") {
                    run { await relay.subscribe(agent, provider: integrationProvider, resource: integrationResource) } done: {
                        integrationStatus = $0.map(Status.failed) ?? .ok("Subscribed. Provider events will arrive in this session.")
                    }
                }
                .disabled(isBusy || integrationResource.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                ForEach(agent.integrations) { integration in
                    HStack {
                        VStack(alignment: .leading) {
                            Text("\(integration.provider): \(integration.resource)")
                            if !integration.ready {
                                Text("Setup or cleanup incomplete").font(.caption).foregroundStyle(.orange)
                            }
                        }
                        Spacer()
                        Button(integration.ready ? "Unsubscribe" : "Clean up") {
                            run { await relay.unsubscribe(integration, from: agent) } done: {
                                integrationStatus = $0.map(Status.failed) ?? .ok("Subscription removed.")
                            }
                        }.disabled(isBusy)
                    }
                }
                statusLine(integrationStatus)
            }

            section("Webhook") {
                if let webhook = agent.webhook {
                    Text("POST JSON to this URL with the bearer token; the `text` field arrives in the session.")
                        .font(.caption).foregroundStyle(CloudTheme.secondary)
                    copyRow(label: "URL", value: webhook.url)
                    if let webhookSecret {
                        copyRow(label: "Token", value: webhookSecret)
                        Text("Copy the token now: Agent Relay does not show it again.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    HStack(spacing: 8) {
                        if let webhookSecret {
                            Button("Copy curl example") {
                                RelayClipboard.copy("curl -X POST '\(webhook.url)' -H 'Authorization: Bearer \(webhookSecret)' -H 'Content-Type: application/json' -d '{\"text\":\"Build failed on main\",\"source\":\"ci\"}'")
                                webhookStatus = .ok("Copied a curl command that posts to @\(agent.name).")
                            }
                        }
                        Button("Revoke", role: .destructive) {
                            run { await relay.revokeWebhook(for: agent) } done: {
                                webhookSecret = nil
                                webhookStatus = $0.map(Status.failed) ?? .ok("Webhook revoked; its URL and token no longer work.")
                            }
                        }
                        .disabled(isBusy)
                    }
                } else {
                    Text("Give @\(agent.name) a webhook URL and bearer token, so CI, alerts or any service can post straight into this session.")
                        .font(.caption).foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Create webhook") {
                        isWorking = true
                        Task {
                            switch await relay.createWebhook(for: agent) {
                            case .success(let created):
                                webhookSecret = created.secret
                                // The token is only in the answer that created it.
                                webhookStatus = created.secret == nil
                                    ? .failed("This webhook already existed, so its token can't be shown again. Revoke it and create a new one for a new token.")
                                    : .ok("Webhook ready. Anything posted to it goes to @\(agent.name).")
                            case .failure(let error):
                                webhookStatus = .failed(error.message)
                            }
                            isWorking = false
                        }
                    }
                    .disabled(isBusy)
                }
                statusLine(webhookStatus)
            }
        }
        .font(.system(size: 12))
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { if newName.isEmpty { newName = agent.displayName } }
        .onChange(of: agent.displayName) { newName = $0 }
    }

    private func run(_ work: @escaping () async -> String?, done: @escaping (String?) -> Void) {
        isWorking = true
        Task {
            done(await work())
            isWorking = false
        }
    }

    private func rename() {
        guard !requestedName.isEmpty, !isBusy, requestedName != agent.displayName else { return }
        let target = requestedName
        isWorking = true
        Task {
            switch await relay.rename(agent, to: target) {
            case .renamed(let message): renameStatus = .ok(message)
            case .failed(let error): renameStatus = .failed(error)
            }
            isWorking = false
        }
    }

    /// The field clears at once and the status says the message is on its
    /// way; a failed send puts the text back unless something else was typed.
    private func sendTest() {
        let text = testText
        testText = ""
        testStatus = .waiting(PendingMessages.sending)
        run { await relay.sendTestMessage(to: agent, text: text) } done: { error in
            if let error {
                testStatus = .failed(error)
                if testText.isEmpty { testText = text }
            }
            else if let waiting = relay.waitingStatus(at: agent.address) { testStatus = .waiting(waiting) }
            else { testStatus = .ok("Queued for delivery.") }
        }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(CloudTheme.secondary)
            content()
        }
    }

    @ViewBuilder
    private func statusLine(_ status: Status?) -> some View {
        switch status {
        case .ok(let text): Label(text, systemImage: "checkmark.circle").font(.caption).foregroundStyle(.green)
        case .waiting(let text): Label(text, systemImage: "clock").font(.caption).foregroundStyle(.orange)
        case .failed(let text): Label(text, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
        case .none: EmptyView()
        }
    }

    private func copyRow(label: String, value: String) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.caption).foregroundStyle(CloudTheme.secondary).frame(width: 40, alignment: .leading)
            Text(value).font(.system(size: 11).monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Button { RelayClipboard.copy(value) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.borderless)
                .help("Copy \(label.lowercased())")
        }
    }
}

/// An agent that left the relay because its session was archived.
private struct ArchivedAgentRow: View {
    let agent: ArchivedAgent
    let height: CGFloat

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "archivebox")
                .font(.system(size: 13)).foregroundStyle(.secondary)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("@\(agent.name)").font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                Text(ArchivedAgentText.detail(archivedAt: agent.archivedAt))
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(height: height)
        .contentShape(Rectangle())
        .help(agent.title.isEmpty ? agent.address : "\(agent.title) · \(agent.address)")
        .accessibilityElement(children: .combine)
        .contextMenu {
            Button("Copy Address") { RelayClipboard.copy(agent.address) }
        }
    }
}

/// One spawned worker: its fleet name is already the address anyone in its
/// workspace can DM or @mention, so a click copies it and its menu releases
/// it back to the broker.
private struct FleetAgentRow: View {
    @ObservedObject var relay: RelayModel
    let broker: BrokerListing
    let worker: WorkerRow
    var height: CGFloat
    @State private var isConfirmingRelease = false
    @State private var copied = false
    @State private var expanded = false

    private var isReleasing: Bool { relay.releasingFleet.contains(worker.id) }
    /// Released, as far as the row knows until the next fleet listing.
    private var isReleased: Bool { relay.releasedFleet.contains(worker.id) }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
        HoverRow(interactive: true, height: height) { hovered in
            Button(action: copyName) {
                HStack(spacing: 10) {
                    AgentIconView(source: worker.provider, size: 20)
                        .frame(width: 28, height: 28)
                        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
                        .overlay(alignment: .bottomTrailing) { activityDot.offset(x: 3, y: 3) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("@\(worker.name)").font(.system(size: 12)).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        subtitle.font(.system(size: 11)).lineLimit(1)
                    }
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(copied ? Color.green : Color.secondary)
                        .opacity(hovered || copied ? 1 : 0)
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(RowContentButtonStyle())
            .help("Copy @\(worker.name)")
            .contextMenu { menuItems }

            if isReleasing {
                ProgressView().controlSize(.small).frame(width: 36)
            } else if isReleased {
                Color.clear.frame(width: 36)
            } else {
                Menu { menuItems } label: {
                    Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).foregroundStyle(CloudTheme.secondary)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: 36)
                .accessibilityLabel("Actions for @\(worker.name)")
            }
            Button { expanded.toggle() } label: {
                Image(systemName: "chevron.right")
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
            .accessibilityLabel(expanded ? "Hide worker details" : "Show worker details")
        }
        if expanded {
            VStack(alignment: .leading, spacing: 5) {
                fleetDetail("Status", worker.stateLabel)
                fleetDetail("Last activity", worker.lastActivityMs.map {
                    Date(timeIntervalSince1970: Double($0) / 1_000).formatted(date: .abbreviated, time: .shortened)
                } ?? "Unavailable")
                fleetDetail("Node", broker.name)
                fleetDetail("Harness", worker.providerLabel)
                if let model = worker.model { fleetDetail("Model", model) }
                if let sessionID = worker.sessionId { fleetDetail("Session", sessionID) }
                if !worker.channels.isEmpty { fleetDetail("Channels", worker.channels.joined(separator: ", ")) }
                if let sessionID = worker.sessionId {
                    AgentOverviewCard(relay: relay, sessionID: sessionID,
                                      publishedDescription: relay.roster.first { $0.sessionId == sessionID }?.description ?? "")
                }
                Button("Copy terminal attach command") {
                    RelayClipboard.copy(FleetAttachCommand.make(workerName: worker.name, nodeId: broker.nodeId))
                }
                .font(.system(size: 11))
            }
            .padding(.leading, 38).padding(.bottom, 8)
        }
        }
        .confirmationDialog("Release @\(worker.name)?", isPresented: $isConfirmingRelease) {
            Button("Release", role: .destructive) { Task { await relay.release(worker, from: broker) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The broker stops the worker's provider process. Its Agent Relay name is released back to the fleet; this cannot be undone.")
        }
    }

    private func fleetDetail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label).foregroundStyle(CloudTheme.secondary).frame(width: 82, alignment: .leading)
            Text(value).textSelection(.enabled)
        }.font(.system(size: 11))
    }

    @ViewBuilder private var menuItems: some View {
        Button("Copy @\(worker.name)") { RelayClipboard.copy("@\(worker.name)") }
        Divider()
        Button("Release…") { isConfirmingRelease = true }
            .disabled(worker.generation == nil)
    }

    private var subtitle: Text {
        if let error = relay.fleetRowErrors[worker.id] { return Text(error).foregroundColor(.orange) }
        if isReleased { return Text("Released").foregroundColor(.secondary) }
        if copied { return Text("Copied @\(worker.name)").foregroundColor(.green) }
        let state = worker.state == .idle && worker.lastActivityMs != nil
            ? AgentSummary.line(description: "", status: "idle", lastSeenMs: worker.lastActivityMs)
            : worker.stateLabel
        var parts = [state, "on \(broker.name)"]
        if let pending = worker.pendingMessages, pending > 0 { parts.append("\(pending) pending") }
        return Text(parts.joined(separator: " · ")).foregroundColor(.secondary)
    }

    /// Shape as well as color, as on a session's presence dot.
    @ViewBuilder private var activityDot: some View {
        switch worker.state {
        case .working: dot(Circle().fill(Color.green))
        case .idle: dot(Circle().strokeBorder(Color.green, lineWidth: 2))
        case .waiting: dot(Circle().strokeBorder(Color.orange, lineWidth: 2))
        case .starting: dot(Circle().strokeBorder(Color.accentColor, lineWidth: 2))
        case .unknown: EmptyView()
        }
    }

    private func dot(_ shape: some View) -> some View {
        shape
            .frame(width: 10, height: 10)
            .background(Circle().fill(Color(nsColor: .windowBackgroundColor)).padding(-2))
            .accessibilityHidden(true)
    }

    private func copyName() {
        RelayClipboard.copyName(worker.name)
        copied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            copied = false
        }
    }
}

// MARK: - People

struct RelayRosterRow: View {
    @ObservedObject var relay: RelayModel
    let agent: RosterAgent
    let openChat: () -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HoverRow(interactive: true, height: 48) { hovered in
                HStack(spacing: 10) {
                    // The harness mark when the registrar said which it is;
                    // a generic glyph for people and services.
                    Group {
                        if let source = agent.harnessSource {
                            AgentIconView(source: source, size: 20)
                        } else {
                            Image(systemName: agent.kind == "human" ? "person.fill" : (agent.kind == "service" ? "gearshape.2" : "sparkles"))
                                .font(.system(size: 12, weight: .medium)).foregroundStyle(CloudTheme.secondary)
                        }
                    }
                        .frame(width: 28, height: 28)
                        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
                        .overlay(alignment: .bottomTrailing) {
                            // Working is a filled dot, idle a ring, as on a fleet worker.
                            Group {
                                if agent.liveness == .live {
                                    Circle().fill(Color.green)
                                } else {
                                    Circle().strokeBorder(Color.green, lineWidth: 2)
                                }
                            }
                            .frame(width: 8, height: 8)
                            .background(Circle().fill(Color(nsColor: .windowBackgroundColor)).padding(-2))
                            .offset(x: 3, y: 3)
                        }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.address ?? "@\(agent.name)").font(.system(size: 13).monospaced()).lineLimit(1)
                        Text(AgentSummary.line(summary: agent.sessionId.flatMap { relay.overviews[$0]?.title.isEmpty == false
                            ? relay.overviews[$0]?.title : relay.goals[$0] },
                                               description: agent.description, status: agent.status,
                                               lastSeenMs: agent.lastSeenMs))
                            .font(.system(size: 11)).foregroundStyle(CloudTheme.secondary).lineLimit(1)
                    }
                    // An idle agent is offered, dimmed.
                    .opacity(agent.liveness == .idle ? 0.6 : 1)
                    Spacer(minLength: 8)
                    Button("Message", action: openChat)
                        .buttonStyle(MenuPanelButtonStyle(kind: hovered ? .primary : .secondary, controlHeight: 26))
                        .fixedSize()
                        .disabled(agent.address == nil)
                        .help(agent.address == nil ? "This agent did not advertise an exact address." : "Message this exact endpoint")
                    Button { expanded.toggle() } label: {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(NavButtonStyle(kind: .icon))
                    .accessibilityLabel(expanded ? "Hide agent details" : "Show agent details")
                }
                .padding(.leading, 8).padding(.trailing, 6)
            }
            .contextMenu {
                Button("Message…", action: openChat).disabled(agent.address == nil)
                Button(expanded ? "Hide Details" : "Show Details") { expanded.toggle() }
                if let address = agent.address { Button("Copy Address") { RelayClipboard.copy(address) } }
            }
            if expanded {
                VStack(alignment: .leading, spacing: 5) {
                    detail("Task", AgentSummary.useful(agent.description) ?? "Task details unavailable")
                    let mentions = AgentSummary.mentions(agent.description)
                    if !mentions.isEmpty { detail("Mentions", mentions.joined(separator: ", ")) }
                    detail("Status", agent.status.capitalized)
                    if let lastSeenMs = agent.lastSeenMs {
                        detail("Last seen", Date(timeIntervalSince1970: Double(lastSeenMs) / 1_000)
                            .formatted(date: .abbreviated, time: .shortened))
                    }
                    detail("Location", agent.whereLabel)
                    if let host = agent.host { detail("Host", host) }
                    if let sessionID = agent.sessionId {
                        AgentOverviewCard(relay: relay, sessionID: sessionID, publishedDescription: agent.description)
                    }
                    Text("Recent activity is unavailable.")
                        .font(.system(size: 10)).foregroundStyle(.tertiary)
                }
                .padding(.leading, 46).padding(.trailing, 8).padding(.bottom, 12)
            }
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label).foregroundStyle(CloudTheme.secondary).frame(width: 72, alignment: .leading)
            Text(value).textSelection(.enabled)
        }.font(.system(size: 11))
    }
}

// MARK: - Sheets

/// A message to any relay address — a name, or the exact address one agent
/// on one machine has. It says whether the recipient runs before a send,
/// what the send met after it, and whether a reply is expected.
struct MessageSheet: View {
    @ObservedObject var relay: RelayModel
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @State private var isSending = false

    private var endpoint: String { RelayModel.endpoint(model.messageEndpoint) }

    private var canSend: Bool {
        !isSending && !endpoint.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The history read last, with messages sent since shown as on their way.
    private var history: History? { relay.shownHistory(at: endpoint) }

    private var recipient: Recipient? { relay.recipient(at: endpoint) }

    /// Sending to a recipient that is not running queues the message; the
    /// button says so.
    private var queues: Bool { MessageDelivery.queues(recipient) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Message an Agent").font(.headline)
            HStack(spacing: 8) {
                TextField("To: @name or agent@machine", text: $model.messageEndpoint)
                    .textFieldStyle(.roundedBorder).font(.system(.body, design: .monospaced))
                Button {
                    Task {
                        await relay.lookUpRecipient(endpoint)
                        await relay.loadConversation(endpoint)
                    }
                } label: {
                    if relay.isLoadingConversation {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .help("Refresh this conversation")
                .disabled(relay.isLoadingConversation || endpoint.isEmpty)
            }
            TextField("Message", text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(3...8)
            statusLine
            HStack {
                if let note = recipient.flatMap({ MessageDelivery.replyNote(for: $0) }) {
                    Text(note).font(.caption).foregroundStyle(CloudTheme.secondary)
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(isSending ? "Sending…" : (queues ? "Queue Anyway" : "Send"), action: send)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(AgentRelayPrimaryButtonStyle())
                    .disabled(!canSend)
            }
            if let error = relay.conversationError, history == nil {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if let history, !history.messages.isEmpty {
                Divider()
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(history.messages) { directMessage($0) }
                    }
                }
                .frame(maxHeight: 260)
            }
        }
        .padding(20)
        .frame(width: 560)
        .frame(minHeight: 300)
        .onChange(of: endpoint) {
            error = nil
            relay.composerShows($0)
        }
        // A new message gives the last send's note way to the recipient's
        // state, so a warning about it is never hidden behind it.
        .onChange(of: text) { if !$0.isEmpty { relay.forgetLastSend() } }
        .onAppear { relay.openComposer(endpoint) }
        .onDisappear { relay.closeComposer() }
        .task(id: endpoint) {
            guard !endpoint.isEmpty else { return }
            // Typing changes the endpoint on every key; read once it settles.
            do { try await Task.sleep(nanoseconds: 300_000_000) } catch { return }
            // `messages`, `sessions`, `fleet` and `roster` invalidations
            // refresh them too; this catches changes the core does not
            // announce, such as a message handed over or a remote agent
            // going offline.
            while !Task.isCancelled {
                await relay.lookUpRecipient(endpoint)
                await relay.loadConversation(endpoint)
                do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            }
        }
    }

    /// Before a send: whether the recipient runs. After one: what it met,
    /// updated as the recipient comes and goes.
    @ViewBuilder private var statusLine: some View {
        if let error {
            Text(error).font(.caption).foregroundStyle(.red)
        } else if let note = relay.deliveryNote(at: endpoint) {
            Text(note.text).font(.caption).foregroundStyle(color(note.tone))
        } else if let recipient, let warning = MessageDelivery.warning(for: recipient) {
            Text(warning).font(.caption)
                .foregroundStyle(recipient.agent == nil ? Color.red : Color.orange)
        } else {
            Text("An exact address reaches only that agent on that machine.")
                .font(.caption).foregroundStyle(CloudTheme.secondary)
        }
    }

    private func color(_ tone: DeliveryTone) -> Color {
        switch tone {
        case .delivered: return .green
        case .waiting: return .orange
        case .failed: return .red
        case .unknown: return .secondary
        }
    }

    /// The box clears at once and the message shows as on its way; a failed
    /// send puts the text back unless something else was typed meanwhile.
    private func send() {
        isSending = true
        error = nil
        let target = model.messageEndpoint
        let body = text
        text = ""
        Task {
            error = await relay.sendMessage(to: target, text: body)
            if error != nil && text.isEmpty { text = body }
            isSending = false
        }
    }

    @ViewBuilder
    private func directMessage(_ message: DirectMessage) -> some View {
        HStack {
            if message.mine { Spacer(minLength: 60) }
            VStack(alignment: message.mine ? .trailing : .leading, spacing: 3) {
                Text((message.threadId == nil ? "" : "↳ Reply · ") + (message.mine ? "You" : "@\(message.sender)"))
                    .font(.caption2).foregroundStyle(CloudTheme.secondary)
                Text(message.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(
                        message.mine ? Color.accentColor.opacity(0.16) : Color.primary.opacity(0.07),
                        in: RoundedRectangle(cornerRadius: 9)
                    )
                    .opacity(PendingMessages.isPending(message) ? 0.7 : 1)
                if PendingMessages.isPending(message) {
                    Text(PendingMessages.sending).font(.caption2).foregroundStyle(CloudTheme.secondary)
                }
            }
            if !message.mine { Spacer(minLength: 60) }
        }
        .padding(.leading, message.threadId == nil ? 0 : 28)
    }
}

/// Messages recently delivered into sessions on the relay.
struct ActivitySheet: View {
    @ObservedObject var relay: RelayModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Recent Messages").font(.title3.weight(.semibold))
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(20)
            Divider()
            List(relay.activity) { entry in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: symbol(entry.outcome)).foregroundStyle(color(entry.outcome))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(entry.sender.map { "@\($0)" } ?? "Someone") → @\(entry.agent)").font(.callout.weight(.medium))
                        Text(entry.detail ?? entry.preview).font(.callout).foregroundStyle(CloudTheme.secondary).lineLimit(2)
                    }
                    Spacer()
                    Text(RelativeTime.string(for: entry.date)).font(.caption).foregroundStyle(CloudTheme.secondary)
                }
                .padding(.vertical, 4)
            }
            .listStyle(.inset)
            .overlay {
                if relay.activity.isEmpty { Text("No messages yet.").foregroundStyle(CloudTheme.secondary) }
            }
        }
        .frame(minWidth: 560, idealWidth: 620, minHeight: 420, idealHeight: 480)
        .task { await relay.refresh(.activity) }
    }

    private func symbol(_ outcome: DeliveryOutcome) -> String {
        switch outcome {
        case .injected: return "arrow.down.message.fill"
        case .skipped: return "minus.circle"
        case .failed: return "exclamationmark.triangle.fill"
        case .waiting: return "clock"
        case .inDoubt: return "questionmark.circle.fill"
        case .answered: return "arrowshape.turn.up.left.fill"
        }
    }

    private func color(_ outcome: DeliveryOutcome) -> Color {
        switch outcome {
        case .injected, .answered: return .green
        case .skipped: return .secondary
        case .failed, .waiting: return .orange
        case .inDoubt: return .yellow
        }
    }
}
