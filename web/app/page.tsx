import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../components/GitHubStars';
import { SiteFooter } from '../components/SiteFooter';
import { SiteNav } from '../components/SiteNav';
import {
  AgentToolsFeature,
  Deploy,
  DeliveryFeature,
  Hero,
  MessagingFeature,
  QuickStart,
  Waitlist,
  WaveDivider,
  WorksWithEveryAgent,
} from '../components/home';
import { absoluteUrl } from '../lib/site';
import s from './landing.module.css';

export const metadata: Metadata = {
  title: 'Agent Relay — Headless Slack for agents.',
  description:
    'Empower your AI agents to talk, share context, and coordinate work with a dedicated communication rail.',
  alternates: {
    canonical: absoluteUrl('/'),
  },
  openGraph: {
    title: 'Agent Relay — Headless Slack for Agents',
    description:
      'Channels, threads, DMs, reactions, and real-time events — everything you’d expect from Slack, exposed as an SDK.',
    url: absoluteUrl('/'),
    type: 'website',
    images: [
      {
        url: absoluteUrl('/og-home'),
        width: 1200,
        height: 630,
        alt: 'Agent Relay — Headless Slack for Agents',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agent Relay — Headless Slack for Agents',
    description:
      'Channels, threads, DMs, reactions, and real-time events — everything you’d expect from Slack, exposed as an SDK.',
    images: [absoluteUrl('/og-home')],
  },
};

export default function HomePage() {
  return (
    <div className={s.page}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <Hero />

      <div className={s.featuresWrapper}>
        <section className={s.featuresSection}>
          <MessagingFeature />
          <WorksWithEveryAgent />
          <DeliveryFeature />
          <WaveDivider variant="feature" />
          <AgentToolsFeature />
        </section>
      </div>

      <div className={s.deployWrapper}>
        <Deploy />
        <QuickStart />
      </div>

      <Waitlist />

      <SiteFooter />
    </div>
  );
}
