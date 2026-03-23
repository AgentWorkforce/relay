import { codeToHtml, bundledLanguages } from 'shiki';

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  npm: 'bash',
};

/**
 * Server-side syntax highlighting with Shiki.
 * Returns an HTML string ready for dangerouslySetInnerHTML.
 */
export async function highlightCode(code: string, lang = 'text'): Promise<string> {
  // Normalize and validate language
  let resolved = LANG_ALIASES[lang] || lang;
  if (!(resolved in bundledLanguages) && resolved !== 'text') {
    resolved = 'text';
  }

  const html = await codeToHtml(code, {
    lang: resolved,
    theme: 'github-light',
  });

  // Shiki wraps in <pre><code>...</code></pre> — we only want the inner content
  // since our components already provide the <pre> wrapper
  const match = html.match(/<code[^>]*>([\s\S]*)<\/code>/);
  return match ? match[1] : html;
}
