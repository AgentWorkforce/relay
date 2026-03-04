import { notFound } from 'next/navigation';

import { SkillPage } from '../../../../components/SkillPage';
import { applyInviteToken, readSkillMarkdown } from '../../../../lib/skill-markdown';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function InvitePage({ params }: PageProps) {
  const { token } = await params;
  const inviteToken = decodeURIComponent(token).trim();
  if (!inviteToken) notFound();

  return <SkillPage markdown={applyInviteToken(readSkillMarkdown(), inviteToken)} />;
}
