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

/**
 * Spoke wires from each agent port to the Agent Relay hub (centre). Ports are
 * percentages of the stage; the six animated message dots ({@link MESSAGES})
 * travel along these spokes — source agent → relay → destination agent. Each
 * message has its own colour + keyframes in landing.module.css so distinct
 * messages flow between different agents (CLI↔CLI, CLI↔custom, custom↔custom).
 */
type Port = readonly [number, number];

const PORTS: readonly Port[] = [
  [31, 30],
  [31, 50],
  [31, 70], // CLI agents (left edge)
  [69, 30],
  [69, 50],
  [69, 70], // custom agents (right edge)
];

const MESSAGE_CLASSES = [s.howMsg1, s.howMsg2, s.howMsg3, s.howMsg4, s.howMsg5, s.howMsg6] as const;

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
          Add Slack-style communication to any agent. Our PTY based driver can power any CLI agent or you can
          drop in our SDK for your custom orchestrator.
        </p>
      </FadeIn>

      <div className={s.howStage}>
        <svg className={s.howWires} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {PORTS.map((p, i) => (
            <line key={i} x1={p[0]} y1={p[1]} x2={50} y2={50} className={s.howWire} />
          ))}
        </svg>

        <div className={s.howMsgs} aria-hidden="true">
          {MESSAGE_CLASSES.map((cls, i) => (
            <span key={i} className={`${s.howMsg} ${cls}`} />
          ))}
        </div>

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
            <AgentGroup label="Your custom agents" logos={CUSTOM_LOGOS} caption="Drop-in SDK + bindings" />
          </FadeIn>
        </div>
      </div>
    </section>
  );
}
