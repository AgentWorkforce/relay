import Foundation
import RelayDesktopCore

/// The menu panel's team access: the core (`contractors.*`) keeps the
/// grants, seats and this person's own grant; this keeps the onboarding
/// flow being filled in.
@MainActor
final class ContractorsModel: ObservableObject {
    struct Flow: Equatable {
        enum Step: Equatable {
            case describe
            case proposing
            case review(rationale: String?, scopes: [Scope])
            case approving
            case done(AccessGrant)
            case failed(String)
        }

        static let minimumDescriptionLength = 8

        let seat: PendingSeat
        var description = ""
        var step: Step = .describe

        var canPropose: Bool {
            step == .describe && description.trimmingCharacters(in: .whitespacesAndNewlines).count >= Self.minimumDescriptionLength
        }

        var canApprove: Bool {
            guard case .review(_, let scopes) = step else { return false }
            return scopes.contains { $0.access != .none }
        }
    }

    @Published private(set) var status: ContractorStatus?
    @Published private(set) var flow: Flow?
    @Published private(set) var revoking: Set<String> = []
    @Published private(set) var error: String?

    private let client: CoreClient
    /// Renewed by `reset`: an answer to a request made before it is dropped.
    private var generation = UUID()
    private var dismissing: Set<String> = []
    private var revokeWritesInFlight: Set<String> = []

    init(client: CoreClient) {
        self.client = client
    }

    /// A failed first load stays visible, so the reason is shown.
    var isVisible: Bool { status?.isVisible == true || error != nil }
    var isOwner: Bool { status?.isOwner == true }
    var pendingSeats: [PendingSeat] { status?.pendingSeats ?? [] }
    var grants: [AccessGrant] { status?.grants ?? [] }
    var serviceNames: [String: String] { status?.serviceNames ?? [:] }
    var isBusy: Bool { flow?.step == .proposing || flow?.step == .approving }

    /// Sign-out or another account: nothing of the previous one stays,
    /// least of all an onboarding flow for its seats.
    func reset() {
        generation = UUID()
        status = nil
        flow = nil
        revoking = []
        dismissing = []
        revokeWritesInFlight = []
        error = nil
    }

    func connectionInterrupted() {
        generation = UUID()
        let interruptedChange = !revokeWritesInFlight.isEmpty || !dismissing.isEmpty
        revoking = []
        dismissing = []
        revokeWritesInFlight = []
        if isBusy {
            flow?.step = .failed(CoreError.interrupted.message)
        }
        error = interruptedChange ? CoreError.interrupted.message : nil
    }

    func service(named id: String) -> Service? { status?.services.first { $0.id == id } }

    /// The cached status, without asking Cloud.
    func load() async {
        let current = generation
        do {
            let loaded = try await client.contractorsStatus()
            guard current == generation else { return }
            status = loaded
            if error != CoreError.interrupted.message { error = loaded.failure?.message }
        } catch {
            if current == generation && self.error != CoreError.interrupted.message { self.error = error.localizedDescription }
        }
    }

    func refresh() async {
        let current = generation
        do {
            let loaded = try await client.contractorsRefresh()
            guard current == generation else { return }
            status = loaded
            if error != CoreError.interrupted.message { error = loaded.failure?.message }
        } catch {
            if current == generation && self.error != CoreError.interrupted.message { self.error = error.localizedDescription }
        }
    }

    func startOnboarding(_ seat: PendingSeat) { flow = Flow(seat: seat) }

    func cancelOnboarding() {
        guard !isBusy else { return }
        flow = nil
    }

    func setDescription(_ text: String) {
        guard flow?.step == .describe else { return }
        flow?.description = String(text.prefix(2_000))
    }

    func setAccess(_ access: Access, for service: String) {
        guard case .review(let rationale, var scopes) = flow?.step,
              let index = scopes.firstIndex(where: { $0.service == service }) else { return }
        scopes[index] = Scope(access: access, service: service)
        flow?.step = .review(rationale: rationale, scopes: scopes)
    }

    func retry() { flow?.step = .describe }

    func propose() async {
        guard let current = flow, current.canPropose else { return }
        let started = generation
        flow?.step = .proposing
        do {
            let proposal = try await client.contractorsPropose(
                ProposeParams(description: current.description, userId: current.seat.userId)
            )
            guard started == generation, flow?.seat == current.seat else { return }
            flow?.step = .review(rationale: proposal.rationale, scopes: proposal.scopes)
        } catch {
            guard started == generation, flow?.seat == current.seat else { return }
            flow?.step = .failed(error.localizedDescription)
        }
    }

    func approve() async {
        guard let current = flow, current.canApprove, case .review(_, let scopes) = current.step else { return }
        let started = generation
        flow?.step = .approving
        do {
            let result = try await client.contractorsApprove(
                ApproveParams(description: current.description, scopes: scopes, userId: current.seat.userId)
            )
            guard started == generation, flow?.seat == current.seat else { return }
            flow?.step = .done(result.grant)
            await refresh()
        } catch {
            guard started == generation, flow?.seat == current.seat else { return }
            flow?.step = .failed(error.localizedDescription)
        }
    }

    /// The seat's row goes at once; the core's answer is the roster's word,
    /// and a failure brings the row back with the reason.
    func dismiss(_ seat: PendingSeat) {
        let current = generation
        guard dismissing.insert(seat.userId).inserted else { return }
        error = nil
        let before = status
        status = status?.withoutSeat(seat.userId)
        Task {
            defer { if current == generation { dismissing.remove(seat.userId) } }
            do {
                let updated = try await client.contractorsDismiss(DismissParams(userId: seat.userId))
                if current == generation { status = updated }
            } catch {
                guard current == generation else { return }
                self.error = error.localizedDescription
                restoreSeat(seat, from: before)
            }
        }
    }

    /// Puts only the seat whose dismissal failed back, where it was, unless
    /// a newer status no longer lists it; other rows stay as they are.
    private func restoreSeat(_ seat: PendingSeat, from before: ContractorStatus?) {
        guard let before, let index = before.pendingSeats.firstIndex(of: seat), let current = status,
              !current.pendingSeats.contains(seat) else { return }
        var seats = current.pendingSeats
        seats.insert(seat, at: min(index, seats.count))
        status = ContractorStatus(availability: current.availability, enabled: current.enabled, failure: current.failure,
                                  grant: current.grant, grants: current.grants, pendingSeats: seats,
                                  provisioning: current.provisioning, role: current.role, services: current.services)
    }

    /// Puts only the grant whose revocation failed back, where it was.
    private func restoreGrant(_ grant: AccessGrant, from before: ContractorStatus?) {
        guard let before, let index = before.grants.firstIndex(of: grant), let current = status,
              !current.grants.contains(grant) else { return }
        var grants = current.grants
        grants.insert(grant, at: min(index, grants.count))
        status = ContractorStatus(availability: current.availability, enabled: current.enabled, failure: current.failure,
                                  grant: current.grant, grants: grants, pendingSeats: current.pendingSeats,
                                  provisioning: current.provisioning, role: current.role, services: current.services)
    }

    /// The grant's row goes at once; a failure brings it back with the reason.
    func revoke(_ grant: AccessGrant) async {
        guard !revoking.contains(grant.id) else { return }
        let current = generation
        revoking.insert(grant.id)
        revokeWritesInFlight.insert(grant.id)
        error = nil
        let before = status
        status = status?.withoutGrant(grant.id)
        defer { if current == generation { revoking.remove(grant.id); revokeWritesInFlight.remove(grant.id) } }
        do {
            try await client.contractorsRevoke(RevokeParams(grantId: grant.id))
            guard current == generation else { return }
            revokeWritesInFlight.remove(grant.id)
            await refresh()
        } catch {
            guard current == generation else { return }
            self.error = error.localizedDescription
            restoreGrant(grant, from: before)
        }
    }
}
