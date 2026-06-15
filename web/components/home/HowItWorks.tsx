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

interface Capability {
  icon: ReactNode;
  title: string;
  detail: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    icon: <MessagesSquare size={18} strokeWidth={1.8} aria-hidden="true" />,
    title: 'DMs, channels & @mentions',
    detail: 'Slack-style routing between agents',
  },
  {
    icon: <RefreshCw size={18} strokeWidth={1.8} aria-hidden="true" />,
    title: 'Durable messaging & retries',
    detail: 'Survives restarts and offline gaps',
  },
  {
    icon: <CheckCheck size={18} strokeWidth={1.8} aria-hidden="true" />,
    title: 'Message receipts',
    detail: 'Know when a handoff was acknowledged',
  },
  {
    icon: <Search size={18} strokeWidth={1.8} aria-hidden="true" />,
    title: 'Search, history & webhooks',
    detail: 'Recover context, bridge any service',
  },
];

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

/** Converging wires from the two agent groups into the hub. */
function WiresIn() {
  return (
    <svg
      className={s.howWires}
      viewBox="0 0 100 100"
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className={s.howWire} d="M0 27 C55 27 45 50 100 50" />
      <path className={s.howWire} d="M0 73 C55 73 45 50 100 50" />
    </svg>
  );
}

/** Diverging wires from the hub out to the four capabilities. */
function WiresOut() {
  return (
    <svg
      className={s.howWires}
      viewBox="0 0 100 100"
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className={s.howWire} d="M0 50 C50 50 45 13 100 13" />
      <path className={s.howWire} d="M0 50 C50 50 48 38 100 38" />
      <path className={s.howWire} d="M0 50 C50 50 48 62 100 62" />
      <path className={s.howWire} d="M0 50 C50 50 45 87 100 87" />
    </svg>
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
          Your agents plug into Agent Relay, the rail that handles messaging, delivery, and history so they
          can coordinate without any glue code.
        </p>
      </FadeIn>

      <div className={s.howHub}>
        <FadeIn direction="right" className={s.howColAgents}>
          <AgentGroup label="CLI agents" logos={CLI_LOGOS} caption="PTY driven, real-time injection" />
          <AgentGroup label="Your custom agents" logos={CUSTOM_LOGOS} caption="Drop-in SDK + bindings" />
        </FadeIn>

        <WiresIn />

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

        <WiresOut />

        <FadeIn direction="left" delay={200} className={s.howColCaps}>
          {CAPABILITIES.map((cap) => (
            <div key={cap.title} className={s.howCap}>
              <span className={s.howCapIcon} aria-hidden="true">
                {cap.icon}
              </span>
              <span className={s.howCapText}>
                <strong>{cap.title}</strong>
                <span className={s.howCapDetail}>{cap.detail}</span>
              </span>
            </div>
          ))}
        </FadeIn>
      </div>
    </section>
  );
}
