'use client';

import Link from 'next/link';

import { FadeIn } from '../../../components/FadeIn';
import { AgentArt } from '../../../components/agents/AgentArt';
import { ForkAgentButton } from '../../../components/agents/ForkAgentButton';
import { INTEGRATION_LABELS, sourceUrl, type Agent } from '../../../lib/agents';
import s from '../agents.module.css';

export function AgentDetail({ agent }: { agent: Agent }) {
  return (
    <div className={s.page}>
      <div className={s.backRow}>
        <Link href="/agents" className={s.backLink}>
          ← All agents
        </Link>
      </div>

      <div className={s.detail}>
        <FadeIn direction="up">
          <div className={s.detailBanner}>
            <AgentArt agent={agent} variant="banner" alt={`${agent.name} banner`} loading="eager" />
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={80}>
          <div className={s.detailHead}>
            <div className={s.titleRow}>
              <h1 className={s.detailTitle}>{agent.name}</h1>
              <a
                href={sourceUrl(agent)}
                target="_blank"
                rel="noopener noreferrer"
                className={s.titleGitHub}
                aria-label={`View ${agent.name} source on GitHub`}
                title="View on GitHub"
              >
                <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </a>
            </div>
            <p className={s.detailTagline}>{agent.tagline}</p>
            <div className={s.chips}>
              {agent.integrations.map((integration) => (
                <span key={integration} className={s.chip}>
                  {INTEGRATION_LABELS[integration]}
                </span>
              ))}
            </div>
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={140}>
          <div className={s.ctaRow}>
            <ForkAgentButton
              agent={agent}
              primaryClassName={s.ctaPrimary}
              secondaryClassName={s.ctaSecondary}
            />
          </div>
        </FadeIn>

        <div className={s.detailBody}>
          <FadeIn direction="up">
            <div>
              <h2 className={s.sectionTitle}>What it does</h2>
              <p className={s.lead}>{agent.description}</p>

              <h2 className={s.sectionTitle}>Highlights</h2>
              <ul className={s.highlights}>
                {agent.highlights.map((highlight) => (
                  <li key={highlight} className={s.highlight}>
                    <span className={s.highlightDot} />
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            </div>
          </FadeIn>

          <FadeIn direction="up" delay={100}>
            <aside className={s.metaCard}>
              <div className={s.metaRow}>
                <span className={s.metaLabel}>Trigger</span>
                <span className={s.metaValue}>{agent.trigger.summary}</span>
                <div className={s.codeChips}>
                  <span className={s.triggerKind} data-kind={agent.trigger.kind}>
                    {agent.trigger.kind === 'schedule' ? 'Schedule' : 'Event'}
                  </span>
                  <span className={s.codeChip}>{agent.trigger.detail}</span>
                </div>
              </div>
              <div className={s.metaRow}>
                <span className={s.metaLabel}>Runtime</span>
                <span className={s.metaValue}>{agent.runtime}</span>
              </div>
              <div className={s.metaRow}>
                <span className={s.metaLabel}>Integrations</span>
                <div className={s.chips}>
                  {agent.integrations.map((integration) => (
                    <span key={integration} className={s.chip}>
                      {INTEGRATION_LABELS[integration]}
                    </span>
                  ))}
                </div>
              </div>
              {agent.inputs.length > 0 && (
                <div className={s.metaRow}>
                  <span className={s.metaLabel}>Configure</span>
                  <div className={s.codeChips}>
                    {agent.inputs.map((input) => (
                      <span key={input} className={s.codeChip}>
                        {input}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </FadeIn>
        </div>
      </div>

      <div className={s.poweredWrapper}>
        <FadeIn direction="up">
          <div className={s.poweredCard}>
            <span className={s.poweredEyebrow}>Ready to run it?</span>
            <p className={s.poweredText}>
              Launch {agent.name} on Agent Relay in one click, or fork the source and tailor it to your team.
            </p>
            <div className={s.ctaRow} style={{ marginTop: 0, justifyContent: 'center' }}>
              <ForkAgentButton
                agent={agent}
                primaryClassName={s.ctaPrimary}
                secondaryClassName={s.ctaSecondary}
              />
            </div>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}
