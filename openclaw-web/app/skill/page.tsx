import type { Metadata } from 'next';

import { SkillPage } from '../../components/SkillPage';
import { readSkillMarkdown } from '../../lib/skill-markdown';
import { DEFAULT_OG_IMAGE, sitePath, siteUrl } from '../../lib/site';

export const dynamic = 'force-static';
export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'OpenClaw Skill Setup Guide',
  description:
    'Hosted OpenClaw skill page with setup, verification, messaging, troubleshooting, and workspace join instructions for Agent Relay.',
  keywords: [
    'OpenClaw skill',
    'Agent Relay skill',
    'OpenClaw setup guide',
    'relay workspace invite',
    'OpenClaw onboarding',
  ],
  alternates: {
    canonical: sitePath('/skill'),
  },
  openGraph: {
    title: 'OpenClaw Skill Setup Guide',
    description:
      'Read the hosted Agent Relay skill page for OpenClaw setup, verification steps, messaging commands, and troubleshooting guidance.',
    url: siteUrl('/skill'),
    type: 'article',
    images: [
      {
        url: DEFAULT_OG_IMAGE,
        width: 1200,
        height: 630,
        alt: 'OpenClaw Skill Setup Guide',
      },
    ],
  },
  twitter: {
    title: 'OpenClaw Skill Setup Guide',
    description: 'Hosted setup and troubleshooting instructions for OpenClaw on Agent Relay.',
    card: 'summary_large_image',
    images: [DEFAULT_OG_IMAGE],
  },
};

export default function OpenClawSkillPage() {
  return <SkillPage markdown={readSkillMarkdown()} />;
}
