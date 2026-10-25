import AppKit
import SwiftUI
import XCTest
@testable import RelayDesktop
import RelayDesktopCore

@MainActor
final class UploadStatusIconTests: XCTestCase {
    private func raster<V: View>(_ view: V, width: CGFloat, height: CGFloat, dark: Bool) throws -> NSBitmapImageRep {
        let host = NSHostingView(rootView: view.environment(\.colorScheme, dark ? .dark : .light))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        defer { window.close() }
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        return bitmap
    }

    func testUploadedAndLocalIconsStayNeutral() async throws {
        for dark in [false, true] {
            let preview = HStack(spacing: 16) {
                SessionStatusCell(state: .local, stopping: false)
                UploadActivityGlyph(frame: UploadActivityFrame(elapsed: 0.75))
                    .font(.system(size: 14, weight: .medium)).frame(width: 28, height: 28)
                SessionStatusCell(state: .uploaded, stopping: false)
            }.padding(16).background(CloudTheme.background)
            let bitmap = try raster(preview, width: 148, height: 60, dark: dark)
            var greenPixels = 0
            for y in 0..<bitmap.pixelsHigh {
                for x in 0..<bitmap.pixelsWide {
                    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                    if color.greenComponent > color.blueComponent + 0.05 && color.greenComponent > color.redComponent + 0.12 {
                        greenPixels += 1
                    }
                }
            }
            XCTAssertEqual(greenPixels, 0, "Upload states should use neutral and accent colors, not green")
            if let folder = ProcessInfo.processInfo.environment["RELAY_UPLOAD_ICON_PREVIEW"] {
                let url = URL(fileURLWithPath: folder).appendingPathComponent("upload-icons-\(dark ? "dark" : "light").png")
                try bitmap.representation(using: .png, properties: [:])?.write(to: url)
            }
        }
    }

    func testRenderedUploadFillRisesFromBottomInBothThemes() async throws {
        for dark in [false, true] {
            var counts: [Int] = []
            for elapsed in [0.0, 0.75, 1.5] {
                let icon = UploadActivityGlyph(frame: UploadActivityFrame(elapsed: elapsed))
                    .font(.system(size: 48, weight: .medium))
                    .frame(width: 80, height: 80).background(CloudTheme.background)
                let bitmap = try raster(icon, width: 80, height: 80, dark: dark)
                var top = 0
                var bottom = 0
                for y in 0..<bitmap.pixelsHigh {
                    for x in 0..<bitmap.pixelsWide {
                        guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                              color.blueComponent - color.redComponent > 0.2 else { continue }
                        if y < bitmap.pixelsHigh / 2 { top += 1 } else { bottom += 1 }
                    }
                }
                counts.append(top + bottom)
                if elapsed == 0.75 {
                    XCTAssertGreaterThan(bottom, top, "The accent must fill upward from the bottom")
                }
            }
            XCTAssertEqual(counts[0], 0)
            XCTAssertGreaterThan(counts[1], counts[0])
            XCTAssertGreaterThan(counts[2], counts[1])
        }
    }
}
