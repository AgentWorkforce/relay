import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import { encodeCodeFenceMeta } from './code-fence-meta';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

const DOCS_DIR = path.resolve(moduleDirname, '../content/docs');

export interface DocFrontmatter {
  title: string;
  description: string;
}

export interface SearchEntry {
  slug: string;
  title: string;
  description: string;
  headings: string[];
  /** Plain text snippet for matching (no MDX/HTML) */
  body: string;
}

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

export interface DocContent {
  frontmatter: DocFrontmatter;
  content: string;
  toc: TocItem[];
}

/**
 * Preprocess MDX to preserve code fence metadata that MDX would otherwise drop.
 * Supported patterns:
 * - ```lang Label
 * - ```lang file="path/to/file.ts"
 * - ```lang Label file="path/to/file.ts"
 */
function preprocessMdx(source: string): string {
  return source.replace(/^```([^\n]*)$/gm, (line, rawInfo: string) => {
    const info = rawInfo.trim();
    if (!info) {
      return line;
    }

    const firstWhitespace = info.search(/\s/);
    if (firstWhitespace === -1) {
      return line;
    }

    const language = info.slice(0, firstWhitespace).trim();
    let remainder = info.slice(firstWhitespace + 1).trim();
    let filename: string | undefined;
    let explicitLabel: string | undefined;

    remainder = remainder
      .replace(/(?:^|\s)(?:file|filename|title)=(["'])(.*?)\1/g, (_, __, value: string) => {
        if (!filename) {
          filename = value.trim();
        }
        return ' ';
      })
      .replace(/(?:^|\s)(?:file|filename|title)=([^\s"'=]+)/g, (_, value: string) => {
        const normalizedValue = value.trim();

        // Recover from malformed shorthand like `file=TypeScript` that was intended
        // to act as a tab label, while still allowing unquoted filenames such as `file=agent.ts`.
        if (!filename && /[./\\]/.test(normalizedValue)) {
          filename = normalizedValue;
        } else if (!explicitLabel) {
          explicitLabel = normalizedValue;
        }

        return ' ';
      })
      .replace(/\s+/g, ' ')
      .trim();

    const label = explicitLabel ?? (remainder && !/[=]/.test(remainder) ? remainder : undefined);

    if (!label && !filename) {
      return line;
    }

    return `\`\`\`${encodeCodeFenceMeta({ language, label, filename })}`;
  });
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[>*_~#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchSnippet(content: string): string {
  const lines = content.split(/\r?\n/);
  const textLines: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) continue;
    if (!trimmed) continue;

    if (
      trimmed.startsWith('<') ||
      trimmed.endsWith('/>') ||
      trimmed === '</CodeGroup>' ||
      trimmed === '</Note>'
    ) {
      continue;
    }

    const plain = stripInlineMarkdown(trimmed);
    if (plain) {
      textLines.push(plain);
    }
  }

  return textLines.join(' ').slice(0, 500);
}

/**
 * Load and parse an MDX doc by slug.
 * @param slug - e.g. "quickstart" or "reference/sdk"
 */
export function getDoc(slug: string): DocContent | null {
  const filePath = path.join(DOCS_DIR, `${slug}.mdx`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);
  const processed = preprocessMdx(content);

  // Extract h2 and h3 headings for table of contents
  const toc: TocItem[] = [];
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const text = match[2].replace(/`([^`]+)`/g, '$1').trim();
    const id = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    toc.push({ id, text, level: match[1].length });
  }

  return {
    frontmatter: {
      title: (data.title as string) || slug,
      description: (data.description as string) || '',
    },
    content: processed,
    toc,
  };
}

/** Build a lightweight search index from all docs */
export function getSearchIndex(): SearchEntry[] {
  // Import inline to avoid circular dependency at module level
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAllDocSlugs } = require('./docs-nav') as typeof import('./docs-nav');
  const slugs = getAllDocSlugs();

  return slugs.map((slug) => {
    const filePath = path.join(DOCS_DIR, `${slug}.mdx`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const { data, content } = matter(raw);
    const body = buildSearchSnippet(content);

    const headings: string[] = [];
    const hRegex = /^#{2,3}\s+(.+)$/gm;
    let m;
    while ((m = hRegex.exec(content)) !== null) {
      headings.push(m[1].replace(/`([^`]+)`/g, '$1').trim());
    }

    return {
      slug,
      title: (data.title as string) || slug,
      description: (data.description as string) || '',
      headings,
      body,
    };
  });
}
