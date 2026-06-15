import type { ReactNode } from 'react';

import ClaudeCode from '@lobehub/icons/es/ClaudeCode';
import Codex from '@lobehub/icons/es/Codex';
import Cursor from '@lobehub/icons/es/Cursor';
import Github from '@lobehub/icons/es/Github';
import HermesAgent from '@lobehub/icons/es/HermesAgent';
import OpenClaw from '@lobehub/icons/es/OpenClaw';
import OpenCode from '@lobehub/icons/es/OpenCode';

import { FadeIn } from '../FadeIn';
import s from '../../app/landing.module.css';
import { PythonLogo, TypeScriptLogo } from './icons';

const ICON_SIZE = 26;

interface LogoItem {
  key: string;
  label: string;
  node: ReactNode;
}

/** CLI coding agents that Relay drives over a PTY. */
const CLI_LOGOS: readonly LogoItem[] = [
  { key: 'claude-code', label: 'Claude Code', node: <ClaudeCode.Color size={ICON_SIZE} /> },
  { key: 'codex', label: 'Codex', node: <Codex.Color size={ICON_SIZE} /> },
  { key: 'opencode', label: 'OpenCode', node: <OpenCode size={ICON_SIZE} /> },
  { key: 'cursor', label: 'Cursor', node: <Cursor size={ICON_SIZE} /> },
];

/** Custom agents you build against the SDK and language bindings. */
const CUSTOM_LOGOS: readonly LogoItem[] = [
  { key: 'hermes', label: 'Hermes', node: <HermesAgent size={ICON_SIZE} /> },
  { key: 'openclaw', label: 'OpenClaw', node: <OpenClaw.Color size={ICON_SIZE} /> },
  { key: 'typescript', label: 'TypeScript', node: <TypeScriptLogo className={s.howLogoSvg} /> },
  { key: 'python', label: 'Python', node: <PythonLogo className={s.howLogoSvg} /> },
  { key: 'github', label: 'GitHub', node: <Github size={ICON_SIZE} /> },
];

const RELAY_CAPABILITIES: readonly string[] = [
  'DMs, channels & @mentions',
  'Durable messaging, retries',
  'Message receipts',
  'Search, history, webhooks',
];

function SourceNode({
  label,
  logos,
  caption,
}: {
  label: string;
  logos: readonly LogoItem[];
  caption: string;
}) {
  return (
    <div className={s.howNode}>
      <span className={s.howNodeLabel}>{label}</span>
      <div className={s.howLogoRow}>
        {logos.map((logo) => (
          <span key={logo.key} className={s.howLogo} aria-label={logo.label} title={logo.label}>
            {logo.node}
          </span>
        ))}
      </div>
      <p className={s.howNodeCaption}>{caption}</p>
    </div>
  );
}

/** A pair of curved arrows linking a source group to the relay card. */
function ExchangeArrows() {
  return (
    <svg className={s.howExchange} viewBox="0 0 56 44" fill="none" aria-hidden="true">
      <path
        className={s.howExchangePath}
        d="M8 15 C24 4 38 4 49 13"
        markerEnd="url(#howArrowHead)"
      />
      <path
        className={s.howExchangePath}
        d="M48 29 C37 38 23 38 7 30"
        markerEnd="url(#howArrowHead)"
      />
    </svg>
  );
}

export function HowItWorks() {
  return (
    <section className={s.howItWorks} aria-labelledby="how-it-works-title">
      {/* Shared arrowhead marker for every ExchangeArrows instance. */}
      <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
        <defs>
          <marker id="howArrowHead" markerWidth="7" markerHeight="7" refX="4" refY="3" orient="auto">
            <path d="M0 0 L6 3 L0 6 Z" fill="currentColor" />
          </marker>
        </defs>
      </svg>

      <FadeIn direction="up" className={s.howHeader}>
        <h2 id="how-it-works-title" className={s.howTitle}>
          How it works
        </h2>
        <p className={s.howSubtitle}>
          Connect CLI agents and your own custom agents to a single communication rail. Agent Relay handles
          delivery, history, and coordination between them.
        </p>
      </FadeIn>

      <div className={s.howDiagram}>
        <FadeIn direction="right" className={s.howSources}>
          <SourceNode
            label="CLI agents"
            logos={CLI_LOGOS}
            caption="PTY driven, real-time message injection"
          />
          <SourceNode
            label="Your custom agents"
            logos={CUSTOM_LOGOS}
            caption="Drop-in SDK + bindings"
          />
        </FadeIn>

        <div className={s.howFlow} aria-hidden="true">
          <ExchangeArrows />
          <ExchangeArrows />
        </div>

        <FadeIn direction="left" delay={160} className={s.howRelay}>
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
          <ul className={s.howCapabilities}>
            {RELAY_CAPABILITIES.map((cap) => (
              <li key={cap} className={s.howCapability}>
                <span className={s.howCapabilityDot} aria-hidden="true" />
                {cap}
              </li>
            ))}
          </ul>
        </FadeIn>
      </div>
    </section>
  );
}
