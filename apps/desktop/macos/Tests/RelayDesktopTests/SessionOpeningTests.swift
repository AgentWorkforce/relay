import XCTest
@testable import RelayDesktopCore
@testable import RelayDesktop

final class SessionOpeningTests: XCTestCase {
    private func row(_ source: String, id: String = "session-id", cwd: String? = "/work/my repo") -> LocalSessionRow {
        LocalSessionRow.merge(uploads: [UploadSession(cwd: cwd, included: false, isAgent: false,
            sessionId: id, source: source, status: .notShared, title: "Session")], sessions: [])[0]
    }

    func testResumesExactSessionInItsDirectory() {
        for (source, cli) in [("codex", "codex resume"), ("claude", "claude --resume"), ("grok", "grok --resume")] {
            XCTAssertEqual(SessionOpening(row: row(source))?.command, "cd -- '/work/my repo' && \(cli) 'session-id'")
        }
        XCTAssertEqual(SessionOpening(row: row("codex", id: "thread/id", cwd: nil))?.deepLink?.absoluteString,
            "codex://threads/thread%2Fid")
    }

    func testClaudeDesktopHandoffKeepsTerminalFallback() {
        let action = SessionOpening(row: row("claude", id: "session-id", cwd: "/work/my repo"))
        XCTAssertEqual(action?.title, "Open in Claude")
        XCTAssertEqual(action?.desktopCommand, "cd -- '/work/my repo' && exec claude --desktop --resume 'session-id'")
        XCTAssertEqual(action?.command, "cd -- '/work/my repo' && claude --resume 'session-id'")
        XCTAssertNil(SessionOpening(row: row("grok"))?.desktopCommand)
        XCTAssertNil(SessionOpening(row: row("codex"))?.desktopCommand)
    }

    /// A Claude Code session discovery lists, with what holds it.
    private func heldSession(_ holder: SessionHolder?, running: Bool = true) -> LocalSession {
        LocalSession(directory: "/work/my repo", holder: holder, live: true, running: running,
            suggestedName: "my-repo", target: Target(id: "session-id", kind: .claudeTerminal), title: "Session")
    }

    private func opening(_ session: LocalSession?) -> SessionOpening? {
        let row = LocalSessionRow.merge(uploads: [], sessions: [heldSession(nil)])[0]
        return SessionOpening(row: row, relay: session)
    }

    /// Claude Code refuses `--desktop --resume` while anything holds the
    /// session, so the handoff is never offered for a held one; a person's
    /// terminal still resumes beside them, a headless process does not.
    func testHeldSessionIsNotOfferedTheDesktopHandoff() throws {
        let interactive = try XCTUnwrap(opening(heldSession(.interactive)))
        XCTAssertNil(interactive.desktopCommand)
        XCTAssertEqual(interactive.title, "Open in Terminal")
        XCTAssertEqual(interactive.command, "cd -- '/work/my repo' && claude --resume 'session-id'")
        XCTAssertEqual(interactive.destination(preference: .automatic, desktopAvailable: true), .terminal)

        XCTAssertNil(opening(heldSession(.background)))

        // A holder a newer core names: no handoff, and no advice invented.
        let unknown = try XCTUnwrap(opening(heldSession(.unknown("worktree"))))
        XCTAssertNil(unknown.desktopCommand)
        XCTAssertNotNil(unknown.command)

        let free = try XCTUnwrap(opening(heldSession(nil)))
        XCTAssertEqual(free.desktopCommand, "cd -- '/work/my repo' && exec claude --desktop --resume 'session-id'")
        XCTAssertEqual(free.destination(preference: .automatic, desktopAvailable: true), .desktop)
    }

    /// A session that has ended, and one discovery no longer lists, hold
    /// nothing: the row's own copy of them is from when it was built.
    func testASessionThatEndedHoldsNothing() throws {
        for ended in [heldSession(.background, running: false), nil] {
            let opened = try XCTUnwrap(opening(ended))
            XCTAssertNotNil(opened.desktopCommand)
            XCTAssertNil(SessionOpening.heldNote(ended))
        }
    }

    func testHeldNoteSaysWhatStillWorks() {
        XCTAssertEqual(SessionOpening.heldNote(heldSession(.interactive)),
            SessionOpening.interactiveHolderNote)
        XCTAssertEqual(SessionOpening.heldNote(heldSession(.background)),
            SessionOpening.backgroundHolderNote)
        XCTAssertNil(SessionOpening.heldNote(heldSession(.unknown("worktree"))))
        XCTAssertNil(SessionOpening.heldNote(heldSession(nil)))
    }

    /// The CLI's own refusal, when a holder takes the session between the
    /// check and the launch, is reported as the note rather than a line
    /// naming the session id. Unrecognised wording passes through.
    func testDesktopFailureReportsALateHolderAsItsNote() {
        XCTAssertEqual(SessionOpening.desktopFailure(
            "Session 0b1e is open in another terminal. Run /desktop there instead."),
            SessionOpening.interactiveHolderNote)
        XCTAssertEqual(SessionOpening.desktopFailure(
            "That session is running in the background (job_7). Run `claude attach job_7`."),
            SessionOpening.backgroundHolderNote)
        XCTAssertEqual(SessionOpening.desktopFailure("Claude Desktop 1.0 is too old."),
            "Claude Desktop 1.0 is too old. Use Open in Terminal as an alternative.")
        XCTAssertEqual(SessionOpening.desktopFailure(""),
            "Claude Desktop could not open this session. Use Open in Terminal as an alternative.")
    }

    func testDesktopLauncherReportsFailureAndAcceptsSuccess() async {
        let failure = await SessionOpenButton.launchDesktop("printf '%s' 'Session is still running' >&2; exit 1")
        XCTAssertTrue(failure?.contains("Session is still running") == true)
        let success = await SessionOpenButton.launchDesktop("exit 0")
        XCTAssertNil(success)
    }

    func testDesktopHandoffHasTerminalOnAllStreams() async {
        let failure = await SessionOpenButton.launchDesktop("if test -t 0 && test -t 1 && test -t 2; then exit 0; else printf 'redirected output is not supported'; exit 1; fi")
        XCTAssertNil(failure)
    }

    func testDesktopHandoffTimesOutWithoutLeavingLauncherRunning() async {
        let start = Date()
        let failure = await SessionDesktopLauncher.launch("exec /bin/sleep 30", timeout: 1)
        XCTAssertTrue(failure?.contains("didn’t respond in time") == true)
        XCTAssertLessThan(Date().timeIntervalSince(start), 6)
    }

    func testOpeningPreferenceAndMissingAppChooseTerminal() throws {
        for source in ["claude", "codex"] {
            let action = try XCTUnwrap(SessionOpening(row: row(source)))
            XCTAssertEqual(action.destination(preference: .automatic, desktopAvailable: true), .desktop)
            XCTAssertEqual(action.destination(preference: .automatic, desktopAvailable: false), .terminal)
            XCTAssertEqual(action.destination(preference: .terminal, desktopAvailable: true), .terminal)
        }
        let noDirectory = try XCTUnwrap(SessionOpening(row: row("codex", cwd: nil)))
        XCTAssertEqual(noDirectory.destination(preference: .automatic, desktopAvailable: false), .unavailable)
        XCTAssertEqual(noDirectory.destination(preference: .automatic, desktopAvailable: true), .desktop)
    }

    func testDoesNotResumeUnknownSourcesMissingDirectoriesOrOptionIDs() {
        XCTAssertNil(SessionOpening(row: row("claude", cwd: nil)))
        XCTAssertNil(SessionOpening(row: row("grok", cwd: "relative")))
        XCTAssertNil(SessionOpening(row: row("unknown")))
        for id in ["", "--help", "id\ncommand", "id\0"] {
            XCTAssertNil(SessionOpening(row: row("codex", id: id)))
        }
        let cloud = LocalSession(directory: "/repo", live: true, suggestedName: "cloud",
            target: Target(id: "session", kind: .claudeCloud), title: "Cloud session")
        XCTAssertNil(SessionOpening(row: LocalSessionRow.merge(uploads: [], sessions: [cloud])[0]))
    }

    func testShellMetacharactersStayLiteral() {
        let action = SessionOpening(row: row("grok", id: "id'$(touch BAD)", cwd: "/repo's `name`"))
        XCTAssertEqual(action?.command, "cd -- '/repo'\"'\"'s `name`' && grok --resume 'id'\"'\"'$(touch BAD)'")
    }

    func testShellReceivesUnmodifiedArgument() throws {
        let value = "repo's $(printf EXPANDED) `printf EXPANDED`; echo unexpected"
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "printf %s \(SessionOpening.quote(value))"]
        process.standardOutput = output
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8), value)
    }

}
