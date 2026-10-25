import AppKit
import SwiftUI
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor private final class TitleEditorFixture: ObservableObject {
    @Published var identity = "first"
    @Published var state = SessionTitlePresentation(title: "Original title", supported: true,
        generatedTitle: "Fix session navigation")
    var saves: [(String, String)] = []
    var preloads = 0
    var waitForBlur: (@Sendable () async throws -> Void)?
    func save(_ title: String, identity: String) {
        saves.append((identity, title))
        state = SessionTitlePresentation(title: title, supported: true, saving: true)
    }
}

private final class TitleEditorTestNativeWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

private struct TitleEditorTestView: View {
    @ObservedObject var fixture: TitleEditorFixture
    @State private var outside = ""
    var body: some View {
        let identity = fixture.identity
        VStack(spacing: 0) {
            editor(identity: identity).id(identity).padding(.horizontal, 12).frame(height: 64)
            HStack {
                TextField("Elsewhere", text: $outside)
                Button("Elsewhere action") {}.buttonStyle(.plain).frame(width: 120)
            }.frame(height: 36)
        }.frame(width: 600, height: 100).background(CloudTheme.background)
    }

    @MainActor private func editor(identity: String) -> SessionTitleEditor {
        var editor = SessionTitleEditor(state: fixture.state, preload: { fixture.preloads += 1 },
            save: { fixture.save($0, identity: identity) })
        if let waitForBlur = fixture.waitForBlur { editor.waitForBlur = waitForBlur }
        return editor
    }
}

@MainActor private final class TitleEditorWindow {
    let fixture = TitleEditorFixture()
    let host: NSHostingView<TitleEditorTestView>
    let window: NSWindow
    init(waitForBlur: (@Sendable () async throws -> Void)? = nil) {
        fixture.waitForBlur = waitForBlur
        host = NSHostingView(rootView: TitleEditorTestView(fixture: fixture))
        window = TitleEditorTestNativeWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 100),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
    }
    func settle(_ ms: Int = 60) async throws {
        try await Task.sleep(for: .milliseconds(ms))
        host.layoutSubtreeIfNeeded()
    }
    func press(_ label: String) throws {
        let x: CGFloat
        switch label {
        case "Rename session": x = 556
        case "Use generated title": x = 499
        case "Done": x = 526
        case "Cancel": x = 570
        default: XCTFail("Unknown control: \(label)"); return
        }
        for eventType in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            window.sendEvent(NSEvent.mouseEvent(with: eventType, location: NSPoint(x: x, y: 68),
                modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0,
                clickCount: 1, pressure: eventType == .leftMouseDown ? 1 : 0)!)
        }
    }
    func begin() async throws {
        try await settle()
        try press("Rename session")
        try await settle()
        XCTAssertNotNil(window.firstResponder as? NSTextView)
    }
    func type(_ value: String) throws {
        let field = try XCTUnwrap(window.firstResponder as? NSTextView)
        field.selectAll(nil)
        field.insertText(value, replacementRange: field.selectedRange())
    }
    func key(_ characters: String, code: UInt16) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            window.sendEvent(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, characters: characters, charactersIgnoringModifiers: characters,
                isARepeat: false, keyCode: code)!)
        }
    }
    func focusOutside() throws {
        func find(_ view: NSView) -> NSTextField? {
            if let field = view as? NSTextField, field.placeholderString == "Elsewhere" { return field }
            return view.subviews.lazy.compactMap(find).first
        }
        XCTAssertTrue(window.makeFirstResponder(try XCTUnwrap(find(host))))
    }
}

@MainActor final class SessionTitleInteractionTests: XCTestCase {
    func testTypingWaitsForDeferredOutsideFocusCommitAndSubmitsOnlyOnce() async throws {
        let ui = TitleEditorWindow()
        defer { ui.window.close() }
        try await ui.begin()
        try ui.type("Edited")
        try ui.type("Edited title")
        try await ui.settle(200)
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        XCTAssertEqual(ui.fixture.preloads, 1, "Typing never performs lookups")
        try ui.focusOutside()
        try await ui.settle(50)
        XCTAssertTrue(ui.fixture.saves.isEmpty, "Focus loss has a short grace period for toolbar actions")
        try await ui.settle(180)
        XCTAssertEqual(ui.fixture.saves.map(\.1), ["Edited title"])
        try await ui.settle(200)
        XCTAssertEqual(ui.fixture.saves.count, 1)
    }

    func testGeneratedTitleAndToolbarFocusCancelPendingBlur() async throws {
        let ui = TitleEditorWindow()
        defer { ui.window.close() }
        try await ui.begin()
        try ui.type("Draft")
        try ui.focusOutside()
        try ui.press("Use generated title")
        try await ui.settle(220)
        XCTAssertEqual((ui.window.firstResponder as? NSTextView)?.string, "Fix session navigation")
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        // Tab to the suggestion control: focus remains within this editor.
        ui.key("\t", code: 48)
        try await ui.settle(220)
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        try ui.press("Done")
        try await ui.settle(220)
        XCTAssertEqual(ui.fixture.saves.map(\.1), ["Fix session navigation"])
    }

    func testCancelEscapeEmptyAndUnchangedDraftsNeverWrite() async throws {
        let ui = TitleEditorWindow()
        defer { ui.window.close() }
        try await ui.begin()
        ui.key("\r", code: 36)
        try await ui.settle()
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        try await ui.begin()
        try ui.type("   ")
        try ui.press("Done")
        try await ui.settle()
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        try await ui.begin()
        try ui.type("Discard with Escape")
        ui.key("\u{1b}", code: 53)
        try await ui.settle(200)
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        try await ui.begin()
        try ui.type("Discard after blur")
        try ui.focusOutside()
        try ui.press("Cancel")
        try await ui.settle(220)
        XCTAssertTrue(ui.fixture.saves.isEmpty)
    }

    func testFailedDraftReopensWithoutAutomaticRetryAndCanBeCorrected() async throws {
        let ui = TitleEditorWindow()
        defer { ui.window.close() }
        try await ui.begin()
        try ui.type("Rejected draft")
        try ui.press("Done")
        try await ui.settle()
        ui.fixture.state = SessionTitlePresentation(title: "Original title", supported: true, error: "Could not save title")
        try await ui.settle()
        XCTAssertEqual((ui.window.firstResponder as? NSTextView)?.string, "Rejected draft")
        try ui.focusOutside()
        try await ui.settle(220)
        XCTAssertEqual(ui.fixture.saves.map(\.1), ["Rejected draft"], "A reopened error never retries itself")
        // Done is still an intentional retry even without further typing.
        try ui.press("Done")
        try await ui.settle()
        XCTAssertEqual(ui.fixture.saves.map(\.1), ["Rejected draft", "Rejected draft"])
    }

    func testOutsidePlainButtonClickCommitsWithoutTakingItsFocus() async throws {
        let gate = TitleBlurWaitGate()
        let ui = TitleEditorWindow(waitForBlur: { await gate.wait() })
        defer { gate.releaseAll(); ui.window.close() }
        try await ui.begin()
        try ui.type("Click away title")
        let titleField = try XCTUnwrap(ui.window.firstResponder as? NSTextView)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            NSApp.sendEvent(NSEvent.mouseEvent(with: type, location: NSPoint(x: 550, y: 18),
                modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: ui.window.windowNumber, context: nil, eventNumber: 0,
                clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!)
        }
        let scheduled = await eventually {
            ui.host.layoutSubtreeIfNeeded()
            return gate.liveWaitIDs.count == 1
        }
        XCTAssertTrue(scheduled, "The outside mouse event must schedule a live deferred commit")
        let pending = try XCTUnwrap(gate.liveWaitIDs.first)
        XCTAssertTrue(ui.window.firstResponder === titleField, "A plain outside button need not take the title field's focus")
        XCTAssertTrue(ui.fixture.saves.isEmpty, "The outside click respects the deferred-commit boundary")
        gate.release(pending)
        let committed = await eventually {
            ui.host.layoutSubtreeIfNeeded()
            return gate.finishedWaits.contains(pending) && ui.fixture.saves.count == 1
        }
        XCTAssertTrue(committed, "Releasing the outside-click task must commit without needing focus loss")
        XCTAssertFalse(gate.cancelledWaits.contains(pending))
        XCTAssertEqual(ui.fixture.saves.map(\.1), ["Click away title"])
    }

    func testEscapeDiscardsDraftBeforeRenamingAgain() async throws {
        let ui = TitleEditorWindow()
        defer { ui.window.close() }
        try await ui.begin()
        try ui.type("Discard")
        ui.key("\u{1b}", code: 53)
        try await ui.settle(200)
        XCTAssertFalse(ui.window.firstResponder is NSTextView)
        try ui.press("Rename session")
        try await ui.settle()
        XCTAssertEqual((ui.window.firstResponder as? NSTextView)?.string, "Original title")
        XCTAssertTrue(ui.fixture.saves.isEmpty)
    }

    func testCapabilityReloadKeepsDraftUntilNativeRenameIsAvailable() async throws {
        let ui = TitleEditorWindow()
        defer { ui.window.close() }
        try await ui.begin()
        try ui.type("Keep through reconnect")
        ui.fixture.state.supported = nil
        try await ui.settle()
        ui.key("\r", code: 36)
        try ui.focusOutside()
        try await ui.settle(220)
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        ui.fixture.state.supported = true
        try await ui.settle()
        try ui.press("Done")
        try await ui.settle()
        XCTAssertEqual(ui.fixture.saves.map(\.1), ["Keep through reconnect"])
    }

    func testCapabilityReloadCancelsAlreadyScheduledBlurAndPreservesDraft() async throws {
        let gate = TitleBlurWaitGate()
        let ui = TitleEditorWindow(waitForBlur: { await gate.wait() })
        defer { gate.releaseAll(); ui.window.close() }
        try await ui.begin()
        try ui.type("Keep pending draft")
        try ui.focusOutside()
        let scheduled = await eventually {
            // Flush native focus updates while the deferred action is held.
            ui.host.layoutSubtreeIfNeeded()
            return gate.liveWaitIDs.count == 1
        }
        XCTAssertTrue(scheduled, "A live blur task must be suspended before reconnect begins")
        let pending = try XCTUnwrap(gate.liveWaitIDs.first)
        XCTAssertFalse(gate.isCancelled(pending))
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        ui.fixture.state.supported = nil
        let capabilityInvalidated = await eventually {
            // Layout can return before SwiftUI dispatches onChange. Keep the
            // deferred action suspended until its cancellation is observed.
            ui.host.layoutSubtreeIfNeeded()
            return gate.isCancelled(pending)
        }
        XCTAssertTrue(capabilityInvalidated, "The rendered capability change must cancel that live task")
        gate.release(pending)
        let finished = await eventually { gate.finishedWaits.contains(pending) }
        XCTAssertTrue(finished)
        XCTAssertTrue(gate.cancelledWaits.contains(pending), "The canceled blur must stay canceled when resumed")
        XCTAssertTrue(ui.fixture.saves.isEmpty, "Reconnect cancels the save scheduled with old capabilities")
        ui.fixture.state.supported = true
        try await ui.settle()
        try ui.press("Done")
        try await ui.settle()
        XCTAssertEqual(ui.fixture.saves.map(\.1), ["Keep pending draft"])
    }

    func testChangingSessionCancelsPendingBlurAndDoesNotReuseDraft() async throws {
        let ui = TitleEditorWindow()
        defer { ui.window.close() }
        try await ui.begin()
        try ui.type("Only for first session")
        try ui.focusOutside()
        ui.fixture.identity = "second"
        ui.fixture.state = SessionTitlePresentation(title: "Second session", supported: true)
        try await ui.settle(220)
        XCTAssertTrue(ui.fixture.saves.isEmpty)
        try await ui.begin()
        XCTAssertEqual((ui.window.firstResponder as? NSTextView)?.string, "Second session")
    }
}

/// Holds the production async boundary without relying on timer ordering.
@MainActor
private final class TitleBlurWaitGate {
    private var nextID = 0
    private var waits: [Int: TitleBlurWait] = [:]
    private var continuations: [Int: CheckedContinuation<Void, Never>] = [:]
    private(set) var finishedWaits: Set<Int> = []
    private(set) var cancelledWaits: Set<Int> = []
    var liveWaitIDs: [Int] { continuations.keys.filter { !isCancelled($0) }.sorted() }

    func wait() async {
        guard !Task.isCancelled else { return }
        let id = nextID
        nextID += 1
        let wait = TitleBlurWait()
        waits[id] = wait
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuations[id] = $0 }
        } onCancel: {
            wait.cancel()
        }
        finishedWaits.insert(id)
        if Task.isCancelled { cancelledWaits.insert(id) }
    }

    func isCancelled(_ id: Int) -> Bool { waits[id]?.isCancelled == true }

    func release(_ id: Int) {
        continuations.removeValue(forKey: id)?.resume()
    }

    func releaseAll() {
        let pending = Array(continuations.keys)
        for id in pending { release(id) }
    }
}

/// Cancellation handlers run synchronously on the canceling task's executor.
/// Keep their signal independent of another main-actor task being scheduled.
private final class TitleBlurWait: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }
}
