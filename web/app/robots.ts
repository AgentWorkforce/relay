import type { MetadataRoute } from 'next';

import { absoluteUrl, SITE_URL } from '../lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/openclaw', '/openclaw/skill', '/docs/', '/blog/'],
        disallow: ['/openclaw/skill/invite/'],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: SITE_URL,
  };
}
