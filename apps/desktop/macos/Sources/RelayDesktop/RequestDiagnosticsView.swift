import RelayDesktopCore
import SwiftUI

struct RequestDiagnosticsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var failuresOnly = false
    @State private var expanded: Set<String> = []
    @State private var copiedProblems = false

    private var entries: [RequestEntry] {
        var entries = model.requestEntries
        if let selected = model.selectedRequest, !entries.contains(where: { $0.id == selected.id }) {
            entries.insert(selected, at: 0)
        }
        return entries.filter { !failuresOnly || $0.failed }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !model.appStatusProblems.isEmpty {
                Text("Current problems").font(.headline).foregroundStyle(CloudTheme.warning).id("app-problems")
                ForEach(model.appStatusProblems, id: \.self) { problem in
                    Text(problem).textSelection(.enabled)
                }
                Button(copiedProblems ? "Copied" : "Copy details") {
                    copiedProblems = RelayClipboard.copy(model.appStatusProblems.joined(separator: "\n\n"))
                }
                .task(id: copiedProblems) {
                    guard copiedProblems else { return }
                    try? await Task.sleep(for: .seconds(2))
                    copiedProblems = false
                }
                Divider()
            }
            HStack {
                Text("Requests").font(.headline)
                Spacer()
                Toggle("Failures only", isOn: $failuresOnly).toggleStyle(.checkbox)
            }
            if let error = model.requestLogError {
                Text(error).font(.caption).foregroundStyle(CloudTheme.warning)
            }
            if entries.isEmpty {
                Text(failuresOnly ? "No failed requests." : "No requests recorded yet.")
                    .foregroundStyle(CloudTheme.secondary).padding(.vertical, 16)
            }
            ForEach(entries, id: \.id) { entry in
                DisclosureGroup(isExpanded: Binding(
                    get: { expanded.contains(entry.id) || model.selectedRequest?.id == entry.id },
                    set: { value in
                        if value { expanded.insert(entry.id) }
                        else {
                            expanded.remove(entry.id)
                            if model.selectedRequest?.id == entry.id { model.selectedRequest = nil }
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(entry.endpoint).textSelection(.enabled)
                        Text("Request").fontWeight(.semibold)
                        Text(entry.request).textSelection(.enabled)
                        Text("Response").fontWeight(.semibold)
                        Text(entry.response).textSelection(.enabled)
                        Button("Copy request details") {
                            RelayClipboard.copy("\(entry.serviceName) · \(entry.method) \(entry.endpoint)\nStatus: \(entry.status.map(String.init) ?? "Unavailable") · \(entry.durationMs.map { "\($0) ms" } ?? "Pending")\nRequest\n\(entry.request)\nResponse\n\(entry.response)")
                        }
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: entry.failed ? "exclamationmark.circle.fill" : (entry.durationMs == nil ? "clock" : "checkmark.circle"))
                            .foregroundStyle(entry.failed ? CloudTheme.warning : CloudTheme.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(entry.serviceName) · \(entry.method) \(entry.endpoint)").lineLimit(2)
                            Text("\(Date(timeIntervalSince1970: Double(entry.startedAtMs) / 1000).formatted(date: .omitted, time: .standard)) · \(entry.status.map { "HTTP \($0)" } ?? (entry.durationMs == nil ? "Pending" : (entry.failed ? "Failed" : "Completed")))\(entry.durationMs.map { " · \($0) ms" } ?? "")")
                                .font(.caption).foregroundStyle(CloudTheme.secondary)
                        }
                    }
                }
                .disclosureGroupStyle(RequestDisclosureStyle())
                .background(model.selectedRequest?.id == entry.id ? CloudTheme.warning.opacity(0.10) : CloudTheme.sidebar)
                .cornerRadius(6).id(entry.id)
            }
        }
        .onChange(of: model.selectedRequest?.id) { _ in failuresOnly = false }
    }
}

private struct RequestDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption).frame(width: 12)
                    configuration.label
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded {
                configuration.content
                    .padding(.horizontal, 12).padding(.bottom, 12)
            }
        }
    }
}
