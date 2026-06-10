import type { Metadata } from 'next';

import { SkillPage } from '../../../components/SkillPage';
import { readOpenClawSkillMarkdown } from '../../../lib/skill-markdown';
import { defaultOgImage } from '../../../lib/og-meta';
import { absoluteUrl } from '../../../lib/site';

export const dynamic = 'force-static';
export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'OpenClaw Skill',
  description:
    'Hosted OpenClaw skill with setup, verification, messaging, and troubleshooting instructions for Agent Relay.',
  keywords: ['OpenClaw skill', 'Agent Relay skill', 'OpenClaw setup guide', 'relay workspace invite'],
  alternates: {
    canonical: absoluteUrl('/openclaw/skill'),
  },
  openGraph: {
    title: 'OpenClaw Skill',
    description: 'Hosted setup and troubleshooting instructions for connecting OpenClaw to Agent Relay.',
    url: absoluteUrl('/openclaw/skill'),
    type: 'article',
    images: [defaultOgImage()],
  },
  twitter: {
    title: 'OpenClaw Skill',
    description: 'Hosted setup and troubleshooting instructions for OpenClaw on Agent Relay.',
    card: 'summary_large_image',
    images: [defaultOgImage().url],
  },
};

export default function LegacyOpenClawSkillPage() {
  return (
    <SkillPage
      title="Agent Relay for OpenClaw"
      lead="Full setup, verification, messaging, and troubleshooting instructions for connecting an OpenClaw instance to Agent Relay."
      markdown={readOpenClawSkillMarkdown()}
    />
  );
}
