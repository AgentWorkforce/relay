import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BLOG_DIR = path.resolve(__dirname, '../content/blog');

export interface BlogFrontmatter {
  title: string;
  description: string;
  date: string;
  author: string;
  category: string;
}

export interface BlogPost {
  slug: string;
  frontmatter: BlogFrontmatter;
  content: string;
}

export function getAllPosts(): BlogPost[] {
  const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith('.mdx'));

  return files
    .map((file) => {
      const raw = fs.readFileSync(path.join(BLOG_DIR, file), 'utf8');
      const { data, content } = matter(raw);
      return {
        slug: file.replace(/\.mdx$/, ''),
        frontmatter: {
          title: (data.title as string) || '',
          description: (data.description as string) || '',
          date: (data.date as string) || '',
          author: (data.author as string) || '',
          category: (data.category as string) || '',
        },
        content,
      };
    })
    .sort((a, b) => (a.frontmatter.date > b.frontmatter.date ? -1 : 1));
}

export function getPost(slug: string): BlogPost | null {
  const filePath = path.join(BLOG_DIR, `${slug}.mdx`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);

  return {
    slug,
    frontmatter: {
      title: (data.title as string) || '',
      description: (data.description as string) || '',
      date: (data.date as string) || '',
      author: (data.author as string) || '',
      category: (data.category as string) || '',
    },
    content,
  };
}
