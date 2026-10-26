import AppKit
import SwiftUI
import RelayDesktopCore

struct LocalSessionCountPreference: PreferenceKey {
    static var defaultValue: Int? = nil
    static func reduce(value: inout Int?, nextValue: () -> Int?) { value = nextValue() ?? value }
}

/// The Cloud session table's visual hierarchy, scoped to this machine.
struct LocalSessionsView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var relay: RelayModel
    @StateObject private var results = SessionSearchProjection()
    private var sort: LocalSessionSort { model.sessionSort }
    @State private var hoveredSortColumn: LocalSessionSortColumn?
    @State private var resizingColumns: SessionColumnLayout?
    private var columns: SessionColumnLayout { resizingColumns ?? model.sessionColumns }
    @State private var collapsedGroups: Set<String> = []
    // The last end-of-list measurement and the results generation it was laid
    // out for. A measurement from an earlier generation (the empty list before
    // the first results commit) must not page in older sessions.
    @State private var listEnd = SessionListEndSignal()
    @State private var selection: Set<String> = []
    @State private var deletionKeys: [String] = []
    @State private var deletionRevision = 0
    @State private var confirmsDeletion = false

    private var allRows: [LocalSessionRow] { results.sourceRows }
    private var query: LocalSessionQuery { LocalSessionQuery(model.sessionSearch) }
    private var rows: [LocalSessionRow] { results.rows }

    private func scheduleResults(immediate: Bool = false) {
        results.schedule(delay: immediate ? 0 : 80_000_000) {
            let source = model.sessionSearchSource.snapshot(model: model, relay: relay)
            return SessionSearchSnapshot(source: source, query: model.sessionSearch, sort: sort,
                grouping: model.sessionGrouping, hiddenSessionIDs: model.hiddenSessionIDs,
                showHiddenSessions: model.showHiddenSessions)
        }
    }
    private func clearSearch() { model.sessionSearch = "" }

    private var groups: [SessionTableGroup] { results.groups }

    /// Rows actually present in the lazy stack. Collapsed groups stay out of
    /// the height the end measurement has to account for.
    private var renderedSessionRows: Int {
        let grouping = results.appliedGrouping.rawValue
        return groups.reduce(0) { count, group in
            collapsedGroups.contains(grouping + ":" + group.key) ? count : count + group.items.count
        }
    }

    var body: some View {
        ZStack {
            table.opacity(model.selectedLocalSession == nil ? 1 : 0)
                .allowsHitTesting(model.selectedLocalSession == nil).disabled(model.selectedLocalSession != nil)
                .accessibilityElement(children: .contain).accessibilityHidden(model.selectedLocalSession != nil)
            if let row = model.selectedLocalSession {
                LocalTranscriptView(row: row, client: model.client, relay: relay)
                    .id(row.id)
            }
        }
        .preference(key: LocalSessionCountPreference.self, value: model.selectedLocalSession == nil ? rows.count : nil)
        .onReceive(model.objectWillChange) { _ in scheduleResults() }
        .onReceive(relay.objectWillChange) { _ in scheduleResults() }
        .onChange(of: sort) { _ in scheduleResults(immediate: true) }
        .onChange(of: model.hiddenSessionIDs) { hidden in selection.subtract(hidden); scheduleResults(immediate: true) }
        .onChange(of: model.showHiddenSessions) { show in if !show { selection.subtract(model.hiddenSessionIDs) }; scheduleResults(immediate: true) }
        .onChange(of: model.sessionGrouping) { _ in scheduleResults(immediate: true) }
        .onAppear { scheduleResults(immediate: true) }
        .onDisappear { results.cancel() }

    }

    private var table: some View {
        VStack(spacing: 0) {
            if model.showsCapySetup {
                CapySetupCard().padding(.bottom, 12)
            }
            if model.showsDevinSetup {
                DevinSetupCard().padding(.bottom, 12)
            }
            if !selection.isEmpty {
                bulkActions.transition(.move(edge: .top).combined(with: .opacity))
            }
            if let error = query.error {
                Label(error, systemImage: "info.circle").font(.caption).foregroundStyle(CloudTheme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 10)
            }
            GeometryReader { horizontal in
                ScrollView(.horizontal) {
                    VStack(spacing: 0) {
                        tableHeader
                        Divider().hidden().overlay(CloudTheme.border)
                        GeometryReader { viewport in
                            ScrollView {
                                let generation = results.generation
                                let renderedGroups = groups
                                let index = model.sessionSearchSource.rowIndex(model: model, relay: relay)
                                TimelineView(.periodic(from: Self.clockStart, by: 10)) { clock in
                                    LazyVStack(spacing: 0) {
                                        ForEach(renderedGroups) { group in
                                            if results.appliedGrouping != .none { groupHeader(group.key, rows: group.rows, first: group.id == groups.first?.id) }
                                            if !collapsedGroups.contains(results.appliedGrouping.rawValue + ":" + group.key) {
                                                ForEach(group.items) { item in
                                                    LocalSessionTableRow(state: index.state(for: item.row), columns: columns,
                                                        selected: selection.contains(item.id), now: clock.date, actions: actions(for: item.row))
                                                        .equatable()
                                                        .id(results.appliedGrouping.rawValue + ":" + item.id)
                                                        .background(item.striped ? CloudTheme.muted : CloudTheme.background)
                                                }
                                            }
                                        }
                                        if rows.isEmpty {
                                            VStack(spacing: 8) {
                                                if model.isLoadingSessions || model.isLoadingPreview { ProgressView().controlSize(.small) }
                                                Text(allRows.isEmpty ? "No sessions found yet" : "No sessions match these filters.")
                                                if allRows.isEmpty { Text("Local sessions appear here as they are discovered.").font(.caption) }
                                                if !model.sessionSearch.isEmpty { Button("Clear search and filters", action: clearSearch) }
                                            }.foregroundStyle(CloudTheme.secondary).frame(maxWidth: .infinity).padding(50)
                                        }
                                        Color.clear.frame(height: 1)
                                            .background(GeometryReader { end in
                                                let placed = end.frame(in: .named("sessionContent"))
                                                let shown = end.frame(in: .named("sessionScroll"))
                                                Color.clear.preference(key: SessionListEndPreference.self,
                                                    value: SessionListEndSignal(visible: SessionListEndMeasurement.isNearEnd(
                                                        contentHeight: placed.minY + placed.height, contentMaxY: shown.maxY,
                                                        viewportHeight: viewport.size.height, renderedRows: renderedSessionRows),
                                                        generation: generation))
                                            })
                                            .accessibilityHidden(true)
                                    }
                                    .coordinateSpace(name: "sessionContent")
                                }
                            }
                            .coordinateSpace(name: "sessionScroll")
                            .onPreferenceChange(SessionListEndPreference.self) { signal in
                                listEnd = signal
                                loadMoreIfNeeded()
                            }
                            .onChange(of: model.isLoadingSessions) { loading in
                                if !loading { loadMoreIfNeeded() }
                            }
                            .onChange(of: model.selectedLocalSession == nil) { showingList in
                                if showingList { loadMoreIfNeeded() }
                            }
                        }
                    }.frame(width: max(horizontal.size.width, columns.minimumWidth), height: horizontal.size.height)
                }
            }


        }
        .alert("Delete cloud copies?", isPresented: $confirmsDeletion) {
            Button("Cancel", role: .cancel) { deletionKeys = [] }
            Button("Delete from Cloud", role: .destructive) {
                let keys = deletionKeys
                let revision = deletionRevision
                Task { await model.excludeSessions(keys: keys, confirmedAt: revision) }
            }
        } message: {
            Text("This removes the selected cloud copies and stops future uploads. Your local history stays on this machine.")
        }
        .animation(.easeInOut(duration: 0.18), value: selection.isEmpty)
        .padding(.horizontal, 24)
    }

    private static let clockStart = Date()

    private func actions(for row: LocalSessionRow) -> SessionRowActions {
        let id = row.id
        return SessionRowActions(
            open: { model.selectedLocalSession = row },
            toggleSelected: { if selection.contains(id) { selection.remove(id) } else { selection.insert(id) } },
            toggleRelay: {
                guard let original = row.relay else { return }
                let session = relay.sessions.first { $0.id == original.id } ?? original
                relay.requestRelay(!relay.presence(of: session).isOn, for: session)
            },
            setHidden: { hidden in Task { await model.setSessionsHidden(keys: [id], hidden: hidden) } },
            openInCloud: { model.openSession($0) })
    }

    private var selectedRows: [LocalSessionRow] { allRows.filter { selection.contains($0.id) } }
    private var uploadKeys: [String] {
        selectedRows.compactMap { row in
            guard !model.hiddenSessionIDs.contains(row.id), let upload = model.sessions.first(where: { $0.id == row.id }), model.canSelectSession(upload), (!upload.included || model.stoppingUploads.contains(upload.id)) else { return nil }
            return upload.id
        }
    }
    private var includedKeys: [String] {
        model.sessions.filter { selection.contains($0.id) && ($0.included || model.requestingUploads.contains($0.id)) && model.canSelectSession($0) }.map(\.id)
    }
    private var messageSessions: [LocalSession] {
        relay.sessions.filter { session in
            selectedRows.contains { $0.relay?.id == session.id && !model.hiddenSessionIDs.contains($0.id) } && relay.canToggle(session, presence: relay.presence(of: session))
        }
    }
    private var bulkActions: some View {
        HStack(spacing: 12) {
            Text("\(selection.count) selected").font(.system(size: 12, weight: .medium))
            Spacer()
            Toggle("Messaging", isOn: Binding(
                get: { !messageSessions.isEmpty && messageSessions.allSatisfy { relay.presence(of: $0).isOn } },
                set: { enabled in for session in messageSessions { relay.requestRelay(enabled, for: session) } }
            ))
            .toggleStyle(.switch).controlSize(.small).fixedSize()
            .disabled(messageSessions.isEmpty)
            Toggle("Upload", isOn: Binding(
                get: { !selectedRows.isEmpty && selectedRows.allSatisfy { row in
                    model.sessions.contains { $0.id == row.id && !model.stoppingUploads.contains($0.id) && ($0.included || model.requestingUploads.contains($0.id)) }
                } },
                set: { enabled in
                    if enabled {
                        let keys = uploadKeys
                        Task { await model.includeSessions(keys: keys) }
                    } else {
                        deletionKeys = includedKeys
                        deletionRevision = model.uploadConnectionRevision
                        confirmsDeletion = true
                    }
                }
            ))
            .toggleStyle(.switch).controlSize(.small).fixedSize()
            .disabled(uploadKeys.isEmpty && includedKeys.isEmpty)
            let hideable = selectedRows.filter { !model.hiddenSessionIDs.contains($0.id) && !model.hidingSessionIDs.contains($0.id) }.map(\.id)
            let unhideable = selectedRows.filter { model.hiddenSessionIDs.contains($0.id) && !model.hidingSessionIDs.contains($0.id) }.map(\.id)
            if !hideable.isEmpty {
                Button { Task { await model.setSessionsHidden(keys: hideable, hidden: true) } } label: {
                    HStack { Text("Hide"); Image(systemName: "eye.slash") }
                }
            }
            if !unhideable.isEmpty {
                Button { Task { await model.setSessionsHidden(keys: unhideable, hidden: false) } } label: {
                    HStack { Text("Unhide"); Image(systemName: "eye") }
                }
            }
        }.padding(12).background(CloudTheme.muted)
    }

    private func loadMoreIfNeeded() {
        Task {
            guard listEnd.canLoadMore(generation: results.generation, isPending: results.isPending),
                  model.selectedLocalSession == nil, model.canLoadMoreSessions else { return }
            await model.loadMoreSessions()
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 16) {
            let allSelected = !rows.isEmpty && rows.allSatisfy { selection.contains($0.id) }
            SessionCheckbox(title: "Select all visible sessions", isOn: allSelected) {
                if allSelected { selection.subtract(rows.map(\.id)) } else { selection.formUnion(rows.map(\.id)) }
            }.frame(width: 20, height: 36)
            Color.clear.frame(width: 24)
            ForEach(columns.visible) { column in
                Group {
                    if let sortable = column.sortColumn { sortHeader(sortable, alignment: column == .relay || column == .upload ? .center : .leading) }
                    else { Text(column.title).frame(maxWidth: .infinity, alignment: .leading) }
                }
                .frame(minWidth: columns.width(for: column), maxWidth: column == columns.expandingColumn ? .infinity : columns.width(for: column))
                // Plain-text and sortable headers share the resize overlay's origin.
                .frame(height: 36)
                .clipped()
                .overlay(alignment: .trailing) {
                    GeometryReader { geometry in
                        SessionColumnResizeHandle(column: column, width: geometry.size.width,
                            begin: { width in
                                var draft = columns
                                draft.setWidth(width, for: column)
                                resizingColumns = draft
                            },
                            change: { resizingColumns?.setWidth($0, for: column) },
                            commit: { if let draft = resizingColumns { model.sessionColumns = draft }; resizingColumns = nil },
                            cancel: { resizingColumns = nil })
                            .frame(width: 10, height: 36).offset(x: geometry.size.width - 2)
                    }
                }
            }
        }.font(.system(size: 12, weight: .medium)).foregroundStyle(CloudTheme.secondary)
            .padding(.horizontal, 12).frame(height: 36).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sortHeader(_ column: LocalSessionSortColumn, alignment: Alignment = .leading) -> some View {
        let selected = sort.column == column
        let nextAscending = selected ? !sort.ascending : column.startsAscending
        let direction = sort.headerDirection(for: column, previewNext: hoveredSortColumn == column)
        return Button { model.sessionSort.select(column) } label: {
            HStack(spacing: 4) {
                if alignment == .center { Color.clear.frame(width: 10).accessibilityHidden(true) }
                Text(column.rawValue).lineLimit(1)
                Image(systemName: (direction ?? nextAscending) ? "arrow.up" : "arrow.down")
                    .font(.system(size: 9, weight: .semibold)).frame(width: 10)
                    .opacity(direction == nil ? 0 : 1).accessibilityHidden(true)
            }.frame(maxWidth: .infinity, minHeight: 36, alignment: alignment).contentShape(Rectangle())
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .onHover { hovering in
            if hovering { hoveredSortColumn = column }
            else if hoveredSortColumn == column { hoveredSortColumn = nil }
        }
        .help("\(column.rawValue): click to sort \(nextAscending ? "ascending" : "descending")")
        .accessibilityLabel("Sort by " + column.rawValue)
        .accessibilityHint("Click to sort " + (nextAscending ? "ascending" : "descending"))
        .accessibilityValue(selected ? (sort.ascending ? "Ascending" : "Descending") : "Not sorted")
    }

    private func groupHeader(_ title: String, rows: [LocalSessionRow], first: Bool) -> some View {
        let key = results.appliedGrouping.rawValue + ":" + title
        let collapsed = collapsedGroups.contains(key)
        return HStack(spacing: 0) {
            SessionGroupSelectionCheckbox(title: title, ids: rows.map(\.id), selection: $selection)
                .frame(width: 44)
            Button {
                if collapsed { collapsedGroups.remove(key) } else { collapsedGroups.insert(key) }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold)).frame(width: 12)
                    if results.appliedGrouping == .harness, let row = rows.first {
                        AgentIconView(source: row.source, size: 24, host: row.relay?.host ?? row.upload?.host)
                    } else {
                        Image(systemName: results.appliedGrouping == .week ? "calendar" : results.appliedGrouping == .project ? "folder" : "circle.dotted")
                            .font(.system(size: 21)).foregroundStyle(CloudTheme.secondary)
                    }
                    Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(CloudTheme.foreground)
                    Spacer()
                    Text("\(rows.count) \(rows.count == 1 ? "session" : "sessions")")
                        .font(.system(size: 11)).foregroundStyle(CloudTheme.secondary).padding(.horizontal, 8).padding(.vertical, 4)
                        .background(CloudTheme.background, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(CloudTheme.border))
                }
                .padding(.trailing, 16).frame(height: 52)
            }
            .buttonStyle(NavButtonStyle(kind: .sidebar))
            .help(collapsed ? "Expand \(title)" : "Collapse \(title)")
            .accessibilityLabel("\(title), \(rows.count) sessions")
            .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
        }
        .background(CloudTheme.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(CloudTheme.border))
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 2).fill(CloudTheme.primary.opacity(0.55)).frame(width: 3) }
        .padding(.top, first ? 4 : 22)
        .accessibilityAddTraits(.isHeader)
    }
}

struct SessionGroupSelectionCheckbox: View {
    let title: String
    let ids: [String]
    @Binding var selection: Set<String>

    private var isOn: Bool { !ids.isEmpty && ids.allSatisfy { selection.contains($0) } }

    var body: some View {
        SessionCheckbox(title: "Select sessions in \(title)", isOn: isOn) {
            if isOn { selection.subtract(ids) } else { selection.formUnion(ids) }
        }
        .help("Select sessions in \(title)")
    }
}

/// A drawn checkbox. Hundreds of table rows scroll through the viewport, and
/// a native checkbox is an AppKit control each row would create on the way in.
struct SessionCheckbox: View {
    let title: String
    let isOn: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            ZStack {
                Color.clear.contentShape(Rectangle())
                SessionCheckboxMark(isOn: isOn)
            }
        }
        .buttonStyle(.plain).actionCursor()
        .accessibilityRepresentation {
            Toggle(title, isOn: Binding(get: { isOn }, set: { if $0 != isOn { toggle() } }))
        }
    }
}

struct SessionCheckboxMark: View {
    let isOn: Bool
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 4.5, style: .continuous)
        shape.fill(isOn ? CloudTheme.primary : Color.primary.opacity(0.1))
            .overlay(shape.strokeBorder(isOn ? Color.clear : Color.primary.opacity(0.12), lineWidth: 0.5))
            .overlay(shape.inset(by: -2).stroke(CloudTheme.ring.opacity(isFocused ? 1 : 0), lineWidth: 2))
            .overlay {
                if isOn {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                }
            }
            .frame(width: 16, height: 16)
            .accessibilityHidden(true)
    }
}

/// The handlers a row's controls call. Rows compare only their values, so
/// these must act on the row they were made for rather than on captured state.
struct SessionRowActions {
    let open: () -> Void
    let toggleSelected: () -> Void
    let toggleRelay: () -> Void
    let setHidden: (Bool) -> Void
    let openInCloud: (UploadSession) -> Void
}

struct LocalSessionTableRow: View, Equatable {
    let state: SessionRowState
    let columns: SessionColumnLayout
    let selected: Bool
    /// The table's shared clock for relative timestamps.
    let now: Date
    let actions: SessionRowActions
    @State private var hovering = false
    @FocusState private var openingFocused: Bool

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.state == rhs.state && lhs.columns == rhs.columns && lhs.selected == rhs.selected && lhs.now == rhs.now
    }

    private var row: LocalSessionRow { state.row }

    var body: some View {
        HStack(spacing: 0) {
            // The selection lane includes the padding around the checkbox.
            SessionCheckbox(title: "Select \(row.title)", isOn: selected, toggle: actions.toggleSelected)
                .frame(width: 44, height: SessionListEndMeasurement.rowHeight)
            HStack(spacing: 16) {
                AgentIconView(source: row.source, size: 22, host: state.host)
                    .frame(width: 24).allowsHitTesting(false)
                ForEach(columns.visible) { column in
                    Group {
                        if column == .relay {
                            relayToggle
                                // Keep the message control and its padding out of the open target.
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                                .background { Color.clear.contentShape(Rectangle()).onTapGesture {} }
                        } else if column == .upload {
                            Button(action: actions.open) {
                                VStack(spacing: 2) {
                                    SessionStatusCell(state: state.uploadState, stopping: state.stopping)
                                    Text(state.stopping ? "Deleting…" : state.uploadState.iconTitle).lineLimit(1)
                                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center).contentShape(Rectangle())
                            }.buttonStyle(.plain).focusable(false).actionCursor().accessibilityHidden(true)
                        } else {
                            Button(action: actions.open) {
                                cell(column).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain).focusable(false).actionCursor().accessibilityHidden(true)
                        }
                    }
                    .frame(width: column == columns.expandingColumn ? nil : columns.width(for: column))
                    .frame(minWidth: column == columns.expandingColumn ? columns.width(for: column) : nil,
                           maxWidth: column == columns.expandingColumn ? .infinity : nil)
                    .clipped()
                }
            }
            .padding(.leading, 4).padding(.trailing, 12).frame(maxWidth: .infinity, alignment: .leading)
        }
        .opacity(state.hidden ? 0.5 : 1)
        .font(.system(size: 12)).foregroundStyle(CloudTheme.secondary)
        // Fully determined by the table, so the lazy stack never measures a row's contents.
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: SessionListEndMeasurement.rowHeight, maxHeight: SessionListEndMeasurement.rowHeight)
        .background {
            Button(action: actions.open) { Color.clear.contentShape(Rectangle()) }
                .buttonStyle(.plain).focused($openingFocused).actionCursor()
                .accessibilityLabel("Open session: \(row.title)")
                .accessibilityValue(uploadStatusDescription)
        }
        .background(selected ? CloudTheme.primary.opacity(0.18) : hovering || openingFocused ? CloudTheme.hover : .clear)
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Open session", action: actions.open)
            Button(state.hidden ? "Unhide session" : "Hide session") { actions.setHidden(!state.hidden) }
                .disabled(state.hiding)
            if let upload = state.upload, upload.status == .uploaded {
                Button("Open in Cloud") { actions.openInCloud(upload) }
            }
        }
    }

    @ViewBuilder private func cell(_ column: SessionColumn) -> some View {
        switch column {
        case .session:
            VStack(alignment: .leading, spacing: 3) {
                Text(state.title).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(CloudTheme.foreground).lineLimit(1).help(state.title)
                let details = row.executionDetails(harness: AgentIconView.name(for: row.source))
                // The agent name leads the second line: what to message it by.
                HStack(spacing: 0) {
                    if let agent = row.agentName {
                        Text("@\(agent)").font(.system(size: 10, weight: .medium)).foregroundStyle(CloudTheme.foreground)
                            .lineLimit(1).layoutPriority(1).help(row.agentDetail ?? "@\(agent)")
                        if !details.isEmpty { Text(" · ").font(.system(size: 10)).foregroundStyle(CloudTheme.secondary) }
                    }
                    Text(details).font(.system(size: 10)).foregroundStyle(CloudTheme.secondary).lineLimit(1).help(details)
                }
                if let error = state.error {
                    Text(error).font(.caption).foregroundStyle(CloudTheme.warning).lineLimit(2).help(error)
                }
            }
        case .project: Text(row.project.isEmpty ? "—" : row.project).lineLimit(1).help(row.directory)
        case .updated: SessionTimestampCell(date: row.updatedAt, now: now)
        case .harness:
            HStack(spacing: 8) {
                AgentIconView(source: row.source, size: 20, host: state.host)
                Text(AgentIconView.name(for: row.source)).lineLimit(1)
            }
        case .model: Text(row.modelName).lineLimit(1).help(row.modelName)
        case .reasoning: Text(row.reasoning).lineLimit(1)
        case .created: SessionTimestampCell(date: row.createdAt, now: now)
        case .directory: Text(row.directory.isEmpty ? "—" : row.directory).lineLimit(1).help(row.directory)
        case .sessionID: Text(row.sessionID).lineLimit(1).font(.system(size: 11, design: .monospaced))
        case .status: Text(state.activityStatus).lineLimit(1)
        case .relay, .upload: EmptyView()
        }
    }

    private var uploadStatusDescription: String {
        if state.stopping { return "Deleting… Deleting the cloud copy and stopping future uploads" }
        return state.uploadState.iconTitle + ". " + state.uploadState.detail
    }

    @ViewBuilder private var relayToggle: some View {
        if let session = state.relaySession {
            MessageAvailabilityButton(title: row.title, presence: state.presence, enabled: state.canToggleRelay,
                help: state.canToggleRelay ? state.presence.messageHelp : (session.live
                    ? "Connect a workspace to receive messages."
                    : "Start this session to receive messages."), action: actions.toggleRelay)
        } else {
            MessageAvailabilityButton(title: row.title, presence: .off, enabled: false,
                help: "Start this session in a supported harness to receive messages.", action: {})
        }
    }
}

struct SessionListEndSignal: Equatable {
    var visible: Bool = false
    var generation: Int = 0

    func canLoadMore(generation current: Int, isPending: Bool) -> Bool {
        visible && current > 0 && generation == current && !isPending
    }
}

/// Whether the session table has actually been scrolled near its end.
///
/// A `LazyVStack` can place its footer just after the first realized rows and
/// report that footer as on screen. That measurement is shorter than the rows
/// it claims to follow, so it must not page in the rest of history. A measured
/// list still pages when its bottom is within the same slack of the viewport,
/// including a short filtered list whose end really is on screen.
enum SessionListEndMeasurement {
    static let rowHeight: CGFloat = 64
    static let nearEndSlack: CGFloat = 200

    static func isNearEnd(contentHeight: CGFloat, contentMaxY: CGFloat, viewportHeight: CGFloat, renderedRows: Int) -> Bool {
        let measured = renderedRows == 0 || contentHeight >= CGFloat(renderedRows) * rowHeight
        return measured && contentMaxY > 0 && contentMaxY <= viewportHeight + nearEndSlack
    }
}

struct SessionListEndPreference: PreferenceKey {
    static var defaultValue = SessionListEndSignal()
    static func reduce(value: inout SessionListEndSignal, nextValue: () -> SessionListEndSignal) {
        let next = nextValue()
        // Visibility belongs to the layout generation that measured it. An
        // empty/short previous result set must not page a newly populated list.
        if next.generation > value.generation {
            value = next
        } else if next.generation == value.generation {
            value.visible = value.visible || next.visible
        }
    }
}

/// Timestamps follow the table's shared clock and expose an exact instant on hover.
struct SessionTimestampCell: View {
    let date: Date?
    let now: Date
    var body: some View {
        Text(RelativeTime.string(for: date, relativeTo: now)).lineLimit(1)
            .help(RelativeTime.exactString(for: date))
    }
}

/// The offer above the session table to add Agent Relay's hooks to Devin,
/// while Devin has run here, its hooks are off and the person has not chosen
/// Not now.
struct DevinSetupCard: View {
    @EnvironmentObject private var model: AppModel
    @State private var turningOn = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(DevinSetup.title, systemImage: "sparkles").font(.system(size: 12, weight: .semibold))
            Text(DevinSetup.message).font(.system(size: 11)).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(DevinSetup.turnOnAction) {
                    turningOn = true
                    Task {
                        await model.turnOnDevin()
                        turningOn = false
                    }
                }
                .buttonStyle(MenuPanelButtonStyle(kind: .primary, controlHeight: 26))
                .fixedSize()
                .disabled(turningOn)
                .help("Add Agent Relay's hooks to Devin")
                Button(DevinSetup.notNowAction) { model.dismissDevinSetup() }
                    .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 26))
                    .fixedSize()
                    .help("Hide this for good")
            }
            if let error = model.devinSetupError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11)).foregroundStyle(CloudTheme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CloudTheme.card, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(CloudTheme.border))
        .accessibilityElement(children: .contain)
    }
}

/// The offer above the session table to put Capy threads on the relay,
/// while Capy is detected and the person has not chosen Not now.
struct CapySetupCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(CapySetup.title, systemImage: "sparkles").font(.system(size: 12, weight: .semibold))
            Text(CapySetup.message).font(.system(size: 11)).foregroundStyle(CloudTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(CapySetup.setUpAction) { model.setUpCapy() }
                    .buttonStyle(MenuPanelButtonStyle(kind: .primary, controlHeight: 26))
                    .fixedSize()
                    .help("Copies a prompt and opens Capy")
                Button(CapySetup.notNowAction) { model.dismissCapySetup() }
                    .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 26))
                    .fixedSize()
                    .help("Hide this for good")
            }
            if model.capyPromptCopied {
                Label(CapySetup.copied, systemImage: "checkmark.circle.fill")
                    .font(.system(size: 11)).foregroundStyle(CloudTheme.success)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CloudTheme.card, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(CloudTheme.border))
        .accessibilityElement(children: .contain)
    }
}
