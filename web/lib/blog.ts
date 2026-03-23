import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

const BLOG_DIR = path.resolve(moduleDirname, '../content/blog');
const BLOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function isValidBlogSlug(slug: string): boolean {
  return BLOG_SLUG_PATTERN.test(slug);
}

function readPostFromFile(fileName: string): BlogPost | null {
  const slug = fileName.replace(/\.mdx$/, '');
  if (!isValidBlogSlug(slug)) {
    return null;
  }

  const raw = fs.readFileSync(path.join(BLOG_DIR, fileName), 'utf8');
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

export function getAllPosts(): BlogPost[] {
  const files = fs.readdirSync(BLOG_DIR).filter((file) => file.endsWith('.mdx'));

  return files
    .map((file) => readPostFromFile(file))
    .filter((post): post is BlogPost => post !== null)
    .sort((a, b) => (a.frontmatter.date > b.frontmatter.date ? -1 : 1));
}

export function getPost(slug: string): BlogPost | null {
  if (!isValidBlogSlug(slug)) {
    return null;
  }

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
