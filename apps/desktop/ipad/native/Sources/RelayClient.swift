import Foundation
import SwiftUI
import Security
import UniformTypeIdentifiers
import RelaySessionOverview
import UserNotifications

typealias JSONObject = [String: Any]

private func object(_ value: Any?) -> JSONObject { value as? JSONObject ?? [:] }
private func string(_ value: Any?) -> String {
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value.stringValue }
    return ""
}
private func objects(_ value: Any?) -> [JSONObject] { value as? [JSONObject] ?? [] }
private func machineIn(_ address: String) -> String {
    guard let at = address.firstIndex(of: "@") else { return "" }
    let host = String(address[address.index(after: at)...])
    guard let dash = host.lastIndex(of: "-"), host[host.index(after: dash)...].allSatisfy(\.isNumber) else { return host }
    return String(host[..<dash])
}
private func cliInName(_ value: String) -> String {
    let words = value.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    for (index, word) in words.enumerated() {
        switch word {
        case "claudecode": return "claudecode"
        case "claude": return words.indices.contains(index + 1) && ["code", "terminal"].contains(words[index + 1]) ? "claudecode" : "claude"
        case "opencode": return "opencode"
        case "open": if words.indices.contains(index + 1) && words[index + 1] == "code" { return "opencode" }
        case "codex", "grok", "cursor", "openai", "muse": return word
        // Grok Bot inboxes are often named for their job, like `devopsgrok`.
        default: if word.count > 4 && word.hasSuffix("grok") { return "grok" }
        }
    }
    return ""
}
private func agentCLI(structured: [String], name: String, persona: String = "") -> String {
    for hint in structured {
        let cli = cliInName(hint)
        if !cli.isEmpty { return cli }
    }
    let named = cliInName(name)
    if !named.isEmpty { return named }
    let description = persona.lowercased()
    for (phrase, cli) in [("claude code", "claudecode"), ("open code", "opencode"),
                          ("codex", "codex"), ("claude", "claude"),
                          ("grok", "grok"), ("cursor", "cursor"),
                          ("openai", "openai"), ("muse", "muse")] {
        if description.contains("a \(phrase) agent") || description.contains("a \(phrase) worker") {
            return cli
        }
    }
    return ""
}

struct RelayAgent: Identifiable, Hashable, Sendable {
    enum Source: String, Sendable { case relay, drive, conversation, channel }
    let id: String
    let name: String
    let address: String
    let source: Source
    let node: String
    let machine: String
    let sessionID: String
    let objective: String
    /// The provider's title, independent from a user-authored objective.
    var sessionTitle = ""
    var mobileHandoff: MobileHandoffNotice?
    var mobileHandoffEnabled = false
    let cli: String
    let subtitle: String
    let status: String
    let attachable: Bool
    /// A person (Relaycast `type: "human"`) rather than an agent.
    var isHuman = false
    /// A person's display name; empty for agents.
    var displayName = ""
    var lastSeen: Date?
    var isDesktopRegistration = false
    /// Renamed registrations only forward messages to the current name.
    var isListed = true
    /// A channel this person belongs to, so its messages reach them.
    var isJoined = false
    var memberCount = 0

    /// Matches the relay core's five-minute presence window.
    func isReachable(at now: Date = Date()) -> Bool {
        if let lastSeen, now.timeIntervalSince(lastSeen) > 5 * 60 { return false }
        switch status {
        case "active", "online", "waiting", "blocked": return true
        case "idle": return !isDesktopRegistration
        default: return false
        }
    }

    static func recipient(_ endpoint: String, in roster: [RelayAgent]) -> RelayAgent {
        let clean = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^@", with: "", options: .regularExpression)
        if let known = roster.first(where: { clean.contains("@") ? $0.address == clean : $0.name == clean }) {
            return known
        }
        let name = clean.split(separator: "@", maxSplits: 1).first.map(String.init) ?? clean
        return RelayAgent(relay: ["name": name, "address": clean, "status": "active"])
    }

    func rosterMatch(in roster: [RelayAgent]) -> RelayAgent? {
        if let exact = roster.first(where: { $0.id == id }) { return exact }
        guard source == .relay else { return nil }
        if !address.contains("@"), let named = roster.first(where: { $0.name == name }) { return named }
        // A person's conversation is independent from online registrations.
        return isHuman ? self : nil
    }

    init(relay data: JSONObject) {
        name = string(data["name"])
        address = string(data["address"]).isEmpty ? name : string(data["address"])
        id = "relay:\(address)"
        source = .relay
        node = ""
        let metadata = object(data["metadata"])
        mobileHandoff = MobileHandoffNotice(metadata: metadata)
        mobileHandoffEnabled = metadata["mobile_handoff_enabled"] as? Bool ?? false
        isDesktopRegistration = string(metadata["source"]) == "relay-desktop"
        isListed = string(metadata["renamed_to"]).isEmpty
        let seen = string(data["last_seen"])
        lastSeen = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(seen))
            ?? (try? Date.ISO8601FormatStyle().parse(seen))
        cli = agentCLI(structured: [string(metadata["session_kind"]), string(metadata["cli"]),
                                    string(metadata["tool"]), string(metadata["harness"]),
                                    string(metadata["provider"])],
                       name: name, persona: string(data["persona"]))
        // Gateway registrations name an agent (for example OpenClaw's `main`),
        // not any one of its conversations. Never request a brief for that ID.
        let gateway = string(metadata["session_scope"]) == "agent" ||
            (isDesktopRegistration && ["openclaw", "hermes"].contains(string(metadata["session_kind"])))
        sessionID = gateway ? "" : string(metadata["session_id"])
        sessionTitle = string(metadata["session_title"]).trimmingCharacters(in: .whitespacesAndNewlines)
        let publishedObjective = string(metadata["objective"])
        objective = (publishedObjective.isEmpty ? string(data["description"]) : publishedObjective)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let host = string(metadata["host"])
        isHuman = PersonIdentity.isHuman(data)
        // A person is one identity across devices: no machine, and the
        // persona is their name, not an agent role.
        machine = isHuman ? "" : (host.isEmpty ? machineIn(address) : host)
        displayName = isHuman ? string(data["persona"]).trimmingCharacters(in: .whitespacesAndNewlines) : ""
        subtitle = isHuman ? name : [machine, string(data["persona"])].filter { !$0.isEmpty }.joined(separator: " · ")
        status = string(data["status"])
        attachable = false
    }
    init(fleet data: JSONObject) {
        name = string(data["name"])
        node = string(data["node"])
        address = name
        id = "drive:\(node)/\(name)"
        source = .drive
        machine = node
        sessionID = string(data["session_id"])
        objective = (string(data["objective"]).isEmpty ? string(data["description"]) : string(data["objective"]))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        cli = agentCLI(structured: [string(data["cli"]), string(data["harness"]),
                                    string(data["providerLabel"]), string(data["cliModel"])], name: name)
        subtitle = [node, string(data["cliModel"]).isEmpty ? string(data["providerLabel"]) : string(data["cliModel"])].filter { !$0.isEmpty }.joined(separator: " · ")
        let state = string(data["workerLiveness"])
        status = state.isEmpty ? string(data["state"]) : state
        attachable = status != "offline" && !name.isEmpty && !node.isEmpty
    }
    init(conversation data: JSONObject) {
        let peers = objects(data["participants"])
        let peer = peers.first { string($0["agent_name"]) != UserDefaults.standard.string(forKey: "relay.mobileName") }
        name = string(peer?["agent_name"])
        address = name
        id = "conversation:\(address)"
        source = .conversation
        node = ""
        isHuman = data["is_human"] as? Bool ?? false
        displayName = string(data["display_name"])
        machine = isHuman ? "" : (string(data["machine"]).isEmpty ? machineIn(address) : string(data["machine"]))
        sessionID = string(data["session_id"])
        objective = string(data["objective"]).trimmingCharacters(in: .whitespacesAndNewlines)
        sessionTitle = string(data["session_title"]).trimmingCharacters(in: .whitespacesAndNewlines)
        mobileHandoff = MobileHandoffNotice(metadata: object(data["handoff_metadata"]))
        mobileHandoffEnabled = data["mobile_handoff_enabled"] as? Bool ?? false
        isDesktopRegistration = data["desktop_registration"] as? Bool ?? false
        cli = isHuman ? "" : agentCLI(structured: [string(peer?["cli"]), string(data["cli"])], name: name)
        subtitle = string(object(data["last_message"])["text"])
        status = string(data["status"])
        attachable = false
    }
    /// A workspace channel: a group chat shared by people and agents.
    init(channel data: JSONObject, joined: Bool) {
        name = string(data["name"])
        address = "#\(name)"
        id = "channel:\(name)"
        source = .channel
        node = ""
        machine = ""
        sessionID = ""
        objective = string(data["topic"]).trimmingCharacters(in: .whitespacesAndNewlines)
        cli = ""
        let count = (data["member_count"] as? NSNumber)?.intValue ?? 0
        let members = count == 1 ? "1 member" : "\(count.formatted()) members"
        subtitle = joined ? members : "Not joined · \(members)"
        status = ""
        attachable = false
        memberCount = count
        isJoined = joined
    }
}

struct RelayMessage: Identifiable {
    let id: String
    let text: String
    let sender: String
    let mine: Bool
    let createdAt: Date?
    /// False when Relaycast sent no id and the row index stands in for one.
    let hasServerID: Bool
    let attachments: [RelayAttachment]
    init(_ data: JSONObject, index: Int) {
        hasServerID = !string(data["id"]).isEmpty
        id = hasServerID ? string(data["id"]) : String(index)
        text = string(data["text"])
        sender = string(data["agent_name"])
        mine = sender == UserDefaults.standard.string(forKey: "relay.mobileName")
        let timestamp = string(data["created_at"])
        createdAt = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(timestamp))
            ?? (try? Date.ISO8601FormatStyle().parse(timestamp))
        attachments = objects(data["attachments"]).map { RelayAttachment($0) }
    }
}

struct RelayAttachment: Identifiable, Hashable {
    let id: String
    let filename: String
    let contentType: String
    let sizeBytes: Int

    init(fileID: String, filename: String, contentType: String, sizeBytes: Int) {
        id = fileID
        self.filename = filename
        self.contentType = contentType
        self.sizeBytes = sizeBytes
    }

    init(_ data: JSONObject) {
        id = string(data["file_id"])
        filename = string(data["filename"])
        contentType = string(data["content_type"])
        sizeBytes = (data["size_bytes"] as? NSNumber)?.intValue ?? 0
    }
}

struct RelaySpawnNode: Identifiable, Hashable {
    let name: String
    let harnesses: [String]
    var id: String { name }
}

struct RelayAPIError: LocalizedError {
    let message: String
    var status: Int? = nil
    var code: String = ""
    var retryAfterSeconds: Int? = nil
    var errorDescription: String? { message }
}

private enum SecureStore {
    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.agentworkforce.relayipad",
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        #if DEBUG && targetEnvironment(simulator)
        if status == errSecMissingEntitlement { return UserDefaults.standard.string(forKey: "relay.simulator.\(key)") }
        #endif
        if status != errSecSuccess && status != errSecItemNotFound {
            NSLog("Agent Relay Keychain read failed: %d", status)
        }
        guard status == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func write(_ value: String, for key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.agentworkforce.relayipad",
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        #if DEBUG && targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            UserDefaults.standard.set(value, forKey: "relay.simulator.\(key)")
            return
        }
        #endif
        if status != errSecSuccess { NSLog("Agent Relay Keychain write failed: %d", status) }
    }
    static func remove(_ key: String) {
        #if DEBUG && targetEnvironment(simulator)
        UserDefaults.standard.removeObject(forKey: "relay.simulator.\(key)")
        #endif
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.agentworkforce.relayipad",
            kSecAttrAccount as String: key
        ] as CFDictionary)
    }
}

@MainActor final class RelayClient: ObservableObject {
    @Published var paired = RelayClient.startsPaired
    @Published var connected = false
    @Published var busy = false
    @Published var error: String?
    @Published var workspace = UserDefaults.standard.string(forKey: "relay.workspaceName") ?? "Workspace"
    @Published var account = UserDefaults.standard.string(forKey: "relay.accountName") ?? "Agent Relay"
    /// The bare handle agents use to reach this person (`to=<handle>`).
    var messagingHandle: String { UserDefaults.standard.string(forKey: "relay.mobileName") ?? "" }
    @Published var verificationURL: URL?
    @Published var userCode = ""
    @Published var signInStatus = ""
    @Published var relayAgents: [RelayAgent] = []
    @Published var fleetAgents: [RelayAgent] = []
    @Published var spawnNodes: [RelaySpawnNode] = []
    @Published var conversations: [RelayAgent] = []
    @Published var channels: [RelayAgent] = []
    @Published var unreadConversationIDs: Set<String> = []
    @Published var hiddenConversationIDs: Set<String> = []
    @Published var messages: [RelayMessage] = []
    @Published var summaryCredentialReady = SecureStore.read("cloudRefreshToken") != nil
    @Published var cloudWorkspaceID = UserDefaults.standard.string(forKey: "relay.workspaceID") {
        didSet {
            if cloudWorkspaceID != oldValue { resetPeople() }
        }
    }
    @Published private var workspacePeople = WorkspacePeopleDirectory()
    @Published var summaries: [String: SessionOverview] = [:]
    @Published var goals: [String: String] = [:]
    /// Outgoing messages Relaycast reports as read by someone other than the
    /// sender, which happens when the broker puts them into the agent's session.
    @Published var deliveredMessageIDs: Set<String> = []
    @Published var attachedID: String?
    @Published var attachedMode: String?
    @Published var terminalEnded = false
    @Published var screenHistory: [String] = []
    var terminalBacklog = ""
    var onTerminalOutput: ((String) -> Void)?
    var onTerminalScroll: ((Int) -> Void)?
    private var terminalTask: Task<Void, Never>?
    private var terminalSocket: URLSessionWebSocketTask?
    private var terminalSessionID: String?
    private var conversationIDs: [String: String] = [:]
    private var joinedChannels: Set<String> = []
    /// Channel senders no longer on the roster, looked up once so a person
    /// who left still shows as a person.
    @Published private var channelSenders: [String: RelayAgent] = [:]
    private var channelSenderRetryAfter: [String: Date] = [:]
    /// Joins this device made, kept until Relaycast lists them (or two
    /// minutes pass) so a lagging membership read can't undo a join.
    private var recentJoins: [String: Date] = [:]
    private var latestMessageIDs: [String: String] = [:]
    private var localMessageNotices = LocalMessageNotices()
    private var latestIncomingMessageIDs: [String: String] = [:]
    private var conversationsInitialized = false
    private var registeredPushToken: String?
    private var selectedConversation: String?
    private var loadingSummaryIDs: Set<String> = []
    private var loadingGoalIDs: Set<String> = []
    private var cloudRefreshTask: Task<String, Error>?
    private var cloudRefreshTaskID: UUID?
    private var peopleRefreshTask: Task<Void, Never>?
    private var conversationAgentMetadata: [String: RelayAgent] = [:]
    private var conversationRoster = ConversationRoster()
    private var conversationAgentRetryAfter: [String: Date] = [:]
    private var latestConversationThreads: [JSONObject] = []
    private var conversationMetadataWorkerID: UUID?
    private var conversationRefreshGeneration = 0
    private var refreshGeneration = 0
    private var signingOut = false
    /// Changes whenever the signed-in identity does, so file work started for
    /// one account or workspace is dropped instead of landing in the next.
    @Published private(set) var sessionGeneration = 0
    private var lastScreenCapture = Date.distantPast
    private let cloud = "https://agentrelay.com/cloud/api/v1"
    private let defaultRelaycast = "https://cast.agentrelay.com"

    private static var startsPaired: Bool {
        #if DEBUG
        RelayUITestFixture.prepare()
        if RelayUITestFixture.enabled { return true }
        #endif
        return SecureStore.read("workspaceKey") != nil
    }
    private var relaycast: String { SecureStore.read("relaycastURL") ?? defaultRelaycast }
    private var workspaceKey: String? { SecureStore.read("workspaceKey") }
    private var agentToken: String? { SecureStore.read("agentToken") }
    private var unreadStoragePrefix: String {
        let workspace = cloudWorkspaceID ?? "unknown"
        let mobileName = UserDefaults.standard.string(forKey: "relay.mobileName") ?? "unknown"
        return "relay.mobileUnread.\(workspace).\(mobileName)"
    }
    private var unreadSeenKey: String { unreadStoragePrefix + ".seen" }
    private var unreadBaselineKey: String { unreadStoragePrefix + ".baseline" }
    private var hiddenConversationsKey: String { unreadStoragePrefix + ".hidden" }

    func captureScreen(_ screen: String) {
        let text = screen.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text != screenHistory.last else { return }
        let now = Date()
        guard now.timeIntervalSince(lastScreenCapture) >= 2 else { return }
        lastScreenCapture = now
        screenHistory.append(String(text.prefix(20_000)))
        if screenHistory.count > 120 { screenHistory.removeFirst(screenHistory.count - 120) }
    }

    private func call(_ url: URL, token: String? = nil, method: String = "GET", body: JSONObject? = nil) async throws -> JSONObject {
        let maximumAttempts = method == "GET" ? 3 : 1
        for attempt in 0..<maximumAttempts {
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 25
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw RelayAPIError(message: "No response from Agent Relay") }
            let json = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject ?? [:]
            guard !(200..<300).contains(http.statusCode) else { return json }
            let problem = object(json["error"])
            let code = string(problem["code"])
            let headerDelay = http.value(forHTTPHeaderField: "Retry-After")
                .flatMap(Int.init).map { max($0, 0) }
            let retryDelay = headerDelay ?? min(2 << attempt, 10)
            if http.statusCode == 503, code == "database_overloaded",
               headerDelay.map({ $0 <= 10 }) ?? true,
               attempt + 1 < maximumAttempts {
                try await Task.sleep(for: .seconds(retryDelay))
                continue
            }
            let serverDetail = string(problem["message"]).isEmpty ? string(json["error"]) : string(problem["message"])
            let detail = code == "database_overloaded"
                ? "Agent Relay is busy. Try again in a moment."
                : (serverDetail.isEmpty ? "Agent Relay returned HTTP \(http.statusCode)" : serverDetail)
            throw RelayAPIError(message: detail, status: http.statusCode, code: code,
                                retryAfterSeconds: headerDelay)
        }
        throw RelayAPIError(message: "Agent Relay is busy. Try again in a moment.", status: 503,
                            code: "database_overloaded")
    }
    private func api(_ path: String, agent: Bool = false, method: String = "GET", body: JSONObject? = nil) async throws -> Any {
        #if DEBUG
        if let fixture = RelayUITestFixture.response(path, method: method, body: body) { return fixture }
        #endif
        guard let token = agent ? agentToken : workspaceKey else {
            throw RelayAPIError(message: "Sign in to Agent Relay")
        }
        guard let url = URL(string: relaycast.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1" + path) else {
            throw RelayAPIError(message: "Invalid Relaycast URL")
        }
        let result: JSONObject
        do {
            result = try await call(url, token: token, method: method, body: body)
        } catch let failure as RelayAPIError where agent && (failure.status == 401 || failure.status == 403) {
            guard let workspaceID = cloudWorkspaceID else { throw failure }
            let person = try await cloudPersonCredential(workspaceID: workspaceID)
            guard person.baseURL == relaycast.trimmingCharacters(in: CharacterSet(charactersIn: "/")) else {
                throw RelayAPIError(message: "Cloud returned a different Relaycast server for this workspace")
            }
            SecureStore.write(person.token, for: "agentToken")
            guard agentToken == person.token else {
                throw RelayAPIError(message: "Could not save your messaging credential")
            }
            UserDefaults.standard.set(person.name, forKey: "relay.mobileName")
            registeredPushToken = nil
            result = try await call(url, token: person.token, method: method, body: body)
        }
        return result["data"] ?? result
    }
    private func cloudCall(_ path: String, token: String? = nil, method: String? = nil, body: JSONObject? = nil) async throws -> JSONObject {
        guard let url = URL(string: cloud + path) else { throw RelayAPIError(message: "Invalid Cloud URL") }
        return try await call(url, token: token, method: method ?? (body == nil ? "GET" : "POST"), body: body)
    }
    private func cloudTokenNeedsRefresh() -> Bool {
        guard let value = SecureStore.read("cloudAccessExpiresAt") else { return true }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expires = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        return expires.map { $0.timeIntervalSinceNow < 60 } ?? true
    }
    private func invalidateCloudRefresh() {
        cloudRefreshTask?.cancel()
        cloudRefreshTask = nil
        cloudRefreshTaskID = nil
    }
    private func refreshCloudToken() async throws -> String {
        guard !signingOut else { throw CancellationError() }
        if let cloudRefreshTask { return try await cloudRefreshTask.value }
        guard let refresh = SecureStore.read("cloudRefreshToken") else {
            throw RelayAPIError(message: "Sign in again to view session summaries")
        }
        let request = CloudCredentialRefresh(sessionGeneration: sessionGeneration, refreshToken: refresh)
        cloudRefreshTaskID = request.id
        let task = Task { try await performCloudRefresh(request) }
        cloudRefreshTask = task
        defer {
            if cloudRefreshTaskID == request.id {
                cloudRefreshTask = nil
                cloudRefreshTaskID = nil
            }
        }
        return try await task.value
    }
    private func requireCurrentRefresh(_ request: CloudCredentialRefresh) throws {
        guard !Task.isCancelled,
              request.isCurrent(requestID: cloudRefreshTaskID, sessionGeneration: sessionGeneration,
                                refreshToken: SecureStore.read("cloudRefreshToken"), signingOut: signingOut) else {
            throw CancellationError()
        }
    }
    private func performCloudRefresh(_ request: CloudCredentialRefresh) async throws -> String {
        try requireCurrentRefresh(request)
        do {
            let result = try await cloudCall("/auth/token/refresh", body: ["refreshToken": request.refreshToken])
            try requireCurrentRefresh(request)
            let access = string(result["accessToken"])
            let nextRefresh = string(result["refreshToken"])
            guard !access.isEmpty, !nextRefresh.isEmpty else {
                throw RelayAPIError(message: "Cloud did not renew the summary credential")
            }
            SecureStore.write(nextRefresh, for: "cloudRefreshToken")
            SecureStore.write(access, for: "cloudAccessToken")
            SecureStore.write(string(result["accessTokenExpiresAt"]), for: "cloudAccessExpiresAt")
            return access
        } catch let failure as RelayAPIError where failure.status == 403 || failure.status == 401 {
            try requireCurrentRefresh(request)
            for key in ["cloudAccessToken", "cloudRefreshToken", "cloudAccessExpiresAt"] { SecureStore.remove(key) }
            summaryCredentialReady = false
            throw RelayAPIError(message: "Sign in again to view session summaries")
        }
    }
    private func authorizedCloudCall(_ path: String, method: String = "GET") async throws -> JSONObject {
        let access: String
        if cloudTokenNeedsRefresh() || SecureStore.read("cloudAccessToken") == nil {
            access = try await refreshCloudToken()
        } else {
            access = SecureStore.read("cloudAccessToken") ?? ""
        }
        do { return try await cloudCall(path, token: access, method: method) }
        catch let failure as RelayAPIError where failure.status == 401 {
            let renewed = try await refreshCloudToken()
            return try await cloudCall(path, token: renewed, method: method)
        }
    }
    private func cloudPersonCredential(workspaceID: String) async throws -> (name: String, token: String, baseURL: String) {
        guard UUID(uuidString: workspaceID) != nil else {
            throw RelayAPIError(message: "No Agent Relay workspace is selected")
        }
        let response = try await authorizedCloudCall(
            "/workspaces/\(workspaceID)/messaging/identity/credential", method: "POST")
        let identity = object(response["identity"])
        let name = string(identity["name"])
        let token = string(identity["token"])
        let base = string(identity["relaycastUrl"])
        let components = URLComponents(string: base)
        guard !name.isEmpty, token.hasPrefix("at_live_"),
              !string(identity["agentId"]).isEmpty,
              components?.scheme == "https", components?.host != nil,
              components?.user == nil, components?.password == nil,
              components?.query == nil, components?.fragment == nil,
              (components?.path.isEmpty == true || components?.path == "/"),
              (components?.port == nil || components?.port == 443) else {
            throw RelayAPIError(message: "Cloud did not return a valid messaging identity")
        }
        return (name, token, base.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }
    func checkConnection() async {
        guard paired, !signingOut else { return }
        if UserDefaults.standard.string(forKey: "relay.messagingIdentitySource") != "cloud" {
            // Existing installations have an agent unique to this device.
            // Upgrade before loading or sending any of its old messages.
            paired = false
            guard SecureStore.read("cloudRefreshToken") != nil else {
                error = "Sign in again to sync Messages with your other devices."
                return
            }
            do {
                try await finishSavedCloudSignIn()
            } catch {
                self.error = error.localizedDescription
            }
            return
        }
        await refresh()
    }
    private func clearPendingCloudGrant() {
        for key in ["cloudPendingDeviceCode", "cloudPendingExpiresAt", "cloudPendingUserCode", "cloudPendingURL"] {
            SecureStore.remove(key)
        }
        verificationURL = nil
        userCode = ""
        signInStatus = ""
    }
    private func pollCloudGrant(code: String, deadline: Date, initialInterval: Int) async throws {
        var interval = initialInterval
        while Date() < deadline {
            try await Task.sleep(for: .seconds(interval))
            let token: JSONObject
            do {
                token = try await cloudCall("/auth/device/token", body: [
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "device_code": code
                ])
            } catch let failure as RelayAPIError {
                if failure.message == "authorization_pending" { continue }
                if failure.message == "slow_down" { interval = min(interval + 5, 60); continue }
                if failure.status == 429 || failure.status == 503 || failure.status == 502 { continue }
                throw failure
            } catch {
                if Task.isCancelled { throw error }
                signInStatus = "Waiting for the connection to return…"
                continue
            }
            guard !string(token["access_token"]).isEmpty else { continue }
            // A successful token response consumes the device code, even if
            // the remaining workspace setup fails and needs a later retry.
            clearPendingCloudGrant()
            try await finishSignIn(token)
            return
        }
        clearPendingCloudGrant()
        throw RelayAPIError(message: "Sign-in expired. Start again.")
    }
    func resumePendingSignIn() async {
        guard !busy, !signingOut else { return }
        busy = true
        defer { busy = false }
        do {
            if let code = SecureStore.read("cloudPendingDeviceCode"),
               let rawDeadline = SecureStore.read("cloudPendingExpiresAt"),
               let timestamp = Double(rawDeadline) {
                let deadline = Date(timeIntervalSince1970: timestamp)
                if deadline > Date() {
                    userCode = SecureStore.read("cloudPendingUserCode") ?? ""
                    verificationURL = SecureStore.read("cloudPendingURL").flatMap(URL.init(string:))
                    signInStatus = "Checking device approval…"
                    try await pollCloudGrant(code: code, deadline: deadline, initialInterval: 5)
                    return
                }
                clearPendingCloudGrant()
            }
            if SecureStore.read("cloudRefreshToken") != nil &&
                (!canLoadSummaries || UserDefaults.standard.string(forKey: "relay.messagingIdentitySource") != "cloud") {
                signInStatus = "Finishing Cloud sign-in…"
                try await finishSavedCloudSignIn()
                signInStatus = ""
            }
        } catch { self.error = error.localizedDescription }
    }
    func beginSignIn() async {
        guard !busy, !signingOut else { return }
        busy = true
        error = nil
        signInStatus = "Starting sign-in…"
        defer { busy = false }
        do {
            let grant = try await cloudCall("/auth/device/start", body: ["client_name": "Agent Relay Mobile"])
            let code = string(grant["device_code"])
            guard !code.isEmpty else { throw RelayAPIError(message: "Sign-in could not start") }
            userCode = string(grant["user_code"])
            let link = string(grant["verification_uri_complete"]).isEmpty
                ? string(grant["verification_uri"]) : string(grant["verification_uri_complete"])
            guard let url = URL(string: link), url.scheme == "https", url.host == "agentrelay.com" else {
                throw RelayAPIError(message: "Cloud returned an invalid sign-in link")
            }
            verificationURL = url
            signInStatus = "Approve this device in your browser"
            let seconds = min(max(grant["expires_in"] as? Int ?? 600, 30), 900)
            let interval = min(max(grant["interval"] as? Int ?? 5, 1), 60)
            let deadline = Date().addingTimeInterval(TimeInterval(seconds))
            SecureStore.write(code, for: "cloudPendingDeviceCode")
            SecureStore.write(String(deadline.timeIntervalSince1970), for: "cloudPendingExpiresAt")
            SecureStore.write(userCode, for: "cloudPendingUserCode")
            SecureStore.write(url.absoluteString, for: "cloudPendingURL")
            try await pollCloudGrant(code: code, deadline: deadline, initialInterval: interval)
        } catch { self.error = error.localizedDescription }
    }
    private func finishSavedCloudSignIn() async throws {
        let access: String
        if cloudTokenNeedsRefresh() || SecureStore.read("cloudAccessToken") == nil {
            access = try await refreshCloudToken()
        } else {
            access = SecureStore.read("cloudAccessToken") ?? ""
        }
        guard let refresh = SecureStore.read("cloudRefreshToken") else { return }
        try await finishSignIn(["access_token": access, "refresh_token": refresh,
                                "access_token_expires_at": SecureStore.read("cloudAccessExpiresAt") ?? ""])
    }
    private func finishSignIn(_ tokens: JSONObject) async throws {
        let cloudToken = string(tokens["access_token"])
        let refreshToken = string(tokens["refresh_token"])
        guard !cloudToken.isEmpty, !refreshToken.isEmpty else {
            throw RelayAPIError(message: "Cloud did not grant persistent access. Start sign-in again.")
        }
        invalidateCloudRefresh()
        // The device code is single-use. Keep the Cloud credential before any
        // workspace lookup or Relaycast registration that might need a retry.
        SecureStore.write(refreshToken, for: "cloudRefreshToken")
        SecureStore.write(cloudToken, for: "cloudAccessToken")
        SecureStore.write(string(tokens["access_token_expires_at"]), for: "cloudAccessExpiresAt")
        guard SecureStore.read("cloudRefreshToken") == refreshToken else {
            throw RelayAPIError(message: "Could not save Cloud access on this device")
        }
        let identity = try await cloudCall("/auth/whoami", token: cloudToken)
        let id = string(object(identity["currentWorkspace"])["id"])
        guard let uuid = UUID(uuidString: id) else { throw RelayAPIError(message: "No Agent Relay workspace is selected") }
        let resolution = try await cloudCall("/workspaces/\(uuid.uuidString.lowercased())/resolve", token: cloudToken)
        let data = object(resolution["data"]).isEmpty ? resolution : object(resolution["data"])
        let key = string(data["relaycastApiKey"])
        guard key.hasPrefix("rk_live_") else { throw RelayAPIError(message: "This workspace has no Relaycast key") }
        let base = string(object(data["urls"])["relaycastUrl"])
        let baseURL = URLComponents(string: base)
        guard base.isEmpty || (
            baseURL?.scheme == "https" && baseURL?.host != nil &&
            baseURL?.user == nil && baseURL?.password == nil &&
            baseURL?.query == nil && baseURL?.fragment == nil &&
            (baseURL?.path.isEmpty == true || baseURL?.path == "/") &&
            (baseURL?.port == nil || baseURL?.port == 443)
        ) else {
            throw RelayAPIError(message: "Invalid Relaycast server")
        }
        // Cloud owns this person's messaging identity. The desktop and web
        // clients use the same credential endpoint, so all three surfaces see
        // the same Relaycast conversations and message history.
        let messagingIdentity = try await cloudPersonCredential(workspaceID: id)
        let resolvedBase = (base.isEmpty ? defaultRelaycast : base)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard messagingIdentity.baseURL == resolvedBase else {
            throw RelayAPIError(message: "Cloud returned a different Relaycast server for this workspace")
        }
        let previousKey = workspaceKey
        let previousURL = SecureStore.read("relaycastURL")
        let previousToken = agentToken
        let previousMobileName = UserDefaults.standard.string(forKey: "relay.mobileName")
        if previousKey != key {
            summaries = [:]
            goals = [:]
        }
        let accountUser = object(identity["user"])
        do {
            if let oldToken = previousToken, oldToken != messagingIdentity.token,
               let oldBase = previousURL ?? (previousKey == nil ? nil : defaultRelaycast),
               let pushToken = RelayPushState.shared.token,
               let oldURL = URL(string: oldBase.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    + "/v1/mobile/push-device") {
                _ = try? await call(oldURL, token: oldToken, method: "DELETE",
                                    body: ["device_token": pushToken, "environment": pushEnvironment])
            }
            SecureStore.write(key, for: "workspaceKey")
            SecureStore.write(messagingIdentity.baseURL, for: "relaycastURL")
            SecureStore.write(messagingIdentity.token, for: "agentToken")
            guard workspaceKey == key, agentToken == messagingIdentity.token,
                  relaycast == messagingIdentity.baseURL else {
                throw RelayAPIError(message: "Could not save the messaging credential")
            }
        } catch {
            if let previousKey { SecureStore.write(previousKey, for: "workspaceKey") }
            else { SecureStore.remove("workspaceKey") }
            if let previousURL { SecureStore.write(previousURL, for: "relaycastURL") }
            else { SecureStore.remove("relaycastURL") }
            if let previousToken { SecureStore.write(previousToken, for: "agentToken") }
            else { SecureStore.remove("agentToken") }
            if let previousMobileName { UserDefaults.standard.set(previousMobileName, forKey: "relay.mobileName") }
            else { UserDefaults.standard.removeObject(forKey: "relay.mobileName") }
            throw error
        }
        if previousToken != messagingIdentity.token || previousURL != messagingIdentity.baseURL {
            resetPeople()
            registeredPushToken = nil
            sessionGeneration += 1
        }
        account = string(accountUser["name"]).isEmpty ? string(accountUser["email"]) : string(accountUser["name"])
        workspace = string(data["name"]).isEmpty ? "Workspace" : string(data["name"])
        UserDefaults.standard.set(account, forKey: "relay.accountName")
        UserDefaults.standard.set(workspace, forKey: "relay.workspaceName")
        UserDefaults.standard.set(messagingIdentity.name, forKey: "relay.mobileName")
        UserDefaults.standard.removeObject(forKey: "relay.mobileIdentity")
        UserDefaults.standard.set("cloud", forKey: "relay.messagingIdentitySource")
        if previousKey != key || previousMobileName != messagingIdentity.name {
            // Clear the installation-specific agent's local view before
            // loading this person's shared conversations.
            refreshGeneration += 1
            conversationRefreshGeneration += 1
            conversationMetadataWorkerID = nil
            conversationAgentMetadata = [:]
            conversationRoster = ConversationRoster()
            conversationAgentRetryAfter = [:]
            latestConversationThreads = []
            conversations = []
            channels = []
            joinedChannels = []
            channelSenders = [:]
            channelSenderRetryAfter = [:]
            recentJoins = [:]
            messages = []
            unreadConversationIDs = []
            hiddenConversationIDs = []
            conversationIDs = [:]
            latestMessageIDs = [:]
            localMessageNotices = LocalMessageNotices()
            latestIncomingMessageIDs = [:]
            conversationsInitialized = false
            selectedConversation = nil
            deliveredMessageIDs = []
        }
        UserDefaults.standard.set(id, forKey: "relay.workspaceID")
        cloudWorkspaceID = id
        summaryCredentialReady = SecureStore.read("cloudRefreshToken") != nil
        paired = true
        await refresh()
    }
    func signOut() async {
        guard !signingOut else { return }
        signingOut = true
        invalidateCloudRefresh()
        resetPeople()
        // Invalidate work before the first suspension point so an in-flight
        // refresh cannot repopulate signed-out state while cleanup awaits.
        refreshGeneration += 1
        sessionGeneration += 1
        conversationRefreshGeneration += 1
        conversationMetadataWorkerID = nil
        if let token = RelayPushState.shared.token {
            _ = try? await api("/mobile/push-device", agent: true, method: "DELETE",
                               body: ["device_token": token, "environment": pushEnvironment])
        }
        registeredPushToken = nil
        await closeTerminal()
        UserDefaults.standard.removeObject(forKey: hiddenConversationsKey)
        for key in ["workspaceKey", "agentToken", "relaycastURL", "cloudAccessToken", "cloudRefreshToken", "cloudAccessExpiresAt",
                    "cloudPendingDeviceCode", "cloudPendingExpiresAt", "cloudPendingUserCode", "cloudPendingURL"] {
            SecureStore.remove(key)
        }
        UserDefaults.standard.removeObject(forKey: "relay.accountName")
        UserDefaults.standard.removeObject(forKey: "relay.workspaceName")
        UserDefaults.standard.removeObject(forKey: "relay.workspaceID")
        UserDefaults.standard.removeObject(forKey: "relay.mobileName")
        UserDefaults.standard.removeObject(forKey: "relay.mobileIdentity")
        UserDefaults.standard.removeObject(forKey: "relay.messagingIdentitySource")
        cloudWorkspaceID = nil
        workspace = "Workspace"
        account = "Agent Relay"
        paired = false
        connected = false
        signingOut = false
        relayAgents = []
        fleetAgents = []
        spawnNodes = []
        conversations = []
        channels = []
        joinedChannels = []
        channelSenders = [:]
        channelSenderRetryAfter = [:]
        recentJoins = [:]
        unreadConversationIDs = []
        hiddenConversationIDs = []
        messages = []
        selectedConversation = nil
        latestMessageIDs = [:]
        localMessageNotices = LocalMessageNotices()
        latestIncomingMessageIDs = [:]
        conversationsInitialized = false
        deliveredMessageIDs = []
        summaries = [:]
        goals = [:]
        summaryCredentialReady = false
        conversationAgentMetadata = [:]
        conversationRoster = ConversationRoster()
        conversationAgentRetryAfter = [:]
        latestConversationThreads = []
    }
    private var pushEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
    func registerPushToken(_ token: String) async {
        guard paired, !signingOut, !token.isEmpty, registeredPushToken != token else { return }
        do {
            _ = try await api("/mobile/push-device", agent: true, method: "PUT",
                              body: ["device_token": token, "environment": pushEnvironment])
            registeredPushToken = token
        } catch {
            NSLog("Agent Relay push token upload failed: %@", error.localizedDescription)
        }
    }

    func refresh() async {
        guard paired, !signingOut else { return }
        refreshGeneration += 1
        let generation = refreshGeneration
        // DM history and presence reconcile independently: a failed node or
        // roster request must not stop messages arriving in an open chat.
        async let messageRefresh: Void = pollMessages(fromRefresh: generation)
        async let channelRefresh: Void = pollChannels(fromRefresh: generation)
        // Photos are optional: an unavailable Cloud endpoint must never block
        // the Relaycast roster, conversation history or messaging.
        peopleRefreshTask?.cancel()
        peopleRefreshTask = Task { await refreshPeople() }
        do {
            async let rosterData = api("/agents?status=all")
            async let nodeData = api("/nodes")
            let roster = try objects(await rosterData)
            guard generation == refreshGeneration, paired else { return }
            applyRoster(roster)
            let nodes = try objects(await nodeData)
            guard generation == refreshGeneration, paired else { return }
            let availableNodes = nodes.compactMap { node -> RelaySpawnNode? in
                guard string(node["status"]) == "online", node["live"] as? Bool != false,
                      node["handlers_live"] as? Bool != false,
                      !(node["tags"] as? [String] ?? []).contains("direct") else { return nil }
                let name = string(node["name"])
                let harnesses = Set(objects(node["capabilities"]).compactMap { capability -> String? in
                    let value = string(capability["name"])
                    guard value.hasPrefix("spawn:"), value.count > 6 else { return nil }
                    return String(value.dropFirst(6))
                })
                guard !name.isEmpty, !harnesses.isEmpty else { return nil }
                return RelaySpawnNode(name: name, harnesses: harnesses.sorted())
            }.sorted { ($0.name.lowercased(), $0.name) < ($1.name.lowercased(), $1.name) }
            var machineKeys: Set<String> = []
            spawnNodes = availableNodes.filter { machineKeys.insert(MobileMachineFilter.key($0.name)).inserted }
            let sessionIDs = Dictionary(relayAgents.map { ($0.name, $0.sessionID) }, uniquingKeysWith: { first, _ in first })
            var live: [RelayAgent] = []
            for node in nodes where string(node["status"]) == "online" &&
                node["live"] as? Bool != false && node["handlers_live"] as? Bool != false &&
                !(node["tags"] as? [String] ?? []).contains("direct") {
                let nodeName = string(node["name"])
                for capability in objects(node["capabilities"]) where string(capability["name"]) == "relay:live-agents:v1" {
                    for name in object(capability["metadata"])["names"] as? [String] ?? [] {
                        live.append(RelayAgent(fleet: ["name": name, "node": nodeName,
                                                       "session_id": sessionIDs[name] ?? "", "workerLiveness": "live"]))
                    }
                }
            }
            fleetAgents = live
            connected = true
            error = nil
        } catch {
            guard generation == refreshGeneration, paired else { return }
            if (error as? RelayAPIError)?.code != "database_overloaded" { connected = false }
            self.error = error.localizedDescription
        }
        await messageRefresh
        await channelRefresh
    }
    private func applyRoster(_ roster: [JSONObject]) {
        let registrations = roster.map(RelayAgent.init(relay:))
        conversationRoster.replace(registrations, excluding: messagingHandle)
        relayAgents = conversationRoster.listedAgents
        // Current registrations replace their cached metadata. Historical
        // lookups stay cached to avoid refetching every old DM peer each poll;
        // conversationRoster alone decides whether an agent is still present.
        for agent in relayAgents {
            conversationAgentMetadata[agent.name] = agent
            conversationAgentRetryAfter.removeValue(forKey: agent.name)
        }
        if conversationsInitialized {
            updateConversations(latestConversationThreads, metadata: conversationAgentMetadata)
        }
    }

    private func resetPeople() {
        peopleRefreshTask?.cancel()
        peopleRefreshTask = nil
        workspacePeople.reset()
    }

    private func refreshPeople() async {
        guard !Task.isCancelled, paired, !signingOut, let workspaceID = cloudWorkspaceID else { return }
        let generation = sessionGeneration
        let request = workspacePeople.begin(workspaceID: workspaceID, sessionGeneration: generation)
        let response: JSONObject
        do {
            #if DEBUG
            if let fixture = RelayUITestFixture.peopleResponse() {
                if RelayUITestFixture.delaysPeople {
                    try await Task.sleep(for: .seconds(10))
                }
                response = fixture
            } else {
                response = try await loadPeople(workspaceID: workspaceID)
            }
            #else
            response = try await loadPeople(workspaceID: workspaceID)
            #endif
        } catch {
            // Includes older Cloud servers, removed membership and expired
            // credentials. Keep initials usable and retry on the next refresh.
            response = [:]
        }
        guard !Task.isCancelled, paired, !signingOut,
              cloudWorkspaceID == workspaceID, sessionGeneration == generation else { return }
        workspacePeople.finish(response, for: request)
    }

    private func loadPeople(workspaceID: String) async throws -> JSONObject {
        guard UUID(uuidString: workspaceID) != nil, hasSavedCloudCredential else { return [:] }
        return try await authorizedCloudCall("/workspaces/\(workspaceID)/messaging/people")
    }

    func personProfile(for agent: RelayAgent) -> WorkspacePerson? {
        guard paired, !signingOut else { return nil }
        return workspacePeople.person(handle: agent.name, isHuman: agent.isHuman,
                                      workspaceID: cloudWorkspaceID, sessionGeneration: sessionGeneration)
    }

    func displayName(for agent: RelayAgent) -> String {
        if agent.source == .channel { return agent.address }
        guard agent.isHuman else { return agent.name }
        let name = personProfile(for: agent)?.displayName ?? ""
        if !name.isEmpty { return name }
        return agent.displayName.isEmpty ? agent.name : agent.displayName
    }

    func pollMessages(fromRefresh refresh: Int? = nil) async {
        guard paired, !signingOut, !Task.isCancelled,
              refresh == nil || refresh == refreshGeneration else { return }
        conversationRefreshGeneration += 1
        let generation = conversationRefreshGeneration
        do {
            let threads = try objects(await api("/dm/conversations", agent: true))
            guard generation == conversationRefreshGeneration else { return }
            latestConversationThreads = threads
            updateConversations(threads, metadata: conversationAgentMetadata)
            Task { await enrichConversationMetadata() }
        } catch {
            // A transient poll failure should not interrupt an open conversation.
        }
    }
    /// Lists workspace channels, marking the ones this person has joined.
    /// A failure keeps the last list, like a failed DM poll.
    func pollChannels(fromRefresh refresh: Int? = nil) async {
        guard paired, !signingOut, !Task.isCancelled,
              refresh == nil || refresh == refreshGeneration else { return }
        let session = sessionGeneration
        let handle = messagingHandle
        do {
            async let listData = api("/channels")
            async let joinedData = channelMemberships(of: handle)
            let list = try objects(await listData)
            // Without the person's own record, keep the memberships last seen.
            let listed = (try? await joinedData) ?? joinedChannels
            guard session == sessionGeneration, paired, !signingOut,
                  refresh == nil || refresh == refreshGeneration else { return }
            let now = Date()
            recentJoins = recentJoins.filter { !listed.contains($0.key) && now.timeIntervalSince($0.value) < 2 * 60 }
            let joined = listed.union(recentJoins.keys)
            joinedChannels = joined
            channels = RelayChannels.list(list, joined: joined)
        } catch {
            // A transient failure should not empty the Channels page.
        }
    }
    private func channelMemberships(of handle: String) async throws -> Set<String> {
        guard !handle.isEmpty else { return [] }
        return RelayChannels.joinedNames(object(try await api("/agents/\(RelayChannels.pathComponent(handle))")))
    }
    @discardableResult
    func joinChannel(_ channel: RelayAgent) async -> Bool {
        guard channel.source == .channel else { return false }
        do {
            try await join(channel.name, session: sessionGeneration)
            await pollChannels()
            return true
        } catch is CancellationError {
            return false
        } catch { self.error = error.localizedDescription; return false }
    }
    /// Joining is idempotent on Relaycast. A join that returns after the
    /// person signed out or switched accounts is dropped.
    private func join(_ name: String, session: Int) async throws {
        try checkSession(session)
        do {
            _ = try await api("/channels/\(RelayChannels.pathComponent(name))/join", agent: true, method: "POST")
        } catch let failure as RelayAPIError where failure.status == 409 {
            // Already a member, as the desktop's Relaycast client also treats it.
        }
        try checkSession(session)
        joinedChannels.insert(name)
        recentJoins[name] = Date()
    }
    /// Who sent a channel message, so it shows their photo or agent artwork.
    func sender(of message: RelayMessage) -> RelayAgent {
        RelayChannels.sender(named: message.sender,
                             in: relayAgents + Array(conversationAgentMetadata.values) + Array(channelSenders.values))
    }
    private func loadChannelSenders(in messages: [RelayMessage]) async {
        let session = sessionGeneration
        let known = Set(relayAgents.map(\.name)).union(conversationAgentMetadata.keys).union(channelSenders.keys)
        let now = Date()
        let missing = Set(messages.filter { !$0.mine && !$0.sender.isEmpty }.map(\.sender))
            .subtracting(known).filter { (channelSenderRetryAfter[$0] ?? .distantPast) <= now }
        for name in missing.sorted().prefix(10) {
            // Retry later, like DM peers, until a lookup succeeds.
            channelSenderRetryAfter[name] = now.addingTimeInterval(5 * 60)
            guard let agent = await loadConversationAgent(named: name), session == sessionGeneration else { continue }
            channelSenders[name] = agent
            channelSenderRetryAfter.removeValue(forKey: name)
        }
    }
    private func conversationPeerNames(in threads: [JSONObject]) -> [String] {
        let mine = UserDefaults.standard.string(forKey: "relay.mobileName") ?? ""
        return Array(Set(threads.compactMap { thread in
            let peer = objects(thread["participants"]).first { string($0["agent_name"]) != mine }
            let name = string(peer?["agent_name"])
            return name.isEmpty ? nil : name
        })).sorted()
    }
    private func loadConversationAgent(named name: String) async -> RelayAgent? {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let encoded = name.addingPercentEncoding(withAllowedCharacters: allowed) ?? name
        guard let data = try? await api("/agents/\(encoded)"),
              !object(data).isEmpty else { return nil }
        return RelayAgent(relay: object(data))
    }
    private func enrichConversationMetadata() async {
        guard conversationMetadataWorkerID == nil, let workspaceID = cloudWorkspaceID else { return }
        let workerID = UUID()
        conversationMetadataWorkerID = workerID
        defer {
            if conversationMetadataWorkerID == workerID {
                conversationMetadataWorkerID = nil
            }
        }
        var attempted: Set<String> = []
        while conversationMetadataWorkerID == workerID && cloudWorkspaceID == workspaceID {
            let now = Date()
            let missing = conversationPeerNames(in: latestConversationThreads).filter {
                conversationAgentMetadata[$0] == nil && !attempted.contains($0) &&
                    (conversationAgentRetryAfter[$0] ?? .distantPast) <= now
            }
            guard !missing.isEmpty else { return }
            await withTaskGroup(of: (String, RelayAgent?).self) { group in
                var next = 0
                let concurrency = min(4, missing.count)
                for _ in 0..<concurrency {
                    let name = missing[next]
                    next += 1
                    group.addTask {
                        let agent = await self.loadConversationAgent(named: name)
                        return (name, agent)
                    }
                }
                while let (name, agent) = await group.next() {
                    attempted.insert(name)
                    guard conversationMetadataWorkerID == workerID,
                          cloudWorkspaceID == workspaceID else {
                        group.cancelAll()
                        continue
                    }
                    if let agent {
                        // A roster refresh may have supplied newer metadata
                        // while this historical lookup was in flight.
                        if conversationAgentMetadata[name] == nil {
                            conversationAgentMetadata[name] = agent
                            updateConversations(latestConversationThreads, metadata: conversationAgentMetadata)
                        }
                        conversationAgentRetryAfter.removeValue(forKey: name)
                    } else {
                        conversationAgentRetryAfter[name] = Date().addingTimeInterval(5 * 60)
                    }
                    if next < missing.count {
                        let nextName = missing[next]
                        next += 1
                        group.addTask {
                            let agent = await self.loadConversationAgent(named: nextName)
                            return (nextName, agent)
                        }
                    }
                }
            }
        }
    }
    private func updateConversations(_ threads: [JSONObject], metadata: [String: RelayAgent]) {
        let mine = UserDefaults.standard.string(forKey: "relay.mobileName") ?? ""
        // Relaycast's unread_count includes this agent's own messages. Keep a
        // device-local cursor for the newest incoming message instead.
        let defaults = UserDefaults.standard
        var seen = defaults.dictionary(forKey: unreadSeenKey) as? [String: String] ?? [:]
        let establishingBaseline = !defaults.bool(forKey: unreadBaselineKey)
        var seenChanged = establishingBaseline
        var ids: [String: String] = [:]
        var latest: [String: String] = [:]
        var latestIncoming: [String: String] = [:]
        var unread: Set<String> = []
        var updated: [RelayAgent] = []
        for thread in threads {
            let conversationID = string(thread["id"])
            let participants = objects(thread["participants"])
            let peer = participants.first { string($0["agent_name"]) != mine }
            let name = string(peer?["agent_name"])
            guard !name.isEmpty else { continue }
            let isCurrentPeer = conversationRoster.includes(name, metadata: metadata[name])
            ids[name] = conversationID
            let last = object(thread["last_message"])
            let messageID = string(last["id"])
            if !messageID.isEmpty { latest[conversationID] = messageID }
            let myID = string(participants.first { string($0["agent_name"]) == mine }?["agent_id"])
            let senderID = string(last["agent_id"])
            let senderName = string(last["agent_name"])
            let incoming = !messageID.isEmpty &&
                (!senderID.isEmpty && !myID.isEmpty ? senderID != myID :
                 !senderName.isEmpty && senderName != mine)
            if incoming {
                latestIncoming[conversationID] = messageID
                if establishingBaseline {
                    if seen[conversationID] != messageID {
                        seen[conversationID] = messageID
                        seenChanged = true
                    }
                } else if seen[conversationID] != messageID {
                    unread.insert("conversation:\(name)")
                }
            }
            if localMessageNotices.shouldPost(conversationID: conversationID, messageID: messageID,
                                              isCurrentPeer: isCurrentPeer,
                                              apnsToken: RelayPushState.shared.token,
                                              initialized: conversationsInitialized,
                                              fromMe: string(last["agent_id"]) == myID) {
                let content = UNMutableNotificationContent()
                // A person shows by name, as in the app; agents by their name.
                let person = metadata[name]
                content.title = person?.isHuman == true && !(person?.displayName.isEmpty ?? true)
                    ? person?.displayName ?? name : name
                content.body = "New message in Agent Relay"
                content.sound = .default
                content.userInfo = ["conversation_id": conversationID]
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: messageID,
                    content: content, trigger: nil))
            }
            var enriched = thread
            enriched["status"] = metadata[name]?.status ?? ""
            enriched["machine"] = metadata[name]?.machine ?? ""
            enriched["session_id"] = metadata[name]?.sessionID ?? ""
            enriched["objective"] = metadata[name]?.objective ?? ""
            enriched["session_title"] = metadata[name]?.sessionTitle ?? ""
            enriched["mobile_handoff_enabled"] = metadata[name]?.mobileHandoffEnabled ?? false
            enriched["cli"] = metadata[name]?.cli ?? ""
            enriched["desktop_registration"] = metadata[name]?.isDesktopRegistration ?? false
            if let handoff = metadata[name]?.mobileHandoff {
                enriched["handoff_metadata"] = ["mobile_handoff_state": handoff.state.rawValue,
                                                "mobile_handoff_error": handoff.detail]
            }
            enriched["is_human"] = metadata[name]?.isHuman ?? false
            enriched["display_name"] = metadata[name]?.displayName ?? ""
            if isCurrentPeer { updated.append(RelayAgent(conversation: enriched)) }
        }
        // A hidden conversation comes back when any newer message arrives, so
        // a reply is never lost behind the swipe, even when this device only
        // sees the person's own later message from another device.
        var hidden = HiddenConversations(defaults.dictionary(forKey: hiddenConversationsKey) as? [String: String] ?? [:])
        if hidden.reveal(newerThan: latest) { defaults.set(hidden.entries, forKey: hiddenConversationsKey) }
        let visibleIDs = Set(updated.map(\.id))
        let hiddenIDs = Set(ids.filter { hidden.contains($0.value) }.map { "conversation:\($0.key)" }).intersection(visibleIDs)
        conversationIDs = ids
        latestMessageIDs = latest
        latestIncomingMessageIDs = latestIncoming
        conversations = updated
        hiddenConversationIDs = hiddenIDs
        unreadConversationIDs = unread.intersection(visibleIDs).subtracting(hiddenIDs)
        if seenChanged { defaults.set(seen, forKey: unreadSeenKey) }
        if establishingBaseline { defaults.set(true, forKey: unreadBaselineKey) }
        conversationsInitialized = true
    }
    /// Hides a conversation from the Messages list on this device only.
    func hideConversation(_ agent: RelayAgent) {
        setConversation(agent, hidden: true)
    }
    func unhideConversation(_ agent: RelayAgent) {
        setConversation(agent, hidden: false)
    }
    private func setConversation(_ agent: RelayAgent, hidden isHidden: Bool) {
        guard agent.source == .conversation, let id = conversationIDs[agent.name], !id.isEmpty else { return }
        let defaults = UserDefaults.standard
        var hidden = HiddenConversations(defaults.dictionary(forKey: hiddenConversationsKey) as? [String: String] ?? [:])
        if isHidden { hidden.hide(id, latestMessageID: latestMessageIDs[id]) } else { hidden.unhide(id) }
        defaults.set(hidden.entries, forKey: hiddenConversationsKey)
        updateConversations(latestConversationThreads, metadata: conversationAgentMetadata)
    }
    func agent(forConversationID id: String) -> RelayAgent? {
        conversations.first { conversationIDs[$0.name] == id }
    }
    func searchRoster(_ query: String, scope: String) async -> [RelayAgent] {
        let lower = query.lowercased()
        let agents = scope == "active" ? relayAgents.filter { $0.isReachable() } : relayAgents
        return agents.filter { lower.isEmpty || $0.name.lowercased().contains(lower) || $0.machine.lowercased().contains(lower) }
    }
    var canLoadSummaries: Bool {
        summaryCredentialReady && cloudWorkspaceID != nil
    }
    var hasSavedCloudCredential: Bool {
        SecureStore.read("cloudRefreshToken") != nil
    }
    private func sessionPath(_ sessionID: String) throws -> String {
        guard let workspaceID = cloudWorkspaceID,
              UUID(uuidString: workspaceID) != nil,
              !sessionID.isEmpty, sessionID.count <= 512 else {
            throw RelayAPIError(message: "Sign in again to view session summaries")
        }
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let encoded = sessionID.addingPercentEncoding(withAllowedCharacters: allowed) ?? sessionID
        return "/workspaces/\(workspaceID)/reflex/sessions/\(encoded)"
    }
    private func summaryPath(_ sessionID: String) throws -> String {
        try sessionPath(sessionID) + "/analysis"
    }
    func loadGoal(for agent: RelayAgent) async {
        let id = agent.sessionID
        guard !id.isEmpty, canLoadSummaries, goals[id] == nil, !loadingGoalIDs.contains(id) else { return }
        loadingGoalIDs.insert(id)
        defer { loadingGoalIDs.remove(id) }
        do {
            let response = try await authorizedCloudCall(try sessionPath(id) + "/events")
            let data = try JSONSerialization.data(withJSONObject: response)
            goals[id] = try SessionGoal.decode(data, sessionID: id) ?? ""
        } catch { /* The generated summary and published objective still work without History events. */ }
    }
    func loadSummary(for agent: RelayAgent) async {
        let id = agent.sessionID
        guard !id.isEmpty, canLoadSummaries, !loadingSummaryIDs.contains(id) else { return }
        loadingSummaryIDs.insert(id)
        defer { loadingSummaryIDs.remove(id) }
        let previous = summaries[id]
        if previous == nil { summaries[id] = SessionOverview(status: .loading) }
        do {
            let data = try await authorizedCloudCall(summaryPath(id))
            let raw = try JSONSerialization.data(withJSONObject: data)
            summaries[id] = try SessionOverview.decode(raw, sessionID: id)
        } catch {
            summaries[id] = SessionOverview(status: .failed, title: previous?.title ?? "",
                                            description: previous?.description ?? "", error: error.localizedDescription)
        }
    }
    func requestSummary(for agent: RelayAgent) async {
        let id = agent.sessionID
        guard !id.isEmpty, canLoadSummaries, summaries[id]?.pending != true else { return }
        do {
            _ = try await authorizedCloudCall(summaryPath(id), method: "POST")
            summaries[id] = SessionOverview(status: .queued, title: summaries[id]?.title ?? "",
                                            description: summaries[id]?.description ?? "")
            await loadSummary(for: agent)
        } catch let failure as RelayAPIError where failure.status == 429 {
            summaries[id] = SessionOverview(status: .failed, title: summaries[id]?.title ?? "",
                                            description: summaries[id]?.description ?? "",
                                            error: "The daily summary limit has been reached. Try again tomorrow.")
        } catch {
            summaries[id] = SessionOverview(status: .failed, title: summaries[id]?.title ?? "",
                                            description: summaries[id]?.description ?? "", error: error.localizedDescription)
        }
    }
    func selectConversation(_ agent: RelayAgent?) {
        let id = agent?.id
        guard selectedConversation != id else { return }
        selectedConversation = id
        messages = []
    }
    /// Push-driven reloads pass `reportsErrors: false` so a flaky
    /// connection doesn't raise an alert the person didn't ask for.
    func loadHistory(for agent: RelayAgent, reportsErrors: Bool = true) async {
        guard selectedConversation == agent.id else { return }
        do {
            let path: String
            var conversationID: String?
            if agent.source == .channel {
                path = "/channels/\(RelayChannels.pathComponent(agent.name))/messages?limit=100"
            } else {
                guard let id = conversationIDs[agent.name], !id.isEmpty else {
                    if selectedConversation == agent.id { messages = [] }
                    return
                }
                conversationID = id
                path = "/dm/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/messages?limit=100"
            }
            let result = try await api(path, agent: true)
            guard selectedConversation == agent.id else { return }
            messages = objects(result).reversed().enumerated().map { RelayMessage($0.element, index: $0.offset) }
            if agent.source == .channel { await loadChannelSenders(in: messages) }
            if let id = conversationID, let incomingID = latestIncomingMessageIDs[id],
               messages.contains(where: { $0.id == incomingID && !$0.mine }) {
                var seen = UserDefaults.standard.dictionary(forKey: unreadSeenKey) as? [String: String] ?? [:]
                if seen[id] != incomingID {
                    seen[id] = incomingID
                    UserDefaults.standard.set(seen, forKey: unreadSeenKey)
                    unreadConversationIDs.remove("conversation:\(agent.name)")
                }
            }
            error = nil
        } catch { if reportsErrors, selectedConversation == agent.id { self.error = error.localizedDescription } }
        await refreshDelivery(for: agent)
    }
    /// Checks whether the latest outgoing message in the open conversation has
    /// reached its recipient. Returns true once it has.
    @discardableResult
    func refreshDelivery(for agent: RelayAgent) async -> Bool {
        guard selectedConversation == agent.id,
              let message = messages.last(where: \.mine), message.hasServerID else { return false }
        if deliveredMessageIDs.contains(message.id) { return true }
        let id = message.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? message.id
        guard let result = try? await api("/messages/\(id)/readers", agent: true) else { return false }
        guard MessageDelivery.delivered(readers: objects(result), sender: message.sender) else { return false }
        deliveredMessageIDs.insert(message.id)
        return true
    }
    /// Only server metadata can describe a handoff; viewing has no side effect.
    func handoffNotice(for agent: RelayAgent) -> MobileHandoffNotice? {
        (conversationAgentMetadata[agent.name] ?? agent).mobileHandoff
    }
    func deliveryLabel(for message: RelayMessage, to agent: RelayAgent) -> String {
        let current = conversationAgentMetadata[agent.name] ?? agent
        return current.deliveryLabel(delivered: deliveredMessageIDs.contains(message.id))
    }
    func send(_ text: String, to agent: RelayAgent) async -> Bool {
        await send(text, attachments: [], to: agent)
    }
    func send(_ text: String, attachments: [RelayAttachment], to agent: RelayAgent) async -> Bool {
        do {
            if agent.source == .channel {
                // Posting needs no membership, but only members are sent the
                // channel's later messages, so the first post joins it.
                let session = sessionGeneration
                if !joinedChannels.contains(agent.name) { try await join(agent.name, session: session) }
                try checkSession(session)
                var body: JSONObject = ["text": text]
                if !attachments.isEmpty { body["attachments"] = attachments.map(\.id) }
                _ = try await api("/channels/\(RelayChannels.pathComponent(agent.name))/messages",
                                  agent: true, method: "POST", body: body)
            } else {
                var body: JSONObject = ["to": agent.name, "text": text]
                if !attachments.isEmpty { body["attachments"] = attachments.map(\.id) }
                _ = try await api("/dm", agent: true, method: "POST", body: body)
            }
            #if DEBUG
            MobileHandoffFixture.trace("post accepted; refreshing")
            #endif
            await refresh()
            #if DEBUG
            MobileHandoffFixture.trace("refresh finished; loading history")
            #endif
            if selectedConversation == agent.id { await loadHistory(for: agent) }
            #if DEBUG
            MobileHandoffFixture.trace("history finished; send completed")
            #endif
            // Delivery usually follows within seconds; check briefly, then
            // leave it to the regular history refresh.
            Task {
                for _ in 0..<10 where selectedConversation == agent.id {
                    if await refreshDelivery(for: agent) { break }
                    try? await Task.sleep(for: .seconds(3))
                }
            }
            return true
        } catch is CancellationError {
            return false
        } catch { self.error = error.localizedDescription; return false }
    }
    private func checkSession(_ generation: Int) throws {
        guard generation == sessionGeneration, paired, !signingOut else { throw CancellationError() }
    }
    func uploadAttachment(from url: URL) async throws -> RelayAttachment {
        let generation = sessionGeneration
        let hasScopedAccess = url.startAccessingSecurityScopedResource()
        defer { if hasScopedAccess { url.stopAccessingSecurityScopedResource() } }

        let values = try url.resourceValues(forKeys: [.fileSizeKey, .nameKey])
        let fileSize = values.fileSize ?? ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.intValue ?? 0
        guard fileSize > 0 else { throw RelayAPIError(message: "This file is empty and can’t be attached") }
        let filename = values.name ?? url.lastPathComponent
        let contentType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let reservation = object(try await api("/files/upload", agent: true, method: "POST", body: [
            "filename": filename,
            "content_type": contentType,
            "size_bytes": fileSize
        ]))
        try checkSession(generation)
        let fileID = string(reservation["id"])
        guard let uploadURL = URL(string: string(reservation["upload_url"])),
              uploadURL.scheme?.lowercased() == "https", !fileID.isEmpty else {
            throw RelayAPIError(message: "Relaycast did not return a valid upload URL")
        }

        var request = URLRequest(url: uploadURL)
        request.httpMethod = "PUT"
        request.timeoutInterval = 180
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.upload(for: request, fromFile: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw RelayAPIError(message: "File upload failed (HTTP \(status))", status: status)
        }
        try checkSession(generation)

        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let encodedID = fileID.addingPercentEncoding(withAllowedCharacters: allowed) ?? fileID
        _ = try await api("/files/\(encodedID)/complete", agent: true, method: "POST")
        try checkSession(generation)
        return RelayAttachment(fileID: fileID, filename: filename, contentType: contentType, sizeBytes: fileSize)
    }
    func downloadURL(for attachment: RelayAttachment) async throws -> URL {
        let generation = sessionGeneration
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let encodedID = attachment.id.addingPercentEncoding(withAllowedCharacters: allowed) ?? attachment.id
        let result = object(try await api("/files/\(encodedID)", agent: true))
        try checkSession(generation)
        guard let url = URL(string: string(result["download_url"])),
              url.scheme?.lowercased() == "https" else {
            throw RelayAPIError(message: "A download link isn’t available for this file")
        }
        return url
    }
    /// Starts a worker on an online node and waits for the node's readiness
    /// receipt. An unconfirmed result means the request was accepted but its
    /// final status could not be observed yet; callers must not submit it again.
    func spawnAgent(on node: RelaySpawnNode, harness: String, name: String,
                    task: String, workingDirectory: String, projectName: String? = nil) async throws -> SpawnOutcome {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let task = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard node.harnesses.contains(harness),
              name.range(of: "^[a-z][a-z0-9-]{1,47}$", options: .regularExpression) != nil,
              !task.isEmpty else {
            throw RelayAPIError(message: "Choose an agent type, enter a valid name, and describe its task")
        }
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let encodedNode = node.name.addingPercentEncoding(withAllowedCharacters: allowed) ?? node.name
        var input: JSONObject = [
            "capability": "spawn:\(harness)", "cli": harness, "node": node.name,
            "target_node": node.name, "name": name, "task": task, "verify_ready": true
        ]
        let folder = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        if !folder.isEmpty {
            guard folder.hasPrefix("/") else { throw RelayAPIError(message: "Working folder must be an absolute path") }
            input["worker_cwd"] = folder
        }
        if let projectName = projectName?.trimmingCharacters(in: .whitespacesAndNewlines), !projectName.isEmpty {
            input["project"] = projectName
        }
        let accepted: JSONObject
        do {
            accepted = object(try await api("/nodes/\(encodedNode)/actions/spawn/invoke",
                                            agent: true, method: "POST", body: ["input": input]))
        } catch let error as RelayAPIError {
            throw RelayAPIError(message: SpawnFailure.message(error.message, node: node.name, name: name, harness: harness),
                                status: error.status, code: error.code)
        }
        let invocationID = string(accepted["invocation_id"])
        guard !invocationID.isEmpty else {
            throw RelayAPIError(message: "The start request did not return a receipt. Check Agents before trying again.")
        }
        let encodedID = invocationID.addingPercentEncoding(withAllowedCharacters: allowed) ?? invocationID
        // Some nodes start the worker but never complete the receipt, so the
        // node's live-agent list also counts as proof that the agent is up.
        for attempt in 1...60 {
            try await Task.sleep(for: .seconds(2))
            if attempt % 5 == 0 {
                await refresh()
                if fleetAgents.contains(where: { $0.name == name && $0.node == node.name }) { return .running }
            }
            let receipt: JSONObject
            do {
                receipt = object(try await api("/actions/spawn/invocations/\(encodedID)", agent: true))
            } catch {
                // A dropped poll does not mean the start failed; keep waiting.
                continue
            }
            switch string(receipt["status"]) {
            case "completed":
                let output = object(receipt["output"])
                guard output["spawned"] as? Bool == true,
                      output["ready"] as? Bool != false else {
                    throw RelayAPIError(message: SpawnFailure.message(string(output["error"]), node: node.name,
                                                                      name: name, harness: harness))
                }
                await refresh()
                return .ready
            case "failed", "cancelled", "canceled":
                throw RelayAPIError(message: SpawnFailure.message(string(receipt["error"]), node: node.name,
                                                                  name: name, harness: harness))
            default: break
            }
        }
        await refresh()
        if fleetAgents.contains(where: { $0.name == name && $0.node == node.name }) { return .running }
        return .unconfirmed
    }
    /// Stops a broker-owned worker through the node that reported it as live.
    /// A request without a final receipt is left unconfirmed so the caller
    /// does not claim success or automatically submit a duplicate release.
    func releaseAgent(_ agent: RelayAgent) async -> Bool {
        guard agent.source == .drive, !agent.node.isEmpty, !agent.name.isEmpty else {
            error = "Only a live agent with a known node can be released here"
            return false
        }
        do {
            let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
            let node = agent.node.addingPercentEncoding(withAllowedCharacters: allowed) ?? agent.node
            let accepted = object(try await api("/nodes/\(node)/actions/release/invoke", agent: true,
                                                method: "POST", body: ["input": ["name": agent.name]]))
            let invocationID = string(accepted["invocation_id"])
            guard !invocationID.isEmpty else {
                throw RelayAPIError(message: "Release request had no receipt. Check Agents before trying again.")
            }
            let encodedID = invocationID.addingPercentEncoding(withAllowedCharacters: allowed) ?? invocationID
            for _ in 0..<30 {
                try await Task.sleep(for: .seconds(2))
                let receipt: JSONObject
                do {
                    receipt = object(try await api("/actions/release/invocations/\(encodedID)", agent: true))
                } catch {
                    throw RelayAPIError(message: "Release was requested, but its result is not available yet. Check Agents before trying again.")
                }
                switch string(receipt["status"]) {
                case "completed":
                    let output = object(receipt["output"])
                    guard output["released"] as? Bool == true else {
                        throw RelayAPIError(message: string(output["error"]).isEmpty ? "The agent did not stop" : string(output["error"]))
                    }
                    await refresh()
                    return true
                case "failed", "cancelled", "canceled":
                    let detail = string(receipt["error"])
                    throw RelayAPIError(message: detail.isEmpty ? "The agent did not stop" : detail)
                default: break
                }
            }
            throw RelayAPIError(message: "Release was requested, but its result is not available yet. Check Agents before trying again.")
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
    func attach(_ agent: RelayAgent, mode: String) async {
        guard agent.attachable else { error = "This agent is not available for attach"; return }
        do {
            await closeTerminal()
            let node = agent.node.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agent.node
            let result = try await api("/nodes/\(node)/terminal/sessions", method: "POST", body: ["agent": agent.name, "mode": mode])
            let data = object(result)
            let id = string(data["session_id"])
            guard var components = URLComponents(string: string(data["terminal_url"])),
                  ["wss", "https"].contains(components.scheme ?? ""),
                  components.host != nil, !id.isEmpty else {
                throw RelayAPIError(message: "Relaycast did not return a terminal session")
            }
            // Relaycast tickets use an HTTPS URL; URLSession requires the WebSocket scheme.
            if components.scheme == "https" { components.scheme = "wss" }
            guard let url = components.url else { throw RelayAPIError(message: "Invalid terminal URL") }
            attachedID = id
            attachedMode = mode
            terminalEnded = false
            terminalBacklog = ""
            screenHistory = []
            lastScreenCapture = .distantPast
            terminalSessionID = id
            let socket = URLSession.shared.webSocketTask(with: url)
            terminalSocket = socket
            socket.resume()
            terminalTask = Task { await streamTerminal(socket, id: id) }
        } catch { self.error = error.localizedDescription }
    }
    private func streamTerminal(_ socket: URLSessionWebSocketTask, id: String) async {
        do {
            while !Task.isCancelled && attachedID == id {
                let incoming = try await socket.receive()
                let raw: Data
                switch incoming {
                case .string(let text): raw = Data(text.utf8)
                case .data(let data): raw = data
                @unknown default: continue
                }
                guard let frame = (try? JSONSerialization.jsonObject(with: raw)) as? JSONObject,
                      string(frame["session_id"]) == id else { continue }
                switch string(frame["type"]) {
                case "terminal.ready", "terminal.snapshot":
                    let data = Data(base64Encoded: string(frame["screen"])) ?? Data()
                    if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                        terminalBacklog = output
                        onTerminalOutput?(output)
                    }
                case "terminal.output":
                    let output = string(frame["chunk"])
                    terminalBacklog = String((terminalBacklog + output).suffix(200_000))
                    onTerminalOutput?(output)
                case "terminal.closed":
                    terminalEnded = true
                    return
                default: break
                }
            }
        } catch {
            if !Task.isCancelled && attachedID == id {
                terminalEnded = true
                self.error = error.localizedDescription
            }
        }
    }
    private func socketSend(_ frame: JSONObject) async {
        guard let socket = terminalSocket,
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        do { try await socket.send(.string(text)) }
        catch { self.error = error.localizedDescription }
    }
    func terminalInput(_ text: String, raw: Bool = false) async {
        guard let id = terminalSessionID, attachedMode == "drive" else { return }
        let value = raw ? text : text + "\n"
        await socketSend(["type": "terminal.input", "session_id": id, "data_base64": Data(value.utf8).base64EncodedString()])
    }
    func resizeTerminal(cols: Int, rows: Int) async {
        guard let id = terminalSessionID else { return }
        await socketSend(["type": "terminal.resize", "session_id": id, "cols": cols, "rows": rows])
    }
    func closeTerminal() async {
        terminalTask?.cancel()
        terminalTask = nil
        if let id = terminalSessionID {
            await socketSend(["type": "terminal.close", "session_id": id])
        }
        terminalSocket?.cancel(with: .normalClosure, reason: nil)
        terminalSocket = nil
        terminalSessionID = nil
        attachedID = nil
        attachedMode = nil
        onTerminalOutput = nil
        onTerminalScroll = nil
    }
}
