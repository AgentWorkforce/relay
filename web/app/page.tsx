import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../components/GitHubStars';
import { SiteFooter } from '../components/SiteFooter';
import { SiteNav } from '../components/SiteNav';
import {
  A2AFeature,
  AgentToolsFeature,
  Deploy,
  DeliveryFeature,
  Hero,
  HowItWorks,
  MessagingFeature,
  QuickStart,
  Waitlist,
  WaveDivider,
} from '../components/home';
import { HOME_OG_IMAGE_PATH, ogImage } from '../lib/og-meta';
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
    images: [ogImage(HOME_OG_IMAGE_PATH, 'Agent Relay — Headless Slack for Agents')],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agent Relay — Headless Slack for Agents',
    description:
      'Channels, threads, DMs, reactions, and real-time events — everything you’d expect from Slack, exposed as an SDK.',
    images: [absoluteUrl(HOME_OG_IMAGE_PATH)],
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
          <HowItWorks />
          <DeliveryFeature />
          <WaveDivider variant="feature" />
          <AgentToolsFeature />
          <WaveDivider variant="a2a" className={s.a2aSeparator} />
          <A2AFeature />
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
