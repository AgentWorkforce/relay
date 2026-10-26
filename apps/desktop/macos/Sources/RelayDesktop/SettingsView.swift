import AppKit
import RelayDesktopCore
import SwiftUI

// MARK: - Panes

/// One Settings pane, chosen in the sidebar.
struct SettingsPaneView: View {
    let pane: SettingsPane
    @EnvironmentObject private var model: AppModel
    @ObservedObject var updater = AppUpdater.shared
    @State private var pendingMode: SharingMode?
    @State private var isConfirmingMode = false

    private var isConnected: Bool { model.phase == .attached || model.phase == .preparingSessions }

    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    switch pane {
                    case .general: general
                    case .opening: SessionOpeningSettingsSection()
                    case .relay: relay
                    case .sharing:
                        sharing
                    case .account:
                        AccountSettingsSection()
                    case .about:
                        SettingsSection(
                            title: "Software updates",
                            description: "Check for new signed and notarized Agent Relay releases."
                        ) {
                            SoftwareUpdateSettingsRow(updater: updater)
                        }
                    case .diagnostics:
                        RequestDiagnosticsView()
                        TroubleshootingSettingsSection()
                        AboutDiagnosticsView()
                    }
                }
                .frame(maxWidth: pane == .diagnostics ? .infinity : 720, alignment: .leading)
                .padding(28)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onAppear {
                if let id = model.selectedRequest?.id { scroll.scrollTo(id, anchor: .top) }
            }
            .onChange(of: model.selectedRequest?.id) { id in
                if let id { withAnimation { scroll.scrollTo(id, anchor: .top) } }
                else if !model.appStatusProblems.isEmpty { scroll.scrollTo("app-problems", anchor: .top) }
            }
        }
        .id(pane)
        .buttonStyle(SettingsActionStyle())
        .foregroundStyle(CloudTheme.foreground)
        .sheet(isPresented: $isConfirmingMode) {
            SharingConfirmationSheet(
                mode: pendingMode ?? model.sharingMode,
                onCancel: {
                    pendingMode = nil
                    isConfirmingMode = false
                },
                onConfirm: { mode in
                    pendingMode = nil
                    isConfirmingMode = false
                    Task {
                        await model.setSharingMode(mode)
                    }
                }
            )
        }
    }

    @ViewBuilder private var general: some View {
        AppearanceSettingsSection()
        SettingsSection(title: "Startup") {
            VStack(spacing: 0) {
                if LoginItem.isAvailable {
                    SettingsToggleRow(
                        title: "Open at login",
                        detail: model.keepsAgentsConnectedAfterQuit
                            ? "Show Agent Relay in the menu bar when you log in. Your agents stay connected either way."
                            : "Show Agent Relay in the menu bar when you log in. Your agents connect when it opens.",
                        systemImage: "power",
                        notice: model.loginItemNeedsApproval
                            ? "Allow Agent Relay in System Settings › General › Login Items."
                            : nil,
                        isOn: Binding(
                            get: { model.launchAtLogin },
                            set: { model.setLaunchAtLogin($0) }
                        )
                    )
                    SettingsDivider()
                }

                SettingsToggleRow(
                    title: "Keep agents connected after quitting",
                    detail: "When off, quitting Agent Relay disconnects your agents and stops uploads until you open it again.",
                    systemImage: "bolt.horizontal.circle",
                    isOn: Binding(
                        get: { model.keepsAgentsConnectedAfterQuit },
                        set: { model.setKeepsAgentsConnectedAfterQuit($0) }
                    )
                )

                if model.coreNeedsApproval {
                    SettingsDivider()
                    BackgroundServiceRow()
                }
            }
        }
        SettingsSection(title: "Privacy") {
            SettingsToggleRow(
                    title: "Share diagnostics",
                    detail: "Send feature usage and error categories, linked to your Agent Relay account after sign-in. They never contain message or session text, searches, paths, URLs, credentials or raw errors. Turning this off stops all of it.",
                    systemImage: "waveform.path.ecg",
                    notice: model.settingErrors["analytics_enabled"],
                    isPending: model.isSettingPending("analytics_enabled"),
                    isOn: Binding(
                        get: { model.analyticsEnabled },
                        set: { model.setAnalyticsEnabled($0) }
                    )
                )
        }
        if let days = model.settings?.historyRetentionDays {
            SettingsSection(title: HistoryRetentionCopy.section) {
                HistoryRetentionRow(
                    days: days,
                    uploadsHeld: !isConnected || model.isPaused,
                    notice: model.settingErrors["history_retention_days"],
                    isPending: model.isSettingPending("history_retention_days"),
                    set: { value in Task { await model.setSetting(SettingsChange(historyRetentionDays: value)) } }
                )
            }
        }
    }

    @ViewBuilder private var relay: some View {
        if isConnected {
            RelaySettingsSection(relay: model.relay)
            ClaudeDeliverySettings(delivery: model.claudeDelivery)
        }
        SettingsSection(title: "Joining the relay") {
            SettingsToggleRow(
                title: "Let sessions put themselves on the relay",
                detail: "Allow a supported local agent session to register only itself through the private desktop socket.",
                systemImage: "person.badge.plus",
                notice: model.settingErrors["allow_self_registration"],
                isPending: model.isSettingPending("allow_self_registration"),
                isOn: Binding(
                    get: { model.settings?.allowSelfRegistration ?? true },
                    set: { value in Task { await model.setSetting(SettingsChange(allowSelfRegistration: value)) } }
                )
            )
        }
        if model.settings?.acceptSpawns != nil {
            SpawnSettingsSection()
        }
        if let folders = model.settings?.claudeConfigDirs {
            ClaudeFoldersSection(folders: folders)
        }
        if model.phase == .attached {
            IncomingMessagesSettings(incoming: model.incoming)
        }
    }

    @ViewBuilder private var sharing: some View {
        if model.phase == .attached {
            SettingsSection(
                title: "Upload policy",
                description: "Shared sessions are visible to your workspace. Sessions you put on the relay are always shared."
            ) {
                VStack(spacing: 0) {
                    ForEach(Array(SharingMode.displayOrder.enumerated()), id: \.element) { index, mode in
                        if index > 0 {
                            SettingsDivider(leadingInset: 52)
                        }

                        // The chosen policy moves at once and the rows stay
                        // usable: a later choice wins over one still saving.
                        UploadPolicyRow(
                            mode: mode,
                            isSelected: model.sharingMode == mode,
                            isPending: model.isChangingSharingMode && model.sharingMode == mode
                        ) {
                            guard mode != model.sharingMode else { return }
                            pendingMode = mode
                            isConfirmingMode = true
                        }
                    }
                    if let error = model.sessionActionError {
                        SettingsDivider()
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote).foregroundStyle(CloudTheme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(16)
                    }
                }
            }
        } else {
            SettingsSection(title: "Upload policy") {
                SettingsUnavailableRow(
                    title: model.phase == .preparingSessions
                        ? "Finding your sessions"
                        : "Sign in to manage uploads",
                    detail: model.phase == .preparingSessions
                        ? "Upload settings will be available when session preparation finishes."
                        : "Connect Agent Relay to choose which sessions are uploaded."
                )
            }
        }
        DisclosureGroup("Upload details") { UploadStagesView().padding(.top, 12) }
            .font(.system(size: 13, weight: .medium))
    }
}

/// Agent Relay starting agents here, headless. Whether teammates may spawn
/// here, the maximum, and a full-access row for each harness the spawn node
/// offers that has the setting, as the core describes it, show only while
/// spawns are accepted.
private struct SpawnSettingsSection: View {
    @EnvironmentObject private var model: AppModel

    private var accepts: Bool { model.settings?.acceptSpawns ?? false }

    private var offered: [HarnessDescriptor] {
        SpawnCopy.fullAccessHarnesses(model.core?.spawn)
    }

    var body: some View {
        SettingsSection(title: SpawnCopy.title, description: SpawnCopy.description) {
            VStack(spacing: 0) {
                SettingsToggleRow(
                    title: SpawnCopy.acceptTitle,
                    detail: SpawnCopy.acceptDetail,
                    systemImage: "sparkles.rectangle.stack",
                    notice: model.settingErrors["accept_spawns"] ?? (accepts ? SpawnCopy.statusLine(model.core?.spawn) : nil),
                    noticeIsStatus: model.settingErrors["accept_spawns"] == nil && SpawnCopy.statusIsHealthy(model.core?.spawn),
                    isPending: model.isSettingPending("accept_spawns"),
                    isOn: Binding(
                        get: { accepts },
                        set: { value in Task { await model.setSetting(SettingsChange(acceptSpawns: value)) } }
                    )
                )
                if accepts {
                    SettingsDivider()
                    SettingsToggleRow(
                        title: SpawnCopy.teammatesTitle,
                        detail: SpawnCopy.teammatesDetail,
                        systemImage: "person.2",
                        notice: SpawnCopy.claimLine(model.core?.spawn?.claim),
                        noticeIsStatus: model.core?.spawn?.claim?.state == .claimed,
                        noticeAction: SpawnCopy.claimCanRetry(model.core?.spawn?.claim)
                            ? (SpawnCopy.claimRetry, { Task { await model.retrySpawnClaim() } })
                            : nil,
                        isPending: model.isSettingPending("spawn_allow_teammates"),
                        isOn: Binding(
                            get: { model.settings?.spawnAllowTeammates ?? false },
                            set: { value in Task { await model.setSetting(SettingsChange(spawnAllowTeammates: value)) } }
                        )
                    )
                    SettingsDivider()
                    SpawnMaxAgentsRow(
                        value: model.settings?.spawnMaxAgents ?? SpawnCopy.maxAgentsDefault,
                        set: { value in await model.setSetting(SettingsChange(spawnMaxAgents: value)) }
                    )
                    ForEach(offered, id: \.id) { harness in
                        SettingsDivider()
                        SettingsToggleRow(
                            title: SpawnCopy.fullAccessTitle(harness),
                            detail: SpawnCopy.fullAccessDetail(harness),
                            systemImage: "lock.open",
                            notice: SpawnCopy.fullAccessChange(harness.id, true).fields.compactMap { model.settingErrors[$0] }.first,
                            isPending: SpawnCopy.fullAccessChange(harness.id, true).fields.contains(where: model.isSettingPending),
                            isOn: fullAccess(harness)
                        )
                    }
                }
            }
        }
    }

    private func fullAccess(_ harness: HarnessDescriptor) -> Binding<Bool> {
        Binding(
            get: { SpawnCopy.fullAccess(model.settings, harness) },
            set: { value in
                Task { await model.setSetting(SpawnCopy.fullAccessChange(harness.id, value)) }
            }
        )
    }
}

/// The field always returns to the last confirmed cap after a failed write.
@MainActor
final class SpawnCapEditor: ObservableObject {
    @Published var draft = ""
    @Published private(set) var error: String?
    @Published private(set) var saving = false
    private var confirmed = 0

    func confirm(_ value: Int) {
        confirmed = value
        draft = value == 0 ? "" : String(value)
    }

    func commit(set: (Int) async -> String?) async {
        guard !saving else { return }
        guard let next = SpawnCopy.maxAgentsInput(draft) else {
            confirm(confirmed)
            return
        }
        guard next != confirmed else { return }
        saving = true
        error = await set(next)
        if error != nil { confirm(confirmed) }
        saving = false
    }
}

/// How many spawned agents may run here at once.
private struct SpawnMaxAgentsRow: View {
    let value: Int
    let set: (Int) async -> String?
    @StateObject private var editor = SpawnCapEditor()

    private func commit() {
        Task { await editor.commit(set: set) }
    }

    private var capField: some View {
        TextField(SpawnCopy.noLimit, text: $editor.draft)
        .textFieldStyle(.roundedBorder)
        .frame(width: 100)
        .monospacedDigit()
        .onSubmit { commit() }
        .onAppear { editor.confirm(value) }
        .onChange(of: value) { next in editor.confirm(next) }
        .disabled(editor.saving)
        .accessibilityLabel(SpawnCopy.maxAgentsTitle)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: "square.stack.3d.up")

            VStack(alignment: .leading, spacing: 4) {
                Text(SpawnCopy.maxAgentsTitle)
                    .font(.body.weight(.medium))
                Text(SpawnCopy.maxAgentsDetail)
                    .font(.footnote)
                    .foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let error = editor.error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }

            Spacer(minLength: 20)

            capField
            Button("Save", action: commit)
                .buttonStyle(AgentRelayPrimaryButtonStyle())
                .controlSize(.small)
                .disabled(editor.saving)
        }
        .padding(16)
        .accessibilityElement(children: .contain)
    }
}

/// How long this computer keeps local session history, with the warning a
/// choice shorter than the default gets (Linux's `history_retention_row`).
struct HistoryRetentionRow: View {
    let days: Int
    /// Signed out or uploads paused: any limit can remove what has not uploaded.
    var uploadsHeld = false
    var notice: String? = nil
    var isPending = false
    let set: (Int) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: "clock.arrow.circlepath")

            VStack(alignment: .leading, spacing: 4) {
                Text(HistoryRetentionCopy.title)
                    .font(.body.weight(.medium))
                Text(HistoryRetentionCopy.detail)
                    .font(.footnote)
                    .foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let warning = HistoryRetentionCopy.warning(days, uploadsHeld: uploadsHeld) {
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(CloudTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                }
                if let notice {
                    Label(notice, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(CloudTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                }
            }

            Spacer(minLength: 20)

            if isPending {
                ProgressView().controlSize(.small)
                    .accessibilityLabel("Saving")
            }
            Picker(HistoryRetentionCopy.title, selection: Binding(
                get: { days },
                set: { next in if next != days { set(next) } }
            )) {
                ForEach(HistoryRetentionCopy.choices, id: \.self) { choice in
                    Text(HistoryRetentionCopy.label(choice)).tag(choice)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(width: 170)
            .accessibilityLabel(HistoryRetentionCopy.title)
            .disabled(true)
        }
        .padding(16)
        .accessibilityElement(children: .contain)
    }
}

/// Light, dark, or match macOS.
private struct AppearanceSettingsSection: View {
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system

    var body: some View {
        SettingsSection(title: "Appearance", description: "Match system follows macOS, including its automatic light and dark schedule.") {
            HStack(spacing: 12) {
                ForEach(AppAppearance.allCases) { option in
                    AppearanceOption(option: option, isSelected: appearance == option) {
                        appearance = option
                    }
                }
            }
            .padding(16)
        }
        .onChange(of: appearance) { $0.apply() }
    }
}

private struct AppearanceOption: View {
    let option: AppAppearance
    let isSelected: Bool
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                preview
                    .frame(height: 74)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(isSelected ? CloudTheme.primary : Color.primary.opacity(hovered ? 0.3 : 0.12),
                                      lineWidth: isSelected ? 2.5 : 1))
                    .scaleEffect(hovered && !isSelected ? 1.02 : 1)
                HStack(spacing: 6) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : option.symbol)
                        .foregroundStyle(isSelected ? CloudTheme.primary : .secondary)
                    Text(option.title).font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .onHover { hovered = $0 }
        .animation(.easeOut(duration: 0.12), value: hovered)
        .accessibilityLabel(option.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder private var preview: some View {
        switch option {
        case .light: miniWindow(dark: false)
        case .dark: miniWindow(dark: true)
        case .system:
            HStack(spacing: 0) {
                miniWindow(dark: false)
                miniWindow(dark: true)
            }
        }
    }

    /// A tiny drawing of the window: rail, sidebar and content.
    private func miniWindow(dark: Bool) -> some View {
        let base = CloudTheme.previewBackground(dark: dark)
        let panel = CloudTheme.previewPanel(dark: dark)
        let line = CloudTheme.previewBorder(dark: dark)
        return HStack(spacing: 0) {
            panel.frame(width: 12)
            VStack(alignment: .leading, spacing: 5) {
                Capsule().fill(CloudTheme.primary.opacity(0.7)).frame(width: 22, height: 5)
                Capsule().fill(line).frame(width: 18, height: 4)
                Capsule().fill(line).frame(width: 20, height: 4)
                Spacer(minLength: 0)
            }
            .padding(6)
            .frame(width: 34, alignment: .leading)
            .background(panel.opacity(0.6))
            VStack(alignment: .leading, spacing: 5) {
                Capsule().fill(line).frame(height: 5)
                RoundedRectangle(cornerRadius: 3).fill(panel).frame(height: 14)
                RoundedRectangle(cornerRadius: 3).fill(panel).frame(height: 14)
                Spacer(minLength: 0)
            }
            .padding(6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(base)
    }
}

private struct SoftwareUpdateSettingsRow: View {
    @ObservedObject var updater: AppUpdater
    @State private var isConfirmingUpdate = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 14) {
                SettingsIcon(systemImage: stateIcon)

                VStack(alignment: .leading, spacing: 4) {
                    Text(headline)
                        .font(.body.weight(.medium))
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(detailColor)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 20)

                if updater.isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.top, 7)
                }

                Button(actionTitle) { performAction() }
                    .disabled(updater.isBusy)
                    .buttonStyle(SettingsActionStyle(prominent: updater.state.isAvailable))
                    .controlSize(.regular)
                    .fixedSize()
            }
            .padding(16)

            SettingsDivider()

            SettingsToggleRow(
                title: "Automatically check for updates",
                detail: "Check once a day while Agent Relay is running. You choose when to install an available update.",
                systemImage: "clock.arrow.circlepath",
                isOn: $updater.automaticallyChecksForUpdates
            )
        }
        .confirmationDialog("Update Agent Relay now?", isPresented: $isConfirmingUpdate) {
            if case let .available(release) = updater.state {
                Button("Update") { Task { await updater.downloadAndInstall(release) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Agent Relay will quit to install the update, interrupting active uploads. Uploads resume when the app reopens.")
        }
    }

    private var headline: String {
        switch updater.state {
        case .idle: return "Agent Relay"
        case .checking: return "Checking for updates…"
        case .upToDate: return "Agent Relay is up to date"
        case let .available(release), let .downloading(release), let .installing(release):
            return "Agent Relay \(release.version) is available"
        case .unavailable: return "Updates unavailable"
        case .failed: return "Update failed"
        }
    }

    private var detail: String {
        switch updater.state {
        case .idle:
            return "You’re running version \(AppInfo.version)."
        case .checking:
            return "Looking for the latest stable release."
        case let .upToDate(date):
            return "Version \(AppInfo.version) is the latest release. Checked \(date.formatted(date: .omitted, time: .shortened))."
        case .available:
            return "Install this update and reopen Agent Relay."
        case .downloading:
            return "Downloading and verifying the update…"
        case .installing:
            return "Preparing the update. Agent Relay will reopen when installation finishes."
        case let .unavailable(message), let .failed(message):
            return message
        }
    }

    private var detailColor: Color {
        if case .failed = updater.state { return .red }
        return CloudTheme.secondary
    }

    private var stateIcon: String {
        switch updater.state {
        case .upToDate: return "checkmark.circle"
        case .available, .downloading, .installing: return "arrow.down.circle"
        case .failed: return "exclamationmark.triangle"
        default: return "arrow.triangle.2.circlepath"
        }
    }

    private var actionTitle: String {
        switch updater.state {
        case .available: return "Update"
        case .downloading: return "Downloading…"
        case .installing: return "Installing…"
        case .checking: return "Checking…"
        default: return "Check now"
        }
    }

    private func performAction() {
        switch updater.state {
        case .available:
            isConfirmingUpdate = true
        default:
            Task { await updater.checkForUpdates() }
        }
    }
}

struct SettingsSection<Content: View>: View {
    let title: String
    let description: String?
    let content: Content

    init(
        title: String,
        description: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.description = description
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                if let description {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(CloudTheme.card)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(CloudTheme.border)
                }
        }
    }
}

private struct SettingsToggleRow: View {
    let title: String
    let detail: String
    let systemImage: String
    var notice: String? = nil
    /// A notice that reports how things stand rather than a problem.
    var noticeIsStatus = false
    /// A button under the notice that acts on it, such as Retry.
    var noticeAction: (title: String, run: () -> Void)? = nil
    /// The switch shows the state asked for while the core saves it.
    var isPending = false
    @Binding var isOn: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: systemImage)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.medium))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let notice {
                    Label(notice, systemImage: noticeIsStatus ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(noticeIsStatus ? CloudTheme.secondary : CloudTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                }
                if let noticeAction {
                    Button(noticeAction.title, action: noticeAction.run)
                        .buttonStyle(AgentRelayPrimaryButtonStyle())
                        .padding(.top, 4)
                }
            }

            Spacer(minLength: 20)

            if isPending {
                ProgressView().controlSize(.small)
                    .accessibilityLabel("Saving")
            }
            Toggle(title, isOn: $isOn)
                .labelsHidden()
                .toggleStyle(SwitchToggleStyle(tint: CloudTheme.settingsAction))
                .actionCursor()
                .controlSize(.regular)
                .padding(.top, 2)
        }
        .padding(16)
        .accessibilityElement(children: .contain)
    }
}

private struct UploadPolicyRow: View {
    let mode: SharingMode
    let isSelected: Bool
    /// Chosen, and the uploader has not confirmed it yet.
    var isPending = false
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 14) {
                Group {
                    if isPending {
                        ProgressView().controlSize(.small)
                            .accessibilityLabel("Saving")
                    } else {
                        Image(systemName: isSelected ? "checkmark.circle.fill" : (hovered ? "circle.inset.filled" : "circle"))
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(isSelected ? CloudTheme.primary : Color.secondary.opacity(0.7))
                    }
                }
                .frame(width: 24, height: 24)

                VStack(alignment: .leading, spacing: 4) {
                    Text(mode.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(CloudTheme.foreground)
                    Text(mode.explanation)
                        .font(.footnote)
                        .foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 12)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? CloudTheme.primary.opacity(0.08) : Color.primary.opacity(hovered ? 0.04 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .onHover { hovered = $0 }
        .animation(.easeOut(duration: 0.12), value: hovered)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
    }
}

private struct SettingsUnavailableRow: View {
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: "arrow.up.circle")
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.medium))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }
}

private struct SettingsIcon: View {
    let systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 16, weight: .regular))
            .foregroundStyle(CloudTheme.secondary)
            .frame(width: 24, height: 28)
            .accessibilityHidden(true)
    }
}

private struct SettingsDivider: View {
    var leadingInset: CGFloat = 54

    var body: some View {
        Divider().hidden().overlay(CloudTheme.border)
            .padding(.leading, leadingInset)
    }
}

struct SharingConfirmationSheet: View {
    var mode: SharingMode
    var onCancel: () -> Void
    var onConfirm: (SharingMode) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(mode.confirmationTitle)
                .font(.headline)
            Text(mode.explanation)
                .fixedSize(horizontal: false, vertical: true)
            Text("Changing this rebuilds the upload queue and can take a few minutes. Previously uploaded data is not deleted.")
                .font(.footnote)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(mode.confirmationAction) {
                    onConfirm(mode)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(AgentRelayPrimaryButtonStyle())
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

// MARK: - Claude Code folders

/// Every Claude Code config folder whose sessions this computer finds and
/// uploads, and why; folders added here can be removed here.
private struct ClaudeFoldersSection: View {
    let folders: [ClaudeConfigDir]
    @EnvironmentObject private var model: AppModel
    @State private var error: String?

    var body: some View {
        SettingsSection(title: ClaudeFolders.title, description: ClaudeFolders.detail) {
            VStack(spacing: 0) {
                ForEach(Array(folders.enumerated()), id: \.element.path) { index, folder in
                    if index > 0 { SettingsDivider() }
                    HStack(alignment: .center, spacing: 14) {
                        SettingsIcon(systemImage: "folder")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ClaudeFolders.displayPath(folder.path, home: NSHomeDirectory()))
                                .font(.body.weight(.medium))
                                .textSelection(.enabled)
                                .help(folder.path)
                            Text(ClaudeFolders.rowDetail(folder))
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 12)
                        if ClaudeFolders.isRemovable(folder) {
                            Button(ClaudeFolders.removeLabel) {
                                set(ClaudeFolders.removing(folder.path, from: folders))
                            }
                        }
                        Toggle(ClaudeFolders.shareHelp, isOn: Binding(
                            get: { folder.shared },
                            set: { share(folder.path, $0) }
                        ))
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .help(ClaudeFolders.shareHelp)
                    }
                    .padding(16)
                }
                if let cloud = model.settings?.claudeCloudSessions {
                    SettingsDivider()
                    HStack(alignment: .center, spacing: 14) {
                        SettingsIcon(systemImage: "cloud")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ClaudeFolders.cloudTitle).font(.body.weight(.medium))
                            Text(ClaudeFolders.cloudDetail)
                                .font(.footnote).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 12)
                        Toggle(ClaudeFolders.cloudTitle, isOn: Binding(
                            get: { cloud },
                            set: { on in
                                Task { error = await model.setSetting(SettingsChange(claudeCloudSessions: on)) }
                            }
                        ))
                        .toggleStyle(.switch)
                        .labelsHidden()
                    }
                    .padding(16)
                }
                SettingsDivider()
                HStack(spacing: 8) {
                    if let error {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Button(ClaudeFolders.addLabel) { chooseFolder() }
                        .help(ClaudeFolders.addHelp)
                }
                .padding(16)
            }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory())
        guard panel.runModal() == .OK, let url = panel.url else { return }
        set(ClaudeFolders.adding(url.path, to: folders))
    }

    private func set(_ added: [String]) {
        Task { error = await model.setSetting(SettingsChange(claudeConfigDirs: added)) }
    }

    private func share(_ path: String, _ shared: Bool) {
        Task {
            error = await model.setSetting(SettingsChange(claudeConfigDir: ClaudeConfigDirChange(path: path, shared: shared)))
        }
    }
}

// MARK: - Relay

/// The relay workspace sessions join, and how Claude Code takes relayed
/// messages.
private struct RelaySettingsSection: View {
    @ObservedObject var relay: RelayModel
    @EnvironmentObject private var model: AppModel
    @State private var isConfirmingInbound = false
    @State private var isConfirmingGrokLeader = false
    @State private var inboundError: String?
    @State private var grokLeaderError: String?
    @State private var openCodePluginError: String?
    @State private var openClawError: String?
    @State private var trustedSendersText = ""
    @State private var trustedSendersError: String?
    @State private var hermesError: String?
    @State private var devinDeliveryError: String?
    @State private var codexStopHookError: String?
    @State private var showRelayMessagesError: String?
    @State private var autoJoinGeneralError: String?
    @State private var claudeSessionHookError: String?

    var body: some View {
        SettingsSection(
            title: "Relay",
            description: "Sessions you put on the relay get a name anyone in this workspace can message."
        ) {
            VStack(spacing: 0) {
                workspaceRow
                if relay.sessions.contains(where: { $0.target.kind == .claudeTerminal }) {
                    SettingsDivider()
                    claudeInboundRow
                }
                if model.settings?.claudeSessionHook != nil {
                    SettingsDivider()
                    claudeSessionHookRow
                }
                if model.settings?.grokLeader != nil {
                    SettingsDivider()
                    grokLeaderRow
                }
                if model.settings?.opencodePlugin != nil {
                    SettingsDivider()
                    openCodePluginRow
                }
                if model.settings?.openclawGateway != nil {
                    SettingsDivider()
                    openClawRow
                }
                if model.settings?.openclawGateway == true {
                    SettingsDivider()
                    OpenClawToolsRowView()
                }

                if model.settings?.hermesAgent != nil {
                    SettingsDivider()
                    hermesRow
                }
                if model.settings?.openclawGateway == true || model.settings?.hermesAgent == true,
                   model.settings?.trustedRelaySenders != nil {
                    SettingsDivider()
                    trustedSendersRow
                }
                if model.settings?.devinDirectDelivery != nil {
                    SettingsDivider()
                    devinDeliveryRow
                }
                if model.settings?.codexStopHook != nil {
                    SettingsDivider()
                    codexStopHookRow
                }
                if model.settings?.mobileClaudeHandoff != nil {
                    SettingsDivider()
                    SettingsToggleRow(
                        title: MobileClaudeHandoffCopy.title,
                        detail: model.settings?.mobileClaudeHandoffSupported == true ? MobileClaudeHandoffCopy.detail : MobileClaudeHandoffCopy.unavailable,
                        systemImage: "iphone",
                        notice: model.settingErrors["mobile_claude_handoff"],
                        isPending: model.isSettingPending("mobile_claude_handoff"),
                        isOn: Binding(
                            get: { model.settings?.mobileClaudeHandoff == true },
                            set: { value in Task { await model.setSetting(SettingsChange(mobileClaudeHandoff: value)) } }
                        )
                    ).disabled(model.settings?.mobileClaudeHandoffSupported != true)
                }
                if model.settings?.showRelayMessages != nil {
                    SettingsDivider()
                    showRelayMessagesRow
                }
                if model.settings?.autoJoinGeneral != nil {
                    SettingsDivider()
                    autoJoinGeneralRow
                }
                if let changes = model.settings?.agentChanges, !changes.isEmpty {
                    SettingsDivider()
                    agentChangesRow(changes)
                }
            }
        }
    }

    private var workspaceRow: some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: relay.workspace == nil ? "antenna.radiowaves.left.and.right.slash" : "dot.radiowaves.left.and.right")
            VStack(alignment: .leading, spacing: 4) {
                Text(relay.workspace == nil ? "No relay workspace" : "Workspace from your Agent Relay account")
                    .font(.body.weight(.medium))
                Text(relay.workspace == nil
                     ? "Connect uses your Agent Relay sign-in."
                     : "Uploads and messages use this workspace. Switch workspaces from the account menu.")
                    .font(.footnote).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let error = relay.workspaceConnectError { notice(error, color: .red) }
                if let error = relay.storeError { notice(error, color: .red) }
                if let error = relay.integrationError { notice(error, color: .orange) }
                if let error = relay.deliveryError { notice(error, color: .orange) }
                if relay.isConnectingWorkspace || relay.workspace == nil {
                    HStack(spacing: 8) {
                        if relay.isConnectingWorkspace {
                            ProgressView().controlSize(.small)
                            Button("Cancel") { relay.cancelConnectWorkspace() }
                        } else {
                            Button("Connect Workspace") {
                                Task { await relay.connectWorkspace() }
                            }
                            .disabled(model.workspaceID == nil)
                            .help("Fetch this workspace's relay key with your Agent Relay sign-in")
                        }
                    }
                    .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    private var claudeInboundRow: some View {
        let direct = model.settings?.directDelivery == true
        let managed = model.settings?.directDeliveryManaged
        let isManaged = managed != nil && managed != "accept"
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: direct ? "checkmark.seal" : "hand.raised")
            VStack(alignment: .leading, spacing: 4) {
                Text("Claude Code delivery").font(.body.weight(.medium))
                Group {
                    if direct {
                        Text("Relayed messages arrive directly: `crossSessionInbound` is `accept` in your Claude settings.")
                    } else if isManaged {
                        Text(LocalizedStringKey(InboundDefault.managedDetail(managed ?? "")))
                    } else {
                        Text("Sessions that skip permission prompts hold relayed messages for your approval. Deliver directly to let them arrive the way Codex messages do.")
                    }
                }
                .font(.footnote).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                if let error = inboundError ?? model.inboundDefaultError { notice(error, color: .red) }
            }
            Spacer(minLength: 12)
            if direct {
                if managed == nil {
                    Button("Ask Again") { setDirect(false) }
                        .help("Set crossSessionInbound to hold in your Claude settings")
                }
            } else if !isManaged {
                Button("Deliver Directly…") { isConfirmingInbound = true }
            }
        }
        .padding(16)
        .confirmationDialog("Deliver relayed messages to Claude Code without asking?", isPresented: $isConfirmingInbound) {
            Button("Deliver directly") { setDirect(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This adds \"crossSessionInbound\": \"accept\" to ~/.claude/settings.json. Every local Claude Code session will then show messages from other sessions and programs, including Agent Relay, without holding them for approval. Claude Code still labels them and never lets them change permissions. Your current file is kept as settings.json.relay-desktop-backup.")
        }
    }

    private func setDirect(_ enabled: Bool) {
        Task { inboundError = await model.setSetting(SettingsChange(directDelivery: enabled)) }
    }

    /// Grok's `[cli] use_leader`. A plain Grok session opens no route in;
    /// one on the shared leader can be listed and messaged like a Claude
    /// Code or Codex session.
    private var grokLeaderRow: some View {
        let enabled = model.settings?.grokLeader == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.seal" : "bolt.horizontal.circle")
            VStack(alignment: .leading, spacing: 4) {
                Text("Grok sessions").font(.body.weight(.medium))
                Group {
                    if enabled {
                        Text("Grok runs its sessions on a shared leader: `use_leader` is `true` in your Grok config. Sessions you open in Grok appear here and can be messaged.")
                    } else {
                        Text("A plain Grok session has no way in. Turn on leader mode so sessions you open in Grok appear here and can be messaged, the way Claude Code and Codex sessions are.")
                    }
                }
                .font(.footnote).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                if let grokLeaderError { notice(grokLeaderError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setGrokLeader(false) }
                    .help("Set use_leader = false in your Grok config")
            } else {
                Button("Turn On Leader Mode…") { isConfirmingGrokLeader = true }
            }
        }
        .padding(16)
        .confirmationDialog("Run Grok sessions on a shared leader?", isPresented: $isConfirmingGrokLeader) {
            Button("Turn on leader mode") { setGrokLeader(true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This sets use_leader = true under [cli] in ~/.grok/config.toml. Grok sessions you open afterwards run on a shared `grok agent leader` process, which stays running after you close Grok and is what Agent Relay delivers through. Sessions already open are not affected until you restart them. Grok refuses leader mode when a sandbox profile is on. Your current file is kept as config.toml.relay-desktop-backup.")
        }
    }

    private func setGrokLeader(_ enabled: Bool) {
        Task { grokLeaderError = await model.setSetting(SettingsChange(grokLeader: enabled)) }
    }

    /// Agent Relay's OpenCode plugin. A plain OpenCode session opens no
    /// port; with the plugin, each OpenCode window can be listed and
    /// messaged like a Claude Code or Codex session.
    private var openCodePluginRow: some View {
        let enabled = model.settings?.opencodePlugin == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.seal" : "bolt.horizontal.circle")
            VStack(alignment: .leading, spacing: 4) {
                Text("OpenCode sessions").font(.body.weight(.medium))
                Group {
                    if enabled {
                        Text("Agent Relay's plugin is in ~/.config/opencode/plugins/agent-relay.js. OpenCode sessions you open appear here and can be messaged. Restart OpenCode windows that were open before it was on.")
                    } else {
                        Text("A plain OpenCode session has no way in. Turn this on to add Agent Relay's plugin, so sessions you open in OpenCode appear here and can be messaged, the way Claude Code and Codex sessions are.")
                    }
                }
                .font(.footnote).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                if let openCodePluginError { notice(openCodePluginError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setOpenCodePlugin(false) }
                    .help("Remove Agent Relay's plugin from OpenCode")
            } else {
                Button("Turn On") { setOpenCodePlugin(true) }
                    .help("Add Agent Relay's plugin to OpenCode")
            }
        }
        .padding(16)
    }

    private func setOpenCodePlugin(_ enabled: Bool) {
        Task { openCodePluginError = await model.setSetting(SettingsChange(opencodePlugin: enabled)) }
    }

    /// The agents of the person's OpenClaw Gateway. Agent Relay connects to
    /// it on this computer; each relay sender gets a session of its own on
    /// the agent, and its answer goes back to the sender only.
    private var openClawRow: some View {
        let enabled = model.settings?.openclawGateway == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.seal" : "bolt.horizontal.circle")
            VStack(alignment: .leading, spacing: 4) {
                Text(OpenClawCopy.title).font(.body.weight(.medium))
                Group {
                    if enabled {
                        Text(OpenClawCopy.onDetail)
                    } else {
                        Text(OpenClawCopy.offDetail)
                    }
                }
                .font(.footnote).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                // A Gateway older than 2026.8.1 cannot make relay sessions
                // answer-only: said while it is on.
                if enabled, let version = model.settings?.openclawUnlimitedVersion {
                    notice(OpenClawCopy.unlimitedNotice(version), color: .orange)
                }
                if let openClawError { notice(openClawError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setOpenClaw(false) }
                    .help(OpenClawCopy.turnOffHelp)
            } else {
                Button("Turn On") { setOpenClaw(true) }
                    .help(OpenClawCopy.turnOnHelp)
            }
        }
        .padding(16)
    }

    private func setOpenClaw(_ enabled: Bool) {
        Task { openClawError = await model.setSetting(SettingsChange(openclawGateway: enabled)) }
    }

    /// The relay senders trusted like the person: their messages reach the
    /// person's own OpenClaw and Hermes instead of an answer-only session.
    private var trustedSendersRow: some View {
        let saved = (model.settings?.trustedRelaySenders ?? []).joined(separator: ", ")
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: "person.badge.shield.checkmark")
            VStack(alignment: .leading, spacing: 6) {
                Text(TrustedSendersCopy.title).font(.body.weight(.medium))
                Text(TrustedSendersCopy.detail)
                    .font(.footnote).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                TextField(TrustedSendersCopy.placeholder, text: $trustedSendersText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { saveTrustedSenders() }
                if let trustedSendersError { notice(trustedSendersError, color: .red) }
            }
            Spacer(minLength: 12)
            Button("Save") { saveTrustedSenders() }
                .disabled(TrustedSendersCopy.senders(from: trustedSendersText) == TrustedSendersCopy.senders(from: saved))
        }
        .padding(16)
        .onAppear { trustedSendersText = saved }
        .onChange(of: saved) { value in trustedSendersText = value }
    }

    private func saveTrustedSenders() {
        let senders = TrustedSendersCopy.senders(from: trustedSendersText)
        Task {
            trustedSendersError = await model.setSetting(SettingsChange(trustedRelaySenders: senders))
        }
    }

    /// The person's Hermes, through its loopback API server. Each relay
    /// sender gets a Hermes session of its own; only the final answer goes
    /// back to the sender.
    private var hermesRow: some View {
        let enabled = model.settings?.hermesAgent == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.seal" : "bolt.horizontal.circle")
            VStack(alignment: .leading, spacing: 4) {
                Text(HermesCopy.title).font(.body.weight(.medium))
                Group {
                    if enabled {
                        Text(HermesCopy.onDetail)
                    } else {
                        Text(HermesCopy.offDetail)
                    }
                }
                .font(.footnote).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                if let hermesError { notice(hermesError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setHermes(false) }
                    .help(HermesCopy.turnOffHelp)
            } else {
                Button("Turn On") { setHermes(true) }
                    .help(HermesCopy.turnOnHelp)
            }
        }
        .padding(16)
    }

    private func setHermes(_ enabled: Bool) {
        Task { hermesError = await model.setSetting(SettingsChange(hermesAgent: enabled)) }
    }

    /// Agent Relay's Devin lifecycle hooks. A Devin session has no port to
    /// write into; with the hooks in its config.json, a staged message
    /// reaches the conversation at each hook boundary.
    private var devinDeliveryRow: some View {
        let enabled = model.settings?.devinDirectDelivery == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.seal" : "bolt.horizontal.circle")
            VStack(alignment: .leading, spacing: 4) {
                Text("Devin sessions").font(.body.weight(.medium))
                Group {
                    if enabled {
                        Text("Agent Relay's hooks are in ~/.config/devin/config.json. Messages reach a Devin session mid-turn and when its turn ends. Start Devin sessions that were open before it was on again.")
                    } else {
                        Text("A Devin session has no way in: messages wait in its inbox, unheard. Turn this on to add Agent Relay's hooks to Devin's config.json, so sessions you open in Devin appear here and can be messaged, the way Claude Code and Codex sessions are.")
                    }
                }
                .font(.footnote).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                if let devinDeliveryError { notice(devinDeliveryError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setDevinDelivery(false) }
                    .help("Remove Agent Relay's hooks from Devin")
            } else {
                Button("Turn On") { setDevinDelivery(true) }
                    .help("Add Agent Relay's hooks to Devin")
            }
        }
        .padding(16)
    }

    private func setDevinDelivery(_ enabled: Bool) {
        Task { devinDeliveryError = await model.setSetting(SettingsChange(devinDirectDelivery: enabled)) }
    }

    private var codexStopHookRow: some View {
        let enabled = model.settings?.codexStopHook == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.seal" : "bubble.left.and.text.bubble.right")
            VStack(alignment: .leading, spacing: 4) {
                Text("Conductor Codex chats").font(.body.weight(.medium))
                Group {
                    if enabled {
                        Text("Agent Relay's Codex hook is in ~/.codex/hooks.json. A message for a Conductor Codex chat that is working is handed over as its turn ends, so it shows in Conductor's chat. One that arrives while the chat is idle is delivered at once and shown at the end of the chat's next turn.")
                    } else {
                        Text("Conductor shows only the Codex turns it starts, so messages delivered to its Codex chats don't appear there. Turn this on to add Agent Relay's Codex hook, so they show in the chat.")
                    }
                }
                .font(.footnote).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                if let codexStopHookError { notice(codexStopHookError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setCodexStopHook(false) }
                    .help("Remove Agent Relay's hook from Codex")
            } else {
                Button("Turn On") { setCodexStopHook(true) }
                    .help("Add Agent Relay's hook to Codex")
            }
        }
        .padding(16)
    }

    private func setCodexStopHook(_ enabled: Bool) {
        Task { codexStopHookError = await model.setSetting(SettingsChange(codexStopHook: enabled)) }
    }

    /// Relay messages in agent chats: hidden (off, the default; the agent
    /// still reads each one) or shown in full.
    private var showRelayMessagesRow: some View {
        let enabled = model.settings?.showRelayMessages == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "text.bubble" : "eye.slash")
            VStack(alignment: .leading, spacing: 4) {
                Text(ShowRelayMessages.title).font(.body.weight(.medium))
                Text(enabled ? ShowRelayMessages.shownExplanation : ShowRelayMessages.explanation)
                    .font(.footnote).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let showRelayMessagesError { notice(showRelayMessagesError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setShowRelayMessages(false) }
                    .help(ShowRelayMessages.turnOffHelp)
            } else {
                Button("Turn On") { setShowRelayMessages(true) }
                    .help(ShowRelayMessages.turnOnHelp)
            }
        }
        .padding(16)
    }

    private func setShowRelayMessages(_ enabled: Bool) {
        Task { showRelayMessagesError = await model.setSetting(SettingsChange(showRelayMessages: enabled)) }
    }

    /// Whether agents put on the relay from now on join #general. Off unless
    /// turned on; agents already on the relay keep their channels.
    private var autoJoinGeneralRow: some View {
        let enabled = model.settings?.autoJoinGeneral == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.circle" : "number")
            VStack(alignment: .leading, spacing: 4) {
                Text(AutoJoinGeneral.title).font(.body.weight(.medium))
                Text(enabled ? AutoJoinGeneral.joinedExplanation : AutoJoinGeneral.explanation)
                    .font(.footnote).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let autoJoinGeneralError { notice(autoJoinGeneralError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setAutoJoinGeneral(false) }
                    .help(AutoJoinGeneral.turnOffHelp)
            } else {
                Button("Turn On") { setAutoJoinGeneral(true) }
                    .help(AutoJoinGeneral.turnOnHelp)
            }
        }
        .padding(16)
    }

    private func setAutoJoinGeneral(_ enabled: Bool) {
        Task { autoJoinGeneralError = await model.setSetting(SettingsChange(autoJoinGeneral: enabled)) }
    }

    /// The latest settings agents changed on the session socket, newest
    /// first; shown once one has.
    private func agentChangesRow(_ changes: [AgentSettingsChange]) -> some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: "square.and.pencil")
            VStack(alignment: .leading, spacing: 4) {
                Text(AgentSettingsChanges.title).font(.body.weight(.medium))
                Text(AgentSettingsChanges.explanation)
                    .font(.footnote).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(Array(changes.prefix(AgentSettingsChanges.shown).enumerated()), id: \.offset) { _, change in
                    Text(AgentSettingsChanges.row(change))
                        .font(.footnote).foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
        }
        .padding(16)
    }

    /// Claude Code's SessionStart hook. Off unless turned on. It never
    /// registers a session; it tells one that is not on the relay how to
    /// POST /register.
    private var claudeSessionHookRow: some View {
        let enabled = model.settings?.claudeSessionHook == true
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: enabled ? "checkmark.seal" : "bell.badge")
            VStack(alignment: .leading, spacing: 4) {
                Text(ClaudeSessionHookCopy.title).font(.body.weight(.medium))
                Text(enabled ? ClaudeSessionHookCopy.turnedOn : ClaudeSessionHookCopy.turnedOff)
                    .font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let claudeSessionHookError { notice(claudeSessionHookError, color: .red) }
            }
            Spacer(minLength: 12)
            if enabled {
                Button("Turn Off") { setClaudeSessionHook(false) }
                    .help(ClaudeSessionHookCopy.turnOffHelp)
            } else {
                Button("Turn On") { setClaudeSessionHook(true) }
                    .help(ClaudeSessionHookCopy.turnOnHelp)
            }
        }
        .padding(16)
    }

    private func setClaudeSessionHook(_ enabled: Bool) {
        Task { claudeSessionHookError = await model.setSetting(SettingsChange(claudeSessionHook: enabled)) }
    }

    private func notice(_ text: String, color: Color) -> some View {
        Label(text, systemImage: "exclamationmark.circle.fill")
            .font(.footnote).foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2)
    }
}

/// Agent Relay's own tools for the person's OpenClaw agents, under OpenClaw's
/// row while it is on. Connect adds Agent Relay's hosted MCP to
/// openclaw.json and opens its consent page in the browser; while that page
/// is open the row reads the status again every two seconds, until it is
/// connected or Settings goes away.
private struct OpenClawToolsRowView: View {
    @EnvironmentObject private var model: AppModel
    @State private var status: OpenClawToolsStatus?
    @State private var error: String?
    @State private var connecting = false
    /// Connects asked for, so a status reply asked before the latest one
    /// is dropped.
    @State private var connects = 0

    var body: some View {
        let row = status.map(OpenClawToolsCopy.row(for:))
        return HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: status?.state == .connected ? "checkmark.seal" : "wrench.and.screwdriver")
            VStack(alignment: .leading, spacing: 4) {
                Text(OpenClawToolsCopy.title).font(.body.weight(.medium))
                if let row, !row.detail.isEmpty {
                    Text(row.detail)
                        .font(.footnote).foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(errors(row), id: \.self) { text in
                    Label(text, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 12)
            if let action = row?.action {
                switch action {
                case .connect:
                    Button(action.label) { connect() }
                        .buttonStyle(AgentRelayPrimaryButtonStyle())
                        .disabled(connecting)
                case .openAgain:
                    Button(action.label) { connect() }
                        .disabled(connecting)
                }
            }
        }
        .padding(16)
        // Restarts when the state changes, so a waiting login is followed,
        // and on every Settings invalidation (a Gateway that came up, a
        // login that ended); ends when the row goes away.
        .task(id: "\(status?.state.rawValue ?? "")#\(model.settingsInvalidations)") { await follow() }
    }

    /// Connect's error and the last sign-in's failure, each once, never
    /// repeating the detail.
    private func errors(_ row: OpenClawToolsCopy.Row?) -> [String] {
        var shown: [String] = []
        for text in [error, row?.error].compactMap({ $0 }) where text != row?.detail && !shown.contains(text) {
            shown.append(text)
        }
        return shown
    }

    private func follow() async {
        await read()
        while OpenClawToolsCopy.polls(status), !Task.isCancelled {
            try? await Task.sleep(nanoseconds: OpenClawToolsCopy.pollNanoseconds)
            if Task.isCancelled { return }
            await read()
        }
    }

    /// Reads the status, unless a Connect was asked for meanwhile: its
    /// answer is newer.
    private func read() async {
        let asked = connects
        let answer = await model.openClawToolsStatus()
        if asked == connects { status = answer }
    }

    private func connect() {
        guard !connecting else { return }
        connecting = true
        connects += 1
        error = nil
        Task {
            switch await model.connectOpenClawTools() {
            case .success(let state):
                status = OpenClawToolsStatus(state: state)
            case .failure(let failure):
                error = failure.message
                // The core may now say why it is unavailable.
                await read()
            }
            connecting = false
        }
    }
}

/// The core runs as a LaunchAgent: at login, without a window, through app
/// updates. Only show this recovery row when macOS requires approval.
private struct BackgroundServiceRow: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            SettingsIcon(systemImage: "bolt.horizontal.circle")
            VStack(alignment: .leading, spacing: 4) {
                Text("Background service").font(.body.weight(.medium))
                Text("Keeps your agents connected and uploads running while Agent Relay is closed, and starts at login.")
                    .font(.footnote).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if model.coreNeedsApproval {
                    Label("Allow Agent Relay in System Settings › General › Login Items.", systemImage: "exclamationmark.circle.fill")
                        .font(.footnote).foregroundStyle(CloudTheme.warning)
                }
            }
            Spacer(minLength: 20)
            if model.coreNeedsApproval {
                Button("Open Login Items…") { model.openLoginItemsSettings() }
            }
        }
        .padding(16)
    }
}

// MARK: - Account

/// Who is signed in, the workspace, and logging out.
private struct AccountSettingsSection: View {
    @EnvironmentObject private var model: AppModel
    @State private var isConfirmingLogOut = false

    var body: some View {
        SettingsSection(title: "Profile") {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .center, spacing: 14) {
                    PersonAvatar(name: model.accountName ?? model.accountEmail ?? "?",
                                 url: model.accountAvatarURL.flatMap(URL.init(string:)), size: 44)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.accountName ?? model.accountEmail ?? "Not signed in")
                            .font(.system(size: 15, weight: .semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        if model.accountName != nil, let email = model.accountEmail {
                            Text(email).font(.system(size: 13)).foregroundStyle(CloudTheme.secondary)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Button("Log out…") { isConfirmingLogOut = true }
                        .disabled(!model.canLogOut)
                }
                Text("Logging out stops uploads and disconnects this app. Local sessions stay where they are.")
                    .font(.system(size: 12)).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.padding(20)
        }
        SettingsSection(title: "Workspace") {
            HStack(alignment: .top, spacing: 14) {
                SettingsIcon(systemImage: "square.stack.3d.up")
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.workspaceName).font(.system(size: 13, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Shared sessions belong to this workspace. Log out and sign in again to switch workspaces.")
                        .font(.system(size: 12)).foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(20)
        }
        .confirmationDialog(
            "Log out of Agent Relay?",
            isPresented: $isConfirmingLogOut
        ) {
            Button("Log out", role: .destructive) {
                Task {
                    await model.disconnect()
                }
            }
            Button("Cancel", role: .cancel) {
                isConfirmingLogOut = false
            }
        } message: {
            Text("Uploads stop and you will need to sign in again to reconnect.")
        }
    }
}

struct ClaudeDeliverySettings: View {
    @ObservedObject var delivery: ClaudeDeliveryModel
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Choose which Claude Code sessions and workspace members may receive messages directly. Ask first holds each message in Agent Relay for your approval.")
                    .font(.footnote)
                Toggle("Only allowed members may deliver directly", isOn: Binding(
                    get: { delivery.status?.restricted ?? false },
                    set: { value in Task { await delivery.restrict(value) } }
                ))
                if delivery.status?.restricted == true && delivery.status?.allowedSenders.isEmpty != false {
                    Text("No members are allowed yet. Their messages will wait for approval.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = delivery.error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                }
                ForEach(delivery.status?.sessions ?? [], id: \.id) { session in
                    Toggle(isOn: Binding(
                        get: { session.direct },
                        set: { value in Task { await delivery.setSession(session.id, direct: value) } }
                    )) {
                        VStack(alignment: .leading) {
                            Text(session.title.isEmpty ? session.agent : session.title).font(.headline)
                            Text(session.direct ? "Direct delivery" : "Ask first").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                ForEach(delivery.status?.allowedSenders ?? [], id: \.address) { sender in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(sender.name).font(.headline)
                            Text(sender.address).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Remove") { Task { await delivery.setSender(sender, allowed: false) } }
                    }
                }
                ForEach(delivery.status?.held ?? [], id: \.id) { message in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(message.senderName) → @\(message.agent)").font(.headline)
                        Text(message.text).lineLimit(8).textSelection(.enabled)
                        HStack {
                            Button("Approve once") { Task { await delivery.approve(message.id) } }
                            if !message.sender.isEmpty {
                                Button("Always allow") { Task { await delivery.alwaysAllow(message) } }
                            }
                            Button("Dismiss") { Task { await delivery.dismiss(message.id) } }
                        }
                    }
                }
                Button("Refresh") { Task { await delivery.refresh() } }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CloudTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(CloudTheme.border)
            }
        } label: {
            Text("Claude Code message approvals")
                .font(.system(size: 13, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
        }
        .task { await delivery.refresh() }
    }
}


private struct IncomingMessagesSettings: View {
    @ObservedObject var incoming: IncomingModel

    var body: some View {
        SettingsSection(title: "Incoming messages", description: incoming.status?.stateLabel) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Choose which Codex threads teammates may message. Ask first holds each message for your approval.")
                    .font(.footnote)
                if let error = incoming.error ?? incoming.status?.error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                }
                ForEach(incoming.status?.threads ?? []) { thread in
                    VStack(alignment: .leading) {
                        Text(thread.title.isEmpty ? thread.id : thread.title).font(.headline)
                        Text("\(thread.project.isEmpty ? "Codex" : thread.project) · \(thread.open ? "Open" : "Closed")").font(.caption)
                        Picker("Incoming messages", selection: Binding<Mode?>(
                            get: { thread.mode },
                            set: { mode in
                                Task {
                                    await incoming.share(thread.id, mode: mode,
                                                         allowsUnrestricted: thread.allowsUnrestricted)
                                }
                            }
                        )) {
                            Text("Off").tag(Mode?.none)
                            Text("Ask first").tag(Mode?.some(.hold))
                            Text("Allow automatically").tag(Mode?.some(.auto))
                        }
                        if thread.mode == .auto {
                            Toggle("Also allow without approval when this thread has full access to this computer", isOn: Binding(
                                get: { thread.allowsUnrestricted },
                                set: { allowed in Task { await incoming.share(thread.id, mode: .auto, allowsUnrestricted: allowed) } }
                            )).font(.footnote)
                        }
                    }
                    Divider().hidden().overlay(CloudTheme.border)
                }
                ForEach(incoming.status?.held ?? []) { message in
                    VStack(alignment: .leading) {
                        Text(message.senderName ?? "Teammate").font(.headline)
                        Text(message.text).lineLimit(8).textSelection(.enabled)
                        HStack {
                            Button("Approve") { Task { await incoming.approve(message.id) } }
                                .disabled(incoming.status?.canApprove != true)
                            Button("Decline") { Task { await incoming.reject(message.id) } }
                        }
                    }
                }
                Button("Refresh") { Task { await incoming.refresh() } }
            }.padding(16)
        }
    }
}

private struct TroubleshootingSettingsSection: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        SettingsSection(title: "Support") {
            HStack(alignment: .top, spacing: 14) {
                SettingsIcon(systemImage: "doc.text.magnifyingglass")
                VStack(alignment: .leading, spacing: 5) {
                    Text("Log file").font(.system(size: 13, weight: .medium))
                    Text("What the background service recorded, for a bug report.")
                        .font(.system(size: 12)).foregroundStyle(CloudTheme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button("Open log file") { model.openLogFile() }
                    .disabled(model.installDirectory == nil)
            }.padding(20)
        }
    }
}

/// Explicit foreground/background pairs avoid macOS tint washing out actions.
/// The label keeps its intrinsic width while descriptions wrap beside it.
struct SettingsActionStyle: ButtonStyle {
    var prominent = false
    @ViewBuilder func makeBody(configuration: Configuration) -> some View {
        if prominent {
            AgentRelayPrimaryButtonStyle(height: 32).makeBody(configuration: configuration)
                .fixedSize(horizontal: true, vertical: false)
        } else {
            Action(configuration: configuration)
        }
    }
    private struct Action: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        @Environment(\.isFocused) private var focused
        @State private var hovered = false

        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: .medium))
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(configuration.role == .destructive ? CloudTheme.settingsDanger : CloudTheme.foreground)
                .padding(.horizontal, 12).frame(minHeight: 32)
                .background(hovered && enabled ? CloudTheme.muted : CloudTheme.background,
                            in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(focused ? CloudTheme.ring : CloudTheme.input,
                                  lineWidth: focused ? 2 : 1))
                .brightness(configuration.isPressed && enabled ? -0.06 : 0)
                .opacity(enabled ? 1 : 0.45)
                .contentShape(RoundedRectangle(cornerRadius: 6))
                .onHover { hovered = $0 }.actionCursor()
        }
    }
}
