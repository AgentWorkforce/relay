import { notFound } from 'next/navigation';

import { SkillPage } from '../../../../components/SkillPage';
import { applyInviteToken, readSkillMarkdown } from '../../../../lib/skill-markdown';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const INVITE_TOKEN_PATTERN = /^rk_live_[A-Za-z0-9_-]+$/;

type PageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function InvitePage({ params }: PageProps) {
  const { token } = await params;
  let inviteToken = '';
  try {
    inviteToken = decodeURIComponent(token).trim();
  } catch {
    notFound();
  }

  if (!inviteToken || !INVITE_TOKEN_PATTERN.test(inviteToken)) notFound();

  return <SkillPage markdown={applyInviteToken(readSkillMarkdown(), inviteToken)} />;
}
