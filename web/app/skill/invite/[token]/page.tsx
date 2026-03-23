import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';

type PageProps = {
  params: Promise<{
    token: string;
  }>;
};

export const metadata: Metadata = {
  alternates: {
    canonical: 'https://agentrelay.dev/openclaw/skill',
  },
};

export default async function InvitePage({ params }: PageProps) {
  const { token } = await params;
  permanentRedirect(`/openclaw/skill/invite/${encodeURIComponent(token)}`);
}
