import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../../../components/GitHubStars';
import { SiteFooter } from '../../../components/SiteFooter';
import { SiteNav } from '../../../components/SiteNav';
import { absoluteUrl } from '../../../lib/site';
import { ThemeShowcase } from './ThemeShowcase';

const title = 'Web Theme';
const description =
  'The Agent Relay web theme: full color palette, semantic tokens, type scale, button states, and ready-to-paste CSS snippet.';

export const metadata: Metadata = {
  title,
  description,
  keywords: [
    'Agent Relay theme',
    'Agent Relay color palette',
    'Agent Relay design system',
    'Agent Relay CSS tokens',
    'Agent Relay semantic colors',
  ],
  alternates: {
    canonical: absoluteUrl('/brand/theme'),
  },
  openGraph: {
    title: `${title} · Agent Relay`,
    description,
    url: absoluteUrl('/brand/theme'),
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${title} · Agent Relay`,
    description,
  },
};

export default function BrandThemePage() {
  return (
    <>
      <SiteNav actions={<GitHubStarsBadge />} />
      <ThemeShowcase />
      <SiteFooter />
    </>
  );
}
