import SwiftUI
import AppKit
import RelayDesktopCore

/// Session controls stay live while the local transcript is open.
struct LocalSessionSidebar: View {
    @EnvironmentObject private var model: AppModel
    let row: LocalSessionRow
    @ObservedObject var relay: RelayModel
    let loading: Bool
    let refresh: () -> Void
    @State private var confirmsDeletion = false
    @State private var deletionRevision = 0
    @State private var newName = ""
    @State private var renaming = false
    @State private var renameStatus: String?

    private var upload: UploadSession? {
        model.sessions.first { $0.id == row.id } ?? row.upload
    }
    private var session: LocalSession? {
        LocalSessionRow.relaySession(for: row.id, in: relay.sessions)
    }
    private var agent: LocalAgent? { session.flatMap { relay.agent(for: $0) } }
    private var requestedName: String {
        newName.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@")).lowercased()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    if let session, SpawnHandover.of(session) == .takeOver {
                        SpawnTakeOverButton(row: row, session: session, relay: relay)
                    } else {
                        SessionOpenButton(row: row, session: session)
                    }
                    if let session, let name = session.registration?.name, SpawnHandover.of(session) == .takenOver {
                        Text(SpawnHandover.takenOver(name)).font(.caption).foregroundStyle(CloudTheme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let session, let error = relay.takeOverErrors[session.id] {
                        Text("\(SpawnHandover.failedTitle): \(error)").font(.caption).foregroundStyle(CloudTheme.warning)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                    if let upload, let url = SessionNavigation.cloudURL(siteURL: model.siteURL, session: upload) {
                        Button { NSWorkspace.shared.open(url) } label: {
                            Label("View on web", systemImage: "globe").frame(maxWidth: .infinity)
                        }.buttonStyle(CloudControlStyle(height: 38, horizontalPadding: 12))
                            .help("Open this session in Cloud in your browser")
                    }
                    Button(action: refresh) {
                        Label("Refresh transcript", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }.buttonStyle(CloudControlStyle(height: 38, horizontalPadding: 12)).disabled(loading)
                }
                Divider().overlay(CloudTheme.border)
                VStack(alignment: .leading, spacing: 10) {
                    Text("Messaging").fontWeight(.semibold)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Receive messages")
                            Spacer()
                            if let session {
                                let presence = relay.presence(of: session)
                                Toggle("Receive messages", isOn: Binding(
                                    get: { presence.isOn },
                                    set: { relay.requestRelay($0, for: session) }
                                )).labelsHidden().toggleStyle(RelaySwitchStyle())
                                    .disabled(model.hiddenSessionIDs.contains(row.id) || renaming || !relay.canToggle(session, presence: presence))
                                    .help("Receive messages from other agents. This also uploads the session to Cloud.")
                            } else {
                                Toggle("Receive messages", isOn: .constant(false))
                                    .labelsHidden().toggleStyle(RelaySwitchStyle()).disabled(true)
                            }
                        }
                        Text(session.map { relay.presence(of: $0).messageStatus } ?? "Offline")
                            .foregroundStyle(CloudTheme.secondary)
                        if session == nil || (session?.live == false && session?.registration == nil) {
                            Text("Start session to receive messages.")
                                .foregroundStyle(CloudTheme.secondary)
                        } else if relay.workspace == nil {
                            Text("Connect a workspace to receive messages.").foregroundStyle(CloudTheme.secondary)
                        }
                        if let session, let error = relay.errors[session.id] { Text(error).foregroundStyle(CloudTheme.warning) }
                    }
                    if let session, relay.presence(of: session).isOn, let agent, !agent.name.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Agent name").help("The name other agents see on Agent Relay. Your session title stays the same.")
                                Spacer()
                                Button {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(agent.displayName, forType: .string)
                                } label: { Image(systemName: "doc.on.doc") }
                                    .buttonStyle(CloudControlStyle(flat: true))
                                    .help("Copy name").accessibilityLabel("Copy name")
                            }
                            HStack(spacing: 6) {
                                TextField("Agent name", text: $newName).textFieldStyle(.roundedBorder)
                                    .accessibilityLabel("Agent name").onSubmit(rename)
                                    .help(AgentNameText.renameNote(name: agent.name, alias: agent.alias))
                                    .disabled(renaming)
                                Button(renaming ? "Renaming…" : "Rename", action: rename)
                                    .disabled(renaming || relay.busyTargets.contains(agent.target.key) || requestedName.isEmpty || requestedName == agent.displayName)
                            }
                            if let renameStatus { Text(renameStatus).textSelection(.enabled) }
                        }.padding(.top, 4)
                    }
                }
                Divider().overlay(CloudTheme.border)
                VStack(alignment: .leading, spacing: 6) {
                    if let upload {
                        HStack {
                            Text("Upload session")
                            Spacer()
                            Toggle("Upload session", isOn: Binding(
                                get: { !model.stoppingUploads.contains(upload.id) && (upload.included || model.requestingUploads.contains(upload.id)) },
                                set: { on in
                                    if on { Task { await model.includeSessions(keys: [upload.id]) } }
                                    else { deletionRevision = model.uploadConnectionRevision; confirmsDeletion = true }
                                }
                            )).labelsHidden().toggleStyle(RelaySwitchStyle())
                                .disabled(model.hiddenSessionIDs.contains(row.id) || !model.canSelectSession(upload))
                                .help("Upload this session and future changes to Cloud.")
                        }
                        let state = model.uploadState(for: upload)
                        HStack(spacing: 6) {
                            SessionStatusCell(state: state, stopping: model.stoppingUploads.contains(upload.id))
                            Text(model.stoppingUploads.contains(upload.id) ? "Deleting…" : state.iconTitle)
                        }.foregroundStyle(CloudTheme.secondary)
                    } else {
                        Text("Upload session")
                        Label(SessionUploadState.discovering.iconTitle, systemImage: SessionUploadState.discovering.symbol)
                            .help(SessionUploadState.discovering.detail)
                            .foregroundStyle(CloudTheme.secondary)
                    }
                    if let error = model.uploadErrors[row.id] { Text(error).foregroundStyle(CloudTheme.warning) }
                }
                Spacer(minLength: 0)
            }.font(.system(size: 12)).padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(CloudTheme.card)
        .onAppear { newName = agent?.displayName ?? "" }
        .onChange(of: agent?.displayName) { newName = $0 ?? "" }
        .confirmationDialog("Delete this session from Cloud?", isPresented: $confirmsDeletion) {
            Button("Delete from Cloud", role: .destructive) {
                if let upload { Task { await model.excludeSessions(keys: [upload.id], confirmedAt: deletionRevision) } }
            }
        } message: {
            Text("This removes the uploaded copy of this session and its subagents from Cloud and stops future uploads. Your local history stays on this machine. Turn Upload session on again to upload a new copy.")
        }
    }

    private func rename() {
        guard let agent, !renaming, !relay.busyTargets.contains(agent.target.key),
              !requestedName.isEmpty, requestedName != agent.displayName else { return }
        let name = requestedName
        renaming = true
        renameStatus = nil
        Task {
            switch await relay.rename(agent, to: name) {
            case .renamed(let message): renameStatus = message
            case .failed(let error): renameStatus = error
            }
            renaming = false
        }
    }
}
