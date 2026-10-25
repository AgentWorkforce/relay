import SwiftUI

/// Canonical Agent Relay action. Brand colors are independent of workspace accents.
/// Matches the compact web button's 10/10/10/3 tail corners and dark border.
enum AgentRelayButtonTheme {
    static let background = Color(red: 45 / 255, green: 106 / 255, blue: 156 / 255)
    // Darken on hover to retain 4.5:1 contrast with the white label.
    static let hover = Color(red: 38 / 255, green: 85 / 255, blue: 126 / 255)
    static let foreground = Color.white
    static let border = Color(red: 35 / 255, green: 73 / 255, blue: 105 / 255)
}

/// The tight bottom-left corner is part of the brand, not a per-screen option.
struct AgentRelayButtonShape: Shape {
    func path(in rect: CGRect) -> Path {
        let radius = min(10, min(rect.width, rect.height) / 2)
        let tail = min(3, radius)
        let x = rect.minX, y = rect.minY, right = rect.maxX, bottom = rect.maxY
        var path = Path()
        path.move(to: CGPoint(x: x + radius, y: y))
        path.addLine(to: CGPoint(x: right - radius, y: y))
        path.addQuadCurve(to: CGPoint(x: right, y: y + radius), control: CGPoint(x: right, y: y))
        path.addLine(to: CGPoint(x: right, y: bottom - radius))
        path.addQuadCurve(to: CGPoint(x: right - radius, y: bottom), control: CGPoint(x: right, y: bottom))
        path.addLine(to: CGPoint(x: x + tail, y: bottom))
        path.addQuadCurve(to: CGPoint(x: x, y: bottom - tail), control: CGPoint(x: x, y: bottom))
        path.addLine(to: CGPoint(x: x, y: y + radius))
        path.addQuadCurve(to: CGPoint(x: x + radius, y: y), control: CGPoint(x: x, y: y))
        path.closeSubpath()
        return path
    }
}

/// Every blue action uses this style; only sizing may vary at call sites.
struct AgentRelayPrimaryButtonStyle: ButtonStyle {
    var height: CGFloat = 28
    var horizontalPadding: CGFloat = 12
    var fontSize: CGFloat = 12
    var expands = false

    func makeBody(configuration: Configuration) -> some View {
        PrimaryBody(configuration: configuration, style: self)
    }

    private struct PrimaryBody: View {
        let configuration: Configuration
        let style: AgentRelayPrimaryButtonStyle
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.isFocused) private var isFocused
        @State private var hovered = false
        private var pressed: Bool { isEnabled && configuration.isPressed }

        var body: some View {
            configuration.label
                .font(.system(size: style.fontSize, weight: .semibold))
                .foregroundStyle(AgentRelayButtonTheme.foreground)
                .padding(.horizontal, style.horizontalPadding)
                .frame(maxWidth: style.expands ? .infinity : nil, minHeight: style.height)
                .background(isEnabled && hovered ? AgentRelayButtonTheme.hover : AgentRelayButtonTheme.background,
                            in: AgentRelayButtonShape())
                .overlay(AgentRelayButtonShape().stroke(AgentRelayButtonTheme.border, lineWidth: 1.5).padding(0.75))
                .overlay(AgentRelayButtonShape().fill(.black.opacity(pressed ? 0.08 : 0)))
                .overlay(AgentRelayButtonShape().stroke(CloudTheme.ring,
                            lineWidth: isFocused && isEnabled ? 2 : 0).padding(-3))
                .opacity(isEnabled ? 1 : 0.5)
                .contentShape(AgentRelayButtonShape())
                .onHover { hovered = $0 }
                .actionCursor()
        }
    }
}
