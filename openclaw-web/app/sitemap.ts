import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
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
  ];
}
