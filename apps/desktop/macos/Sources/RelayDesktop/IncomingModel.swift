import Foundation
import RelayDesktopCore

/// Incoming messages to Codex threads shared from this Mac (`incoming.*`).
/// `status` is the core's last answer with every change still on its way
/// written over it: a change shows at once, a read never hides one still
/// pending, and a failed change simply stops being shown.
@MainActor
final class IncomingModel: ObservableObject {
    @Published private(set) var status: IncomingStatus?
    @Published private(set) var error: String?

    private let client: CoreClient
    private var generation = UUID()
    private var changesInFlight = 0
    /// The core's last answer.
    private var confirmed: IncomingStatus? { didSet { status = shown } }
    /// Changes on their way, oldest first, each under its token; a change
    /// the core took records how many reads had started (`takenAtRead`)
    /// and stays until a read started after that succeeds.
    private var pending: [(token: UInt64, takenAtRead: UInt64?, change: (IncomingStatus) -> IncomingStatus)] = [] { didSet { status = shown } }
    private var changeToken: UInt64 = 0
    /// Reads are numbered as they start; an older read's answer never
    /// replaces a newer one's status.
    private var readsStarted: UInt64 = 0
    private var appliedRead: UInt64 = 0

    init(client: CoreClient) {
        self.client = client
    }

    private var shown: IncomingStatus? {
        guard let confirmed else { return nil }
        return pending.reduce(confirmed) { $1.change($0) }
    }

    /// Sign-out or another account: the previous one's threads and held
    /// messages go; answers to earlier requests are dropped.
    func reset() {
        generation = UUID()
        changesInFlight = 0
        pending = []
        confirmed = nil
        error = nil
    }

    func connectionInterrupted() {
        generation = UUID()
        error = changesInFlight > 0 ? CoreError.interrupted.message : nil
        changesInFlight = 0
        pending = []
    }

    func refresh() async {
        let current = generation
        readsStarted += 1
        let read = readsStarted
        guard let loaded = try? await client.incomingStatus(), current == generation, read > appliedRead else { return }
        // The read lists what the core took before it started; a failed
        // read keeps it shown.
        appliedRead = read
        pending.removeAll { $0.takenAtRead.map { $0 < read } ?? false }
        confirmed = loaded
    }

    /// `mode` nil stops sharing the thread. The core replaces the thread's
    /// whole share, so the caller passes the unrestricted choice it keeps.
    func share(_ threadID: String, mode: Mode?, allowsUnrestricted: Bool) async {
        await settle(showing: { $0.sharing(threadID, mode: mode, allowsUnrestricted: allowsUnrestricted) }) {
            try await client.incomingShare(ShareParams(allowsUnrestricted: allowsUnrestricted, mode: mode, threadId: threadID))
            return nil
        }
    }

    func approve(_ id: String) async {
        await settle(showing: { $0.withoutHeld(id) }) {
            try await client.incomingApprove(HeldMessageParams(id: id)).approved ? nil
                : "This message can't be approved now: it expired, is gone, or incoming messages are paused."
        }
    }

    func reject(_ id: String) async {
        await settle(showing: { $0.withoutHeld(id) }) {
            try await client.incomingReject(HeldMessageParams(id: id)).rejected ? nil
                : "This message can't be declined now: it expired, is gone, or incoming messages are paused."
        }
    }

    /// Runs one change, showing `showing` over the status meanwhile; its
    /// refusal, or the core's sentence, becomes `error`.
    private func settle(showing: @escaping (IncomingStatus) -> IncomingStatus, _ change: () async throws -> String?) async {
        let current = generation
        changeToken &+= 1
        let token = changeToken
        pending.append((token, nil, showing))
        changesInFlight += 1
        error = nil
        let outcome: String?
        do {
            outcome = try await change()
        } catch {
            outcome = error.localizedDescription
        }
        guard current == generation else { return }
        changesInFlight -= 1
        error = outcome
        // A refused change stops showing at once; one the core took shows
        // until a read succeeds after it.
        if outcome != nil {
            pending.removeAll { $0.token == token }
        } else if let index = pending.firstIndex(where: { $0.token == token }) {
            pending[index].takenAtRead = readsStarted
        }
        await refresh()
    }
}
