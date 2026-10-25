import SwiftUI
import RelayDesktopCore

struct SavedSessionViewControls: View {
    @EnvironmentObject private var model: AppModel
    @State private var saving = false
    @State private var browsing = false

    private var currentView: SavedSessionView? { model.currentSavedSessionView }

    var body: some View {
        Button {
            model.showsSessionSearch = false
            saving = false
            browsing.toggle()
        } label: {
            Image(systemName: currentView == nil ? "bookmark" : "bookmark.fill")
                .font(.system(size: 15))
                .frame(width: 32, height: 32).contentShape(Rectangle())
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 5)))
        .foregroundStyle(currentView == nil ? CloudTheme.secondary : CloudTheme.primary)
        .help(currentView.map { "Saved views — " + $0.name } ?? "Saved views")
        .accessibilityLabel("Saved views")
        .accessibilityValue(currentView.map { "Saved view: " + $0.name } ?? "Unsaved view")
        .accessibilityHint("Open saved views or save the current view")
        .popover(isPresented: $browsing, arrowEdge: .bottom) {
            if saving {
                SaveSessionViewForm { browsing = false }.environmentObject(model)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Saved views").font(.headline)
                    if model.savedSessionViews.views.isEmpty {
                        Text("Save a search and table layout to use it again.")
                            .foregroundStyle(CloudTheme.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        ScrollView {
                            VStack(spacing: 4) {
                                ForEach(model.savedSessionViews.views) { view in
                                    SavedSessionViewRow(view: view) { browsing = false }
                                }
                            }
                        }.frame(maxHeight: 300)
                        Text("The default view opens when the app starts.")
                            .font(.caption).foregroundStyle(CloudTheme.secondary)
                    }
                    Button("Save current view") { saving = true }
                        .buttonStyle(AgentRelayPrimaryButtonStyle(height: 32))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }.padding(16).frame(width: 340)
                    .onExitCommand { browsing = false }
                    .environmentObject(model)
            }
        }
    }
}

struct SaveSessionViewForm: View {
    @EnvironmentObject private var model: AppModel
    let close: () -> Void
    @State private var name = ""
    @State private var makeDefault = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Save current view").font(.headline)
            Text("Keep this search, grouping, sort order, columns, and hidden-session display.")
                .font(.caption).foregroundStyle(CloudTheme.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("View name", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityLabel("View name").focused($nameFocused).onSubmit(save)
            if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.savedSessionViews.canSave(name: name) {
                Text("A view with this name already exists.").font(.caption).foregroundStyle(CloudTheme.warning)
            }
            Toggle("Make default", isOn: $makeDefault).toggleStyle(.checkbox)
                .help("Open this view when the app starts")
            HStack {
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save", action: save).keyboardShortcut(.defaultAction)
                    .buttonStyle(AgentRelayPrimaryButtonStyle(height: 32))
                    .disabled(!model.savedSessionViews.canSave(name: name))
            }
        }.padding(20).frame(width: 340).onAppear { nameFocused = true }
    }
    private func save() {
        guard model.savedSessionViews.save(name: name, configuration: model.sessionViewConfiguration, makeDefault: makeDefault) != nil else { return }
        close()
    }
}

private struct SavedSessionViewRow: View {
    @EnvironmentObject private var model: AppModel
    let view: SavedSessionView
    let close: () -> Void
    @State private var hovered = false
    @FocusState private var deleteFocused: Bool
    private var isDefault: Bool { model.savedSessionViews.defaultID == view.id }
    private var isCurrent: Bool { model.sessionViewConfiguration == view.configuration }
    var body: some View {
        HStack(spacing: 4) {
            Button { model.applySessionView(view); close() } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark").opacity(isCurrent ? 1 : 0).accessibilityHidden(true)
                    Text(view.name).lineLimit(1)
                    Spacer(minLength: 0)
                }.padding(6).contentShape(Rectangle())
            }.accessibilityLabel("Open \(view.name)")
                .accessibilityValue(isCurrent ? "Current view" : "")
                .help(view.name)
            Button { model.savedSessionViews.setDefault(isDefault ? nil : view.id) } label: {
                Image(systemName: isDefault ? "star.fill" : "star").frame(width: 28, height: 28)
            }.help(isDefault ? "Remove default" : "Make default")
                .accessibilityLabel("\(isDefault ? "Remove default" : "Make default"): \(view.name)")
                .accessibilityValue(isDefault ? "Default view" : "")
            Button { model.savedSessionViews.delete(view.id) } label: {
                Image(systemName: "xmark").frame(width: 28, height: 28)
                    .opacity(hovered || deleteFocused ? 1 : 0.6)
            }.focused($deleteFocused).help("Delete \(view.name)")
                .accessibilityLabel("Delete saved view \(view.name)")
        }.buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 5)))
            .onHover { hovered = $0 }
            .accessibilityElement(children: .contain)
    }
}
