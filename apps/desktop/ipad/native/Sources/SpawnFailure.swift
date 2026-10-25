import Foundation

/// How a start request ended when it did not fail.
enum SpawnOutcome: Equatable {
    /// The node's receipt confirmed the agent is ready.
    case ready
    /// No receipt, but the node lists the agent as live.
    case running
    /// The node accepted the request and nothing has confirmed it since.
    case unconfirmed
}

/// Turns the node's or Relay's raw start error into a sentence a person can
/// act on, keeping the raw detail for support.
enum SpawnFailure {
    static func message(_ detail: String, node: String, name: String, harness: String) -> String {
        let detail = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = detail.lowercased()
        let summary: String
        if lower.contains("d1_pressure") || lower.contains("liveness retry pending") {
            summary = "Agent Relay is busy and could not register \(name). Wait a minute, then try again."
        } else if lower.contains("spawn_readiness_timeout") || lower.contains("readiness timeout") {
            summary = "\(name) did not become ready on \(node) in time. Check Agents before trying again."
        } else if lower.contains("preflight") {
            summary = "\(node) could not set up Agent Relay tools for \(name), so it did not start the agent."
        } else if harness == "codex" && lower.contains("codex") && lower.contains("lock") {
            summary = "Codex on \(node) is in use by another session. Try again later or choose another agent type."
        } else if lower.contains("operation not permitted") || lower.contains("permission denied")
                    || lower.contains("eperm") || lower.contains("eacces") {
            summary = "\(node) cannot open that project folder. Folders on an external drive may not be readable by background apps; choose a folder on the internal disk."
        } else if lower.contains("enoent") || lower.contains("no such file") || lower.contains("not a directory") {
            summary = "That project folder does not exist on \(node). Check the saved path."
        } else if lower.contains("name_in_use") || lower.contains("name_taken")
                    || (lower.contains("already") && (lower.contains("exists") || lower.contains("taken") || lower.contains("in use"))) {
            summary = "The name \(name) is already in use, possibly by an earlier start that is still being cleaned up. Choose another name."
        } else {
            summary = "\(node) did not start \(name)."
        }
        return detail.isEmpty ? summary : "\(summary)\nDetails: \(detail)"
    }
}

/// Checks a project folder typed for a node. The node receives the path as
/// is, so it must be absolute there; `~` is not expanded.
enum SpawnProjectPath {
    static func problem(_ path: String, node: String) -> String? {
        let path = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }
        if path.hasPrefix("~") { return "Enter the full path on \(node), such as /Users/name/project. ~ is not expanded." }
        if !path.hasPrefix("/") { return "Enter the full path on \(node), starting with /." }
        if path.contains("\n") { return "Enter the path on one line." }
        return nil
    }
}
