import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDocsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'docs'),
    path.resolve(process.cwd(), '../docs'),
    path.resolve(__dirname, '../../docs'),
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
