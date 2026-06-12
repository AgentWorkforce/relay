import type { MetadataRoute } from 'next';

import { absoluteUrl, SITE_URL } from '../lib/site';

const AI_CRAWLERS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'GPTBot',
  'Claude-SearchBot',
  'Claude-User',
  'ClaudeBot',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: ['/'],
      })),
      {
        userAgent: '*',
        allow: [
          '/',
          '/skill',
          '/skill.md',
          '/openclaw',
          '/openclaw/skill',
          '/agents',
          '/agents/',
          '/docs/',
          '/blog/',
        ],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: SITE_URL,
  };
}
