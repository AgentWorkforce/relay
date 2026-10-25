import SwiftUI

// Adapted from Skip’s native conversation renderer.
struct ChatMarkdownView: View {
    private let blocks: [ChatMarkdownParser.Block]

    init(_ markdown: String) {
        blocks = ChatMarkdownParser.parse(markdown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: ChatMarkdownParser.Block) -> some View {
        switch block {
        case .paragraph(let text):
            inlineMarkdown(text)
                .font(.system(size: 13))
                .lineSpacing(2)
        case .heading(let level, let text):
            inlineMarkdown(text)
                .font(.system(size: level == 1 ? 16 : level == 2 ? 15 : 13.5, weight: .bold))
                .padding(.top, 2)
        case .unorderedItem(let text):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("•").font(.system(size: 13, weight: .bold))
                inlineMarkdown(text).font(.system(size: 13)).lineSpacing(2)
            }
        case .orderedItem(let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("\(number).").font(.system(size: 12.5, weight: .semibold)).monospacedDigit()
                inlineMarkdown(text).font(.system(size: 13)).lineSpacing(2)
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: 9) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(CloudTheme.primary)
                    .frame(width: 3)
                inlineMarkdown(text)
                    .font(.system(size: 12.5))
                    .foregroundStyle(CloudTheme.secondary)
                    .lineSpacing(2)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let text):
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Code").font(.system(size: 10, weight: .medium)).foregroundStyle(CloudTheme.codeMuted)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                    } label: { Image(systemName: "doc.on.doc").foregroundStyle(CloudTheme.codeForeground).font(.system(size: 10)).frame(width: 24, height: 22) }
                        .buttonStyle(NavButtonStyle(kind: .icon)).help("Copy code").accessibilityLabel("Copy code")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text)
                        .font(.system(size: 11.5, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(9)
            .foregroundStyle(CloudTheme.codeForeground)
            .background(CloudTheme.codeBackground)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(CloudTheme.border, lineWidth: 1)
            }
        }
    }

    private func inlineMarkdown(_ value: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        let attributed = (try? AttributedString(markdown: value, options: options)) ?? AttributedString(value)
        return Text(attributed)
    }
}

enum ChatMarkdownParser {
    enum Block: Equatable {
        case paragraph(String)
        case heading(Int, String)
        case unorderedItem(String)
        case orderedItem(Int, String)
        case quote(String)
        case code(String)
    }

    static func parse(_ markdown: String) -> [Block] {
        let lines = markdown.components(separatedBy: .newlines)
        var blocks: [Block] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                index += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                index += 1
                var codeLines: [String] = []
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(codeLines.joined(separator: "\n")))
                continue
            }

            if let heading = heading(from: trimmed) {
                blocks.append(.heading(heading.level, heading.text))
                index += 1
                continue
            }
            if let item = unorderedItem(from: trimmed) {
                blocks.append(.unorderedItem(item))
                index += 1
                continue
            }
            if let item = orderedItem(from: trimmed) {
                blocks.append(.orderedItem(item.number, item.text))
                index += 1
                continue
            }
            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    guard next.hasPrefix(">") else { break }
                    quoteLines.append(String(next.dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            var paragraph: [String] = [trimmed]
            index += 1
            while index < lines.count {
                let next = lines[index].trimmingCharacters(in: .whitespaces)
                guard !next.isEmpty, !isBlockStart(next) else { break }
                paragraph.append(next)
                index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }

        return blocks.isEmpty ? [.paragraph(markdown)] : blocks
    }

    private static func heading(from line: String) -> (level: Int, text: String)? {
        for level in 1...6 {
            let prefix = String(repeating: "#", count: level) + " "
            if line.hasPrefix(prefix) {
                return (level, String(line.dropFirst(prefix.count)))
            }
        }
        return nil
    }

    private static func unorderedItem(from line: String) -> String? {
        for prefix in ["- ", "* ", "+ "] where line.hasPrefix(prefix) {
            return String(line.dropFirst(prefix.count))
        }
        return nil
    }

    private static func orderedItem(from line: String) -> (number: Int, text: String)? {
        guard let separator = line.firstIndex(of: "."),
              separator < line.index(before: line.endIndex),
              line[line.index(after: separator)] == " ",
              let number = Int(line[..<separator])
        else { return nil }
        return (number, String(line[line.index(separator, offsetBy: 2)...]))
    }

    private static func isBlockStart(_ line: String) -> Bool {
        line.hasPrefix("```") || line.hasPrefix(">") || heading(from: line) != nil
            || unorderedItem(from: line) != nil || orderedItem(from: line) != nil
    }
}
