import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

function resolveDocsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'docs'),
    path.resolve(process.cwd(), '../docs'),
    path.resolve(process.cwd(), '../../docs'),
    path.resolve(moduleDirname, '../../docs'),
    path.resolve(moduleDirname, '../../../docs'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate docs directory. Checked: ${candidates.join(', ')}`);
}

const DOCS_DIR = resolveDocsDir();

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
 * Preprocess MDX to preserve code block meta labels.
 * Mintlify uses ```lang Label where Label is a tab title (e.g. ```bash TypeScript).
 * We swap the language with the label so CodeGroup can display the right tab name.
 * The actual syntax highlighting language is less important than the tab label.
 */
function preprocessMdx(source: string): string {
  // Inside CodeGroup blocks, replace ```lang Label with ```Label
  // so the code element gets className="language-Label" which CodeGroup reads
  return source.replace(
    /(<CodeGroup>[\s\S]*?<\/CodeGroup>)/g,
    (codeGroupBlock) =>
      codeGroupBlock.replace(
        /```\w+\s+([A-Za-z][\w .+-]*)\n/g,
        (_, label: string) => `\`\`\`${label.trim()}\n`
      )
  );
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
