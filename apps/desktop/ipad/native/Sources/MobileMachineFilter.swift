import Foundation

/// Host metadata and address-safe hostnames identify the same computer.
/// Keep endpoint names intact: normalization is only for display and filtering.
enum MobileMachineFilter {
    private static func label(_ name: String) -> String {
        var host = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if host.hasSuffix(".") { host.removeLast() }
        if host.lowercased().hasSuffix(".local") { host.removeLast(6) }
        return host
    }

    static func key(_ name: String) -> String {
        label(name).folding(options: [.diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased().filter { $0.isLetter || $0.isNumber }
    }

    static func matches(_ name: String, selected: String) -> Bool {
        selected.isEmpty || key(name) == key(selected)
    }

    static func options(_ names: [String]) -> [String] {
        var seen: Set<String> = []
        return names.map(label).filter { !key($0).isEmpty }
            .sorted { ($0.lowercased(), $0) < ($1.lowercased(), $1) }
            .filter { seen.insert(key($0)).inserted }
    }
}
