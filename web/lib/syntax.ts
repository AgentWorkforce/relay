/**
 * Simple regex-based syntax highlighter.
 * Returns HTML string with <span class="..."> wrappers.
 */

const RULES: { pattern: RegExp; cls: string }[] = [
  // Strings (double, single, backtick) — must come first
  { pattern: /(["'`])(?:(?!\1|\\).|\\.)*\1/g, cls: 'syn-string' },
  // Comments
  { pattern: /\/\/.*$/gm, cls: 'syn-comment' },
  { pattern: /#.*$/gm, cls: 'syn-comment' },
  // Keywords
  { pattern: /\b(import|from|export|const|let|var|await|async|function|return|new|if|else|for|while|class|type|interface|extends|implements|of|in|as|default)\b/g, cls: 'syn-keyword' },
  // Python keywords
  { pattern: /\b(def|async|await|import|from|return|class|if|else|elif|for|while|with|try|except|finally|raise|pass|yield|lambda|and|or|not|is|True|False|None)\b/g, cls: 'syn-keyword' },
  // Types / constructors (PascalCase)
  { pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, cls: 'syn-type' },
  // Method calls
  { pattern: /\.([a-zA-Z_]\w*)\s*\(/g, cls: 'syn-method' },
  // Numbers
  { pattern: /\b(\d+\.?\d*)\b/g, cls: 'syn-number' },
];

export function highlightCode(code: string): string {
  // Escape HTML
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Replace tokens with placeholders to avoid double-matching
  const tokens: string[] = [];
  function placeholder(content: string, cls: string): string {
    const idx = tokens.length;
    tokens.push(`<span class="${cls}">${content}</span>`);
    return `\x00${idx}\x00`;
  }

  // Strings first (highest priority)
  html = html.replace(RULES[0].pattern, (m) => placeholder(m, RULES[0].cls));
  // Comments
  html = html.replace(RULES[1].pattern, (m) => placeholder(m, RULES[1].cls));
  html = html.replace(RULES[2].pattern, (m) => placeholder(m, RULES[2].cls));
  // Keywords
  html = html.replace(RULES[3].pattern, (m) => placeholder(m, RULES[3].cls));
  html = html.replace(RULES[4].pattern, (m) => placeholder(m, RULES[4].cls));
  // Types
  html = html.replace(RULES[5].pattern, (_, t: string) => placeholder(t, RULES[5].cls));
  // Methods — keep the dot and parens
  html = html.replace(RULES[6].pattern, (_, m: string) => `.${placeholder(m, RULES[6].cls)}(`);
  // Numbers
  html = html.replace(RULES[7].pattern, (m) => placeholder(m, RULES[7].cls));

  // Restore placeholders
  // eslint-disable-next-line no-control-regex
  html = html.replace(/\x00(\d+)\x00/g, (_, idx) => tokens[Number(idx)]);

  return html;
}
