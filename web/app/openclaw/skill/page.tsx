import type { Metadata } from 'next';

import { SkillPage } from '../../../components/SkillPage';
import { readSkillMarkdown } from '../../../lib/skill-markdown';
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
  },
  twitter: {
    title: 'OpenClaw Skill',
    description: 'Hosted setup and troubleshooting instructions for OpenClaw on Agent Relay.',
    card: 'summary',
  },
};

export default function LegacyOpenClawSkillPage() {
  return <SkillPage markdown={readSkillMarkdown()} />;
}
