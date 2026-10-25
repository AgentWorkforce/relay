import Foundation

/// Wording for spawned agents: Agent Relay starting agents on this computer,
/// headless, through the core's spawn node. On unless turned off, and each
/// harness runs with full access unless turned off. Nothing here is
/// tied to particular harnesses: the core describes each one it knows
/// (`SpawnStatus.harnessDescriptors`: its label, what full access means for
/// it and its default) and reports which ones it offers. The Linux app's
/// `SPAWN_*` constants and `spawn_*` functions match these word for word.
public enum SpawnCopy {
    public static let title = "Spawned agents"
    public static let description = "Agent Relay can start agents on this computer, headless, with the agent command lines installed here. You message them like any other agent here."
    public static let acceptTitle = "Accept spawns from Agent Relay"
    public static let acceptDetail = "Let your workspace start agents here. They run in the background as you, in the folder the spawn names, and stop when they are released."

    public static let teammatesTitle = "Allow teammates to spawn here"
    public static let teammatesDetail = "Off: only you can start agents on this computer. On: workspace owners and admins can too."

    public static let maxAgentsTitle = "Max spawned agents"
    public static let maxAgentsDetail = "Leave empty for no limit. An optional cap limits how many spawned agents may run here at once. An idle agent keeps its place until it is released; a spawn beyond the cap is refused, never queued."
    /// The range the field accepts when filled in; the empty default (0)
    /// means no limit.
    public static let maxAgentsRange: ClosedRange<Int> = 1...32
    public static let maxAgentsDefault = 0

    public static let noLimit = "No limit"

    public static func maxAgentsInput(_ text: String) -> Int? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return 0 }
        guard text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(text), maxAgentsRange.contains(value) else { return nil }
        return value
    }

    /// `2 of 8 places in use.`
    public static func places(_ slots: SpawnSlots) -> String {
        slots.max == 0 ? "\(slots.held) places in use. No limit." : "\(slots.held) of \(slots.max) places in use."
    }

    /// A harness by its product name, as the core describes it; an id it
    /// does not describe is capitalized.
    public static func label(_ harness: String, in descriptors: [HarnessDescriptor] = []) -> String {
        if let descriptor = descriptors.first(where: { $0.id == harness }) { return descriptor.label }
        return harness.prefix(1).uppercased() + harness.dropFirst()
    }

    /// `Codex`, `Codex and Claude`, `Codex, Claude and Gemini`.
    public static func list(_ harnesses: [String], in descriptors: [HarnessDescriptor] = []) -> String {
        let labels = harnesses.map { label($0, in: descriptors) }
        guard let last = labels.last else { return "agents" }
        if labels.count == 1 { return last }
        return labels.dropLast().joined(separator: ", ") + " and " + last
    }

    /// The harnesses with a full-access row: each one the node offers that
    /// has the setting, in the core's order. None from an older core.
    public static func fullAccessHarnesses(_ status: SpawnStatus?) -> [HarnessDescriptor] {
        guard let status else { return [] }
        return (status.harnessDescriptors ?? []).filter {
            $0.fullAccess != nil && status.harnesses.contains($0.id)
        }
    }

    public static func fullAccessTitle(_ harness: HarnessDescriptor) -> String {
        "\(harness.label): full access"
    }

    public static func fullAccessDetail(_ harness: HarnessDescriptor) -> String {
        harness.fullAccess?.detail ?? ""
    }

    /// Whether `harness` runs with full access: the person's choice, else
    /// its default.
    public static func fullAccess(_ settings: SettingsValues?, _ harness: HarnessDescriptor) -> Bool {
        settings?.spawnHarnesses?[harness.id]?.fullAccess ?? harness.fullAccess?.defaultOn ?? false
    }

    /// Turns full access for `harness` on or off.
    public static func fullAccessChange(_ harness: String, _ enabled: Bool) -> SettingsChange {
        SettingsChange(spawnHarnesses: [harness: SpawnHarnessSettings(fullAccess: enabled)])
    }

    /// What the spawn node is doing, or `nil` when there is nothing to say.
    /// A live node that takes no spawns (another account owns it) says why,
    /// and one not claimed yet says that Cloud spawns nothing here until it is.
    public static func statusLine(_ status: SpawnStatus?) -> String? {
        guard let status else { return nil }
        switch status.state {
        case .live:
            if let error = status.error { return error }
            let node = status.nodeName ?? "this computer"
            if let claim = status.claim, claim.state != .claimed {
                return "Connected to Agent Relay as \(node). \(notClaimed)"
            }
            let line = "Agent Relay can spawn \(list(status.harnesses, in: status.harnessDescriptors ?? [])) here as \(node). Spawned agents are addressed name@\(node)."
            guard let slots = status.slots else { return line }
            return line + " " + places(slots)
        case .connecting:
            return "Connecting to Agent Relay…"
        case .waiting:
            if let error = status.error { return "Not connected: \(error) Trying again." }
            return "Not connected. Trying again."
        case .off:
            return status.error
        }
    }

    /// Whether the status line reads as a healthy status, not a warning.
    public static func statusIsHealthy(_ status: SpawnStatus?) -> Bool {
        guard let status, status.state == .live, status.error == nil else { return false }
        return status.claim.map { $0.state == .claimed } ?? true
    }

    /// Until the claim succeeds, Cloud refuses every spawn onto this computer.
    public static let notClaimed = "No agent can be spawned on this computer through Agent Relay Cloud until its spawn node is claimed."
    public static let claimRetry = "Retry"

    /// Whether the claim failed in a way Retry can help with.
    public static func claimCanRetry(_ claim: SpawnClaim?) -> Bool {
        claim?.state == .failed
    }

    /// Whether Agent Relay Cloud records this computer's spawn node as the
    /// person's, shown under "Allow teammates to spawn here"; `nil` while
    /// the core reports no claim.
    public static func claimLine(_ claim: SpawnClaim?) -> String? {
        guard let claim else { return nil }
        switch claim.state {
        case .claimed:
            return "Claimed by you in Agent Relay Cloud."
        case .ownedByOther:
            return "Claimed by another account in Agent Relay Cloud."
        case .pending, .signedOut, .failed:
            let line = "Not claimed yet: no agent can be spawned on this computer through Agent Relay Cloud until it is."
            guard let note = claim.note else { return line }
            return line + " " + note
        }
    }
}
