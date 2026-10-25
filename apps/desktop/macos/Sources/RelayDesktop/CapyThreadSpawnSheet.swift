import AppKit
import RelayDesktopCore
import SwiftUI

/// Starts a headless Capy thread through Agent Relay Cloud, then follows it
/// until the thread has bound itself as a relay agent.
struct CapyThreadSpawnSheet: View {
    @ObservedObject var relay: RelayModel
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var projects: [CapyProject] = []
    @State private var projectID = ""
    @State private var task = ""
    @State private var capyModel = ""
    @State private var pullRequestAuthor = ""
    @State private var operation: CapySpawnOperation?
    @State private var result: CapyThreadSpawn?
    @State private var loadingProjects = true
    @State private var starting = false
    @State private var error: String?
    @State private var projectError: String?

    private var workspaceID: String { model.workspaceID ?? "" }
    private var boundAgent: String? {
        guard result?.binding.state == .bound else { return nil }
        return result?.binding.agent
    }
    private var canStart: Bool {
        !loadingProjects && !starting && !projectID.isEmpty
            && !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Start Capy thread").font(.title3.weight(.semibold))
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }

            if starting {
                status(CapySpawnPresentation.starting, spinning: true)
            } else if let result {
                resultView(result)
            } else {
                form
            }
        }
        .padding(20)
        .frame(width: 520)
        .task(id: workspaceID) { await load() }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Start a headless Capy session in this workspace. It will join Agent Relay on its first turn.")
                .font(.callout).foregroundStyle(.secondary)

            field("Project") {
                if loadingProjects {
                    HStack { ProgressView().controlSize(.small); Text("Loading Capy projects…") }
                } else if projects.isEmpty {
                    Text("No Capy projects are available.").foregroundStyle(.secondary)
                } else {
                    Picker("Project", selection: $projectID) {
                        ForEach(projects, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    .labelsHidden()
                }
            }

            field("Task") {
                TextEditor(text: $task)
                    .font(.body)
                    .frame(minHeight: 110)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                    .accessibilityLabel("Task")
            }

            field("Model (optional)") {
                TextField("Use the project default", text: $capyModel)
            }

            field("Pull request author") {
                Picker("Pull request author", selection: $pullRequestAuthor) {
                    Text("Project default").tag("")
                    Text("You").tag("user")
                    Text("Capy").tag("capy")
                }
                .labelsHidden()
            }

            if let error = error ?? projectError {
                VStack(alignment: .leading, spacing: 6) {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                    if error.localizedCaseInsensitiveContains("Capy is not connected"),
                       let url = CapySpawnPresentation.cloudSettingsURL(siteURL: model.siteURL) {
                        Button("Agent Relay Cloud → Settings → Workspace → Capy") {
                            NSWorkspace.shared.open(url)
                        }
                        .buttonStyle(.link)
                    }
                }
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button(operation == nil ? "Start" : "Retry") { Task { await start() } }
                    .buttonStyle(AgentRelayPrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canStart)
            }
        }
    }

    @ViewBuilder
    private func resultView(_ result: CapyThreadSpawn) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if let agent = boundAgent {
                Label("Running on the relay", systemImage: "checkmark.circle.fill")
                    .font(.headline).foregroundStyle(.green)
                detail("Thread", result.threadId)
                detail("Agent", agent.hasPrefix("@") ? agent : "@\(agent)")
                HStack {
                    Button("Start another") { startAnother() }
                    Spacer()
                    Button("Message") {
                        model.messageEndpoint = agent.hasPrefix("@") ? agent : "@\(agent)"
                        model.agentsSheet = .message
                    }
                .buttonStyle(AgentRelayPrimaryButtonStyle())
                }
            } else {
                status(CapySpawnPresentation.waiting, spinning: error == nil)
                detail("Thread", result.threadId)
                Text("Capy must finish its first-turn Agent Relay binding before messages can be delivered.")
                    .font(.callout).foregroundStyle(.secondary)
                if let error {
                    HStack {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.orange)
                        Spacer()
                        Button("Check again") { Task { await follow(result.threadId) } }
                    }
                }
            }
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            content()
        }
    }

    private func status(_ message: String, spinning: Bool) -> some View {
        HStack(spacing: 10) {
            if spinning { ProgressView().controlSize(.small) }
            Text(message).font(.headline)
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).frame(width: 58, alignment: .trailing)
            Text(value).textSelection(.enabled)
        }
    }

    @MainActor
    private func load() async {
        guard !workspaceID.isEmpty else {
            loadingProjects = false
            error = "Sign in to Agent Relay Cloud to start a Capy thread."
            return
        }
        if let saved = relay.savedCapySpawn(workspaceID: workspaceID) {
            operation = saved
            projectID = saved.projectID
            task = saved.task
            capyModel = saved.model ?? ""
            pullRequestAuthor = saved.pullRequestAuthor ?? ""
            if let threadID = saved.threadID {
                result = CapyThreadSpawn(
                    binding: CapyBinding(state: .pending),
                    status: "unknown",
                    threadId: threadID
                )
                await follow(threadID)
            }
        }
        do {
            projects = try await relay.capyProjects()
            projectError = nil
            if projectID.isEmpty { projectID = projects.first?.id ?? "" }
        } catch {
            projectError = error.localizedDescription
        }
        loadingProjects = false
    }

    @MainActor
    private func start() async {
        error = nil
        let trimmedTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        let selectedModel = capyModel.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let prepared = try relay.prepareCapySpawn(
                workspaceID: workspaceID,
                projectID: projectID,
                task: trimmedTask,
                model: selectedModel.isEmpty ? nil : selectedModel,
                pullRequestAuthor: pullRequestAuthor.isEmpty ? nil : pullRequestAuthor,
                reportTo: nil
            )
            operation = prepared
            starting = true
            let (saved, created) = try await relay.startCapyThread(prepared)
            operation = saved
            result = created
            starting = false
            if created.binding.state != .bound { await poll(created.threadId) }
        } catch {
            starting = false
            self.error = error.localizedDescription
        }
    }

    @MainActor
    private func follow(_ threadID: String) async {
        error = nil
        do {
            let current = try await relay.capyThreadStatus(threadID)
            result = current
            error = nil
            if current.binding.state != .bound { await poll(threadID) }
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor
    private func poll(_ threadID: String) async {
        for _ in 0..<60 where !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            do {
                let current = try await relay.capyThreadStatus(threadID)
                result = current
                error = nil
                if current.binding.state == .bound { return }
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
    }

    private func startAnother() {
        relay.clearCapySpawn()
        operation = nil
        result = nil
        task = ""
        capyModel = ""
        pullRequestAuthor = ""
        error = nil
    }
}
