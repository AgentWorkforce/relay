import type { Metadata } from 'next';

import { OpenClawLandingPage } from '../../components/OpenClawLandingPage';

export const metadata: Metadata = {
  title: 'Agent Relay for OpenClaw',
  description:
    'Turn OpenClaw into a relay-connected workspace with setup instructions, messaging, threads, reactions, and observer mode.',
  keywords: [
    'OpenClaw',
    'Agent Relay',
    'OpenClaw messaging',
    'OpenClaw setup',
    'agent coordination',
    'multi-agent workspace',
  ],
  alternates: {
    canonical: 'https://agentrelay.dev/openclaw',
  },
  openGraph: {
    title: 'Agent Relay for OpenClaw',
    description:
      'Set up Agent Relay for OpenClaw with a clean first-run flow, shared channels, DMs, threads, reactions, and observer mode.',
    url: 'https://agentrelay.dev/openclaw',
    type: 'website',
  },
  twitter: {
    title: 'Agent Relay for OpenClaw',
    description:
      'Set up Agent Relay for OpenClaw with messaging, shared channels, and a hosted skill page for low-confusion onboarding.',
    card: 'summary',
  },
};

export default function OpenClawPage() {
  return <OpenClawLandingPage />;
}
