#if DEBUG
import Foundation

/// A closed, offline UI fixture. Only POST /dm advances it; reads never do.
enum MobileHandoffFixture {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var sent: String?
    }
    private static let state = State()
    private static let person = "ui-test-person"
    private static var scenario: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-RelayUITestMobileHandoff"), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    static func trace(_ stage: String) {
        guard scenario != nil else { return }
        NSLog("Mobile handoff send: %@", stage)
    }

    static func response(_ path: String, method: String, body: JSONObject?) -> Any? {
        guard let scenario else { return nil }
        NSLog("Mobile handoff fixture: %@ %@", method, path)
        state.lock.lock()
        defer { state.lock.unlock() }
        if path == "/dm", method == "POST", body?["to"] as? String == "reviewer" {
            state.sent = body?["text"] as? String
            return ["id": "handoff-send", "conversation_id": "dm_reviewer"]
        }
        var metadata: JSONObject = ["source": "relay-desktop", "mobile_handoff_enabled": true, "host": "Finn Mini.local",
                                    "session_kind": "claude-terminal", "session_id": "same-claude-session",
                                    "session_title": "Continue the same task"]
        if state.sent != nil, scenario != "queued" {
            metadata["mobile_handoff_state"] = scenario
            if scenario == "failed" {
                metadata["mobile_handoff_error"] = "Claude's mobile connection could not be confirmed. Check the message status before sending again."
            }
        }
        let agent: JSONObject = ["name": "reviewer", "status": "active", "address": "reviewer@finn-mini-123",
                                 "last_seen": Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(Date()),
                                 "metadata": metadata]
        if path == "/agents" || path.hasPrefix("/agents?status=") { return [agent] }
        if path == "/agents/reviewer" { return agent }
        let original: JSONObject = ["id": "handoff-original", "agent_name": "reviewer",
                                    "agent_id": "a_reviewer", "text": "Reading this conversation sends no message.",
                                    "created_at": "2026-10-24T12:00:00.000Z"]
        let sent: JSONObject? = state.sent.map {
            ["id": "handoff-send", "agent_name": person, "agent_id": "a_me", "text": $0,
             "created_at": "2026-10-24T12:01:00.000Z"]
        }
        let last = sent ?? original
        if path == "/dm/conversations" {
            return [["id": "dm_reviewer",
                     "participants": [["agent_name": person, "agent_id": "a_me"],
                                      ["agent_name": "reviewer", "agent_id": "a_reviewer"]],
                     "last_message": last] as JSONObject]
        }
        if path.hasPrefix("/dm/dm_reviewer/messages") {
            // Relaycast appends a send and returns newest first. Keep the old
            // message so the UI observes the same history growth as production.
            return sent.map { [$0, original] } ?? [original]
        }
        // Even a ready handoff is not a message receipt.
        if path.hasSuffix("/readers") { return [JSONObject]() }
        return nil
    }
}
#endif
