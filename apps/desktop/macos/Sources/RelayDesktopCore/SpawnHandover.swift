import Foundation

/// What the apps offer for a session Agent Relay spawned here, from what the
/// core reports on its registration (`SessionSpawn`). Joining it shows its
/// live transcript inside Agent Relay with a message box that sends into the
/// running agent through the relay; taking it over stops it headless and
/// hands its session to the person, so exactly one process runs it. The
/// Linux app's `models::spawn_handover` matches this word for word.
public enum SpawnHandover: Equatable {
    /// Agent Relay runs it and it cannot be taken over: its harness's own app
    /// opens it live where it has one (a spawned Codex thread, on the shared
    /// app server: "Open in Codex" only); it is never resumed in Terminal.
    case openLive
    /// Agent Relay runs it headless: join it here, or take it over.
    case takeOver
    /// Taken over: the person's session now, opened like any other.
    case takenOver

    public static func of(_ session: LocalSession?) -> SpawnHandover? {
        guard let spawn = session?.registration?.spawn else { return nil }
        if spawn.takenOver { return .takenOver }
        return spawn.canTakeOver ? .takeOver : .openLive
    }

    /// The agent whose own output is its transcript (`agents.transcript`);
    /// `nil` when the session's transcript is read (`sessions.transcript`).
    public static func transcriptAgent(_ session: LocalSession?) -> String? {
        of(session) == .takeOver ? session?.registration?.name : nil
    }

    /// Whether the transcript is followed live with a message box under it:
    /// a spawned agent Agent Relay still runs.
    public static func joins(_ session: LocalSession?) -> Bool {
        let handover = of(session)
        return handover == .takeOver || handover == .openLive
    }

    /// Where following continues after the last page of a read that asked
    /// for `requested`: where the page says what is written next starts, else
    /// that page again (its entries are told apart by id).
    public static func followCursor(requested: LocalTranscriptCursor?, page: LocalTranscriptPage) -> LocalTranscriptCursor? {
        page.followCursor ?? requested
    }

    /// Whether it is in the middle of a turn: taking it over then waits for the turn.
    public static func isWorking(_ agent: LocalAgent?) -> Bool {
        agent?.spawn?.work.state == .working
    }

    public static let joinTitle = "Join"
    public static let joinHelp = "Follow its transcript here and message it."
    public static let following = "Live: new output appears as the agent writes it."
    public static func composerPlaceholder(_ name: String) -> String { "Message @\(name)" }
    public static let composerNote = "Sent through Agent Relay into the running agent, like any message to it."
    public static let send = "Send"

    public static let codexHosted = "Agent Relay’s Codex app server runs this thread. Open it in Codex to watch or steer it live; it is not resumed in Terminal while Agent Relay hosts it."
    public static let codexMissing = "Install the Codex app to open this thread. Agent Relay’s Codex app server runs it, so it is not resumed in Terminal."
    public static let hosted = "Agent Relay runs this session. Follow it and message it here; it is not resumed in Terminal while Agent Relay runs it."

    /// The note beside the open button of a session Agent Relay runs that is
    /// not taken over: Codex's when it opens live in Codex (`opening`), else
    /// why it has no open button.
    public static func hostedNote(_ session: LocalSession?, opening: SessionOpening?) -> String? {
        guard of(session) == .openLive else { return nil }
        return opening?.liveOnly == true ? codexHosted : hosted
    }

    /// `Take over in Claude` (Claude Desktop) or `Take over in Terminal`.
    public static func takeOverTitle(desktop: Bool) -> String {
        desktop ? "Take over in Claude" : "Take over in Terminal"
    }
    public static let takeOverHelp = "Stop the headless agent and continue its session yourself. It keeps its name, so messages keep arriving."
    public static func confirmTitle(_ name: String) -> String { "Take over @\(name)?" }
    public static func confirmMessage(_ name: String, desktop: Bool) -> String {
        "Agent Relay stops its headless Claude, then opens the session in \(desktop ? "Claude" : "Terminal"). @\(name) keeps its name, so messages to it reach the session you open."
    }
    public static func workingMessage(_ name: String) -> String {
        "@\(name) is in the middle of a turn. Agent Relay can wait for the turn to end, or interrupt it now."
    }
    public static let takeOverButton = "Take Over"
    public static let afterTurn = "Take Over After This Turn"
    public static let interrupt = "Interrupt and Take Over"
    public static let cancel = "Cancel"
    public static func waiting(_ name: String) -> String { "Waiting for @\(name) to finish its turn…" }
    public static let interruptNow = "Interrupt Now"
    public static func interruptTitle(_ name: String) -> String { "Interrupt @\(name) now?" }
    public static let interruptMessage = "The turn it is running stops where it is. The session you open has everything up to there."
    public static let stopping = "Stopping the headless agent…"
    public static func takenOver(_ name: String) -> String {
        "Taken over: this session is yours now. Messages to @\(name) reach it while it runs."
    }
    public static let failedTitle = "Couldn’t take over"
    /// The session's folder is unknown, so it cannot be opened for the person.
    public static func noFolder(_ id: String) -> String {
        "Agent Relay stopped the headless agent, but its folder is unknown. Resume it yourself with claude --resume \(id)."
    }
}
