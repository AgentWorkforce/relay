import type { CSSProperties } from 'react';

import { agentAsset, type Agent } from '../../lib/agents';

type Variant = 'card' | 'card-sm' | 'banner' | 'avatar';

const ASSET_FOR: Record<Variant, 'card' | 'card-sm' | 'banner' | 'avatar'> = {
  card: 'card',
  'card-sm': 'card-sm',
  banner: 'banner',
  avatar: 'avatar',
};

const FALLBACK_FONT_SIZE: Record<Variant, string> = {
  banner: 'clamp(3rem, 9vw, 6rem)',
  card: 'clamp(2.4rem, 12vw, 4rem)',
  'card-sm': 'clamp(2.4rem, 12vw, 4rem)',
  avatar: '1.8rem',
};

function monogram(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Renders an agent's committed artwork as a plain <img> (next/image is avoided
 * because the SST/OpenNext optimizer 500s without sharp). Agents without
 * committed PNGs get a deterministic brand-gradient + monogram so static
 * renders, OG, and the sitemap stay stable.
 */
export function AgentArt({
  agent,
  variant,
  alt,
  loading = 'lazy',
}: {
  agent: Agent;
  variant: Variant;
  alt?: string;
  /** Use 'eager' for above-the-fold art (e.g. the detail hero banner). */
  loading?: 'lazy' | 'eager';
}) {
  if (agent.hasCustomArt) {
    return (
      <img
        src={agentAsset(agent.slug, ASSET_FOR[variant])}
        alt={alt ?? `${agent.name} artwork`}
        loading={loading}
      />
    );
  }

  const style: CSSProperties = {
    position: 'absolute',
    inset: 0,
    background: `linear-gradient(135deg, ${agent.accent}, color-mix(in srgb, ${agent.accent} 50%, #0b0e14))`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-heading), sans-serif',
    fontWeight: 700,
    letterSpacing: '-0.04em',
    fontSize: FALLBACK_FONT_SIZE[variant],
    color: 'rgba(255,255,255,0.96)',
    textShadow: '0 2px 16px rgba(0,0,0,0.28)',
  };

  return (
    <div style={style} role="img" aria-label={alt ?? `${agent.name} artwork`}>
      {monogram(agent.name)}
    </div>
  );
}
