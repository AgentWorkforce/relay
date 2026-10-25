import AppKit
import RelayDesktopCore
import SwiftUI

// The session rows, banners and presence indicators the Agents page uses;
// the Team page shows the same banners.

extension AppModel {
    var appStatusProblems: [String] {
        var seen = Set<String>()
        let uploadProblem: String?
        if let status = statusViewModel, case .needsAttention(let message) = status.state {
            uploadProblem = message
        } else { uploadProblem = nil }
        return [uploadProblem, sessionActionError, sessionsError, previewError,
                coreProblem, lastError, relayProblem(relay),
                relay.storeError, relay.integrationError, relay.deliveryError, uploadActionError]
            .compactMap { $0 }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    func openAppStatus() {
        if requestFailure != nil { openFailedRequest() }
        else if !appStatusProblems.isEmpty {
            selectedRequest = nil
            page = .settings(.diagnostics)
        } else { showLocalSessions() }
    }

    /// What stops messages or uploads right now, for the banners and the
    /// menu bar icon's badge.
    func relayProblem(_ relay: RelayModel) -> String? {
        if let error = coreProblem ?? sessionsError ?? lastError { return error }
        if let status = statusViewModel, case .needsAttention(let message) = status.state { return message }
        if let error = relay.storeError ?? relay.integrationError { return error }
        if relay.sessions.contains(where: { $0.registration != nil }), let error = relay.deliveryError {
            return "Can't reach the relay: \(error)"
        }
        return nil
    }

    /// The uploader's row for a relay session, once the uploader lists it.
    func uploadEntry(for session: LocalSession) -> UploadSession? {
        guard let key = session.target.uploadKey else { return nil }
        return sessions.first { $0.id == key }
    }

    var uploadStatusText: String {
        if phase == .preparingSessions { return "Preparing uploads" }
        guard phase == .attached else { return phase == .launching ? "Connecting…" : "Not connected" }
        guard let status = statusViewModel else { return "Checking uploads" }
        if isPaused { return "Uploads paused" }
        return status.state == .upToDate ? "Uploads up to date" : status.headline
    }

    var uploadStatusColor: Color {
        guard phase == .attached, let status = statusViewModel else { return CloudTheme.secondary }
        switch status.state {
        case .upToDate: return CloudTheme.success
        case .uploading, .preparing: return CloudTheme.primary
        case .needsAttention, .conflict, .offline: return CloudTheme.warning
        default: return CloudTheme.secondary
        }
    }
}

enum RelayClipboard {
    @discardableResult
    static func copy(_ text: String, to pasteboard: NSPasteboard = .general) -> Bool {
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
    }

    /// Copies `@name` and tells VoiceOver, since the row's only visible
    /// confirmation is brief.
    static func copyName(_ name: String) {
        copy("@\(name)")
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [
            .announcement: "Copied @\(name)",
            .priority: NSAccessibilityPriorityLevel.high.rawValue
        ])
    }
}

/// A switch that shows its state the same way whether or not its window is
/// key. AppKit's switch drops its accent fill in a non-key window, which a
/// menu-bar panel often is, leaving on and off both grey.
///
/// On is a filled accent track with the knob right; off is a neutral track
/// with the knob left, so position carries the state as well as color.
struct RelaySwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        SwitchBody(configuration: configuration)
    }

    private struct SwitchBody: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.isFocused) private var isFocused
        @Environment(\.colorScheme) private var colorScheme
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        private static let size = CGSize(width: 30, height: 18)
        private var isOn: Bool { configuration.isOn }
        private var highlighted: Bool { hovered && isEnabled }
        private var track: Color {
            if isOn { return CloudTheme.settingsAction.opacity(highlighted ? 0.85 : 1) }
            return CloudTheme.input
        }

        var body: some View {
            Button {
                configuration.isOn.toggle()
            } label: {
                ZStack(alignment: isOn ? .trailing : .leading) {
                    Capsule()
                        .fill(track)
                        .overlay(Capsule().strokeBorder(CloudTheme.border, lineWidth: 0.5))
                    Circle()
                        .fill(colorScheme == .dark ? CloudTheme.foreground : CloudTheme.background)
                        .shadow(color: .black.opacity(0.25), radius: 1, y: 0.5)
                        .padding(2)
                }
                .frame(width: Self.size.width, height: Self.size.height)
                .overlay(Capsule().strokeBorder(CloudTheme.ring.opacity(isFocused || highlighted ? 0.8 : 0), lineWidth: 2).padding(-3))
                .opacity(isEnabled ? 1 : 0.4)
                .contentShape(Capsule())
                .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.8), value: isOn)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: highlighted)
            }
            .buttonStyle(.plain)
            // The pointing hand says it can be pressed; SwiftUI's hosting view
            // can replace cursor rectangles, so it is reasserted on movement.
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    hovered = true
                    (isEnabled ? NSCursor.pointingHand : NSCursor.arrow).set()
                case .ended:
                    hovered = false
                    NSCursor.arrow.set()
                }
            }
            .onDisappear {
                if hovered {
                    hovered = false
                    NSCursor.arrow.set()
                }
            }
            .accessibilityRepresentation {
                Toggle(isOn: configuration.$isOn) { configuration.label }
            }
        }
    }
}

/// A row whose whole area, the switch included, highlights and shows the
/// pointing hand together, so the row reads as one control.
struct HoverRow<Content: View>: View {
    var interactive: Bool
    var height: CGFloat
    @ViewBuilder var content: (Bool) -> Content
    @State private var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 6) { content(hovered && interactive) }
            .padding(.trailing, 2)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(RoundedRectangle(cornerRadius: 8)
                .fill(CloudTheme.hover.opacity(hovered && interactive ? 1 : 0)))
            .contentShape(RoundedRectangle(cornerRadius: 8))
            // SwiftUI's hosting view can replace cursor rectangles, so the
            // hand is reasserted as the pointer moves.
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    hovered = true
                    (interactive ? NSCursor.pointingHand : NSCursor.arrow).set()
                case .ended:
                    hovered = false
                    NSCursor.arrow.set()
                }
            }
            // A row removed or a panel closed under the pointer gets no
            // hover end, so the hand is put back here.
            .onDisappear {
                if hovered {
                    hovered = false
                    NSCursor.arrow.set()
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovered)
    }
}

/// The row's own content as a button: the highlight belongs to `HoverRow`,
/// so this keeps only press, focus and disabled feedback.
struct RowContentButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ContentBody(configuration: configuration)
    }

    private struct ContentBody: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            // Fills the row, highlight and all, so every highlighted point clicks.
            configuration.label
                .padding(.leading, 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .actionCursor()
                .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
                .overlay(RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(CloudTheme.primary.opacity(isFocused ? 1 : 0), lineWidth: 2).padding(-4))
        }
    }
}

/// A small caps-free section label, in the style of the system Wi-Fi and
/// Bluetooth menus.
struct SectionHeader: View {
    var title: String
    var detail: String?

    var body: some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(CloudTheme.secondary)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let detail {
                Text(detail).font(.system(size: 11)).foregroundStyle(CloudTheme.secondary).monospacedDigit()
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
    }
}

/// A condition that stops messages or uploads, with the one action that fixes it.
struct PanelBanner: View {
    var symbol: String
    var tint: Color
    var message: String
    var action: (String, () -> Void)?
    var actionDisabled = false

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(tint).font(.system(size: 13))
            Text(message).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                .lineLimit(3).help(message)
            Spacer(minLength: 4)
            if let (label, perform) = action {
                Button(label, action: perform)
                    .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 24))
                    .fixedSize()
                    .disabled(actionDisabled)
            }
        }
        .padding(8)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
    }
}

/// The banners both surfaces show above the session list: only what stops
/// messages or uploads from flowing, most blocking first.
struct RelayBanners: View {
    @ObservedObject var relay: RelayModel
    @EnvironmentObject private var model: AppModel
    /// Where connecting a workspace happens from this surface.
    var connectWorkspace: () -> Void

    var body: some View {
        if model.isPaused {
            PanelBanner(
                symbol: "pause.circle.fill", tint: CloudTheme.warning,
                message: "Paused. Agents don't receive messages and nothing uploads.",
                action: ("Resume", { Task { await model.setPaused(false) } }),
                actionDisabled: !model.canTogglePause
            )
        }
        if relay.workspace == nil && relay.isConnectingWorkspace {
            PanelBanner(
                symbol: "arrow.triangle.2.circlepath", tint: CloudTheme.secondary,
                message: "Finish connecting the workspace in your browser.",
                action: ("Cancel", { relay.cancelConnectWorkspace() })
            )
        }
        if relay.workspace == nil && !relay.isConnectingWorkspace {
            PanelBanner(
                symbol: "antenna.radiowaves.left.and.right.slash", tint: CloudTheme.warning,
                message: relay.workspaceConnectError ?? "Connect a relay workspace to put agents on the relay.",
                action: ("Connect", connectWorkspace)
            )
        }
        if let problem = model.relayProblem(relay) {
            PanelBanner(symbol: "exclamationmark.triangle.fill", tint: CloudTheme.warning, message: problem, action: nil)
        }
    }
}

/// A session with its relay switch. A settled row on the relay copies its
/// name when clicked; any other row toggles, the same as its switch.
/// `accessory` sits between the row and the switch; `menuItems` follow the
/// copy items in the context menu.
struct RelaySessionRow<Accessory: View, MenuItems: View>: View {
    @ObservedObject var relay: RelayModel
    @EnvironmentObject private var model: AppModel
    var session: LocalSession
    var height: CGFloat
    /// The agent whose name was just copied, while its row confirms it.
    @Binding var copiedName: String?
    var toggle: (Bool) -> Void
    @ViewBuilder var accessory: () -> Accessory
    @ViewBuilder var menuItems: () -> MenuItems

    var body: some View {
        let registration = session.registration
        let presence = relay.presence(of: session)
        let title = session.title
        let copyable = registration != nil && !presence.isChanging
        let canToggle = relay.canToggle(session, presence: presence)
        let help = relay.switchHelp(session, presence: presence)
        // One hover target for the whole row, switch included.
        HoverRow(interactive: copyable || canToggle, height: height) { hovered in
            let row = AgentRow(
                session: session, title: title, name: registration?.displayName,
                presence: presence, error: relay.errors[session.id],
                copyable: copyable, copied: copyable && copiedName == registration?.displayName, hovered: hovered
            )
            Group {
                if let registration, copyable {
                    // An agent's name is what someone needs to message it.
                    Button { copyName(registration.displayName) } label: { row }
                        .help("Copy @\(registration.displayName) — \(presence.detail)")
                        .accessibilityLabel("Copy @\(registration.displayName)")
                } else {
                    Button { toggle(!presence.isOn) } label: { row }
                        .disabled(!canToggle)
                        .help(help)
                        .accessibilityLabel(presence.isOn ? "Take \(title) off the relay" : "Put \(title) on the relay")
                }
            }
            .buttonStyle(RowContentButtonStyle())
            .contextMenu {
                if let registration {
                    Button("Copy @\(registration.displayName)") { RelayClipboard.copy("@\(registration.displayName)") }
                    Button("Copy exact address") { RelayClipboard.copy(registration.address) }
                    Divider()
                }
                menuItems()
            }

            accessory()

            Toggle(presence.isOn ? "Take \(title) off the relay" : "Put \(title) on the relay", isOn: Binding(
                get: { presence.isOn },
                set: { toggle($0) }
            ))
            .toggleStyle(RelaySwitchStyle())
            .disabled(!canToggle)
            .frame(width: 36)
            .help(help)
        }
    }

    private func copyName(_ name: String) {
        RelayClipboard.copyName(name)
        copiedName = name
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            if copiedName == name { copiedName = nil }
        }
    }
}

/// One session: its harness icon, and on the relay a presence dot on it —
/// the way chat apps show who can be messaged. The subtitle names where it
/// runs, the name to message it by once it is on the relay, and a status
/// word only when something is off.
struct AgentRow: View {
    var session: LocalSession
    var title: String
    var name: String?
    var presence: RelayPresence
    var error: String?
    /// Whether a click copies the name: settled on the relay.
    var copyable = false
    /// Confirms a click copied the name.
    var copied = false
    /// The pointer is somewhere on the row, switch included.
    var hovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            AgentIconView(source: session.target.kind.source, size: 20, host: session.host)
                .frame(width: 28, height: 28)
                .background(CloudTheme.muted, in: RoundedRectangle(cornerRadius: 7))
                .opacity(presence == .leaving ? 0.55 : 1)
                .overlay(alignment: .bottomTrailing) { PresenceDot(presence: presence).offset(x: 3, y: 3) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13))
                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                subtitle.font(.system(size: 11)).lineLimit(1)
            }
            if copyable {
                // Shown on hover so the click's effect is known before it happens.
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(copied ? CloudTheme.success : CloudTheme.secondary)
                    .opacity(hovered || copied ? 1 : 0)
                    .accessibilityHidden(true)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: copied)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: presence)
        .accessibilityElement(children: .combine)
        .accessibilityValue(name.map { "\(presence.label), @\($0)" } ?? "")
    }

    private var place: String {
        let project = session.projectName
        if session.target.kind == .claudeCloud { return [project, "Claude app"].compactMap { $0 }.joined(separator: " · ") }
        if let host = SessionHost.name(session.host) { return [project, host].compactMap { $0 }.joined(separator: " · ") }
        return project ?? session.target.kind.label
    }

    private var subtitle: Text {
        if let error { return Text(error).foregroundColor(CloudTheme.warning) }
        if let name, copied { return Text("Copied @\(name)").foregroundColor(CloudTheme.success) }
        switch presence {
        case .joining:
            // The name it will most likely get, so the address is known early.
            return Text("Joining as @\(name ?? session.suggestedName)…").foregroundColor(CloudTheme.primary)
        case .leaving:
            return Text("Leaving the relay…").foregroundColor(CloudTheme.secondary)
        default:
            break
        }
        if let name {
            let address = Text("@\(name)").foregroundColor(CloudTheme.secondary)
            switch presence {
            case .online, .off, .joining, .leaving: return address + Text(" · \(place)").foregroundColor(CloudTheme.secondary)
            case .connecting: return Text("Connecting · ").foregroundColor(CloudTheme.warning) + address
            case .offline:
                if session.needsOpenCodeRestart {
                    return Text("Restart OpenCode to connect · ").foregroundColor(CloudTheme.warning) + address
                }
                return Text("Waiting — session not running · ").foregroundColor(CloudTheme.warning) + address
            }
        }
        if session.needsOpenCodeRestart {
            return Text("\(place) · Restart OpenCode to connect").foregroundColor(CloudTheme.secondary)
        }
        if !session.live { return Text("\(place) · Not running").foregroundColor(CloudTheme.secondary) }
        // Only Codex has a real last-active time; terminal Claude sessions
        // are listed because they are running now.
        if session.target.kind == .codex, let updated = session.updatedAt {
            return Text("\(place) · \(RelativeTime.string(for: updated))").foregroundColor(CloudTheme.secondary)
        }
        return Text(place).foregroundColor(CloudTheme.secondary)
    }
}

/// Filled success color when messages push straight in, a warning ring while
/// connecting, a grey ring while the session isn't running, a pulsing
/// accent ring while joining, and nothing off the relay. Shape as well as
/// color carries the state.
struct PresenceDot: View {
    var presence: RelayPresence
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        switch presence {
        case .off, .leaving:
            EmptyView()
        case .joining:
            dot(Circle().strokeBorder(CloudTheme.primary, lineWidth: 2))
                .scaleEffect(pulsing ? 1.15 : 0.85)
                .opacity(pulsing ? 1 : 0.6)
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulsing = true }
                }
                .onDisappear { pulsing = false }
        case .online:
            dot(Circle().fill(CloudTheme.success))
        case .connecting:
            dot(Circle().strokeBorder(CloudTheme.warning, lineWidth: 2))
        case .offline:
            dot(Circle().strokeBorder(CloudTheme.secondary, lineWidth: 2))
        }
    }

    private func dot(_ shape: some View) -> some View {
        shape
            .frame(width: 10, height: 10)
            .background(Circle().fill(CloudTheme.background).padding(-2))
            .accessibilityHidden(true)
    }
}
