import Foundation

/// Reads Relaycast's message readers. The broker marks a message read when it
/// puts it into the agent's session, so any reader other than the sender
/// means the message was delivered.
enum MessageDelivery {
    static func delivered(readers: [[String: Any]], sender: String) -> Bool {
        readers.contains { reader in
            let name = (reader["agent_name"] as? String) ?? (reader["agentName"] as? String) ?? ""
            return !name.isEmpty && name != sender
        }
    }
}
