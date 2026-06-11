import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../../../components/GitHubStars';
import { SiteFooter } from '../../../components/SiteFooter';
import { SiteNav } from '../../../components/SiteNav';
import { absoluteUrl } from '../../../lib/site';
import { UseCasesContent } from './UseCasesContent';

const title = 'Agent Use Cases — What proactive agents do for you';
const description =
  'Concrete proactive use cases: auto-review and merge PRs, prevent codebase entropy, turn requests into PRs, monitor releases, and ship daily digests — mapped to the agents that deliver them.';

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: absoluteUrl('/agents/use-cases'),
  },
  openGraph: {
    title,
    description,
    url: absoluteUrl('/agents/use-cases'),
  },
};

export default function UseCasesPage() {
  return (
    <>
      <SiteNav actions={<GitHubStarsBadge />} />
      <UseCasesContent />
      <SiteFooter />
    </>
  );
}
