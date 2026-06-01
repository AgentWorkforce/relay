import { codeToHtml, bundledLanguages, type ThemeRegistrationRaw } from 'shiki';

/**
 * Custom Shiki themes built from the Relay brand console palette (see
 * public/brand.css `--console-*` / `--terminal-*`). Keeps code blocks in the
 * cool navy/blue scheme instead of a stock high-contrast theme.
 */
function relayTheme(
  name: string,
  type: 'light' | 'dark',
  c: {
    bg: string;
    fg: string;
    comment: string;
    keyword: string;
    string: string;
    number: string;
    type: string;
    func: string;
    property: string;
    operator: string;
  }
): ThemeRegistrationRaw {
  return {
    name,
    type,
    colors: { 'editor.foreground': c.fg, 'editor.background': c.bg },
    settings: [
      { settings: { foreground: c.fg, background: c.bg } },
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: c.comment, fontStyle: 'italic' },
      },
      {
        scope: ['string', 'string.quoted', 'string.template', 'constant.character', 'constant.other.symbol'],
        settings: { foreground: c.string },
      },
      { scope: ['constant.character.escape', 'string.regexp'], settings: { foreground: c.number } },
      {
        scope: [
          'constant.numeric',
          'constant.language',
          'constant.language.boolean',
          'constant.language.null',
        ],
        settings: { foreground: c.number },
      },
      {
        scope: [
          'keyword',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'storage',
          'storage.type',
          'storage.modifier',
          'variable.language.this',
        ],
        settings: { foreground: c.keyword },
      },
      {
        scope: ['keyword.operator', 'punctuation.separator', 'punctuation.terminator'],
        settings: { foreground: c.operator },
      },
      {
        scope: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function'],
        settings: { foreground: c.func },
      },
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'support.type',
          'support.class',
          'entity.other.inherited-class',
          'entity.name.tag',
        ],
        settings: { foreground: c.type },
      },
      {
        scope: [
          'support.type.property-name',
          'meta.object-literal.key',
          'variable.other.property',
          'support.variable',
          'entity.other.attribute-name',
        ],
        settings: { foreground: c.property },
      },
      {
        scope: ['variable', 'variable.other.readwrite', 'meta.definition.variable', 'variable.parameter'],
        settings: { foreground: c.fg },
      },
    ],
  };
}

const RELAY_DARK = relayTheme('relay-dark', 'dark', {
  bg: '#0a182c',
  fg: '#c6d4e3',
  comment: '#6b7a8d',
  keyword: '#7eb8da',
  string: '#e4a986',
  number: '#94cbef',
  type: '#6bd4bc',
  func: '#62a1ce',
  property: '#9fd0ee',
  operator: '#9fb6c9',
});

const RELAY_LIGHT = relayTheme('relay-light', 'light', {
  bg: '#f3f4f6',
  fg: '#1f2937',
  comment: '#8a96a3',
  keyword: '#2d6a9c',
  string: '#b45309',
  number: '#2d6a9c',
  type: '#0f766e',
  func: '#4a90c2',
  property: '#2d6a9c',
  operator: '#4b5563',
});

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
export async function highlightCode(
  code: string,
  lang = 'text'
): Promise<{
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
      light: RELAY_LIGHT,
      dark: RELAY_DARK,
    },
  });

  const match = html.match(
    /<pre(?: class="([^"]*)")?(?: style="([^"]*)")?[^>]*><code>([\s\S]*)<\/code><\/pre>/
  );

  if (!match) {
    return { codeHtml: html };
  }

  return {
    preClassName: match[1],
    preStyle: match[2],
    codeHtml: match[3],
  };
}
