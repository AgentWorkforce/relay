import Foundation

/// How the app presents a person on the relay, as opposed to an agent.
/// Relaycast marks a person's identity `type: "human"` and carries their
/// display name as `persona`; their handle is the agent name, which is what
/// agents address them by, never the full `name@node` address.
enum PersonIdentity {
    static func isHuman(_ data: JSONObject) -> Bool {
        (data["type"] as? String)?.lowercased() == "human"
    }

    /// Up to two initials from the display name, else from the handle's
    /// dash-separated parts, so "Ada Lovelace" and "ada-lovelace" are both "AL".
    static func initials(displayName: String, handle: String) -> String {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = (name.isEmpty ? handle : name)
            .split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" || $0 == "." })
            .compactMap { $0.first(where: \.isLetter) ?? $0.first }
        let letters = words.count > 1 ? [words[0], words[words.count - 1]] : Array(words.prefix(1))
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }
}
