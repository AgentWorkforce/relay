import Foundation
import RelayDesktopCore

/// Local consent before Relaycast messages enter Claude Code sessions.
/// `status` is the core's last answer with every change still on its way
/// written over it: a change shows at once, a read never hides one still
/// pending, and a failed change simply stops being shown.
@MainActor
final class ClaudeDeliveryModel: ObservableObject {
    @Published private(set) var status: ClaudeDeliveryStatus?
    @Published private(set) var error: String?

    private let client: CoreClient
    private var generation = 0
    private var changesInFlight = 0
    /// The core's last answer.
    private var confirmed: ClaudeDeliveryStatus? { didSet { status = shown } }
    /// Changes on their way, oldest first, each under its token; a change
    /// the core took records how many reads had started (`takenAtRead`)
    /// and stays until a read started after that succeeds.
    private var pending: [(token: UInt64, takenAtRead: UInt64?, change: (ClaudeDeliveryStatus) -> ClaudeDeliveryStatus)] = [] { didSet { status = shown } }
    private var changeToken: UInt64 = 0
    /// Reads are numbered as they start; an older read's answer never
    /// replaces a newer one's status.
    private var readsStarted: UInt64 = 0
    private var appliedRead: UInt64 = 0

    init(client: CoreClient) { self.client = client }

    private var shown: ClaudeDeliveryStatus? {
        guard let confirmed else { return nil }
        return pending.reduce(confirmed) { $1.change($0) }
    }

    func connectionInterrupted() {
        generation += 1
        error = changesInFlight > 0 ? CoreError.interrupted.message : nil
        changesInFlight = 0
        pending = []
    }

    func refresh() async { await refresh(preservingError: false) }

    private func refresh(preservingError: Bool) async {
        let current = generation
        readsStarted += 1
        let read = readsStarted
        do {
            let loaded = try await client.claudeDeliveryStatus()
            guard current == generation, read > appliedRead else { return }
            // The read lists what the core took before it started; a
            // failed read keeps it shown.
            appliedRead = read
            pending.removeAll { $0.takenAtRead.map { $0 < read } ?? false }
            confirmed = loaded
            if !preservingError && error != CoreError.interrupted.message { error = nil }
        }
        catch { if current == generation && !preservingError && self.error != CoreError.interrupted.message { self.error = error.localizedDescription } }
    }

    func restrict(_ restricted: Bool) async {
        await change(showing: { $0.restricting(restricted) }) {
            _ = try await client.claudeDeliveryRestrict(ClaudeRestrictionParams(restricted: restricted))
        }
    }

    func setSession(_ id: String, direct: Bool) async {
        await change(showing: { $0.withSession(id, direct: direct) }) {
            _ = try await client.claudeDeliverySession(ClaudeSessionDeliveryParams(direct: direct, sessionId: id))
        }
    }

    func setSender(_ sender: ClaudeSender, allowed: Bool) async {
        await setSender(address: sender.address, name: sender.name, allowed: allowed)
    }

    func setSender(address: String, name: String, allowed: Bool) async {
        let sender = ClaudeSender(address: address, name: name)
        await change(showing: { allowed ? $0.allowing(sender) : $0.withoutSender(address) }) {
            _ = try await client.claudeDeliverySender(ClaudeSenderDeliveryParams(allowed: allowed, name: name, sender: address))
        }
    }

    func approve(_ id: String) async {
        await change(showing: { $0.withoutHeld(id) }) {
            _ = try await client.claudeDeliveryApprove(ClaudeHeldParams(id: id))
        }
    }

    func dismiss(_ id: String) async {
        await change(showing: { $0.withoutHeld(id) }) {
            _ = try await client.claudeDeliveryDismiss(ClaudeHeldParams(id: id))
        }
    }

    func alwaysAllow(_ message: ClaudeHeldDelivery) async {
        let sender = ClaudeSender(address: message.sender, name: message.senderName)
        await change(showing: { $0.allowing(sender).withoutHeld(message.id) }) {
            _ = try await client.claudeDeliverySender(ClaudeSenderDeliveryParams(allowed: true, name: message.senderName, sender: message.sender))
            _ = try await client.claudeDeliveryApprove(ClaudeHeldParams(id: message.id))
        }
    }

    private func change(showing: @escaping (ClaudeDeliveryStatus) -> ClaudeDeliveryStatus, _ body: () async throws -> Void) async {
        let current = generation
        changeToken &+= 1
        let token = changeToken
        pending.append((token, nil, showing))
        changesInFlight += 1
        error = nil
        var failed = false
        do {
            try await body()
            guard current == generation else { return }
            error = nil
            // One the core took shows until a read succeeds after it.
            if let index = pending.firstIndex(where: { $0.token == token }) { pending[index].takenAtRead = readsStarted }
        } catch {
            guard current == generation else { return }
            failed = true
            self.error = error.localizedDescription
            // A refused change stops showing at once.
            pending.removeAll { $0.token == token }
        }
        guard current == generation else { return }
        changesInFlight -= 1
        // A reconciliation read must not erase the action failure it follows.
        // A later explicit refresh still clears a recovered error.
        await refresh(preservingError: failed)
    }
}
