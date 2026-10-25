import AppKit
import SwiftUI

/// Cloud's effective workspace palette, not its marketing/airframe fallback.
/// Source: cloud/packages/web/app/dashboard/_components/workspace-chrome.module.css.
/// Session spacing and grouping: dashboard/sessions/sessions.module.css.
/// Dynamic NSColors preserve the existing Light / Dark / Match system setting.
enum CloudTheme {
    static let background = color(0xf9fafb, 0x14191f)
    static let foreground = color(0x111827, 0xedf4fb)
    static let card = color(0xffffff, 0x1a2129)
    static let sidebar = color(0xffffff, 0x10151b)
    static let muted = color(0xf3f4f6, 0x1d252e)
    static let secondary = color(0x4b5563, 0xa8b8c8)
    static let primary = color(0x2d6a9c, 0x74b8e2)
    static let hover = color(0xe7eff7, 0x223e58)
    static let selectedText = color(0x26557e, 0x99c2e0)
    static let border = color(0x4a90c2, 0xa8b8c8, lightAlpha: 0.16, darkAlpha: 0.13)
    static let input = color(0xc9ddee, 0x74b8e2, darkAlpha: 0.32)
    static let ring = color(0x4a90c2, 0x74b8e2)
    static let messageConnecting = color(0xaa7d12, 0xe5bf55)
    static let success = color(0x1d9f73, 0x63d18b)
    static let warning = Color(nsColor: warningColor)
    /// The warning orange for AppKit drawing, such as the menu bar icon.
    static let warningColor = dynamic(0xc1674b, 0xce9178)
    static let danger = color(0xd95b63, 0xf0727f)
    // Toggle tracks retain contrast with the light thumb in both appearances.
    static let settingsAction = color(0x245580, 0x245580)
    static let settingsDanger = color(0x9b2335, 0xffa8b2)
    static let codeBackground = Color(nsColor: rgb(0x0d1723))
    static let codeForeground = Color(nsColor: rgb(0xdbe5f0))
    static let codeMuted = Color(nsColor: rgb(0x7c8a9b))

    static func previewBackground(dark: Bool) -> Color { Color(nsColor: rgb(dark ? 0x14191f : 0xf9fafb)) }
    static func previewPanel(dark: Bool) -> Color { Color(nsColor: rgb(dark ? 0x1d252e : 0xf3f4f6)) }
    static func previewBorder(dark: Bool) -> Color { Color(nsColor: rgb(dark ? 0x39434d : 0xdde9f2)) }

    private static func color(_ light: UInt32, _ dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) -> Color {
        Color(nsColor: dynamic(light, dark, lightAlpha: lightAlpha, darkAlpha: darkAlpha))
    }

    private static func dynamic(_ light: UInt32, _ dark: UInt32, lightAlpha: Double = 1, darkAlpha: Double = 1) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? rgb(dark, alpha: darkAlpha) : rgb(light, alpha: lightAlpha)
        }
    }

    private static func rgb(_ hex: UInt32, alpha: Double = 1) -> NSColor {
        NSColor(srgbRed: Double((hex >> 16) & 255) / 255,
                green: Double((hex >> 8) & 255) / 255,
                blue: Double(hex & 255) / 255, alpha: alpha)
    }
}

/// Native menu tracking provides arrow keys, type-ahead, Enter and Escape.
/// A pull-down opens below the field instead of nesting another speech bubble.
struct CloudSelect<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let options: [(Value, String)]

    var body: some View {
        CloudDropdown(title: title, selection: $selection, options: options)
            .frame(maxWidth: .infinity).frame(height: 28)
            .background(CloudTheme.background, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(CloudTheme.input).allowsHitTesting(false))
    }
}

struct CloudDropdown<Value: Hashable>: NSViewRepresentable {
    let title: String
    @Binding var selection: Value
    let options: [(Value, String)]

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> CloudDropdownButton {
        let button = CloudDropdownButton(frame: .zero, pullsDown: true)
        button.cell = CloudDropdownCell(textCell: "", pullsDown: true)
        button.isBordered = false
        button.preferredEdge = .minY
        button.autoenablesItems = false
        button.font = .systemFont(ofSize: 12)
        button.focusRingType = .exterior
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.target = context.coordinator
        button.action = #selector(Coordinator.choose(_:))
        return button
    }
    func updateNSView(_ button: CloudDropdownButton, context: Context) {
        context.coordinator.parent = self
        let labels = options.map(\.1)
        if Array(button.itemTitles.dropFirst()) != labels {
            button.removeAllItems()
            // AppKit reserves the first item as the pull-down's title.
            button.addItem(withTitle: "")
            button.addItems(withTitles: labels)
        }
        let index = options.firstIndex { $0.0 == selection } ?? 0
        button.selectItem(at: index + 1)
        button.item(at: 0)?.title = options.indices.contains(index) ? options[index].1 : title
        for (offset, item) in button.itemArray.enumerated() {
            item.state = offset == index + 1 ? .on : .off
        }
        button.setAccessibilityLabel(title)
        button.setAccessibilityValue(options.indices.contains(index) ? options[index].1 : title)
        button.menu?.minimumWidth = button.bounds.width
        button.needsLayout = true
    }
    final class Coordinator: NSObject {
        var parent: CloudDropdown
        init(_ parent: CloudDropdown) { self.parent = parent }
        @objc func choose(_ sender: NSPopUpButton) {
            let index = sender.indexOfSelectedItem - 1
            guard parent.options.indices.contains(index) else { return }
            parent.selection = parent.options[index].0
        }
    }
}

private final class CloudDropdownCell: NSPopUpButtonCell {
    override func titleRect(forBounds rect: NSRect) -> NSRect {
        let frame = super.titleRect(forBounds: rect)
        return NSRect(x: frame.minX + 8, y: frame.minY, width: max(0, frame.width - 8), height: frame.height)
    }
}

final class CloudDropdownButton: NSPopUpButton {
    override var alignmentRectInsets: NSEdgeInsets { NSEdgeInsetsZero }

    override func layout() {
        super.layout()
        menu?.minimumWidth = bounds.width
    }
    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

struct CloudControlStyle: ButtonStyle {
    var flat = false
    var height: CGFloat = 28
    var horizontalPadding: CGFloat = 10
    func makeBody(configuration: Configuration) -> some View {
        Control(configuration: configuration, flat: flat, height: height, horizontalPadding: horizontalPadding)
    }
    private struct Control: View {
        let configuration: Configuration
        let flat: Bool
        let height: CGFloat
        let horizontalPadding: CGFloat
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovered = false
        var body: some View {
            configuration.label.font(.system(size: 12)).foregroundStyle(CloudTheme.foreground)
                .padding(.horizontal, horizontalPadding).frame(height: height)
                .background(isEnabled && (hovered || configuration.isPressed) ? CloudTheme.hover : flat ? .clear : CloudTheme.background,
                            in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(flat ? .clear : CloudTheme.input))
                .contentShape(Rectangle()).onHover { hovered = $0 }
                .opacity(isEnabled ? 1 : 0.45)
                .actionCursor()
        }
    }
}

struct CloudMenuOption: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "checkmark").opacity(selected ? 1 : 0)
            }
        }.buttonStyle(CloudControlStyle(flat: true))
            .accessibilityValue(selected ? "Selected" : "Not selected")
    }
}

/// Reassert the cursor as the pointer moves: hosting views can replace cursor rectangles.
/// Do not push onto NSCursor's global stack; nested controls and disappearing rows
/// must not leave a stale hand cursor behind.
struct ActionCursor: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @State private var pointer = ActionCursorState()

    func body(content: Content) -> some View {
        content
            .onContinuousHover { phase in
                switch phase {
                case .active: pointer.enter(enabled: isEnabled)
                case .ended: pointer.leave()
                }
            }
            .onChange(of: isEnabled) { pointer.enabledChanged($0) }
            .onDisappear { pointer.leave() }
    }
}

/// Cursor ownership lasts only while the pointer is over this control.
struct ActionCursorState {
    private var hovering = false

    mutating func enter(enabled: Bool) {
        hovering = true
        (enabled ? NSCursor.pointingHand : NSCursor.arrow).set()
    }

    func enabledChanged(_ enabled: Bool) {
        if hovering { (enabled ? NSCursor.pointingHand : NSCursor.arrow).set() }
    }

    mutating func leave() {
        guard hovering else { return }
        hovering = false
        NSCursor.arrow.set()
    }
}

extension View {
    func actionCursor() -> some View { modifier(ActionCursor()) }
}

/// Preserve native button rendering and keyboard behavior while adding hover
/// feedback and the same cursor as our custom controls.
struct NativeActionButtonStyle<Base: PrimitiveButtonStyle>: PrimitiveButtonStyle {
    let base: Base

    func makeBody(configuration: Configuration) -> some View {
        base.makeBody(configuration: configuration).modifier(NativeActionHover())
    }

    private struct NativeActionHover: ViewModifier {
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovered = false

        func body(content: Content) -> some View {
            content
                .overlay(RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(CloudTheme.ring.opacity(hovered && isEnabled ? 0.6 : 0))
                    .allowsHitTesting(false))
                .onHover { hovered = $0 }
                .actionCursor()
        }
    }
}
