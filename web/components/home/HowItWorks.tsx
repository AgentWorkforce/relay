import type { ReactNode } from 'react';

import { CheckCheck, MessagesSquare, RefreshCw, Search } from 'lucide-react';

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

const ICON_SIZE = 24;

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
  { key: 'typescript', label: 'TypeScript', node: <TypeScriptLogo className={s.howChipSvg} /> },
  { key: 'python', label: 'Python', node: <PythonLogo className={s.howChipSvg} /> },
  { key: 'github', label: 'GitHub', node: <Github size={ICON_SIZE} /> },
];

interface Feature {
  icon: ReactNode;
  label: string;
}

const FEATURES: readonly Feature[] = [
  { icon: <MessagesSquare size={17} strokeWidth={1.8} aria-hidden="true" />, label: 'DMs, channels & @mentions' },
  { icon: <RefreshCw size={17} strokeWidth={1.8} aria-hidden="true" />, label: 'Durable delivery & retries' },
  { icon: <CheckCheck size={17} strokeWidth={1.8} aria-hidden="true" />, label: 'Message receipts' },
  { icon: <Search size={17} strokeWidth={1.8} aria-hidden="true" />, label: 'Search, history & webhooks' },
];

/**
 * Animated message lanes behind the row. Each lane is a faint wire carrying
 * dots that travel the full width and pass *behind* the centered relay node —
 * so messages appear to flow from one set of agents, through Agent Relay, to
 * the other. Directions alternate to read as two-way communication.
 */
interface Lane {
  top: string;
  dir: 'right' | 'left';
  dur: number;
  delays: readonly number[];
}

const LANES: readonly Lane[] = [
  { top: '30%', dir: 'right', dur: 4.4, delays: [0, 1.1, 2.2, 3.3] },
  { top: '50%', dir: 'left', dur: 5.0, delays: [0.6, 1.85, 3.1, 4.35] },
  { top: '70%', dir: 'right', dur: 4.7, delays: [0.35, 1.5, 2.65, 3.8] },
];

function MessageLanes() {
  return (
    <div className={s.howLanes} aria-hidden="true">
      {LANES.map((lane, i) => (
        <div key={i} className={s.howLane} style={{ top: lane.top }}>
          {lane.delays.map((delay, j) => (
            <span
              key={j}
              className={lane.dir === 'left' ? `${s.howDot} ${s.howDotLeft}` : s.howDot}
              style={{ animationDelay: `${delay}s`, animationDuration: `${lane.dur}s` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AgentGroup({
  label,
  logos,
  caption,
}: {
  label: string;
  logos: readonly LogoItem[];
  caption: string;
}) {
  return (
    <div className={s.howGroup}>
      <span className={s.howGroupLabel}>{label}</span>
      <div className={s.howGroupLogos}>
        {logos.map((logo) => (
          <span key={logo.key} className={s.howChip} aria-label={logo.label} title={logo.label}>
            {logo.node}
          </span>
        ))}
      </div>
      <p className={s.howGroupCaption}>{caption}</p>
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
          Bring any agent — CLI tools or your own custom builds — onto one rail. They talk to each
          other through Agent Relay, so a message from one agent reaches any other.
        </p>
      </FadeIn>

      <div className={s.howStage}>
        <MessageLanes />
        <div className={s.howRow}>
          <FadeIn direction="right" className={s.howCol}>
            <AgentGroup label="CLI agents" logos={CLI_LOGOS} caption="PTY driven, real-time injection" />
          </FadeIn>

          <FadeIn direction="up" delay={120} className={s.howCore}>
            <div className={s.howCoreNode}>
              <img
                src="/brand-kit/agent-relay-mark.svg"
                alt=""
                width={46}
                height={38}
                className={s.howCoreMark}
              />
              <img
                src="/brand-kit/agent-relay-wordmark.svg"
                alt="Agent Relay"
                width={150}
                height={30}
                className={s.howCoreWordmark}
              />
            </div>
          </FadeIn>

          <FadeIn direction="left" delay={120} className={s.howCol}>
            <AgentGroup
              label="Your custom agents"
              logos={CUSTOM_LOGOS}
              caption="Drop-in SDK + bindings"
            />
          </FadeIn>
        </div>
      </div>

      <FadeIn direction="up" delay={160} className={s.howFeatures}>
        {FEATURES.map((feature) => (
          <span key={feature.label} className={s.howFeature}>
            <span className={s.howFeatureIcon}>{feature.icon}</span>
            {feature.label}
          </span>
        ))}
      </FadeIn>

      <p className={s.howFootnote}>
        Plug in any other agent over the SDK, MCP, or A2A — every one lands on the same rail.
      </p>
    </section>
  );
}
