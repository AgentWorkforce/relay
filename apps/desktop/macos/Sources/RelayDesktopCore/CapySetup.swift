import Foundation

/// The card above the session table offered to people who use Capy: Capy threads run on
/// Capy's servers, so setup happens in a Capy thread, which proposes the
/// Agent Relay plugin for the person to approve once. Shown while Capy is
/// detected and the card was not dismissed. The Linux app's
/// `models::capy_setup` matches this word for word.
public enum CapySetup {
    public static let title = "Capy detected"
    public static let message = "Put your Capy threads on Agent Relay so other agents can message them and their conversations appear in Sessions. Capy asks you to approve the Agent Relay plugin once."
    public static let setUpAction = "Set up in Capy"
    public static let notNowAction = "Not now"
    /// Copied to the clipboard for the person to paste into a Capy thread.
    public static let prompt = "Set me up on Agent Relay: https://github.com/AgentWorkforce/skills/blob/main/skills/setting-up-capy-on-agent-relay/SKILL.md"
    public static let copied = "Prompt copied. Paste it into a Capy thread."
    public static let url = URL(string: "https://capy.ai")!
    /// Set once the person chose Not now; the card never returns.
    public static let dismissedKey = "capySetupDismissed"

    /// Capy is installed: its app in `/Applications` or `~/Applications`, or
    /// the `~/.capy` directory its device connector creates on a paired
    /// computer.
    public static func isInstalled(home: URL,
                                   applications: URL = URL(fileURLWithPath: "/Applications", isDirectory: true),
                                   fileManager: FileManager = .default) -> Bool {
        [applications.appendingPathComponent("Capy.app"),
         home.appendingPathComponent("Applications/Capy.app"),
         home.appendingPathComponent(".capy")].contains { candidate in
            var isDirectory: ObjCBool = false
            return fileManager.fileExists(atPath: candidate.path, isDirectory: &isDirectory) && isDirectory.boolValue
        }
    }

    public static func shows(installed: Bool, dismissed: Bool) -> Bool {
        installed && !dismissed
    }
}
