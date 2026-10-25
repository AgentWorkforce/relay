import AppKit
import RelayDesktopCore
import SwiftUI

/// Bundled agent artwork, shared by onboarding and the session monitor.
struct AgentIconView: View {
    var source: String
    var size: CGFloat = 36
    /// The app the session runs in, when not the provider's own
    /// (`conductor`): its icon is badged on the provider's.
    var host: String? = nil
    var artworkColor: Color? = nil

    static func name(for source: String) -> String {
        switch source.lowercased() {
        case "capy": return "Capy"
        case "codex": return "Codex"
        case "claude": return "Claude"
        case "claude-code", "claude_code", "claudecode": return "Claude Code"
        case "grok", "xai": return "Grok"
        case "cursor": return "Cursor"
        case "cursor-cloud", "cursor_cloud": return "Cursor Cloud"
        case "opencode", "opencode-open", "open-code", "open_code": return "OpenCode"
        case "openai", "open-ai", "open_ai": return "OpenAI"
        case "muse", "muse-open": return "Muse"
        case "devin": return "Devin"
        case "openclaw": return "OpenClaw"
        case "hermes": return "Hermes"
        case "pi": return "Pi"
        default: return source.capitalized
        }
    }

    private static let images: [String: NSImage] = {
        let resources = Bundle.main.url(forResource: "RelayDesktop_RelayDesktop", withExtension: "bundle")
            .flatMap { Bundle(url: $0) } ?? .module
        var images: [String: NSImage] = [:]
        let templateImages = Set(["devin", "grok", "cursor", "opencode", "openai", "muse"])
        for name in ["capy", "codex", "claude", "devin", "grok", "cursor", "opencode", "openai", "claudecode", "muse", "openclaw", "hermes"] {
            if let url = resources.url(forResource: name, withExtension: "svg"),
               let image = NSImage(contentsOf: url) {
                image.isTemplate = templateImages.contains(name)
                images[name] = image
            }
        }
        for name in ["conductor", "paseo"] {
            if let url = resources.url(forResource: name, withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                images["host:\(name)"] = image
            }
        }
        return images
    }()

    var body: some View {
        Group {
            let named = Self.name(for: source)
            let imageKey = named == "Cursor Cloud"
                ? "cursor"
                : named.lowercased().replacingOccurrences(of: " ", with: "")
            if let image = Self.images[imageKey] {
                if let artworkColor {
                    Image(nsImage: image).resizable().scaledToFit()
                        .foregroundStyle(artworkColor)
                } else {
                    Image(nsImage: image).resizable().scaledToFit()
                }
            } else {
                Image(systemName: "terminal").resizable().scaledToFit().padding(4)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        // Top-trailing: the agent list puts its presence dot bottom-trailing.
        .overlay(alignment: .topTrailing) {
            if SessionHost.name(host) != nil, let badge = host.flatMap({ Self.images["host:\($0.lowercased())"] }) {
                let side = max(9, (size * 0.55).rounded())
                Image(nsImage: badge).resizable().scaledToFit()
                    .frame(width: side, height: side)
                    .clipShape(RoundedRectangle(cornerRadius: side * 0.22))
                    .offset(x: side * 0.3, y: -side * 0.3)
            }
        }
        .accessibilityLabel(SessionHost.label(provider: Self.name(for: source), host: host))
        .help(SessionHost.label(provider: Self.name(for: source), host: host))
    }
}
