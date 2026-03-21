import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';

export const metadata: Metadata = {
  alternates: {
    canonical: 'https://agentrelay.dev/openclaw/skill',
  },
};

export default function OpenClawSkillPage() {
  permanentRedirect('/openclaw/skill');
}
