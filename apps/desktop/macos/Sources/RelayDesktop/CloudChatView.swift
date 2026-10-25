import AppKit
import RelayDesktopCore
import SwiftUI

/// The conversation with Skip beside Projects. One conversation at a time:
/// "New chat" starts over, and the empty state offers a first question.
struct CloudChatView: View {
    @ObservedObject var chat: ChatModel
    @FocusState private var composerFocused: Bool

    private static let suggestions = [
        ("exclamationmark.bubble", "What’s blocked and why?"),
        ("list.number", "What should I look at first?"),
        ("forward", "Which sessions can you push along?"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if chat.messages.isEmpty { welcome }
                        ForEach(chat.messages) { message in
                            ChatMessageView(chat: chat, message: message)
                        }
                        if chat.isSending { ThinkingRow() }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 18).padding(.vertical, 18)
                }
                .onChange(of: chat.messages.count) { _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: chat.isSending) { _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            composer
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            SkipAvatar(size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text("Skip").font(.system(size: 14, weight: .semibold))
                HStack(spacing: 5) {
                    Circle().fill(status.color).frame(width: 6, height: 6)
                    Text(status.text).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if !chat.messages.isEmpty {
                Button { startNewChat() } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                        .font(.system(size: 12, weight: .medium))
                        .padding(.horizontal, 9).padding(.vertical, 5)
                }
                .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 7)))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.primary.opacity(0.12)))
                .keyboardShortcut("n", modifiers: .command)
                .disabled(chat.isSending)
                .help("Start a new conversation (⌘N)")
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 16).frame(height: 56)
        .animation(.easeInOut(duration: 0.15), value: chat.messages.isEmpty)
    }

    private var status: (text: String, color: Color) {
        if chat.isConnected { return (chat.isSending ? "Thinking…" : "Ready", SkipWorkState.ready.tint) }
        if chat.needsSignIn { return ("Sign in needed", .orange) }
        return ("Offline", .secondary)
    }

    private func startNewChat() {
        chat.newConversation()
        composerFocused = true
    }

    // MARK: Empty state

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Ask about any project").font(.system(size: 17, weight: .semibold))
                Text("Skip reads the same sessions you see here. It can explain what’s stuck and draft messages to your agents; nothing is sent without you.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: 6) {
                ForEach(Self.suggestions, id: \.1) { symbol, question in
                    SuggestionButton(symbol: symbol, text: question) {
                        Task { await chat.ask(question) }
                    }
                    .disabled(!chat.isConnected || chat.isSending)
                }
            }
        }
        .padding(.top, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Composer

    private var canSend: Bool {
        chat.isConnected && !chat.isSending
            && !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error = chat.error, chat.isConnected || !chat.needsSignIn {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(chat.isConnected ? "Message Skip…" : "Skip is not connected", text: $chat.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .lineLimit(1...8)
                    .focused($composerFocused)
                    .onSubmit(send)
                    .padding(.vertical, 5)
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(AgentRelayPrimaryButtonStyle(height: 26, horizontalPadding: 0))
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .help("Send (Return)")
                .accessibilityLabel("Send message to Skip")
            }
            .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 6)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .strokeBorder(composerFocused ? Color.accentColor.opacity(0.6) : Color.primary.opacity(0.12), lineWidth: composerFocused ? 1.5 : 1))
            .contentShape(Rectangle())
            .onTapGesture { composerFocused = true }
            Text("Return to send · Shift-Return for a new line")
                .font(.caption2).foregroundStyle(.tertiary)
                .padding(.leading, 4)
                .opacity(composerFocused ? 1 : 0)
        }
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 8)
        .animation(.easeInOut(duration: 0.12), value: composerFocused)
    }

    private func send() {
        Task {
            guard canSend else { return }
            await chat.send()
        }
    }
}

/// Skip's mark: the chat glyph on the brand blue.
struct SkipAvatar: View {
    var size: CGFloat = 24
    var body: some View {
        Image(systemName: "sparkle")
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(
                LinearGradient(colors: [Color(red: 0.29, green: 0.56, blue: 0.87), Color(red: 0.18, green: 0.42, blue: 0.61)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: Circle())
            .accessibilityHidden(true)
    }
}

private struct SuggestionButton: View {
    let symbol: String
    let text: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Color.accentColor).frame(width: 18)
                Text(text).font(.callout).multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.1)))
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 10)))
        .help("Ask Skip")
    }
}

private struct ThinkingRow: View {
    @State private var phase = 0.0
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            SkipAvatar(size: 22)
            HStack(spacing: 4) {
                ForEach(0..<3) { index in
                    Circle().fill(Color.secondary)
                        .frame(width: 6, height: 6)
                        .opacity(0.3 + 0.7 * max(0, sin(phase - Double(index) * 0.8)))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(Color.primary.opacity(0.05), in: Capsule())
            Text("Reading your sessions…").font(.caption).foregroundStyle(.secondary)
        }
        .onAppear { withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) { phase = .pi * 2 } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Skip is thinking")
    }
}

private struct ChatMessageView: View {
    @ObservedObject var chat: ChatModel
    let message: ConversationTurn
    @State private var hovering = false
    @State private var showsSources = false
    @State private var copied = false

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        Group {
            if isUser { userBubble } else { skipReply }
        }
        .onHover { hovering = $0 }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 48)
            Text(message.content)
                .font(.system(size: 13))
                .textSelection(.enabled)
                .padding(.horizontal, 13).padding(.vertical, 9)
                .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
                .overlay(alignment: .topLeading) { copyButton.offset(x: -30, y: 2) }
        }
    }

    private var skipReply: some View {
        HStack(alignment: .top, spacing: 10) {
            SkipAvatar(size: 22)
            VStack(alignment: .leading, spacing: 10) {
                ChatMarkdownView(message.content).textSelection(.enabled)
                ForEach(message.actions.filter { $0.type == "send_message" }) { action in
                    DraftMessageCard(chat: chat, action: action)
                }
                if !message.references.isEmpty {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { showsSources.toggle() }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "doc.text.magnifyingglass").font(.system(size: 10))
                            Text(message.references.count == 1 ? "1 source" : "\(message.references.count) sources")
                            Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
                                .rotationEffect(.degrees(showsSources ? 90 : 0))
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                    }
                    .buttonStyle(HoverPlainButtonStyle(shape: Capsule()))
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.1)))
                    if showsSources {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(message.references) { reference in
                                SessionReferenceButton(chat: chat, reference: reference)
                            }
                        }
                        .transition(.opacity)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            copyButton
        }
    }

    private var copyButton: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message.content, forType: .string)
            copied = true
            Task { try? await Task.sleep(nanoseconds: 1_200_000_000); copied = false }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11)).frame(width: 24, height: 24)
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .foregroundStyle(.secondary)
        .opacity(hovering || copied ? 1 : 0)
        .help("Copy message")
        .accessibilityLabel("Copy message")
    }
}

/// A message Skip drafted for an agent. It is only sent from here.
private struct DraftMessageCard: View {
    @ObservedObject var chat: ChatModel
    let action: TurnAction

    @EnvironmentObject private var model: AppModel

    private var name: String {
        model.relay.sessions.first(where: { $0.id == action.agentId })?.registration.map { "@\($0.name)" } ?? action.agentId
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Draft to \(name)", systemImage: "paperplane")
                .font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
            Text(action.message).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if let receipt = action.receipt {
                Label(receipt.message, systemImage: receipt.sent ? "checkmark.circle" : "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Button {
                    Task { await chat.sendAction(action) }
                } label: {
                    Label("Send to \(name)", systemImage: "paperplane.fill")
                }
                .controlSize(.small)
                .buttonStyle(AgentRelayPrimaryButtonStyle())
                .disabled(chat.pendingActions.contains(action.id))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.opacity(0.18)))
    }
}

struct SessionReferenceButton: View {
    @ObservedObject var chat: ChatModel
    let reference: TurnReference
    var body: some View {
        Button {
            Task { await chat.readSession(reference) }
        } label: {
            Label(reference.title ?? reference.sessionId, systemImage: "clock.arrow.circlepath")
                .font(.callout).foregroundStyle(Color.accentColor)
                .lineLimit(2).multilineTextAlignment(.leading)
                .padding(.horizontal, 6).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .help("Read this session’s history")
    }
}

struct CloudSessionDetail: View {
    @ObservedObject var chat: ChatModel
    let reference: TurnReference
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(reference.title ?? "Session history").font(.title3.weight(.semibold)).lineLimit(2)
                    Text(reference.sessionId).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding(20)
            Divider()
            if let error = chat.error { Text(error).foregroundStyle(.red).padding(16) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    Text("Newest activity first").font(.caption).foregroundStyle(.secondary)
                    ForEach(chat.events) { event in
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text(event.actorName ?? event.actorRole ?? event.toolName ?? event.kind ?? "Event").font(.caption.weight(.semibold))
                                Spacer()
                                if let date = event.ts { Text(CloudDate.display(date)).font(.caption).foregroundStyle(.secondary) }
                            }
                            if let content = event.content, !content.isEmpty { ChatMarkdownView(content).textSelection(.enabled) }
                            else if let tool = event.toolName { Text("\(tool) · \(event.toolStatus ?? "recorded")").font(.callout) }
                            else { Text("Activity recorded without message content.").font(.callout).foregroundStyle(.secondary) }
                            if event.contentTruncated == true { Text("This event’s content was truncated by the history service.").font(.caption).foregroundStyle(.secondary) }
                        }.padding(14).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                    }
                    if chat.isLoadingEvents { ProgressView() }
                    else if chat.events.isEmpty { Text("No uploaded events found for this session.").foregroundStyle(.secondary) }
                    if chat.eventsCursor != nil {
                        Button("Load older activity") { Task { await chat.readSession(reference, more: true) } }.disabled(chat.isLoadingEvents)
                    }
                }.padding(20)
            }
        }.frame(minWidth: 660, idealWidth: 760, minHeight: 500, idealHeight: 650)
    }
}

private enum CloudDate {
    static func display(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        return date?.formatted(date: .abbreviated, time: .shortened) ?? value
    }
}

// Observe the selected session independently of the app's top-level state.
struct CloudSessionSheetHost: View {
    @ObservedObject var chat: ChatModel
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .sheet(item: $chat.selectedSession) { reference in
                CloudSessionDetail(chat: chat, reference: reference)
            }
    }
}
