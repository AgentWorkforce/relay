import RelayDesktopCore
import SwiftUI

/// Every project at a glance: Skip's briefing and the project list on the
/// left, a conversation with Skip on the right. Detail stays folded until
/// asked for: a project opens to its sessions, the briefing to its notes.
struct ProjectsView: View {
    @ObservedObject var chat: ChatModel
    @State private var confirmingPush: [ProjectSession] = []
    @State private var filter: SkipWorkState?
    @State private var showsBriefingNotes = false
    @State private var showsQuiet = false

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    SkipAccessNotice(chat: chat)
                    briefing
                    projectList
                }
                .padding(.horizontal, 32).padding(.vertical, 28)
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minWidth: 400, maxWidth: .infinity)
            Divider()
            CloudChatView(chat: chat)
                .frame(minWidth: 340, idealWidth: 400, maxWidth: 460)
        }
        // Durable Cloud owns generation, so polling only observes the cache.
        // The model preserves refresh-on-view for explicitly legacy servers.
        .task(id: chat.projectsPollingState) {
            while chat.isConnected && !Task.isCancelled {
                await chat.readProjects()
                try? await Task.sleep(nanoseconds: chat.projectsPollingState.delayNanoseconds)
            }
        }
        .confirmationDialog(
            confirmingPush.count == 1 ? "Send Skip’s message to 1 session?" : "Send Skip’s messages to \(confirmingPush.count) sessions?",
            isPresented: Binding(get: { !confirmingPush.isEmpty }, set: { if !$0 { confirmingPush = [] } }),
            titleVisibility: .visible
        ) {
            Button("Send as me") {
                let sessions = confirmingPush
                Task { await chat.pushAlong(sessions) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(confirmingPush.map { "\($0.title): \($0.nudge ?? "")" }.joined(separator: "\n\n"))
        }
        // A filter left on a state that no longer has projects would hide everything.
        .onChange(of: chat.report) { report in
            if let filter, report?.count(filter) ?? 0 == 0 { self.filter = nil }
        }
    }

    // MARK: Briefing

    @ViewBuilder private var briefing: some View {
        VStack(alignment: .leading, spacing: 14) {
            BriefingHeader(chat: chat)
            if let report = chat.report {
                Text(report.briefing.headline)
                    .font(.system(size: 19, weight: .regular))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    ForEach([SkipWorkState.needsYou, .ready, .working], id: \.self) { state in
                        let count = report.count(state)
                        if count > 0 {
                            StateFilterChip(state: state, count: count, isOn: filter == state) {
                                withAnimation(.easeInOut(duration: 0.15)) { filter = filter == state ? nil : state }
                            }
                        }
                    }
                    if hasNotes(report) {
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) { showsBriefingNotes.toggle() }
                        } label: {
                            HStack(spacing: 4) {
                                Text(showsBriefingNotes ? "Less" : "Details")
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 9, weight: .semibold))
                                    .rotationEffect(.degrees(showsBriefingNotes ? 180 : 0))
                            }
                            .font(.callout).foregroundStyle(.secondary)
                            .padding(.horizontal, 8).padding(.vertical, 5)
                        }
                        .buttonStyle(HoverPlainButtonStyle(shape: Capsule()))
                        .accessibilityHint(showsBriefingNotes ? "Hide Skip’s notes" : "Show Skip’s notes")
                    }
                }
                if showsBriefingNotes {
                    VStack(alignment: .leading, spacing: 14) {
                        BriefingLines(title: "Needs you", state: .needsYou, lines: report.briefing.stuck)
                        BriefingLines(title: "Moving", state: .working, lines: report.briefing.moving)
                        BriefingLines(title: "Skip can push", state: .ready, lines: report.briefing.ready)
                    }
                    .padding(.top, 4)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
                pushAll(report)
            } else if chat.isLoadingProjects {
                BriefingPlaceholder()
            } else if chat.isConnected && chat.projects != nil {
                Text("Skip groups your shared sessions into projects and tells you what’s stuck, what’s moving, and what it can push along.")
                    .font(.system(size: 15)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else if chat.isConnected {
                BriefingPlaceholder()
            }
            if let error = chat.projectsError, !chat.needsSignIn {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func hasNotes(_ report: ProjectsReport) -> Bool {
        !(report.briefing.stuck.isEmpty && report.briefing.moving.isEmpty && report.briefing.ready.isEmpty)
    }

    @ViewBuilder private func pushAll(_ report: ProjectsReport) -> some View {
        let waiting = report.waiting
        if !waiting.isEmpty {
            HStack(spacing: 14) {
                Image(systemName: "forward.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SkipWorkState.ready.tint)
                    .frame(width: 30, height: 30)
                    .background(SkipWorkState.ready.tint.opacity(0.14), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(waiting.count == 1 ? "Skip can move 1 session along" : "Skip can move \(waiting.count) sessions along")
                        .font(.system(size: 13, weight: .semibold))
                    Text("You’ll read each message before it’s sent as you.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("Review") { confirmingPush = waiting }
                    .buttonStyle(AgentRelayPrimaryButtonStyle())
                    .disabled(!chat.pendingPushes.isEmpty)
            }
            .padding(12)
            .background(SkipWorkState.ready.tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    // MARK: Projects

    @ViewBuilder private var projectList: some View {
        if let report = chat.report {
            let visible = report.projects.filter { filter == nil || $0.state == filter }
            let active = visible.filter { !$0.state.isQuiet }
            let quiet = visible.filter(\.state.isQuiet)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    SectionLabel(text: filter == nil ? "Active" : filter!.title)
                    Text("\(filter == nil ? active.count : visible.count)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                    Spacer()
                    if let filter {
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) { self.filter = nil }
                        } label: {
                            Label("Clear filter", systemImage: "xmark.circle.fill")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
                        .help("Show every project")
                    }
                }
                .padding(.bottom, 2)
                if report.projects.isEmpty {
                    Text("No shared sessions in the last two weeks. Put sessions on the relay from Agents and Skip will group them here.")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(active) { project in
                    ProjectRow(chat: chat, project: project).padding(.horizontal, -12)
                }
                if !quiet.isEmpty {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { showsQuiet.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .rotationEffect(.degrees(showsQuiet || active.isEmpty ? 90 : 0))
                            Text("Done and idle · \(quiet.count)")
                        }
                        .font(.callout).foregroundStyle(.secondary)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                    }
                    .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 8)))
                    .padding(.top, 6).padding(.leading, -10)
                    if showsQuiet || active.isEmpty {
                        ForEach(quiet) { project in
                            ProjectRow(chat: chat, project: project).padding(.horizontal, -12)
                        }
                    }
                }
            }
        }
    }
}

/// Only shown when Skip can't use the app's sign-in.
private struct SkipAccessNotice: View {
    @ObservedObject var chat: ChatModel
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if chat.needsSignIn {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "person.crop.circle.badge.exclamationmark")
                    .font(.system(size: 20)).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Sign in again to use Skip").font(.system(size: 13, weight: .semibold))
                    Text(chat.error ?? "Your sign-in has expired. Skip reads your projects with it.")
                        .font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Button("Sign in") { model.signIn() }
                    .buttonStyle(AgentRelayPrimaryButtonStyle())
            }
            .padding(14)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

private struct BriefingHeader: View {
    @ObservedObject var chat: ChatModel
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            SectionLabel(text: "Briefing")
            if chat.isLoadingProjects {
                ProgressView().controlSize(.mini)
                Text(chat.report == nil ? "Skip is reading your sessions…" : "Refreshing…")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let date = chat.report?.generatedDate {
                Text("· \(RelativeTime.string(for: date))").font(.caption).foregroundStyle(.tertiary)
            }
            Button {
                chat.startProjectsRefresh()
            } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(HoverPlainButtonStyle(shape: Circle()))
            .foregroundStyle(.secondary)
            .opacity(hovering && !chat.isLoadingProjects ? 1 : 0)
            .disabled(!chat.isConnected || chat.isLoadingProjects)
            .help("Ask Skip to rebuild the briefing")
            .accessibilityLabel("Refresh projects")
            Spacer()
        }
        .frame(height: 22)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

private struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold)).tracking(0.6)
            .foregroundStyle(.secondary)
    }
}

private struct BriefingPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach([1.0, 0.82, 0.55], id: \.self) { width in
                GeometryReader { proxy in
                    RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.07))
                        .frame(width: proxy.size.width * width)
                }
                .frame(height: 16)
            }
        }
        .accessibilityLabel("Loading the briefing")
    }
}

private struct StateFilterChip: View {
    let state: SkipWorkState
    let count: Int
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Circle().fill(state.tint).frame(width: 7, height: 7)
                Text("\(count)").font(.callout.weight(.semibold).monospacedDigit())
                Text(state.title).font(.callout)
            }
            .foregroundStyle(isOn ? Color.white : Color.primary)
            .padding(.horizontal, 11).padding(.vertical, 5)
            .background(isOn ? state.tint : Color.primary.opacity(0.05), in: Capsule())
        }
        .buttonStyle(HoverPlainButtonStyle(shape: Capsule()))
        .help(isOn ? "Show every project" : "Show only projects that are \(state.title.lowercased())")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

private struct BriefingLines: View {
    let title: String
    let state: SkipWorkState
    let lines: [String]
    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(title.uppercased()).font(.system(size: 11, weight: .semibold)).tracking(0.4).foregroundStyle(state.tint)
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().fill(state.tint).frame(width: 5, height: 5).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 1 }
                        Text(line).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                }
            }
        }
    }
}

private struct ProjectRow: View {
    @ObservedObject var chat: ChatModel
    let project: Project
    @State private var isExpanded = false
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Circle().fill(project.state.tint).frame(width: 8, height: 8).padding(.top, 6)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(project.name).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                        if isExpanded || hovering { StatePill(state: project.state, compact: true) }
                        Spacer(minLength: 8)
                        Text(RelativeTime.string(for: SkipDate.parse(project.lastActiveAt)))
                            .font(.caption).foregroundStyle(.secondary)
                            .opacity(hovering ? 0 : 1)
                    }
                    if let line = project.next ?? project.summary.nilIfBlank {
                        Text(line).font(.callout).foregroundStyle(.secondary)
                            .lineLimit(isExpanded ? nil : 1)
                            .fixedSize(horizontal: false, vertical: isExpanded)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .contentShape(Rectangle())
            .actionCursor()
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
            }
            .overlay(alignment: .topTrailing) {
                if hovering {
                    HStack(spacing: 2) {
                        RowIconButton(symbol: "bubble.left", help: "Ask Skip about \(project.name)") {
                            Task { await chat.ask("What’s the latest on \(project.name), and what should happen next?") }
                        }
                        .disabled(!chat.isConnected || chat.isSending)
                        RowIconButton(symbol: isExpanded ? "chevron.up" : "chevron.down", help: isExpanded ? "Hide sessions" : "Show sessions") {
                            withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
                        }
                    }
                    .padding(.top, 6).padding(.trailing, 6)
                    .transition(.opacity)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(isExpanded ? "Hide sessions" : "Show sessions")
            if isExpanded {
                VStack(alignment: .leading, spacing: 10) {
                    if project.next != nil, !project.summary.isEmpty {
                        Text(project.summary).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                    Text(meta).font(.caption).foregroundStyle(.tertiary)
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(project.sessions) { session in
                            ProjectSessionRow(chat: chat, session: session)
                        }
                    }
                }
                .padding(.leading, 32).padding(.trailing, 12).padding(.bottom, 12)
                .transition(.opacity)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isExpanded ? Color(nsColor: .controlBackgroundColor) : Color.primary.opacity(hovering ? 0.045 : 0))
        )
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(isExpanded ? 0.07 : 0)))
        .onHover { hovering = $0 }
        .animation(.easeInOut(duration: 0.12), value: hovering)
    }

    private var meta: String {
        let sessions = project.sessions.count == 1 ? "1 session" : "\(project.sessions.count) sessions"
        return ([sessions] + project.repositories.prefix(3)).joined(separator: " · ")
    }
}

private struct ProjectSessionRow: View {
    @ObservedObject var chat: ChatModel
    let session: ProjectSession
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task { await chat.readSession(TurnReference(sessionId: session.sessionId, source: session.source, title: session.title, url: nil)) }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    AgentIconView(source: session.source, size: 14).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title).font(.system(size: 13, weight: .medium))
                            .lineLimit(2).multilineTextAlignment(.leading)
                        Text("\(session.reason) · \(RelativeTime.string(for: SkipDate.parse(session.lastActiveAt)))")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 8)
                    if hovering {
                        Label("History", systemImage: "clock.arrow.circlepath")
                            .font(.caption).foregroundStyle(Color.accentColor)
                    } else {
                        StatePill(state: session.state, compact: true)
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(hovering ? 0.05 : 0), in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
            }
            .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
            .onHover { hovering = $0 }
            .help("Read this session’s history")
            if session.canPush, let nudge = session.nudge, let key = session.pushKey {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Skip’s next message", systemImage: "text.bubble")
                        .font(.caption.weight(.semibold)).foregroundStyle(SkipWorkState.ready.tint)
                    Text(nudge).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if let receipt = session.receipt {
                        Label(receipt.message, systemImage: receipt.sent ? "checkmark.circle.fill" : "info.circle")
                            .font(.caption).foregroundStyle(receipt.sent ? SkipWorkState.ready.tint : .secondary)
                    } else {
                        if let note = chat.pushNotes[key] {
                            Label(note, systemImage: "exclamationmark.circle")
                                .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        }
                        Button {
                            Task { await chat.pushAlong([session]) }
                        } label: {
                            if chat.pendingPushes.contains(key) {
                                ProgressView().controlSize(.small)
                            } else {
                                Label("Send as me", systemImage: "paperplane.fill")
                            }
                        }
                        .controlSize(.small)
                        .disabled(chat.pendingPushes.contains(key))
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(SkipWorkState.ready.tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
                .padding(.leading, 32)
            }
        }
    }
}

/// A small icon button that only shows its background under the pointer.
struct RowIconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 12, weight: .medium))
                .frame(width: 26, height: 26)
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .foregroundStyle(.secondary)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// Plain content with a soft fill under the pointer and when pressed.
struct HoverPlainButtonStyle<S: Shape>: ButtonStyle {
    let shape: S

    func makeBody(configuration: Configuration) -> some View {
        HoverBody(configuration: configuration, shape: shape)
    }

    private struct HoverBody: View {
        let configuration: Configuration
        let shape: S
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.isFocused) private var isFocused
        @State private var hovering = false

        var body: some View {
            configuration.label
                .background(Color.primary.opacity(configuration.isPressed && isEnabled ? 0.12 : (hovering && isEnabled ? 0.07 : 0)), in: shape)
                .overlay(shape.stroke(CloudTheme.ring.opacity(isFocused && isEnabled ? 1 : 0), lineWidth: 2))
                .contentShape(shape)
                .opacity(isEnabled ? 1 : 0.45)
                .onHover { hovering = $0 }
                .actionCursor()
                .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: hovering)
        }
    }
}

private struct StatePill: View {
    let state: SkipWorkState
    var compact = false
    var body: some View {
        Text(state.title)
            .font(.system(size: compact ? 10.5 : 11, weight: .semibold))
            .foregroundStyle(state.tint)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(state.tint.opacity(0.12), in: Capsule())
            .fixedSize()
    }
}

extension SkipWorkState {
    var tint: Color {
        switch self {
        case .needsYou: return .orange
        case .ready: return Color(red: 0.18, green: 0.62, blue: 0.40)
        case .working: return AgentRelayButtonTheme.background
        case .idle: return .secondary
        case .done: return .secondary
        }
    }

    /// Folded away below the active projects.
    var isQuiet: Bool { self == .done || self == .idle }
}

private extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
