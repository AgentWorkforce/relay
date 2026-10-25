import SwiftUI
import RelayDesktopCore

struct SessionColumnSettings: View {
    @Binding var layout: SessionColumnLayout
    @Binding var grouping: LocalSessionGrouping
    @Binding var showHidden: Bool
    @State private var isPresented = false
    @State private var window: NSWindow?
    var body: some View {
        Button { isPresented.toggle() } label: {
            Image(systemName: "rectangle.split.3x1")
                .font(.system(size: 16))
                .frame(width: 32, height: 32)
                .accessibilityHidden(true)
        }
            .buttonStyle(NavButtonStyle(kind: .icon))
            .help("Table display").accessibilityLabel("Table display")
            .background(WindowReader { window = $0 })
            .popover(isPresented: $isPresented) {
                SessionColumnEditor(layout: $layout, grouping: $grouping, showHidden: $showHidden, close: { isPresented = false }, resetWindow: {
                    guard let window, !window.styleMask.contains(.fullScreen) else { return }
                    let size = SessionColumnLayout.defaultWindowSize
                    let available = window.screen?.visibleFrame.size ?? size
                    let chrome = window.frameRect(forContentRect: NSRect(origin: .zero, size: size)).height - size.height
                    window.setContentSize(NSSize(width: min(size.width, available.width), height: min(size.height, available.height - chrome)))
                })
            }
    }
}

struct SessionColumnEditor: View {
    @Binding var layout: SessionColumnLayout
    @Binding var grouping: LocalSessionGrouping
    @Binding var showHidden: Bool
    let close: () -> Void
    var resetWindow: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cancelled = false
    @State private var dragging: SessionColumn?
    @GestureState private var gesture: DragGesture.Value?
    private let rowHeight: CGFloat = 40
    private let rowSpacing: CGFloat = 6

    private var sourceIndex: Int? { dragging.flatMap { layout.order.firstIndex(of: $0) } }
    private var targetIndex: Int? {
        guard let sourceIndex, let gesture else { return nil }
        return destination(from: sourceIndex, translation: gesture.translation.height)
    }
    private func destination(from index: Int, translation: CGFloat) -> Int {
        min(layout.order.count - 1, max(0, index + Int((translation / (rowHeight + rowSpacing)).rounded())))
    }
    private func offset(at index: Int) -> CGFloat {
        guard let sourceIndex, let targetIndex, let gesture else { return 0 }
        let step = rowHeight + rowSpacing
        if index == sourceIndex {
            return min(CGFloat(layout.order.count - 1 - index) * step, max(-CGFloat(index) * step, gesture.translation.height))
        }
        if index > sourceIndex && index <= targetIndex { return -step }
        if index < sourceIndex && index >= targetIndex { return step }
        return 0
    }
    private var movement: Animation? { reduceMotion ? nil : .interactiveSpring(response: 0.25, dampingFraction: 0.86) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Group by").font(.caption.weight(.medium))
                CloudSelect(title: "Group by", selection: $grouping,
                            options: LocalSessionGrouping.allCases.map { ($0, $0.rawValue) })
                    .accessibilityLabel("Group sessions")
            }
            Toggle("Show hidden", isOn: $showHidden).toggleStyle(.checkbox)
            VStack(alignment: .leading, spacing: 10) {
                Text("\(layout.visible.count) of \(layout.order.count) columns shown").font(.caption)
                VStack(spacing: rowSpacing) {
                    ForEach(Array(layout.order.enumerated()), id: \.element) { index, column in
                        columnRow(column, index: index)
                            .offset(y: offset(at: index))
                            .zIndex(dragging == column && gesture != nil ? 1 : 0)
                            .animation(dragging == column ? nil : movement, value: targetIndex)
                    }
                }
                .background(alignment: .top) {
                    if let targetIndex {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(CloudTheme.primary.opacity(0.06))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(CloudTheme.primary.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                            .frame(height: rowHeight)
                            .offset(y: CGFloat(targetIndex) * (rowHeight + rowSpacing))
                    }
                }
                .coordinateSpace(name: "column-order")
            }
            HStack {
                Button("Reset to default") { dragging = nil; withAnimation(movement) { layout = SessionColumnLayout() }; resetWindow() }
                Spacer()
                Button("Done", action: close)
                    .buttonStyle(AgentRelayPrimaryButtonStyle(height: 32))
                    .keyboardShortcut(.defaultAction)
            }
        }.padding(20).frame(width: 380)
            .onExitCommand { if dragging != nil { cancelled = true; dragging = nil } else { close() } }
            .onChange(of: gesture == nil) { ended in if ended { dragging = nil; cancelled = false } }
            .onDisappear { dragging = nil }
    }

    private func columnRow(_ column: SessionColumn, index: Int) -> some View {
        let lifted = dragging == column && gesture != nil
        return HStack(spacing: 8) {
            Image(systemName: "line.3.horizontal")
                .foregroundStyle(CloudTheme.secondary)
                .frame(width: 28, height: rowHeight)
                .contentShape(Rectangle()).help("Drag to reorder \(column.title)")
                .accessibilityLabel("Reorder \(column.title)")
                .gesture(DragGesture(minimumDistance: 4, coordinateSpace: .named("column-order"))
                    .updating($gesture) { value, state, _ in state = value }
                    .onChanged { _ in if dragging == nil && !cancelled { dragging = column } }
                    .onEnded { value in
                        guard dragging == column else { return }
                        let target = destination(from: index, translation: value.translation.height)
                        withAnimation(movement) {
                            layout.move(column, to: layout.order[target])
                            dragging = nil
                        }
                    })
            Toggle(column.title, isOn: Binding(get: { !layout.hidden.contains(column) }, set: { layout.setVisible($0, for: column) }))
                .toggleStyle(.checkbox).lineLimit(1)
                .disabled(layout.visible.count == 1 && !layout.hidden.contains(column))
                .accessibilityLabel("Show \(column.title)")
            Spacer(minLength: 0)
            Button { withAnimation(movement) { layout.move(column, to: layout.order[index - 1]) } } label: { Image(systemName: "arrow.up").frame(width: 16) }
                .disabled(index == 0).help("Move \(column.title) up").accessibilityLabel("Move \(column.title) up")
            Button { withAnimation(movement) { layout.move(column, to: layout.order[index + 1]) } } label: { Image(systemName: "arrow.down").frame(width: 16) }
                .disabled(index == layout.order.count - 1).help("Move \(column.title) down").accessibilityLabel("Move \(column.title) down")
        }
        .padding(.horizontal, 8).frame(height: rowHeight)
        .background(lifted ? CloudTheme.card : CloudTheme.muted, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(lifted ? CloudTheme.primary : .clear, lineWidth: 1))
        .shadow(color: .black.opacity(lifted ? 0.18 : 0), radius: 8, y: 4)
    }
}
