import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { absoluteUrl } from '../../lib/site';
import { AgentsGallery } from './AgentsGallery';

const title = 'Agents — Proactive agents ready to deploy';
const description =
  'A gallery of open-source proactive agents that review PRs, triage issues, monitor releases, and digest your work. Fork one and launch it on Agent Relay in one click.';

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: absoluteUrl('/agents'),
  },
  openGraph: {
    title,
    description,
    url: absoluteUrl('/agents'),
  },
};

export default function AgentsPage() {
  return (
    <>
      <SiteNav actions={<GitHubStarsBadge />} />
      <AgentsGallery />
      <SiteFooter />
    </>
  );
}
