import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../../../components/GitHubStars';
import { SiteFooter } from '../../../components/SiteFooter';
import { SiteNav } from '../../../components/SiteNav';
import { absoluteUrl } from '../../../lib/site';
import { DeployButtonShowcase } from './DeployButtonShowcase';

const title = 'Deploy Button';
const description =
  'Design variants for the "Deploy on Agent Relay" embed button. Review on light and dark stages and pick a direction.';

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: absoluteUrl('/brand/deploy-button'),
  },
};

export default function DeployButtonPage() {
  return (
    <>
      <SiteNav actions={<GitHubStarsBadge />} />
      <DeployButtonShowcase />
      <SiteFooter />
    </>
  );
}
