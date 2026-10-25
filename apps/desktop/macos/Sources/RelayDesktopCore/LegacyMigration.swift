import Foundation

/// What earlier macOS builds kept in the app that the core now owns. Each
/// step runs once and then forgets the old state.
public enum LegacyMigration {
    /// The person turned diagnostics off.
    public static let analyticsEnabledKey = "desktop.analytics.enabled"
    /// The anonymous installation id; the core issues its own.
    public static let analyticsIdentityKey = "desktop.analytics.identity"
    /// The mailbox device id; the core issues its own once.
    public static let deviceIDKey = "desktop-cloud-device-id"
    /// The contractor-access flag.
    public static let contractorAccessKey = "ContractorAccessEnabled"
    /// Contractor seats hidden on this Mac; the core keeps its own.
    public static let contractorDismissedKey = "ContractorAccessDismissedSeats"
    /// The app turned its own login item on once after the first sign-in;
    /// the core's LaunchAgent runs at login now, so the app no longer does.
    public static let loginItemConfiguredKey = "loginItemConfigured"
    /// Incoming sharing-policy recovery markers, one per policy file.
    public static let incomingRecoveryPrefix = "incoming-policy-incomplete:"

    /// The settings the core must be told, from what this Mac kept: nil
    /// when there is nothing to carry over.
    public static func settings(in defaults: UserDefaults) -> SettingsChange? {
        let analytics: Bool? = defaults.object(forKey: analyticsEnabledKey) as? Bool == false ? false : nil
        let contractors: Bool? = defaults.bool(forKey: contractorAccessKey) ? true : nil
        guard analytics != nil || contractors != nil else { return nil }
        return SettingsChange(analyticsEnabled: analytics, contractorAccess: contractors)
    }

    /// Removes every key the app no longer reads. Run after `settings`
    /// reached the core, so a failure is retried at the next launch.
    public static func forgetDefaults(in defaults: UserDefaults) {
        for key in [analyticsEnabledKey, analyticsIdentityKey, deviceIDKey, contractorAccessKey, contractorDismissedKey, loginItemConfiguredKey] {
            defaults.removeObject(forKey: key)
        }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(incomingRecoveryPrefix) {
            defaults.removeObject(forKey: key)
        }
    }

    /// Where earlier builds kept Skip conversations.
    public static func legacyConversations(supportDirectory: URL) -> URL {
        supportDirectory.appendingPathComponent("AgentRelay/Conversations")
    }

    /// Moves Skip conversations into the app data directory the core reads.
    /// A file the core already has stays the core's. The old directory, and
    /// its `AgentRelay` parent once empty, are removed. Run before the core
    /// starts.
    public static func moveConversations(from legacy: URL, to destination: URL, fileManager: FileManager = .default) throws {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: legacy.path, isDirectory: &isDirectory), isDirectory.boolValue else { return }
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
        for name in try fileManager.contentsOfDirectory(atPath: legacy.path) {
            let source = legacy.appendingPathComponent(name)
            let target = destination.appendingPathComponent(name)
            if fileManager.fileExists(atPath: target.path) {
                try fileManager.removeItem(at: source)
            } else {
                try fileManager.moveItem(at: source, to: target)
                try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            }
        }
        try fileManager.removeItem(at: legacy)
        let parent = legacy.deletingLastPathComponent()
        if (try? fileManager.contentsOfDirectory(atPath: parent.path))?.isEmpty == true {
            try? fileManager.removeItem(at: parent)
        }
    }
}
