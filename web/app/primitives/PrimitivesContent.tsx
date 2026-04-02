'use client';

import Link from 'next/link';

import { FadeIn } from '../../components/FadeIn';
import s from './primitives.module.css';

const primitives = [
  {
    id: 'auth',
    badge: 'RELAYAUTH',
    title: 'Auth',
    subtitle: 'Identity & authorization for AI agents',
    description:
      'Tokens, scopes, RBAC, policies, and audit trails for multi-agent systems. Give every agent a real identity, a human sponsor, and access that can be verified, revoked, and explained.',
    features: [
      { title: 'JWT Tokens', desc: 'Issue short-lived access tokens with sponsor chains, workspace context, and edge-verifiable claims.' },
      { title: 'Scope-Based Access', desc: 'Grant exact permissions with plane, resource, action, and optional path constraints.' },
      { title: 'RBAC Policies', desc: 'Bundle scopes into named roles and layer deny-first policies from org to workspace to agent.' },
      { title: 'Audit Trails', desc: 'Track every token use, scope decision, and admin action back to a responsible human.' },
      { title: 'Token Revocation', desc: 'Invalidate credentials globally in under a second with edge-aware revocation checks.' },
      { title: 'Budget Enforcement', desc: 'Cap spend, rate, and risky actions before an agent runs away with production access.' },
    ],
    docsHref: '/docs',
    githubHref: 'https://github.com/agentworkforce/relayauth',
  },
  {
    id: 'file',
    badge: 'RELAYFILE',
    title: 'File',
    subtitle: 'Headless filesystem for AI agents',
    description:
      'One place to read, write, watch, and coordinate files. Shared volumes, locks, metadata, and realtime change events let multi-agent systems work on the same state without building storage plumbing first.',
    features: [
      { title: 'Read Files', desc: 'Fetch full contents or byte ranges with the same API across local and remote volumes.' },
      { title: 'Write Files', desc: 'Create, overwrite, append, and patch files safely from agents and tools.' },
      { title: 'Watch Changes', desc: 'Subscribe to file events and trigger follow-up work the moment something changes.' },
      { title: 'Shared Volumes', desc: 'Mount the same workspace into multiple agents so they can collaborate on identical state.' },
      { title: 'File Locking', desc: 'Coordinate concurrent writes with explicit locks and conflict-aware workflows.' },
      { title: 'Permissions', desc: 'Control which agents can read, write, watch, or administer each path.' },
    ],
    docsHref: '/docs',
    githubHref: 'https://github.com/agentworkforce/relayfile',
  },
  {
    id: 'message',
    badge: 'RELAYCAST',
    title: 'Message',
    subtitle: 'Headless messaging for AI agents',
    description:
      'Channels, threads, DMs, and real-time events for multi-agent systems. Two API calls to start, zero infrastructure to manage.',
    features: [
      { title: 'Channels', desc: 'Organize agent communication into named channels. Public, private, or ephemeral.' },
      { title: 'Threads', desc: 'Reply to any message to create a focused thread without cluttering the main channel.' },
      { title: 'Direct Messages', desc: 'Send private messages between agents for side conversations and coordination.' },
      { title: 'Reactions', desc: 'React to messages with emoji to signal approval, completion, or attention.' },
      { title: 'Real-Time Events', desc: 'Stream channel events via WebSocket or SSE for instant message delivery.' },
      { title: 'Inbox', desc: 'Each agent gets a unified inbox of unread mentions, DMs, and thread replies.' },
    ],
    docsHref: '/docs',
    githubHref: 'https://github.com/agentworkforce/relaycast',
  },
  {
    id: 'schedule',
    badge: 'RELAYCRON',
    title: 'Schedule',
    subtitle: 'Cron scheduling for AI agents',
    description:
      'Cron expressions, webhook delivery, WebSocket real-time events, and execution logs — all built on Cloudflare Durable Objects.',
    features: [
      { title: 'Cron Expressions', desc: 'Full cron expression support with second-level precision. Timezone-aware scheduling out of the box.' },
      { title: 'Webhook Delivery', desc: 'HTTP POST deliveries with automatic retries, exponential backoff, and configurable timeout.' },
      { title: 'WebSocket Events', desc: 'Subscribe to schedule lifecycle events in real-time — fired, success, failure, and retry.' },
      { title: 'Execution Logs', desc: 'Every job execution logged with request/response payloads, status codes, and latency.' },
      { title: 'Durable Object Alarms', desc: 'Automatic failover across 300+ data centers. Your jobs fire even if individual PoPs go down.' },
      { title: 'TypeScript & Python SDKs', desc: 'First-party SDKs with full type safety, auto-completion, and chainable methods.' },
    ],
    docsHref: '/docs',
    githubHref: 'https://app.agentcron.dev',
  },
];

const navItems = primitives.map((p) => ({ id: p.id, label: p.title }));

export function PrimitivesContent() {
  return (
    <div className={s.page}>
      <div className={s.heroSection}>
        <section className={s.hero}>
          <FadeIn direction="up">
            <div className={s.badge}>
              <span className={s.badgeDot} />
              PRIMITIVES
            </div>
          </FadeIn>

          <FadeIn direction="up" delay={60}>
            <h1 className={s.headline}>
              The building blocks for
              <br />
              agent infrastructure
            </h1>
          </FadeIn>

          <FadeIn direction="up" delay={120}>
            <p className={s.subtitle}>
              Four primitives that give AI agents identity, shared files,
              real-time messaging, and scheduled execution — without building
              infrastructure from scratch.
            </p>
          </FadeIn>

          <FadeIn direction="up" delay={180}>
            <nav className={s.pillNav}>
              {navItems.map((item) => (
                <a key={item.id} href={`#${item.id}`} className={s.pill}>
                  {item.label}
                </a>
              ))}
            </nav>
          </FadeIn>
        </section>
      </div>

      {primitives.map((primitive, pi) => (
        <div
          key={primitive.id}
          id={primitive.id}
          className={`${s.primitiveSection} ${pi % 2 === 1 ? s.primitiveSectionAlt : ''}`}
        >
          <section className={s.primitiveInner}>
            <FadeIn direction="up">
              <div className={s.primitiveBadge}>{primitive.badge}</div>
              <h2 className={s.primitiveTitle}>{primitive.title}</h2>
              <p className={s.primitiveSubhead}>{primitive.subtitle}</p>
              <p className={s.primitiveDesc}>{primitive.description}</p>
            </FadeIn>

            <div className={s.featuresGrid}>
              {primitive.features.map((feature, fi) => (
                <FadeIn
                  key={feature.title}
                  direction="up"
                  delay={fi * 50}
                  className={s.featureCol}
                >
                  <div className={s.featureCard}>
                    <h3 className={s.featureTitle}>{feature.title}</h3>
                    <p className={s.featureDesc}>{feature.desc}</p>
                  </div>
                </FadeIn>
              ))}
            </div>

            <FadeIn direction="up" delay={200}>
              <div className={s.primitiveCtas}>
                <Link href={primitive.docsHref} className={s.ctaPrimary}>
                  Read the Docs
                </Link>
                <a
                  href={primitive.githubHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={s.ctaSecondary}
                >
                  {primitive.id === 'schedule' ? 'Start building' : 'View on GitHub'}
                </a>
              </div>
            </FadeIn>
          </section>
        </div>
      ))}

      <div className={s.poweredWrapper}>
        <FadeIn direction="up">
          <div className={s.poweredCard}>
            <span className={s.poweredEyebrow}>Powered by Agent Relay</span>
            <p className={s.poweredText}>
              All four primitives run on the same platform. One workspace, one
              API key, and one SDK across auth, files, messaging, and scheduling.
            </p>
            <Link href="/docs" className={s.ctaPrimary}>
              Get started
            </Link>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}
