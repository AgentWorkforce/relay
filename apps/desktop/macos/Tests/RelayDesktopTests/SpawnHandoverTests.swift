import XCTest
@testable import RelayDesktopCore

/// The Linux app's `models::spawn_handover` tests pin the same behavior and
/// wording.
final class SpawnHandoverTests: XCTestCase {
    private func session(_ kind: SessionKind, spawn: SessionSpawn?, directory: String? = "/work/api") -> LocalSession {
        LocalSession(directory: directory, live: true,
                     registration: SessionRegistration(addedBySession: false, address: "c1@desk-desktop", name: "c1", spawn: spawn),
                     suggestedName: "c1", target: Target(id: "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d", kind: kind), title: "Fix CI")
    }

    private func row(_ session: LocalSession) -> LocalSessionRow {
        LocalSessionRow.mergeUnsorted(uploads: [], sessions: [session])[0]
    }

    private let headless = SessionSpawn(canTakeOver: true, harness: "claude", takenOver: false)
    private let taken = SessionSpawn(canTakeOver: false, harness: "claude", takenOver: true)
    private let codex = SessionSpawn(canTakeOver: false, harness: "codex", takenOver: false)
    private let grok = SessionSpawn(canTakeOver: false, harness: "grok", takenOver: false)

    func testWhatIsOfferedFollowsTheCore() {
        XCTAssertNil(SpawnHandover.of(session(.claudeTerminal, spawn: nil)))
        XCTAssertEqual(SpawnHandover.of(session(.claudeTerminal, spawn: headless)), .takeOver)
        XCTAssertEqual(SpawnHandover.of(session(.claudeTerminal, spawn: taken)), .takenOver)
        XCTAssertEqual(SpawnHandover.of(session(.codex, spawn: codex)), .openLive)
        XCTAssertEqual(SpawnHandover.transcriptAgent(session(.claudeTerminal, spawn: headless)), "c1")
        XCTAssertNil(SpawnHandover.transcriptAgent(session(.claudeTerminal, spawn: taken)))
        XCTAssertNil(SpawnHandover.transcriptAgent(session(.codex, spawn: codex)))
        XCTAssertTrue(SpawnHandover.joins(session(.claudeTerminal, spawn: headless)))
        XCTAssertTrue(SpawnHandover.joins(session(.codex, spawn: codex)))
        XCTAssertFalse(SpawnHandover.joins(session(.claudeTerminal, spawn: taken)))
        XCTAssertFalse(SpawnHandover.joins(nil))
    }

    func testAHeadlessClaudeIsTakenOverNeverResumedBesideIt() throws {
        XCTAssertNil(SessionOpening(row: row(session(.claudeTerminal, spawn: headless))))
        let resumed = try XCTUnwrap(SessionOpening(row: row(session(.claudeTerminal, spawn: taken))))
        XCTAssertEqual(resumed.command, "cd -- '/work/api' && claude --resume '0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d'")
        // A newer read of the session wins over the row's.
        let stale = row(session(.claudeTerminal, spawn: headless))
        XCTAssertNotNil(SessionOpening(row: stale, relay: session(.claudeTerminal, spawn: taken)))
        XCTAssertNil(SessionOpening(row: row(session(.claudeTerminal, spawn: taken)), relay: session(.claudeTerminal, spawn: headless)))
    }

    func testASpawnedCodexThreadOpensOnlyLiveInCodex() throws {
        let action = try XCTUnwrap(SessionOpening(row: row(session(.codex, spawn: codex))))
        XCTAssertTrue(action.liveOnly)
        XCTAssertNil(action.command)
        XCTAssertNil(action.desktopCommand)
        XCTAssertEqual(action.title, "Open in Codex")
        XCTAssertEqual(action.deepLink?.absoluteString, "codex://threads/0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d")
        XCTAssertEqual(action.destination(preference: .terminal, desktopAvailable: true), .desktop)
        XCTAssertEqual(action.destination(preference: .automatic, desktopAvailable: false), .unavailable)
        let own = try XCTUnwrap(SessionOpening(row: row(session(.codex, spawn: nil))))
        XCTAssertFalse(own.liveOnly)
        XCTAssertNotNil(own.command)
    }

    func testAHostedSessionWithoutALiveAppIsNeverResumedBesideIt() throws {
        let hosted = session(.grok, spawn: grok)
        XCTAssertEqual(SpawnHandover.of(hosted), .openLive)
        XCTAssertTrue(SpawnHandover.joins(hosted))
        XCTAssertNil(SessionOpening(row: row(hosted)))
        XCTAssertEqual(SpawnHandover.hostedNote(hosted, opening: SessionOpening(row: row(hosted))), SpawnHandover.hosted)
        let own = try XCTUnwrap(SessionOpening(row: row(session(.grok, spawn: nil))))
        XCTAssertEqual(own.command, "cd -- '/work/api' && grok --resume '0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d'")
        let thread = session(.codex, spawn: codex)
        XCTAssertEqual(SpawnHandover.hostedNote(thread, opening: SessionOpening(row: row(thread))), SpawnHandover.codexHosted)
        XCTAssertNil(SpawnHandover.hostedNote(session(.claudeTerminal, spawn: headless), opening: nil))
        let yours = session(.claudeTerminal, spawn: taken)
        XCTAssertNil(SpawnHandover.hostedNote(yours, opening: SessionOpening(row: row(yours))))
        XCTAssertNil(SpawnHandover.hostedNote(session(.grok, spawn: nil), opening: own))
    }

    func testFollowingContinuesWhereThePageSaysOrRereadsIt() {
        let from = LocalTranscriptCursor(id: 10, tsMs: 0)
        let follow = LocalTranscriptCursor(id: 42, tsMs: 0)
        XCTAssertEqual(SpawnHandover.followCursor(requested: from, page: LocalTranscriptPage(entries: [], followCursor: follow)), follow)
        XCTAssertEqual(SpawnHandover.followCursor(requested: from, page: LocalTranscriptPage(entries: [])), from)
        XCTAssertNil(SpawnHandover.followCursor(requested: nil, page: LocalTranscriptPage(entries: [])))
    }

    func testWording() {
        XCTAssertEqual(SpawnHandover.takeOverTitle(desktop: true), "Take over in Claude")
        XCTAssertEqual(SpawnHandover.takeOverTitle(desktop: false), "Take over in Terminal")
        XCTAssertEqual(SpawnHandover.confirmTitle("c1"), "Take over @c1?")
        XCTAssertEqual(SpawnHandover.confirmMessage("c1", desktop: false),
                       "Agent Relay stops its headless Claude, then opens the session in Terminal. @c1 keeps its name, so messages to it reach the session you open.")
        XCTAssertEqual(SpawnHandover.workingMessage("c1"),
                       "@c1 is in the middle of a turn. Agent Relay can wait for the turn to end, or interrupt it now.")
        XCTAssertEqual(SpawnHandover.waiting("c1"), "Waiting for @c1 to finish its turn…")
        XCTAssertEqual(SpawnHandover.interruptTitle("c1"), "Interrupt @c1 now?")
        XCTAssertEqual(SpawnHandover.interruptMessage,
                       "The turn it is running stops where it is. The session you open has everything up to there.")
        XCTAssertEqual(SpawnHandover.afterTurn, "Take Over After This Turn")
        XCTAssertEqual(SpawnHandover.interrupt, "Interrupt and Take Over")
        XCTAssertEqual(SpawnHandover.codexHosted,
                       "Agent Relay’s Codex app server runs this thread. Open it in Codex to watch or steer it live; it is not resumed in Terminal while Agent Relay hosts it.")
        XCTAssertEqual(SpawnHandover.hosted,
                       "Agent Relay runs this session. Follow it and message it here; it is not resumed in Terminal while Agent Relay runs it.")
        XCTAssertEqual(SpawnHandover.takenOver("c1"), "Taken over: this session is yours now. Messages to @c1 reach it while it runs.")
        XCTAssertEqual(SpawnHandover.composerPlaceholder("c1"), "Message @c1")
        XCTAssertEqual(SpawnHandover.noFolder("abc"),
                       "Agent Relay stopped the headless agent, but its folder is unknown. Resume it yourself with claude --resume abc.")
    }
}
