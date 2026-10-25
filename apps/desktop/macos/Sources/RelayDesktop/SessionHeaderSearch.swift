import AppKit
import SwiftUI
import RelayDesktopCore

/// The same search control lives in the global header across session views.
struct SessionHeaderSearch: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var relay: RelayModel
    private var showsFilters: Bool {
        get { model.showsSessionSearch }
        nonmutating set { model.showsSessionSearch = newValue }
    }
    @State private var searchShortcut: Any?
    private var query: LocalSessionQuery { LocalSessionQuery(model.sessionSearch) }
    private func clearSearch() { model.sessionSearch = "" }

    var body: some View {
        let query = self.query
        HStack(spacing: 10) {
            Button { showsFilters = true } label: {
                Image(systemName: "magnifyingglass").frame(width: 20, height: 26)
            }.buttonStyle(.plain).accessibilityLabel("Search and filter sessions")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(query.terms.enumerated()).filter { $0.element.field != nil }, id: \.offset) { index, term in
                        HStack(spacing: 6) {
                            Text(term.displayTitle).lineLimit(1)
                            Button { model.sessionSearch = query.removingTerm(at: index) } label: {
                                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                                    .frame(width: 18, height: 20).contentShape(Rectangle())
                            }
                            .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 3)))
                            .help("Remove " + term.displayTitle).accessibilityLabel("Remove " + term.displayTitle)
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: SearchBarRemoveBounds.self,
                                    value: [geometry.frame(in: .named("sessionSearchBar"))])
                            })
                        }.font(.system(size: 11)).padding(.leading, 8).padding(.trailing, 4).padding(.vertical, 3)
                            .background(CloudTheme.muted, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(CloudTheme.border))
                    }
                    Button { showsFilters = true } label: {
                        let words = query.terms.filter { $0.field == nil }.map(\.raw).joined(separator: " ")
                        Text(words.isEmpty ? (query.terms.isEmpty ? "Search or filter sessions…" : "Add filters…") : words)
                            .lineLimit(1).padding(.horizontal, 4).frame(minHeight: 26)
                    }.buttonStyle(.plain).keyboardShortcut("f", modifiers: .command)
                }
            }.frame(maxWidth: .infinity).frame(height: 28)
            if !model.sessionSearch.isEmpty {
                Button(action: clearSearch) {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 15)).frame(width: 24, height: 26)
                }.buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 5)))
                    .help("clear search").accessibilityLabel("Clear search and filters")
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: SearchBarRemoveBounds.self,
                            value: [geometry.frame(in: .named("sessionSearchBar"))])
                    })
            }
            Button { showsFilters = true } label: {
                Text("/").font(.system(size: 11, design: .monospaced))
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(CloudTheme.border))
            }.buttonStyle(.plain).help("Search and filter sessions (/ or ⌘F)")
        }
        .foregroundStyle(CloudTheme.secondary)
        .padding(.horizontal, 14).padding(.vertical, 9)
        .frame(minWidth: 250, maxWidth: .infinity)
        .background(CloudTheme.background, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(showsFilters ? CloudTheme.input : CloudTheme.border))
        .coordinateSpace(name: "sessionSearchBar")
        .backgroundPreferenceValue(SearchBarRemoveBounds.self) { exclusions in
            SearchBarClickRouter(exclusions: exclusions) { showsFilters = true }
        }
        .actionCursor()
        .background {
            AnchoredSearchPanel(presented: $model.showsSessionSearch) {
            let source = model.sessionSearchSource.rows(model: model, relay: relay)
            return SessionSearchPanel(text: $model.sessionSearch,
                harnesses: source.harnesses,
                projects: source.projects,
                close: { showsFilters = false })
            }
        }
        .onAppear {
            searchShortcut = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                guard event.characters == "/", event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
                      !showsFilters, !(NSApp.keyWindow?.firstResponder is NSTextView),
                      !(NSApp.keyWindow?.firstResponder is NSTextField) else { return event }
                showsFilters = true
                return nil
            }
        }
        .onDisappear {
            model.showsSessionSearch = false
            if let searchShortcut { NSEvent.removeMonitor(searchShortcut) }
            searchShortcut = nil
        }
    }
}
