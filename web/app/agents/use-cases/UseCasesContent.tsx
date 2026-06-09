'use client';

import Link from 'next/link';

import { FadeIn } from '../../../components/FadeIn';
import {
  agentAsset,
  getAgent,
  NON_PUBLIC_AGENT_LABELS,
  USE_CASE_GROUPS,
} from '../../../lib/agents';
import s from '../agents.module.css';

function slugifyTheme(theme: string): string {
  return theme
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function AgentRef({ slug }: { slug: string }) {
  const agent = getAgent(slug);
  if (agent) {
    return (
      <Link href={`/agents/${agent.slug}`} className={s.agentRef}>
        {agent.hasCustomArt && (
          <img className={s.agentRefAvatar} src={agentAsset(agent.slug, 'avatar')} alt="" />
        )}
        {agent.name}
      </Link>
    );
  }
  const label = NON_PUBLIC_AGENT_LABELS[slug] ?? slug;
  return <span className={s.agentRef}>{label}</span>;
}

export function UseCasesContent() {
  return (
    <div className={s.page}>
      <div className={s.heroSection}>
        <section className={s.hero}>
          <FadeIn direction="up">
            <div className={s.badge}>
              <span className={s.badgeDot} />
              USE CASES
            </div>
          </FadeIn>

          <FadeIn direction="up" delay={60}>
            <h1 className={s.headline}>
              What proactive agents
              <br />
              do for you
            </h1>
          </FadeIn>

          <FadeIn direction="up" delay={120}>
            <p className={s.subtitle}>
              These agents do not wait to be asked. They watch the work where it happens — pull requests,
              issues, calls, release feeds — and take the next step on their own.
            </p>
          </FadeIn>

          <FadeIn direction="up" delay={180}>
            <nav className={s.pillNav}>
              {USE_CASE_GROUPS.map((group) => (
                <a key={group.theme} href={`#${slugifyTheme(group.theme)}`} className={s.pill}>
                  {group.theme}
                </a>
              ))}
            </nav>
          </FadeIn>
        </section>
      </div>

      <div className={s.bands}>
        {USE_CASE_GROUPS.map((group, gi) => (
          <div
            key={group.theme}
            id={slugifyTheme(group.theme)}
            className={`${s.band} ${gi % 2 === 1 ? s.bandAlt : ''}`}
          >
            <section className={s.bandInner}>
              <FadeIn direction="up">
                <div className={s.bandHeader}>
                  <h2 className={s.bandTheme}>{group.theme}</h2>
                  <p className={s.bandBlurb}>{group.blurb}</p>
                </div>
              </FadeIn>

              <div className={s.useGrid}>
                {group.cases.map((useCase, ci) => (
                  <FadeIn key={useCase.title} direction="up" delay={(ci % 2) * 60}>
                    <div className={s.useCard}>
                      <h3 className={s.useTitle}>{useCase.title}</h3>
                      <p className={s.useDesc}>{useCase.description}</p>
                      <div className={s.agentRefs}>
                        {useCase.agents.map((slug) => (
                          <AgentRef key={slug} slug={slug} />
                        ))}
                      </div>
                    </div>
                  </FadeIn>
                ))}
              </div>
            </section>
          </div>
        ))}
      </div>

      <div className={s.poweredWrapper}>
        <FadeIn direction="up">
          <div className={s.poweredCard}>
            <span className={s.poweredEyebrow}>Powered by Agent Relay</span>
            <p className={s.poweredText}>
              Browse the full gallery and launch any of these agents on Agent Relay in one click.
            </p>
            <Link href="/agents" className={s.pill}>
              Explore all agents →
            </Link>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}
