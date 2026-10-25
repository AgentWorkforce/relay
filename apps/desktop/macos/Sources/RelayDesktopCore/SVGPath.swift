import CoreGraphics
import Foundation

/// One step of an SVG path. Only the absolute commands used by the Agent
/// Relay mark are modelled: `M`, `L`, `C` and `Z`.
public enum SVGPathCommand: Equatable {
    case move(CGPoint)
    case line(CGPoint)
    case curve(control1: CGPoint, control2: CGPoint, to: CGPoint)
    case close
}

/// A very small parser for the subset of SVG path data the app ships with.
/// It deliberately refuses relative commands and arcs instead of guessing.
public enum SVGPath {
    public enum ParseError: Error, Equatable {
        case unsupportedCommand(String)
        case truncated
    }

    private static func isDigit(_ character: Character) -> Bool {
        character >= "0" && character <= "9"
    }

    private static func isSeparator(_ character: Character) -> Bool {
        character == " " || character == "," || character == "\n" || character == "\r" || character == "\t"
    }

    private static func isLetter(_ character: Character) -> Bool {
        (character >= "a" && character <= "z") || (character >= "A" && character <= "Z")
    }

    public static func parse(_ text: String) throws -> [SVGPathCommand] {
        let characters = Array(text)
        var index = 0
        var commands: [SVGPathCommand] = []

        func skipSeparators() {
            while index < characters.count, isSeparator(characters[index]) {
                index += 1
            }
        }

        func readNumber() throws -> CGFloat {
            skipSeparators()
            let start = index
            if index < characters.count, characters[index] == "-" || characters[index] == "+" {
                index += 1
            }
            var sawDigit = false
            while index < characters.count, isDigit(characters[index]) {
                index += 1
                sawDigit = true
            }
            if index < characters.count, characters[index] == "." {
                index += 1
                while index < characters.count, isDigit(characters[index]) {
                    index += 1
                    sawDigit = true
                }
            }
            if sawDigit, index < characters.count, characters[index] == "e" || characters[index] == "E" {
                let savedIndex = index
                index += 1
                if index < characters.count, characters[index] == "-" || characters[index] == "+" {
                    index += 1
                }
                var sawExponentDigit = false
                while index < characters.count, isDigit(characters[index]) {
                    index += 1
                    sawExponentDigit = true
                }
                if !sawExponentDigit {
                    index = savedIndex
                }
            }
            guard sawDigit else { throw ParseError.truncated }
            guard let value = Double(String(characters[start..<index])) else { throw ParseError.truncated }
            return CGFloat(value)
        }

        func readPoint() throws -> CGPoint {
            let x = try readNumber()
            let y = try readNumber()
            return CGPoint(x: x, y: y)
        }

        var currentCommand: Character?

        while index < characters.count {
            skipSeparators()
            if index >= characters.count { break }
            let character = characters[index]
            if isLetter(character) {
                currentCommand = character
                index += 1
            }
            guard let command = currentCommand else {
                throw ParseError.unsupportedCommand(String(character))
            }
            switch command {
            case "M":
                let start = try readPoint()
                commands.append(.move(start))
                // A repeated coordinate pair after a moveto is an implicit lineto.
                currentCommand = "L"
            case "L":
                let point = try readPoint()
                commands.append(.line(point))
            case "C":
                let control1 = try readPoint()
                let control2 = try readPoint()
                let end = try readPoint()
                commands.append(.curve(control1: control1, control2: control2, to: end))
            case "Z", "z":
                commands.append(.close)
                currentCommand = nil
            default:
                throw ParseError.unsupportedCommand(String(command))
            }
        }

        return commands
    }

    /// Every point the commands mention, including curve control points.
    public static func points(_ commands: [SVGPathCommand]) -> [CGPoint] {
        var result: [CGPoint] = []
        for command in commands {
            switch command {
            case .move(let point):
                result.append(point)
            case .line(let point):
                result.append(point)
            case .curve(let control1, let control2, let end):
                result.append(control1)
                result.append(control2)
                result.append(end)
            case .close:
                break
            }
        }
        return result
    }

    /// Bounding box over all points, control points included. A superset of
    /// the drawn bounds, which is what the layout code needs.
    public static func bounds(_ commands: [SVGPathCommand]) -> CGRect {
        let allPoints = points(commands)
        guard let first = allPoints.first else { return .null }
        var minX = first.x
        var maxX = first.x
        var minY = first.y
        var maxY = first.y
        for point in allPoints.dropFirst() {
            minX = min(minX, point.x)
            maxX = max(maxX, point.x)
            minY = min(minY, point.y)
            maxY = max(maxY, point.y)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// A transform that scales `viewBox` to fit inside `rect` without
    /// distortion and centres it. SVG y grows downwards, so pass
    /// `flipVertically: true` for AppKit's bottom-up drawing.
    public static func fittingTransform(viewBox: CGRect, into rect: CGRect, flipVertically: Bool) -> CGAffineTransform {
        guard viewBox.width > 0, viewBox.height > 0, rect.width > 0, rect.height > 0 else {
            return .identity
        }
        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        let scaledWidth = viewBox.width * scale
        let scaledHeight = viewBox.height * scale
        let offsetX = (rect.width - scaledWidth) / 2
        let offsetY = (rect.height - scaledHeight) / 2

        var transform: CGAffineTransform
        if flipVertically {
            transform = CGAffineTransform(
                translationX: rect.minX + offsetX,
                y: rect.minY + offsetY + scaledHeight
            )
            transform = transform.scaledBy(x: scale, y: -scale)
        } else {
            transform = CGAffineTransform(
                translationX: rect.minX + offsetX,
                y: rect.minY + offsetY
            )
            transform = transform.scaledBy(x: scale, y: scale)
        }
        transform = transform.translatedBy(x: -viewBox.minX, y: -viewBox.minY)
        return transform
    }

    /// Builds a `CGPath`, applying `transform` to every point.
    public static func cgPath(_ commands: [SVGPathCommand], transform: CGAffineTransform = .identity) -> CGPath {
        let path = CGMutablePath()
        for command in commands {
            switch command {
            case .move(let point):
                path.move(to: point, transform: transform)
            case .line(let point):
                path.addLine(to: point, transform: transform)
            case .curve(let control1, let control2, let end):
                path.addCurve(to: end, control1: control1, control2: control2, transform: transform)
            case .close:
                path.closeSubpath()
            }
        }
        return path
    }
}

/// The Agent Relay mark, taken from `assets/agent-relay-mark.svg`.
/// Kept as path data so the repository carries no binary image assets.
public enum BrandMarkPaths {
    public static let viewBox = CGRect(x: 0, y: 0, width: 112, height: 91)

    /// Light blue, the chevron in front.
    public static let frontColor = (red: 117.0 / 255.0, green: 184.0 / 255.0, blue: 226.0 / 255.0)
    /// Dark blue, the chevron behind.
    public static let backColor = (red: 63.0 / 255.0, green: 106.0 / 255.0, blue: 134.0 / 255.0)

    public static let frontPathData = "M71.3682 21.7098L54.042 39.036C50.6567 42.4213 50.6568 47.9099 54.042 51.2952L71.3727 68.6259L52.8321 87.1665C48.6005 91.3981 41.7397 91.3981 37.5081 87.1665L3.17369 52.8321C-1.05789 48.6005 -1.0579 41.7397 3.17369 37.5081L37.5081 3.17369C41.7397 -1.0579 48.6005 -1.05789 52.8321 3.17369L71.3682 21.7098Z"

    public static let backPathData = "M75.5711 72.8243C78.9563 76.2096 84.445 76.2096 87.8302 72.8243L109.359 51.2952C112.745 47.9099 112.745 42.4213 109.359 39.036L87.8302 17.507C84.445 14.1218 78.9563 14.1218 75.5711 17.507L71.3682 21.7098L88.6989 39.0405C92.0842 42.4258 92.0842 47.9144 88.6989 51.2997L71.3727 68.6259L75.5711 72.8243Z"

    /// The parsed commands. An unparsable constant would be a programming
    /// error, so the fallback is an empty path rather than a crash.
    public static var front: [SVGPathCommand] {
        (try? SVGPath.parse(frontPathData)) ?? []
    }

    public static var back: [SVGPathCommand] {
        (try? SVGPath.parse(backPathData)) ?? []
    }
}
