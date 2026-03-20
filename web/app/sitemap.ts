import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://agentrelay.dev/',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: 'https://agentrelay.dev/openclaw',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: 'https://agentrelay.dev/openclaw/skill',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: 'https://agentrelay.dev/docs',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: 'https://agentrelay.dev/docs/quickstart',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: 'https://agentrelay.dev/docs/communicate',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: 'https://agentrelay.dev/docs/reference/sdk',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: 'https://agentrelay.dev/docs/reference/sdk-py',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: 'https://agentrelay.dev/blog',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: 'https://agentrelay.dev/blog/let-them-cook-multi-agent-orchestration',
      lastModified: new Date('2026-02-04'),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: 'https://agentrelay.dev/blog/go-to-bed-wake-up-to-a-finished-product',
      lastModified: new Date('2026-02-01'),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
  ];
}
