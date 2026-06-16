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
 * Orthogonal pipe network: each agent group connects to a side bus, and each
 * bus feeds the Agent Relay hub at the centre. Coordinates are percentages of
 * the stage; axis-aligned segments stay square under the stretched viewBox.
 * Three message dots ({@link MESSAGE_CLASSES}) travel these pipes with
 * right-angle turns — source agent → relay → destination — so each route is
 * easy to follow (CLI → custom, custom → CLI, CLI → CLI).
 */
const WIRES: readonly string[] = [
  '31,38 35,38 35,62 31,62', // left stubs + bus
  '35,50 50,50', // left feed into the relay box (runs under it)
  '69,38 65,38 65,62 69,62', // right stubs + bus
  '65,50 50,50', // right feed into the relay box (runs under it)
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
          Our PTY based driver can power any CLI agent or you can drop in our SDK for your custom
          orchestrator.
        </p>
      </FadeIn>

      <div className={s.howStage}>
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
