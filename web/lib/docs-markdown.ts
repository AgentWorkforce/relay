import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import {
  getSpawnOptionDescription,
  getSpawnOptionName,
  getSpawnOptionRows,
  type SpawnOptionsTableVariant,
} from './spawn-options-table';
import { getAllDocSlugs } from './docs-nav';
import { absoluteUrl } from './site';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);
const DOCS_DIR = path.resolve(moduleDirname, '../content/docs');
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

function renderSpawnOptionsTable(attrs: string): string {
  const variantMatch = attrs.match(/variant="([^"]+)"/)?.[1];
  const variant: SpawnOptionsTableVariant =
    variantMatch === 'relay-startup' ? 'relay-startup' : variantMatch === 'advanced' ? 'advanced' : 'common';
  const rows = getSpawnOptionRows(variant);
  const lines = [
    '| Option | What it does |',
    '| --- | --- |',
    ...rows.map((row) => {
      const option = getSpawnOptionName(row, 'typescript')
        .map((name) => `\`${name}\``)
        .join(', ');
      const description = getSpawnOptionDescription(row, 'typescript');

      return `| ${option} | ${description} |`;
    }),
  ];

  return `\n${lines.join('\n')}\n`;
}

function renderMarkdownBody(content: string): string {
  let output = content;

  output = output.replace(/<CodeGroup>\s*/g, '');
  output = output.replace(/\s*<\/CodeGroup>/g, '');
  output = output.replace(/<CardGroup[^>]*>\s*/g, '');
  output = output.replace(/\s*<\/CardGroup>/g, '');

  output = output.replace(
    /<Note>\s*([\s\S]*?)\s*<\/Note>/g,
    (_match, body: string) => `\n${toBlockquote(body)}\n`
  );
  output = output.replace(/<Card\s+([^>]*)>([\s\S]*?)<\/Card>/g, (_match, attrs: string, body: string) =>
    renderCard(attrs, body)
  );
  output = output.replace(
    /<BannerLink\s+([^>]*)>([\s\S]*?)<\/BannerLink>/g,
    (_match, attrs: string, body: string) => `\n${renderBannerLink(attrs, body)}\n`
  );
  output = output.replace(/<SpawnOptionsTable([^>]*)\/>/g, (_match, attrs: string) =>
    renderSpawnOptionsTable(attrs)
  );

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
