import SwiftUI
import RelayDesktopCore

struct SessionTitlePresentation: Equatable {
    let title: String
    var supported: Bool? = nil
    var reason: String? = nil
    var generatedTitle: String? = nil
    var saving = false
    var error: String? = nil
    var preloadRevision = 0
}

/// Only the session header edits native titles. The field shares the title's
/// baseline; actions occupy a fixed lane so editing never moves the subtitle.
struct SessionTitleEditor: View {
    let state: SessionTitlePresentation
    var preload: () -> Void = {}
    var save: (String) -> Void = { _ in }
    // Keep the grace period in production; tests can suspend and release this
    // wait explicitly rather than racing the main actor against wall-clock time.
    var waitForBlur: @Sendable () async throws -> Void = {
        try await Task.sleep(for: .milliseconds(150))
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editing = false
    @State private var draft = ""
    @State private var original = ""
    @State private var submittedDraft: String?
    @State private var submissionStarted = false
    @State private var blurAllowed = false
    @State private var blurTask: Task<Void, Never>?
    @State private var blurRevision = 0
    private enum Control: Hashable { case title, generated, done, cancel, rename }
    @FocusState private var focus: Control?

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .leading) {
                Text(state.title).lineLimit(1).help(state.title)
                    .opacity(editing ? 0 : 1).accessibilityHidden(editing)
                if editing {
                    TextField("Session title", text: Binding(get: { draft }, set: {
                        if draft != $0 {
                            draft = $0
                            blurAllowed = true
                        }
                    }))
                    .textFieldStyle(.plain).focused($focus, equals: .title)
                    .onSubmit { commit() }.accessibilityLabel("Session title")
                }
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(CloudTheme.foreground)
            .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
            HStack(spacing: 6) {
                if let error = state.error {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 12)).foregroundStyle(CloudTheme.warning)
                        .help(error).accessibilityLabel(error)
                }
                if editing {
                    if state.generatedTitle != nil {
                        Button(action: useGeneratedTitle) {
                            Image(systemName: "sparkles").frame(width: 24, height: 24)
                        }.focusable().focused($focus, equals: .generated)
                            .help("Use generated title").accessibilityLabel("Use generated title")
                    }
                    Button("Done") { commit() }
                        .focusable().focused($focus, equals: .done).help("Save title")
                        .disabled(state.supported != true || state.saving)
                    Button("Cancel") { cancel() }
                        .focusable().focused($focus, equals: .cancel).help("Cancel editing")
                } else if state.saving {
                    ProgressView().controlSize(.mini).help("Saving title…")
                } else {
                    Button(action: begin) {
                        Label("Rename", systemImage: "square.and.pencil")
                    }.focusable().focused($focus, equals: .rename)
                        .disabled(state.supported != true)
                        .help(state.reason ?? "Rename session")
                        .accessibilityLabel("Rename session")
                }
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(CloudTheme.secondary).buttonStyle(.plain).actionCursor()
            .frame(width: 160, height: 24, alignment: .trailing)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.12), value: editing)
        }
        .frame(height: 24)
        .background(SessionTitleFocusBoundary(inside: cancelBlur, outside: {
            scheduleBlur(checkFocus: false)
        }))
        .onExitCommand { cancel() }
        .onAppear(perform: preload)
        .onDisappear { cancelBlur() }
        .onChange(of: state.preloadRevision) { _ in preload() }
        .onChange(of: focus) { next in
            if next == nil { scheduleBlur(checkFocus: true) } else { cancelBlur() }
        }
        .onChange(of: state.supported) { supported in
            // A delayed commit captures the previous presentation, including capability.
            // Retire it during reconnect without discarding the editable draft.
            if supported != true { cancelBlur() }
            if supported == false { cancel(restoreFocus: false) }
        }
        .onChange(of: state) { next in
            guard let submittedDraft else { return }
            if next.saving {
                submissionStarted = true
            } else if next.error != nil {
                cancelBlur()
                draft = submittedDraft
                original = next.title
                self.submittedDraft = nil
                submissionStarted = false
                blurAllowed = false // A rejected draft only retries after a deliberate edit or Done.
                editing = next.supported == true
                focus = editing ? .title : nil
            } else if submissionStarted || next.title == submittedDraft {
                self.submittedDraft = nil
                submissionStarted = false
            }
        }
    }

    private func begin() {
        guard state.supported == true, !state.saving else { return }
        cancelBlur()
        submittedDraft = nil
        submissionStarted = false
        original = state.title
        draft = state.title
        blurAllowed = true
        editing = true
        focus = .title
    }

    private func useGeneratedTitle() {
        cancelBlur()
        if let generated = state.generatedTitle {
            draft = generated
            blurAllowed = true
            focus = .title
        }
    }

    private func commit(restoreFocus: Bool = true) {
        guard editing, state.supported == true, !state.saving else { return }
        let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let changed = !title.isEmpty && title != original && title != state.title
        cancelBlur()
        editing = false
        focus = restoreFocus ? .rename : nil
        blurAllowed = false
        guard changed else { return }
        submittedDraft = title
        submissionStarted = false
        save(title)
    }

    private func cancel(restoreFocus: Bool = true) {
        cancelBlur()
        editing = false
        focus = restoreFocus ? .rename : nil
        blurAllowed = false
        submittedDraft = nil
        submissionStarted = false
    }

    private func cancelBlur() {
        blurRevision += 1
        blurTask?.cancel()
        blurTask = nil
    }

    private func scheduleBlur(checkFocus: Bool) {
        guard editing, blurAllowed else { return }
        cancelBlur()
        let revision = blurRevision
        blurTask = Task { @MainActor in
            try? await waitForBlur()
            guard !Task.isCancelled, revision == blurRevision, editing,
                  !checkFocus || focus == nil else { return }
            commit(restoreFocus: false)
        }
    }
}
