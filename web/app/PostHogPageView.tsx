'use client';

import { PostHogPageView as PostHogPageViewComponent } from '@posthog/next';
import { usePathname } from 'next/navigation';

import { getWebsiteAnalyticsPage } from '../lib/site-analytics';

export function WebsitePostHogPageView() {
  const pathname = usePathname();
  return getWebsiteAnalyticsPage(pathname) ? <PostHogPageViewComponent /> : null;
}
