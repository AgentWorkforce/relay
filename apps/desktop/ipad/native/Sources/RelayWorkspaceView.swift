import SwiftUI
import UserNotifications
import UniformTypeIdentifiers

private enum WorkspacePage: String, CaseIterable, Identifiable {
    case agents = "Agents"
    case messages = "Messages"
    case channels = "Channels"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .agents: "person.2"
        case .messages: "bubble.left.and.bubble.right"
        case .channels: "number"
        }
    }
}

private struct PendingMobileMessage: Identifiable {
    let id = UUID().uuidString
    let agentID: String
    let text: String
    let attachments: [RelayAttachment]
    let createdAt = Date()
    var failed = false
}

private enum ChatTimestamps {
    static func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour().minute())
    }

    static func divider(_ date: Date) -> String {
        let time = date.formatted(.dateTime.hour().minute())
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today  \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday  \(time)" }
        let day = calendar.isDate(date, equalTo: .now, toGranularity: .year)
            ? date.formatted(.dateTime.month(.abbreviated).day())
            : date.formatted(.dateTime.month(.abbreviated).day().year())
        return "\(day)  \(time)"
    }

    static func startsGroup(_ message: RelayMessage, after previous: RelayMessage?) -> Bool {
        guard let date = message.createdAt else { return false }
        guard let previousDate = previous?.createdAt else { return true }
        return !Calendar.current.isDate(date, inSameDayAs: previousDate)
            || date.timeIntervalSince(previousDate) >= 15 * 60
            || date < previousDate
    }
}

private struct SavedSpawnProject: Codable, Identifiable, Hashable {
    let id: String
    let node: String
    let name: String
    let path: String
}

private enum ChatLinks {
    static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    static func render(_ value: String) -> AttributedString {
        guard let detector else { return AttributedString(value) }
        let source = value as NSString
        let matches = detector.matches(in: value, range: NSRange(location: 0, length: source.length))
        var result = AttributedString()
        var cursor = 0
        for match in matches {
            guard let url = match.url,
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  match.range.location >= cursor else { continue }
            result += AttributedString(source.substring(with: NSRange(
                location: cursor, length: match.range.location - cursor)))
            var linked = AttributedString(source.substring(with: match.range))
            linked.link = url
            result += linked
            cursor = NSMaxRange(match.range)
        }
        if cursor < source.length {
            result += AttributedString(source.substring(from: cursor))
        }
        return result
    }
}

struct RelayWorkspaceView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @StateObject private var client = RelayClient()
    @State private var page: WorkspacePage = .agents
    @State private var selected: RelayAgent?
    @State private var phonePath: [MobileConversationRoute] = []
    @State private var search = ""
    @State private var machineFilter = ""
    @State private var showAll = false
    @State private var showHidden = false
    @State private var messageDraft = ""
    @FocusState private var messageFocused: Bool
    @State private var pendingMessages: [PendingMobileMessage] = []
    @State private var uploadedAttachments: [RelayAttachment] = []
    @State private var showFileImporter = false
    @State private var attachmentUploadTask: Task<Void, Never>?
    @State private var attachmentUploadState = AttachmentUploadState()
    @State private var pinnedAgentIDs: Set<String> = []
    @GestureState private var revealedTimeWidth: CGFloat = 0
    @State private var collapsedOverviewIDs: Set<String> = []
    @State private var commandDraft = ""
    @State private var newRecipient = ""
    @State private var showCompose = false
    @State private var showSpawn = false
    @State private var spawnNodeName = ""
    @State private var spawnHarness = ""
    @State private var spawnName = ""
    @State private var spawnTask = ""
    @State private var spawnProjectID = ""
    @State private var savedSpawnProjects: [SavedSpawnProject] = []
    @State private var addingSpawnProject = false
    @State private var newProjectName = ""
    @State private var newProjectPath = ""
    @State private var spawning = false
    @State private var spawnAccepted = false
    @State private var spawnNotice: String?
    @State private var releaseCandidate: RelayAgent?
    @State private var releasingAgent = false
    @State private var showSettings = false
    @State private var showScreenHistory = false
    private var accent: Color {
        colorScheme == .dark ? Color(red: 0.48, green: 0.69, blue: 1.0)
                             : Color(red: 0.19, green: 0.42, blue: 0.80)
    }

    // The body is split into stages so the Release build type-checks it in
    // reasonable time; one long modifier chain made the archive fail.
    var body: some View {
        observedWorkspace
        .alert("Agent Relay", isPresented: Binding(get: { client.error != nil }, set: { if !$0 { client.error = nil } })) {
            Button("OK", role: .cancel) { client.error = nil }
        } message: { Text(client.error ?? "") }
        .sheet(isPresented: $showSettings) { settings }
        .sheet(isPresented: $showCompose) { compose }
        .sheet(isPresented: $showSpawn) { spawnSheet }
        .sheet(isPresented: $showScreenHistory) { screenHistoryView }
        .confirmationDialog("Release \(releaseCandidate?.name ?? "agent")?", isPresented: Binding(
            get: { releaseCandidate != nil }, set: { if !$0 { releaseCandidate = nil } }
        ), titleVisibility: .visible) {
            Button("Release agent", role: .destructive) {
                guard let target = releaseCandidate else { return }
                releaseCandidate = nil
                releasingAgent = true
                Task {
                    let released = await client.releaseAgent(target)
                    releasingAgent = false
                    if released {
                        switchPage(.agents)
                        search = target.name
                    }
                }
            }
            Button("Cancel", role: .cancel) { releaseCandidate = nil }
        } message: {
            Text("This stops the running agent on \(releaseCandidate?.node ?? "its machine").")
        }
    }
    /// Signed-in workspace or sign-in, with its refresh loop and lifecycle.
    private var lifecycleWorkspace: some View {
        Group {
            if client.paired {
                workspace
            } else {
                signIn
            }
        }
        .task {
            await client.checkConnection()
            Task { await client.resumePendingSignIn() }
            if client.paired { await requestNotifications() }
            if let id = RelayPushState.shared.pendingConversationID { await openNotificationConversation(id) }
            if let name = RelayPushState.shared.pendingChannelName { await openNotificationChannel(name) }
            while !Task.isCancelled {
                // Reconcile presence as well as messages: saved DM threads do
                // not tell us whether their peer is still on the relay.
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { break }
                await client.refresh()
                // A channel's history is read when it opens, when the app
                // returns to the foreground and when its push arrives; the
                // presence refresh never re-reads it.
                if let selected, selected.source != .channel, client.attachedID == nil {
                    await client.loadHistory(for: selected)
                }
                if let selected, client.summaries[selected.sessionID]?.pending == true {
                    await client.loadSummary(for: selected)
                }
                if let token = RelayPushState.shared.token { await client.registerPushToken(token) }
            }
        }
        .onAppear { loadPinnedAgents() }
        .onChange(of: page) { _, _ in
            discardStagedAttachments()
            loadPinnedAgents()
        }
        .onChange(of: client.cloudWorkspaceID) { _, _ in loadPinnedAgents() }
        .onChange(of: client.sessionGeneration) { _, _ in
            // Drafts, uploads and unsent bubbles belong to the account that
            // made them; never carry them into the next one.
            discardStagedAttachments()
            showFileImporter = false
            pendingMessages = []
            messageDraft = ""
            selected = nil
            phonePath = []
            client.selectConversation(nil)
            // A channel name is only meaningful in the workspace it came from.
            RelayPushState.shared.pendingChannelName = nil
        }
        .onChange(of: client.paired) { _, paired in
            if paired {
                Task { await requestNotifications() }
            } else {
                selected = nil
                phonePath = []
                messageDraft = ""
                showAll = false
                showHidden = false
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await client.resumePendingSignIn()
                    await client.refresh()
                    if let selected, selected.source == .channel, client.attachedID == nil {
                        await client.loadHistory(for: selected)
                    }
                }
            }
        }
    }
    /// Keeps the selection and pending notifications in step with the client.
    private var observedWorkspace: some View {
        lifecycleWorkspace
        .onChange(of: client.hiddenConversationIDs) { _, hidden in
            if hidden.isEmpty { showHidden = false }
            if !showHidden, let current = selected, hidden.contains(current.id) {
                selected = nil
                client.selectConversation(nil)
            }
        }
        .onChange(of: client.conversations) { _, conversations in
            reconcileSelection(in: conversations, source: .conversation)
            presentPendingNotificationConversation()
        }
        .onChange(of: client.channels) { _, channels in
            reconcileSelection(in: channels, source: .channel)
            presentPendingNotificationChannel()
        }
        .onChange(of: client.relayAgents.filter { showAll || $0.isHuman || $0.isReachable() }) { _, agents in
            reconcileSelection(in: agents, source: .relay)
        }
        .onReceive(NotificationCenter.default.publisher(for: RelayPushState.tokenDidChange)) { event in
            if let token = event.object as? String { Task { await client.registerPushToken(token) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: RelayPushState.openConversation)) { event in
            if let id = event.object as? String { Task { await openNotificationConversation(id) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: RelayPushState.messageArrived)) { event in
            if let id = event.object as? String { Task { await refreshForPush(conversationID: id) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: RelayPushState.openChannel)) { event in
            if let name = event.object as? String { Task { await openNotificationChannel(name) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: RelayPushState.channelMessageArrived)) { event in
            guard let name = event.object as? String, let selected, selected.source == .channel,
                  selected.name == name, client.attachedID == nil else { return }
            Task { await client.loadHistory(for: selected, reportsErrors: false) }
        }
        .onChange(of: selected) { _, current in
            // Lets a push for the open channel refresh it without a banner.
            RelayPushState.shared.openChannelName = current?.source == .channel ? current?.name : nil
        }
    }

    private func reconcileSelection(in agents: [RelayAgent], source: RelayAgent.Source) {
        guard let current = selected, current.source == source else { return }
        guard let updated = current.rosterMatch(in: agents) else {
            selected = nil
            phonePath = []
            client.selectConversation(nil)
            discardStagedAttachments()
            return
        }
        // A chat composed before the roster arrived keeps its existing ID,
        // so uploads and pending messages continue to belong to that chat.
        guard updated.id == current.id, updated != current else { return }
        selected = updated
        // Navigation keeps its original value: heartbeat metadata must not
        // replace the destination and run its draft/terminal cleanup.
    }

    private func requestNotifications() async {
        let authorized = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if authorized {
            UIApplication.shared.registerForRemoteNotifications()
            if let token = RelayPushState.shared.token { await client.registerPushToken(token) }
        }
    }

    private func openNotificationConversation(_ id: String) async {
        guard client.paired else { return }
        RelayPushState.shared.pendingConversationID = id
        await client.refresh()
        presentPendingNotificationConversation()
    }

    private func presentPendingNotificationConversation() {
        guard client.paired,
              let agent = RelayPushState.shared.takePendingConversation(resolve: client.agent(forConversationID:)) else { return }
        page = .messages
        selected = agent
        messageDraft = ""
        discardStagedAttachments()
        messageFocused = false
        client.selectConversation(agent)
        phonePath = [MobileConversationRoute(agent: agent)]
        Task { await client.loadHistory(for: agent) }
    }

    private func openNotificationChannel(_ name: String) async {
        guard client.paired else { return }
        RelayPushState.shared.pendingChannelName = name
        await client.refresh()
        presentPendingNotificationChannel()
    }

    private func presentPendingNotificationChannel() {
        guard client.paired, let name = RelayPushState.shared.pendingChannelName,
              let channel = client.channels.first(where: { $0.name == name }) else { return }
        RelayPushState.shared.pendingChannelName = nil
        page = .channels
        selected = channel
        messageDraft = ""
        discardStagedAttachments()
        messageFocused = false
        client.selectConversation(channel)
        phonePath = [MobileConversationRoute(agent: channel)]
        Task { await client.loadHistory(for: channel) }
    }

    private func refreshForPush(conversationID: String) async {
        guard client.paired else { return }
        await client.pollMessages()
        guard let selected,
              client.attachedID == nil,
              client.agent(forConversationID: conversationID)?.id == selected.id else { return }
        await client.loadHistory(for: selected)
    }

    private var workspace: some View {
        GeometryReader { geometry in
            Group {
                if geometry.size.width < 700 {
                    phoneWorkspace
                } else {
                    HStack(spacing: 0) {
                        rail
                        Rectangle().fill(Color.primary.opacity(0.08)).frame(width: 1)
                        sidebar.frame(width: geometry.size.width < 850 ? 245 : 285)
                        Rectangle().fill(Color.primary.opacity(0.08)).frame(width: 1)
                        detail.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
            .background(Color(.systemBackground))
        }
    }
    private func switchPage(_ item: WorkspacePage) {
        page = item
        selected = nil
        messageDraft = ""
        discardStagedAttachments()
        messageFocused = false
        client.selectConversation(nil)
        phonePath = []
        search = ""
        machineFilter = ""
        showHidden = false
        Task {
            await client.closeTerminal()
            await client.refresh()
        }
    }
    private var pinStorageKey: String {
        let workspace = client.cloudWorkspaceID ?? client.workspace
        let section = page.rawValue.lowercased().replacingOccurrences(of: " ", with: "-")
        return "relay.pinnedAgents.\(workspace).\(section)"
    }
    private func loadPinnedAgents() {
        pinnedAgentIDs = Set(UserDefaults.standard.stringArray(forKey: pinStorageKey) ?? [])
    }
    private func togglePinned(_ agent: RelayAgent) {
        if pinnedAgentIDs.contains(agent.id) { pinnedAgentIDs.remove(agent.id) }
        else { pinnedAgentIDs.insert(agent.id) }
        UserDefaults.standard.set(pinnedAgentIDs.sorted(), forKey: pinStorageKey)
    }
    private func selectAgent(_ agent: RelayAgent) {
        if selected?.id != agent.id {
            messageDraft = ""
            discardStagedAttachments()
        }
        selected = agent
        messageFocused = false
        client.selectConversation(agent)
        Task { await client.closeTerminal(); await client.loadHistory(for: agent) }
    }
    private var rail: some View {
        VStack(spacing: 12) {
            Image("BrandMark").resizable().scaledToFit().frame(width: 35, height: 31)
                .padding(.top, 17).accessibilityLabel("Agent Relay")
            ForEach(WorkspacePage.allCases) { item in
                Button { switchPage(item) } label: {
                    Image(systemName: item.symbol).font(.system(size: 19, weight: .medium))
                        .foregroundStyle(page == item ? accent : .secondary)
                        .frame(width: 43, height: 43)
                        .background(page == item ? accent.opacity(0.11) : .clear, in: RoundedRectangle(cornerRadius: 9))
                }
                .buttonStyle(.plain).accessibilityLabel(item.rawValue)
            }
            Spacer()
            Button { showSettings = true } label: {
                Image(systemName: "gearshape").font(.system(size: 19)).foregroundStyle(.secondary)
                    .frame(width: 43, height: 43)
            }.buttonStyle(.plain).accessibilityLabel("Settings")
            Text(client.connected ? "●" : "○").font(.caption).foregroundStyle(client.connected ? .green : .orange)
                .padding(.bottom, 15).accessibilityLabel(client.connected ? "Connected" : "Disconnected")
        }
        .frame(width: 60).background(Color(.secondarySystemGroupedBackground))
    }
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(client.workspace).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text(client.account).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                if !client.messagingHandle.isEmpty {
                    Text(client.messagingHandle).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1)
                        .accessibilityLabel("Agents reach you as \(client.messagingHandle)")
                }
            }.padding(.horizontal, 18).padding(.top, 19).padding(.bottom, 18)
            Divider().padding(.bottom, 14)
            HStack {
                Text(listTitle)
                    .font(.system(size: 11, weight: .semibold)).tracking(0.7).foregroundStyle(.secondary)
                Spacer()
                Text(count(for: page).formatted()).font(.caption).foregroundStyle(.secondary)
                if page == .messages {
                    Button { showCompose = true } label: { Image(systemName: "square.and.pencil") }
                        .buttonStyle(.plain).foregroundStyle(accent).accessibilityLabel("New message")
                }
            }.padding(.horizontal, 19).padding(.bottom, 9)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search", text: $search).textInputAutocapitalization(.never).autocorrectionDisabled()
            }.font(.system(size: 13)).padding(9)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.08)))
                .padding(.horizontal, 12).padding(.bottom, 12)
            if page != .channels { machinePicker.padding(.horizontal, 12).padding(.bottom, 10) }
            if page == .agents {
                Button { openSpawn() } label: {
                    Label("Start an agent", systemImage: "plus.circle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.plain).foregroundStyle(accent)
                .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
                .padding(.horizontal, 12).padding(.bottom, 10)
                Picker("Agents", selection: $showAll) {
                    Text("Active").tag(false)
                    Text("All").tag(true)
                }.pickerStyle(.segmented).padding(.horizontal, 12).padding(.bottom, 10)
            }
            List {
                ForEach(filtered) { agent in
                    agentRow(agent)
                        .listRowInsets(EdgeInsets(top: 0.5, leading: 8, bottom: 0.5, trailing: 8))
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) { hideAction(agent) }
                }
                if filtered.isEmpty {
                    Text(emptyListText).font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.top, 20)
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                if showsHiddenToggle {
                    hiddenToggle(font: .system(size: 12))
                        .listRowInsets(EdgeInsets(top: 6, leading: 17, bottom: 6, trailing: 8))
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            Divider()
            Button { Task { await client.refresh() } } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(15)
            }.buttonStyle(.plain)
        }
        .background(Color(.systemGroupedBackground))
    }
    private func count(for page: WorkspacePage) -> Int {
        switch page {
        case .agents: client.relayAgents.filter { showAll || $0.isReachable() }.count
        case .messages: client.conversations.filter { client.hiddenConversationIDs.contains($0.id) == showHidden }.count
        case .channels: client.channels.count
        }
    }
    private var listTitle: String {
        switch page {
        case .agents: "RELAY AGENTS"
        case .messages: showHidden ? "HIDDEN CONVERSATIONS" : "CONVERSATIONS"
        case .channels: "CHANNELS"
        }
    }
    private var emptyListText: String {
        page == .channels ? "No channels in this workspace" : "No agents in this view"
    }
    /// Swipe left on a conversation to hide it on this device; nothing is deleted.
    @ViewBuilder private func hideAction(_ agent: RelayAgent) -> some View {
        if agent.source == .conversation {
            if client.hiddenConversationIDs.contains(agent.id) {
                Button { client.unhideConversation(agent) } label: { Label("Unhide", systemImage: "eye") }
                    .tint(accent)
            } else {
                Button { client.hideConversation(agent) } label: { Label("Hide", systemImage: "eye.slash") }
                    .tint(.gray)
            }
        }
    }
    private var showsHiddenToggle: Bool {
        page == .messages && (showHidden || !client.hiddenConversationIDs.isEmpty)
    }
    private func hiddenToggle(font: Font) -> some View {
        Button { showHidden.toggle() } label: {
            Label(showHidden ? "Show conversations" : "Show hidden (\(client.hiddenConversationIDs.count.formatted()))",
                  systemImage: showHidden ? "bubble.left.and.bubble.right" : "eye.slash")
                .font(font).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain)
    }
    private var filtered: [RelayAgent] {
        let agents: [RelayAgent]
        switch page {
        case .agents: agents = client.relayAgents.filter { showAll || $0.isReachable() }
        case .messages: agents = client.conversations.filter { client.hiddenConversationIDs.contains($0.id) == showHidden }
        case .channels: agents = client.channels
        }
        let matching = agents.filter { agent in
            (agent.source == .channel || MobileMachineFilter.matches(agent.machine, selected: machineFilter)) &&
            (search.isEmpty || "\(agent.name) \(client.displayName(for: agent)) \(agent.subtitle) \(agent.objective) \(agent.sessionTitle) \(agent.address) \(agent.machine) \(client.summaries[agent.sessionID]?.title ?? "") \(client.goals[agent.sessionID] ?? "")".localizedCaseInsensitiveContains(search))
        }
        return matching.filter { pinnedAgentIDs.contains($0.id) } + matching.filter { !pinnedAgentIDs.contains($0.id) }
    }
    private func rowSubtitle(_ agent: RelayAgent) -> String {
        for candidate in [client.summaries[agent.sessionID]?.title ?? "", agent.objective, agent.sessionTitle,
                          client.goals[agent.sessionID] ?? "", agent.subtitle, agent.address] where !candidate.isEmpty {
            return candidate
        }
        return agent.name
    }
    private var machines: [String] {
        let agents = page == .agents ? client.relayAgents.filter { showAll || $0.isReachable() } : client.conversations
        return MobileMachineFilter.options(agents.map(\.machine))
    }
    private var machinePicker: some View {
        Menu {
            Button("All machines") { machineFilter = "" }
            ForEach(machines, id: \.self) { machine in
                Button(machine) { machineFilter = machine }
            }
        } label: {
            HStack {
                Image(systemName: "desktopcomputer")
                Text(machineFilter.isEmpty ? "All machines" : machineFilter).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.down").font(.caption)
            }
            .font(.system(size: 12)).foregroundStyle(.secondary)
            .padding(.horizontal, 10).frame(height: 34)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        }
    }
    private func agentName(_ agent: RelayAgent, font: Font, machineFont: Font) -> some View {
        HStack(spacing: 5) {
            Text(client.displayName(for: agent))
                .font(font).lineLimit(1).minimumScaleFactor(0.8)
            if agent.isHuman {
                // A person's handle is what agents address them by.
                Text(agent.name).font(machineFont).foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.75)
            } else if !agent.machine.isEmpty {
                Text("@\(agent.machine)").font(machineFont).foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.75)
            }
        }
    }
    private func pinButton(_ agent: RelayAgent) -> some View {
        let isPinned = pinnedAgentIDs.contains(agent.id)
        return Button { togglePinned(agent) } label: {
            Image(systemName: isPinned ? "pin.fill" : "pin")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isPinned ? accent : Color.secondary)
                .frame(width: 34, height: 38)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isPinned ? "Unpin \(agent.name)" : "Pin \(agent.name)")
    }
    private func detailSubtitle(_ agent: RelayAgent) -> String {
        let source = agent.subtitle.isEmpty ? agent.address : agent.subtitle
        guard !agent.machine.isEmpty else { return source }
        return source.split(separator: "·").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0 != agent.machine }.joined(separator: " · ")
    }
    private var phoneWorkspace: some View {
        NavigationStack(path: $phonePath) {
            VStack(spacing: 0) {
                Picker("Section", selection: Binding(get: { page }, set: { switchPage($0) })) {
                    ForEach(WorkspacePage.allCases) { item in Text(item.rawValue).tag(item) }
                }
                .pickerStyle(.segmented).padding(.horizontal, 16).padding(.top, 12)
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search \(page.rawValue.lowercased())", text: $search)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .padding(11).background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 16).padding(.top, 12)
                if page != .channels { machinePicker.padding(.horizontal, 16).padding(.top, 9) }
                if page == .agents {
                    Button { openSpawn() } label: {
                        Label("Start an agent", systemImage: "plus.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                    }
                    .buttonStyle(.plain).foregroundStyle(accent)
                    .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal, 16).padding(.top, 9)
                    Picker("Agents", selection: $showAll) {
                        Text("Active").tag(false)
                        Text("All").tag(true)
                    }.pickerStyle(.segmented).padding(.horizontal, 16).padding(.top, 9)
                }
                HStack {
                    Text(listTitle)
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Text(count(for: page).formatted()).font(.caption).foregroundStyle(.secondary)
                }.padding(.horizontal, 19).padding(.top, 16).padding(.bottom, 7)
                List {
                        ForEach(filtered) { agent in
                            HStack(spacing: 2) {
                                Button { phonePath.append(MobileConversationRoute(agent: agent)) } label: {
                                    HStack(spacing: 11) {
                                        avatar(agent, size: 38)
                                        VStack(alignment: .leading, spacing: 3) {
                                            agentName(agent, font: .subheadline.weight(.medium), machineFont: .caption2)
                                            Text(rowSubtitle(agent))
                                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                        }
                                        Spacer(minLength: 0)
                                        unreadIndicator(agent)
                                        if agent.isReachable() {
                                            Circle().fill(.green).frame(width: 7, height: 7)
                                        }
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                    }.padding(.vertical, 12).padding(.leading, 12)
                                        .contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                pinButton(agent).padding(.trailing, 4)
                            }
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
                            .listRowInsets(EdgeInsets(top: 1.5, leading: 12, bottom: 1.5, trailing: 12))
                            .listRowSeparator(.hidden).listRowBackground(Color.clear)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) { hideAction(agent) }
                        }
                        if filtered.isEmpty {
                            Text(emptyListText).foregroundStyle(.secondary).padding(.top, 28)
                                .frame(maxWidth: .infinity)
                                .listRowSeparator(.hidden).listRowBackground(Color.clear)
                        }
                        if showsHiddenToggle {
                            hiddenToggle(font: .subheadline)
                                .listRowInsets(EdgeInsets(top: 10, leading: 19, bottom: 10, trailing: 12))
                                .listRowSeparator(.hidden).listRowBackground(Color.clear)
                        }
                }
                .listStyle(.plain).scrollContentBackground(.hidden)
                .contentMargins(.bottom, 20, for: .scrollContent)
            }
            .background(Color(.systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 8) {
                        Image("BrandMark").resizable().scaledToFit().frame(width: 27, height: 22)
                            .accessibilityIdentifier("Workspace logo")
                        Text("Agent Relay").font(.headline)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await client.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
                if page == .messages {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showCompose = true } label: { Image(systemName: "square.and.pencil") }
                            .accessibilityLabel("New message")
                    }
                }
            }
            .navigationDestination(for: MobileConversationRoute.self) { route in
                let destination = route.agent
                let agent = selected?.id == route.id ? selected ?? destination : destination
                agentDetail(agent)
                    .navigationTitle(client.displayName(for: agent))
                    .navigationBarTitleDisplayMode(.inline)
                    .onAppear {
                        // Metadata changes may re-evaluate the destination;
                        // only entering a different chat resets focus/history.
                        if selected?.id != agent.id { selectAgent(agent) }
                    }
                    .onDisappear {
                        // Popping back to the list is handled by the phonePath
                        // change; this also runs when an iPad crosses the compact
                        // width breakpoint with the same conversation still open,
                        // so it must not drop staged files or a running upload.
                        messageDraft = ""
                        messageFocused = false
                        Task { await client.closeTerminal() }
                    }
            }
        }
        .onChange(of: phonePath) { _, path in
            if path.isEmpty {
                selected = nil
                discardStagedAttachments()
                client.selectConversation(nil)
            }
        }
    }
    private func agentRow(_ agent: RelayAgent) -> some View {
        HStack(spacing: 2) {
            Button { selectAgent(agent) } label: {
                HStack(spacing: 10) {
                    avatar(agent, size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        agentName(agent, font: .system(size: 13, weight: .medium), machineFont: .system(size: 10, weight: .medium, design: .monospaced))
                        Text(rowSubtitle(agent))
                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    unreadIndicator(agent)
                    if agent.isReachable() {
                        Circle().fill(.green).frame(width: 6, height: 6)
                    }
                }
                .padding(.leading, 9).frame(maxWidth: .infinity, minHeight: 51, alignment: .leading)
                .background(selected?.id == agent.id ? accent.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 7))
            }
            .buttonStyle(.plain)
            pinButton(agent)
        }
    }
    @ViewBuilder private func unreadIndicator(_ agent: RelayAgent) -> some View {
        if agent.source == .conversation && client.unreadConversationIDs.contains(agent.id) {
            Circle().fill(accent).frame(width: 9, height: 9)
                .accessibilityLabel("Unread messages")
        }
    }
    @ViewBuilder
    private func avatar(_ agent: RelayAgent, size: CGFloat, identifier: String = "Person avatar") -> some View {
        if agent.source == .channel {
            Image(systemName: "number")
                .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(accent)
                .frame(width: size, height: size)
                .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.26))
                .accessibilityLabel("Channel")
        } else if agent.isHuman {
            let url = client.personProfile(for: agent)?.avatarURL
            PersonAvatar(displayName: client.displayName(for: agent), handle: agent.name,
                         url: url, size: size, accent: accent, accessibilityID: identifier)
                // Reset image state synchronously when the person, URL or
                // signed-in workspace changes, including an open chat header.
                .id([client.cloudWorkspaceID ?? "", String(client.sessionGeneration),
                     agent.name, url?.absoluteString ?? ""])
        } else {
            agentAvatar(agent, size: size)
        }
    }
    private func agentAvatar(_ agent: RelayAgent, size: CGFloat) -> some View {
        let cli = agent.cli.isEmpty
            ? (client.relayAgents.first { $0.name == agent.name }?.cli
               ?? client.fleetAgents.first { $0.name == agent.name }?.cli ?? "")
            : agent.cli
        let artwork = artworkName(for: cli)
        return Group {
            if artwork.isEmpty {
                Image(systemName: "terminal")
                    .resizable().scaledToFit().foregroundStyle(.primary)
            } else if ["grok", "cursor", "opencode", "openai", "muse"].contains(cli) {
                Image(artwork).resizable().renderingMode(.template).scaledToFit().foregroundStyle(.primary)
            } else {
                Image(artwork).resizable().scaledToFit()
            }
        }
        .frame(width: size * 0.68, height: size * 0.68)
        .frame(width: size, height: size)
        .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.26))
        .accessibilityLabel(cli.isEmpty ? "Agent" : "\(cli) agent")
    }
    private func artworkName(for cli: String) -> String {
        switch cli {
        case "codex": "AgentCodex"
        case "claude": "AgentClaude"
        case "claudecode": "AgentClaudecode"
        case "grok": "AgentGrok"
        case "cursor": "AgentCursor"
        case "opencode": "AgentOpencode"
        case "openai": "AgentOpenai"
        case "muse": "AgentMuse"
        default: ""
        }
    }
    private var detail: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Text(page.rawValue).font(.system(size: 14, weight: .semibold)).padding(.leading, 20)
                Spacer(minLength: 0)
                Button { Task { await client.refresh() } } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 13))
                        .frame(width: 38, height: 38)
                }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Refresh")
            }
            .background(Color(.systemGroupedBackground))
            Divider()
            if let selected {
                agentDetail(selected)
            } else {
                VStack(spacing: 14) {
                    Image(systemName: page.symbol).font(.system(size: 45)).foregroundStyle(accent.opacity(0.6))
                    Text(page == .messages ? "Choose a conversation" : page == .channels ? "Choose a channel" : "Choose an agent")
                        .font(.title3.weight(.semibold))
                    Text(page == .channels ? "Everyone in a channel sees every message, from people and agents."
                         : "Send a message and see the response here.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if page == .messages {
                        Button("New message") { showCompose = true }.buttonStyle(.borderedProminent)
                    } else if page == .agents {
                        Button { openSpawn() } label: { Label("New agent", systemImage: "plus") }
                            .buttonStyle(.borderedProminent)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
    private func agentDetail(_ agent: RelayAgent) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                avatar(agent, size: 38, identifier: "Person header avatar")
                VStack(alignment: .leading, spacing: 3) {
                    agentName(agent, font: .system(size: 16, weight: .semibold), machineFont: .system(size: 11, weight: .medium, design: .monospaced))
                    if !detailSubtitle(agent).isEmpty {
                        Text(detailSubtitle(agent)).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                if client.attachedID != nil {
                    Text(client.terminalEnded ? "Ended" : client.attachedMode == "drive" ? "Driving" : "Viewing")
                        .font(.caption).foregroundStyle(client.terminalEnded ? .secondary : accent)
                    Button("Detach") { Task { await client.closeTerminal() } }.buttonStyle(.bordered)
                } else if agent.source == .channel {
                    if agent.isJoined {
                        Text("Joined").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("Join") { Task { await client.joinChannel(agent) } }
                            .buttonStyle(.bordered).accessibilityIdentifier("Join channel")
                    }
                } else {
                    Text(agent.status.isEmpty ? "Agent" : agent.status.capitalized)
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let target = releasableFleetAgent(for: agent) {
                    Button { releaseCandidate = target } label: {
                        Label("Release", systemImage: "stop.circle")
                            .font(.caption.weight(.medium))
                    }
                    .buttonStyle(.bordered).tint(.red)
                    .disabled(releasingAgent)
                }
            }.padding(.horizontal, 16).frame(height: 70)
            if let notice = client.handoffNotice(for: agent) {
                VStack(alignment: .leading, spacing: 4) {
                    Label(notice.title, systemImage: notice.state == .failed ? "exclamationmark.circle" : "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.medium))
                        .accessibilityIdentifier("Mobile handoff status")
                    if !notice.detail.isEmpty { Text(notice.detail).font(.caption) }
                }
                .foregroundStyle(notice.state == .failed ? Color.orange : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 8)
            }
            Divider()
            if client.attachedID != nil {
                summaryCard(for: agent)
                HStack(spacing: 12) {
                    Button("History") { showScreenHistory = true }
                    if client.attachedMode == "drive" {
                        Spacer()
                        Button("Older") { client.onTerminalScroll?(1) }
                        Button("Newer") { client.onTerminalScroll?(-1) }
                    } else {
                        Spacer()
                        Button("Browse in Drive") { Task { await client.attach(agent, mode: "drive") } }
                    }
                }
                .font(.caption).buttonStyle(.borderless).padding(.horizontal, 15).frame(height: 36)
                .background(Color(.tertiarySystemGroupedBackground))
                RelayTerminal(client: client).background(Color(red: 0.075, green: 0.12, blue: 0.17))
                if client.attachedMode == "drive" && !client.terminalEnded { terminalComposer }
            } else {
                conversation(for: agent)
            }
        }
    }
    private func releasableFleetAgent(for agent: RelayAgent) -> RelayAgent? {
        if agent.source == .channel { return nil }
        if agent.source == .drive { return agent.attachable ? agent : nil }
        let matches = client.fleetAgents.filter { $0.name == agent.name && $0.attachable }
        return matches.count == 1 ? matches.first : nil
    }
    private func summaryCard(for agent: RelayAgent) -> some View {
        let overview = client.summaries[agent.sessionID]
        let collapsed = collapsedOverviewIDs.contains(agent.id)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button {
                    if collapsed { collapsedOverviewIDs.remove(agent.id) }
                    else { collapsedOverviewIDs.insert(agent.id) }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        Label("Agent overview", systemImage: "sparkles")
                    }.font(.system(size: 12, weight: .semibold))
                }.buttonStyle(.plain).accessibilityLabel(collapsed ? "Expand agent overview" : "Collapse agent overview")
                Spacer()
                if !collapsed && client.canLoadSummaries && !agent.sessionID.isEmpty {
                    Button(overview?.hasBrief == true ? "Regenerate" : "Generate") {
                        Task { await client.requestSummary(for: agent) }
                    }
                    .font(.caption).buttonStyle(.borderless)
                    .disabled(overview?.pending == true || overview?.status == .loading)
                }
            }
            if collapsed {
                if let overview, overview.hasBrief {
                    Text(overview.title).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                } else if !agent.objective.isEmpty {
                    Text(agent.objective).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                } else if !agent.sessionTitle.isEmpty {
                    Text(agent.sessionTitle).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
            } else if let overview, overview.hasBrief {
                Text(overview.title).font(.system(size: 13, weight: .medium))
                Text(overview.description).font(.system(size: 12)).foregroundStyle(.secondary)
                    .lineLimit(3)
            } else {
                if !agent.sessionTitle.isEmpty {
                    Text(agent.sessionTitle).font(.system(size: 13, weight: .medium))
                }
                if !agent.objective.isEmpty {
                    Text("Published objective").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(agent.objective).font(.system(size: 12)).foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                if let goal = client.goals[agent.sessionID], !goal.isEmpty {
                    Text("Original request").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(goal).font(.system(size: 12)).foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                if agent.sessionID.isEmpty {
                    Text(agent.objective.isEmpty ? "This agent has not published a session summary."
                         : "No Cloud session summary is linked to this chat.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                } else if client.canLoadSummaries {
                    Text(overview?.status == .loading ? "Checking for a saved summary…" :
                         (agent.objective.isEmpty ? "Generate a short summary to see what this agent is working on." : "Generate a Cloud summary for more detail."))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                } else {
                    Text("Cloud access needs approval. Enable summaries once in Settings.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            if !collapsed && overview?.pending == true {
                Text(overview?.status == .queued ? "Summary queued. This may take a few minutes." : "Generating summary…")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !collapsed, let problem = overview?.error {
                Text(problem).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .task(id: "\(agent.id):\(client.canLoadSummaries)") {
            await client.loadSummary(for: agent)
        }
        .task(id: "\(agent.id):\(client.canLoadSummaries):goal") {
            await client.loadGoal(for: agent)
        }
    }
    private var screenHistoryView: some View {
        NavigationStack {
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        Text("Screens captured since this attach began. Earlier agent output may require Drive mode.")
                            .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                        ForEach(Array(client.screenHistory.enumerated()), id: \.offset) { index, screen in
                            Text(screen)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(Color(red: 0.84, green: 0.90, blue: 0.96))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(Color(red: 0.075, green: 0.12, blue: 0.17), in: RoundedRectangle(cornerRadius: 8))
                                .padding(.horizontal)
                                .id(index)
                        }
                    }.padding(.vertical)
                }
                .onAppear { if let last = client.screenHistory.indices.last { reader.scrollTo(last, anchor: .bottom) } }
            }
            .navigationTitle("Screen history")
            .toolbar { Button("Done") { showScreenHistory = false } }
        }
    }
    private func conversation(for agent: RelayAgent) -> some View {
        let scrollRequest = MobileChatScrollRequest(
            pending: pendingMessages.filter { $0.agentID == agent.id }.map(\.id),
            messages: client.messages.map(\.id))
        return VStack(spacing: 0) {
            if agent.source == .drive {
                HStack(spacing: 10) {
                    Button { Task { await client.attach(agent, mode: "drive") } } label: {
                        Label("Drive session", systemImage: "keyboard")
                    }.buttonStyle(.borderedProminent).disabled(!agent.attachable)
                    Button { Task { await client.attach(agent, mode: "view") } } label: {
                        Label("View only", systemImage: "eye")
                    }.buttonStyle(.bordered).disabled(!agent.attachable)
                    Spacer()
                }.padding(18)
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if agent.source != .channel { summaryCard(for: agent) }
                        if client.messages.isEmpty {
                            Text(agent.source == .channel ? "No messages yet. Everyone in \(agent.address) will see what you send."
                                 : "No messages yet. Send one to keep this agent moving.")
                                .font(.subheadline).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, 45)
                        }
                        ForEach(Array(client.messages.enumerated()), id: \.element.id) { index, message in
                            if let date = message.createdAt,
                               ChatTimestamps.startsGroup(message, after: index == 0 ? nil : client.messages[index - 1]) {
                                Text(ChatTimestamps.divider(date))
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 15).padding(.bottom, 4)
                            }
                            messageTimeRow(at: message.createdAt) {
                                VStack(alignment: .trailing, spacing: 3) {
                                HStack(alignment: .bottom) {
                                    if message.mine {
                                        Spacer(minLength: 45)
                                    } else if agent.source == .channel {
                                        // Several people and agents share a channel,
                                        // so each message shows who sent it.
                                        avatar(client.sender(of: message), size: 28, identifier: "Message sender avatar")
                                    }
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(ChatLinks.render(message.text)).font(.system(size: 14))
                                            .textSelection(.enabled).tint(accent)
                                            .accessibilityValue(message.createdAt.map {
                                                "\(message.mine ? "Sent" : "Received") \(ChatTimestamps.divider($0))"
                                            } ?? "")
                                        ForEach(message.attachments) { attachment in
                                            attachmentButton(attachment)
                                        }
                                        Text(senderLabel(message, in: agent))
                                            .font(.system(size: 10)).foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    .padding(12).background(message.mine ? accent.opacity(0.12) : Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                                    if !message.mine { Spacer(minLength: 45) }
                                }
                                // Part of the row so it scrolls into view and
                                // slides with the bubble when times are revealed.
                                if message.mine && message.id == client.messages.last(where: \.mine)?.id {
                                    Text(client.deliveryLabel(for: message, to: agent))
                                        .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                                        .accessibilityIdentifier("Delivery status")
                                }
                                }
                            }.id(MobileChatScrollTarget.message(message.id))
                        }
                        ForEach(pendingMessages.filter { $0.agentID == agent.id }) { pending in
                            messageTimeRow(at: pending.createdAt) {
                                HStack {
                                    Spacer(minLength: 45)
                                    Button {
                                        guard pending.failed else { return }
                                        messageDraft = pending.text
                                        uploadedAttachments = pending.attachments
                                        pendingMessages.removeAll { $0.id == pending.id }
                                        messageFocused = true
                                    } label: {
                                        VStack(alignment: .trailing, spacing: 5) {
                                            Text(ChatLinks.render(pending.text)).font(.system(size: 14)).tint(accent)
                                                .accessibilityValue("Sent \(ChatTimestamps.divider(pending.createdAt))")
                                            // The whole failed bubble is the tap-to-edit button, so its
                                            // attachments are labels, not nested download buttons.
                                            ForEach(pending.attachments) { attachment in
                                                attachmentLabel(attachment, downloadable: false)
                                            }
                                            Label(pending.failed ? "Could not confirm send · tap to edit" : "Sending…",
                                                  systemImage: pending.failed ? "exclamationmark.circle" : "clock")
                                                .font(.system(size: 10))
                                        }
                                        .padding(12).background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                                    }.buttonStyle(.plain)
                                }
                            }.id(MobileChatScrollTarget.pending(pending.id))
                        }
                    }.padding(20)
                }
                .scrollDismissesKeyboard(.interactively)
                .simultaneousGesture(
                    DragGesture(minimumDistance: 15).updating($revealedTimeWidth) { drag, width, _ in
                        let horizontal = drag.translation.width
                        if horizontal < -10 && abs(horizontal) > abs(drag.translation.height) * 1.3 {
                            width = min(80, -horizontal)
                        }
                    }
                )
                .task(id: scrollRequest) {
                    // A send can insert history and remove its pending row in
                    // one update. Reconcile once, then scroll to the surviving
                    // row; a superseded task must never target a removed row.
                    await Task.yield()
                    guard !Task.isCancelled, let scrollTarget = scrollRequest.target else { return }
                    withAnimation { proxy.scrollTo(scrollTarget, anchor: .bottom) }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                messageComposer(for: agent)
                    .background(Color(.systemBackground))
            }
        }
    }
    private func senderLabel(_ message: RelayMessage, in agent: RelayAgent) -> String {
        if agent.source == .channel {
            return message.mine ? "You" : client.displayName(for: client.sender(of: message))
        }
        return message.sender.isEmpty ? (message.mine ? "You" : agent.name) : message.sender
    }
    private func messageTimeRow<Content: View>(at date: Date?,
                                                @ViewBuilder content: () -> Content) -> some View {
        ZStack(alignment: .trailing) {
            if let date {
                Text(ChatTimestamps.time(date))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .frame(width: 76, alignment: .trailing)
                    .opacity(min(1, revealedTimeWidth / 25))
                    .accessibilityHidden(revealedTimeWidth < 10)
            }
            content().offset(x: -revealedTimeWidth)
        }
    }
    private func messageComposer(for agent: RelayAgent) -> some View {
        let uploadingAttachments = attachmentUploadState.isUploading(for: agent.id)
        return VStack(spacing: 0) {
            if uploadingAttachments {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text("Uploading attachment…").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }.padding(.horizontal, 16).padding(.vertical, 7)
            }
            if !uploadedAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(uploadedAttachments) { attachment in
                            HStack(spacing: 6) {
                                Image(systemName: "paperclip")
                                Text(attachment.filename).lineLimit(1).frame(maxWidth: 150)
                                Button { uploadedAttachments.removeAll { $0.id == attachment.id } } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                }.buttonStyle(.plain).accessibilityLabel("Remove \(attachment.filename)")
                            }
                            .font(.caption).padding(.horizontal, 9).padding(.vertical, 7)
                            .background(Color(.secondarySystemGroupedBackground), in: Capsule())
                        }
                    }.padding(.horizontal, 14).padding(.vertical, 7)
                }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                Button { showFileImporter = true } label: {
                    Image(systemName: "paperclip").font(.system(size: 17, weight: .medium))
                        .frame(width: 28, height: 40)
                }
                .buttonStyle(.plain).foregroundStyle(accent)
                .disabled(uploadingAttachments)
                .accessibilityLabel("Attach file")
                TextField("Message \(agent.source == .channel ? agent.address : agent.name)…", text: $messageDraft, axis: .vertical)
                    .accessibilityIdentifier("Message composer")
                    .lineLimit(1...5).font(.system(size: 14)).padding(12)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
                    .focused($messageFocused)
                    .submitLabel(.send)
                    .onSubmit { sendDraft(to: agent) }
                if messageFocused {
                    Button { messageFocused = false } label: {
                        Image(systemName: "keyboard.chevron.compact.down")
                    }.buttonStyle(.plain).accessibilityLabel("Hide keyboard")
                }
                Button { sendDraft(to: agent) } label: {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).frame(width: 26, height: 26)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("Send message")
                .disabled(uploadingAttachments || (messageDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && uploadedAttachments.isEmpty))
            }.padding(14)
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                // Open every picked file's sandbox access now, while the picker
                // grant is fresh; later files would otherwise fail to open after
                // the first upload's awaits.
                let scoped = urls.filter { $0.startAccessingSecurityScopedResource() }
                attachmentUploadTask?.cancel()
                let upload = attachmentUploadState.begin(for: agent.id)
                attachmentUploadTask = Task {
                    defer { scoped.forEach { $0.stopAccessingSecurityScopedResource() } }
                    await uploadFiles(urls, for: agent, upload: upload)
                }
            case .failure(let failure): client.error = failure.localizedDescription
            }
        }
    }
    private func attachmentButton(_ attachment: RelayAttachment) -> some View {
        Button {
            let generation = client.sessionGeneration
            Task {
                do {
                    let url = try await client.downloadURL(for: attachment)
                    guard generation == client.sessionGeneration else { return }
                    openURL(url)
                } catch is CancellationError {
                } catch {
                    if generation == client.sessionGeneration { client.error = error.localizedDescription }
                }
            }
        } label: {
            attachmentLabel(attachment, downloadable: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Download attachment \(attachment.filename)")
    }
    private func attachmentLabel(_ attachment: RelayAttachment, downloadable: Bool) -> some View {
            HStack(spacing: 8) {
                Image(systemName: attachment.contentType.hasPrefix("image/") ? "photo" : "doc")
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.filename).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file))
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
                if downloadable { Image(systemName: "arrow.down.circle").font(.system(size: 13)) }
            }
            .foregroundStyle(accent).frame(maxWidth: .infinity, alignment: .leading)
            .padding(9).background(Color(.systemBackground).opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
    }
    /// Drops staged files and stops any upload still running for them, so a
    /// conversation, page or account switch starts with an idle composer.
    private func discardStagedAttachments() {
        attachmentUploadTask?.cancel()
        attachmentUploadTask = nil
        attachmentUploadState.invalidate()
        uploadedAttachments = []
    }
    private func uploadFiles(_ urls: [URL], for agent: RelayAgent,
                             upload: AttachmentUploadState.Token) async {
        // Only the upload the composer is waiting on may touch its state; a
        // cancelled or superseded one must not add files or clear the spinner.
        let current = {
            attachmentUploadState.isCurrent(upload) && !Task.isCancelled && selected?.id == agent.id
        }
        guard current() else { return }
        defer {
            if attachmentUploadState.finish(upload) {
                attachmentUploadTask = nil
            }
        }
        for url in urls {
            do {
                let attachment = try await client.uploadAttachment(from: url)
                guard current() else { return }
                uploadedAttachments.append(attachment)
            } catch {
                if current(), !(error is CancellationError) { client.error = error.localizedDescription }
                return
            }
        }
    }
    private func sendDraft(to agent: RelayAgent) {
        let draft = messageDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = uploadedAttachments
        // The keyboard's return key reaches here too, so wait for the pick to
        // finish uploading instead of sending only the files that are done.
        guard !attachmentUploadState.isUploading(for: agent.id),
              !draft.isEmpty || !attachments.isEmpty else { return }
        let text = draft.isEmpty ? "Shared \(attachments.count) attachment\(attachments.count == 1 ? "" : "s")." : draft
        messageDraft = ""
        uploadedAttachments = []
        let pending = PendingMobileMessage(agentID: agent.id, text: text, attachments: attachments)
        pendingMessages.append(pending)
        Task {
            let sent = await client.send(text, attachments: attachments, to: agent)
            #if DEBUG
            MobileHandoffFixture.trace("composer received send result: \(sent)")
            #endif
            if sent { pendingMessages.removeAll { $0.id == pending.id } }
            else if let index = pendingMessages.firstIndex(where: { $0.id == pending.id }) {
                pendingMessages[index].failed = true
            }
        }
    }
    private var terminalComposer: some View {
        HStack(spacing: 10) {
            TextField("Type a command or instruction", text: $commandDraft)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .onSubmit { submitCommand() }
            Button("Send") { submitCommand() }.disabled(commandDraft.isEmpty)
        }.padding(12).background(Color(.secondarySystemGroupedBackground))
    }
    private func submitCommand() {
        let text = commandDraft
        guard !text.isEmpty else { return }
        commandDraft = ""
        Task { await client.terminalInput(text) }
    }
    private var selectedSpawnNode: RelaySpawnNode? {
        client.spawnNodes.first { $0.name == spawnNodeName }
    }
    private var spawnProjectsOnNode: [SavedSpawnProject] {
        savedSpawnProjects.filter { $0.node == spawnNodeName }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private var selectedSpawnProject: SavedSpawnProject? {
        spawnProjectsOnNode.first { $0.id == spawnProjectID }
    }
    private var spawnProjectsKey: String {
        "relay.spawnProjects.\(client.cloudWorkspaceID ?? "local")"
    }
    private static let localSpawnProjectsKey = "relay.spawnProjects.local"
    /// Projects saved before the workspace was known were stored under the
    /// local key; adopt them once the workspace is known so they don't vanish.
    private func loadSpawnProjects() -> [SavedSpawnProject] {
        let defaults = UserDefaults.standard
        let decode = { (key: String) in
            defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([SavedSpawnProject].self, from: $0) } ?? []
        }
        var projects = decode(spawnProjectsKey)
        if spawnProjectsKey != Self.localSpawnProjectsKey {
            let local = decode(Self.localSpawnProjectsKey)
            if !local.isEmpty {
                projects += local.filter { project in
                    !projects.contains { $0.node == project.node && $0.path == project.path }
                }
                if let data = try? JSONEncoder().encode(projects) { defaults.set(data, forKey: spawnProjectsKey) }
                defaults.removeObject(forKey: Self.localSpawnProjectsKey)
            }
        }
        return projects
    }
    private var newProjectPathProblem: String? {
        SpawnProjectPath.problem(newProjectPath, node: spawnNodeName)
    }
    private func saveSpawnProjects() {
        guard let data = try? JSONEncoder().encode(savedSpawnProjects) else { return }
        UserDefaults.standard.set(data, forKey: spawnProjectsKey)
    }
    private func addSpawnProject() {
        let name = newProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
        let path = newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, path.hasPrefix("/"), !path.contains("\n") else {
            spawnNotice = "Enter a project name and its absolute folder path on \(spawnNodeName)."
            return
        }
        if let existing = spawnProjectsOnNode.first(where: { $0.path == path }) {
            spawnProjectID = existing.id
        } else {
            let project = SavedSpawnProject(id: UUID().uuidString, node: spawnNodeName, name: name, path: path)
            savedSpawnProjects.append(project)
            spawnProjectID = project.id
            saveSpawnProjects()
        }
        newProjectName = ""
        newProjectPath = ""
        addingSpawnProject = false
        spawnNotice = nil
    }
    private func openSpawn() {
        savedSpawnProjects = loadSpawnProjects()
        spawnNodeName = client.spawnNodes.first?.name ?? ""
        spawnHarness = client.spawnNodes.first?.harnesses.first ?? ""
        spawnProjectID = savedSpawnProjects.first { $0.node == spawnNodeName }?.id ?? ""
        spawnName = ""
        spawnTask = ""
        addingSpawnProject = false
        newProjectName = ""
        newProjectPath = ""
        spawnAccepted = false
        spawnNotice = nil
        showSpawn = true
        Task { await client.refresh() }
    }
    private func spawnSymbol(_ harness: String) -> String {
        switch harness {
        case "codex": "chevron.left.forwardslash.chevron.right"
        case "claude": "sparkles"
        case "opencode": "curlybraces"
        case "muse": "music.note"
        case "grok": "bolt.fill"
        case "gemini": "diamond.fill"
        case "devin": "hammer.fill"
        default: "cpu"
        }
    }
    private func spawnHarnessCard(_ harness: String) -> some View {
        let selected = spawnHarness == harness
        let artwork = artworkName(for: harness)
        return Button { spawnHarness = harness } label: {
            VStack(spacing: 9) {
                Group {
                    if artwork.isEmpty {
                        Image(systemName: spawnSymbol(harness))
                            .font(.system(size: 23, weight: .medium))
                    } else if ["grok", "cursor", "opencode", "openai", "muse"].contains(harness) {
                        Image(artwork).resizable().renderingMode(.template).scaledToFit()
                    } else {
                        Image(artwork).resizable().scaledToFit()
                    }
                }.frame(width: 28, height: 28)
                Text(harness.capitalized).font(.subheadline.weight(.semibold))
            }
            .frame(width: 96, height: 78)
            .foregroundStyle(selected ? accent : Color.primary)
            .background(selected ? accent.opacity(0.13) : Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .stroke(selected ? accent : Color.clear, lineWidth: 1.5))
        }.buttonStyle(.plain).accessibilityLabel("Start a \(harness) agent")
    }
    /// The form stays up once a machine is chosen or a start is in progress,
    /// even if a refresh briefly returns no machines.
    private var spawnSheetHasMachine: Bool {
        !client.spawnNodes.isEmpty || spawning || !spawnNodeName.isEmpty
    }
    private var spawnSheet: some View {
        NavigationStack {
            Form {
                if !spawnSheetHasMachine {
                    Section {
                        ContentUnavailableView("No machines available", systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                                               description: Text("Connect a machine that can start agents, then refresh."))
                        Button("Refresh machines") { Task { await client.refresh() } }
                    }
                } else {
                    Section("Machine") {
                        Picker("Run on", selection: $spawnNodeName) {
                            ForEach(client.spawnNodes) { node in Text(node.name).tag(node.name) }
                        }
                        .onChange(of: spawnNodeName) { _, _ in
                            if let node = selectedSpawnNode, !node.harnesses.contains(spawnHarness) {
                                spawnHarness = node.harnesses.first ?? ""
                            }
                            spawnProjectID = spawnProjectsOnNode.first?.id ?? ""
                            addingSpawnProject = false
                        }
                        if !spawnNodeName.isEmpty && selectedSpawnNode == nil {
                            Text("\(spawnNodeName) is not available right now. Wait for it to come back or choose another machine.")
                                .font(.caption).foregroundStyle(.red)
                        }
                    }
                    if let node = selectedSpawnNode {
                        Section("Agent type") {
                            ScrollView(.horizontal) {
                                HStack(spacing: 10) {
                                    ForEach(node.harnesses, id: \.self) { harness in
                                        spawnHarnessCard(harness)
                                    }
                                }.padding(.vertical, 5)
                            }.scrollIndicators(.hidden)
                        }
                    }
                    Section {
                        TextField("Name", text: $spawnName)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        ZStack(alignment: .topLeading) {
                            if spawnTask.isEmpty {
                                Text("What should this agent do?").foregroundStyle(.tertiary)
                                    .padding(.horizontal, 5).padding(.top, 8)
                            }
                            TextEditor(text: $spawnTask).frame(minHeight: 110)
                                .scrollContentBackground(.hidden)
                        }
                    } header: {
                        Text("New agent")
                    } footer: {
                        Text("Use a short, unique name with lowercase letters, numbers, or hyphens.")
                    }
                    Section("Project on this machine") {
                        Picker("Project", selection: $spawnProjectID) {
                            Text("No project").tag("")
                            ForEach(spawnProjectsOnNode) { project in
                                Text(project.name).tag(project.id)
                            }
                        }
                        if let project = selectedSpawnProject {
                            Text(project.path).font(.caption).foregroundStyle(.secondary)
                            Button("Forget this project", role: .destructive) {
                                savedSpawnProjects.removeAll { $0.id == project.id }
                                spawnProjectID = spawnProjectsOnNode.first?.id ?? ""
                                saveSpawnProjects()
                            }
                        } else if spawnProjectsOnNode.isEmpty {
                            Text("Save a folder on \(spawnNodeName) to choose it again when starting agents.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Button(addingSpawnProject ? "Cancel adding project" : "Add project folder") {
                            addingSpawnProject.toggle()
                        }
                        if addingSpawnProject {
                            TextField("Project name", text: $newProjectName)
                            TextField("Absolute folder path on \(spawnNodeName)", text: $newProjectPath)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            if let problem = newProjectPathProblem {
                                Text(problem).font(.caption).foregroundStyle(.red)
                            }
                            Button("Save project") { addSpawnProject() }
                                .disabled(newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                          newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                          newProjectPathProblem != nil)
                        }
                    }
                }
                if let spawnNotice {
                    Section { Text(spawnNotice).foregroundStyle(spawnAccepted ? Color.secondary : Color.red) }
                }
                if spawnSheetHasMachine && !spawnAccepted {
                    Section {
                        Button { startSpawn() } label: {
                            HStack {
                                Spacer()
                                if spawning { ProgressView().padding(.trailing, 7) }
                                Text(spawning ? "Starting agent…" : "Start agent")
                                Spacer()
                            }
                        }
                        .disabled(spawning || selectedSpawnNode == nil || spawnHarness.isEmpty || spawnName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                  spawnTask.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } footer: {
                        if spawning {
                            Text("Waiting for \(spawnNodeName) to confirm the agent is running. This can take up to 2 minutes.")
                        }
                    }
                }
            }
            .navigationTitle("New agent")
            .toolbar { Button(spawnAccepted ? "Done" : "Cancel") { showSpawn = false }.disabled(spawning) }
            .onAppear {
                if spawnNodeName.isEmpty { spawnNodeName = client.spawnNodes.first?.name ?? "" }
                if spawnHarness.isEmpty { spawnHarness = selectedSpawnNode?.harnesses.first ?? "" }
            }
            .onChange(of: client.spawnNodes) { _, nodes in
                // A node can drop out of one refresh and return in the next;
                // keep the person's choice rather than switching machines.
                if spawnNodeName.isEmpty {
                    spawnNodeName = nodes.first?.name ?? ""
                    spawnHarness = nodes.first?.harnesses.first ?? ""
                    spawnProjectID = spawnProjectsOnNode.first?.id ?? ""
                }
            }
        }
        .frame(minWidth: 380, minHeight: 550)
        .interactiveDismissDisabled(spawning)
    }
    private func startSpawn() {
        guard let node = selectedSpawnNode, !spawning else { return }
        // Hide the keyboard so the progress and any error below are visible.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        spawning = true
        spawnNotice = nil
        let name = spawnName.trimmingCharacters(in: .whitespacesAndNewlines)
        let project = selectedSpawnProject
        let harness = spawnHarness
        let task = spawnTask
        Task {
            do {
                switch try await client.spawnAgent(on: node, harness: harness, name: name,
                                                   task: task, workingDirectory: project?.path ?? "",
                                                   projectName: project?.name) {
                case .ready, .running:
                    showSpawn = false
                    switchPage(.agents)
                    search = name
                case .unconfirmed:
                    spawnAccepted = true
                    spawnNotice = "\(node.name) accepted the request but has not confirmed that \(name) started. "
                        + "Check Agents in a minute before trying again."
                }
            } catch {
                spawnNotice = error.localizedDescription
            }
            spawning = false
        }
    }
    private enum AccountLinks {
        static let privacy = URL(string: "https://agentrelay.com/privacy")!
        static let support = URL(string: "https://agentrelay.com/support")!
        // Release blocker until Cloud deploys and verifies this direct deletion page.
        static let deletion = URL(string: "https://agentrelay.com/cloud/account/delete")!
    }

    private var signIn: some View {
        VStack(spacing: 18) {
            Image("BrandMark").resizable().scaledToFit().frame(width: 92, height: 75)
            Text("Agent Relay").font(.largeTitle.bold())
            Text("Sign in to your Agent Relay workspace to reach agents and messages anywhere.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let url = client.verificationURL {
                Link("Continue in Safari", destination: url).buttonStyle(.borderedProminent)
                if !client.userCode.isEmpty { Text(client.userCode).font(.title2.monospaced().bold()) }
                Text(client.signInStatus).font(.caption).foregroundStyle(.secondary)
            } else {
                Button(client.busy ? "Starting…" : "Sign in") { Task { await client.beginSignIn() } }
                    .buttonStyle(.borderedProminent).disabled(client.busy)
            }
            HStack {
                Link("Privacy policy", destination: AccountLinks.privacy)
                Link("Support", destination: AccountLinks.support)
            }.font(.footnote)
        }.frame(width: 380).frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(25).background(Color(.secondarySystemGroupedBackground))
    }
    private var settings: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    LabeledContent("Status", value: client.connected ? "Connected" : "Offline")
                    Button("Reconnect") { Task { await client.checkConnection() } }
                    Button("Sign out", role: .destructive) { Task { await client.signOut(); showSettings = false } }
                }
                Section("Account") {
                    Link("Privacy policy", destination: AccountLinks.privacy)
                    Link("Support", destination: AccountLinks.support)
                    NavigationLink("Open-source licenses") {
                        ScrollView {
                            if let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt"),
                               let notices = try? String(contentsOf: url, encoding: .utf8) {
                                Text(notices).font(.footnote).textSelection(.enabled).padding()
                            } else {
                                Text("License information is unavailable.").padding()
                            }
                        }.navigationTitle("Open-source licenses")
                    }
                    Link("Delete account", destination: AccountLinks.deletion)
                        .foregroundStyle(.red)
                }
                Section("Session summaries") {
                    LabeledContent("Cloud access", value: client.canLoadSummaries ? "Enabled" : "Needs approval")
                    if !client.canLoadSummaries {
                        if let url = client.verificationURL {
                            Link("Continue in Safari", destination: url)
                            if !client.userCode.isEmpty { Text(client.userCode).font(.caption.monospaced().bold()) }
                            Text(client.signInStatus).font(.caption).foregroundStyle(.secondary)
                        } else {
                            Button(client.busy ? "Starting…" : client.hasSavedCloudCredential ? "Finish Cloud sign-in" : "Enable summaries") {
                                Task {
                                    if client.hasSavedCloudCredential { await client.resumePendingSignIn() }
                                    else { await client.beginSignIn() }
                                }
                            }.disabled(client.busy)
                        }
                    }
                }
                Section {
                    Text("Agent Relay Mobile connects directly to Relaycast. An internet connection is required.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Done") { showSettings = false } }
        }.frame(minWidth: 420, minHeight: 320)
    }
    private var compose: some View {
        NavigationStack {
            Form {
                TextField("Agent name or Relay address", text: $newRecipient)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Open conversation") {
                    let endpoint = newRecipient.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "^@", with: "", options: .regularExpression)
                    guard !endpoint.isEmpty else { return }
                    let agent = RelayAgent.recipient(endpoint, in: client.relayAgents + client.conversations)
                    page = .messages; showCompose = false; newRecipient = ""
                    selectAgent(agent)
                    phonePath = [MobileConversationRoute(agent: agent)]
                }.disabled(newRecipient.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .navigationTitle("New message")
            .toolbar { Button("Cancel") { showCompose = false } }
        }.frame(minWidth: 420, minHeight: 260)
    }
}
