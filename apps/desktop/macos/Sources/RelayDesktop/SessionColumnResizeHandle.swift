import AppKit
import SwiftUI
import RelayDesktopCore

/// The only resize hit target is the trailing edge of a column header.
/// A pointer drag leaves keyboard focus where it is: Escape reaches the drag
/// through a key monitor that lives only while the drag runs.
struct SessionColumnResizeHandle: View {
    let column: SessionColumn
    let width: CGFloat
    let begin: (CGFloat) -> Void
    let change: (CGFloat) -> Void
    let commit: () -> Void
    let cancel: () -> Void
    @State private var initialWidth: CGFloat?
    @State private var hovering = false
    @State private var cancelled = false
    @State private var escape = EscapeMonitor()
    @GestureState private var dragging = false

    var body: some View {
        Rectangle().fill(hovering || dragging ? CloudTheme.primary : CloudTheme.border)
            .frame(width: 2, height: 20)
            .frame(width: 10, height: 36).contentShape(Rectangle())
            .onHover { over in
                if over != hovering { if over { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
                hovering = over
            }
            .keyboardFocusable()
            .gesture(DragGesture(minimumDistance: 2, coordinateSpace: .global)
                .updating($dragging) { _, active, _ in active = true }
                .onChanged { value in
                    guard !cancelled else { return }
                    if initialWidth == nil {
                        initialWidth = width
                        begin(width)
                        escape.start { cancelled = true; initialWidth = nil; cancel() }
                    }
                    change((initialWidth ?? width) + value.translation.width)
                }
                .onEnded { value in
                    escape.stop()
                    guard !cancelled else { cancelled = false; return }
                    change((initialWidth ?? width) + value.translation.width)
                    initialWidth = nil
                    commit()
                })
            .onTapGesture(count: 2) { begin(width); change(column.width); commit() }
            .onChange(of: dragging) { active in
                guard !active else { return }
                escape.stop()
                if initialWidth != nil { initialWidth = nil; cancel() }
                cancelled = false
            }
            .onDisappear { if hovering { NSCursor.pop() }; escape.stop(); initialWidth = nil; cancel() }
            .accessibilityLabel("Resize \(column.title) column")
            .accessibilityValue("\(Int(width)) points")
            .accessibilityAdjustableAction { direction in
                begin(width)
                change(width + (direction == .increment ? 10 : -10))
                commit()
            }
            .help("Drag to resize; double-click to reset")
    }
}

private extension View {
    /// Keyboard navigation reaches the grip; a click never focuses it.
    @ViewBuilder func keyboardFocusable() -> some View {
        if #available(macOS 14, *) { focusable(interactions: .activate) } else { focusable() }
    }
}

/// Swallows Escape for the length of one pointer drag.
private final class EscapeMonitor {
    private var monitor: Any?

    func start(_ cancel: @escaping () -> Void) {
        stop()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            self?.stop()
            cancel()
            return nil
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
