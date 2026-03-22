import type { MetadataRoute } from 'next';

import { getAllPosts } from '../lib/blog';
import { getAllDocSlugs } from '../lib/docs-nav';

const SITE_URL = 'https://agentrelay.dev';
const OPENCLAW_USE_CASE_SLUGS = [
  'multi-agent-workflows-claude-codex',
  'how-to-let-ai-agents-message-each-other',
  'agent-orchestration-for-coding-teams',
  'slack-style-messaging-for-ai-agents',
  'human-in-the-loop-agent-workflows',
] as const;

function siteUrl(path: string) {
  return `${SITE_URL}${path}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const docs = getAllDocSlugs().map((slug) => ({
    url: siteUrl(`/docs/${slug}`),
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: slug === 'introduction' ? 0.85 : 0.8,
  }));

  const blogPosts = getAllPosts().map((post) => ({
    url: siteUrl(`/blog/${post.slug}`),
    lastModified: post.frontmatter.date ? new Date(post.frontmatter.date) : lastModified,
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  const openclawUseCases = OPENCLAW_USE_CASE_SLUGS.map((slug) => ({
    url: siteUrl(`/openclaw/use-cases/${slug}`),
    lastModified,
    changeFrequency: 'weekly' as const,
    priority: 0.72,
  }));

  return [
    {
      url: siteUrl('/'),
      lastModified,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: siteUrl('/openclaw'),
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: siteUrl('/openclaw/skill'),
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    ...openclawUseCases,
    {
      url: siteUrl('/docs'),
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    ...docs,
    {
      url: siteUrl('/blog'),
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    ...blogPosts,
  ];
}
