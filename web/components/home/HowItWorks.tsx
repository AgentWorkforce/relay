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
 * Pyramid layout: the Agent Relay hub sits at the top; the two agent groups
 * sit below it. A fixed-height connector zone between them carries the
 * orthogonal pipes (relay → bus → each group) and the animated messages.
 * Coordinates are percentages of that connector zone, so the pipes and dots
 * line up at every width. Three message dots ({@link MESSAGE_CLASSES}) travel
 * the pipes up to the relay and back down to another agent (CLI → custom,
 * custom → CLI, CLI → CLI).
 */
// Apex coords (% of the relay+connector zone): relay bottom 50%, bus 75%,
// card tops 100%. The pipes connect the relay box down to each agent group.
const WIRES: readonly string[] = [
  '50,50 50,75', // relay down to the bus
  '25,75 75,75', // bus across
  '25,75 25,100', // bus down to CLI agents
  '75,75 75,100', // bus down to custom agents
];

const MESSAGE_CLASSES = [s.howMsg1, s.howMsg2, s.howMsg3] as const;

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
          Works with Every Agent
        </h2>
        <p className={s.howSubtitle}>
          It's not a harness, and it's not a framework. Our PTY based driver can power any CLI agent
          or you can drop in our SDK for your custom orchestrator.
        </p>
      </FadeIn>

      <div className={s.howStage}>
        {/* Apex zone = relay box (top) + connector (below). Wires and message
            dots span the whole zone so a dot can travel up behind the relay
            box and pop back out. */}
        <div className={s.howApex}>
          <svg className={s.howWires} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {WIRES.map((points, i) => (
              <polyline key={i} points={points} className={s.howWire} />
            ))}
          </svg>
          <div className={s.howMsgs} aria-hidden="true">
            {MESSAGE_CLASSES.map((cls, i) => (
              <span key={i} className={`${s.howMsg} ${cls}`} />
            ))}
          </div>

          <div className={s.howCore}>
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
          </div>

          <div className={s.howLink} aria-hidden="true" />
        </div>

        <div className={s.howRow}>
          <FadeIn direction="right" className={s.howCol}>
            <AgentGroup label="CLI agents" logos={CLI_LOGOS} caption="PTY driven, real-time injection" />
          </FadeIn>
          <FadeIn direction="left" delay={80} className={s.howCol}>
            <AgentGroup label="Your custom agents" logos={CUSTOM_LOGOS} caption="Drop-in SDK + bindings" />
          </FadeIn>
        </div>
      </div>
    </section>
  );
}
