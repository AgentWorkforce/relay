import Foundation
import RelayDesktopCore

/// Skip on the Projects page: the saved conversation and project view are
/// the core's (`chat.*`); this keeps the draft, what is in flight and the
/// session history sheet.
@MainActor
final class ChatModel: ObservableObject {
    @Published var draft = ""
    @Published private(set) var conversation = ChatConversation.empty
    @Published private(set) var projects: ProjectsState?
    @Published private(set) var error: String?
    @Published private(set) var projectsError: String?
    /// The account's sign-in no longer works for Skip; signing in again helps.
    @Published private(set) var needsSignIn = false
    @Published private(set) var isSending = false
    @Published private(set) var pendingActions: Set<String> = []
    @Published private(set) var pendingPushes: Set<String> = []
    /// Why a push could not start, by push key. Not saved: fixing the cause
    /// makes it retryable.
    @Published private(set) var pushNotes: [String: String] = [:]
    @Published var selectedSession: TurnReference?
    @Published private(set) var events: [SessionEvent] = []
    @Published private(set) var eventsCursor: String?
    @Published private(set) var isLoadingEvents = false

    private let client: CoreClient
    weak var model: AppModel?
    private var selection = UUID()
    /// Renewed by `reset`: an answer to a request made before it is dropped.
    private var generation = UUID()
    private var sendingText: String?
    private var clearingConversation = false
    private var refreshingProjects = false
    private var actionWritesInFlight: Set<String> = []
    /// Numbers every request whose answer replaces `conversation`. A read's
    /// answer is applied only while it is the latest request: a later read
    /// supersedes it, and so does a change (send, clear) that finishes after
    /// it started, whose answer always lands. A read that left before or
    /// during a send never puts the pre-send conversation back.
    private var conversationRequest = 0

    private func startConversationRequest() -> Int {
        conversationRequest += 1
        return conversationRequest
    }

    private func isLatest(_ request: Int) -> Bool { request == conversationRequest }

    /// Applies what a change answered and ends every read in flight: their
    /// answers may predate the change.
    private func changed(_ conversation: ChatConversation) {
        conversationRequest += 1
        self.conversation = conversation
    }

    init(client: CoreClient) {
        self.client = client
    }

    var messages: [ConversationTurn] { conversation.messages }
    var isConnected: Bool { model?.phase == .attached || model?.phase == .preparingSessions }
    var report: ProjectsReport? { projects?.report }
    var isLoadingProjects: Bool { projects?.refreshing == true }

    /// SwiftUI restarts the page task when a refresh is admitted during an idle sleep.
    struct ProjectsPollingState: Hashable {
        let connected: Bool
        let loading: Bool
        var delayNanoseconds: UInt64 { (loading ? 5 : 60) * 1_000_000_000 }
    }
    var projectsPollingState: ProjectsPollingState {
        ProjectsPollingState(connected: isConnected, loading: isLoadingProjects)
    }

    func reset() {
        generation = UUID()
        selection = UUID()
        isSending = false
        sendingText = nil
        clearingConversation = false
        refreshingProjects = false
        actionWritesInFlight = []
        isLoadingEvents = false
        draft = ""
        conversation = .empty
        projects = nil
        error = nil
        projectsError = nil
        needsSignIn = false
        pendingActions = []
        pendingPushes = []
        pushNotes = [:]
        selectedSession = nil
        events = []
        eventsCursor = nil
    }

    func connectionInterrupted() {
        let interruptedWrite = isSending || clearingConversation || !actionWritesInFlight.isEmpty
        let interruptedProjectWrite = refreshingProjects || !pendingPushes.isEmpty
        if isSending, let sendingText, !draft.contains(sendingText) {
            draft = draft.isEmpty ? sendingText : "\(sendingText)\n\n\(draft)"
        }
        generation = UUID()
        selection = UUID()
        conversationRequest += 1
        isSending = false
        sendingText = nil
        clearingConversation = false
        refreshingProjects = false
        actionWritesInFlight = []
        isLoadingEvents = false
        if let saved = projects {
            projects = ProjectsState(durable: saved.durable, refreshing: false, report: saved.report, stale: saved.stale)
        }
        pendingActions = []
        pendingPushes = []
        error = interruptedWrite ? CoreError.interrupted.message : nil
        projectsError = interruptedProjectWrite ? CoreError.interrupted.message : nil
    }

    private func record(_ error: Error, projects: Bool = false) {
        if (error as? CoreError)?.kind == ErrorKind.notSignedIn.rawValue { needsSignIn = true }
        if projects {
            if projectsError != CoreError.interrupted.message { projectsError = error.localizedDescription }
            if let saved = self.projects {
                self.projects = ProjectsState(durable: saved.durable, refreshing: false, report: saved.report, stale: saved.stale)
            }
        } else if self.error != CoreError.interrupted.message { self.error = error.localizedDescription }
    }

    func refresh() async {
        guard isConnected else { return }
        let current = generation
        let request = startConversationRequest()
        do {
            let loaded = try await client.chatConversation()
            guard current == generation else { return }
            if isLatest(request) {
                conversation = loaded
                if error != CoreError.interrupted.message { error = nil }
                needsSignIn = false
            }
        } catch {
            if current == generation && isLatest(request) { record(error) }
        }
        do {
            let loaded = try await client.chatProjects()
            guard current == generation else { return }
            projects = loaded
            if projectsError != CoreError.interrupted.message { projectsError = loaded.error }
        } catch {
            if current == generation { record(error, projects: true) }
        }
    }

    /// Sends `question`, or the draft when it is nil.
    func send(_ question: String? = nil) async {
        let text = (question ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, isConnected else { return }
        guard text.count <= 12_000 else { error = "Keep your message under 12,000 characters."; return }
        if question == nil { draft = "" }
        let current = generation
        isSending = true
        sendingText = text
        error = nil
        defer { if current == generation { isSending = false; sendingText = nil } }
        do {
            let result = try await client.chatSend(ChatSendParams(text: text))
            guard current == generation else { return }
            changed(result.conversation)
        } catch {
            guard current == generation else { return }
            if draft.isEmpty && question == nil { draft = text }
            record(error)
        }
    }

    func ask(_ question: String) async { await send(question) }

    func newConversation() {
        guard !isSending, !clearingConversation else { return }
        let current = generation
        clearingConversation = true
        error = nil
        Task {
            defer { if current == generation { clearingConversation = false } }
            do {
                let cleared = try await client.chatClear()
                guard current == generation else { return }
                changed(cleared)
                error = nil
            } catch {
                if current == generation { record(error) }
            }
        }
    }

    /// Sends a message Skip drafted, as the person; the core keeps the receipt.
    func sendAction(_ action: TurnAction) async {
        guard action.receipt == nil, !pendingActions.contains(action.id) else { return }
        let current = generation
        pendingActions.insert(action.id)
        actionWritesInFlight.insert(action.id)
        error = nil
        defer { if current == generation { pendingActions.remove(action.id); actionWritesInFlight.remove(action.id) } }
        do {
            try await client.chatAct(ActParams(actionId: action.id))
            guard current == generation else { return }
            actionWritesInFlight.remove(action.id)
            // The receipt is read back like any other read: a send that
            // finishes meanwhile answers with the newer conversation.
            let request = startConversationRequest()
            let loaded = try await client.chatConversation()
            guard current == generation else { return }
            if isLatest(request) { conversation = loaded }
        } catch {
            if current == generation { record(error) }
        }
    }

    func startProjectsRefresh() {
        guard isConnected, !isLoadingProjects, !refreshingProjects else { return }
        let current = generation
        refreshingProjects = true
        projectsError = nil
        Task {
            defer { if current == generation { refreshingProjects = false } }
            do {
                let rebuilt = try await client.chatProjectsRefresh()
                guard current == generation else { return }
                projects = rebuilt
                projectsError = rebuilt.error
            } catch let error as CoreError where error.kind == ErrorKind.busy.rawValue {
                return
            } catch {
                if current == generation { record(error, projects: true) }
            }
        }
    }

    /// Periodic page reads observe Cloud's durable cache without requesting model work.
    func readProjects() async {
        guard isConnected else { return }
        let current = generation
        do {
            let loaded = try await client.chatProjects()
            guard current == generation else { return }
            projects = loaded
            if projectsError != CoreError.interrupted.message { projectsError = loaded.error }
            // Only the explicitly identified legacy API keeps refresh-on-view.
            // Durable pending/failed reports are observed, never re-admitted here.
            if loaded.durable == false && loaded.stale && !loaded.refreshing { startProjectsRefresh() }
        } catch {
            if current == generation { record(error, projects: true) }
        }
    }

    /// Sends Skip's nudge to each ready session, as the person.
    func pushAlong(_ sessions: [ProjectSession]) async {
        let keys = sessions.compactMap(\.pushKey).filter { !pendingPushes.contains($0) }
        guard !keys.isEmpty else { return }
        let current = generation
        pendingPushes.formUnion(keys)
        projectsError = nil
        keys.forEach { pushNotes[$0] = nil }
        defer { if current == generation { pendingPushes.subtract(keys) } }
        do {
            let result = try await client.chatPush(PushParams(pushKeys: keys))
            guard current == generation else { return }
            projects = result.projects
            for outcome in result.results { pushNotes[outcome.pushKey] = outcome.note }
        } catch {
            if current == generation { record(error, projects: true) }
        }
    }

    func readSession(_ reference: TurnReference, more: Bool = false) async {
        if !more || selectedSession != reference {
            selection = UUID()
            events = []
            eventsCursor = nil
        }
        selectedSession = reference
        let current = selection
        let account = generation
        isLoadingEvents = true
        defer { if current == selection { isLoadingEvents = false } }
        let params = ChatHistoryParams(cursor: more ? eventsCursor : nil, sessionId: reference.sessionId, source: reference.source)
        do {
            let page = try await client.chatHistory(params)
            guard current == selection, account == generation else { return }
            var seen = Set<String>()
            events = (more ? events + page.events : page.events).filter { seen.insert($0.id).inserted }
            eventsCursor = page.nextCursor
        } catch {
            if current == selection, account == generation { record(error) }
        }
    }
}
