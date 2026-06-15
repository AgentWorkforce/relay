import { Bot, SquareTerminal } from 'lucide-react';

import { AgentToolLogo } from '../AgentToolLogos';
import { FadeIn } from '../FadeIn';
import s from '../../app/landing.module.css';
import { GitHubIcon, OpenClawLogo, PythonLogo, TypeScriptLogo } from './icons';

/** A capability the relay layer provides, rendered as a chip below the diagram. */
interface RelayCapability {
  title: string;
  detail: string;
}

const RELAY_CAPABILITIES: readonly RelayCapability[] = [
  { title: 'DMs, channels & @mentions', detail: 'Slack-style routing between any agents.' },
  { title: 'Durable messaging & retries', detail: 'Delivery survives restarts and offline gaps.' },
  { title: 'Message receipts', detail: 'Know exactly when a handoff was acknowledged.' },
  { title: 'Search, history & webhooks', detail: 'Recover context and bridge external services.' },
];

/** Vertical down-and-up connector that links a source group to the relay card. */
function HowConnector() {
  return (
    <div className={s.howConnector} aria-hidden="true">
      <svg viewBox="0 0 40 72" fill="none" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="howDown" markerWidth="9" markerHeight="9" refX="4.5" refY="6" orient="auto">
            <path d="M0 0 L4.5 6 L9 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
          <marker id="howUp" markerWidth="9" markerHeight="9" refX="4.5" refY="3" orient="auto">
            <path d="M0 9 L4.5 3 L9 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        <path className={s.howConnectorPath} d="M15 6 L15 66" markerEnd="url(#howDown)" />
        <path className={s.howConnectorPath} d="M25 66 L25 6" markerEnd="url(#howUp)" />
      </svg>
    </div>
  );
}

export function HowItWorks() {
  return (
    <section className={s.howItWorks} aria-labelledby="how-it-works-title">
      <FadeIn direction="up" className={s.howHeader}>
        <h2 id="how-it-works-title" className={s.howTitle}>
          How it works
        </h2>
        <p className={s.howSubtitle}>
          Connect CLI agents and your own custom agents to a single communication rail. Agent Relay
          handles delivery, history, and coordination between them.
        </p>
      </FadeIn>

      <div className={s.howFlow}>
        <FadeIn direction="up" className={s.howSources}>
          <div className={s.howNode}>
            <span className={s.howNodeLabel}>CLI agents</span>
            <div className={s.howLogoRow}>
              <span className={s.howLogo}>
                <AgentToolLogo className={s.howLogoSvg} provider="claude" idPrefix="how-claude" />
              </span>
              <span className={s.howLogo}>
                <AgentToolLogo className={s.howLogoSvg} provider="codex" idPrefix="how-codex" />
              </span>
              <span className={s.howLogo}>
                <OpenClawLogo className={s.howLogoSvg} />
              </span>
              <span className={s.howLogo}>
                <SquareTerminal className={s.howLogoSvg} strokeWidth={1.8} aria-hidden="true" />
              </span>
            </div>
            <p className={s.howNodeCaption}>PTY driven, real-time message injection</p>
          </div>

          <div className={s.howNode}>
            <span className={s.howNodeLabel}>Your custom agents</span>
            <div className={s.howLogoRow}>
              <span className={s.howLogo}>
                <Bot className={s.howLogoSvg} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={s.howLogo}>
                <TypeScriptLogo className={s.howLogoSvg} />
              </span>
              <span className={s.howLogo}>
                <PythonLogo className={s.howLogoSvg} />
              </span>
              <span className={s.howLogo}>
                <GitHubIcon size={26} />
              </span>
            </div>
            <p className={s.howNodeCaption}>Drop-in SDK + bindings</p>
          </div>
        </FadeIn>

        <HowConnector />

        <FadeIn direction="up" delay={120} className={s.howRelay}>
          <div className={s.howRelayCard}>
            <img
              src="/brand-kit/agent-relay-mark.svg"
              alt=""
              width={44}
              height={36}
              className={s.howRelayMark}
            />
            <img
              src="/brand-kit/agent-relay-wordmark.svg"
              alt="Agent Relay"
              width={158}
              height={32}
              className={s.howRelayWordmark}
            />
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={200} className={s.howCapabilities}>
          {RELAY_CAPABILITIES.map((cap) => (
            <div key={cap.title} className={s.howCapability}>
              <span className={s.howCapabilityDot} aria-hidden="true" />
              <span>
                <strong>{cap.title}</strong>
                <span className={s.howCapabilityDetail}>{cap.detail}</span>
              </span>
            </div>
          ))}
        </FadeIn>
      </div>
    </section>
  );
}
