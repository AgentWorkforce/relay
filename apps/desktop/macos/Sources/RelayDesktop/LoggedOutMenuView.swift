import AppKit
import SwiftUI

/// The signed-out menu is a small introduction to Relay. The terminals are
/// illustrative, never a roster or an indication that local agents are running.
struct LoggedOutMenuView: View {
    var signingIn: Bool
    var signIn: () -> Void
    var quit: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var palette: LoggedOutMenuPalette { .init(dark: colorScheme == .dark) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                BrandMarkView(width: 34)
                BrandWordmarkView(height: 31)
            }
            .foregroundStyle(palette.ink)
            .padding(.top, 25)
            .padding(.bottom, 21)

            AgentTerminalMarquee(paused: signingIn, palette: palette)

            VStack(spacing: 0) {
                VStack(spacing: 0) {
                    Text("Your whole team.").foregroundStyle(palette.ink)
                    Text("On the relay.").foregroundStyle(palette.accent)
                }
                .font(.system(size: 27, weight: .semibold))
                .tracking(-1)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)

                Text(signingIn ? "Finish signing in in your browser." : "People and agents, across your organization.")
                    .font(.system(size: 12))
                    .foregroundStyle(palette.muted)
                    .padding(.top, 12)
                    .padding(.bottom, 30)

                Button(action: signIn) {
                    HStack(spacing: 19) {
                        Text(signingIn ? "Continue signing in" : "Sign in")
                        Image(systemName: "arrow.right")
                    }
                }
                .buttonStyle(AgentRelayPrimaryButtonStyle(height: 44, horizontalPadding: 20, fontSize: 13))
                .help("Open Agent Relay to sign in")
            }
            .padding(.top, 19)
            .padding(.horizontal, 22)
            .padding(.bottom, 36)

            HStack {
                HStack(spacing: 6) {
                    Circle().fill(palette.muted.opacity(0.75)).frame(width: 5, height: 5)
                        .accessibilityHidden(true)
                    Text(signingIn ? "Waiting for sign-in" : "Not signed in")
                }
                Spacer(minLength: 8)
                Button(action: quit) {
                    Label("Quit", systemImage: "power")
                        .padding(.vertical, 5)
                        .padding(.leading, 5)
                        .contentShape(Rectangle())
                }
                .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
                .keyboardShortcut("q", modifiers: .command)
                .help("Quit Agent Relay")
            }
            .font(.system(size: 11))
            .foregroundStyle(palette.muted)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(palette.footer)
            .overlay(alignment: .top) { palette.line.frame(height: 1) }
        }
        .frame(width: 350)
        .background(palette.paper)
    }
}

private struct LoggedOutMenuPalette {
    var dark: Bool
    var paper: Color { color(0xFBFCFD, 0x14232E) }
    var ink: Color { color(0x142737, 0xEDF4F8) }
    var muted: Color { color(0x607483, 0xA0B3C0) }
    var line: Color { color(0xE1E7EC, 0x2C3E4A) }
    var footer: Color { color(0xF0F4F6, 0x11202A) }
    var terminal: Color { color(0xF6F9FC, 0x1C303E) }
    var terminalInk: Color { color(0x324F63, 0xD8E7EF) }
    var terminalLine: Color { color(0xD3E0E9, 0x355366) }
    var terminalMuted: Color { color(0x677E8E, 0x9CB2C0) }
    var accent: Color { color(0x286A94, 0x8BC4E8) }

    private func color(_ light: UInt32, _ dark: UInt32) -> Color {
        let value = self.dark ? dark : light
        return Color(red: Double((value >> 16) & 255) / 255,
                     green: Double((value >> 8) & 255) / 255,
                     blue: Double(value & 255) / 255)
    }
}

private struct AgentTerminalMarquee: View {
    var paused: Bool
    var palette: LoggedOutMenuPalette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var start = Date()

    private struct Terminal {
        var agent: String
        var artwork: String
        var role: String
        var prompt: String
        var result: String
        var handoff: String
    }

    private static let terminals = [
        Terminal(agent: "Claude Code", artwork: "menu-claude", role: "build",
                 prompt: "❯ Build the sign-in flow", result: "+ auth.ts · 42 lines",
                 handoff: "relay → codex: ready to review"),
        Terminal(agent: "Codex", artwork: "menu-codex", role: "review",
                 prompt: "› Review Claude’s changes", result: "✓ Session handling looks good",
                 handoff: "relay → opencode: run tests"),
        Terminal(agent: "OpenCode", artwork: "menu-opencode", role: "test",
                 prompt: "› Check the sign-in flow", result: "✓ 12 tests passed",
                 handoff: "relay → team: all clear")
    ]

    // Same artwork as agentrelay.com's AgentToolLogos.tsx. Keep the images
    // cached: decoding SVGs on every animation frame is unnecessary work.
    private static let artwork: [String: NSImage] = {
        let resources = Bundle.main.url(forResource: "RelayDesktop_RelayDesktop", withExtension: "bundle")
            .flatMap { Bundle(url: $0) } ?? .module
        return Dictionary(uniqueKeysWithValues: terminals.compactMap { terminal in
            guard let url = resources.url(forResource: terminal.artwork, withExtension: "svg"),
                  let image = NSImage(contentsOf: url) else { return nil }
            image.isTemplate = terminal.artwork == "menu-codex"
            return (terminal.artwork, image)
        })
    }()

    var body: some View {
        Group {
            if reduceMotion || paused {
                strip(at: 0)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: !visible)) { context in
                    strip(at: context.date.timeIntervalSince(start))
                }
            }
        }
        .frame(height: 144)
        .clipped()
        .mask(LinearGradient(stops: [
            .init(color: .clear, location: 0), .init(color: .black, location: 0.13),
            .init(color: .black, location: 0.87), .init(color: .clear, location: 1)
        ], startPoint: .leading, endPoint: .trailing))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Illustration of Claude Code, Codex, and OpenCode sharing work")
        .onAppear { start = Date(); visible = true }
        .onDisappear { visible = false }
    }

    private func strip(at time: TimeInterval) -> some View {
        // Three cards and their gaps form one loop. The second copy is ready
        // behind the first, so wrapping has no jump or empty frame.
        let distance = CGFloat(Self.terminals.count) * 218
        let offset = CGFloat(time.truncatingRemainder(dividingBy: 28) / 28) * distance
        return HStack(spacing: 10) {
            ForEach(0..<6) { index in terminal(Self.terminals[index % Self.terminals.count]) }
        }
        .fixedSize()
        .offset(x: -30 - offset)
        .frame(width: 350, height: 144, alignment: .leading)
        .rotationEffect(.degrees(-5))
    }

    private func terminal(_ sample: Terminal) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                if let image = Self.artwork[sample.artwork] {
                    Image(nsImage: image).resizable().scaledToFit().frame(width: 15, height: 15)
                }
                Text(sample.agent).font(.system(size: 11, weight: .semibold))
                Spacer(minLength: 0)
                Text(sample.role).font(.system(size: 10)).foregroundStyle(palette.terminalMuted)
            }
            .padding(.horizontal, 11).padding(.vertical, 7)
            .overlay(alignment: .bottom) { palette.terminalLine.frame(height: 1) }

            VStack(alignment: .leading, spacing: 5) {
                Text(sample.prompt)
                Text(sample.result).foregroundStyle(palette.terminalMuted)
                Label(sample.handoff, systemImage: "arrow.up.right")
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(palette.accent)
                    .padding(.top, 3)
            }
            .font(.system(size: 11, design: .monospaced))
            .padding(.horizontal, 11).padding(.vertical, 10)
        }
        .lineLimit(1)
        .foregroundStyle(palette.terminalInk)
        .frame(width: 208)
        .background(palette.terminal, in: MenuMessageShape(radius: 10, tailRadius: 2))
        .overlay(MenuMessageShape(radius: 10, tailRadius: 2).strokeBorder(palette.terminalLine, lineWidth: 1))
        .shadow(color: .black.opacity(palette.dark ? 0.2 : 0.06), radius: 5, y: 4)
    }
}

/// Homepage message silhouette: three round corners and a small lower-left tail.
private struct MenuMessageShape: InsettableShape {
    var radius: CGFloat = 16
    var tailRadius: CGFloat = 3
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let rect = rect.insetBy(dx: insetAmount, dy: insetAmount)
        let r = max(0, min(radius - insetAmount, min(rect.width, rect.height) / 2))
        let tail = max(0, tailRadius - insetAmount)
        return Path { path in
            path.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
            path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
            path.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX + tail, y: rect.maxY))
            path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - tail), control: CGPoint(x: rect.minX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
            path.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
            path.closeSubpath()
        }
    }

    func inset(by amount: CGFloat) -> Self {
        var shape = self
        shape.insetAmount += amount
        return shape
    }
}

struct LoggedOutMenuView_Previews: PreviewProvider {
    static var previews: some View {
        ForEach([ColorScheme.light, .dark], id: \.self) { scheme in
            LoggedOutMenuView(signingIn: false, signIn: {}, quit: {})
                .environment(\.colorScheme, scheme)
                .previewDisplayName(scheme == .dark ? "Dark" : "Light")
        }
    }
}
