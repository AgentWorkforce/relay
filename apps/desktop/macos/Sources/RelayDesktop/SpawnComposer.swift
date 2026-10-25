import SwiftUI
import RelayDesktopCore

/// The message box under a spawned agent's live transcript: it sends into the
/// running agent through the relay, as any message to it is delivered, and
/// starts no process of its own. The Linux app's `ui::spawn_join` matches it.
struct SpawnComposer: View {
    @ObservedObject var relay: RelayModel
    let name: String
    let address: String
    @State private var text = ""
    @State private var error: String?
    @State private var sending = false

    private var canSend: Bool { !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(SpawnHandover.composerPlaceholder(name), text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(1...6)
                    .accessibilityLabel(SpawnHandover.composerPlaceholder(name))
                    .onSubmit(send)
                Button(sending ? "Sending…" : SpawnHandover.send, action: send)
                    .buttonStyle(AgentRelayPrimaryButtonStyle())
                    .disabled(!canSend)
            }
            status
        }
        .frame(maxWidth: 760, alignment: .leading)
        .padding(.horizontal, 32).padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .onAppear { relay.openComposer(address) }
        .onDisappear { relay.closeComposer() }
        .onChange(of: text) { if !$0.isEmpty { relay.forgetLastSend() } }
    }

    @ViewBuilder private var status: some View {
        if let error {
            Text(error).font(.caption).foregroundStyle(.red)
        } else if let note = relay.deliveryNote(at: address) {
            Text(note.text).font(.caption).foregroundStyle(CloudTheme.secondary)
        } else {
            Text(SpawnHandover.composerNote).font(.caption).foregroundStyle(CloudTheme.secondary)
        }
    }

    /// The box clears at once; a failed send puts the text back unless
    /// something else was typed meanwhile.
    private func send() {
        guard canSend else { return }
        sending = true
        error = nil
        let body = text
        text = ""
        Task {
            error = await relay.sendMessage(to: address, text: body)
            if error != nil && text.isEmpty { text = body }
            sending = false
        }
    }
}
