import type { MetadataRoute } from 'next';

import { getAllPosts } from '../lib/blog';
import { getAllDocSlugs } from '../lib/docs-nav';

const SITE_URL = 'https://agentrelay.dev';

function absoluteUrl(path: string) {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: absoluteUrl('/'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: absoluteUrl('/openclaw'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: absoluteUrl('/openclaw/skill'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: absoluteUrl('/blog'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: absoluteUrl('/primitives'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
  ];

  const docsRoutes: MetadataRoute.Sitemap = getAllDocSlugs().map((slug) => ({
    url: absoluteUrl(`/docs/${slug}`),
    lastModified: now,
    changeFrequency: 'weekly',
    priority: slug === 'introduction' ? 0.9 : 0.8,
  }));

  const blogRoutes: MetadataRoute.Sitemap = getAllPosts().map((post) => ({
    url: absoluteUrl(`/blog/${post.slug}`),
    lastModified: post.frontmatter.date ? new Date(post.frontmatter.date) : now,
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  return [...staticRoutes, ...docsRoutes, ...blogRoutes];
}
