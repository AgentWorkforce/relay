import { permanentRedirect } from 'next/navigation';

type PageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function LegacyOpenClawInvitePage({ params }: PageProps) {
  const { token } = await params;
  permanentRedirect(`/skill/invite/${encodeURIComponent(token)}`);
}
