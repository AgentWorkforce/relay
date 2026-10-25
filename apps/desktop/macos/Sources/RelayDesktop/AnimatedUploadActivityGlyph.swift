import AppKit
import QuartzCore
import SwiftUI

/// The compositor animates this leaf without a TimelineView invalidating the
/// session table's SwiftUI graph every frame. GTK already draws its upload
/// animation inside a leaf widget rather than rebuilding the session list.
struct AnimatedUploadActivityGlyph: NSViewRepresentable {
    let reduceMotion: Bool

    func makeNSView(context: Context) -> UploadActivityLayerView {
        UploadActivityLayerView(reduceMotion: reduceMotion)
    }

    func updateNSView(_ view: UploadActivityLayerView, context: Context) {
        view.setReducedMotion(reduceMotion)
    }

    static func dismantleNSView(_ view: UploadActivityLayerView, coordinator: ()) {
        view.stopAnimating()
    }
}

@MainActor
final class UploadActivityLayerView: NSView {
    private let base = CALayer()
    private let accent = CALayer()
    private let fill = CALayer()
    private var observers: [NSObjectProtocol] = []
    private(set) var reduceMotion: Bool
    private(set) var animationStarts = 0

    init(reduceMotion: Bool) {
        self.reduceMotion = reduceMotion
        super.init(frame: .zero)
        wantsLayer = true
        base.contentsGravity = .resizeAspect
        base.opacity = 0.35
        accent.contentsGravity = .resizeAspect
        accent.opacity = 0.85
        fill.backgroundColor = NSColor.white.cgColor
        fill.anchorPoint = CGPoint(x: 0.5, y: 0)
        accent.mask = fill
        layer?.addSublayer(base)
        layer?.addSublayer(accent)
        updateImages()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: 16, height: 16) }

    override func layout() {
        super.layout()
        let changedSize = accent.bounds.size != bounds.size
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        base.frame = bounds
        accent.frame = bounds
        fill.bounds = CGRect(origin: .zero, size: bounds.size)
        fill.position = CGPoint(x: bounds.width / 2, y: 0)
        CATransaction.commit()
        if changedSize { stopAnimating() }
        updateAnimation()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeVisibility()
        updateImages()
        updateAnimation()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        observeVisibility()
        updateAnimation()
    }

    private func observeVisibility() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        if let window {
            for name in [NSWindow.didChangeOcclusionStateNotification,
                         NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification] {
                observers.append(NotificationCenter.default.addObserver(
                    forName: name, object: window, queue: .main
                ) { [weak self] _ in
                    MainActor.assumeIsolated { self?.updateAnimation() }
                })
            }
        }
        if let clip = enclosingScrollView?.contentView {
            clip.postsBoundsChangedNotifications = true
            observers.append(NotificationCenter.default.addObserver(
                forName: NSView.boundsDidChangeNotification, object: clip, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.updateAnimation() }
            })
        }
    }

    override func viewDidHide() { super.viewDidHide(); stopAnimating() }
    override func viewDidUnhide() { super.viewDidUnhide(); updateAnimation() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateImages()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateImages()
    }

    func setReducedMotion(_ value: Bool) {
        guard reduceMotion != value else { return }
        reduceMotion = value
        updateAnimation()
    }

    var isAnimating: Bool { fill.animation(forKey: "upload-fill") != nil }

    func stopAnimating() {
        fill.removeAnimation(forKey: "upload-fill")
        accent.removeAnimation(forKey: "upload-fade")
    }

    private func updateAnimation() {
        guard !reduceMotion, let window, window.isVisible, !window.isMiniaturized,
              window.occlusionState.contains(.visible), !isHiddenOrHasHiddenAncestor,
              !visibleRect.intersection(bounds).isEmpty, bounds.width > 0, bounds.height > 0 else {
            stopAnimating()
            return
        }
        guard !isAnimating else { return }
        // Same 1.5 s fill / 0.3 s fade as UploadActivityFrame and GTK.
        let rise = CAKeyframeAnimation(keyPath: "bounds.size.height")
        rise.values = [0, bounds.height, bounds.height]
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0.85, 0.85, 0]
        let start = CACurrentMediaTime()
        for animation in [rise, fade] {
            animation.keyTimes = [0, NSNumber(value: 1.5 / 1.8), 1]
            animation.duration = 1.8
            animation.repeatCount = .infinity
            animation.calculationMode = .linear
            animation.beginTime = start
        }
        fill.add(rise, forKey: "upload-fill")
        accent.add(fade, forKey: "upload-fade")
        animationStarts += 1
    }

    private func updateImages() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let symbol = NSImage(systemSymbolName: "arrow.up.circle.fill", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 14, weight: .medium))
            for (target, color) in [(base, NSColor(CloudTheme.secondary)), (accent, NSColor(CloudTheme.primary))] {
                let image = symbol?.withSymbolConfiguration(.init(paletteColors: [color]))
                target.contents = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
                target.contentsScale = window?.backingScaleFactor ?? 2
            }
        }
    }
}
