import Foundation
import OSLog
import RelayDesktopCore
import ServiceManagement

/// The core's LaunchAgent, `Contents/Library/LaunchAgents/<label>.plist`.
/// Agent Relay Dev has its own label, socket and data directory.
final class LaunchAgentService: CoreService {
    private static let logger = Logger(subsystem: AppInfo.subsystem, category: "launch-agent")
    static var plistName: String {
        AppInfo.isDevelopment ? "com.agentrelay.desktop.dev.core.plist" : "com.agentrelay.desktop.core.plist"
    }

    /// OS calls are replaceable so recovery tests never register a real job.
    struct System {
        var bundledStatus: () -> SMAppService.Status
        var registerBundled: () throws -> Void
        var unregisterBundled: () throws -> Void
        var legacyStatus: (URL) -> SMAppService.Status
        var launchctl: ([String]) -> (success: Bool, output: String)
        var pause: (TimeInterval) -> Void

        static func live() -> Self {
            let service = SMAppService.agent(plistName: LaunchAgentService.plistName)
            return Self(bundledStatus: { service.status },
                        registerBundled: { try service.register() },
                        unregisterBundled: { try service.unregister() },
                        legacyStatus: { SMAppService.statusForLegacyPlist(at: $0) },
                        launchctl: LaunchAgentService.runLaunchctl,
                        pause: { Thread.sleep(forTimeInterval: $0) })
        }
    }

    private let system: System
    private let bundleURL: URL
    private let homeDirectory: URL
    private let bundleIdentifier: String
    private let defaults: UserDefaults

    init(bundleURL: URL = Bundle.main.bundleURL,
         homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
         bundleIdentifier: String = Bundle.main.bundleIdentifier ?? "com.agentrelay.desktop",
         defaults: UserDefaults = .standard, system: System? = nil) {
        self.bundleURL = bundleURL
        self.homeDirectory = homeDirectory
        self.bundleIdentifier = bundleIdentifier
        self.defaults = defaults
        self.system = system ?? .live()
    }

    private var label: String { Self.plistName.replacingOccurrences(of: ".plist", with: "") }
    private var fallbackLabel: String { "\(label).local" }
    private var fallbackKey: String { "\(label).usesLocalLaunchAgent" }
    private var usesFallback: Bool { defaults.bool(forKey: fallbackKey) }
    private var fallbackURL: URL {
        homeDirectory.appendingPathComponent("Library/LaunchAgents/\(fallbackLabel).plist")
    }

    var installationProblem: String? {
        guard !AppInfo.isDevelopment, bundlesPlist,
              !Self.isInstalledInApplications(bundleURL, homeDirectory: homeDirectory) else { return nil }
        return "Move Agent Relay to Applications, then open that copy. A copy opened from a disk image or temporary folder cannot keep its background service connected."
    }

    static func isInstalledInApplications(_ bundleURL: URL, homeDirectory: URL) -> Bool {
        let parent = bundleURL.standardizedFileURL.resolvingSymlinksInPath()
            .deletingLastPathComponent().path
        let applications = URL(fileURLWithPath: "/Applications", isDirectory: true)
            .resolvingSymlinksInPath().path
        let userApplications = homeDirectory.appendingPathComponent("Applications", isDirectory: true)
            .resolvingSymlinksInPath().path
        return parent == applications || parent == userApplications
    }

    var status: CoreServiceStatus {
        if usesFallback {
            if system.legacyStatus(fallbackURL) == .requiresApproval { return .requiresApproval }
            let loaded = launchctl("print", "gui/\(getuid())/\(fallbackLabel)")
            guard loaded.success,
                  let expected = try? fallbackPlist()["Program"] as? String,
                  Self.loadedProgram(loaded.output) == expected else { return .notRegistered }
            return .enabled
        }
        switch system.bundledStatus() {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notRegistered: return .notRegistered
        // Before its first registration launchd has no record of the agent
        // and reports it not found; only a bundle without the property list
        // (`swift run`) really has none.
        case .notFound: return bundlesPlist ? .notRegistered : .notFound
        @unknown default: return .notFound
        }
    }

    private var bundlesPlist: Bool {
        FileManager.default.fileExists(atPath: bundleURL
            .appendingPathComponent("Contents/Library/LaunchAgents/\(Self.plistName)").path)
    }

    /// This build: the bundled core's SHA-256, which `build-app.sh` records
    /// beside it, the app executable, and the bundle's absolute path. Moving
    /// the app changes the fallback LaunchAgent's Program even if its bytes
    /// are identical, so that move must re-register the loaded job.
    var binaryIdentity: String? {
        guard let url = Bundle.main.url(forResource: "agent-relay-probe", withExtension: "sha256"),
              let line = try? String(contentsOf: url, encoding: .utf8),
              let digest = line.split(separator: " ").first, !digest.isEmpty,
              let executable = Bundle.main.executableURL,
              let attributes = try? FileManager.default.attributesOfItem(atPath: executable.path),
              let modified = attributes[.modificationDate] as? Date else { return nil }
        return Self.binaryIdentity(digest: String(digest), modified: modified,
                                   bundleURL: bundleURL)
    }

    static func binaryIdentity(digest: String, modified: Date, bundleURL: URL) -> String {
        "\(digest)-\(modified.timeIntervalSince1970)-\(bundleURL.standardizedFileURL.path)"
    }

    func register() throws {
        if let installationProblem { throw fallbackError(installationProblem) }
        guard usesFallback else { try system.registerBundled(); return }
        _ = try registerFallback(forceReload: true)
        retireBundledJob()
    }

    @discardableResult
    private func registerFallback(forceReload: Bool) throws -> Bool {
        let plist = try fallbackPlist()
        let contents = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try FileManager.default.createDirectory(at: fallbackURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: fallbackURL, options: .atomic)
        // Respect revoked consent even if launchd still has the job loaded.
        guard system.legacyStatus(fallbackURL) != .requiresApproval else { return false }
        let loaded = launchctl("print", "gui/\(getuid())/\(fallbackLabel)")
        if loaded.success {
            if !forceReload, Self.loadedProgram(loaded.output) == plist["Program"] as? String { return false }
            try bootoutFallback()
        }
        let result = launchctl("bootstrap", "gui/\(getuid())", fallbackURL.path)
        if !result.success {
            // macOS may record the approval requirement during bootstrap.
            guard system.legacyStatus(fallbackURL) != .requiresApproval else { return false }
            throw fallbackError(result.output)
        }
        return true
    }

    private func bootoutFallback() throws {
        let result = launchctl("bootout", "gui/\(getuid())/\(fallbackLabel)")
        // bootout can return before the old label disappears. Never treat a
        // lingering job as the newly submitted one, even with the same path.
        for _ in 0..<20 {
            if !launchctl("print", "gui/\(getuid())/\(fallbackLabel)").success { return }
            guard result.success else { throw fallbackError(result.output) }
            system.pause(0.05)
        }
        throw fallbackError("The previous background service has not stopped yet. Try again.")
    }

    func unregister() throws {
        guard usesFallback else { try system.unregisterBundled(); return }
        if launchctl("print", "gui/\(getuid())/\(fallbackLabel)").success {
            try bootoutFallback()
        }
        // A failed submission (or failed retirement) can leave the broken
        // original registered alongside the selected fallback. Stop owns both.
        if system.bundledStatus() == .enabled || system.bundledStatus() == .requiresApproval {
            try system.unregisterBundled()
        }
        if FileManager.default.fileExists(atPath: fallbackURL.path) {
            try FileManager.default.removeItem(at: fallbackURL)
        }
    }

    /// BTM can retain a relative agent URL with no parent bundle even though
    /// SMAppService says enabled. Re-registering repeats the same failed job.
    /// Only this exact launchd failure switches to a user LaunchAgent whose
    /// Program names the helper in the installed app by absolute path.
    func recoverSpawnFailure() throws -> Bool {
        guard installationProblem == nil else { return false }
        if usesFallback {
            let recovered = try registerFallback(forceReload: false)
            retireBundledJob()
            return recovered
        }
        guard system.bundledStatus() == .enabled else { return false }
        let result = launchctl("print", "gui/\(getuid())/\(label)")
        guard result.success, Self.hasBrokenBundleProgram(result.output) else { return false }
        // Persist the selected recovery method, not a claim that it started.
        // status and the usesFallback branch above handle failed submissions
        // immediately, including after relaunch or an original job disappearing.
        defaults.set(true, forKey: fallbackKey)
        // Keep the broken job registered until the fallback is submitted.
        do { try registerFallback(forceReload: true) } catch {
            throw fallbackError("The backup background service could not start: \(error.localizedDescription)")
        }
        retireBundledJob()
        return true
    }

    private func retireBundledJob() {
        guard system.bundledStatus() == .enabled else { return }
        // The affected install proved both labels can coexist if BTM refuses
        // to remove the broken original job.
        do { try system.unregisterBundled() } catch {
            Self.logger.error("could not remove the broken SMAppService job: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func hasBrokenBundleProgram(_ output: String) -> Bool {
        output.contains("job state = spawn failed")
            && output.range(of: #"last exit code = 78(?:\D|$)"#, options: .regularExpression) != nil
            && output.contains("program identifier = Contents/Helpers/")
    }

    static func loadedProgram(_ output: String) -> String? {
        output.split(separator: "\n").lazy.map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.hasPrefix("program = ") }.map { String($0.dropFirst("program = ".count)) }
    }

    private func fallbackPlist() throws -> [String: Any] {
        let bundled = bundleURL
            .appendingPathComponent("Contents/Library/LaunchAgents/\(Self.plistName)")
        let data = try Data(contentsOf: bundled)
        guard let source = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let program = source["BundleProgram"] as? String,
              program.hasPrefix("Contents/Helpers/"),
              let arguments = source["ProgramArguments"] as? [String],
              !arguments.isEmpty else { throw fallbackError("The bundled core LaunchAgent is invalid.") }
        let helper = bundleURL.appendingPathComponent(program).standardizedFileURL
        guard helper.path.hasPrefix(bundleURL.standardizedFileURL.path + "/"),
              FileManager.default.isExecutableFile(atPath: helper.path) else {
            throw fallbackError("The bundled core helper is missing.")
        }
        return [
            "Label": fallbackLabel,
            "Program": helper.path,
            "ProgramArguments": arguments,
            "AssociatedBundleIdentifiers": [bundleIdentifier],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 10,
            "ProcessType": "Background"
        ]
    }

    private func launchctl(_ arguments: String...) -> (success: Bool, output: String) {
        system.launchctl(arguments)
    }

    private static func runLaunchctl(_ arguments: [String]) -> (success: Bool, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return (false, error.localizedDescription) }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return (process.terminationStatus == 0, output)
    }

    private func fallbackError(_ message: String) -> NSError {
        NSError(domain: "com.agentrelay.desktop.launch-agent", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}
