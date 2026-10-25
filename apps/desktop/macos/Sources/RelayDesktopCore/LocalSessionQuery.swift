import Foundation

/// A small, local-only search language. Menu choices edit this same query.
public struct LocalSessionQuery {
    public struct Term {
        public let raw: String
        public let field: String?
        public let value: String
        public let excluded: Bool
        public var displayTitle: String {
            guard field == "is", ["on-relay", "off-relay"].contains(value.lowercased()) else { return raw }
            let receives = (value.lowercased() == "on-relay") != excluded
            return receives ? "Receives messages" : "Does not receive messages"
        }
        fileprivate let dates: (Date, Date)?
    }
    public let terms: [Term]
    private static let fields: Set<String> = ["title", "project", "harness", "source", "path", "id", "agent", "is", "upload", "updated", "after", "before"]

    public init(_ query: String) {
        var words: [String] = [], word = "", quoted = false, escaped = false
        for char in query {
            if char.isWhitespace && !quoted {
                if !word.isEmpty { words.append(word); word = "" }
            } else {
                word.append(char)
                if char == "\"" && !escaped { quoted.toggle() }
            }
            escaped = char == "\\" && !escaped
        }
        if !word.isEmpty { words.append(word) }
        var index = 0, terms: [Term] = []
        while index < words.count {
            var raw = words[index]
            // Accept `title: Foo` as well as `title:Foo`.
            if raw.hasSuffix(":"), index + 1 < words.count, (!words[index + 1].contains(":") || words[index + 1].hasPrefix("\"")) {
                index += 1; raw += words[index]
            }
            let excluded = raw.hasPrefix("-") && raw.count > 1
            let body = excluded ? String(raw.dropFirst()) : raw
            let parts = body.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            let field = parts.count == 2 && Self.fields.contains(parts[0].lowercased()) ? parts[0].lowercased() : nil
            var value = field == nil ? body : String(parts[1])
            if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }
            value = value.replacingOccurrences(of: "\\\"", with: "\"")
            terms.append(Term(raw: raw, field: field, value: value, excluded: excluded, dates: ["updated", "after", "before"].contains(field ?? "") ? Self.dateBounds(value, field: field!) : nil))
            index += 1
        }
        self.terms = terms
    }

    public func value(for field: String) -> String? {
        terms.last { $0.field == field && !$0.excluded }?.value
    }

    /// Remove one visible query term without changing other filters or search words.
    public func removingTerm(at index: Int) -> String {
        terms.enumerated().filter { $0.offset != index }.map { $0.element.raw }.joined(separator: " ")
    }

    public func setting(_ field: String, to value: String?) -> String {
        var parts = terms.filter { $0.field != field }.map(\.raw)
        if let value, !value.isEmpty {
            let escaped = value.replacingOccurrences(of: "\"", with: "\\\"")
            parts.append(field + ":" + (value.contains(where: \.isWhitespace) ? "\"\(escaped)\"" : escaped))
        }
        return parts.joined(separator: " ")
    }

    /// Menu edits clear equivalent qualifiers so typed and clicked filters agree.
    public func applyingFilter(_ field: String, to value: String?) -> String {
        let aliases = field == "harness" ? ["source"] : field == "updated" ? ["after", "before"] : []
        var query = self
        for alias in aliases { query = LocalSessionQuery(query.setting(alias, to: nil)) }
        return query.setting(field, to: value)
    }

    private static func selectionField(_ field: String) -> String { field == "source" ? "harness" : field }

    public func containsSelection(_ field: String, value: String) -> Bool {
        terms.contains { !$0.excluded && Self.selectionField($0.field ?? "") == Self.selectionField(field) && $0.value.lowercased() == value.lowercased() }
    }

    private static func opposite(_ field: String, _ left: String, _ right: String) -> Bool {
        guard field == "is" || field == "upload" else { return false }
        let pair = Set([left.lowercased(), right.lowercased()])
        if field == "is" { return pair == ["active", "inactive"] || pair == ["on-relay", "off-relay"] }
        if field == "upload" {
            return pair == ["local", "in-progress"] || (left.lowercased() != right.lowercased() && (pair.contains("none") || pair.contains("discovering")))
        }
        return false
    }

    private func conflictsWithSelection(_ field: String, value: String) -> Bool {
        terms.contains { Self.selectionField($0.field ?? "") == Self.selectionField(field)
            && (($0.excluded && $0.value.lowercased() == value.lowercased()) || (!$0.excluded && Self.opposite(field, $0.value, value))) }
    }

    /// Commit a highlighted completion, replacing only its matching trailing fragment.
    public static func completingSuggestion(_ text: String, field: String, value: String, title: String) -> String {
        let terms = LocalSessionQuery(text).terms
        let matches: (String) -> Bool = { fragment in
            !fragment.isEmpty && (value.localizedCaseInsensitiveContains(fragment) || title.localizedCaseInsensitiveContains(fragment))
        }
        var removed = 0
        if let last = terms.last, !last.excluded {
            if let lastField = last.field, Self.selectionField(lastField) == Self.selectionField(field) {
                if last.value.lowercased() != value.lowercased() && (last.value.isEmpty || matches(last.value)) { removed = 1 }
            } else if last.field == nil {
                var suffix: [String] = []
                for term in terms.reversed() {
                    guard term.field == nil, !term.excluded else { break }
                    suffix.insert(term.value, at: 0)
                    if matches(suffix.joined(separator: " ")) { removed = suffix.count }
                }
            }
        }
        let base = removed == 0 ? text : terms.dropLast(removed).map(\.raw).joined(separator: " ")
        return selectingSuggestion(base, field: field, value: value, selected: true)
    }

    /// Directional keyboard selection is idempotent: Right adds, Left removes.
    public static func selectingSuggestion(_ text: String, field: String, value: String, selected: Bool) -> String {
        let query = LocalSessionQuery(text)
        if selected && query.containsSelection(field, value: value) && query.conflictsWithSelection(field, value: value) {
            let kept = query.terms.filter { term in
                Self.selectionField(term.field ?? "") != Self.selectionField(field)
                    || !(term.excluded ? term.value.lowercased() == value.lowercased() : Self.opposite(field, term.value, value))
            }.map(\.raw).joined(separator: " ")
            return kept + " "
        }
        guard query.containsSelection(field, value: value) != selected else { return text }
        return suggesting(text, field: field, value: value)
    }

    /// Toggle a choice, completing only an unfinished qualifier prefix.
    public static func suggesting(_ text: String, field: String, value: String) -> String {
        let query = LocalSessionQuery(text)
        guard !value.isEmpty else { return query.applyingFilter(field, to: nil) }
        var parts = query.terms.map(\.raw)
        if text.last?.isWhitespace != true, let last = query.terms.last {
            let token = last.raw.lowercased()
            let suggestion = field.lowercased() + ":" + value.lowercased()
            let qualifierPrefix = last.field == nil && !token.isEmpty && field.lowercased().hasPrefix(token)
            let valuePrefix = last.field == field && token != suggestion && suggestion.hasPrefix(token)
            if !last.excluded && (qualifierPrefix || valuePrefix) { parts.removeLast() }
        }
        let base = LocalSessionQuery(parts.joined(separator: " "))
        if base.containsSelection(field, value: value) {
            parts = base.terms.filter {
                $0.excluded || Self.selectionField($0.field ?? "") != Self.selectionField(field) || $0.value.lowercased() != value.lowercased()
            }.map(\.raw)
        } else {
            parts = base.terms.filter { term in
                Self.selectionField(term.field ?? "") != Self.selectionField(field)
                    || !(term.excluded ? term.value.lowercased() == value.lowercased() : Self.opposite(field, term.value, value))
            }.map(\.raw)
            parts.append(LocalSessionQuery("").setting(field, to: value))
        }
        if parts.isEmpty { return "" }
        return parts.joined(separator: " ") + " "
    }

    private var oppositeSelectionError: String? {
        for term in terms where !term.excluded {
            if let field = term.field, ["is", "upload"].contains(field), terms.contains(where: { !$0.excluded && $0.field == field && Self.opposite(field, term.value, $0.value) }) {
                return field == "is" ? (["on-relay", "off-relay"].contains(term.value.lowercased()) ? "Choose either receives messages or does not receive messages." : "Choose either is:active or is:inactive.") : "Choose compatible upload filters; opposite states cannot be combined."
            }
        }
        return nil
    }

    public var error: String? {
        if let error = oppositeSelectionError { return error }
        for term in terms {
            guard let field = term.field else { continue }
            if term.value.isEmpty { return "Add a value after \(field):" }
            if ["updated", "after", "before"].contains(field), term.dates == nil {
                return "Use a date like updated:2026-10-01, updated:>=2026-10-01, or updated:2026-10-01..2026-10-11 (UTC)."
            }
            if field == "is", !["active", "inactive", "on-relay", "off-relay"].contains(term.value.lowercased()) {
                return "Use is:active, is:inactive, is:on-relay, or is:off-relay."
            }
            if field == "upload", !(["in-progress", "none"] + SessionUploadState.allCases.map(\.rawValue)).contains(term.value.lowercased()) {
                return "Use upload:uploaded, upload:local, upload:in-progress, or upload:discovering."
            }
        }
        return nil
    }

    public func matches(_ row: LocalSessionRow, uploadState: SessionUploadState? = nil) -> Bool {
        guard oppositeSelectionError == nil else { return false }
        // Discovery can lead the catalog; absence alone is not an upload failure.
        let state = uploadState ?? row.upload.map { SessionUploadState(session: $0, status: nil) } ?? .discovering
        let text = [row.title, row.source, row.project, row.directory, row.id, row.agentNames].joined(separator: " ")
        var alternatives: [String: Bool] = [:]
        for term in terms {
            var value = term.value.lowercased()
            // `@reviewer` is how agents are written: a term so written
            // searches agent names and addresses only.
            var field = term.field
            if (field == nil || field == "agent"), value.hasPrefix("@") {
                value = String(value.drop { $0 == "@" })
                field = "agent"
            }
            let match: Bool
            switch field {
            case "title": match = row.title.localizedCaseInsensitiveContains(value)
            case "project": match = row.project.localizedCaseInsensitiveContains(value)
            case "harness", "source": match = row.source.lowercased() == value
            case "path": match = row.directory.localizedCaseInsensitiveContains(value)
            case "id": match = row.id.localizedCaseInsensitiveContains(value)
            // An alias and the name it points at both find the session.
            case "agent": match = row.agentNames.localizedCaseInsensitiveContains(value)
            case "is":
                switch value {
                case "active": match = row.relay?.live == true
                case "inactive": match = row.relay?.live != true
                case "on-relay": match = row.relay?.registration != nil
                case "off-relay": match = row.relay?.registration == nil
                default: match = false
                }
            case "upload":
                if value == "none" { match = row.upload == nil }
                else if value == "in-progress" { match = state.isPending }
                else { match = state.rawValue == value }
            case "updated", "after", "before":
                if let date = row.updatedAt, let bounds = term.dates {
                    match = date >= bounds.0 && date < bounds.1
                } else { match = false }
            default: match = text.localizedCaseInsensitiveContains(value)
            }
            if term.excluded {
                if match { return false }
            } else if let field = term.field, ["harness", "source", "project", "upload"].contains(field) {
                let key = Self.selectionField(field)
                alternatives[key] = (alternatives[key] ?? false) || match
            } else if !match { return false }
        }
        return alternatives.values.allSatisfy { $0 }
    }

    private static func dateBounds(_ value: String, field: String) -> (Date, Date)? {
        func day(_ text: String) -> Date? {
            guard text.count == 10 else { return nil }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.isLenient = false
            guard let date = formatter.date(from: text), formatter.string(from: date) == text else { return nil }
            return date
        }
        if field == "after", let date = day(value) { return (date.addingTimeInterval(86400), .distantFuture) }
        if field == "before", let date = day(value) { return (.distantPast, date) }
        if field != "updated" { return nil }
        if value.contains("..") {
            let parts = value.components(separatedBy: "..")
            guard parts.count == 2 else { return nil }
            let start = parts[0].isEmpty || parts[0] == "*" ? Date.distantPast : day(parts[0])
            let end = parts[1].isEmpty || parts[1] == "*" ? Date.distantFuture : day(parts[1])?.addingTimeInterval(86400)
            guard let start, let end, start < end else { return nil }
            return (start, end)
        }
        for op in [">=", "<=", ">", "<"] where value.hasPrefix(op) {
            guard let date = day(String(value.dropFirst(op.count))) else { return nil }
            switch op {
            case ">=": return (date, .distantFuture)
            case ">": return (date.addingTimeInterval(86400), .distantFuture)
            case "<=": return (.distantPast, date.addingTimeInterval(86400))
            default: return (.distantPast, date)
            }
        }
        return day(value).map { ($0, $0.addingTimeInterval(86400)) }
    }
}
