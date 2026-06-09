import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { GitHubStarsBadge } from '../../../components/GitHubStars';
import { SiteFooter } from '../../../components/SiteFooter';
import { SiteNav } from '../../../components/SiteNav';
import { agentAsset, allAgentSlugs, getAgent } from '../../../lib/agents';
import { absoluteUrl } from '../../../lib/site';
import { AgentDetail } from './AgentDetail';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return allAgentSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const agent = getAgent(slug);
  if (!agent) return { title: 'Not Found' };

  const title = `${agent.name} — Agent Relay`;
  const description = agent.tagline;
  const canonical = absoluteUrl(`/agents/${agent.slug}`);

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      ...(agent.hasCustomArt
        ? { images: [{ url: absoluteUrl(agentAsset(agent.slug, 'card')) }] }
        : {}),
    },
  };
}

export default async function AgentPage({ params }: PageProps) {
  const { slug } = await params;
  const agent = getAgent(slug);
  if (!agent) notFound();

  return (
    <>
      <SiteNav actions={<GitHubStarsBadge />} />
      <AgentDetail agent={agent} />
      <SiteFooter />
    </>
  );
}
