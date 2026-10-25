import SwiftUI
import RelayDesktopCore

@MainActor
final class LocalTranscriptModel: ObservableObject {
    @Published private(set) var entries: [LocalTranscriptEntry] = []
    @Published private(set) var cursor: LocalTranscriptCursor?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private let client: CoreClient
    let row: LocalSessionRow
    /// The row's session as last read: a spawned agent's changes as it is
    /// taken over.
    private(set) var session: LocalSession?
    /// Where following continues once the whole transcript is read, and the
    /// spawned agent read from (nil: the session's transcript).
    private var followFrom: LocalTranscriptCursor?
    private var followReady = false
    private var readAgent: String?
    /// Bumped by every read: a follow that a read overtook drops its page.
    private var reads = 0

    init(row: LocalSessionRow, client: CoreClient) {
        self.row = row
        self.client = client
        session = row.relay
    }

    /// One page: a spawned agent's own output while Agent Relay runs it
    /// headless, else the session's transcript.
    private func page(_ cursor: LocalTranscriptCursor?, sessionID: String, agent: String?) async throws -> LocalTranscriptPage {
        if let agent { return try await client.agentsTranscript(AgentTranscriptParams(cursor: cursor, name: agent)) }
        return try await client.sessionsTranscript(LocalTranscriptParams(cursor: cursor, sessionId: sessionID, source: row.source))
    }

    func load(more: Bool = false) async {
        guard !loading else { return }
        guard let sessionID = row.upload?.sessionId ?? row.relay?.target.id else { return }
        loading = true
        reads += 1
        if !more { cursor = nil }
        error = nil
        followReady = false
        let agent = SpawnHandover.transcriptAgent(session)
        readAgent = agent
        defer { loading = false }
        do {
            var next = more ? cursor : nil
            var seen = Set<LocalTranscriptCursor>()
            var replace = !more
            repeat {
                try Task.checkCancellation()
                let requested = next
                let page = try await page(next, sessionID: sessionID, agent: agent)
                try Task.checkCancellation()
                if replace {
                    entries = page.entries
                    replace = false
                } else {
                    let existing = Set(entries.map(\.id))
                    entries += page.entries.filter { !existing.contains($0.id) }
                }
                cursor = page.nextCursor
                if let cursor, cursor == next || !seen.insert(cursor).inserted {
                    error = "The transcript stopped advancing. Try refreshing this session."
                    return
                }
                if page.nextCursor == nil {
                    followFrom = SpawnHandover.followCursor(requested: requested, page: page)
                    followReady = true
                }
                next = cursor
                await Task.yield()
            } while next != nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    /// Reads what a spawned agent wrote since the last read; reads it all
    /// again when what it is read from changed (it was taken over).
    func follow(_ session: LocalSession?) async {
        self.session = session ?? self.session
        guard !loading, error == nil, followReady,
              let sessionID = row.upload?.sessionId ?? row.relay?.target.id else { return }
        let agent = SpawnHandover.transcriptAgent(self.session)
        if agent != readAgent { return await load() }
        let read = reads
        var next = followFrom
        while let page = try? await page(next, sessionID: sessionID, agent: agent) {
            // A refresh or take-over read replaced the transcript meanwhile.
            guard read == reads, !loading else { return }
            let existing = Set(entries.map(\.id))
            entries += page.entries.filter { !existing.contains($0.id) }
            guard let more = page.nextCursor, more != next else {
                followFrom = SpawnHandover.followCursor(requested: next, page: page)
                return
            }
            next = more
        }
    }
}

struct LocalTranscriptView: View {
    @StateObject private var transcript: LocalTranscriptModel
    @ObservedObject var relay: RelayModel

    init(row: LocalSessionRow, client: CoreClient, relay: RelayModel) {
        _transcript = StateObject(wrappedValue: LocalTranscriptModel(row: row, client: client))
        self.relay = relay
    }

    /// The row's session as last read.
    private var session: LocalSession? {
        relay.sessions.first { $0.id == transcript.row.relay?.id } ?? transcript.row.relay
    }

    private var transcriptScroll: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if transcript.entries.isEmpty && transcript.cursor == nil && !transcript.loading && transcript.error == nil {
                    VStack(spacing: 10) {
                        Image(systemName: "text.bubble").font(.system(size: 28)).foregroundStyle(CloudTheme.secondary.opacity(0.7))
                        Text("No local transcript available").font(.headline)
                        Text("This session’s contents are not available on this machine.").foregroundStyle(CloudTheme.secondary)
                    }.frame(maxWidth: .infinity).padding(.vertical, 60)
                }
                ForEach(transcriptGroups(transcript.entries), id: \.first!.id) { entries in
                    TranscriptGroupView(entries: entries, source: transcript.row.source)
                }
                if let error = transcript.error {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Couldn’t read this session", systemImage: "exclamationmark.triangle").font(.headline)
                        Text(error).font(.caption).foregroundStyle(CloudTheme.secondary).textSelection(.enabled)
                        Button("Try again") { Task { await transcript.load(more: transcript.cursor != nil) } }
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                }
                if transcript.loading {
                    HStack(spacing: 10) { ProgressView().controlSize(.small); Text("Reading local transcript…").foregroundStyle(CloudTheme.secondary) }
                        .frame(maxWidth: .infinity).padding(20)
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 32).padding(.vertical, 30)
            .frame(maxWidth: .infinity)
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                transcriptScroll
                if SpawnHandover.joins(session), let registration = session?.registration {
                    Divider().overlay(CloudTheme.border)
                    Text(SpawnHandover.following).font(.caption).foregroundStyle(CloudTheme.secondary)
                        .frame(maxWidth: 760, alignment: .leading).padding(.horizontal, 32).padding(.top, 8)
                        .frame(maxWidth: .infinity)
                    SpawnComposer(relay: relay, name: registration.name, address: registration.address)
                }
            }
            Divider().overlay(CloudTheme.border)
            LocalSessionSidebar(row: transcript.row, relay: relay, loading: transcript.loading,
                                refresh: { Task { await transcript.load() } })
                .frame(width: 250)
        }
        .background(CloudTheme.background)
        .task { await transcript.load() }
        // A spawned agent's transcript is followed live while it is shown.
        .task(id: transcript.row.id) {
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
                if SpawnHandover.of(session) != nil { await transcript.follow(session) }
            }
        }
    }
}

func transcriptGroups(_ entries: [LocalTranscriptEntry]) -> [[LocalTranscriptEntry]] {
    var groups: [[LocalTranscriptEntry]] = []
    for entry in entries {
        if isTranscriptTool(entry), let last = groups.last, let first = last.first, isTranscriptTool(first) {
            groups[groups.count - 1].append(entry)
        } else {
            groups.append([entry])
        }
    }
    return groups
}

private func isTranscriptTool(_ entry: LocalTranscriptEntry) -> Bool {
    entry.kind == "tool_use" || entry.kind == "tool_result" || entry.role == "tool_result"
}

private struct TranscriptGroupView: View {
    let entries: [LocalTranscriptEntry]
    let source: String
    @State private var expanded = false

    var body: some View {
        let count = entries.filter { $0.kind == "tool_use" }.count
        if entries.first.map(isTranscriptTool) == true {
            VStack(alignment: .leading, spacing: 8) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Text(count == 0 ? "Tool results" : "\(count) tool call\(count == 1 ? "" : "s")")
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                    }.font(.system(size: 12)).padding(.vertical, 6).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(CloudTheme.secondary)
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if expanded {
                    ForEach(entries, id: \.id) { entry in
                        TranscriptEntryView(entry: entry, source: source)
                    }
                }
            }
        } else {
            ForEach(entries, id: \.id) { entry in
                TranscriptEntryView(entry: entry, source: source)
            }
        }
    }
}

private struct TranscriptEntryView: View {
    @EnvironmentObject private var model: AppModel
    let entry: LocalTranscriptEntry
    let source: String
    @State private var expanded = false
    @State private var hovering = false
    private var activity: Bool { entry.kind != "text" || entry.role == "tool_result" }
    private var user: Bool { entry.role == "user" && !activity }
    private var title: String {
        switch entry.kind {
        case "thinking": return "Thinking"
        case "tool_use": return "Tool call"
        case "tool_result": return "Tool result"
        case "context": return "Session context"
        default: return entry.role == "tool_result" ? "Tool result" : "Session activity"
        }
    }
    private var glyph: String {
        switch entry.kind {
        case "thinking": return "sparkle"
        case "context": return "doc.text"
        default: return "terminal"
        }
    }

    var body: some View {
        if activity {
            VStack(alignment: .leading, spacing: 0) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 9) {
                        Image(systemName: glyph)
                        Text(title).fontWeight(.medium)
                        if !expanded {
                            Text(entry.text.replacingOccurrences(of: "\n", with: " "))
                                .lineLimit(1).foregroundStyle(CloudTheme.secondary.opacity(0.7))
                        }
                        Spacer(minLength: 4)
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
                    }.font(.system(size: 12)).padding(12).contentShape(Rectangle())
                }.buttonStyle(NavButtonStyle(kind: .icon))
                    .help(expanded ? "Collapse \(title.lowercased())" : "Expand \(title.lowercased())")
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if expanded {
                    Divider().hidden().overlay(CloudTheme.border).padding(.horizontal, 12)
                    HStack { Spacer(); copyButton }.padding(.horizontal, 8).padding(.top, 4)
                    if entry.kind == "thinking" {
                        ChatMarkdownView(entry.text).textSelection(.enabled).padding(14)
                    } else {
                        ScrollView(.horizontal) {
                            Text(entry.text.isEmpty ? "No text recorded." : entry.text)
                                .font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: false)
                        }.padding(14)
                    }
                    truncation
                }
            }.background(CloudTheme.card, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(CloudTheme.border))
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 7) {
                    if user {
                        PersonAvatar(name: model.accountName ?? "You", url: model.accountAvatarURL.flatMap(URL.init(string:)), size: 22)
                    } else { AgentIconView(source: source, size: 18) }
                    Text(user ? "You" : AgentIconView.name(for: source)).font(.system(size: 12, weight: .semibold))
                    Text(Date(timeIntervalSince1970: Double(entry.timestampMs) / 1000), style: .time)
                        .font(.system(size: 10)).foregroundStyle(CloudTheme.secondary.opacity(0.7))
                    Spacer()
                    copyButton.opacity(hovering ? 1 : 0.35)
                }
                if let path = entry.imagePath, let image = NSImage(contentsOfFile: path) {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                        .frame(maxWidth: 640, maxHeight: 480)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .accessibilityLabel("Attached image")
                } else if entry.imagePath != nil {
                    Text("Image unavailable").foregroundStyle(CloudTheme.secondary)
                }
                if !entry.text.isEmpty || entry.imagePath == nil {
                    ChatMarkdownView(entry.text.isEmpty ? "No text recorded." : entry.text).textSelection(.enabled)
                }
                truncation
            }
            .padding(user ? 18 : 0)
            .background(user ? CloudTheme.muted : .clear, in: RoundedRectangle(cornerRadius: 14))
            .padding(.leading, user ? 48 : 0)
            .onHover { hovering = $0 }
        }
    }

    private var copyButton: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(entry.text, forType: .string)
        } label: {
            Image(systemName: "doc.on.doc").font(.system(size: 10)).frame(width: 26, height: 24)
        }.buttonStyle(NavButtonStyle(kind: .icon)).help("Copy message").accessibilityLabel("Copy message")
    }

    @ViewBuilder private var truncation: some View {
        if entry.truncated {
            Text("Long message shortened. Open the original session for the full output.")
                .font(.caption).foregroundStyle(CloudTheme.secondary).padding(8)
        }
    }
}
