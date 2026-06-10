import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import { resolveContentDir } from './content-paths';
import { docsNav, getAllDocSlugs } from './docs-nav';
import { absoluteUrl } from './site';

const DOCS_DIR = resolveContentDir('docs');
const DOCS_BASE_URL = absoluteUrl('/docs');

export function getDocMarkdownUrl(slug: string): string {
  return `${DOCS_BASE_URL}/markdown/${slug}.md`;
}

export function getDocsMarkdownIndexUrl(): string {
  return `${DOCS_BASE_URL}/markdown.md`;
}

type MarkdownDoc = {
  slug: string;
  title: string;
  description: string;
  markdown: string;
};

function readDocSource(slug: string): { title: string; description: string; content: string } | null {
  const filePath = path.join(DOCS_DIR, `${slug}.mdx`);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);
  return {
    title: (data.title as string) || slug,
    description: (data.description as string) || '',
    content,
  };
}

function resolveHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return href;
  }
  if (href.startsWith('/')) {
    return absoluteUrl(href);
  }
  return href;
}

function collapseInline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function toBlockquote(body: string): string {
  return body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function renderAdmonition(body: string): string {
  return toBlockquote(body);
}

function renderCard(attrs: string, body: string): string {
  const title = attrs.match(/title="([^"]+)"/)?.[1] ?? 'Link';
  const href = resolveHref(attrs.match(/href="([^"]+)"/)?.[1]);
  const summary = collapseInline(body);
  const label = href ? `[${title}](${href})` : `**${title}**`;
  return `- ${label}${summary ? `: ${summary}` : ''}`;
}

function renderBannerLink(attrs: string, body: string): string {
  const href = resolveHref(attrs.match(/href="([^"]+)"/)?.[1]);
  const label = collapseInline(body);

  if (!label) {
    return '';
  }

  return href ? `[${label}](${href})` : label;
}

function renderMarkdownBody(content: string): string {
  let output = content;

  output = output.replace(/<CodeGroup>\s*/g, '');
  output = output.replace(/\s*<\/CodeGroup>/g, '');
  output = output.replace(/<CardGroup[^>]*>\s*/g, '');
  output = output.replace(/\s*<\/CardGroup>/g, '');

  output = output.replace(
    /<Note>\s*([\s\S]*?)\s*<\/Note>/g,
    (_match, body: string) => `\n${renderAdmonition(body)}\n`
  );
  output = output.replace(
    /<Warning>\s*([\s\S]*?)\s*<\/Warning>/g,
    (_match, body: string) => `\n${renderAdmonition(body)}\n`
  );
  output = output.replace(/<Card\s+([^>]*)>([\s\S]*?)<\/Card>/g, (_match, attrs: string, body: string) =>
    renderCard(attrs, body)
  );
  output = output.replace(
    /<BannerLink\s+([^>]*)>([\s\S]*?)<\/BannerLink>/g,
    (_match, attrs: string, body: string) => `\n${renderBannerLink(attrs, body)}\n`
  );
  output = output.replace(/<SpawnOptionsTable[^>]*\/>/g, '');

  output = output.replace(/\n{3,}/g, '\n\n');
  return output.trim();
}

export function getDocMarkdown(slug: string): MarkdownDoc | null {
  const doc = readDocSource(slug);
  if (!doc) {
    return null;
  }

  const canonicalUrl = `${DOCS_BASE_URL}/${slug}`;
  const markdownUrl = getDocMarkdownUrl(slug);
  const header = [
    `# ${doc.title}`,
    doc.description ? `\n${doc.description}` : '',
    `\nRendered page: ${canonicalUrl}`,
    `Markdown endpoint: ${markdownUrl}`,
    '\n---\n',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    slug,
    title: doc.title,
    description: doc.description,
    markdown: `${header}\n${renderMarkdownBody(doc.content)}\n`,
  };
}

export function getDocsMarkdownIndex(): string {
  const docs = getAllDocSlugs()
    .map((slug) => getDocMarkdown(slug))
    .filter((doc): doc is MarkdownDoc => doc !== null);

  const lines = [
    '# Agent Relay Docs (Markdown)',
    '',
    'These markdown views are generated directly from `web/content/docs/*.mdx`.',
    'They are meant for agents, CLI tooling, and raw browser access.',
    '',
    ...docs.map(
      (doc) =>
        `- [${doc.title}](${getDocMarkdownUrl(doc.slug)})${doc.description ? `: ${doc.description}` : ''}`
    ),
    '',
  ];

  return `${lines.join('\n')}\n`;
}

type DocsLink = {
  title: string;
  url: string;
  description: string;
};

function getCurrentDocsLinks(): DocsLink[] {
  return docsNav.flatMap((group) =>
    group.items.flatMap((item) => {
      const doc = getDocMarkdown(item.slug);
      if (!doc) {
        return [];
      }
      return [
        {
          title: doc.title,
          url: getDocMarkdownUrl(item.slug),
          description: doc.description,
        },
      ];
    })
  );
}

function formatLink({ title, url, description }: DocsLink): string {
  return `- [${title}](${url})${description ? `: ${description}` : ''}`;
}

/**
 * llms.txt index per https://llmstxt.org: H1, blockquote summary, then link
 * sections. Served at /llms.txt, /llm.txt, and /docs/llms.txt so agents that
 * probe conventional paths find the markdown mirrors.
 */
export function getLlmsText(): string {
  const lines = [
    '# Agent Relay',
    '',
    '> Agent Relay is Headless Slack for agents: a communication layer for workspaces, messages, delivery receipts, actions, events, sessions, harnesses, and CLI/MCP tooling.',
    '',
    `\`/llms.txt\` and \`/llm.txt\` return this same Markdown index. Every docs page has a plain-markdown mirror: append \`.md\` to its URL (for example ${DOCS_BASE_URL}/typescript-sdk.md) or use the canonical form ${DOCS_BASE_URL}/markdown/{slug}.md. Use \`/llms-full.txt\` when you need all docs in one file.`,
    '',
    '## Documentation',
    '',
    formatLink({
      title: 'Full documentation content',
      url: absoluteUrl('/llms-full.txt'),
      description: 'Single Markdown bundle generated from current docs.',
    }),
    formatLink({
      title: 'Markdown docs index',
      url: getDocsMarkdownIndexUrl(),
      description: 'Per-page Markdown endpoints for current docs.',
    }),
    ...getCurrentDocsLinks().map(formatLink),
    '',
    '## Optional',
    '',
    formatLink({
      title: 'GitHub repository',
      url: 'https://github.com/AgentWorkforce/relay',
      description: 'Source code, issues, and releases.',
    }),
    '',
  ];

  return `${lines.join('\n')}`;
}

function getMarkdownBundle(slugs: string[]): string[] {
  return slugs
    .map((slug) => getDocMarkdown(slug))
    .filter((doc): doc is MarkdownDoc => doc !== null)
    .map((doc) => doc.markdown.trim());
}

export function getLlmsFullText(): string {
  const currentDocs = getMarkdownBundle(getAllDocSlugs());
  const sections = [
    '# Agent Relay Full Documentation',
    '',
    '> Combined Markdown documentation for Agent Relay.',
    '',
    'Generated from `web/content/docs/*.mdx`.',
    '',
    '## Documentation',
    '',
    currentDocs.join('\n\n---\n\n'),
    '',
  ];

  return `${sections.join('\n')}`;
}
