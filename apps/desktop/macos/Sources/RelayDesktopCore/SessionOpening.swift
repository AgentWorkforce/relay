import Foundation

public enum SessionOpenPreference: String, CaseIterable, Identifiable {
    case automatic, terminal
    public var id: String { rawValue }
    public var title: String { self == .automatic ? "Automatic" : "Terminal" }
    public static func storageKey(_ source: String) -> String { "sessionOpening.\(source)" }
}

public enum SessionOpenDestination: Equatable {
    case desktop, terminal, unavailable
}

/// Only local CLI identities can be resumed. Cloud Claude IDs are not CLI IDs.
/// A session Agent Relay spawned is never resumed beside the process that
/// runs it: a spawned Codex thread opens only in Codex, whose app server
/// hosts it, a spawned Claude is taken over instead (`SpawnHandover`) until
/// it has been, and any other it runs (Grok, OpenCode…) is not opened at all
/// while it does.
public struct SessionOpening: Equatable {
    public let deepLink: URL?
    public let command: String?
    public let desktopCommand: String?
    /// Opened only live in its app: never resumed in Terminal, whatever the
    /// preference.
    public let liveOnly: Bool
    /// What holds the session now, as the core reports it. Claude Desktop
    /// resumes a session in a process of its own, so Claude Code refuses
    /// `--desktop --resume` while anything holds it; only the holder hands
    /// over. A held session is not offered a handoff that is always
    /// refused: it keeps what still works, with `heldNote` beside it.
    public let holder: SessionHolder?

    /// What to do instead, beside the open action of a held session. None
    /// for a session Agent Relay spawned: it is taken over instead, and
    /// `SpawnHandover` has its own notes for that.
    public static func heldNote(_ session: LocalSession?) -> String? {
        guard SpawnHandover.of(session) == nil, session?.running != false else { return nil }
        switch session?.holder {
        case .interactive: return interactiveHolderNote
        case .background: return backgroundHolderNote
        // A holder a newer core names: its handoff is still not offered,
        // but this build has no advice it can vouch for.
        case .unknown, .none: return nil
        }
    }
    public static let interactiveHolderNote =
        "This session is open in a terminal. Run /desktop there to continue it in Claude."
    public static let backgroundHolderNote =
        "A headless Claude Code process is running this session. Run claude agents to find it, or stop it, to continue it here."

    /// The Claude Code CLI's own failure, as the alert should put it. A
    /// holder that took the session between the check and the launch is
    /// reported with the note for it, in place of a line naming the
    /// session id. Matching the CLI's wording is a backstop for that race,
    /// not the check: wording this does not recognise is passed through as
    /// the CLI wrote it.
    public static func desktopFailure(_ detail: String) -> String {
        if detail.contains("is open in another terminal") { return interactiveHolderNote }
        if detail.contains("is running in the background") { return backgroundHolderNote }
        return (detail.isEmpty ? "Claude Desktop could not open this session." : detail)
            + " Use Open in Terminal as an alternative."
    }
    public var title: String {
        if deepLink != nil { return "Open in Codex" }
        return desktopCommand == nil ? "Open in Terminal" : "Open in Claude"
    }

    public func destination(preference: SessionOpenPreference, desktopAvailable: Bool) -> SessionOpenDestination {
        if liveOnly { return desktopAvailable ? .desktop : .unavailable }
        if preference == .automatic && desktopAvailable && (deepLink != nil || desktopCommand != nil) { return .desktop }
        return command == nil ? .unavailable : .terminal
    }

    /// `relay` is the row's session as last read, when newer than the row's.
    public init?(row: LocalSessionRow, relay: LocalSession? = nil) {
        guard row.relay?.target.kind != .claudeCloud,
              let id = row.upload?.sessionId ?? row.relay?.target.id else { return nil }
        let session = relay ?? row.relay
        let handover = SpawnHandover.of(session)
        if handover == .takeOver { return nil }
        // What holds the session is read only from `relay`, the session as
        // discovery lists it now: the row's own copy is from when the row
        // was built, and a session that has since ended holds nothing.
        let holder = relay?.running == false ? nil : relay?.holder
        self.init(source: row.source, id: id, directory: row.directory,
                  liveOnly: handover == .openLive, holder: holder)
    }

    public init?(source: String, id: String, directory: String, liveOnly: Bool = false,
                 holder: SessionHolder? = nil) {
        guard !id.isEmpty, !id.hasPrefix("-"), !id.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { return nil }
        let cli: String
        switch source {
        case "codex": cli = "codex resume"
        case "claude": cli = "claude --resume"
        case "grok": cli = "grok --resume"
        default: return nil
        }
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~")))!
        deepLink = source == "codex" ? URL(string: "codex://threads/\(encoded)") : nil
        // Opened live only through its app: without a deep link, not at all.
        if liveOnly && deepLink == nil { return nil }
        self.liveOnly = liveOnly
        self.holder = holder
        // A session a person is typing in resumes in Terminal beside them;
        // one a headless process holds is refused there too, so it is not
        // offered at all. Never silently resume under the desktop app's
        // working directory.
        command = !self.liveOnly && holder != .background && directory.hasPrefix("/") && !directory.contains("\0")
            ? "cd -- \(Self.quote(directory)) && \(cli) \(Self.quote(id))" : nil
        // --desktop requires Claude Code >= 2.1.285 and subscription login.
        // The CLI owns the handoff and reports version/auth errors; the one
        // refusal it cannot recover from, a session another process holds,
        // is not asked for at all.
        desktopCommand = source == "claude" && command != nil && holder == nil
            ? "cd -- \(Self.quote(directory)) && exec claude --desktop --resume \(Self.quote(id))" : nil
        if deepLink == nil && command == nil { return nil }
    }

    public static func quote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}
