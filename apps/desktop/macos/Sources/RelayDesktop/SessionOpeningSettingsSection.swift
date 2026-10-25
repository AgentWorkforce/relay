import AppKit
import SwiftUI
import RelayDesktopCore

struct SessionOpeningSettingsSection: View {
    @ObservedObject private var applications = SessionApplications.shared
    @AppStorage("sessionOpening.claude") private var claude: SessionOpenPreference = .automatic
    @AppStorage("sessionOpening.codex") private var codex: SessionOpenPreference = .automatic

    var body: some View {
        SettingsSection(title: "Open local sessions", description: "Automatic opens the desktop app when installed, otherwise Terminal. These preferences apply only to this computer.") {
            VStack(spacing: 0) {
                provider("Claude Code", detail: applications.claudeDesktop ? "Claude Desktop is installed" : "Claude Desktop isn’t installed. Sessions open in Terminal.", preference: $claude)
                Divider().overlay(CloudTheme.border).padding(.leading, 20)
                provider("Codex", detail: applications.codexDesktop ? "Codex is installed" : "Codex isn’t installed. Sessions open in Terminal.", preference: $codex)
                Divider().overlay(CloudTheme.border).padding(.leading, 20)
                HStack {
                    Text("Grok").fontWeight(.medium)
                    Spacer()
                    Text("Terminal").foregroundStyle(CloudTheme.secondary)
                }.padding(20)
            }
        }
        DisclosureGroup("Requirements & troubleshooting") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Opening in Claude requires Claude Code 2.1.285 or later and a Claude subscription. If a session is still open elsewhere, close it there first or choose Terminal.")
                Text("Terminal resume requires the matching CLI and the session’s original folder. Historical sessions don’t reliably record whether they were used in a terminal or desktop app.")
                HStack(spacing: 12) {
                    if !applications.claudeDesktop {
                        Link("Download Claude Desktop", destination: URL(string: "https://claude.com/download")!)
                    }
                    Link("Set up Claude Code", destination: URL(string: "https://code.claude.com/docs/en/quickstart")!)
                }
            }
            .font(.system(size: 12)).foregroundStyle(CloudTheme.secondary)
            .fixedSize(horizontal: false, vertical: true).padding(.top, 12)
        }
        Button("Check installed apps") { applications.refresh() }
        .onAppear { applications.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in applications.refresh() }
    }

    private func provider(_ name: String, detail: String, preference: Binding<SessionOpenPreference>) -> some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 5) {
                Text(name).fontWeight(.medium)
                Text(detail).font(.system(size: 12)).foregroundStyle(CloudTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Picker(name, selection: preference) {
                ForEach(SessionOpenPreference.allCases) { Text($0.title).tag($0) }
            }.labelsHidden().frame(width: 150).accessibilityLabel("Open \(name) sessions")
        }.padding(20)
    }
}
