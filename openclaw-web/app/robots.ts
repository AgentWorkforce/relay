import type { MetadataRoute } from 'next';

import { siteUrl } from '../lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/openclaw', '/openclaw/skill', '/openclaw/use-cases/'],
        disallow: ['/openclaw/skill/invite/'],
      },
    ],
    sitemap: siteUrl('/sitemap.xml'),
    host: 'https://agentrelay.dev',
  };
}
