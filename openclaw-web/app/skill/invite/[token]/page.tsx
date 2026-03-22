import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SkillPage } from '../../../../components/SkillPage';
import { applyInviteToken, readSkillMarkdown } from '../../../../lib/skill-markdown';
import { sitePath } from '../../../../lib/site';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const INVITE_TOKEN_PATTERN = /^rk_live_[A-Za-z0-9_-]+$/;

type PageProps = {
  params: Promise<{
    token: string;
  }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  let decodedToken = '';

  try {
    decodedToken = decodeURIComponent(token).trim();
  } catch {
    return {
      title: 'OpenClaw Workspace Invite',
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  if (!decodedToken || !INVITE_TOKEN_PATTERN.test(decodedToken)) {
    return {
      title: 'OpenClaw Workspace Invite',
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  return {
    title: 'OpenClaw Workspace Invite',
    description: 'Private invite instructions for joining an Agent Relay workspace from OpenClaw.',
    alternates: {
      canonical: sitePath('/skill'),
    },
    robots: {
      index: false,
      follow: false,
      nocache: true,
      googleBot: {
        index: false,
        follow: false,
        noimageindex: true,
        nosnippet: true,
      },
    },
  };
}

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
