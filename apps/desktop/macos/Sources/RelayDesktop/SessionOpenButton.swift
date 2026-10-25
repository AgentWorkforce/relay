import SwiftUI
import AppKit
import RelayDesktopCore

struct SessionOpenButton: View {
    let row: LocalSessionRow
    /// The row's session as last read, when newer than the row's.
    var session: LocalSession? = nil
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var applications = SessionApplications.shared
    @AppStorage("sessionOpening.claude") private var claudePreference: SessionOpenPreference = .automatic
    @AppStorage("sessionOpening.codex") private var codexPreference: SessionOpenPreference = .automatic

    private var preference: SessionOpenPreference { row.source == "claude" ? claudePreference : codexPreference }
    @State private var error: String?
    @State private var opening = false

    var body: some View {
        let sessionOpening = SessionOpening(row: row, relay: session)
        if let action = sessionOpening {
            let destination = action.destination(preference: preference, desktopAvailable: applications.desktopAvailable(for: row.source))
            let title = destination == .desktop || action.liveOnly ? action.title : destination == .terminal ? "Open in Terminal" : "Set up session opening"
            Button {
                Task { await open(action) }
            } label: {
                HStack(spacing: 6) {
                    if destination == .desktop || action.liveOnly {
                        AgentIconView(source: row.source, size: 18)
                        Text(title)
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 10, weight: .semibold))
                    } else {
                        Label(title, systemImage: destination == .terminal ? "terminal" : "arrow.up.right")
                    }
                }.frame(maxWidth: .infinity)
            }.buttonStyle(CloudControlStyle(height: 38, horizontalPadding: 12)).disabled(opening)
                .help(title).accessibilityLabel(title)
            .onAppear { applications.refresh() }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in applications.refresh() }
            .alert("Couldn’t open session", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                if action.command != nil {
                    Button("Open in Terminal") { Task { await open(action, inTerminal: true) } }
                }
                Button("Opening settings") { model.page = .settings(.opening) }
                Button("Cancel", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
        }
        if let note = SpawnHandover.hostedNote(session ?? row.relay, opening: sessionOpening)
            ?? SessionOpening.heldNote(session) {
            Text(note).font(.caption).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor private func open(_ action: SessionOpening, inTerminal: Bool = false) async {
        opening = true
        defer { opening = false }
        error = nil
        applications.refresh()
        let destination = action.destination(preference: inTerminal ? .terminal : preference,
                                             desktopAvailable: applications.desktopAvailable(for: row.source))
        if destination == .unavailable && action.liveOnly {
            error = SpawnHandover.codexMissing
            return
        }
        if destination == .unavailable {
            model.page = .settings(.opening)
            return
        }
        error = await Self.run(action, destination: destination)
    }

    /// Opens `action` where `destination` says; why it failed, if it did.
    @MainActor static func run(_ action: SessionOpening, destination: SessionOpenDestination) async -> String? {
        if destination == .desktop {
            if let command = action.desktopCommand {
                return await launchDesktop(command)
            }
            if let url = action.deepLink, NSWorkspace.shared.open(url) { return nil }
        }
        guard let command = action.command else {
            return "Install Codex to open this session. Its working directory is unavailable for terminal resume."
        }
        guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else {
            return "Terminal is unavailable. Check your session-opening preferences in Settings."
        }
        // A private, self-removing command file avoids Apple Events permission
        // and never interpolates transcript metadata into AppleScript.
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("relay-resume-\(UUID().uuidString).command")
        do {
            let script = "#!/bin/sh\n/bin/rm -- \"$0\"\nexec /bin/zsh -lic \(SessionOpening.quote(command))\n"
            try Data(script.utf8).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            try await NSWorkspace.shared.open([file], withApplicationAt: terminal, configuration: config)
            return nil
        } catch {
            try? FileManager.default.removeItem(at: file)
            return "\(error.localizedDescription) Check your session-opening preferences in Settings."
        }
    }

    /// The CLI opens Desktop and exits; no terminal window or prompt is created.
    static func launchDesktop(_ command: String) async -> String? {
        await SessionDesktopLauncher.launch(command)
    }
}
