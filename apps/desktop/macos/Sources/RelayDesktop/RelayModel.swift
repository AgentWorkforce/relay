import AppKit
import Foundation
import RelayDesktopCore
import RelaySessionOverview

/// The relay as the Agents page and the menu panel show it: this Mac's
/// sessions and agents, the fleet, the workspace roster and its people,
/// recent deliveries and direct messages. Every list is the core's; this
/// keeps the last answer of each and what the person is switching.
@MainActor
final class RelayModel: ObservableObject {
    private(set) var sessionRowsRevision: UInt64 = 0
    private(set) var sessionSearchMetadataRevision: UInt64 = 0

    @Published private(set) var sessions: [LocalSession] = [] {
        didSet { if oldValue != sessions { sessionRowsRevision &+= 1 } }
    }
    @Published private(set) var agents: [LocalAgent] = []
    /// Agents that left the relay because their session was archived.
    @Published private(set) var archivedAgents: [ArchivedAgent] = [] {
        didSet { if oldValue != archivedAgents { sessionSearchMetadataRevision &+= 1 } }
    }
    @Published private(set) var brokers: [BrokerListing] = []
    @Published private(set) var roster: [RosterAgent] = [] {
        didSet { if oldValue != roster { sessionSearchMetadataRevision &+= 1 } }
    }
    @Published private(set) var rosterError: String?
    @Published private(set) var people: [WorkspacePerson] = []
    @Published private(set) var peopleError: String?
    @Published private(set) var activity: [DeliveryActivity] = []
    @Published private(set) var overviews: [String: SessionOverview] = [:]
    @Published private(set) var goals: [String: String] = [:]
    /// Cloud turned away the overview calls: the core holds no session to
    /// call it as the person, and the card offers to sign in again.
    @Published private(set) var overviewNeedsSignIn = false
    /// Bumped when a renewed sign-in makes the overviews read again.
    @Published private(set) var overviewReloads = 0
    @Published private(set) var isRefreshing = false
    /// Why the last change to a session failed, by target key.
    @Published private(set) var errors: [String: String] = [:]
    /// Why taking a spawned agent over failed, by `LocalSession.id`, until it
    /// is tried again.
    @Published var takeOverErrors: [String: String] = [:]
    /// The switch state asked for, by target key, while the relay catches up.
    @Published private(set) var wanted: [String: Bool] = [:] {
        didSet { if oldValue != wanted { sessionSearchMetadataRevision &+= 1 } }
    }
    @Published private(set) var busyTargets: Set<String> = [] {
        didSet { if oldValue != busyTargets { sessionSearchMetadataRevision &+= 1 } }
    }
    @Published private(set) var releasingFleet: Set<String> = []
    /// Workers released and shown as such until the next fleet listing.
    @Published private(set) var releasedFleet: Set<String> = []
    @Published private(set) var fleetRowErrors: [String: String] = [:]
    /// A message sent from the composer that its conversation does not list
    /// yet: shown under the history until a read lists it. Once the core
    /// took it, `sentId` is the id a history read confirms it by.
    struct PendingMessage {
        let echo: DirectMessage
        var sent = false
        var sentId: String?
    }
    /// By endpoint, oldest first.
    @Published private(set) var pendingMessages: [String: [PendingMessage]] = [:]
    @Published private(set) var isConnectingWorkspace = false
    @Published private(set) var workspaceConnectError: String?
    /// The conversation with one endpoint, while the composer shows it.
    @Published private(set) var conversation: (endpoint: String, history: History)?
    @Published private(set) var conversationError: String?
    @Published private(set) var isLoadingConversation = false
    /// The roster's record of the composer's recipient, while the composer
    /// is open.
    @Published private(set) var recipient: (endpoint: String, recipient: Recipient)?
    /// The composer's last send: where it went, its message id, and the
    /// last state Relaycast reported for it.
    @Published private(set) var lastSend: (endpoint: String, messageId: String?, state: MessageState?)?

    private let client: CoreClient
    private let capyStore: CapySpawnStore
    weak var model: AppModel?
    private var conversationReads = 0
    private var recipientReads = 0
    /// The recipient the open composer shows; `nil` while it is closed.
    private var composerEndpoint: String?
    private var loadingOverviews: Set<String> = []
    private var loadingGoals: Set<String> = []
    @Published private(set) var titleOverviews: [String: SessionOverview] = [:]
    @Published private(set) var titleCapabilities: [String: SessionTitleCapability] = [:]
    @Published private(set) var titleEdits = SessionTitleEdits() { didSet { sessionRowsRevision &+= 1 } }
    @Published private(set) var titleErrors: [String: String] = [:]
    private(set) var titleWriteRevision: UInt64 = 0
    private var titlePreloadQueue: [LocalSessionRow] = []
    private var activeTitlePreloads: Set<String> = []
    private var titlePreloadedAt: [String: Date] = [:]
    private var titlePreloadGeneration: UInt64 = 0
    /// Renewed when the account changes: an answer about the previous
    /// account's roster, people or messages is dropped.
    private var account = UUID()

    init(client: CoreClient, defaults: UserDefaults = .standard) {
        self.client = client
        capyStore = CapySpawnStore(defaults: defaults)
    }

    // MARK: Snapshot

    var workspace: WorkspaceStatus? {
        guard let workspace = model?.core?.workspace, workspace.isFound else { return nil }
        return workspace
    }
    var storeError: String? { model?.core?.agents.storeError }
    var integrationError: String? { model?.core?.agents.integrationError }
    var deliveryError: String? { model?.core?.agents.deliveryError }

    /// Most recent first; switching never reorders rows.
    var sessionsByRecency: [LocalSession] {
        sessions.sorted { lhs, rhs in
            let lhsAt = lhs.updatedAtMs ?? 0, rhsAt = rhs.updatedAtMs ?? 0
            if lhsAt != rhsAt { return lhsAt > rhsAt }
            return lhs.id < rhs.id
        }
    }

    func agent(for session: LocalSession) -> LocalAgent? {
        agents.first { $0.target == session.target }
    }

    /// The push channel's state comes from the snapshot, which the core
    /// publishes on every change; the session list carries only the
    /// registration.
    func presence(of session: LocalSession) -> RelayPresence {
        // A busy session with no explicit request is switching to the other
        // state; one registered provisionally is on its way on.
        let wanted = wanted[session.id]
            ?? (busyTargets.contains(session.id) ? (session.registration == nil || session.registration?.isProvisional == true) : nil)
        let push = session.registration.flatMap { model?.core?.push[$0.name] }
        return RelayPresence.of(onRelay: session.registration != nil, wanted: wanted, isLive: session.live,
                                pushLive: push.map(\.isLive))
    }

    /// Off the relay needs a running session and a workspace; on it can
    /// always be switched off.
    func canToggle(_ session: LocalSession, presence: RelayPresence) -> Bool {
        (model?.hiddenSessionIDs.contains(session.target.uploadKey ?? session.id) != true) && (presence.isOn || presence.isChanging || (session.live && workspace != nil))
    }

    func switchHelp(_ session: LocalSession, presence: RelayPresence) -> String {
        if presence.isOn { return "Take off the relay" }
        if !session.live { return "Start this session to put it on the relay" }
        if workspace == nil { return "Connect a relay workspace first" }
        return session.target.uploadKey == nil
            ? "Put on the relay to message it by name"
            : "Put on the relay to message it by name. Sessions on the relay are uploaded."
    }

    /// Why a message to `address` waits, when its session is not running.
    func waitingStatus(at address: String) -> String? {
        guard let session = sessions.first(where: { $0.registration?.address == address }), !session.live else { return nil }
        return "Waiting — session not running"
    }

    var onlineCount: Int { sessions.filter { presence(of: $0) == .online }.count }

    /// Names this Mac's fleet workers go by, so the roster does not list
    /// them again as remote; its own sessions the roster marks `this_computer`.
    var localNames: Set<String> { Set(brokers.flatMap(\.workers).map(\.name)) }

    var rosterGroups: RosterGroups { RosterGroups(roster, people: people, localNames: localNames) }
    var teammates: [WorkspacePerson] { people.filter { !$0.isSelf } }
    var fleetErrors: [String] { brokers.compactMap { broker in broker.error.map { "\(broker.name): \($0)" } } }

    // MARK: Refresh

    func refreshAll() async {
        isRefreshing = true
        defer { isRefreshing = false }
        async let sessions: Void = refresh(.sessions)
        async let agents: Void = refresh(.agents)
        async let fleet: Void = refresh(.fleet)
        async let activity: Void = refresh(.activity)
        async let roster: Void = refresh(.roster)
        async let people: Void = refresh(.people)
        _ = await (sessions, agents, fleet, activity, roster, people)
    }

    /// The core invalidated `what`: re-fetches it, and a session, worker or
    /// reply changing can change whether the open composer's recipient runs
    /// and what became of its message.
    func invalidated(_ what: Listing) async {
        await refresh(what)
        switch what {
        case .sessions, .fleet, .roster, .messages:
            if let endpoint = composerEndpoint { await readRecipient(endpoint) }
        default:
            break
        }
    }

    /// Re-fetches one collection.
    func refresh(_ what: Listing) async {
        let revision = model?.uploadConnectionRevision
        switch what {
        case .sessions:
            try? await loadSessions()
        case .agents:
            if let result = try? await client.agentsList() {
                guard revision == model?.uploadConnectionRevision else { return }
                if agents != result.agents { agents = result.agents }
                if archivedAgents != result.archived { archivedAgents = result.archived }
            }
        case .fleet:
            if let result = try? await client.fleetList(), revision == model?.uploadConnectionRevision {
                if brokers != result.brokers { brokers = result.brokers }
                // Reconcile the optimistic release even when the listing is unchanged.
                if !releasedFleet.isEmpty { releasedFleet = [] }
            }
        case .activity:
            if let result = try? await client.activityList(LimitParams()), revision == model?.uploadConnectionRevision, activity != result.activity {
                activity = result.activity
            }
        case .roster:
            let current = account
            do {
                let result = try await client.rosterList(RosterParams(includeIdle: false))
                guard current == account, revision == model?.uploadConnectionRevision else { return }
                if roster != result.agents { roster = result.agents }
                if rosterError != nil { rosterError = nil }
            } catch let error as CoreError where error.kind == ErrorKind.notSignedIn.rawValue {
                guard current == account, revision == model?.uploadConnectionRevision else { return }
                if !roster.isEmpty { roster = [] }
                if rosterError != nil { rosterError = nil }
            } catch {
                if current == account && revision == model?.uploadConnectionRevision && rosterError != error.localizedDescription {
                    rosterError = error.localizedDescription
                }
            }
        case .people:
            let current = account
            do {
                let result = try await client.peopleList()
                guard current == account, revision == model?.uploadConnectionRevision else { return }
                if people != result.people { people = result.people }
                if peopleError != nil { peopleError = nil }
            } catch let error as CoreError where error.kind == ErrorKind.notSignedIn.rawValue {
                guard current == account, revision == model?.uploadConnectionRevision else { return }
                if !people.isEmpty { people = [] }
                if peopleError != nil { peopleError = nil }
            } catch {
                if current == account && revision == model?.uploadConnectionRevision && peopleError != error.localizedDescription {
                    peopleError = error.localizedDescription
                }
            }
        case .messages:
            if let endpoint = conversation?.endpoint { await loadConversation(endpoint) }
        default:
            break
        }
    }

    /// Reads this Mac's sessions with their registrations.
    func loadSessions() async throws {
        let revision = model?.uploadConnectionRevision
        let titleRevision = titleWriteRevision
        let result = try await client.sessionsList()
        guard revision == model?.uploadConnectionRevision, titleRevision == titleWriteRevision else { return }
        if sessions != result.sessions { sessions = result.sessions }
        reconcileTitleEdits()
        settle()
        model?.reconcileHiddenSessions()
    }

    /// The sessions again, showing the panel's and page's progress.
    func refreshSessions() async {
        isRefreshing = true
        defer { isRefreshing = false }
        try? await loadSessions()
    }

    /// Retire reads from the old core without discarding the visible relay.
    func connectionInterrupted() {
        conversationReads += 1
        recipientReads += 1
        isLoadingConversation = false
        // A send the retired core never answered is not shown as on its way.
        pendingMessages = [:]
        // A read from the retired core cannot finish a loading placeholder.
        loadingOverviews = []
        loadingGoals = []
        retireTitlePreloads()
        titleOverviews = titleOverviews.filter { $0.value.status != .loading }
        overviews = overviews.filter { $0.value.status != .loading }
    }

    /// The replacement core has answered its first snapshot. Restart visible
    /// overview reads that may have expired during a longer outage.
    func connectionRecovered() {
        // Hover during an outage may have started a failed read; recovery
        // invalidates those as well as requests from the original connection.
        retireTitlePreloads()
        overviews = overviews.filter { _, overview in
            overview.status != .failed ||
                (overview.error != CoreError.reconnecting.message && overview.error != CoreError.closed.message)
        }
        overviewReloads += 1
    }

    private func retireTitlePreloads() {
        titlePreloadGeneration &+= 1
        titlePreloadQueue = []
        activeTitlePreloads = []
        titlePreloadedAt = [:]
        titleCapabilities = [:]
    }

    func accountChanged() {
        account = UUID()
        titlePreloadGeneration &+= 1
        activeTitlePreloads = []
        titleWriteRevision &+= 1
        titleEdits = SessionTitleEdits()
        titleErrors = [:]
        titleOverviews = [:]
        titleCapabilities = [:]
        titlePreloadedAt = [:]
        titlePreloadQueue = []
        overviews = [:]
        loadingOverviews = []
        overviewNeedsSignIn = false
        goals = [:]
        loadingGoals = []
        conversationReads += 1
        conversation = nil
        conversationError = nil
        isLoadingConversation = false
        recipientReads += 1
        recipient = nil
        lastSend = nil
        pendingMessages = [:]
        releasedFleet = []
        roster = []
        people = []
        rosterError = nil
        peopleError = nil
        Task {
            await refresh(.people)
            await refresh(.roster)
        }
    }

    func displayedTitle(for row: LocalSessionRow) -> String {
        titleEdits.title(for: row.id) ?? row.title
    }

    func titleState(for row: LocalSessionRow) -> SessionTitlePresentation {
        let overview = titleOverviews[row.id]
        let generated = overview?.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return SessionTitlePresentation(title: displayedTitle(for: row),
            supported: titleCapabilities[row.id]?.supported,
            reason: titleCapabilities[row.id]?.reason,
            generatedTitle: generated?.isEmpty == false ? generated : nil,
            saving: titleEdits.isSaving(row.id), error: titleErrors[row.id],
            preloadRevision: overviewReloads)
    }

    /// Opening a session preloads its saved suggestion and native capability.
    /// A bounded queue and one-minute cache also cover quick session switching.
    func preloadTitle(_ row: LocalSessionRow) {
        guard !activeTitlePreloads.contains(row.id),
              !titlePreloadQueue.contains(where: { $0.id == row.id }),
              titlePreloadedAt[row.id].map({ Date().timeIntervalSince($0) >= 60 }) ?? true else { return }
        if titlePreloadQueue.count >= 64 { titlePreloadQueue.removeFirst() }
        titlePreloadQueue.append(row)
        drainTitlePreloads()
    }

    private func drainTitlePreloads() {
        while activeTitlePreloads.count < 4, !titlePreloadQueue.isEmpty {
            let row = titlePreloadQueue.removeFirst()
            activeTitlePreloads.insert(row.id)
            let current = account
            let revision = model?.uploadConnectionRevision
            let generation = titlePreloadGeneration
            Task {
                defer {
                    // Retired reads must not remove a replacement core's active request.
                    if generation == titlePreloadGeneration {
                        activeTitlePreloads.remove(row.id)
                        drainTitlePreloads()
                    }
                }
                do {
                    let capability = try await client.sessionsTitleCapability(SessionTitleIdentity(sessionId: row.sessionID, source: row.source))
                    guard generation == titlePreloadGeneration, current == account, revision == model?.uploadConnectionRevision else { return }
                    titleCapabilities[row.id] = capability
                } catch {
                    guard generation == titlePreloadGeneration, current == account, revision == model?.uploadConnectionRevision else { return }
                    titleCapabilities[row.id] = SessionTitleCapability(reason: error.localizedDescription, supported: false)
                }
                if row.upload?.status == .uploaded {
                    if titleOverviews[row.id] == nil { titleOverviews[row.id] = SessionOverview(status: .loading) }
                    do {
                        let response = try await client.sessionsOverviewGet(SessionOverviewParams(sessionId: row.sessionID))
                        let overview = try SessionOverview.decode(JSONEncoder().encode(response), sessionID: row.sessionID, source: row.source)
                        guard generation == titlePreloadGeneration, current == account, revision == model?.uploadConnectionRevision else { return }
                        titleOverviews[row.id] = overview
                    } catch {
                        guard generation == titlePreloadGeneration, current == account, revision == model?.uploadConnectionRevision else { return }
                        let previous = titleOverviews[row.id]
                        titleOverviews[row.id] = SessionOverview(status: .failed, title: previous?.title ?? "",
                            description: previous?.description ?? "", error: error.localizedDescription)
                    }
                }
                guard generation == titlePreloadGeneration, current == account, revision == model?.uploadConnectionRevision else { return }
                titlePreloadedAt[row.id] = Date()
            }
        }
    }

    func setSessionTitle(_ rawTitle: String, for row: LocalSessionRow) async {
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !titleEdits.isSaving(row.id), titleCapabilities[row.id]?.supported == true else { return }
        guard title != titleState(for: row).title else { return }
        let current = account
        let token = titleEdits.begin(row.id, title: title)
        titleErrors[row.id] = nil
        titleWriteRevision &+= 1
        do {
            let result = try await client.sessionsTitleSet(SessionTitleSetParams(sessionId: row.sessionID, source: row.source, title: title))
            guard current == account else { return }
            titleWriteRevision &+= 1
            titleEdits.succeed(row.id, token: token, title: result.title)
            scheduleTitleExpiry(row)
            await refreshSessions()
            await model?.refreshSessions()
            reconcileTitleEdits()
        } catch {
            guard current == account else { return }
            titleWriteRevision &+= 1
            titleEdits.fail(row.id, token: token)
            scheduleTitleExpiry(row)
            titleErrors[row.id] = error.localizedDescription
        }
    }

    private func scheduleTitleExpiry(_ row: LocalSessionRow) {
        guard let expiration = titleEdits.expiration(for: row.id) else { return }
        let current = account
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, expiration.date.timeIntervalSinceNow)))
            guard let self, current == self.account else { return }
            var edits = self.titleEdits
            guard edits.expire(row.id, token: expiration.token) else { return }
            self.titleEdits = edits
            await self.refreshSessions()
            await self.model?.refreshSessions()
        }
    }

    func reconcileTitleEdits() {
        let rows = LocalSessionRow.mergeUnsorted(uploads: model?.sessions ?? [], sessions: sessions)
        var updated = titleEdits
        for row in rows { updated.observe(row.id, title: row.title) }
        if updated != titleEdits { titleEdits = updated }
    }

    func loadOverview(_ sessionID: String) async {
        guard !sessionID.isEmpty, !loadingOverviews.contains(sessionID) else { return }
        let current = account
        let revision = model?.uploadConnectionRevision
        loadingOverviews.insert(sessionID)
        defer { if revision == model?.uploadConnectionRevision { loadingOverviews.remove(sessionID) } }
        let previous = overviews[sessionID]
        if previous == nil { overviews[sessionID] = SessionOverview(status: .loading) }
        do {
            let response = try await client.sessionsOverviewGet(SessionOverviewParams(sessionId: sessionID))
            let decoded = try SessionOverview.decode(JSONEncoder().encode(response), sessionID: sessionID)
            if current == account && revision == model?.uploadConnectionRevision {
                overviews[sessionID] = decoded
                overviewNeedsSignIn = false
            }
        } catch {
            if current == account && revision == model?.uploadConnectionRevision {
                overviewNeedsSignIn = Self.needsSignIn(error)
                overviews[sessionID] = SessionOverview(status: .failed, title: previous?.title ?? "",
                                                       description: previous?.description ?? "", error: error.localizedDescription)
            }
        }
    }

    func loadGoal(_ sessionID: String) async {
        guard !sessionID.isEmpty, goals[sessionID] == nil, !loadingGoals.contains(sessionID) else { return }
        let current = account
        let revision = model?.uploadConnectionRevision
        loadingGoals.insert(sessionID)
        defer { if revision == model?.uploadConnectionRevision { loadingGoals.remove(sessionID) } }
        do {
            let response = try await client.sessionsOverviewEvents(SessionOverviewParams(sessionId: sessionID))
            let goal = try SessionGoal.decode(JSONEncoder().encode(response), sessionID: sessionID) ?? ""
            if current == account && revision == model?.uploadConnectionRevision { goals[sessionID] = goal }
        } catch { /* The saved summary and published description still work without History events. */ }
    }

    func requestOverview(_ sessionID: String) async {
        guard !sessionID.isEmpty, overviews[sessionID]?.pending != true else { return }
        let current = account
        let revision = model?.uploadConnectionRevision
        do {
            _ = try await client.sessionsOverviewRequest(SessionOverviewParams(sessionId: sessionID))
            guard current == account, revision == model?.uploadConnectionRevision else { return }
            overviews[sessionID] = SessionOverview(status: .queued, title: overviews[sessionID]?.title ?? "",
                                                   description: overviews[sessionID]?.description ?? "")
            await loadOverview(sessionID)
        } catch {
            if current == account && revision == model?.uploadConnectionRevision {
                overviewNeedsSignIn = Self.needsSignIn(error)
                overviews[sessionID] = SessionOverview(status: .failed, title: overviews[sessionID]?.title ?? "",
                                                       description: overviews[sessionID]?.description ?? "", error: error.localizedDescription)
            }
        }
    }

    /// A renewed sign-in: the overviews Cloud turned away are read again.
    func signInRenewed() {
        overviewNeedsSignIn = false
        overviews = overviews.filter { $0.value.status != .failed }
        overviewReloads += 1
    }

    /// Cloud turned the call away because the core holds no session to make
    /// it as the person: signing in again fixes it.
    private static func needsSignIn(_ error: Error) -> Bool {
        (error as? CoreError)?.kind == ErrorKind.notSignedIn.rawValue
    }

    /// Forgets a wanted state the relay has reached.
    private func settle() {
        for (key, on) in wanted where !busyTargets.contains(key) {
            if sessions.first(where: { $0.id == key }).map({ ($0.registration != nil) == on }) ?? true {
                wanted[key] = nil
            }
        }
    }

    // MARK: Switching

    /// Puts a session on the relay or takes it off. The switch shows the new
    /// state at once; one change per session runs at a time, and the last
    /// state asked for wins.
    func requestRelay(_ on: Bool, for session: LocalSession) {
        guard !on || model?.hiddenSessionIDs.contains(session.target.uploadKey ?? session.id) != true else { return }
        wanted[session.id] = on
        errors[session.id] = nil
        guard !busyTargets.contains(session.id) else { return }
        busyTargets.insert(session.id)
        Task { await drive(session.id, target: session.target) }
    }

    func register(_ session: LocalSession, as name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@")).lowercased()
        guard !name.isEmpty else { return }
        guard model?.hiddenSessionIDs.contains(session.target.uploadKey ?? session.id) != true else { return }
        guard !busyTargets.contains(session.id) else { return }
        busyTargets.insert(session.id)
        errors[session.id] = nil
        defer { busyTargets.remove(session.id); settle() }
        // The row reads as on the relay under `name` from the click; the
        // core's listing brings the real registration, and a failure takes
        // the provisional one away again.
        if let index = sessions.firstIndex(where: { $0.id == session.id }), sessions[index].registration == nil {
            sessions[index] = sessions[index].withRegistration(.provisional(name: name))
        }
        do {
            let registered = try await client.agentsRegister(RegisterParams(name: name, target: session.target))
            // Preserve the successful mutation if the follow-up list fails,
            // so a queued off request still knows which agent to unregister.
            if let index = sessions.firstIndex(where: { $0.id == session.id }) {
                let current = sessions[index]
                let previous = registered.alreadyRegistered ? current.registration : nil
                let registration = SessionRegistration(addedBySession: previous?.addedBySession ?? false, address: registered.address, alias: previous?.alias, name: registered.name, push: previous?.push, spawn: previous?.spawn)
                sessions[index] = LocalSession(directory: current.directory, host: current.host, live: current.live, project: current.project, registration: registration, running: current.running, suggestedName: current.suggestedName, target: current.target, title: current.title, updatedAtMs: current.updatedAtMs)
            }
            try await loadSessions()
            await refresh(.agents)
        } catch {
            errors[session.id] = error.localizedDescription
            if let index = sessions.firstIndex(where: { $0.id == session.id }),
               let registration = sessions[index].registration, registration.isProvisional, registration.name == name {
                sessions[index] = sessions[index].withRegistration(nil)
            }
        }
        // A hide/off request made during explicit name registration must win
        // before callers observe this target as settled.
        if wanted[session.id] != nil { await drive(session.id, target: session.target) }
    }

    private func drive(_ key: String, target: Target) async {
        defer {
            busyTargets.remove(key)
            settle()
        }
        while let on = wanted[key] {
            let current = sessions.first { $0.id == key }
            let isOn = current?.registration != nil
            if on == isOn { break }
            do {
                if on {
                    try await client.agentsRegister(RegisterParams(target: target))
                } else if let name = current?.registration?.name {
                    try await client.agentsUnregister(NameParams(name: name))
                }
                // The switch settles on what the core lists; a list that
                // cannot be read ends the change rather than repeating it.
                try await loadSessions()
                errors[key] = nil
                await refresh(.agents)
            } catch {
                errors[key] = error.localizedDescription
                wanted[key] = nil
                break
            }
        }
    }

    // MARK: Workspace

    /// Fetches the account workspace's relay key with the Agent Relay sign-in.
    func connectWorkspace() async {
        guard let workspaceID = model?.workspaceID, !isConnectingWorkspace else { return }
        isConnectingWorkspace = true
        workspaceConnectError = nil
        model?.connectingWorkspace = true
        defer {
            isConnectingWorkspace = false
            model?.connectingWorkspace = false
        }
        do {
            try await client.accountConnectWorkspace(ConnectWorkspaceParams(workspaceId: workspaceID))
        } catch {
            workspaceConnectError = error.localizedDescription
        }
    }

    func cancelConnectWorkspace() {
        Task { try? await client.accountSignInCancel() }
    }

    // MARK: Agent tools

    private func act(_ change: () async throws -> Void) async -> String? {
        do {
            try await change()
            await refresh(.agents)
            await refresh(.sessions)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    enum RenameOutcome: Equatable {
        /// What the rename did, in words from the core's answer: the alias it released.
        case renamed(String)
        case failed(String)
    }

    /// The agent is shown under its new name from the click; the core's
    /// listing confirms it, and a failure shows the old name again.
    func rename(_ agent: LocalAgent, to name: String) async -> RenameOutcome {
        showAlias(name, of: agent)
        var released: String?
        if let error = await act({ released = try await client.agentsRename(RenameParams(name: agent.name, newName: name)).released }) {
            // Only where the name asked for is still what shows: a listing
            // read meanwhile is the core's word.
            showAlias(agent.alias, of: agent, where: name)
            return .failed(error)
        }
        return .renamed(AgentNameText.renamed(name: agent.name, previousAlias: released, requested: name))
    }

    /// Shows `agent` (and its session) under `alias`; with `current`, only
    /// where that alias shows now.
    private func showAlias(_ alias: String?, of agent: LocalAgent, where current: String? = nil) {
        agents = agents.map { listed in
            guard listed.name == agent.name, current == nil || listed.alias == current else { return listed }
            return listed.withAlias(alias)
        }
        sessions = sessions.map { session in
            guard let registration = session.registration, registration.name == agent.name,
                  current == nil || registration.alias == current else { return session }
            return session.withRegistration(registration.withAlias(alias))
        }
    }

    func setReplyWithFinalAnswer(_ enabled: Bool?, for agent: LocalAgent) async -> String? {
        await act { try await client.agentsReplySetting(ReplySettingParams(enabled: enabled, name: agent.name)) }
    }

    func sendTestMessage(to agent: LocalAgent, text: String) async -> String? {
        await act { try await client.agentsTestMessage(TestMessageParams(name: agent.name, text: text)) }
    }

    /// Creates the agent's webhook; the secret is only in this answer.
    func createWebhook(for agent: LocalAgent) async -> Result<CreatedWebhook, CoreError> {
        do {
            let created = try await client.agentsWebhookCreate(NameParams(name: agent.name))
            await refresh(.agents)
            return .success(created)
        } catch let error as CoreError {
            return .failure(error)
        } catch {
            return .failure(CoreError(kind: ErrorKind.internal.rawValue, message: error.localizedDescription))
        }
    }

    func revokeWebhook(for agent: LocalAgent) async -> String? {
        await act { try await client.agentsWebhookRevoke(NameParams(name: agent.name)) }
    }

    func subscribe(_ agent: LocalAgent, provider: String, resource: String) async -> String? {
        await act {
            try await client.agentsIntegrationsSubscribe(IntegrationParams(name: agent.name, provider: provider, resource: resource))
        }
    }

    func unsubscribe(_ integration: AgentIntegration, from agent: LocalAgent) async -> String? {
        let params = IntegrationParams(name: agent.name, provider: integration.provider, resource: integration.resource)
        return await act {
            if integration.ready {
                try await client.agentsIntegrationsUnsubscribe(params)
            } else {
                try await client.agentsIntegrationsCleanUp(params)
            }
        }
    }

    func release(_ worker: WorkerRow, from broker: BrokerListing) async {
        guard let generation = worker.generation, !releasingFleet.contains(worker.id) else { return }
        releasingFleet.insert(worker.id)
        // The row reads as released from the click; the next listing says
        // where the worker stands, and a failure brings its actions back.
        releasedFleet.insert(worker.id)
        fleetRowErrors[worker.id] = nil
        defer { releasingFleet.remove(worker.id) }
        do {
            try await client.fleetRelease(ReleaseParams(generation: generation, name: worker.name, nodeId: broker.nodeId))
            await refresh(.fleet)
        } catch {
            releasedFleet.remove(worker.id)
            fleetRowErrors[worker.id] = error.localizedDescription
        }
    }

    // MARK: Spawned agents

    /// Hands a spawned agent's session to the person (`agents.take_over`):
    /// returns once its headless process has stopped.
    func takeOver(_ name: String, interrupt: Bool) async throws -> TakenOver {
        let taken = try await client.agentsTakeOver(TakeOverParams(interrupt: interrupt, name: name))
        async let sessions: Void = refresh(.sessions)
        async let agents: Void = refresh(.agents)
        _ = await (sessions, agents)
        return taken
    }

    // MARK: Capy thread spawning

    func capyProjects() async throws -> [CapyProject] {
        var projects: [CapyProject] = []
        var cursor: String?
        repeat {
            let page = try await client.capyProjectsList(CapyProjectsParams(cursor: cursor))
            projects.append(contentsOf: page.projects)
            cursor = page.truncated ? page.nextCursor : nil
        } while cursor != nil
        return projects
    }

    func savedCapySpawn(workspaceID: String) -> CapySpawnOperation? {
        capyStore.operation(workspaceID: workspaceID)
    }

    func prepareCapySpawn(workspaceID: String, projectID: String, task: String,
                          model: String?, pullRequestAuthor: String?, reportTo: String?) throws -> CapySpawnOperation {
        try capyStore.prepare(workspaceID: workspaceID, projectID: projectID, task: task,
                              model: model, pullRequestAuthor: pullRequestAuthor, reportTo: reportTo)
    }

    func startCapyThread(_ operation: CapySpawnOperation) async throws -> (CapySpawnOperation, CapyThreadSpawn) {
        let author = operation.pullRequestAuthor.flatMap(CapyPullRequestAuthor.init(rawValue:))
        let result = try await client.capyThreadsSpawn(CapyThreadSpawnParams(
            clientRequestId: operation.clientRequestID,
            model: operation.model,
            projectId: operation.projectID,
            pullRequestAuthor: author,
            reportTo: operation.reportTo,
            task: operation.task
        ))
        let saved = try capyStore.markCreated(operation, threadID: result.threadId)
        return (saved, result)
    }

    func capyThreadStatus(_ threadID: String) async throws -> CapyThreadSpawn {
        try await client.capyThreadsGet(CapyThreadSpawnGetParams(threadId: threadID))
    }

    func clearCapySpawn() {
        capyStore.clear()
    }

    // MARK: Messages

    /// `@name` or `agent@machine`, as the composer takes it.
    static func endpoint(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.hasPrefix("@") ? String(value.dropFirst()) : value
    }

    func loadConversation(_ raw: String) async {
        let endpoint = Self.endpoint(raw)
        guard !endpoint.isEmpty else { return }
        if conversation?.endpoint != endpoint { conversation = nil }
        // The newest read wins: an older one finishing later is dropped.
        conversationReads += 1
        let read = conversationReads
        isLoadingConversation = true
        defer { if read == conversationReads { isLoadingConversation = false } }
        do {
            let history = try await client.messagesHistory(HistoryParams(endpoint: endpoint))
            guard read == conversationReads else { return }
            conversation = (endpoint, history)
            conversationError = nil
            retirePendingMessages(endpoint, listed: history)
        } catch {
            if read == conversationReads { conversationError = error.localizedDescription }
        }
    }

    /// `to` for a name, `address` for an exact address.
    private static func recipientParams(_ endpoint: String) -> (address: String?, to: String?) {
        endpoint.contains("@") ? (endpoint, nil) : (nil, endpoint)
    }

    /// The open composer shows `raw` as its recipient (it opened, or To
    /// changed). Anything about another
    /// recipient (its record, a read in flight, its last send and that
    /// send's follow-up) is retired.
    func composerShows(_ raw: String) {
        let endpoint = Self.endpoint(raw)
        guard endpoint != composerEndpoint else { return }
        composerEndpoint = endpoint
        recipientReads += 1
        if recipient?.endpoint != endpoint { recipient = nil }
        if lastSend?.endpoint != endpoint { lastSend = nil }
    }

    /// The composer opened showing `raw`: it starts clean and follows that
    /// recipient until it closes.
    func openComposer(_ raw: String) {
        closeComposer()
        composerShows(raw)
    }

    /// Reads the open composer's recipient `raw` and, for its last send
    /// there, what Relaycast holds for the message. Only a read: a recipient
    /// the composer does not show (or a closed composer) is not read.
    func lookUpRecipient(_ raw: String) async {
        await readRecipient(Self.endpoint(raw))
    }

    /// Reads `endpoint` while it is the composer's recipient; an answer that
    /// arrives after the composer moved on is dropped. A read that cannot
    /// tell keeps the last state Relaycast reported.
    private func readRecipient(_ endpoint: String) async {
        guard endpoint == composerEndpoint else { return }
        recipientReads += 1
        let read = recipientReads
        guard !endpoint.isEmpty else {
            recipient = nil
            return
        }
        let (address, to) = Self.recipientParams(endpoint)
        let messageId = lastSend.flatMap { $0.endpoint == endpoint ? $0.messageId : nil }
        let current = account
        guard let result = try? await client.rosterGet(RecipientParams(address: address, messageId: messageId, to: to)),
              read == recipientReads, current == account, endpoint == composerEndpoint else { return }
        recipient = (endpoint, result)
        if let state = result.message, let sent = lastSend, sent.endpoint == endpoint, sent.messageId == messageId {
            lastSend = (endpoint, messageId, state)
        }
    }

    /// The recipient's record when it is the composer's `endpoint`.
    func recipient(at raw: String) -> Recipient? {
        let endpoint = Self.endpoint(raw)
        return recipient.flatMap { $0.endpoint == endpoint ? $0.recipient : nil }
    }

    /// What the composer says about its last send to `endpoint`.
    func deliveryNote(at raw: String) -> (text: String, tone: DeliveryTone)? {
        let endpoint = Self.endpoint(raw)
        guard let lastSend, lastSend.endpoint == endpoint else { return nil }
        return MessageDelivery.note(lastSend.state, recipient: recipient(at: endpoint))
    }

    /// The composer moved on from its last send (a new message is being
    /// written); the note gives way to the recipient's state.
    func forgetLastSend() {
        lastSend = nil
    }

    /// The composer closed: nothing is followed for it any more.
    func closeComposer() {
        composerEndpoint = nil
        recipientReads += 1
        recipient = nil
        lastSend = nil
    }

    /// The conversation with `raw` as the composer shows it: the history
    /// read last, then the messages sent since that it does not list yet.
    func shownHistory(at raw: String) -> History? {
        let endpoint = Self.endpoint(raw)
        guard let conversation, conversation.endpoint == endpoint else { return nil }
        let pending = pendingMessages[endpoint] ?? []
        guard !pending.isEmpty else { return conversation.history }
        return History(identity: conversation.history.identity, messages: conversation.history.messages + pending.map(\.echo))
    }

    /// A history read of `endpoint` succeeded: the messages it lists, and
    /// those the core took without an id to confirm them by, are no longer
    /// shown as on their way.
    private func retirePendingMessages(_ endpoint: String, listed history: History) {
        let ids = Set(history.messages.map(\.id))
        pendingMessages[endpoint]?.removeAll { $0.sent && $0.sentId.map(ids.contains) ?? true }
    }

    /// Sends as the signed-in person; the answer's delivery state is kept
    /// for the composer. The message shows in the conversation at once, as
    /// on its way, until the history lists it. Returns why the send failed.
    func sendMessage(to raw: String, text: String) async -> String? {
        let endpoint = Self.endpoint(raw)
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return "Type a message first." }
        let (address, to) = Self.recipientParams(endpoint)
        let params = SendParams(address: address, text: body, to: to)
        let echo = PendingMessages.echo(body)
        pendingMessages[endpoint, default: []].append(PendingMessage(echo: echo))
        // The echo goes at once when the send fails, and once a history
        // read lists the message when it succeeds.
        var taken = false
        defer { if !taken { pendingMessages[endpoint]?.removeAll { $0.echo.id == echo.id } } }
        do {
            let sent = try await client.messagesSend(params)
            taken = true
            if let index = pendingMessages[endpoint]?.firstIndex(where: { $0.echo.id == echo.id }) {
                pendingMessages[endpoint]?[index].sent = true
                pendingMessages[endpoint]?[index].sentId = sent.messageId
            }
            guard endpoint == composerEndpoint else { return nil }
            recipientReads += 1
            recipient = (endpoint, sent.recipient)
            lastSend = (endpoint, sent.messageId, sent.recipient.message)
            await loadConversation(endpoint)
            // Relaycast hands a message to a running agent's host within
            // moments; read its state again once it has had the chance.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                // Only while the composer still shows this send: a To changed
                // since retired it, and its read never displaces the new one.
                guard let self, sent.messageId != nil, self.lastSend?.endpoint == endpoint,
                      self.lastSend?.messageId == sent.messageId else { return }
                await self.readRecipient(endpoint)
            }
            return nil
        } catch let error as CoreError where error.kind == ErrorKind.notFound.rawValue {
            if endpoint == composerEndpoint {
                recipientReads += 1
                recipient = (endpoint, Recipient(agent: nil, known: true))
                lastSend = nil
            }
            return MessageDelivery.note(.noSuchAgent, recipient: nil).text
        } catch {
            return error.localizedDescription
        }
    }
}
