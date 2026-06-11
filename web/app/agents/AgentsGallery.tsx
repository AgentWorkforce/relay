'use client';

import Link from 'next/link';
import { Box, Database, Zap } from 'lucide-react';

import { FadeIn } from '../../components/FadeIn';
import { AgentArt } from '../../components/agents/AgentArt';
import { BuildYourOwn } from '../../components/agents/BuildYourOwn';
import { AGENTS, INTEGRATION_LABELS } from '../../lib/agents';
import s from './agents.module.css';

const CAPABILITIES = [
  {
    Icon: Box,
    title: 'Its own sandbox',
    text: 'Every agent runs isolated in its own cloud sandbox — no shared state, no blast radius.',
  },
  {
    Icon: Database,
    title: 'Persistent memory',
    text: 'Agents remember context across runs with scoped, expiring workspace memory.',
  },
  {
    Icon: Zap,
    title: 'One-click deploy',
    text: 'Launch on Agent Relay Cloud, or fork the source and run it yourself.',
  },
];

export function AgentsGallery() {
  return (
    <div className={s.page}>
      <div className={s.heroSection}>
        <section className={s.hero}>
          <FadeIn direction="up">
            <div className={s.badge}>
              <span className={s.badgeDot} />
              AGENT GALLERY
            </div>
          </FadeIn>

          <FadeIn direction="up" delay={60}>
            <h1 className={s.headline}>
              Proactive agents,
              <br />
              ready to deploy
            </h1>
          </FadeIn>

          <FadeIn direction="up" delay={120}>
            <p className={s.subtitle}>
              A gallery of open-source agents that watch your repos, inbox, and stack — then act. Pick one,
              fork it, and launch it on Agent Relay in one click.
            </p>
          </FadeIn>

          <FadeIn direction="up" delay={180}>
            <nav className={s.pillNav}>
              <Link href="/agents/use-cases" className={s.pill}>
                Browse use cases
              </Link>
              <a
                href="https://github.com/AgentWorkforce/agents"
                target="_blank"
                rel="noopener noreferrer"
                className={s.pill}
              >
                View on GitHub
              </a>
            </nav>
          </FadeIn>
        </section>
      </div>

      <div className={s.capabilities}>
        {CAPABILITIES.map(({ Icon, ...cap }, i) => (
          <FadeIn key={cap.title} direction="up" delay={i * 70}>
            <div className={s.capCard}>
              <span className={s.capIcon}>
                <Icon aria-hidden="true" />
              </span>
              <div>
                <h3 className={s.capTitle}>{cap.title}</h3>
                <p className={s.capText}>{cap.text}</p>
              </div>
            </div>
          </FadeIn>
        ))}
      </div>

      <div className={s.gallery}>
        <div className={s.grid}>
          {AGENTS.map((agent, i) => (
            <FadeIn key={agent.slug} direction="up" delay={(i % 3) * 60} className={s.col}>
              <Link href={`/agents/${agent.slug}`} className={s.card}>
                <div className={s.cardMedia}>
                  <AgentArt agent={agent} variant="card-sm" alt={`${agent.name} card`} />
                </div>
                <div className={s.cardBody}>
                  <h2 className={s.cardName}>{agent.name}</h2>
                  <p className={s.cardTagline}>{agent.tagline}</p>
                  <div className={s.chips}>
                    {agent.integrations.map((integration) => (
                      <span key={integration} className={s.chip}>
                        {INTEGRATION_LABELS[integration]}
                      </span>
                    ))}
                  </div>
                  <div className={s.cardFooter}>
                    <span className={s.cardArrow}>View agent →</span>
                  </div>
                </div>
              </Link>
            </FadeIn>
          ))}
        </div>
      </div>

      <BuildYourOwn />

      <div className={s.poweredWrapper}>
        <FadeIn direction="up">
          <div className={s.poweredCard}>
            <span className={s.poweredEyebrow}>Powered by Agent Relay</span>
            <p className={s.poweredText}>
              Every agent runs on the Agent Relay platform — identity, shared files, messaging, and scheduling
              out of the box. Fork one to your repo and make it yours.
            </p>
            <Link href="/agents/use-cases" className={s.pill}>
              See what they can do →
            </Link>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}
