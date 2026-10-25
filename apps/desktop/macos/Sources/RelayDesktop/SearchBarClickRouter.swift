import AppKit
import SwiftUI

struct SearchBarRemoveBounds: PreferenceKey {
    static var defaultValue: [CGRect] = []
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) { value += nextValue() }
}

/// Observe clicks without taking gestures away from buttons or the chip scroller.
struct SearchBarClickRouter: NSViewRepresentable {
    let exclusions: [CGRect]
    let open: () -> Void

    func makeNSView(context: Context) -> SearchBarClickView { SearchBarClickView() }
    func updateNSView(_ view: SearchBarClickView, context: Context) {
        view.exclusions = exclusions
        view.open = open
    }
}

final class SearchBarClickView: NSView {
    var exclusions: [CGRect] = []
    var open: () -> Void = {}
    private var start: CGPoint?
    private var monitor: Any?
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        start = nil
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] event in
            guard let self, self.window === event.window, !self.isHiddenOrHasHiddenAncestor else { return event }
            let point = self.convert(event.locationInWindow, from: nil)
            if event.type == .leftMouseDown {
                self.start = Self.isOpenClick(start: point, end: point, bounds: self.bounds, exclusions: self.exclusions) ? point : nil
            } else {
                if let start = self.start, Self.isOpenClick(start: start, end: point, bounds: self.bounds, exclusions: self.exclusions) {
                    self.open()
                }
                self.start = nil
            }
            return event
        }
    }

    static func isOpenClick(start: CGPoint, end: CGPoint, bounds: CGRect, exclusions: [CGRect]) -> Bool {
        bounds.contains(start) && bounds.contains(end)
            && hypot(end.x - start.x, end.y - start.y) < 4
            && !exclusions.contains { $0.contains(start) || $0.contains(end) }
    }

    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
