import Foundation

/// Constants about this app itself.
enum AppInfo {
    static let subsystem = "com.agentrelay.desktop"
    static let displayName = "Agent Relay"
    static let productionSiteURL = "https://agentrelay.com"

    /// The site this build signs in to: Agent Relay Dev carries a loopback
    /// site in Resources/site-url.txt.
    static var defaultSiteURL: String {
        guard let path = Bundle.main.url(forResource: "site-url", withExtension: "txt"),
              let text = try? String(contentsOf: path, encoding: .utf8) else { return productionSiteURL }
        let site = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: site), ["http", "https"].contains(url.scheme ?? ""), url.host != nil else {
            return productionSiteURL
        }
        return site
    }

    static var isDevelopment: Bool { defaultSiteURL != productionSiteURL }

    /// This build's directory in Application Support, which the core owns:
    /// the agent store, outboxes, conversations and the relay-send socket.
    /// Agent Relay Dev keeps its own.
    static var dataDirectory: URL { dataDirectory(in: nil) }

    static func dataDirectory(in supportDirectory: URL?, development: Bool = isDevelopment) -> URL {
        (supportDirectory ?? applicationSupport)
            .appendingPathComponent(development ? "\(subsystem).dev" : subsystem)
    }

    static var applicationSupport: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
    }

    /// The core's bridge socket, as its LaunchAgent serves it:
    /// `~/.agentworkforce/desktop/core.sock` (`core.dev.sock` for Agent Relay Dev).
    static var coreSocket: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agentworkforce/desktop/\(isDevelopment ? "core.dev.sock" : "core.sock")").path
    }

    /// The core version in this bundle, from Resources/probe-version.txt.
    static var bundledCoreVersion: String? {
        guard let url = Bundle.main.url(forResource: "probe-version", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let version = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return version.isEmpty ? nil : version
    }

    /// The welcome screen and connected settings share one persistent window.
    static let mainWindowID = "main"

    static var buildRevision: String? {
        guard let path = Bundle.main.url(forResource: "build-revision", withExtension: "txt"),
              let value = try? String(contentsOf: path, encoding: .utf8) else { return nil }
        let revision = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return revision.isEmpty ? nil : revision
    }

    static var displayVersion: String {
        if isDevelopment || version == "0.0.0" || version == "development build" {
            return "Development (\(buildRevision ?? "unknown revision"))"
        }
        return version
    }

    /// Marketing version from the bundle, e.g. "1.2.0".
    static var version: String {
        let value = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        guard let value, !value.isEmpty else { return "development build" }
        return value
    }
}
