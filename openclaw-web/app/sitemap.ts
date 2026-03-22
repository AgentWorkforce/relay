import type { MetadataRoute } from 'next';

import { siteUrl } from '../lib/site';
import { useCasePages } from '../lib/use-cases';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: siteUrl('/'),
      lastModified,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: siteUrl('/skill'),
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    ...useCasePages.map((page) => ({
      url: siteUrl(`/use-cases/${page.slug}`),
      lastModified,
      changeFrequency: 'weekly' as const,
      priority: 0.72,
    })),
  ];
}
