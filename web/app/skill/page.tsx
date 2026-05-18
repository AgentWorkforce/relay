import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';

import { absoluteUrl } from '../../lib/site';

export const metadata: Metadata = {
  alternates: {
    canonical: absoluteUrl('/openclaw/skill'),
  },
};

export default function OpenClawSkillPage() {
  permanentRedirect('/openclaw/skill');
}
