import Foundation

/// One name per session. A rename replaces it: only the new name is shown and
/// replies come from it, while the earlier name only forwards messages
/// already sent to it.
public enum AgentNameText {
    /// The name an agent is shown by: the name it was renamed to, else the
    /// name it was registered with.
    public static func displayName(name: String, alias: String?) -> String { alias ?? name }

    /// What a renamed agent's name means, on hover. `nil` for one never renamed.
    public static func aliasDetail(name: String, alias: String?) -> String? {
        alias.map { "Renamed from @\(name). Only @\($0) is shown and replies come from it; messages still sent to @\(name) arrive here." }
    }

    /// The note beneath an agent's rename field.
    public static func renameNote(name: String, alias: String?) -> String {
        if let alias {
            return "Renamed from @\(name), which only forwards messages sent to it. Renaming again replaces @\(alias), which keeps forwarding for 24 hours."
        }
        return "Renaming replaces this name: only the new one is shown, and replies come from it. Messages already sent to @\(name) still arrive."
    }

    /// What a rename did, from the agent's name, the alias it had and the name asked for.
    public static func renamed(name: String, previousAlias: String?, requested: String) -> String {
        let now = requested == name ? "Back to" : "Now"
        guard let previousAlias else {
            return requested == name ? "Back to @\(name)." : "Now @\(requested). Messages already sent to @\(name) still arrive."
        }
        return "\(now) @\(requested). Messages sent to @\(previousAlias) still arrive for 24 hours."
    }
}

public extension LocalAgent {
    var displayName: String { AgentNameText.displayName(name: name, alias: alias) }
}

public extension SessionRegistration {
    var displayName: String { AgentNameText.displayName(name: name, alias: alias) }
}

public extension LocalSessionRow {
    /// The name this session is messaged by on the relay: its alias once
    /// renamed. `nil` while it is off the relay.
    var agentName: String? { relay?.registration?.displayName }

    /// The hover text for the agent name.
    var agentDetail: String? {
        guard let registration = relay?.registration else { return nil }
        return AgentNameText.aliasDetail(name: registration.name, alias: registration.alias)
            ?? "Messages to @\(registration.name) reach this session."
    }

    /// Every name that reaches this session, and its address, for search.
    var agentNames: String {
        guard let registration = relay?.registration else { return "" }
        return [registration.name, registration.alias, registration.address].compactMap { $0 }.joined(separator: " ")
    }
}
