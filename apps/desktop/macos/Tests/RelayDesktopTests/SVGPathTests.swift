import CoreGraphics
import XCTest
@testable import RelayDesktopCore

final class SVGPathTests: XCTestCase {
    private func counts(_ commands: [SVGPathCommand]) -> (moves: Int, lines: Int, curves: Int, closes: Int) {
        var moves = 0
        var lines = 0
        var curves = 0
        var closes = 0
        for command in commands {
            switch command {
            case .move:
                moves += 1
            case .line:
                lines += 1
            case .curve:
                curves += 1
            case .close:
                closes += 1
            }
        }
        return (moves, lines, curves, closes)
    }

    func testParsesSimplePath() throws {
        let commands = try SVGPath.parse("M0 0L10 0C10 5 5 10 0 10Z")
        XCTAssertEqual(commands.count, 4)
        XCTAssertEqual(commands[0], .move(CGPoint(x: 0, y: 0)))
        XCTAssertEqual(commands[1], .line(CGPoint(x: 10, y: 0)))
        XCTAssertEqual(
            commands[2],
            .curve(control1: CGPoint(x: 10, y: 5), control2: CGPoint(x: 5, y: 10), to: CGPoint(x: 0, y: 10))
        )
        XCTAssertEqual(commands[3], .close)
    }

    func testParsesNegativeAndCommaSeparatedNumbers() throws {
        let commands = try SVGPath.parse("M-1.5,-2.25 L 3 4")
        XCTAssertEqual(commands.count, 2)
        XCTAssertEqual(commands[0], .move(CGPoint(x: -1.5, y: -2.25)))
        XCTAssertEqual(commands[1], .line(CGPoint(x: 3, y: 4)))
    }

    func testRepeatedPairsAfterMoveAreLines() throws {
        let commands = try SVGPath.parse("M0 0 1 1 2 2")
        XCTAssertEqual(counts(commands).moves, 1)
        XCTAssertEqual(counts(commands).lines, 2)
    }

    func testRejectsRelativeCommands() {
        XCTAssertThrowsError(try SVGPath.parse("m0 0l10 10")) { error in
            XCTAssertEqual(error as? SVGPath.ParseError, SVGPath.ParseError.unsupportedCommand("m"))
        }
    }

    func testFrontMarkHasTheExpectedCommands() throws {
        let commands = try SVGPath.parse(BrandMarkPaths.frontPathData)
        XCTAssertEqual(commands.count, 12)
        let tally = counts(commands)
        XCTAssertEqual(tally.moves, 1)
        XCTAssertEqual(tally.lines, 6)
        XCTAssertEqual(tally.curves, 4)
        XCTAssertEqual(tally.closes, 1)
    }

    func testBackMarkHasTheExpectedCommands() throws {
        let commands = try SVGPath.parse(BrandMarkPaths.backPathData)
        XCTAssertEqual(commands.count, 12)
        let tally = counts(commands)
        XCTAssertEqual(tally.moves, 1)
        XCTAssertEqual(tally.lines, 6)
        XCTAssertEqual(tally.curves, 4)
        XCTAssertEqual(tally.closes, 1)
    }

    func testMarkBoundsStayInsideTheViewBox() {
        let front = SVGPath.bounds(BrandMarkPaths.front)
        let back = SVGPath.bounds(BrandMarkPaths.back)
        let union = front.union(back)
        // Control points sit a hair outside the view box; allow 2 units.
        XCTAssertGreaterThan(union.minX, -2)
        XCTAssertGreaterThan(union.minY, -2)
        XCTAssertLessThan(union.maxX, BrandMarkPaths.viewBox.width + 2)
        XCTAssertLessThan(union.maxY, BrandMarkPaths.viewBox.height + 2)
        XCTAssertGreaterThan(union.width, 100)
        XCTAssertGreaterThan(union.height, 80)
        XCTAssertFalse(BrandMarkPaths.front.isEmpty)
        XCTAssertFalse(BrandMarkPaths.back.isEmpty)
    }

    func testFittingTransformCentresAndScales() {
        let viewBox = CGRect(x: 0, y: 0, width: 112, height: 91)
        let target = CGRect(x: 0, y: 0, width: 18, height: 18)
        let transform = SVGPath.fittingTransform(viewBox: viewBox, into: target, flipVertically: false)
        let scale = 18.0 / 112.0
        let scaledHeight = 91.0 * scale
        let topLeft = CGPoint(x: 0, y: 0).applying(transform)
        let bottomRight = CGPoint(x: 112, y: 91).applying(transform)
        XCTAssertEqual(Double(topLeft.x), 0, accuracy: 0.001)
        XCTAssertEqual(Double(topLeft.y), (18.0 - scaledHeight) / 2, accuracy: 0.001)
        XCTAssertEqual(Double(bottomRight.x), 18, accuracy: 0.001)
        XCTAssertEqual(Double(bottomRight.y), (18.0 + scaledHeight) / 2, accuracy: 0.001)
    }

    func testFlippedTransformPutsTheTopOfTheViewBoxAtTheTop() {
        let viewBox = CGRect(x: 0, y: 0, width: 112, height: 91)
        let target = CGRect(x: 0, y: 0, width: 18, height: 18)
        let transform = SVGPath.fittingTransform(viewBox: viewBox, into: target, flipVertically: true)
        let top = CGPoint(x: 0, y: 0).applying(transform)
        let bottom = CGPoint(x: 0, y: 91).applying(transform)
        XCTAssertGreaterThan(top.y, bottom.y)
        XCTAssertEqual(Double(bottom.y), (18.0 - 91.0 * (18.0 / 112.0)) / 2, accuracy: 0.001)
    }

    func testBuildsACGPath() {
        let path = SVGPath.cgPath(BrandMarkPaths.front)
        XCTAssertFalse(path.isEmpty)
        XCTAssertFalse(path.boundingBoxOfPath.isNull)
    }
}
