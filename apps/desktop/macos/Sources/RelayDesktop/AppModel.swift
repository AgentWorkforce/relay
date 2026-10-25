import AppKit
import Foundation
import OSLog
import RelayDesktopCore
import UserNotifications

/// The app's state: a client of the relay core that keeps only what the
/// windows and the menu bar need. The core owns sign-in, the uploader,
/// agents, delivery and every Cloud and Relaycast call; this model renders
/// its snapshot, re-fetches what it invalidates and sends it commands.
///
/// ```
/// launch ─register LaunchAgent─▶ connect ─hello/subscribe─▶ status snapshots + events
///   account.state: signed_out ─sign in─▶ pending_approval ─▶ preparing ─▶ signed_in
/// ```
@MainActor
final class AppModel: ObservableObject {
    // Source revisions make query-only cache reads constant time. Published
    // setters notify before mutation; didSet advances these before the next read.
    private(set) var sessionRowsRevision: UInt64 = 0
    private(set) var sessionSearchMetadataRevision: UInt64 = 0
    let sessionSearchSource = SessionSearchSourceCache()

    enum Phase: Equatable {
        /// Before the core's first snapshot.
        case launching
        /// Signed out: the sign-in window is the app.
        case signedOut
        /// A sign-in is starting or connecting the workspace.
        case signingIn
        /// Waiting for the browser to return to this Mac.
        case waitingForBrowser
        /// Signed in; local sessions are being prepared for upload.
        case preparingSessions
        /// Signed in with the uploader connected.
        case attached
    }

    static let logger = Logger(subsystem: AppInfo.subsystem, category: "model")

    // MARK: Published state

    @Published private(set) var isCoreConnected = false
    @Published private(set) var core: Status? {
        didSet {
            // Revision/daemon diagnostics do not change session search metadata.
            if oldValue?.account != core?.account || oldValue?.workspace != core?.workspace || oldValue?.push != core?.push {
                sessionSearchMetadataRevision &+= 1
            }
        }
    }
    @Published private(set) var signInLink: String?
    /// The core could not be started or reached.
    @Published private(set) var coreProblem: String?
    /// macOS holds the core until the person allows it in Login Items.
    @Published private(set) var coreNeedsApproval = false
    @Published private(set) var isRecoveringCore = false
    @Published private(set) var lastError: String?
    @Published private(set) var signInError: String?
    /// From the sign-in click until the core answers or its snapshot shows
    /// the attempt; no second one starts meanwhile.
    @Published private(set) var startingSignIn = false
    /// From Log out until the core has answered and its snapshot no longer
    /// shows the account.
    @Published private(set) var signingOut = false

    @Published private(set) var status: UploaderStatus? {
        didSet {
            // SessionUploadState only reads these global fields. Delivery counters
            // still publish to the footer without rebuilding every search row.
            if oldValue?.paused != status?.paused || oldValue?.stage != status?.stage || oldValue?.delivery.stopped != status?.delivery.stopped {
                sessionSearchMetadataRevision &+= 1
            }
        }
    }
    @Published private(set) var sessions: [UploadSession] = [] {
        didSet { if oldValue != sessions { sessionRowsRevision &+= 1 } }
    }
    @Published private(set) var previewSessionIDs: Set<String> = [] {
        didSet { if oldValue != previewSessionIDs { sessionSearchMetadataRevision &+= 1 } }
    }
    @Published private(set) var sessionPreparationStarted: Date?
    @Published private(set) var isLoadingPreview = false
    /// Why the titles found on this Mac could not be read while history prepares.
    @Published private(set) var previewError: String?
    @Published private(set) var lastSessionsRefresh: Date?
    @Published private(set) var isLoadingSessions = false
    @Published private(set) var sessionsError: String?
    @Published private(set) var sessionActionError: String?
    /// Why compacting the journal or retrying stopped uploads failed.
    @Published private(set) var uploadActionError: String?
    @Published private(set) var workDescription: String?
    @Published private(set) var isWorking = false
    /// The upload policy asked for while `uploader.sharing.set` answers.
    @Published private(set) var sharingModeWanted = PendingValue<SharingMode>()
    /// Paused or resumed, as asked for, while the uploader answers.
    @Published private(set) var pausedWanted = PendingValue<Bool>()
    /// The stage action asked for (retry or compact) until its answer.
    @Published private(set) var pendingUploadAction: UploadStage.Action?
    private var drivingSharingMode = false
    private var drivingPause = false
    @Published private(set) var requestingUploads: Set<String> = [] {
        didSet { if oldValue != requestingUploads { sessionSearchMetadataRevision &+= 1 } }
    }
    @Published private(set) var stoppingUploads: Set<String> = [] {
        didSet { if oldValue != stoppingUploads { sessionSearchMetadataRevision &+= 1 } }
    }
    @Published private(set) var uploadErrors: [String: String] = [:]
    private var uploadTasks: [String: Task<Bool, Never>] = [:]
    @Published private(set) var sessionLimit = AppModel.sessionPage
    @Published var sessionUploadFilter: SessionUploadFilter = .all
    @Published var selectedLocalSession: LocalSessionRow? {
        didSet { if selectedLocalSession != nil { showsSessionSearch = false } }
    }
    @Published var sessionSearch = ""
    @Published var showsSessionSearch = false
    @Published var sessionSort = LocalSessionSort()
    @Published var savedSessionViews = SavedSessionViews() {
        didSet { defaults.set(savedSessionViews.data, forKey: SavedSessionViews.preferenceKey) }
    }
    var sessionViewConfiguration: SessionViewConfiguration {
        SessionViewConfiguration(search: sessionSearch, grouping: sessionGrouping, sort: sessionSort,
                                 columns: sessionColumns, showHidden: showHiddenSessions)
    }
    var currentSavedSessionView: SavedSessionView? {
        let configuration = sessionViewConfiguration
        return savedSessionViews.views.first { $0.configuration == configuration }
    }
    func applySessionView(_ view: SavedSessionView) {
        let configuration = view.configuration
        sessionSearch = configuration.search
        sessionGrouping = configuration.grouping
        sessionSort = configuration.sort
        sessionColumns = SessionColumnLayout(data: configuration.columns)
        showHiddenSessions = configuration.showHidden
        selectedLocalSession = nil
        showsSessionSearch = false
        page = .sessions
    }
    @Published var sessionGrouping: LocalSessionGrouping = .none
    @Published private(set) var hiddenSessionIDs: Set<String> = [] {
        didSet { defaults.set(Array(hiddenSessionIDs).sorted(), forKey: "hiddenSessions.v1") }
    }
    @Published private(set) var hidingSessionIDs: Set<String> = []
    @Published var showHiddenSessions = false {
        didSet { defaults.set(showHiddenSessions, forKey: "showHiddenSessions.v1") }
    }

    @Published var sessionColumns = SessionColumnLayout() {
        didSet { defaults.set(sessionColumns.data, forKey: SessionColumnLayout.preferenceKey) }
    }
    /// Sessions offers to put Capy threads on the relay.
    @Published private(set) var showsCapySetup = false
    /// Set up in Capy copied its prompt.
    @Published private(set) var capyPromptCopied = false
    /// Not now was chosen on the Devin card.
    @Published private(set) var devinSetupDismissed = false
    /// Why Turn On on the Devin card failed; the core's sentence.
    @Published private(set) var devinSetupError: String?
    /// Sessions offers Agent Relay's hooks to Devin while the core reports
    /// them off.
    var showsDevinSetup: Bool {
        DevinSetup.shows(hooks: settings?.devinDirectDelivery, dismissed: devinSetupDismissed)
    }

    @Published var page: DesktopPage = .sessions {
        didSet { if page != .sessions { showsSessionSearch = false } }
    }
    /// My agents' sidebar scope.
    @Published var agentScope: MyAgentScope = .all
    /// The teammate the Team page is narrowed to, by identity hash; nil shows everyone.
    @Published var teamPerson: String?
    /// The agent search shared by My agents and Team.
    @Published var agentSearch = ""
    /// The open relay sheet, set from any page, the menu bar and links.
    @Published var agentsSheet: AgentsSheet?
    /// The message composer's target; not secret.
    @Published var messageEndpoint = ""

    /// The core's settings as Settings shows them: the last ones the core
    /// reported, with every change still on its way written over them.
    @Published private(set) var settings: SettingsValues?
    /// The settings as the core last reported them.
    private var confirmedSettings: SettingsValues? { didSet { settings = shownSettings } }
    /// Changes sent and not yet answered, oldest first, each under the
    /// token its answer carries.
    private var pendingSettings: [(token: UInt64, change: SettingsChange)] = [] { didSet { settings = shownSettings } }
    private var settingsWriteToken: UInt64 = 0
    /// Why the last change to a setting failed, by its JSON key, until the
    /// setting is changed again.
    @Published private(set) var settingErrors: [String: String] = [:]
    /// Counts the core's Settings invalidations, so rows that read their own
    /// status (Agent Relay tools) read it again, as Linux does.
    @Published private(set) var settingsInvalidations = 0
    /// Why the first-run default could not be applied; Settings shows it.
    @Published private(set) var inboundDefaultError: String?
    @Published var launchAtLogin = false
    @Published private(set) var loginItemNeedsApproval = false
    /// Quitting leaves the core running unless the person turned this off;
    /// then quitting unregisters its LaunchAgent until the app opens again.
    @Published private(set) var keepsAgentsConnectedAfterQuit: Bool

    let relay: RelayModel
    let chat: ChatModel
    let contractors: ContractorsModel
    let incoming: IncomingModel
    let claudeDelivery: ClaudeDeliveryModel

    static let sessionPage = 500
    /// The core binary the LaunchAgent was last registered with.
    static let registeredCoreKey = "registeredCoreBinary"
    static let keepsAgentsConnectedKey = "keepAgentsConnectedAfterQuit"

    // MARK: Private state

    @Published private(set) var requestEntries: [RequestEntry] = []
    @Published private(set) var requestFailure: RequestEntry?
    @Published var selectedRequest: RequestEntry?
    @Published private(set) var requestLogError: String?
    private var seenRequestFailures: Set<String> = []
    private var readingRequests = false
    @Published private(set) var relaycastUpgrade: RelaycastUpgrade.Reason?
    var showRelaycastUpgrade: Bool { relaycastUpgrade != nil }
    private var lastRelaycastUpgradeAt: Date?
    private var requestIdentityRevision: UInt64 = 0
    private var requestIdentityStartedAtMs: Int = 0

    func dismissRelaycastUpgrade() { relaycastUpgrade = nil }

    func openRelaycastBilling() {
        guard let url = RelaycastUpgrade.billingURL(siteURL: siteURL, reason: relaycastUpgrade ?? .planLimit) else { return }
        NSWorkspace.shared.open(url)
        dismissRelaycastUpgrade()
    }

    /// Copies the setup prompt and opens Capy, where a thread runs the setup.
    func setUpCapy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(CapySetup.prompt, forType: .string)
        NSWorkspace.shared.open(CapySetup.url)
        capyPromptCopied = true
    }

    /// Not now: hides the Capy card for good.
    func dismissCapySetup() {
        defaults.set(true, forKey: CapySetup.dismissedKey)
        showsCapySetup = false
    }

    /// Turn On on the Devin card: adds the hooks. The card goes once the
    /// core reports them on; a failure shows the core's sentence under it.
    func turnOnDevin() async {
        devinSetupError = await setSetting(SettingsChange(devinDirectDelivery: true))
    }

    /// Not now: hides the Devin card for good.
    func dismissDevinSetup() {
        defaults.set(true, forKey: DevinSetup.dismissedKey)
        devinSetupDismissed = true
    }

    func refreshRequestLog() async {
        guard !readingRequests else { return }
        let identityRevision = requestIdentityRevision
        readingRequests = true
        defer { readingRequests = false }
        do {
            let result = try await client.diagnosticsRequests()
            if requestEntries != result.entries { requestEntries = result.entries }
            if requestLogError != nil { requestLogError = nil }
            let failed = result.entries.filter(\.failed)
            let now = Date()
            let recent = failed.filter {
                $0.startedAtMs >= requestIdentityStartedAtMs &&
                abs(now.timeIntervalSince1970 - Double($0.startedAtMs) / 1000) < 300
            }
            if identityRevision == requestIdentityRevision,
               let reason = RelaycastUpgrade.reason(for: recent, plan: core?.workspace.workspacePlan,
                                                    unseen: { !seenRequestFailures.contains($0.id) }),
               lastRelaycastUpgradeAt.map({ now.timeIntervalSince($0) >= 900 }) ?? true {
                relaycastUpgrade = reason
                lastRelaycastUpgradeAt = now
            }
            if let newest = failed.first(where: { !seenRequestFailures.contains($0.id) }) {
                requestFailure = newest
            }
            seenRequestFailures.formUnion(failed.map(\.id))
            if seenRequestFailures.count > 1000 { seenRequestFailures = Set(failed.map(\.id)) }
        } catch {
            requestLogError = "Request log unavailable. The background service may need to be updated or restarted."
        }
    }

    func openFailedRequest() {
        guard let entry = requestFailure else { return }
        selectedRequest = entry
        requestFailure = nil
        page = .settings(.diagnostics)
    }

    let client: CoreClient
    private let service: CoreService
    /// The core version this bundle carries; a running core of another
    /// version is asked to stop so launchd starts this one.
    private let bundledCoreVersion: String?
    /// How long launchd takes to stop an unregistered core (its exit timeout is 5 s).
    private let unregisterSettle: UInt64
    /// Restart once per version, not per pid: bad bundle metadata must not
    /// kill every replacement of an otherwise bridge-compatible core.
    private var restartedCoreVersions: Set<String> = []
    /// Cores asked to stop, by pid. One serves until it exits, so a
    /// connection to it waits for launchd's replacement instead.
    private var retiredCorePIDs: Set<Int> = []
    /// Registrations made again for a core launchd refuses.
    private var refusalRepairs = 0
    static let refusalRepairLimit = 8
    private let configuredSite: String
    private let manageSystemServices: Bool
    private let defaults: UserDefaults
    private var connectTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var initialRefreshTask: Task<Void, Never>?
    private var startupWatchdog: Task<Void, Never>?
    private let startupTimeout: UInt64
    private var openedLink: String?
    private var openWindowAction: ((String) -> Void)?
    private var wantsMainWindow = false
    private var windowOpen = false
    private var panelOpen = false
    private var hasBootstrapped = false
    private var migratedSettings = false
    /// Bumped whenever the uploader's connection changes, so answers to
    /// requests made before are dropped.
    private var connectionRevision = 0
    /// The reads a new connection makes, one after another. A sign-out
    /// between them ends it, so no read starts for the signed-out account.
    private(set) var connectionRefresh: Task<Void, Never>?
    private var previousPhase: Phase = .launching
    /// A workspace connection is running; its browser approval does not
    /// sign anyone out.
    var connectingWorkspace = false
    /// A sign-in renewing the session the core calls Cloud with while this
    /// Mac stays connected; its browser approval does not sign anyone out.
    @Published private(set) var renewingSignIn = false {
        didSet { relay.objectWillChange.send() }
    }

    init(client: CoreClient = CoreClient(socketPath: AppInfo.coreSocket),
         service: CoreService = LaunchAgentService(),
         bundledCoreVersion: String? = AppInfo.bundledCoreVersion,
         unregisterSettle: UInt64 = 6_000_000_000,
         startupTimeout: UInt64 = 20_000_000_000,
         siteURL: String = AppInfo.defaultSiteURL,
         manageSystemServices: Bool = true,
         defaults: UserDefaults = .standard,
         capyInstalled: Bool = false) {
        self.client = client
        self.service = service
        self.bundledCoreVersion = bundledCoreVersion
        self.unregisterSettle = unregisterSettle
        self.startupTimeout = startupTimeout
        configuredSite = siteURL
        self.manageSystemServices = manageSystemServices
        self.defaults = defaults
        self.keepsAgentsConnectedAfterQuit = defaults.object(forKey: Self.keepsAgentsConnectedKey) as? Bool ?? true
        self.sessionColumns = SessionColumnLayout(data: defaults.data(forKey: SessionColumnLayout.preferenceKey))
        self.hiddenSessionIDs = Set((defaults.stringArray(forKey: "hiddenSessions.v1") ?? []).map(LocalSessionRow.currentHiddenID))
        self.showHiddenSessions = defaults.bool(forKey: "showHiddenSessions.v1")
        self.showsCapySetup = CapySetup.shows(installed: capyInstalled,
                                              dismissed: defaults.bool(forKey: CapySetup.dismissedKey))
        self.devinSetupDismissed = defaults.bool(forKey: DevinSetup.dismissedKey)
        relay = RelayModel(client: client, defaults: defaults)
        chat = ChatModel(client: client)
        contractors = ContractorsModel(client: client)
        incoming = IncomingModel(client: client)
        claudeDelivery = ClaudeDeliveryModel(client: client)
        relay.model = self
        chat.model = self
        savedSessionViews = SavedSessionViews(data: defaults.data(forKey: SavedSessionViews.preferenceKey))
        if let view = savedSessionViews.defaultView { applySessionView(view) }
    }

    // MARK: Derived state

    var account: AccountStatus { core?.account ?? .signedOut }

    var phase: Phase {
        guard let core else { return .launching }
        let account = core.account
        switch account.state {
        case .signedIn: return .attached
        case .preparing:
            return account.phase == "preparing_local_sessions" ? .preparingSessions : .signingIn
        case .pendingApproval:
            return (connectingWorkspace || renewingSignIn) && previousPhase == .attached ? .attached : .waitingForBrowser
        case .signedOut, .denied, .expired, .error:
            return .signedOut
        }
    }

    var accountID: String? { account.person?.id }
    var accountEmail: String? { account.person?.email }
    var accountName: String? { account.person?.name }
    var hasMultipleWorkspaces: Bool { (account.workspaceCount ?? 0) > 1 }
    var workspaceAvatarURL: String? { account.workspaceAvatarUrl }
    var accountAvatarURL: String? { account.person?.avatarUrl }
    var workspaceID: String? { account.workspaceId }
    var workspaceName: String {
        if let name = account.workspaceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return "Workspace"
    }
    var siteURL: String { account.siteUrl ?? configuredSite }
    var installDirectory: String? { status?.directory }
    var captureProgress: CaptureProgress? { account.progress }
    var coreVersion: String? { core?.daemon.version }
    var bridgeVersion: Int? { core?.daemon.bridgeVersion }
    /// Paused as the person last asked, else as the uploader reports.
    var isPaused: Bool { pausedWanted.shown(status?.paused == true) }
    var canLogOut: Bool { (phase == .attached || phase == .preparingSessions) && !signingOut }
    var analyticsEnabled: Bool { settings?.analyticsEnabled ?? true }
    /// The upload policy as the person last chose it, else as the uploader
    /// reports it.
    var sharingMode: SharingMode { sharingModeWanted.shown(status?.sharingMode ?? .selected) }
    var isChangingSharingMode: Bool { sharingModeWanted.isPending }
    var isSessionTableReadOnly: Bool { sharingMode == .all || phase != .attached }
    var isShowingSessionPreview: Bool { phase == .preparingSessions || !previewSessionIDs.isEmpty }

    var isPreparingSessionList: Bool {
        phase == .preparingSessions || captureProgress?.isCapturing == true || !previewSessionIDs.isEmpty
            || (lastSessionsRefresh == nil && isLoadingSessions)
    }

    var statusViewModel: StatusViewModel? { status.map(StatusViewModel.init(status:)) }

    var sessionUploadSummary: SessionUploadSummary? {
        statusViewModel.map { SessionUploadSummary(status: $0, sessions: sessions, requesting: requestingUploads) }
    }

    var filteredSessions: [UploadSession] {
        SessionFilter.filter(sessions, query: sessionSearch).filter { sessionUploadFilter.matches(uploadState(for: $0)) }
    }

    func uploadState(for session: UploadSession) -> SessionUploadState {
        if previewSessionIDs.contains(session.id) { return .discovering }
        if requestingUploads.contains(session.id) { return .preparing }
        return SessionUploadState(session: session, status: status)
    }

    func sessionCount(for filter: SessionUploadFilter) -> Int {
        sessions.filter { filter.matches(uploadState(for: $0)) }.count
    }

    func canSelectSession(_ row: UploadSession) -> Bool {
        !isSessionTableReadOnly && !previewSessionIDs.contains(row.id)
    }

    // MARK: Window plumbing

    /// SwiftUI hands the app its `openWindow` action from a live view.
    func registerOpenWindow(_ action: @escaping (String) -> Void) {
        openWindowAction = action
        if wantsMainWindow { showMainWindow() }
    }

    func showSettingsWindow(_ pane: SettingsPane = .general) {
        record(.settings, .started)
        agentsSheet = nil
        page = .settings(pane)
        showMainWindow()
    }

    func showMainWindow() {
        guard manageSystemServices else { openWindowAction?(AppInfo.mainWindowID); return }
        NSApp.activate(ignoringOtherApps: true)
        if let openWindowAction {
            wantsMainWindow = false
            openWindowAction(AppInfo.mainWindowID)
            return
        }
        wantsMainWindow = true
        for window in NSApp.windows where window.identifier?.rawValue.contains(AppInfo.mainWindowID) == true {
            wantsMainWindow = false
            window.makeKeyAndOrderFront(nil)
            return
        }
    }

    func showSessionUploads() {
        agentsSheet = nil
        page = .sessions
        showMainWindow()
    }

    /// Uploaded sessions open in Cloud; others open their row in Session Uploads.
    func openSession(_ session: UploadSession) {
        if let url = SessionNavigation.cloudURL(siteURL: siteURL, session: session) {
            NSWorkspace.shared.open(url)
            return
        }
        sessionUploadFilter = .all
        sessionSearch = session.sessionId
        showSessionUploads()
    }

    func panelDidAppear() {
        panelOpen = true
        Task { await refreshVisibleState() }
    }

    func panelDidDisappear() { panelOpen = false }

    func windowVisibilityChanged(_ visible: Bool) { windowOpen = visible }

    func quit() { NSApp.terminate(nil) }

    // MARK: Launch

    /// Moves what earlier builds kept, registers the core's LaunchAgent and
    /// connects to it.
    func bootstrapIfNeeded() async {
        if hasBootstrapped { return }
        hasBootstrapped = true
        if manageSystemServices {
            LoginItem.removeIfUnavailable()
            launchAtLogin = LoginItem.isEnabled
            loginItemNeedsApproval = LoginItem.needsApproval
            if !AppInfo.isDevelopment {
                do {
                    try LegacyMigration.moveConversations(
                        from: LegacyMigration.legacyConversations(supportDirectory: AppInfo.applicationSupport),
                        to: AppInfo.dataDirectory.appendingPathComponent("Conversations")
                    )
                } catch {
                    Self.logger.error("could not move Skip conversations: \(error.localizedDescription, privacy: .public)")
                }
            }
            requestNotificationPermission()
        }
        watchStartup()
        await ensureService()
        // A copy opened from a DMG must not attach to the installed core:
        // version reconciliation could stop that core even without registering.
        guard service.installationProblem == nil else {
            startupWatchdog?.cancel()
            return
        }
        connectTask = Task { [weak self] in await self?.connectLoop() }
        pollTask = Task { [weak self] in await self?.pollLoop() }
    }

    /// Quitting the app leaves the core running, launchd's, unless the
    /// person chose otherwise: then the core stops until the app opens again.
    func shutdown() {
        if !keepsAgentsConnectedAfterQuit {
            // Before restoring a pending registration, which `stopping` skips.
            stopBackgroundService()
        }
        isCoreConnected = false
        connectTask?.cancel()
        initialRefreshTask?.cancel()
        startupWatchdog?.cancel()
        pollTask?.cancel()
        client.reset()
        // applicationWillTerminate is synchronous: finish a pending registration
        // now rather than relying on the cancelled repair task to resume.
        do {
            try finishCoreRegistration()
        } catch {
            Self.logger.error("could not restore the core before quitting: \(error.localizedDescription, privacy: .public)")
        }
    }

    private var coreRegistrationPending = false

    private func reregisterCore() async throws {
        try service.unregister()
        coreRegistrationPending = true
        try? await Task.sleep(nanoseconds: unregisterSettle)
        // Cancellation ends the wait, but must not leave launchd unregistered.
        try finishCoreRegistration()
    }

    private func finishCoreRegistration() throws {
        guard coreRegistrationPending else { return }
        coreRegistrationPending = false
        guard !stopping else { return }
        try service.register()
        defaults.set(service.binaryIdentity, forKey: Self.registeredCoreKey)
    }

    /// Registers the core's LaunchAgent when it is not registered, and says
    /// when macOS waits for the person to allow it.
    func ensureService() async {
        guard !stopping, !Task.isCancelled, !coreRegistrationPending else { return }
        if let installationProblem = service.installationProblem {
            coreNeedsApproval = false
            coreProblem = installationProblem
            return
        }
        let identity = service.binaryIdentity
        do {
            switch service.status {
            case .notRegistered:
                try service.register()
                defaults.set(identity, forKey: Self.registeredCoreKey)
            case .enabled where identity != nil && defaults.string(forKey: Self.registeredCoreKey) != identity:
                // launchd admits only the binary the agent was registered
                // with. The old core must have stopped before the new
                // registration, or launchd keeps the old one's record.
                try await reregisterCore()
            case .enabled, .requiresApproval, .notFound:
                break
            }
        } catch {
            Self.logger.error("could not register the core: \(error.localizedDescription, privacy: .public)")
            coreProblem = "The background service could not start. Try again, or check Agent Relay in System Settings › General › Login Items."
        }
        coreNeedsApproval = service.status == .requiresApproval
        if coreNeedsApproval {
            coreProblem = "Allow Agent Relay in System Settings › General › Login Items so it can keep your agents connected."
        } else if service.status == .notFound {
            coreProblem = "This build has no background service installed. Open a complete Agent Relay app, or start the core manually when developing with Swift."
        }
    }

    /// launchd admits the core against a code requirement Background Task
    /// Management records for the agent. A Developer ID or Apple Development
    /// signature names a team, which an update keeps. An ad-hoc signature
    /// has none, so the requirement pins the replaced binary's hash and launchd
    /// refuses the new core ("Launch Constraint Violation"). BTM keeps the
    /// old requirement for a while after the bundle changes; a registration
    /// made once it lets go records the new hash. So while an enabled core
    /// does not answer, it is registered again, a bounded number of times.
    private func recoverBrokenBundleProgram() throws -> Bool {
        let recovered = try service.recoverSpawnFailure()
        coreNeedsApproval = service.status == .requiresApproval
        if coreNeedsApproval {
            coreProblem = "Allow Agent Relay in System Settings › General › Login Items so it can keep your agents connected."
        }
        guard recovered else { return false }
        Self.logger.notice("using an absolute-path LaunchAgent after macOS lost the core bundle path")
        defaults.set(service.binaryIdentity, forKey: Self.registeredCoreKey)
        return true
    }

    private func recoverRefusedCore() async {
        guard !isRecoveringCore, !stopping else { return }
        isRecoveringCore = true
        defer { isRecoveringCore = false }
        await ensureService()
        guard !stopping, !Task.isCancelled, service.installationProblem == nil,
              service.status == .enabled,
              refusalRepairs < Self.refusalRepairLimit else { return }
        refusalRepairs += 1
        Self.logger.notice("registering the core again: it does not answer")
        do {
            if try recoverBrokenBundleProgram() { return }
            try await reregisterCore()
        } catch {
            Self.logger.error("could not register the core: \(error.localizedDescription, privacy: .public)")
            if (error as NSError).domain == "com.agentrelay.desktop.launch-agent" {
                coreProblem = "macOS could not start Agent Relay’s backup background service. Try again, or check the app’s log for details."
            } else {
                coreProblem = "The background service could not restart. Check Agent Relay in System Settings › General › Login Items, then try again."
            }
        }
        coreNeedsApproval = service.status == .requiresApproval
        if coreNeedsApproval {
            coreProblem = "Allow Agent Relay in System Settings › General › Login Items so it can keep your agents connected."
        }
    }

    private func watchStartup() {
        startupWatchdog?.cancel()
        startupWatchdog = Task { [weak self, startupTimeout] in
            do { try await Task.sleep(nanoseconds: startupTimeout) } catch { return }
            guard let self, !isCoreConnected, coreProblem == nil else { return }
            coreProblem = StartupPresentation.timeoutMessage
        }
    }

    /// Explicit recovery also works after the automatic repair budget is used.
    func retryBackgroundService() async {
        guard !isRecoveringCore, !stopping else { return }
        refusalRepairs = 0
        coreProblem = nil
        watchStartup()
        await recoverRefusedCore()
    }

    func openLoginItemsSettings() { service.openSystemSettings() }

    var backgroundServiceStatus: CoreServiceStatus { service.status }
    var coreNeedsInstallation: Bool { service.installationProblem != nil }

    func stopBackgroundService() {
        guard service.installationProblem == nil else { return }
        stopping = true
        connectTask?.cancel()
        initialRefreshTask?.cancel()
        startupWatchdog?.cancel()
        pollTask?.cancel()
        client.reset()
        do {
            try service.unregister()
        } catch {
            Self.logger.error("could not stop the core: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The person stopped the core; nothing registers it again this launch.
    private var stopping = false

    private func connectLoop() async {
        var attempts = 0
        while !Task.isCancelled {
            do {
                let (hello, events) = try await client.subscribe(topics: [.status, .activity, .invalidated, .notify, .signIn])
                if retiredCorePIDs.contains(hello.pid) {
                    throw CoreError.unreachable("The background service is restarting.")
                }
                if let bundled = bundledCoreVersion, hello.daemonVersion != bundled,
                   restartedCoreVersions.insert(hello.daemonVersion).inserted {
                    // An app update replaced the binary under a running core.
                    Self.logger.notice("restarting a core of another version")
                    retiredCorePIDs.insert(hello.pid)
                    client.reset()
                    await client.shutdownDaemon()
                    continue
                }
                attempts = 0
                refusalRepairs = 0
                coreProblem = nil
                coreNeedsApproval = false
                isCoreConnected = true
                // Reads interrupted by the previous core may have surfaced a
                // temporary transport error. The new snapshot and refreshes
                // replace their results; keep action errors, whose outcome is
                // uncertain until the person checks it.
                if lastError == CoreError.reconnecting.message || lastError == CoreError.closed.message {
                    lastError = nil
                }
                if sessionsError == CoreError.reconnecting.message || sessionsError == CoreError.closed.message {
                    sessionsError = nil
                }
                if previewError == CoreError.reconnecting.message || previewError == CoreError.closed.message {
                    previewError = nil
                }
                startupWatchdog?.cancel()
                // subscribe queues the initial snapshot before returning.
                // Apply it before any settings or session discovery work.
                var iterator = events.makeAsyncIterator()
                guard let first = await iterator.next() else { throw CoreError.closed }
                let wasAttached = phase == .attached
                handle(first)
                if wasAttached { relay.connectionRecovered() }
                // Entering an account starts its own guarded refresh in apply.
                let refreshAccount = wasAttached || phase != .attached
                initialRefreshTask?.cancel()
                initialRefreshTask = Task { await connected(refreshAccount: refreshAccount) }
                while let event = await iterator.next() { handle(event) }
                initialRefreshTask?.cancel()
                Self.logger.notice("the core connection closed")
            } catch let error as CoreError where error.kind == "bridge_version_mismatch" {
                Self.logger.notice("stopping a core of another bridge version")
                await client.shutdownDaemon()
            } catch {
                attempts += 1
                var recoveredBrokenBundle = false
                // A broken BTM bundle path is already visible in launchd's
                // first failed spawn. Repair it before the normal 15-attempt
                // re-registration cycle or startup timeout.
                if attempts <= 6 && service.installationProblem == nil {
                    do {
                        if try recoverBrokenBundleProgram() {
                            attempts = 0
                            recoveredBrokenBundle = true
                        }
                    } catch {
                        Self.logger.error("could not start the backup core: \(error.localizedDescription, privacy: .public)")
                        coreProblem = "macOS could not start Agent Relay’s backup background service. Try again, or check the app’s log for details."
                    }
                }
                if !recoveredBrokenBundle && attempts % 15 == 0 {
                    await recoverRefusedCore()
                }
                if attempts >= 15 && !coreNeedsApproval && coreProblem == nil {
                    coreProblem = "Agent Relay could not connect to its background service. Try restarting the service to continue to sign-in."
                }
            }
            if isCoreConnected {
                // Answers from the retired core must not put its errors or
                // stale data back into the freshly connected account view.
                connectionRevision += 1
                connectionRefresh?.cancel()
                isWorking = false
                workDescription = nil
                sharingModeWanted.clear()
                pausedWanted.clear()
                pendingUploadAction = nil
                pendingSettings = []
                startingSignIn = false
                relay.connectionInterrupted()
                incoming.connectionInterrupted()
                claudeDelivery.connectionInterrupted()
                contractors.connectionInterrupted()
                chat.connectionInterrupted()
            }
            isCoreConnected = false
            initialRefreshTask?.cancel()
            client.reset()
            // launchd may still be starting the core: back off to 2 s.
            try? await Task.sleep(nanoseconds: UInt64(min(2.0, 0.1 * pow(1.5, Double(attempts))) * 1_000_000_000))
        }
    }

    /// Everything a fresh connection needs: settings, the one-time
    /// settings migration, and every collection shown.
    private func connected(refreshAccount: Bool) async {
        await loadSettings()
        guard !Task.isCancelled else { return }
        if !migratedSettings {
            await migrateSettings()
        }
        if !hasRecordedLaunch {
            hasRecordedLaunch = true
            record(.appLaunch, .started)
        }
        guard !Task.isCancelled else { return }
        await refreshAll(includeAccount: refreshAccount)
    }

    private var hasRecordedLaunch = false

    /// Opt-outs and flags earlier builds kept in UserDefaults reach the core
    /// once; the old keys are then forgotten.
    private func migrateSettings() async {
        if let pending = LegacyMigration.settings(in: defaults) {
            do {
                confirmedSettings = try await client.settingsSet(pending)
            } catch {
                Self.logger.error("could not carry settings over to the core")
                return
            }
        }
        LegacyMigration.forgetDefaults(in: defaults)
        migratedSettings = true
    }

    private func refreshAll(includeAccount: Bool = true) async {
        async let uploader: Void = includeAccount ? refreshUploader() : ()
        async let relay: Void = self.relay.refreshAll()
        async let incoming: Void = includeAccount ? self.incoming.refresh() : ()
        async let claudeDelivery: Void = self.claudeDelivery.refresh()
        async let chat: Void = includeAccount ? self.chat.refresh() : ()
        async let contractors: Void = includeAccount ? self.contractors.load() : ()
        _ = await (uploader, relay, incoming, claudeDelivery, chat, contractors)
    }

    // MARK: Events

    func handle(_ event: CoreEvent) {
        switch event {
        case .status(let snapshot):
            guard snapshot.revision > (core?.revision ?? 0) || snapshot.daemon.pid != core?.daemon.pid else { return }
            apply(snapshot)
        case .signIn(let state):
            signInLink = state.link
            openSignInLinkIfNew(state.link)
        case .invalidated(let invalidation):
            invalidated(invalidation.what)
        case .notify(let notification):
            show(notification)
        case .activity(let line):
            Self.logger.info("core: \(line.message, privacy: .public)")
        case .shutdown:
            break
        }
    }

    private func apply(_ snapshot: Status) {
        let first = core == nil
        defer {
            if first {
                let links = pendingLinks
                pendingLinks = []
                links.forEach(openConnection)
            }
        }
        let before = phase
        let beforeAccount = core?.account
        core = snapshot
        let after = phase
        if beforeAccount?.workspaceId != snapshot.account.workspaceId || beforeAccount?.person?.id != snapshot.account.person?.id || (snapshot.account.state == .signedOut && beforeAccount?.state != .signedOut) {
            relaycastUpgrade = nil
            lastRelaycastUpgradeAt = nil
            requestIdentityRevision &+= 1
            requestIdentityStartedAtMs = Int(Date().timeIntervalSince1970 * 1000)
        }
        previousPhase = after
        if snapshot.account.state.isFailure {
            signInError = snapshot.account.error
        } else if snapshot.account.state != .signedOut {
            signInError = nil
        }
        if snapshot.account.state != .pendingApproval {
            signInLink = nil
            openedLink = nil
        }
        // The snapshot shows where the attempt stands; its state guards
        // from here.
        if startingSignIn && after != .signedOut { startingSignIn = false }
        if signingOut && after == .signedOut { signingOut = false }
        if renewingSignIn && beforeAccount?.state == .pendingApproval && snapshot.account.state != .pendingApproval {
            renewingSignIn = false
            relay.signInRenewed()
        }
        if after == .preparingSessions && before != .preparingSessions {
            sessionPreparationStarted = Date()
            Task { await refreshSessionPreview() }
        }
        if (before == .signingIn || before == .waitingForBrowser) && (after == .preparingSessions || after == .attached) {
            page = .sessions
            showMainWindow()
        }
        if after == .attached && before != .attached {
            connectionRevision += 1
            let revision = connectionRevision
            connectionRefresh = Task {
                await refreshUploader()
                guard revision == connectionRevision else { return }
                await chat.refresh()
                guard revision == connectionRevision else { return }
                await contractors.refresh()
                guard revision == connectionRevision else { return }
                await incoming.refresh()
            }
        }
        if after == .signedOut && before != .signedOut && before != .launching {
            resetUploader()
            chat.reset()
            contractors.reset()
            incoming.reset()
            showMainWindow()
        }
        if beforeAccount?.workspaceId != snapshot.account.workspaceId || beforeAccount?.person?.id != snapshot.account.person?.id {
            relay.accountChanged()
            if beforeAccount != nil {
                incoming.reset()
                Task { await incoming.refresh() }
                contractors.reset()
                // Team access belongs to a signed-in account: signed out,
                // there is nothing to load and no section to show it in.
                if after == .attached || after == .preparingSessions {
                    Task { await contractors.load() }
                }
            }
        }
    }

    private func invalidated(_ what: Listing) {
        switch what {
        case .uploader: Task { await refreshUploader() }
        case .chat, .projects: Task { await chat.refresh() }
        case .incoming: Task { await incoming.refresh() }
        // An agent changed a setting (`PATCH /settings`).
        case .settings:
            settingsInvalidations += 1
            Task { await loadSettings() }
        case .activity:
            Task {
                await relay.invalidated(what)
                await claudeDelivery.refresh()
            }
        default: Task { await relay.invalidated(what) }
        }
    }

    private func openSignInLinkIfNew(_ link: String?) {
        guard let link, link != openedLink, let url = URL(string: link) else { return }
        openedLink = link
        guard manageSystemServices else { return }
        if !NSWorkspace.shared.open(url) {
            record(.browserApproval, .failed, failure: .browserOpen)
        }
    }

    // MARK: Notifications

    private var notificationsAvailable: Bool { manageSystemServices && Bundle.main.bundleIdentifier != nil }

    private func requestNotificationPermission() {
        guard notificationsAvailable else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func show(_ notification: CoreNotification) {
        guard notificationsAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        if let link = notification.link { content.userInfo = ["link": link] }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: Polling

    /// The uploader's status every 5 s while a window or the panel is open,
    /// every 30 s otherwise. Everything else arrives as events.
    private func pollLoop() async {
        while !Task.isCancelled {
            let visible = windowOpen || panelOpen
            try? await Task.sleep(nanoseconds: visible ? 5_000_000_000 : 30_000_000_000)
            guard core != nil else { continue }
            await refreshVisibleState()
        }
    }

    func showLocalSessions(search: String? = nil) {
        if let search { sessionSearch = search }
        selectedLocalSession = nil
        page = .sessions
    }

    func refreshVisibleState() async {
        if phase == .preparingSessions {
            await refreshSessionPreview()
            return
        }
        async let status: Void = refreshStatus()
        if windowOpen || panelOpen { await refreshSessions() }
        await status
    }

    // MARK: Uploader

    private func resetUploader() {
        connectionRevision += 1
        status = nil
        sessions = []
        previewSessionIDs = []
        previewError = nil
        sessionPreparationStarted = nil
        lastSessionsRefresh = nil
        sessionsError = nil
        sessionActionError = nil
        uploadActionError = nil
        requestingUploads = []
        stoppingUploads = []
        sharingModeWanted.clear()
        pausedWanted.clear()
        pendingUploadAction = nil
        uploadErrors = [:]
        uploadTasks.values.forEach { $0.cancel() }
        uploadTasks = [:]
        sessionLimit = Self.sessionPage
        selectedLocalSession = nil
        showsSessionSearch = false
        sessionSearch = ""
        sessionUploadFilter = .all
        agentScope = .all
        teamPerson = nil
        agentSearch = ""
        agentsSheet = nil
        isWorking = false
        workDescription = nil
    }

    private func refreshUploader() async {
        async let status: Void = refreshStatus()
        async let sessions: Void = refreshSessions()
        _ = await (status, sessions)
    }

    func refreshStatus() async {
        guard phase == .attached || phase == .preparingSessions else { return }
        let revision = connectionRevision
        do {
            let response = try await client.uploaderStatus()
            guard revision == connectionRevision else { return }
            if status != response { status = response }
            if lastError != nil { lastError = nil }
        } catch let error as CoreError where error.kind == ErrorKind.notSignedIn.rawValue {
            guard revision == connectionRevision else { return }
            if status != nil { status = nil }
        } catch {
            guard revision == connectionRevision else { return }
            if lastError != error.localizedDescription { lastError = error.localizedDescription }
        }
    }

    /// Bumped by every change to which sessions upload: a listing read
    /// before one is stale and is read again.
    private var selectionRevision = 0
    private var sessionsReadAgain = false

    func refreshSessions() async {
        guard phase == .attached else { return }
        guard !isLoadingSessions else {
            sessionsReadAgain = true
            return
        }
        let revision = connectionRevision
        let selection = selectionRevision
        let titleRevision = relay.titleWriteRevision
        isLoadingSessions = true
        defer {
            isLoadingSessions = false
            if sessionsReadAgain {
                sessionsReadAgain = false
                Task { await refreshSessions() }
            }
        }
        do {
            let response = try await client.uploaderSessionsList(LimitParams(limit: sessionLimit))
            guard revision == connectionRevision else { return }
            guard selection == selectionRevision, titleRevision == relay.titleWriteRevision else {
                sessionsReadAgain = true
                return
            }
            if sessions != response.sessions { sessions = response.sessions }
            relay.reconcileTitleEdits()
            reconcileHiddenSessions()
            if !previewSessionIDs.isEmpty { previewSessionIDs = [] }
            if sessionPreparationStarted != nil { sessionPreparationStarted = nil }
            lastSessionsRefresh = Date()
            if sessionsError != nil { sessionsError = nil }
        } catch {
            guard revision == connectionRevision else { return }
            if sessionsError != error.localizedDescription { sessionsError = error.localizedDescription }
        }
    }

    /// Titles found on this Mac while history prepares, before the uploader
    /// can list them.
    private func refreshSessionPreview() async {
        guard phase == .preparingSessions, lastSessionsRefresh == nil, !isLoadingPreview else { return }
        let revision = connectionRevision
        let titleRevision = relay.titleWriteRevision
        isLoadingPreview = true
        defer { isLoadingPreview = false }
        let response: UploadPreview
        do {
            response = try await client.uploaderSessionsPreview(PreviewParams(refresh: true))
        } catch {
            if revision == connectionRevision { previewError = error.localizedDescription }
            return
        }
        guard revision == connectionRevision, titleRevision == relay.titleWriteRevision, lastSessionsRefresh == nil else { return }
        previewError = nil
        guard !response.sessions.isEmpty else { return }
        sessions = response.sessions
        previewSessionIDs = Set(response.sessions.map(\.id))
    }

    var canLoadMoreSessions: Bool {
        phase == .attached && !isLoadingSessions && previewSessionIDs.isEmpty
            && sessions.count >= sessionLimit
    }

    func loadMoreSessions() async {
        guard canLoadMoreSessions else { return }
        sessionLimit += Self.sessionPage
        await refreshSessions()
    }

    /// Runs one uploader action at a time; refuses, rather than skips
    /// silently, when it cannot run now.
    private func perform(_ description: String, _ work: () async throws -> Void) async -> Error? {
        guard phase == .attached else {
            return CoreError(kind: ErrorKind.notSignedIn.rawValue, message: "Sign in to Agent Relay to upload sessions.")
        }
        guard !isWorking else {
            return CoreError(kind: "busy", message: "Another upload change is still running. Try again in a moment.", retryable: true)
        }
        let revision = connectionRevision
        isWorking = true
        workDescription = description
        defer {
            if revision == connectionRevision {
                isWorking = false
                workDescription = nil
            }
        }
        do {
            try await work()
            return nil
        } catch {
            return error
        }
    }

    /// The button stays usable while a change runs: a later click asks for
    /// the newer state, and the last one asked for wins.
    var canTogglePause: Bool { phase == .attached && status != nil }

    /// Pauses or resumes at once; the uploader is asked until it reports the
    /// state last asked for, and the latest request's failure reverts it.
    func setPaused(_ paused: Bool) async {
        guard paused != isPaused else { return }
        pausedWanted.begin(paused)
        guard !drivingPause else { return }
        drivingPause = true
        defer { drivingPause = false }
        let revision = connectionRevision
        // Each request is sent once; the loop goes on only for a newer one.
        while let wanted = pausedWanted.wanted {
            let token = pausedWanted.token
            let failure = await perform(wanted ? "Pausing uploads and messages…" : "Resuming uploads and messages…") {
                if wanted { try await client.uploaderPause() } else { try await client.uploaderResume() }
                await refreshStatus()
                await incoming.refresh()
            }
            guard revision == connectionRevision else { return }
            if let failure {
                // A later click still gets its turn; the final choice's
                // failure falls back to the state the uploader reports.
                if pausedWanted.finish(token) { lastError = failure.localizedDescription }
            } else {
                pausedWanted.finish(token)
            }
        }
    }

    /// Retries uploads a problem stopped; queued records are kept. The stage
    /// shows the retry under way until the uploader's status says more.
    func retryUploads() async {
        await runUploadAction(.retry, "Retrying uploads…") { try await client.uploaderRetry() }
    }

    private func runUploadAction(_ action: UploadStage.Action, _ description: String, _ work: () async throws -> Void) async {
        guard pendingUploadAction == nil else { return }
        uploadActionError = nil
        pendingUploadAction = action
        let revision = connectionRevision
        let failure = await perform(description) {
            try await work()
            await refreshStatus()
        }
        guard revision == connectionRevision else { return }
        pendingUploadAction = nil
        if let failure { uploadActionError = failure.localizedDescription }
    }

    /// Asks Agent Relay Cloud again to record this computer's spawn node as
    /// the person's (`spawn.claim.retry`); the status shows the answer.
    func retrySpawnClaim() async {
        do {
            try await client.spawnClaimRetry()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Removes consumed records from a full upload journal.
    func compactJournal() async {
        await runUploadAction(.compact, "Compacting the upload journal…") { try await client.uploaderCompact() }
    }

    @discardableResult
    func includeSessions(keys: [String]) async -> Bool {
        await changeSessionUploads(keys: keys.filter { !hiddenSessionIDs.contains($0) }, included: true)
    }

    /// Reconcile persisted hidden sessions when fresh core state arrives,
    /// including sessions discovered by the uploader after they were hidden.
    func reconcileHiddenSessions() {
        let sharing = Set(sessions.filter(\.included).map(\.id))
            .union(relay.sessions.filter { $0.registration != nil }.map { $0.target.uploadKey ?? $0.id })
        let keys = hiddenSessionIDs.intersection(sharing).subtracting(hidingSessionIDs)
        guard !keys.isEmpty else { return }
        Task { await setSessionsHidden(keys: keys.filter { hiddenSessionIDs.contains($0) }, hidden: true) }
    }

    /// Hiding stops sharing without deleting an existing cloud copy. Unhiding
    /// restores visibility only; sharing must be explicitly enabled again.
    func setSessionsHidden(keys: [String], hidden: Bool) async {
        let keys = Set(keys).subtracting(hidingSessionIDs)
        if !hidden { hiddenSessionIDs.subtract(keys); return }
        hiddenSessionIDs.formUnion(keys)
        hidingSessionIDs.formUnion(keys)
        let revision = connectionRevision
        for key in keys {
            defer { hidingSessionIDs.remove(key) }
            if let session = LocalSessionRow.relaySession(for: key, in: relay.sessions) {
                relay.requestRelay(false, for: session)
                while relay.busyTargets.contains(session.id) && !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(20))
                }
                if let error = relay.errors[session.id] {
                    hiddenSessionIDs.remove(key)
                    uploadErrors[key] = "Could not hide session: " + error
                    continue
                }
            }
            // Finish any include already in flight before excluding. Hidden
            // sessions cannot start another include through the UI.
            if let task = uploadTasks[key] { _ = await task.value }
            guard revision == connectionRevision, !Task.isCancelled else {
                hiddenSessionIDs.remove(key)
                continue
            }
            guard sessions.contains(where: { $0.id == key }) else { continue }
            do {
                try await client.uploaderSessionsExclude(SessionKeysParams(sessionKeys: [key]))
                guard revision == connectionRevision else { hiddenSessionIDs.remove(key); continue }
                selectionRevision += 1
                sessions = sessions.map { $0.id == key ? $0.withInclusion(false) : $0 }
                uploadErrors[key] = nil
            } catch {
                hiddenSessionIDs.remove(key)
                uploadErrors[key] = "Could not hide session: " + error.localizedDescription
            }
        }
    }

    var uploadConnectionRevision: Int { connectionRevision }

    func excludeSessions(keys: [String], confirmedAt revision: Int? = nil) async {
        if let revision, revision != connectionRevision { return }
        _ = await changeSessionUploads(keys: keys, included: false)
    }

    /// Each session has its own serialized request loop. The visible intent is
    /// updated before awaiting the core, and a second click replaces that intent.
    private func changeSessionUploads(keys: [String], included: Bool) async -> Bool {
        guard !keys.isEmpty else { return false }
        guard phase == .attached else {
            sessionActionError = "Sign in to Agent Relay to upload sessions."
            return false
        }
        guard !isSessionTableReadOnly, keys.allSatisfy({ !previewSessionIDs.contains($0) }) else { return false }
        let revision = connectionRevision
        sessionActionError = nil
        let tasks = Set(keys).map { key -> Task<Bool, Never> in
            uploadErrors[key] = nil
            if included {
                requestingUploads.insert(key)
                stoppingUploads.remove(key)
            } else {
                stoppingUploads.insert(key)
                requestingUploads.remove(key)
            }
            selectionRevision += 1
            if let task = uploadTasks[key] { return task }
            let task = Task { await driveUpload(key, revision: revision) }
            uploadTasks[key] = task
            return task
        }
        var succeeded = true
        for task in tasks { if !(await task.value) { succeeded = false } }
        if revision == connectionRevision { await refreshUploader() }
        return succeeded
    }

    private func driveUpload(_ key: String, revision: Int) async -> Bool {
        defer {
            if revision == connectionRevision {
                uploadTasks[key] = nil
                requestingUploads.remove(key)
                stoppingUploads.remove(key)
            }
        }
        var reconcile = false
        while revision == connectionRevision && !Task.isCancelled {
            let on = requestingUploads.contains(key)
            guard on || stoppingUploads.contains(key) else { return true }
            // Upload exclusion does not prove the Cloud copy was deleted.
            if on && !reconcile && sessions.first(where: { $0.id == key })?.included == true { return true }
            do {
                let params = SessionKeysParams(sessionKeys: [key])
                if on { try await client.uploaderSessionsInclude(params) }
                else { try await client.uploaderSessionsDelete(params) }
                guard revision == connectionRevision else { return false }
                selectionRevision += 1
                sessions = sessions.map { $0.id == key ? $0.withInclusion(on) : $0 }
                if requestingUploads.contains(key) == on { return true }
            } catch {
                guard revision == connectionRevision else { return false }
                // A later click still gets its turn; a failed final choice rolls
                // back to the last confirmed value and explains the error in-row.
                if requestingUploads.contains(key) != on { reconcile = true; continue }
                uploadErrors[key] = error.localizedDescription
                return false
            }
        }
        return false
    }

    /// The chosen policy shows at once; the uploader is asked until it
    /// reports the policy last chosen, and the latest request's failure
    /// reverts to the one it reports.
    func setSharingMode(_ mode: SharingMode) async {
        guard mode != sharingMode else { return }
        sessionActionError = nil
        sharingModeWanted.begin(mode)
        guard !drivingSharingMode else { return }
        drivingSharingMode = true
        defer { drivingSharingMode = false }
        let revision = connectionRevision
        // Each request is sent once; the loop goes on only for a newer one.
        while let wanted = sharingModeWanted.wanted {
            let token = sharingModeWanted.token
            let failure = await perform("Updating upload selection…") {
                try await client.uploaderSharingSet(SharingParams(mode: wanted))
                selectionRevision += 1
            }
            guard revision == connectionRevision else { return }
            if let failure {
                if sharingModeWanted.finish(token) { sessionActionError = failure.localizedDescription }
            } else {
                await refreshUploader()
                guard revision == connectionRevision else { return }
                sharingModeWanted.finish(token)
            }
        }
    }

    func openLogFile() {
        record(.openLogs, .started)
        guard let directory = installDirectory else { return }
        let log = URL(fileURLWithPath: directory).appendingPathComponent("collector.log")
        if FileManager.default.fileExists(atPath: log.path) {
            NSWorkspace.shared.open(log)
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory)])
        }
    }

    // MARK: Sign-in

    /// Whether first-run Claude Code direct delivery still needs its default.
    var inboundDefaultOffer: InboundDefault.Offer? {
        InboundDefault.offer(settings, alreadyOffered: defaults.bool(forKey: InboundDefault.offeredKey))
    }

    /// Applies the first-run default once, preserving explicit and managed settings.
    private func takeInboundDefault() -> SettingsChange? {
        guard let offer = inboundDefaultOffer else { return nil }
        guard offer == .offer else {
            defaults.set(true, forKey: InboundDefault.offeredKey)
            return nil
        }
        return SettingsChange(directDeliveryDefault: true)
    }

    /// Makes the first-run change. The core keeps a value the user already
    /// chose (`hold` included) and refuses against a managed setting. A
    /// failed write is offered again at the next sign-in.
    private func applyInboundDefault(_ change: SettingsChange) async {
        if let failure = await setSetting(change) {
            inboundDefaultError = failure
            Self.logger.error("could not set Claude Code direct delivery: \(failure, privacy: .public)")
        } else {
            inboundDefaultError = nil
            defaults.set(true, forKey: InboundDefault.offeredKey)
        }
    }

    /// Starts a sign-in in the browser, sharing only the sessions chosen in
    /// My sessions; Settings › Session sharing offers automatic uploads.
    func signIn(acknowledgeUninspectedSchedules: Bool = false, workspace: String? = nil, useAnotherAccount: Bool = false) {
        guard !startingSignIn, phase == .signedOut else { return }
        signInError = nil
        lastError = nil
        startingSignIn = true
        let inboundChange = takeInboundDefault()
        Task {
            if let inboundChange { await applyInboundDefault(inboundChange) }
            let params = SignInRequest(acknowledgeUninspectedSchedules: acknowledgeUninspectedSchedules, flow: useAnotherAccount ? .browser : nil,
                                       sharing: .selected, siteUrl: configuredSite, workspace: workspace)
            do {
                let state = try await client.accountSignIn(params)
                // The core started no attempt: nothing is left to wait for.
                // Otherwise its snapshot shows where the attempt stands.
                if state.state == .signedOut || state.state.isFailure { startingSignIn = false }
                signInLink = state.link
                openSignInLinkIfNew(state.link)
            } catch {
                startingSignIn = false
                signInError = error.localizedDescription
            }
        }
    }

    /// Signs in again in the browser while this Mac stays connected: the
    /// core keeps a new session for Cloud calls such as session summaries,
    /// and uploads carry on.
    func renewSignIn() {
        guard phase == .attached, !renewingSignIn else { return }
        renewingSignIn = true
        Task {
            let params = SignInRequest(acknowledgeUninspectedSchedules: false, flow: .browser,
                                       sharing: sharingMode, siteUrl: nil, workspace: nil)
            do {
                let state = try await client.accountSignIn(params)
                if state.state == .pendingApproval {
                    signInLink = state.link
                    openSignInLinkIfNew(state.link)
                } else {
                    // The core already holds a usable session: read again.
                    renewingSignIn = false
                    relay.signInRenewed()
                }
            } catch {
                renewingSignIn = false
                signInError = error.localizedDescription
            }
        }
    }

    func openApprovalPageAgain() {
        openedLink = nil
        openSignInLinkIfNew(signInLink)
    }

    func selectWorkspace(_ workspaceID: String) {
        signInError = nil
        Task {
            do { try await client.accountSelectWorkspace(ConnectWorkspaceParams(workspaceId: workspaceID)) }
            catch { signInError = error.localizedDescription }
        }
    }

    func cancelSignIn() {
        Task { try? await client.accountSignInCancel() }
    }

    /// Logs out: the window shows the account leaving at once, until the
    /// core has answered and its snapshot no longer shows the account.
    func disconnect() async {
        guard !signingOut else { return }
        agentsSheet = nil
        signingOut = true
        do {
            try await client.accountSignOut()
            // Signed out, the window waits for the snapshot without the
            // account, which arrives on the event stream and may trail
            // this answer.
            if phase == .signedOut { signingOut = false }
        } catch {
            signingOut = false
            signInError = "Could not finish disconnecting. Uploads may still be running. Sign in again to retry cleanup. " + error.localizedDescription
        }
    }

    /// `agentrelay://` links: a message endpoint opens the composer; a
    /// connection link signs in to its workspace.
    /// Links that arrived before the core's first snapshot, in order.
    private var pendingLinks: [URL] = []

    func openConnection(_ url: URL) {
        guard core != nil else {
            // A cold launch from a link: it is parsed once the core answers
            // and the account's phase is known.
            pendingLinks.append(url)
            return
        }
        Task {
            do {
                let link = try await client.linksParse(LinkParams(siteUrl: configuredSite, url: url.absoluteString))
                switch link {
                case .message(_, let endpoint):
                    messageEndpoint = endpoint
                    page = .sessions
                    agentsSheet = .message
                    lastError = nil
                case .connect(_, _, let workspace):
                    if let current = workspaceID, canLogOut, current.lowercased() != workspace.lowercased() {
                        record(.connectionLink, .failed, failure: .workspaceConflict)
                        lastError = "This app is connected to another account or workspace. Log out in Account before connecting a different workspace."
                        page = .settings(.account)
                    } else {
                        record(.connectionLink, .succeeded)
                        lastError = nil
                        if phase == .signedOut { signIn(workspace: workspace) }
                    }
                case .unknown:
                    rejectConnectionLink()
                }
            } catch {
                rejectConnectionLink()
            }
            showMainWindow()
        }
    }

    private func rejectConnectionLink() {
        record(.connectionLink, .failed, failure: .invalidConnection)
        lastError = "This connection link is not for this Agent Relay app. Download the app from the same site and try again."
    }

    // MARK: Settings

    func loadSettings() async {
        let revision = connectionRevision
        if let loaded = try? await client.settingsGet(), revision == connectionRevision { confirmedSettings = loaded }
    }

    private var shownSettings: SettingsValues? {
        pendingSettings.reduce(confirmedSettings) { $0?.applying($1.change) }
    }

    /// Whether a change to the setting under `field` (its JSON key) is still
    /// on its way: the row shows the value asked for, with a marker.
    func isSettingPending(_ field: String) -> Bool {
        pendingSettings.contains { $0.change.fields.contains(field) }
    }

    /// Sets one of the core's settings. The change shows at once; the core's
    /// answer replaces it, and a failure reverts it and is returned as the
    /// core's sentence (also kept in `settingErrors` under the setting).
    @discardableResult
    func setSetting(_ change: SettingsChange) async -> String? {
        settingsWriteToken &+= 1
        let token = settingsWriteToken
        let revision = connectionRevision
        for field in change.fields { settingErrors[field] = nil }
        pendingSettings.append((token, change))
        do {
            let saved = try await client.settingsSet(change)
            guard revision == connectionRevision else { return nil }
            pendingSettings.removeAll { $0.token == token }
            // The latest change's answer is the core's last word. An older
            // answer may predate a newer change still on its way, so only
            // its own change joins the confirmed values.
            confirmedSettings = token == settingsWriteToken ? saved : confirmedSettings?.applying(change)
            // A later direct-delivery change supersedes a first-run failure.
            if change.directDelivery != nil { inboundDefaultError = nil }
            return nil
        } catch {
            guard revision == connectionRevision else { return nil }
            pendingSettings.removeAll { $0.token == token }
            for field in change.fields { settingErrors[field] = error.localizedDescription }
            return error.localizedDescription
        }
    }

    /// Whether the person's OpenClaw agents can use Agent Relay's tools
    /// (`openclaw.relay_tools.status`); a failed read says why, as the core
    /// worded it.
    func openClawToolsStatus() async -> OpenClawToolsStatus {
        do {
            return try await client.openclawRelayToolsStatus()
        } catch {
            return OpenClawToolsStatus(detail: error.localizedDescription, state: .unavailable)
        }
    }

    /// Connect (or Open Again): the core starts OpenClaw's sign-in and the
    /// consent page opens in the browser, as the sign-in approval page does.
    /// Returns the new state, or the core's sentence on failure.
    func connectOpenClawTools() async -> Result<OpenClawToolsState, CoreError> {
        do {
            let connected = try await client.openclawRelayToolsConnect()
            if manageSystemServices, let link = connected.authorizationUrl,
               let url = URL(string: link), url.scheme == "https" || url.scheme == "http" {
                NSWorkspace.shared.open(url)
            }
            return .success(connected.state)
        } catch let error as CoreError {
            return .failure(error)
        } catch {
            return .failure(CoreError(kind: "internal", message: error.localizedDescription))
        }
    }

    func setAnalyticsEnabled(_ enabled: Bool) {
        Task { await setSetting(SettingsChange(analyticsEnabled: enabled)) }
    }

    func setKeepsAgentsConnectedAfterQuit(_ enabled: Bool) {
        keepsAgentsConnectedAfterQuit = enabled
        defaults.set(enabled, forKey: Self.keepsAgentsConnectedKey)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        let changed = LoginItem.setEnabled(enabled)
        launchAtLogin = LoginItem.isEnabled
        loginItemNeedsApproval = LoginItem.needsApproval
        record(.launchAtLogin, changed ? .succeeded : .failed, failure: changed ? nil : .systemSetting)
        if !changed { lastError = "Agent Relay could not change the login setting." }
    }

    /// Records an operation only the UI performs; the core records its own.
    func record(_ operation: TelemetryOperation, _ outcome: TelemetryOutcome, failure: TelemetryFailure? = nil) {
        let event = TelemetryEvent(failure: failure, operation: operation, outcome: outcome)
        Task { try? await client.telemetryRecord(event) }
    }
}
