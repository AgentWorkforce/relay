import SwiftUI
import AppKit
import RelayDesktopCore

/// Takes a spawned Claude over: the core stops it headless (after its turn,
/// or, while it waits for one, interrupting it once the person confirms),
/// then its session opens in Claude Desktop or Terminal in its folder. It
/// keeps its name, so relay messages keep arriving. The Linux app's
/// `ui::spawn_take_over` matches it.
struct SpawnTakeOverButton: View {
    let row: LocalSessionRow
    let session: LocalSession
    @ObservedObject var relay: RelayModel
    @ObservedObject private var applications = SessionApplications.shared
    @AppStorage("sessionOpening.claude") private var preference: SessionOpenPreference = .automatic
    @State private var confirming = false
    @State private var confirmingInterrupt = false
    @State private var working = false
    @State private var busy = false
    @State private var waiting = false

    private var name: String { session.registration?.name ?? "" }
    private var desktop: Bool {
        preference == .automatic && applications.desktopAvailable(for: "claude")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                working = SpawnHandover.isWorking(relay.agent(for: session))
                confirming = true
            } label: {
                HStack(spacing: 6) {
                    if busy { ProgressView().controlSize(.small) } else { AgentIconView(source: "claude", size: 18) }
                    Text(SpawnHandover.takeOverTitle(desktop: desktop))
                }.frame(maxWidth: .infinity)
            }
            .buttonStyle(CloudControlStyle(height: 38, horizontalPadding: 12)).disabled(busy || name.isEmpty)
            .help(SpawnHandover.takeOverHelp).accessibilityLabel(SpawnHandover.takeOverTitle(desktop: desktop))
            if waiting {
                Text(SpawnHandover.waiting(name)).font(.caption).foregroundStyle(CloudTheme.secondary)
                Button(SpawnHandover.interruptNow) { confirmingInterrupt = true }.controlSize(.small)
            } else if busy {
                Text(SpawnHandover.stopping).font(.caption).foregroundStyle(CloudTheme.secondary)
            }
        }
        .onAppear { applications.refresh() }
        .confirmationDialog(SpawnHandover.confirmTitle(name), isPresented: $confirming) {
            Button(working ? SpawnHandover.afterTurn : SpawnHandover.takeOverButton) { start() }
            Button(SpawnHandover.cancel, role: .cancel) {}
        } message: {
            Text(working ? SpawnHandover.workingMessage(name) : SpawnHandover.confirmMessage(name, desktop: desktop))
        }
        // While it waits for the turn: stop it now, once confirmed.
        .confirmationDialog(SpawnHandover.interruptTitle(name), isPresented: $confirmingInterrupt) {
            Button(SpawnHandover.interrupt, role: .destructive) {
                Task { _ = try? await relay.takeOver(name, interrupt: true) }
            }
            Button(SpawnHandover.cancel, role: .cancel) {}
        } message: {
            Text(SpawnHandover.interruptMessage)
        }
    }

    /// Its outcome outlives this button, which the session taken over
    /// replaces: a failure is shown in the sidebar (`takeOverErrors`).
    private func start() {
        busy = true
        waiting = working
        let id = session.id
        relay.takeOverErrors[id] = nil
        Task { @MainActor in
            defer { busy = false; waiting = false }
            do {
                let taken = try await relay.takeOver(name, interrupt: false)
                relay.takeOverErrors[id] = await open(taken)
            } catch {
                relay.takeOverErrors[id] = error.localizedDescription
            }
        }
    }

    /// Resumes the session where the person prefers, in its folder.
    @MainActor private func open(_ taken: TakenOver) async -> String? {
        applications.refresh()
        let directory = taken.directory ?? row.directory
        guard let action = SessionOpening(source: "claude", id: taken.target.id, directory: directory) else {
            return SpawnHandover.noFolder(taken.target.id)
        }
        let destination = action.destination(preference: preference, desktopAvailable: applications.desktopAvailable(for: "claude"))
        if destination == .unavailable { return SpawnHandover.noFolder(taken.target.id) }
        return await SessionOpenButton.run(action, destination: destination)
    }
}
