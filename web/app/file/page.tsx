import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../../components/GitHubStars';

import { RelayfileContent } from './RelayfileContent';

export const metadata: Metadata = {
  title: 'Relayfile | Integration filesystem for AI agents',
  description:
    'Mount SaaS integrations as files so agents can read, write, watch, and coordinate through one realtime workspace.',
};

export default function FilePage() {
  return <RelayfileContent navActions={<GitHubStarsBadge />} />;
}
