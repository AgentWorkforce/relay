import AppKit
import RelayDesktopCore
import SwiftUI

struct MainWindowView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var updater = AppUpdater.shared
    @State private var isConfirmingUpdate = false
    @State private var updateFailure: String?

    var body: some View {
        Group {
            switch model.phase {
            case .attached, .preparingSessions:
                if model.signingOut { SigningOutView() } else { connected }
            default:
                SignInView()
            }
        }
        .buttonStyle(NativeActionButtonStyle(base: DefaultButtonStyle()))
        .foregroundStyle(CloudTheme.foreground)
        .tint(CloudTheme.primary).accentColor(CloudTheme.primary)
        .background(CloudTheme.background)
        .frame(minWidth: 980, minHeight: 650)
        // SwiftUI can route links to this scene before the app delegate.
        .onOpenURL { model.openConnection($0) }
        .onAppear { model.windowVisibilityChanged(true) }
        .onDisappear { model.windowVisibilityChanged(false) }
        .task(id: model.phase) {
            if model.phase == .attached || model.phase == .preparingSessions { await model.refreshVisibleState() }
        }
        .background(CloudSessionSheetHost(chat: model.chat))
        .sheet(isPresented: $isConfirmingUpdate) {
            if case let .available(release) = updater.state {
                updateConfirmation(for: release)
            }
        }
        .alert("Update failed", isPresented: Binding(
            get: { updateFailure != nil },
            set: { if !$0 { updateFailure = nil } }
        )) {
            Button("OK") { updateFailure = nil }
        } message: {
            Text(updateFailure ?? "Agent Relay could not install the update.")
        }
    }

    private var connected: some View {
        WorkspaceShell(
            relay: model.relay,
            updater: updater,
            confirmUpdate: { isConfirmingUpdate = true }
        ) {
            VStack(alignment: .leading, spacing: 0) {
                switch model.page {
                case .projects, .sessions, .agents, .team: LocalSessionsView(relay: model.relay)
                case .settings(let pane): SettingsPaneView(pane: pane)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .relaySheets(model.relay, model: model)
    }

    private func updateConfirmation(for release: AppRelease) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 76))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.yellow, .white)
                .padding(.bottom, 28)
            Text("Update Agent Relay now?")
                .font(.system(size: 25, weight: .bold))
                .padding(.bottom, 18)
            Text("Agent Relay will quit to install version \(release.version). This will interrupt active uploads; they will resume when the app reopens.")
                .font(.system(size: 19))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 16) {
                Button("Cancel") { isConfirmingUpdate = false }
                    .keyboardShortcut(.cancelAction)
                    .buttonStyle(NativeActionButtonStyle(base: BorderedButtonStyle()))
                Button("Update") {
                    isConfirmingUpdate = false
                    Task {
                        await updater.downloadAndInstall(release)
                        if case let .failed(message) = updater.state { updateFailure = message }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(AgentRelayPrimaryButtonStyle())
            }
            .controlSize(.large)
            .frame(maxWidth: .infinity)
            .padding(.top, 30)
        }
        .padding(32)
        .frame(width: 460, alignment: .leading)
    }
}
