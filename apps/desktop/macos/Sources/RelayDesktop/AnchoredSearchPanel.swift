import AppKit
import QuartzCore
import SwiftUI

/// A transient search surface whose top edge grows over its toolbar anchor.
struct AnchoredSearchPanel<Content: View>: NSViewRepresentable {
    @Binding var presented: Bool
    let content: () -> Content

    func makeNSView(context: Context) -> SearchPanelAnchor { SearchPanelAnchor() }
    func updateNSView(_ view: SearchPanelAnchor, context: Context) {
        view.closeSearch = { presented = false }
        view.update(presented: presented, content: AnyView(content()))
    }
    static func dismantleNSView(_ view: SearchPanelAnchor, coordinator: ()) { view.close(animated: false) }
}

private final class SearchFloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class SearchPanelAnchor: NSView {
    var closeSearch: () -> Void = {}
    private var requestedContent: AnyView?
    private var panel: NSPanel?
    private var monitor: Any?
    private var transitioning = false
    private var closing = false
    private var transitionID = 0
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    static func frame(anchor: CGRect, container: CGRect) -> CGRect {
        let width = min(max(anchor.width + 24, 540), container.width - 24)
        let height = min(520, container.height - 24)
        let x = min(max(anchor.midX - width / 2, container.minX + 12), container.maxX - width - 12)
        let top = min(anchor.maxY + 12, container.maxY - 12)
        return CGRect(x: x, y: max(container.minY + 12, top - height), width: width, height: height)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let content = self.requestedContent else { return }
            self.update(presented: true, content: content)
        }
    }

    func update(presented: Bool, content: AnyView) {
        requestedContent = presented ? content : nil
        guard presented else { close(); return }
        guard let window else { return }
        let reopening = closing
        let opening = panel == nil || reopening
        if closing { transitionID += 1; closing = false; transitioning = false }
        if panel == nil {
            let panel = SearchFloatingPanel(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: content)
            self.panel = panel
            window.addChildWindow(panel, ordered: .above)

        } else if let host = panel?.contentView as? NSHostingView<AnyView> {
            host.rootView = content
        }
        if monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                guard let self, let panel = self.panel else { return event }
                if event.window !== panel { self.closeSearch(); self.close() }
                return event
            }
        }
        if opening, let panel, let geometry = geometry() {
            transitionID += 1
            let id = transitionID
            transitioning = true
            if !reopening {
                panel.setFrame(geometry.anchor, display: true)
                panel.alphaValue = 0.35
            }
            panel.makeKeyAndOrderFront(nil)
            animate {
                panel.animator().setFrame(geometry.expanded, display: true)
                panel.animator().alphaValue = 1
            } completion: { [weak self] in
                guard let self, self.transitionID == id else { return }
                self.transitioning = false
                self.position()
            }
        } else { position() }
    }
    override func layout() { super.layout(); position() }
    private func geometry() -> (anchor: CGRect, expanded: CGRect)? {
        guard let window else { return nil }
        let anchor = window.convertToScreen(convert(bounds, to: nil))
        let container = window.convertToScreen(window.contentView?.bounds ?? .zero)
        return (anchor, Self.frame(anchor: anchor, container: container))
    }
    private func position() {
        guard !transitioning, let panel, let geometry = geometry() else { return }
        panel.setFrame(geometry.expanded, display: true)
    }
    private func animate(_ changes: @escaping () -> Void, completion: @escaping () -> Void) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.2
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
            changes()
        } completionHandler: { completion() }
    }
    func close(animated: Bool = true) {
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        guard let panel else { return }
        if animated, closing { return }
        transitionID += 1
        let id = transitionID
        let finish = { [weak self, weak panel] in
            guard let self, self.transitionID == id, let panel else { return }
            panel.parent?.removeChildWindow(panel)
            panel.close()
            self.panel = nil
            self.transitioning = false
            self.closing = false
        }
        guard animated, let geometry = geometry() else { finish(); return }
        closing = true
        transitioning = true
        animate {
            panel.animator().setFrame(geometry.anchor, display: true)
            panel.animator().alphaValue = 0
        } completion: { finish() }
    }
    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
