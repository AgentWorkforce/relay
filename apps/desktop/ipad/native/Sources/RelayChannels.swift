import Foundation

/// Workspace channels are group chats shared by people and agents. The
/// Channels page lists the ones this person has joined first, then the rest.
enum RelayChannels {
    static func list(_ channels: [JSONObject], joined: Set<String>) -> [RelayAgent] {
        var seen: Set<String> = []
        let rows = channels.compactMap { data -> RelayAgent? in
            let name = (data["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, data["is_archived"] as? Bool != true,
                  seen.insert(name).inserted else { return nil }
            return RelayAgent(channel: data, joined: joined.contains(name))
        }
        return rows.filter(\.isJoined).sorted(by: byName) + rows.filter { !$0.isJoined }.sorted(by: byName)
    }

    /// Channel names from a person's own `GET /agents/:name` record.
    static func joinedNames(_ agent: JSONObject) -> Set<String> {
        Set((agent["channels"] as? [JSONObject] ?? []).compactMap { $0["name"] as? String }.filter { !$0.isEmpty })
    }

    /// The roster entry for a message's sender, so the message shows their
    /// photo or agent artwork. A sender who has left gets initials or a
    /// terminal icon from a bare entry.
    static func sender(named name: String, in roster: [RelayAgent]) -> RelayAgent {
        roster.first { $0.name == name && $0.isHuman } ?? roster.first { $0.name == name }
            ?? RelayAgent(relay: ["name": name])
    }

    static func pathComponent(_ name: String) -> String {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))
        return name.addingPercentEncoding(withAllowedCharacters: allowed) ?? name
    }

    private static func byName(_ first: RelayAgent, _ second: RelayAgent) -> Bool {
        (first.name.lowercased(), first.name) < (second.name.lowercased(), second.name)
    }
}
