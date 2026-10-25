// render-icon.swift -- draw the Agent Relay app icon into an .iconset.
//
// Run it as a script, no package or Xcode project needed:
//
//     swift scripts/render-icon.swift OUT_DIR
//
// It writes OUT_DIR/AppIcon.iconset with the seven pixel sizes macOS asks for
// (16, 32, 64, 128, 256, 512, 1024) under the ten @1x/@2x names `iconutil`
// expects, so the caller can finish with:
//
//     iconutil -c icns OUT_DIR/AppIcon.iconset -o AppIcon.icns
//
// The artwork is the Agent Relay mark from assets/agent-relay-mark.svg (viewBox
// 0 0 112 91, two paths, absolute M/L/C/Z commands only) centred on a dark navy
// Big Sur style squircle. The path data is inlined on purpose: docs/plan.md
// section 4 forbids binary image assets in the repository, and a script that
// parses the SVG at build time would add a dependency for no gain.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Artwork constants

/// Front (lighter) chevron of the mark.
let frontPathData = """
M71.3682 21.7098L54.042 39.036C50.6567 42.4213 50.6568 47.9099 54.042 51.2952\
L71.3727 68.6259L52.8321 87.1665C48.6005 91.3981 41.7397 91.3981 37.5081 87.1665\
L3.17369 52.8321C-1.05789 48.6005 -1.0579 41.7397 3.17369 37.5081L37.5081 3.17369\
C41.7397 -1.0579 48.6005 -1.05789 52.8321 3.17369L71.3682 21.7098Z
"""

/// Back (darker) chevron of the mark.
let backPathData = """
M75.5711 72.8243C78.9563 76.2096 84.445 76.2096 87.8302 72.8243L109.359 51.2952\
C112.745 47.9099 112.745 42.4213 109.359 39.036L87.8302 17.507C84.445 14.1218 78.9563 14.1218 75.5711 17.507\
L71.3682 21.7098L88.6989 39.0405C92.0842 42.4258 92.0842 47.9144 88.6989 51.2997\
L71.3727 68.6259L75.5711 72.8243Z
"""

let markViewBox = CGSize(width: 112, height: 91)

let frontColor = CGColor(red: 0x75 / 255.0, green: 0xB8 / 255.0, blue: 0xE2 / 255.0, alpha: 1)
let backColor = CGColor(red: 0x3F / 255.0, green: 0x6A / 255.0, blue: 0x86 / 255.0, alpha: 1)

/// Dark navy plate. A shallow top-to-bottom gradient around #0F1720 keeps the
/// icon from reading as a flat black square in the Dock.
let plateTopColor = CGColor(red: 0x18 / 255.0, green: 0x24 / 255.0, blue: 0x31 / 255.0, alpha: 1)
let plateBottomColor = CGColor(red: 0x0B / 255.0, green: 0x10 / 255.0, blue: 0x18 / 255.0, alpha: 1)
/// Hairline highlight along the top edge, as on stock macOS icons.
let plateRimColor = CGColor(red: 1, green: 1, blue: 1, alpha: 0.10)

/// Fraction of the canvas the squircle occupies. Apple's Big Sur icon grid puts
/// an 824 pt plate on a 1024 pt canvas.
let plateFraction: CGFloat = 824.0 / 1024.0
/// Fraction of the plate width the mark spans.
let markFraction: CGFloat = 0.60

/// Pixel sizes and the iconset file names that map onto them.
let iconsetEntries: [(pixels: Int, names: [String])] = [
    (16, ["icon_16x16.png"]),
    (32, ["icon_16x16@2x.png", "icon_32x32.png"]),
    (64, ["icon_32x32@2x.png"]),
    (128, ["icon_128x128.png"]),
    (256, ["icon_128x128@2x.png", "icon_256x256.png"]),
    (512, ["icon_256x256@2x.png", "icon_512x512.png"]),
    (1024, ["icon_512x512@2x.png"]),
]

// MARK: - Minimal SVG path parser (absolute M, L, C, Z only)

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("render-icon: error: \(message)\n".utf8))
    exit(1)
}

/// Parses the subset of the SVG path grammar the mark uses: absolute `M`, `L`,
/// `C` and `Z`. Anything else is a hard error rather than a silent misdraw.
func makePath(from data: String) -> CGPath {
    let path = CGMutablePath()
    let characters = Array(data)
    var index = 0
    var command: Character = " "
    var current = CGPoint.zero
    var start = CGPoint.zero

    func skipSeparators() {
        while index < characters.count {
            let character = characters[index]
            if character == " " || character == "," || character == "\n" || character == "\r" || character == "\t" {
                index += 1
            } else {
                break
            }
        }
    }

    func readNumber() -> CGFloat {
        skipSeparators()
        var text = ""
        if index < characters.count, characters[index] == "-" || characters[index] == "+" {
            text.append(characters[index])
            index += 1
        }
        while index < characters.count {
            let character = characters[index]
            if character.isNumber || character == "." {
                text.append(character)
                index += 1
            } else if character == "e" || character == "E" {
                text.append(character)
                index += 1
                if index < characters.count, characters[index] == "-" || characters[index] == "+" {
                    text.append(characters[index])
                    index += 1
                }
            } else {
                break
            }
        }
        guard let value = Double(text) else {
            fail("could not read a number at offset \(index) of the path data")
        }
        return CGFloat(value)
    }

    func readPoint() -> CGPoint {
        let x = readNumber()
        let y = readNumber()
        return CGPoint(x: x, y: y)
    }

    while index < characters.count {
        skipSeparators()
        guard index < characters.count else { break }
        let cursorBefore = index
        let character = characters[index]
        if character.isLetter {
            command = character
            index += 1
        }
        switch command {
        case "M":
            current = readPoint()
            start = current
            path.move(to: current)
            // A second coordinate pair after M is an implicit lineto.
            command = "L"
        case "L":
            current = readPoint()
            path.addLine(to: current)
        case "C":
            let control1 = readPoint()
            let control2 = readPoint()
            let end = readPoint()
            path.addCurve(to: end, control1: control1, control2: control2)
            current = end
        case "Z", "z":
            path.closeSubpath()
            current = start
            skipSeparators()
        default:
            fail("unsupported path command '\(command)'; only absolute M, L, C and Z are handled")
        }
        guard index > cursorBefore else {
            fail("stalled at offset \(index) of the path data after command '\(command)'")
        }
    }

    return path.copy() ?? path
}

/// A superellipse standing in for the Big Sur continuous-corner mask. n = 5 is
/// very close to Apple's plate and needs no corner-by-corner bezier fitting.
func squirclePath(in rect: CGRect, exponent: CGFloat = 5, samples: Int = 512) -> CGPath {
    let path = CGMutablePath()
    let a = rect.width / 2
    let b = rect.height / 2
    let centerX = rect.midX
    let centerY = rect.midY
    let power = 2 / exponent

    for step in 0...samples {
        let t = (CGFloat(step) / CGFloat(samples)) * 2 * .pi
        let cosT = cos(t)
        let sinT = sin(t)
        let x = centerX + a * CGFloat(copysign(pow(abs(Double(cosT)), Double(power)), Double(cosT)))
        let y = centerY + b * CGFloat(copysign(pow(abs(Double(sinT)), Double(power)), Double(sinT)))
        if step == 0 {
            path.move(to: CGPoint(x: x, y: y))
        } else {
            path.addLine(to: CGPoint(x: x, y: y))
        }
    }
    path.closeSubpath()
    return path.copy() ?? path
}

// MARK: - Drawing

func renderIcon(pixels: Int) -> CGImage {
    let size = CGFloat(pixels)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fail("could not create a \(pixels)x\(pixels) bitmap context")
    }

    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    context.interpolationQuality = .high

    let plateSide = size * plateFraction
    let plateRect = CGRect(
        x: (size - plateSide) / 2,
        y: (size - plateSide) / 2,
        width: plateSide,
        height: plateSide
    )
    let plate = squirclePath(in: plateRect, samples: max(128, pixels))

    // Plate, filled with a vertical gradient. CGContext is y-up, so the "top"
    // colour belongs at the higher y.
    context.saveGState()
    context.addPath(plate)
    context.clip()
    if let gradient = CGGradient(
        colorsSpace: colorSpace,
        colors: [plateBottomColor, plateTopColor] as CFArray,
        locations: [0, 1]
    ) {
        context.drawLinearGradient(
            gradient,
            start: CGPoint(x: plateRect.midX, y: plateRect.minY),
            end: CGPoint(x: plateRect.midX, y: plateRect.maxY),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    } else {
        context.setFillColor(plateTopColor)
        context.fill(plateRect)
    }
    context.restoreGState()

    // Hairline rim, drawn inside the plate so it never bleeds past the edge.
    if pixels >= 64 {
        context.saveGState()
        context.addPath(plate)
        context.clip()
        context.addPath(plate)
        context.setStrokeColor(plateRimColor)
        context.setLineWidth(max(1, size / 256))
        context.strokePath()
        context.restoreGState()
    }

    // The mark, mapped from the SVG's y-down viewBox into the y-up context.
    let markWidth = plateSide * markFraction
    let scale = markWidth / markViewBox.width
    let markHeight = markViewBox.height * scale
    let originX = (size - markWidth) / 2
    let originY = (size - markHeight) / 2
    var transform = CGAffineTransform(
        a: scale, b: 0,
        c: 0, d: -scale,
        tx: originX, ty: originY + markHeight
    )

    let front = makePath(from: frontPathData)
    let back = makePath(from: backPathData)

    context.saveGState()
    // SVG paint order: the lighter chevron first, the darker one over it.
    context.addPath(front.copy(using: &transform) ?? front)
    context.setFillColor(frontColor)
    context.fillPath(using: .evenOdd)

    context.addPath(back.copy(using: &transform) ?? back)
    context.setFillColor(backColor)
    context.fillPath(using: .winding)
    context.restoreGState()

    guard let image = context.makeImage() else {
        fail("could not snapshot the \(pixels)x\(pixels) bitmap context")
    }
    return image
}

func writePNG(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        fail("could not create a PNG writer for \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fail("could not write \(url.path)")
    }
}

// MARK: - Entry point

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("-h") || arguments.contains("--help") {
    print("""
    Usage: swift scripts/render-icon.swift OUT_DIR

    Writes OUT_DIR/AppIcon.iconset with the Agent Relay app icon at 16, 32, 64,
    128, 256, 512 and 1024 pixels. Finish with:

        iconutil -c icns OUT_DIR/AppIcon.iconset -o AppIcon.icns
    """)
    exit(0)
}
guard let outputArgument = arguments.first, !outputArgument.isEmpty else {
    fail("missing OUT_DIR; usage: swift scripts/render-icon.swift OUT_DIR")
}

let outputDirectory = URL(fileURLWithPath: outputArgument, isDirectory: true)
let iconsetDirectory = outputDirectory.appendingPathComponent("AppIcon.iconset", isDirectory: true)

do {
    if FileManager.default.fileExists(atPath: iconsetDirectory.path) {
        try FileManager.default.removeItem(at: iconsetDirectory)
    }
    try FileManager.default.createDirectory(at: iconsetDirectory, withIntermediateDirectories: true)
} catch {
    fail("could not prepare \(iconsetDirectory.path): \(error.localizedDescription)")
}

for entry in iconsetEntries {
    let image = renderIcon(pixels: entry.pixels)
    for name in entry.names {
        writePNG(image, to: iconsetDirectory.appendingPathComponent(name))
    }
}

print("render-icon: wrote \(iconsetEntries.reduce(0) { $0 + $1.names.count }) PNGs to \(iconsetDirectory.path)")
