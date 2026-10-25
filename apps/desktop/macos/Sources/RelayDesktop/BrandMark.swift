import AppKit
import CoreGraphics
import RelayDesktopCore
import SwiftUI

/// The Agent Relay mark, drawn from the path data in `RelayDesktopCore`.
enum BrandMark {
    static let menuBarLength: CGFloat = 18

    /// What the menu bar icon says without opening the panel.
    enum MenuBarState: Equatable {
        case normal
        /// Messages and uploads are paused: the mark is dimmed.
        case paused
        /// Something stops messages or uploads: the mark is drawn in the
        /// warning orange.
        case attention
    }

    /// The menu bar image. With no `tint` it is a template image: black, so
    /// macOS tints it for light and dark menu bars. A `tint` draws it in that
    /// colour instead, which sets Agent Relay Dev apart from the release app.
    /// Needing attention draws it in the warning orange, over any tint.
    /// The chevron behind is drawn at half strength.
    static func menuBarImage(
        length: CGFloat = BrandMark.menuBarLength,
        state: MenuBarState = .normal,
        tint: NSColor? = nil
    ) -> NSImage {
        let tint = state == .attention ? CloudTheme.warningColor : tint
        let color = tint ?? .black
        let size = NSSize(width: length, height: length)
        let image = NSImage(size: size, flipped: false) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return true }
            let transform = SVGPath.fittingTransform(
                viewBox: BrandMarkPaths.viewBox,
                into: rect,
                flipVertically: true
            )
            let strength: CGFloat = state == .paused ? 0.35 : 1
            context.saveGState()
            context.setFillColor(color.withAlphaComponent(0.5 * strength).cgColor)
            context.addPath(SVGPath.cgPath(BrandMarkPaths.back, transform: transform))
            context.fillPath()
            context.setFillColor(color.withAlphaComponent(strength).cgColor)
            context.addPath(SVGPath.cgPath(BrandMarkPaths.front, transform: transform))
            context.fillPath(using: .evenOdd)
            context.restoreGState()
            return true
        }
        image.isTemplate = tint == nil
        return image
    }
}

/// One of the two chevrons, scaled to fit whatever space it is given.
struct BrandMarkShape: Shape {
    enum Layer {
        case front
        case back
    }

    var layer: Layer

    func path(in rect: CGRect) -> Path {
        let commands = layer == .front ? BrandMarkPaths.front : BrandMarkPaths.back
        let transform = SVGPath.fittingTransform(
            viewBox: BrandMarkPaths.viewBox,
            into: rect,
            flipVertically: false
        )
        return Path(SVGPath.cgPath(commands, transform: transform))
    }
}

/// The full-colour mark, for the sign-in window.
struct BrandMarkView: View {
    var width: CGFloat = 96

    private var height: CGFloat {
        width * (BrandMarkPaths.viewBox.height / BrandMarkPaths.viewBox.width)
    }

    private var frontColor: Color {
        Color(
            red: BrandMarkPaths.frontColor.red,
            green: BrandMarkPaths.frontColor.green,
            blue: BrandMarkPaths.frontColor.blue
        )
    }

    private var backColor: Color {
        Color(
            red: BrandMarkPaths.backColor.red,
            green: BrandMarkPaths.backColor.green,
            blue: BrandMarkPaths.backColor.blue
        )
    }

    var body: some View {
        ZStack {
            BrandMarkShape(layer: .front).fill(frontColor)
            BrandMarkShape(layer: .back).fill(backColor)
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
}

/// The menu bar item's label. It is also the app's earliest live view, so it
/// is where SwiftUI's window-opening action is handed to the model.
struct MenuBarLabel: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var relay: RelayModel
    @Environment(\.openWindow) private var openWindow

    private var state: BrandMark.MenuBarState {
        if model.relayProblem(relay) != nil { return .attention }
        return model.isPaused ? .paused : .normal
    }

    var body: some View {
        Image(nsImage: BrandMark.menuBarImage(state: state, tint: AppInfo.isDevelopment ? .systemGreen : nil))
            .accessibilityLabel(AppInfo.displayName)
            .accessibilityValue(state == .paused ? "Paused" : state == .attention ? "Needs attention" : "")
            // This handler stays mounted when the main window is closed.
            .onOpenURL { model.openConnection($0) }
            .onAppear {
                model.registerOpenWindow { identifier in
                    openWindow(id: identifier)
                }
            }
    }
}

/// Canonical Agent Relay wordmark from the website brand kit, kept as vector
/// outlines so its lettering stays exact at every display scale.
private struct BrandWordmarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        let transform = SVGPath.fittingTransform(viewBox: BrandWordmarkPaths.viewBox, into: rect, flipVertically: false)
        return Path(SVGPath.cgPath(BrandWordmarkPaths.commands, transform: transform))
    }
}

struct BrandWordmarkView: View {
    var height: CGFloat = 24

    var body: some View {
        BrandWordmarkShape()
            .fill(.foreground)
            .frame(width: height * BrandWordmarkPaths.viewBox.width / BrandWordmarkPaths.viewBox.height, height: height)
            .accessibilityLabel("Agent Relay")
    }
}
