import AppKit
import SwiftUI

/// Launch Services is authoritative for installed apps, including apps outside /Applications.
@MainActor final class SessionApplications: ObservableObject {
    static let shared = SessionApplications()
    @Published private(set) var claudeDesktop = false
    @Published private(set) var codexDesktop = false

    init() { refresh() }

    func refresh() {
        claudeDesktop = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.anthropic.claudefordesktop") != nil
        codexDesktop = URL(string: "codex://threads/").flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0) } != nil
    }

    func desktopAvailable(for source: String) -> Bool {
        switch source {
        case "claude": return claudeDesktop
        case "codex": return codexDesktop
        default: return false
        }
    }
}
