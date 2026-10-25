import AppKit
import RelayDesktopCore
import SwiftUI

/// One global header; Settings alone adds contextual navigation below it.
struct WorkspaceShell<Content: View>: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var relay: RelayModel
    @ObservedObject var updater: AppUpdater
    let confirmUpdate: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var localSessionCount: Int?


    var body: some View {
        VStack(spacing: 0) {
            globalHeader
            Divider().hidden().overlay(CloudTheme.border)
            HStack(spacing: 0) {
                if model.page.section == .settings {
                    sidebar
                    Divider().hidden().overlay(CloudTheme.border)
                }
                VStack(spacing: 0) {
                    if model.page.section == .settings || (model.page != .sessions && model.selectedLocalSession == nil) {
                        topBar
                        Divider().hidden().overlay(CloudTheme.border)
                    }
                    content()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider().hidden().overlay(CloudTheme.border)
            statusBar
        }
        .task {
            while !Task.isCancelled {
                await model.refreshRequestLog()
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { break }
            }
        }
        .onPreferenceChange(LocalSessionCountPreference.self) { localSessionCount = $0 }
        .overlay(alignment: .bottomTrailing) {
            if let upgrade = model.relaycastUpgrade {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Label(upgrade.title, systemImage: "exclamationmark.triangle")
                            .font(.headline)
                        Spacer()
                        Button { model.dismissRelaycastUpgrade() } label: {
                            Image(systemName: "xmark")
                        }.buttonStyle(.plain).accessibilityLabel("Dismiss upgrade notice")
                    }
                    Text(upgrade.message).font(.subheadline)
                    Button(RelaycastUpgrade.action) { model.openRelaycastBilling() }
                        .buttonStyle(AgentRelayPrimaryButtonStyle())
                }
                .padding(16)
                .frame(width: 360)
                .background {
                    RoundedRectangle(cornerRadius: 12).fill(.regularMaterial).shadow(radius: 8)
                }
                .padding(.trailing, 20)
                .padding(.bottom, 44)
            }
        }
    }

    // MARK: Global header

    private func currentTitleRow(_ row: LocalSessionRow) -> LocalSessionRow {
        model.sessionSearchSource.rows(model: model, relay: relay).values.first { $0.id == row.id } ?? row
    }

    private var globalHeader: some View {
        HStack(spacing: 20) {
            Button { model.showLocalSessions() } label: {
                HStack(spacing: 10) {
                    BrandMarkView(width: 24)
                    BrandWordmarkView(height: 19)
                        .foregroundStyle(CloudTheme.foreground)
                }.frame(height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Sessions")
            if model.page.section != .settings && model.selectedLocalSession == nil {
                SessionHeaderSearch(relay: relay)
            } else if model.page.section != .settings, let row = model.selectedLocalSession {
                HStack(spacing: 12) {
                    backToSessionsButton
                    Divider().frame(height: 28).overlay(CloudTheme.border)
                    AgentIconView(source: row.source, size: 26)
                    VStack(alignment: .leading, spacing: 3) {
                        SessionTitleEditor(state: relay.titleState(for: currentTitleRow(row)),
                            preload: { relay.preloadTitle(row) },
                            save: { title in Task { await relay.setSessionTitle(title, for: currentTitleRow(row)) } })
                            .id(row.id)
                        Text([AgentIconView.name(for: row.source), row.project, "Local transcript"]
                            .filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.system(size: 11)).foregroundStyle(CloudTheme.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }.frame(maxWidth: .infinity, alignment: .leading)
            } else {
                backToSessionsButton
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                if model.page.section != .settings && model.selectedLocalSession == nil {
                    SavedSessionViewControls()
                    SessionColumnSettings(layout: $model.sessionColumns, grouping: $model.sessionGrouping, showHidden: $model.showHiddenSessions)
                }
                HeaderAccountButton(relay: relay, updater: updater)
            }
        }
        .padding(.horizontal, 24)
        .frame(height: 64)
        .background(CloudTheme.sidebar)
    }

    private var backToSessionsButton: some View {
        Button { model.showLocalSessions() } label: {
            Label("Back to sessions", systemImage: "chevron.left")
        }
        .buttonStyle(CloudControlStyle(flat: true, height: 32))
        .fixedSize().help("Back to sessions")
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    settingsSidebar
                }
                .padding(10)
            }
        }
        .frame(width: 244)
        .background(CloudTheme.sidebar)
    }

    @ViewBuilder private var settingsSidebar: some View {
        ForEach(Array(SettingsPane.groups.enumerated()), id: \.offset) { index, group in
            sectionTitle(group.title).padding(.top, index == 0 ? 0 : 14)
            ForEach(group.panes) { pane in
                sidebarRow(pane.title, symbol: pane.symbol, selected: model.page == .settings(pane),
                           badge: pane == .about && updater.state.isAvailable ? "Update" : nil) {
                    model.page = .settings(pane)
                }
            }
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.system(size: 11, weight: .medium))
            .foregroundStyle(CloudTheme.secondary).padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func sidebarRow(_ title: String, symbol: String? = nil, icon: AnyView? = nil, selected: Bool = false,
                            count: Int? = nil, live: Bool = false, badge: String? = nil,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Group {
                    if let icon { icon } else if let symbol { Image(systemName: symbol) }
                }
                .frame(width: 18)
                Text(title).lineLimit(1).foregroundStyle(selected ? CloudTheme.selectedText : CloudTheme.foreground)
                Spacer(minLength: 4)
                if let badge {
                    Circle().fill(CloudTheme.primary).frame(width: 6, height: 6)
                        .accessibilityLabel(badge + " available")
                        .help(badge + " available")
                }
                if let count {
                    HStack(spacing: 4) {
                        if live { Circle().fill(CloudTheme.success).frame(width: 5, height: 5) }
                        Text(count.formatted()).font(.caption.monospacedDigit())
                    }
                    .foregroundStyle(CloudTheme.secondary)
                }
            }
            .font(.system(size: 13, weight: selected ? .medium : .regular))
            .padding(.horizontal, 10).frame(height: 34)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(NavButtonStyle(kind: .sidebar, isSelected: selected))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(model.page.title).font(.system(size: 15, weight: .semibold))
                    if let scope = scopeLabel {
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(CloudTheme.secondary.opacity(0.7))
                        Text(scope).font(.system(size: 15)).foregroundStyle(CloudTheme.secondary)
                    }
                }
                .lineLimit(1)
                Text(model.page.subtitle).font(.system(size: 12)).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(model.page.subtitle)
            }
            Spacer(minLength: 12)
            if model.page == .agents || model.page == .team {
                Button {
                    if let url = SessionNavigation.cloudURL(siteURL: model.siteURL, sessionId: "_")?.deletingLastPathComponent() { NSWorkspace.shared.open(url) }
                } label: { Label("Open Cloud", systemImage: "arrow.up.right") }
                .buttonStyle(NavButtonStyle(kind: .icon))
                .help("View sessions from every machine in Cloud")
            }
        }
        .padding(.horizontal, 28).frame(height: 64)
    }

    /// The sidebar filter in effect, when it narrows the page.
    private var scopeLabel: String? {
        switch model.page {
        case .agents: return model.agentScope == .all ? nil : model.agentScope.rawValue
        case .sessions: return nil
        case .team:
            guard let hash = model.teamPerson else { return nil }
            if hash == TeamSelection.unowned { return "Other live agents" }
            return relay.teammates.first { $0.identityHash == hash }?.name
        default: return nil
        }
    }

    // MARK: Status bar

    private var statusProblems: [String] { model.appStatusProblems }

    private var statusBar: some View {
        HStack(spacing: 4) {
            Button {
                model.openAppStatus()
            } label: {
                HStack(spacing: 6) {
                    Circle().fill(model.requestFailure == nil && statusProblems.isEmpty ? model.uploadStatusColor : CloudTheme.warning).frame(width: 6, height: 6)
                    Text(model.requestFailure?.failureSummary ?? (statusProblems.isEmpty ? model.uploadStatusText : "Needs attention")).lineLimit(1)
                }
                .padding(.horizontal, 8).frame(height: 22)
            }
            .buttonStyle(NavButtonStyle(kind: .icon))
            .accessibilityIdentifier("app-status")
            .accessibilityLabel("App status")
            .help(model.requestFailure != nil || !statusProblems.isEmpty ? "View in Diagnostics" : "App status · Show my sessions")
            if let count = localSessionCount {
                Text("\(count) \(count == 1 ? "session" : "sessions") on this machine")
                    .foregroundStyle(CloudTheme.secondary)
                    .padding(.horizontal, 8)
                if model.isPreparingSessionList || model.phase == .preparingSessions {
                    ProgressView().controlSize(.mini)
                    Text("Preparing history…").foregroundStyle(CloudTheme.secondary)
                }
            }
            if updater.state.isAvailable {
                Button(action: confirmUpdate) {
                    Image(systemName: "arrow.down.to.line")
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(NavButtonStyle(kind: .icon))
                .foregroundStyle(CloudTheme.primary)
                .help("Update available")
                .accessibilityLabel("Update available")
            }
            Button {
                Task { await model.setPaused(!model.isPaused) }
            } label: {
                Image(systemName: model.isPaused ? "play.fill" : "pause.fill").font(.system(size: 9))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(NavButtonStyle(kind: .icon))
            .disabled(!model.canTogglePause)
            .accessibilityLabel(model.isPaused ? "Resume messages and uploads" : "Pause messages and uploads")
            .help(model.isPaused ? "Resume messages and uploads" : "Pause messages and uploads")
            Spacer(minLength: 8)
            Button { model.showLocalSessions(search: "is:active is:on-relay") } label: {
                Label("Live Agents on Relay: \(relay.sessions.filter { $0.live && $0.registration != nil }.count)", systemImage: "dot.radiowaves.left.and.right")
                    .padding(.horizontal, 8).frame(height: 22)
            }
            .buttonStyle(NavButtonStyle(kind: .icon))
            .help("Show live sessions on the relay")

        }
        .font(.system(size: 11))
        .padding(.horizontal, 6).frame(height: 28)
        .background(CloudTheme.card)
    }

    private var connection: WorkspaceConnection { WorkspaceConnection(model: model, relay: relay) }
}

/// Whether messages and uploads can flow, shown by the header's account dot.
struct WorkspaceConnection {
    let label: String
    let color: Color
    let help: String
    let isHealthy: Bool

    @MainActor
    init(model: AppModel, relay: RelayModel) {
        if let problem = model.coreProblem {
            self.init("Needs attention", CloudTheme.warning, problem)
        } else if model.core != nil && !model.isCoreConnected {
            self.init("Reconnecting", CloudTheme.warning, "Agent Relay is reconnecting to its background service.")
        } else if model.isPaused {
            self.init("Paused", CloudTheme.warning, "Agents don't receive messages and nothing uploads.")
        } else if let problem = model.relayProblem(relay) {
            self.init("Needs attention", CloudTheme.warning, problem)
        } else if relay.workspace == nil {
            self.init("No relay workspace", CloudTheme.warning, "Connect a workspace in Settings › Messages.")
        } else if model.phase == .preparingSessions {
            self.init("Preparing sessions", .accentColor, "Reading your local history.")
        } else if model.phase != .attached {
            self.init("Not connected", CloudTheme.warning, "Agent Relay is not connected to its background service.")
        } else {
            self.init("Connected", CloudTheme.success, "Signed in and connected to your workspace.", healthy: true)
        }
    }

    private init(_ label: String, _ color: Color, _ help: String, healthy: Bool = false) {
        self.label = label
        self.color = color
        self.help = help
        isHealthy = healthy
    }
}

extension RelayModel {
    /// The live sessions: what My agents lists. An ended session keeps its
    /// registration, so a reopened Codex thread is back on the relay with its
    /// name and queued messages, but it is not listed until then. A Grok TUI
    /// row exists only while the TUI runs; without a leader it is not live
    /// yet, and is listed so it can be added once leader mode is on. An
    /// OpenCode window opened before the plugin was on is listed the same
    /// way, as needing a restart.
    var listedSessions: [LocalSession] {
        sessionsByRecency.filter { $0.live || $0.target.kind == .grokOpen || $0.needsOpenCodeRestart }
    }

    func count(of scope: MyAgentScope) -> Int {
        switch scope {
        case .all: return listedSessions.count + brokers.flatMap(\.workers).count + rosterGroups.mine.count
        case .onRelay: return listedSessions.filter { $0.registration != nil }.count
        case .offRelay: return listedSessions.filter { $0.registration == nil }.count
        case .fleet: return brokers.flatMap(\.workers).count
        case .elsewhere: return rosterGroups.mine.count
        }
    }
}

extension AppUpdateState {
    var isAvailable: Bool { if case .available = self { return true }; return false }
}

struct HeaderAccountButton: View {
    @ObservedObject var relay: RelayModel
    @ObservedObject var updater: AppUpdater
    @EnvironmentObject private var model: AppModel
    @State private var isShowingMenu = false
    @State private var isConfirmingLogOut = false
    @State private var isConfirmingWorkspaceSignOut = false

    private var name: String { model.accountName?.trimmingCharacters(in: .whitespaces).nilIfBlank ?? email }
    private var email: String { model.accountEmail?.trimmingCharacters(in: .whitespaces).nilIfBlank ?? "Signed in" }
    private var connection: WorkspaceConnection { WorkspaceConnection(model: model, relay: relay) }

    var body: some View {
        Button { isShowingMenu.toggle() } label: {
            ZStack(alignment: model.hasMultipleWorkspaces ? .topLeading : .center) {
                if model.hasMultipleWorkspaces {
                    PersonAvatar(name: model.workspaceName, url: model.workspaceAvatarURL.flatMap(URL.init(string:)), size: 26, cornerRadius: 6)
                        .accessibilityHidden(true)
                }
                PersonAvatar(name: name, url: model.accountAvatarURL.flatMap(URL.init(string:)), size: model.hasMultipleWorkspaces ? 28 : 30)
                    .background(Circle().fill(CloudTheme.sidebar).padding(-2))
                    .overlay(alignment: .bottomTrailing) {
                        Circle().fill(connection.color).frame(width: 8, height: 8)
                            .background(Circle().fill(CloudTheme.sidebar).padding(-2))
                    }
                    .offset(x: model.hasMultipleWorkspaces ? 12 : 0, y: model.hasMultipleWorkspaces ? 12 : 0)
            }
                .frame(width: 40, height: 40)
                .padding(6)
        }
        .buttonStyle(NavButtonStyle(kind: .icon, isSelected: isShowingMenu))
        .help("Signed in as \(email)")
        .accessibilityLabel("Account: signed in as \(email)")
        .popover(isPresented: $isShowingMenu, arrowEdge: .bottom) {
            HeaderAccountMenu(model: model, updater: updater, connection: connection,
                              name: name, email: email, isShowingMenu: $isShowingMenu,
                              isConfirmingLogOut: $isConfirmingLogOut,
                              isConfirmingWorkspaceSignOut: $isConfirmingWorkspaceSignOut)
        }
        .confirmationDialog("Sign out to switch workspace?", isPresented: $isConfirmingWorkspaceSignOut) {
            Button("Sign out", role: .destructive) { Task { await model.disconnect() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Uploads stop and stay tied to \(model.workspaceName). Sign back in to that workspace to resume without uploading existing history again.")
        }
        .confirmationDialog("Log out of Agent Relay?", isPresented: $isConfirmingLogOut) {
            Button("Log out", role: .destructive) { Task { await model.disconnect() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Uploads stop and you will need to sign in again to reconnect.")
        }
    }
}

struct HeaderAccountMenu: View {
    @ObservedObject var model: AppModel
    @ObservedObject var updater: AppUpdater
    let connection: WorkspaceConnection
    let name: String
    let email: String
    @Binding var isShowingMenu: Bool
    @Binding var isConfirmingLogOut: Bool
    @Binding var isConfirmingWorkspaceSignOut: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                PersonAvatar(name: name, url: model.accountAvatarURL.flatMap(URL.init(string:)), size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    if model.accountName != nil { Text(name).font(.callout.weight(.semibold)) }
                    Text(email).font(.caption).foregroundStyle(CloudTheme.secondary).textSelection(.enabled)
                }
            }
            .padding(.bottom, 4)
            HStack(spacing: 6) {
                Circle().fill(connection.color).frame(width: 6, height: 6)
                Text(connection.isHealthy ? "Signed in · \(model.workspaceName)" : connection.help)
                    .lineLimit(2)
            }
            .font(.caption).foregroundStyle(CloudTheme.secondary)
            Divider().hidden().overlay(CloudTheme.border).padding(.vertical, 4)
            if model.hasMultipleWorkspaces {
                Button {
                    isShowingMenu = false
                    isConfirmingWorkspaceSignOut = true
                } label: {
                    Label("Switch workspace…", systemImage: "square.stack.3d.up")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(MenuPanelButtonStyle(kind: .quiet))
                .disabled(!model.canLogOut)
                Divider().hidden().overlay(CloudTheme.border).padding(.vertical, 4)
            }
            Button {
                isShowingMenu = false
                model.page = .settings(.general)
            } label: {
                Label("Settings…", systemImage: "gearshape").frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(MenuPanelButtonStyle(kind: .quiet))
            if updater.state.isAvailable {
                Button {
                    isShowingMenu = false
                    model.page = .settings(.about)
                } label: {
                    Label("Update available", systemImage: "arrow.down.circle")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(MenuPanelButtonStyle(kind: .quiet))
            }
            Button(role: .destructive) {
                isShowingMenu = false
                isConfirmingLogOut = true
            } label: {
                Label("Log out…", systemImage: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(CloudTheme.danger).frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(MenuPanelButtonStyle(kind: .quiet))
            .disabled(!model.canLogOut)
        }
        .padding(14)
        .frame(width: 270, alignment: .leading)
    }
}

private extension String {
    var nilIfBlank: String? { isEmpty ? nil : self }
}
