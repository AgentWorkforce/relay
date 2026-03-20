import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/openclaw', '/openclaw/skill', '/docs', '/blog'],
        disallow: ['/openclaw/skill/invite/', '/skill/invite/'],
      },
    ],
    sitemap: 'https://agentrelay.dev/sitemap.xml',
    host: 'https://agentrelay.dev',
  };
}
