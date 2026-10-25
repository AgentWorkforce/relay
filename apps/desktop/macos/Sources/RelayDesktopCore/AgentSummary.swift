import Foundation

/// Short text for a roster row. A declared objective is useful, but many fleet
/// registrations store the entire launch instruction in `description`.
public enum AgentSummary {
    public static func line(summary: String? = nil, latestOutgoing: String? = nil,
                            description: String, status: String, lastSeenMs: Int64?, now: Date = Date()) -> String {
        if status == "idle" {
            return lastSeenMs.map {
                let seen = Date(timeIntervalSince1970: Double($0) / 1_000)
                let date: Date.FormatStyle.DateStyle = Calendar.current.isDate(seen, inSameDayAs: now)
                    ? .omitted : .abbreviated
                return "Idle since \(seen.formatted(date: date, time: .shortened))"
            } ?? "Idle"
        }
        for candidate in [summary, latestOutgoing] {
            if let candidate, let cleaned = useful(candidate) { return cleaned }
        }
        if let cleaned = useful(description) { return cleaned }
        return "Active · task details unavailable"
    }

    public static func useful(_ raw: String) -> String? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        // Spawn instructions often contain a human-written Summary after the
        // boilerplate. Keep that sentence, never the path to a private brief.
        if let range = value.range(of: "Summary:", options: .caseInsensitive) {
            value = String(value[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if value.range(of: #"^You are\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return nil
        }
        value = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        if let range = value.range(of: #"(?<=[.!?])\s+(?=[A-Z])"#, options: .regularExpression) {
            value = String(value[..<range.lowerBound])
        }
        return value.isEmpty ? nil : value
    }

    /// Only references already published in the roster description. This is
    /// not a search of the agent's private conversations or transcript.
    public static func mentions(_ raw: String) -> [String] {
        let pattern = #"https?://[^\s<>()]+|(?:[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[0-9]+"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        var seen = Set<String>()
        return regex.matches(in: raw, range: range).compactMap { match in
            guard let span = Range(match.range, in: raw) else { return nil }
            let value = String(raw[span]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;!?)"))
            return seen.insert(value).inserted ? value : nil
        }.prefix(5).map { $0 }
    }
}
