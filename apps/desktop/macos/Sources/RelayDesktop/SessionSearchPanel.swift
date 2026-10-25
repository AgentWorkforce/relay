import AppKit
import SwiftUI
import RelayDesktopCore

/// One query powers typed search and the suggested filters.
struct SessionSearchPanel: View {
    @Binding var text: String
    let harnesses: [String]
    let projects: [String]
    let close: () -> Void
    @FocusState private var focused: Bool
    @StateObject private var navigation = SessionSearchNavigation()
    @State private var navigatingSuggestions = false
    @State private var help = false
    @State private var keyMonitor: Any?

    @StateObject private var suggestionCache = SessionSearchSuggestions()

    private var suggestionList: SessionSearchSuggestions.List {
        suggestionCache.list(text: text, harnesses: harnesses, projects: projects)
    }
    private func choose(_ option: SessionSearchSuggestions.Suggestion) {
        navigation.reset()
        text = LocalSessionQuery.suggesting(text, field: option.field, value: option.value)
        focused = true
    }
    private func moveHighlight(_ delta: Int) {
        let list = suggestionList
        let items = list.items
        guard !items.isEmpty else { navigatingSuggestions = false; navigation.reset(); return }
        navigation.move(delta, ids: list.ids, query: text)
        navigatingSuggestions = true
        // Keep a queued text-change callback from undoing subsequent arrow navigation.
        navigation.preserve(id: items[navigation.index(in: list.ids)].id, query: text)
    }
    private func selectHighlighted(_ selected: Bool) {
        let list = suggestionList
        let items = list.items
        let selection = navigation.index(in: list.ids)
        guard items.indices.contains(selection) else { return }
        let option = items[selection]
        let next = selected
            ? LocalSessionQuery.completingSuggestion(text, field: option.field, value: option.value, title: option.title)
            : LocalSessionQuery.selectingSuggestion(text, field: option.field, value: option.value, selected: false)
        navigation.preserve(id: option.id, query: next)
        if next != text { text = next }
        navigatingSuggestions = true
    }
    private func submit() {
        let list = suggestionList
        let items = list.items
        let selection = navigation.index(in: list.ids)
        if navigatingSuggestions, items.indices.contains(selection) {
            let option = items[selection]
            text = LocalSessionQuery.completingSuggestion(text, field: option.field, value: option.value, title: option.title)
        }
        close()
    }
    var body: some View {
        let list = suggestionList
        let items = list.items
        let selection = navigation.index(in: list.ids)
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(CloudTheme.secondary)
                TextField("Search or filter sessions…", text: $text)
                    .textFieldStyle(.plain).focused($focused)
                    .onSubmit { submit() }
                Button { close() } label: {
                    Image(systemName: "xmark").frame(width: 24, height: 24)
                }
                .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 5)))
                .help("Close search").accessibilityLabel("Close search")
            }.padding(12).background(CloudTheme.background, in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(CloudTheme.ring))
                .padding(12)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        Button { close() } label: {
                            HStack { Label("Search loaded sessions", systemImage: "magnifyingglass"); Spacer(); Text("↵").foregroundStyle(CloudTheme.secondary) }
                                .padding(12).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, option in
                            VStack(alignment: .leading, spacing: 2) {
                                if index == 0 || items[index - 1].section != option.section {
                                    Divider().overlay(CloudTheme.border)
                                    Text(option.section).font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(CloudTheme.secondary).padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 6)
                                }
                                Button { choose(option) } label: {
                                    HStack(spacing: 10) {
                                        if option.field == "harness" { AgentIconView(source: option.value, size: 20) }
                                        else { Image(systemName: option.icon).frame(width: 20).foregroundStyle(CloudTheme.secondary) }
                                        Text(option.title)
                                        Spacer()
                                        Text(option.id).font(.system(size: 11, design: .monospaced)).foregroundStyle(CloudTheme.secondary)
                                        if list.selectedIDs.contains(option.id) { Image(systemName: "checkmark")
                                            .font(.system(size: 10, weight: .bold))
                                            .foregroundStyle(.white)
                                            .frame(width: 18, height: 18)
                                            .background(Color(red: 44 / 255.0, green: 106 / 255.0, blue: 156 / 255.0), in: Circle()) }
                                    }.padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
                                        .background(selection == index ? CloudTheme.hover : .clear, in: RoundedRectangle(cornerRadius: 5))
                                }.buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 5)))
                            }.id(index)
                        }
                        if items.isEmpty { Text("No filter suggestions. Press Return to search.").foregroundStyle(CloudTheme.secondary).padding(12) }
                    }.padding(.horizontal, 8)
                }.onChange(of: selection) { proxy.scrollTo($0) }
            }
            Divider().overlay(CloudTheme.border)
            if let error = list.query.error { Text(error).font(.caption).foregroundStyle(CloudTheme.warning).padding(10) }
            if help {
                Text("Combine words with harness:codex, project:cloud, is:active or upload:uploaded. Quote phrases and use - to exclude. Dates: updated:>=2026-10-01 (UTC). Search covers loaded sessions; scroll the list to load older history.")
                    .font(.caption).foregroundStyle(CloudTheme.secondary).padding(12)
            }
            HStack {
                Button("Search syntax tips") { help.toggle() }.buttonStyle(.plain).foregroundStyle(CloudTheme.primary)
                Spacer()
                Text("↑ ↓ navigate · → select · ← remove · ↵ choose & search").foregroundStyle(CloudTheme.secondary)
                if !text.isEmpty { Button("Clear") { text = ""; focused = true }.buttonStyle(.plain) }
            }.font(.system(size: 11)).padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).background(CloudTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(CloudTheme.border))
        .foregroundStyle(CloudTheme.foreground)
        .onAppear {
            focused = true
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty else { return event }
                switch event.keyCode {
                case 125: moveHighlight(1); return nil
                case 126: moveHighlight(-1); return nil
                case 124:
                    guard navigatingSuggestions else { return event }
                    selectHighlighted(true); return nil
                case 123:
                    guard navigatingSuggestions else { return event }
                    selectHighlighted(false); return nil
                case 36, 76:
                    guard navigatingSuggestions else { return event }
                    submit(); return nil
                case 48:
                    if event.modifierFlags.contains(.shift) { return event }
                    let list = suggestionList
                    let selection = navigation.index(in: list.ids)
                    if list.items.indices.contains(selection) { choose(list.items[selection]); return nil }
                default: break
                }
                return event
            }
        }
        .onDisappear {
            if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
            keyMonitor = nil
        }
        .onChange(of: text) { value in
            // SwiftUI may coalesce or delay query callbacks during key repeat.
            // Only the current query can reset navigation; identity survives list changes.
            guard value == text else { return }
            if !navigation.accepts(query: value) {
                navigation.reset()
                navigatingSuggestions = false
            }
        }
        .onExitCommand { close() }

    }
}

/// Keep keyboard focus tied to a filter identity, never its changing row offset.
final class SessionSearchNavigation: ObservableObject {
    @Published private(set) var highlightedID: String?
    private var keyboardQuery: String?

    func index(in ids: [String]) -> Int {
        highlightedID.flatMap { ids.firstIndex(of: $0) } ?? 0
    }
    func move(_ delta: Int, ids: [String], query: String) {
        guard !ids.isEmpty else { reset(); return }
        preserve(id: ids[max(0, min(index(in: ids) + delta, ids.count - 1))], query: query)
    }
    func preserve(id: String, query: String) {
        highlightedID = id
        keyboardQuery = query
    }
    func accepts(query: String) -> Bool { keyboardQuery == query }
    func reset() { highlightedID = nil; keyboardQuery = nil }
}
