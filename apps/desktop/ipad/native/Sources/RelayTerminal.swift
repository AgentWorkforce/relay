import SwiftUI
import SwiftTerm
import UIKit

final class RelayTerminalView: TerminalView, TerminalViewDelegate {
    var onInput: ((String) -> Void)?
    var onResize: ((Int, Int) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame, font: .monospacedSystemFont(ofSize: 13, weight: .regular))
        terminalDelegate = self
        backgroundColor = UIColor(red: 0.075, green: 0.12, blue: 0.17, alpha: 1)
        allowMouseReporting = false
        changeScrollback(5_000)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { onResize?(newCols, newRows) }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        if let text = String(bytes: data, encoding: .utf8) { onInput?(text) }
    }
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        if let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url)
        }
    }
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {
        UIPasteboard.general.string = String(data: content, encoding: .utf8)
    }
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

struct RelayTerminal: UIViewRepresentable {
    @ObservedObject var client: RelayClient
    func makeUIView(context: Context) -> RelayTerminalView {
        let terminal = RelayTerminalView(frame: .zero)
        terminal.onInput = { [weak client] text in Task { await client?.terminalInput(text, raw: true) } }
        terminal.onResize = { [weak client] cols, rows in Task { await client?.resizeTerminal(cols: cols, rows: rows) } }
        client.onTerminalOutput = { [weak terminal, weak client] text in
            terminal?.feed(text: text)
            DispatchQueue.main.async { [weak terminal, weak client] in
                if let screen = terminal?.accessibilityPageContent() { client?.captureScreen(screen) }
            }
        }
        client.onTerminalScroll = { [weak terminal] lines in
            if lines > 0 { terminal?.pageUp() }
            else { terminal?.pageDown() }
        }
        if !client.terminalBacklog.isEmpty {
            terminal.feed(text: client.terminalBacklog)
            DispatchQueue.main.async { [weak terminal, weak client] in
                if let screen = terminal?.accessibilityPageContent() { client?.captureScreen(screen) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak terminal, weak client] in
            guard let terminal, terminal.bounds.height > 0,
                  let screen = terminal.accessibilityPageContent() else { return }
            client?.captureScreen(screen)
        }
        if client.attachedMode == "drive" {
            DispatchQueue.main.async { _ = terminal.becomeFirstResponder() }
        }
        return terminal
    }
    func updateUIView(_ uiView: RelayTerminalView, context: Context) {
        uiView.onInput = client.attachedMode == "drive" ? { [weak client] text in Task { await client?.terminalInput(text, raw: true) } } : nil
        if client.attachedMode != "drive" && uiView.isFirstResponder { _ = uiView.resignFirstResponder() }
    }
}
