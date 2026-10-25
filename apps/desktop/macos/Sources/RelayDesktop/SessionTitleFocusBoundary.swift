import AppKit
import SwiftUI

/// Plain macOS buttons need not take keyboard focus. Observe outside clicks as
/// well as SwiftUI focus changes, without intercepting or replaying any events.
struct SessionTitleFocusBoundary: NSViewRepresentable {
    let inside: () -> Void
    let outside: () -> Void

    func makeNSView(context: Context) -> BoundaryView { BoundaryView() }
    func updateNSView(_ view: BoundaryView, context: Context) {
        view.inside = inside
        view.outside = outside
    }
    static func dismantleNSView(_ view: BoundaryView, coordinator: ()) { view.stop() }

    final class BoundaryView: NSView {
        var inside: () -> Void = {}
        var outside: () -> Void = {}
        private var monitor: Any?
        private var resign: NSObjectProtocol?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard let window else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                guard let self, let window = self.window else { return event }
                if event.window === window && self.bounds.contains(self.convert(event.locationInWindow, from: nil)) {
                    self.inside()
                } else {
                    self.outside()
                }
                return event
            }
            resign = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification,
                object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.outside() }
                }
        }
        func stop() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            if let resign { NotificationCenter.default.removeObserver(resign) }
            monitor = nil
            resign = nil
        }
    }
}
