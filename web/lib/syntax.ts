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
 * Returns the extracted <code> contents plus <pre> metadata for dual light/dark themes.
 */
export async function highlightCode(code: string, lang = 'text'): Promise<{
  codeHtml: string;
  preClassName?: string;
  preStyle?: string;
}> {
  // Normalize and validate language
  let resolved = LANG_ALIASES[lang] || lang;
  if (!(resolved in bundledLanguages) && resolved !== 'text') {
    resolved = 'text';
  }

  const html = await codeToHtml(code, {
    lang: resolved,
    themes: {
      light: 'github-light',
      dark: 'github-dark',
    },
  });

  const match = html.match(/<pre(?: class="([^"]*)")?(?: style="([^"]*)")?[^>]*><code>([\s\S]*)<\/code><\/pre>/);

  if (!match) {
    return { codeHtml: html };
  }

  return {
    preClassName: match[1],
    preStyle: match[2],
    codeHtml: match[3],
  };
}
