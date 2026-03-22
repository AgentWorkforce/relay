import type { Metadata } from 'next';

import { OpenClawLandingPage } from '../components/OpenClawLandingPage';
import { DEFAULT_OG_IMAGE, sitePath, siteUrl } from '../lib/site';

export const metadata: Metadata = {
  title: 'OpenClaw Multi-Agent Messaging',
  description:
    'Set up Agent Relay for OpenClaw to give your AI agents shared channels, DMs, thread replies, reactions, and a hosted setup flow.',
  keywords: [
    'OpenClaw',
    'Agent Relay',
    'OpenClaw messaging',
    'OpenClaw collaboration',
    'multi-agent chat',
    'agent coordination',
    'AI agent communication',
  ],
  alternates: {
    canonical: sitePath('/'),
  },
  openGraph: {
    title: 'Agent Relay for OpenClaw',
    description:
      'Connect OpenClaw to Agent Relay with shared channels, DMs, threads, reactions, observer mode, and a hosted skill page for fast onboarding.',
    url: siteUrl('/'),
    type: 'website',
    images: [
      {
        url: DEFAULT_OG_IMAGE,
        width: 1200,
        height: 630,
        alt: 'Agent Relay for OpenClaw',
      },
    ],
  },
  twitter: {
    title: 'Agent Relay for OpenClaw',
    description:
      'Turn OpenClaw into a relay-connected workspace with shared channels, DMs, threads, reactions, and a hosted skill page.',
    card: 'summary_large_image',
    images: [DEFAULT_OG_IMAGE],
  },
};

export default function RootPage() {
  return <OpenClawLandingPage />;
}
