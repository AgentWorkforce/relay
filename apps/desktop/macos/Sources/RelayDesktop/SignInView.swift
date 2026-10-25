import AppKit
import RelayDesktopCore
import SwiftUI

/// Sign in first; choose what to share in the Sessions window.
struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startupMessage = Int.random(in: StartupPresentation.messages.indices)
    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                splash.frame(width: geometry.size.width * 0.54)
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        content
                        if model.phase != .launching, let error = model.signInError ?? model.coreProblem ?? model.lastError {
                            Label(error, systemImage: "exclamationmark.circle")
                                .font(.callout).foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: 360)
                    .padding(40)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
                }
                .frame(maxWidth: .infinity)
                .background(Color(red: 0.988, green: 0.989, blue: 0.986))
                .overlay(alignment: .bottom) {
                    if AppInfo.isDevelopment {
                        Text("Development")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .help(model.siteURL)
                            .padding(.bottom, 20)
                    }
                }
                .environment(\.colorScheme, .light)
            }
        }
    }

    // Split welcome layout: centered brand and agents, quiet light login panel.
    private var splash: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 48)
            HStack(spacing: 12) {
                BrandMarkView(width: 34)
                BrandWordmarkView(height: 26)
            }
            HStack(spacing: 20) {
                AgentIconView(source: "codex")
                AgentIconView(source: "claude")
                AgentIconView(source: "cursor", artworkColor: .white)
                AgentIconView(source: "opencode", artworkColor: .white)
                AgentIconView(source: "grok", artworkColor: .white)
                AgentIconView(source: "muse", artworkColor: Color(red: 0.25, green: 0.57, blue: 1.0))
                AgentIconView(source: "devin", artworkColor: .white)
            }
            .padding(.top, 36)
            Spacer(minLength: 48)
        }
        .padding(48)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .foregroundStyle(.white)
        .background(Color(red: 0.04, green: 0.10, blue: 0.15))
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .launching:
            startup
        case .waitingForBrowser, .signingIn:
            if model.account.phase == "selecting_workspace" {
                workspacePicker
            } else {
                SignInProgressView(
                    waitingForBrowser: model.phase == .waitingForBrowser,
                    canOpenBrowser: model.signInLink != nil,
                    openBrowser: model.openApprovalPageAgain,
                    cancel: model.cancelSignIn
                )
            }
        default:
            signIn
        }
    }

    @ViewBuilder
    private var workspacePicker: some View {
        Text("Choose your workspace")
            .font(.system(size: 28, weight: .semibold)).tracking(-0.6)
        if let email = model.accountEmail {
            Text("Signed in as \(email)").foregroundStyle(.secondary)
        }
        VStack(spacing: 10) {
            ForEach(model.account.workspaceChoices ?? [], id: \.id) { workspace in
                Button { model.selectWorkspace(workspace.id) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "square.stack.3d.up")
                        VStack(alignment: .leading, spacing: 4) {
                            Text(workspace.name).fontWeight(.semibold)
                            if let organization = workspace.organizationName {
                                Text(organization).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.35)))
                }.buttonStyle(.plain)
            }
        }
        Button("Cancel", action: model.cancelSignIn).buttonStyle(.link)
    }

    @ViewBuilder
    private var signIn: some View {
        Text("Get your agents on the relay")
            .font(.system(size: 28, weight: .semibold)).tracking(-0.6)
            .fixedSize(horizontal: false, vertical: true)
        // From the click until the core's snapshot shows the attempt, no
        // second one starts.
        GoogleSignInButton {
            model.signIn()
        }
        .disabled(model.core == nil || model.startingSignIn)
        Button("Use another account") { model.signIn(useAnotherAccount: true) }
            .buttonStyle(.link)
            .disabled(model.core == nil || model.startingSignIn)
        if model.account.action == .acknowledgeUninspectedSchedules {
            Button("Continue anyway") { model.signIn(acknowledgeUninspectedSchedules: true) }
                .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 38))
                .help("Sign in although an earlier uploader's schedules could not be checked")
                .disabled(model.startingSignIn)
        }
        if model.coreNeedsApproval {
            Button("Open Login Items") { model.openLoginItemsSettings() }
                .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 44))
        }
    }

    private var startup: some View {
        VStack(alignment: .leading, spacing: 24) {
            Group {
                if model.coreProblem != nil {
                    Image(systemName: model.coreNeedsInstallation ? "folder" :
                          model.coreNeedsApproval ? "lock.shield" : "arrow.triangle.2.circlepath")
                        .font(.system(size: 25, weight: .medium))
                        .foregroundStyle(Color(red: 0.25, green: 0.43, blue: 0.56))
                        .frame(width: 60, height: 60)
                        .background(Color(red: 0.90, green: 0.94, blue: 0.96), in: RoundedRectangle(cornerRadius: 16))
                }
            }
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    Text(model.coreNeedsInstallation ? "Finish installation." :
                            model.coreNeedsApproval ? "One quick permission." :
                            model.coreProblem != nil ? "Let’s get you connected." : StartupPresentation.title)
                        .font(.system(size: 28, weight: .semibold)).tracking(-0.6)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    if model.coreProblem == nil {
                        Spacer(minLength: 0)
                        RelayLoadingBars(label: "Starting Agent Relay", scale: 0.5)
                    }
                }
                Text(model.coreProblem ?? StartupPresentation.messages[startupMessage])
                    .font(.system(size: 15)).foregroundStyle(.secondary)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 48, alignment: .topLeading)
                    .contentTransition(.opacity)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: startupMessage)
            }
            if model.coreProblem != nil {
                VStack(spacing: 10) {
                    if model.coreNeedsInstallation {
                        Button("Open Applications") {
                            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications", isDirectory: true))
                        }
                        .buttonStyle(AgentRelayPrimaryButtonStyle(height: 44, expands: true))
                    } else if model.coreNeedsApproval {
                        Button("Open Login Items") { model.openLoginItemsSettings() }
                            .buttonStyle(MenuPanelButtonStyle(kind: .primary, controlHeight: 44))
                    }
                    if !model.coreNeedsInstallation {
                        Button {
                            Task { await model.retryBackgroundService() }
                        } label: {
                            Label(model.isRecoveringCore ? "Restarting service…" : "Try again", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(MenuPanelButtonStyle(kind: model.coreNeedsApproval ? .secondary : .primary, controlHeight: 44))
                        .disabled(model.isRecoveringCore)
                    }
                    if !model.coreNeedsInstallation && !model.coreNeedsApproval {
                        Button("Open Login Items") { model.openLoginItemsSettings() }
                            .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 44))
                    }
                }
            }
            if model.coreProblem != nil {
                Button("Copy diagnostics") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(
                        DesktopDiagnostics.report(DesktopDiagnostics.sections(for: model)), forType: .string
                    )
                }
                .buttonStyle(.link)
            }
        }
        .task(id: model.coreProblem == nil && !reduceMotion) {
            guard model.coreProblem == nil, !reduceMotion else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: UInt64(StartupPresentation.interval * 1_000_000_000)) }
                catch { return }
                startupMessage = (startupMessage + 1) % StartupPresentation.messages.count
            }
        }
    }

}

/// Fixed-size content keeps the login panel still as the loading bars move.
/// The window while the account leaves, from Log out until the core's
/// snapshot no longer shows it; the Linux app's signing-out screen says the
/// same.
struct SigningOutView: View {
    var body: some View {
        VStack(spacing: 16) {
            RelayLoadingBars()
            Text("Disconnecting this computer…")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.primary)
            Text("Uploads are stopping safely.")
                .font(.system(size: 13))
                .foregroundStyle(CloudTheme.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

struct SignInProgressView: View {
    var waitingForBrowser: Bool
    var canOpenBrowser = false
    var openBrowser: () -> Void = {}
    var cancel: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            VStack(spacing: 16) {
                RelayLoadingBars()
                    .padding(.top, 8)
                Text(waitingForBrowser ? "Continue in your browser" : "Connecting…")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.primary)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 10) {
                Button("Cancel", action: cancel)
                    .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 44))
                    .keyboardShortcut(.cancelAction)
                if waitingForBrowser {
                    Button(action: openBrowser) {
                        Label("Open browser", systemImage: "arrow.up.right")
                    }
                    .buttonStyle(MenuPanelButtonStyle(kind: .primary, controlHeight: 44))
                    .disabled(!canOpenBrowser)
                }
            }
        }
    }
}

/// A quiet travelling wave in the homepage's primary blue. The surrounding
/// layout never changes size; Reduce Motion gets a static set of bars.
struct RelayLoadingBars: View {
    var label = "Connecting"
    var scale: CGFloat = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()

    var body: some View {
        Group {
            if reduceMotion {
                bars(at: 0)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    bars(at: context.date.timeIntervalSince(start))
                }
            }
        }
        .scaleEffect(scale)
        .frame(width: 88 * scale, height: 40 * scale)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    private func bars(at time: TimeInterval) -> some View {
        HStack(alignment: .center, spacing: 5) {
            ForEach(0..<9) { index in
                let wave = pow((sin(time * 2 * .pi / 1.8 - Double(index) * 0.55) + 1) / 2, 2)
                Capsule()
                    .fill(Color(red: 45 / 255, green: 106 / 255, blue: 156 / 255))
                    .frame(width: 4, height: 8 + 24 * wave)
                    .opacity(0.3 + 0.7 * wave)
            }
        }
        .frame(width: 88, height: 40)
    }
}

/// White button in Google's house style, with a simple multicolour "G".
struct GoogleSignInButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                GoogleGlyph(length: 18)
                Text("Sign in with Google")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(Color(red: 0.23, green: 0.25, blue: 0.26))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color(red: 0.45, green: 0.47, blue: 0.46), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .accessibilityLabel("Sign in with Google")
    }
}

/// A plain four-arc approximation of the Google mark: no artwork files.
struct GoogleGlyph: View {
    var length: CGFloat = 18

    private var lineWidth: CGFloat { length * 0.24 }

    private var blue: Color { Color(red: 0.259, green: 0.522, blue: 0.957) }
    private var green: Color { Color(red: 0.204, green: 0.659, blue: 0.325) }
    private var yellow: Color { Color(red: 0.984, green: 0.737, blue: 0.020) }
    private var red: Color { Color(red: 0.918, green: 0.263, blue: 0.208) }

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.00, to: 0.16)
                .stroke(blue, lineWidth: lineWidth)
            Circle()
                .trim(from: 0.16, to: 0.45)
                .stroke(green, lineWidth: lineWidth)
            Circle()
                .trim(from: 0.45, to: 0.66)
                .stroke(yellow, lineWidth: lineWidth)
            Circle()
                .trim(from: 0.66, to: 0.95)
                .stroke(red, lineWidth: lineWidth)
            Rectangle()
                .fill(blue)
                .frame(width: length * 0.30, height: lineWidth)
                .offset(x: length * 0.22)
        }
        .padding(lineWidth / 2)
        .frame(width: length, height: length)
        .accessibilityHidden(true)
    }
}
