import Foundation

/// Wording for the trusted senders setting (`trusted_relay_senders`),
/// shown while OpenClaw or Hermes is on. The Linux app's `TRUSTED_SENDERS_*`
/// constants match these word for word.
public enum TrustedSendersCopy {
    public static let title = "Trusted senders"
    public static let detail = "Relay names or addresses trusted like you: their messages reach your own OpenClaw and Hermes, with their memory and tools. Everyone else gets an answer-only chat of their own. Separate them with commas."
    public static let placeholder = "teammate, name@machine"

    /// The comma-separated field as the list `trusted_relay_senders` takes:
    /// trimmed, empty entries dropped.
    public static func senders(from text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}
