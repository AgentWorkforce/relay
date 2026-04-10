import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';
import { resolveContentDir } from './content-paths';

const BLOG_DIR = resolveContentDir('blog');
const BLOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BlogFrontmatter {
  title: string;
  description: string;
  date: string;
  updatedAt?: string;
  author: string;
  category: string;
  tags: string[];
  coverImage?: string;
  coverImageAlt?: string;
}

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface BlogPost {
  slug: string;
  frontmatter: BlogFrontmatter;
  content: string;
  readTime: string;
  toc: TocItem[];
}

function isValidBlogSlug(slug: string): boolean {
  return BLOG_SLUG_PATTERN.test(slug);
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractToc(content: string): TocItem[] {
  const toc: TocItem[] = [];
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(content)) !== null) {
    const text = match[2].replace(/`([^`]+)`/g, '$1').trim();
    toc.push({
      id: slugifyHeading(text),
      text,
      level: match[1].length as 2 | 3,
    });
  }

  return toc;
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function estimateReadTime(content: string): string {
  const words = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_~-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

function normalizeFrontmatter(data: matter.GrayMatterFile<string>['data']): BlogFrontmatter {
  return {
    title: (data.title as string) || '',
    description: (data.description as string) || '',
    date: (data.date as string) || '',
    updatedAt: (data.updatedAt as string) || undefined,
    author: (data.author as string) || '',
    category: (data.category as string) || '',
    tags: parseTags(data.tags),
    coverImage: (data.coverImage as string) || undefined,
    coverImageAlt: (data.coverImageAlt as string) || undefined,
  };
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
    frontmatter: normalizeFrontmatter(data),
    content,
    readTime: estimateReadTime(content),
    toc: extractToc(content),
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
    frontmatter: normalizeFrontmatter(data),
    content,
    readTime: estimateReadTime(content),
    toc: extractToc(content),
  };
}

export function getRelatedPosts(post: BlogPost, limit = 4): BlogPost[] {
  const currentTags = new Set(post.frontmatter.tags.map((tag) => tag.toLowerCase()));

  return getAllPosts()
    .filter((candidate) => candidate.slug !== post.slug)
    .map((candidate) => {
      const sharedTags = candidate.frontmatter.tags.reduce((score, tag) => {
        return score + (currentTags.has(tag.toLowerCase()) ? 2 : 0);
      }, 0);

      const categoryScore = candidate.frontmatter.category === post.frontmatter.category ? 4 : 0;
      const score = categoryScore + sharedTags;

      return { candidate, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.candidate.frontmatter.date === b.candidate.frontmatter.date) return 0;
      return a.candidate.frontmatter.date < b.candidate.frontmatter.date ? 1 : -1;
    })
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
