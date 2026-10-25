import AppKit
import QuartzCore
import XCTest
@testable import RelayDesktop

@MainActor
final class UploadActivityLayerTests: XCTestCase {
    private func settle() async throws {
        try await Task.sleep(nanoseconds: 100_000_000)
    }

    func testAnimationStaysInLayersAcrossUnchangedUpdatesAndRespectsReducedMotion() async throws {
        let view = UploadActivityLayerView(reduceMotion: false)
        let window = UploadTestWindow(contentRect: NSRect(x: 80, y: 80, width: 28, height: 28),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        defer { window.close() }
        window.orderFrontRegardless()
        window.signalVisibilityChange()
        view.layoutSubtreeIfNeeded()
        try await settle()
        XCTAssertTrue(view.isAnimating, "An exposed upload glyph should animate")
        let starts = view.animationStarts
        for _ in 0..<100 {
            view.setReducedMotion(false)
            view.needsLayout = true
            view.layoutSubtreeIfNeeded()
        }
        XCTAssertEqual(view.animationStarts, starts, "Refreshing the row must not restart its compositor animation")
        view.setReducedMotion(true)
        XCTAssertFalse(view.isAnimating, "Reduced motion must stop the compositor, not just hide its result")
        let accent = try XCTUnwrap(view.layer?.sublayers?.last)
        XCTAssertEqual(accent.opacity, 0.85)
        XCTAssertEqual(accent.mask?.bounds.height, view.bounds.height, "Reduced motion displays the full arrow")
        view.setReducedMotion(false)
        XCTAssertTrue(view.isAnimating, "An exposed upload glyph should animate")
        view.isHidden = true
        XCTAssertFalse(view.isAnimating)
        view.isHidden = false
        XCTAssertTrue(view.isAnimating, "An exposed upload glyph should animate")
        window.orderOut(nil)
        window.signalVisibilityChange()
        try await settle()
        XCTAssertFalse(view.isAnimating, "A closed or hidden window must not keep the upload animation running")
    }

    func testReducedMotionNativeLayerRendersAccentArrowInBothThemes() throws {
        for dark in [false, true] {
            let view = UploadActivityLayerView(reduceMotion: true)
            let window = UploadTestWindow(contentRect: NSRect(x: 0, y: 0, width: 28, height: 28),
                                          styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = view
            defer { window.close() }
            view.frame = NSRect(x: 0, y: 0, width: 28, height: 28)
            view.layoutSubtreeIfNeeded()
            XCTAssertFalse(view.isAnimating)
            let layer = try XCTUnwrap(view.layer)
            let accent = try XCTUnwrap(layer.sublayers?.last)
            XCTAssertNotNil(accent.contents, "The native symbol must have a raster image")
            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 56, pixelsHigh: 56,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            let context = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
            context.cgContext.clear(CGRect(x: 0, y: 0, width: 56, height: 56))
            context.cgContext.scaleBy(x: 2, y: 2)
            layer.render(in: context.cgContext)
            var accentPixels = 0
            for y in 0..<bitmap.pixelsHigh {
                for x in 0..<bitmap.pixelsWide {
                    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                          color.alphaComponent > 0.1 else { continue }
                    if color.blueComponent - color.redComponent > 0.2 { accentPixels += 1 }
                }
            }
            XCTAssertGreaterThan(accentPixels, 20, "Native reduced-motion arrow must be visibly blue in \(dark ? "dark" : "light") appearance")
        }
    }

    func testOcclusionStopsAnimationAndVisibilityRestartsItOnce() async throws {
        let view = UploadActivityLayerView(reduceMotion: false)
        let window = UploadTestWindow(contentRect: NSRect(x: 80, y: 80, width: 28, height: 28),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        defer { window.close() }
        window.orderFrontRegardless()
        view.layoutSubtreeIfNeeded()
        window.signalVisibilityChange()
        XCTAssertTrue(view.isAnimating)
        let starts = view.animationStarts
        window.setOccluded(true)
        XCTAssertFalse(view.isAnimating, "An ordered-in but fully occluded window must stop the compositor")
        window.setOccluded(false)
        XCTAssertTrue(view.isAnimating)
        XCTAssertEqual(view.animationStarts, starts + 1)
        window.signalVisibilityChange()
        XCTAssertEqual(view.animationStarts, starts + 1, "Repeated visible notifications must not restart the animation")
    }

    func testDetachedAndOffscreenUploadViewsDoNotAnimate() async throws {
        let view = UploadActivityLayerView(reduceMotion: false)
        view.frame = NSRect(x: 0, y: 0, width: 16, height: 16)
        view.layoutSubtreeIfNeeded()
        XCTAssertFalse(view.isAnimating)

        let document = NSView(frame: NSRect(x: 0, y: 0, width: 40, height: 400))
        document.addSubview(view)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 40, height: 40))
        scroll.documentView = document
        let window = UploadTestWindow(contentRect: NSRect(x: 120, y: 80, width: 40, height: 40),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        defer { window.close() }
        scroll.contentView.scroll(to: .zero)
        window.orderFrontRegardless()
        window.signalVisibilityChange()
        view.layoutSubtreeIfNeeded()
        try await settle()
        XCTAssertTrue(view.isAnimating, "An exposed upload glyph should animate")
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 200))
        scroll.reflectScrolledClipView(scroll.contentView)
        try await settle()
        XCTAssertFalse(view.isAnimating, "A glyph outside the clip bounds must stop animating")
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        try await settle()
        XCTAssertTrue(view.isAnimating, "An exposed upload glyph should animate")
        view.removeFromSuperview()
        XCTAssertFalse(view.isAnimating)
    }
}

/// XCTest's windows can be ordered in yet occluded by the user's foreground
/// app. Control only this external input; retain real NSWindow ordering,
/// native view attachment/clipping and the production notification observer.
@MainActor
private final class UploadTestWindow: NSWindow {
    private var testOcclusion: NSWindow.OcclusionState = .visible
    override var occlusionState: NSWindow.OcclusionState { testOcclusion }

    func setOccluded(_ value: Bool) {
        testOcclusion = value ? [] : .visible
        signalVisibilityChange()
    }

    func signalVisibilityChange() {
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: self)
    }
}
