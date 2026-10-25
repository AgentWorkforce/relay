import AppKit
import XCTest

/// OCR fixtures use fixed Retina pixel density independent of the runner's
/// attached display. Point dimensions and all recognition/geometry assertions
/// remain unchanged; CI still decides whether the runner-specific failure is fixed.
@MainActor
enum SessionRenderFixture {
    static func bitmap(for view: NSView) throws -> NSBitmapImageRep {
        let scale: CGFloat = 2
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(view.bounds.width * scale),
            pixelsHigh: Int(view.bounds.height * scale), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ))
        bitmap.size = view.bounds.size
        view.cacheDisplay(in: view.bounds, to: bitmap)
        return bitmap
    }
}
