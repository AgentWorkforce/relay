import type { Metadata } from 'next';

import { SkillPage } from '../../components/SkillPage';
import { defaultOgImage } from '../../lib/og-meta';
import { absoluteUrl } from '../../lib/site';
import { readAgentRelaySkillMarkdown } from '../../lib/skill-markdown';

export const dynamic = 'force-static';
export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'Agent Relay Skill',
  description:
    'Hosted Agent Relay onboarding skill for choosing orchestrator vs participant instructions and getting agents onto a shared relay.',
  keywords: [
    'Agent Relay skill',
    'orchestrating-agent-relay',
    'using-agent-relay',
    'agent workspace setup',
    'multi-agent coordination',
  ],
  alternates: {
    canonical: absoluteUrl('/skill'),
  },
  openGraph: {
    title: 'Agent Relay Skill',
    description:
      'One hosted handoff for agents: start a Relay workspace, choose the orchestrator or participant role, and coordinate with the team.',
    url: absoluteUrl('/skill'),
    type: 'article',
    images: [defaultOgImage()],
  },
  twitter: {
    title: 'Agent Relay Skill',
    description: 'Hosted Agent Relay onboarding for orchestrators, human drivers, and registered workers.',
    card: 'summary_large_image',
    images: [defaultOgImage().url],
  },
};

export default function AgentRelaySkillPage() {
  return (
    <SkillPage
      title="Agent Relay Skill"
      lead="One plain handoff for starting a Relay workspace, choosing orchestrator vs participant mode, and getting agents communicating with the right tools."
      markdown={readAgentRelaySkillMarkdown()}
    />
  );
}
