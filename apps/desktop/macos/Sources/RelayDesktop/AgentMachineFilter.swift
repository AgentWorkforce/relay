import Foundation
import SwiftUI
import RelayDesktopCore

enum AgentMachineFilter {
    static func key(_ name: String) -> String {
        name.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    static func host(_ agent: RosterAgent) -> String? {
        if let host = agent.host, !host.isEmpty { return host }
        guard let address = agent.address, let at = address.lastIndex(of: "@") else { return nil }
        return String(address[address.index(after: at)...])
    }

    static func matches(_ name: String?, selected: String) -> Bool {
        selected.isEmpty || (name.map { key($0) == key(selected) } ?? false)
    }

    /// Whether the picker names another machine. Its agents on the relay are
    /// then that machine's "On the relay" list, since none of this Mac's
    /// sessions are on it.
    static func showsElsewhereAsRelay(thisMachine: String, selected: String) -> Bool {
        !selected.isEmpty && !matches(thisMachine, selected: selected)
    }

    static func options(_ names: [String]) -> [String] {
        var unique: [String: String] = [:]
        for name in names where !name.isEmpty { unique[key(name)] = name }
        return unique.values.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}

struct AgentMachinePicker: View {
    @Binding var selection: String
    let names: [String]

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "desktopcomputer").foregroundStyle(.secondary)
            Picker("Machine", selection: $selection) {
                Text("All machines").tag("")
                ForEach(AgentMachineFilter.options(names), id: \.self) { name in
                    Text(name).tag(name)
                }
            }
            .pickerStyle(.menu)
            Spacer()
        }
        .font(.system(size: 12)).padding(.horizontal, 8)
    }
}
