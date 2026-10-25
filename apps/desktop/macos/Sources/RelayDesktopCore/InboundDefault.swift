import Foundation

/// Claude Code direct delivery (`crossSessionInbound: "accept"`) is on by
/// default; first-run setup explains it with a pre-checked box on the
/// sign-in screen, offered once, and unticking it turns it off (`hold`). The
/// core keeps a value the user already chose, `hold` included, and never
/// edits an organization's managed settings. The Linux app's
/// `models.inbound_default_offer` matches this word for word.
public enum InboundDefault {
    public static let label = "Deliver relayed messages to Claude Code directly"
    public static let detail = "Sets \"crossSessionInbound\": \"accept\" in ~/.claude/settings.json unless you already chose a value."
    /// Set once the sign-in screen has offered the default.
    public static let offeredKey = "claudeInboundDefaultOffered"

    public enum Offer: Equatable, Sendable {
        /// The pre-checked box.
        case offer
        /// The organization's managed value, which wins.
        case managed(String)
    }

    /// What the sign-in screen shows: the box while direct delivery is on
    /// (usually by the core's own default) or the settings are not read yet
    /// (`nil`), so a sign-in clicked early still applies the choice; the
    /// managed value when the organization pins one; nothing once offered,
    /// when the core has no Claude settings, or when it is off, which is the
    /// user's own `hold` or `refuse` (kept) or a computer where Claude Code
    /// has not run.
    public static func offer(_ settings: SettingsValues?, alreadyOffered: Bool) -> Offer? {
        if alreadyOffered { return nil }
        guard let settings else { return .offer }
        guard let direct = settings.directDelivery else { return nil }
        if let managed = settings.directDeliveryManaged, managed != "accept" { return .managed(managed) }
        return direct ? .offer : nil
    }

    public static func managedDetail(_ managed: String) -> String {
        if managed == "refuse" {
            return "Your organization's managed settings set `crossSessionInbound` to `refuse`, so Claude Code drops relayed messages. Ask your admin to change it."
        }
        return "Your organization's managed settings set `crossSessionInbound` to `\(managed)`, so Claude Code asks before showing each message. Ask your admin to change it."
    }
}
