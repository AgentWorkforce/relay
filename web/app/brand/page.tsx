import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { absoluteUrl } from '../../lib/site';
import { BrandShowcase } from './BrandShowcase';

const title = 'Brand Kit';
const description =
  'Agent Relay brand assets: downloadable logo, mark, and wordmark PNGs in every variant. Grab the kit as a zip or individual files.';

export const metadata: Metadata = {
  title,
  description,
  keywords: [
    'Agent Relay brand',
    'Agent Relay logo',
    'Agent Relay brand kit',
    'Agent Relay press kit',
    'Agent Relay color palette',
    'Agent Relay design system',
  ],
  alternates: {
    canonical: absoluteUrl('/brand'),
  },
  openGraph: {
    title: `${title} · Agent Relay`,
    description,
    url: absoluteUrl('/brand'),
    type: 'website',
    images: [
      {
        url: absoluteUrl('/brand-kit/agent-relay-logo-circle.png'),
        width: 1024,
        height: 1024,
        alt: 'Agent Relay logo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${title} · Agent Relay`,
    description,
    images: [absoluteUrl('/brand-kit/agent-relay-logo-circle.png')],
  },
};

export default function BrandPage() {
  return (
    <>
      <SiteNav actions={<GitHubStarsBadge />} />
      <BrandShowcase />
      <SiteFooter />
    </>
  );
}
