import Foundation

/// What a status reads like once a change the person just made is saved:
/// shown while the core answers, and replaced by the core's own answer. The
/// Linux app's `models::optimistic` matches these.
public extension IncomingStatus {
    /// `mode` nil stops sharing the thread.
    func sharing(_ threadID: String, mode: Mode?, allowsUnrestricted: Bool) -> IncomingStatus {
        IncomingStatus(canApprove: canApprove, error: error, held: held, state: state, threads: threads.map { thread in
            guard thread.id == threadID else { return thread }
            return IncomingThread(allowsUnrestricted: mode == nil ? false : allowsUnrestricted, id: thread.id, mode: mode,
                                  open: thread.open, project: thread.project, shared: mode != nil, title: thread.title)
        })
    }

    /// Without the held message `id`: approved or declined.
    func withoutHeld(_ id: String) -> IncomingStatus {
        IncomingStatus(canApprove: canApprove, error: error, held: held.filter { $0.id != id }, state: state, threads: threads)
    }
}

public extension ClaudeDeliveryStatus {
    func restricting(_ restricted: Bool) -> ClaudeDeliveryStatus {
        ClaudeDeliveryStatus(allowedSenders: allowedSenders, held: held, restricted: restricted, sessions: sessions)
    }

    func withSession(_ id: String, direct: Bool) -> ClaudeDeliveryStatus {
        ClaudeDeliveryStatus(allowedSenders: allowedSenders, held: held, restricted: restricted, sessions: sessions.map { session in
            session.id == id
                ? ClaudeDeliverySession(agent: session.agent, direct: direct, id: session.id, title: session.title)
                : session
        })
    }

    func withoutSender(_ address: String) -> ClaudeDeliveryStatus {
        ClaudeDeliveryStatus(allowedSenders: allowedSenders.filter { $0.address != address }, held: held,
                             restricted: restricted, sessions: sessions)
    }

    /// With `sender` allowed, once; a sender already allowed is kept as is.
    func allowing(_ sender: ClaudeSender) -> ClaudeDeliveryStatus {
        guard !allowedSenders.contains(where: { $0.address == sender.address }) else { return self }
        return ClaudeDeliveryStatus(allowedSenders: allowedSenders + [sender], held: held, restricted: restricted, sessions: sessions)
    }

    /// Without the held message `id`: approved or dismissed.
    func withoutHeld(_ id: String) -> ClaudeDeliveryStatus {
        ClaudeDeliveryStatus(allowedSenders: allowedSenders, held: held.filter { $0.id != id }, restricted: restricted, sessions: sessions)
    }
}

public extension ContractorStatus {
    /// Without the seat of `userID`: dismissed.
    func withoutSeat(_ userID: String) -> ContractorStatus {
        ContractorStatus(availability: availability, enabled: enabled, failure: failure, grant: grant, grants: grants,
                         pendingSeats: pendingSeats.filter { $0.userId != userID }, provisioning: provisioning, role: role,
                         services: services)
    }

    /// Without the grant `id`: revoked.
    func withoutGrant(_ id: String) -> ContractorStatus {
        ContractorStatus(availability: availability, enabled: enabled, failure: failure, grant: grant,
                         grants: grants.filter { $0.id != id }, pendingSeats: pendingSeats, provisioning: provisioning,
                         role: role, services: services)
    }
}

public extension LocalAgent {
    /// This agent shown under `alias`: what a rename shows before the core
    /// confirms it, and what reverting it restores.
    func withAlias(_ alias: String?) -> LocalAgent {
        LocalAgent(addedBySession: addedBySession, address: address, alias: alias, deliveryError: deliveryError,
                   inboxStall: inboxStall, integrations: integrations, name: name, push: push, registeredAt: registeredAt,
                   replyWithFinalAnswer: replyWithFinalAnswer, spawn: spawn, target: target, title: title, webhook: webhook)
    }
}

public extension SessionRegistration {
    func withAlias(_ alias: String?) -> SessionRegistration {
        SessionRegistration(addedBySession: addedBySession, address: address, alias: alias, name: name, push: push, spawn: spawn)
    }

    /// The registration a session shows from the moment it is put on the
    /// relay under `name`, until the core lists the real one: it has no
    /// address yet.
    static func provisional(name: String) -> SessionRegistration {
        SessionRegistration(addedBySession: false, address: "", name: name)
    }

    var isProvisional: Bool { address.isEmpty }
}

public extension LocalSession {
    func withRegistration(_ registration: SessionRegistration?) -> LocalSession {
        LocalSession(directory: directory, holder: holder, host: host, live: live, project: project, registration: registration,
                     running: running, suggestedName: suggestedName, target: target, title: title, updatedAtMs: updatedAtMs)
    }
}

/// A message the composer sent that the conversation does not list yet.
public enum PendingMessages {
    /// The caption under a message still on its way.
    public static let sending = "Sending…"
    public static let idPrefix = "pending:"

    /// The echo a conversation shows for `text` until the history lists it.
    public static func echo(_ text: String, id: String = UUID().uuidString) -> DirectMessage {
        DirectMessage(id: idPrefix + id, mine: true, sender: "", text: text)
    }

    public static func isPending(_ message: DirectMessage) -> Bool { message.id.hasPrefix(idPrefix) }
}
