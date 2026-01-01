/**
 * Logo Component - Monogram AR
 *
 * The Agent Relay logo featuring interwoven A and R letters.
 * Uses the signature cyan (#00d9ff) and teal (#00ffc8) colors
 * to symbolize structure and flow.
 */

import React from 'react';

export interface LogoProps {
  /** Size of the logo in pixels (width and height) */
  size?: number;
  /** Whether to include the wordmark alongside the icon */
  showWordmark?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Whether to apply a glow effect */
  withGlow?: boolean;
  /** Whether to animate on hover */
  animated?: boolean;
}

/**
 * Agent Relay Monogram Logo
 *
 * An SVG logo with interwoven A and R letters representing
 * the connection between agents in the relay system.
 */
export function Logo({
  size = 40,
  showWordmark = false,
  className = '',
  withGlow = true,
  animated = true,
}: LogoProps) {
  return (
    <div
      className={`
        inline-flex items-center gap-3
        ${animated ? 'group' : ''}
        ${className}
      `}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`
          transition-all duration-300
          ${withGlow ? 'drop-shadow-[0_0_8px_rgba(0,217,255,0.3)]' : ''}
          ${animated ? 'group-hover:drop-shadow-[0_0_16px_rgba(0,217,255,0.5)] group-hover:scale-105' : ''}
        `}
        aria-label="Agent Relay Logo"
        role="img"
      >
        {/* A shape - Primary structure */}
        <path
          d="M30 80 L 50 20 L 70 80"
          stroke="#00d9ff"
          strokeWidth="4"
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
          className={`
            ${animated ? 'transition-all duration-300 group-hover:[stroke-width:5]' : ''}
          `}
        />
        {/* A crossbar */}
        <line
          x1="40"
          y1="50"
          x2="60"
          y2="50"
          stroke="#00d9ff"
          strokeWidth="4"
          strokeLinecap="round"
          className={`
            ${animated ? 'transition-all duration-300 group-hover:[stroke-width:5]' : ''}
          `}
        />

        {/* R overlay - Representing flow/relay */}
        <path
          d="M50 20 L 50 80"
          stroke="#00ffc8"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.7"
          className={`
            ${animated ? 'transition-opacity duration-300 group-hover:opacity-100' : ''}
          `}
        />
        <path
          d="M50 20 C 80 20 80 50 50 50 L 80 80"
          stroke="#00ffc8"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0.7"
          className={`
            ${animated ? 'transition-opacity duration-300 group-hover:opacity-100' : ''}
          `}
        />
      </svg>

      {showWordmark && (
        <span
          className={`
            font-display font-semibold text-text-primary tracking-tight
            transition-all duration-300
            ${animated ? 'group-hover:text-accent-cyan' : ''}
          `}
          style={{ fontSize: size * 0.45 }}
        >
          Agent Relay
        </span>
      )}
    </div>
  );
}

/**
 * Compact logo icon for tight spaces like headers
 */
export function LogoIcon({
  size = 24,
  className = '',
  withGlow = false,
}: Pick<LogoProps, 'size' | 'className' | 'withGlow'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`
        transition-all duration-300
        ${withGlow ? 'drop-shadow-[0_0_8px_rgba(0,217,255,0.3)]' : ''}
        ${className}
      `}
      aria-label="Agent Relay Logo"
      role="img"
    >
      {/* A shape */}
      <path
        d="M30 80 L 50 20 L 70 80"
        stroke="#00d9ff"
        strokeWidth="5"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      <line
        x1="40"
        y1="50"
        x2="60"
        y2="50"
        stroke="#00d9ff"
        strokeWidth="5"
        strokeLinecap="round"
      />

      {/* R overlay */}
      <path
        d="M50 20 L 50 80"
        stroke="#00ffc8"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M50 20 C 80 20 80 50 50 50 L 80 80"
        stroke="#00ffc8"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity="0.7"
      />
    </svg>
  );
}

/**
 * Large animated logo for landing pages and hero sections
 */
export function LogoHero({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div className={`relative inline-block ${className}`}>
      {/* Outer glow ring animation */}
      <div
        className="
          absolute inset-[-20%]
          rounded-full
          bg-accent-cyan/10
          animate-pulse
          blur-2xl
        "
        aria-hidden="true"
      />

      <svg
        width={120}
        height={120}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="
          relative z-10
          drop-shadow-[0_0_20px_rgba(0,217,255,0.4)]
          animate-[float_6s_ease-in-out_infinite]
        "
        aria-label="Agent Relay Logo"
        role="img"
      >
        <defs>
          <linearGradient id="logoGradientA" x1="30" y1="80" x2="70" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#00d9ff" />
            <stop offset="100%" stopColor="#00b8d9" />
          </linearGradient>
          <linearGradient id="logoGradientR" x1="50" y1="20" x2="80" y2="80" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#00ffc8" />
            <stop offset="100%" stopColor="#00d9b8" />
          </linearGradient>
        </defs>

        {/* A shape with gradient */}
        <path
          d="M30 80 L 50 20 L 70 80"
          stroke="url(#logoGradientA)"
          strokeWidth="5"
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
        <line
          x1="40"
          y1="50"
          x2="60"
          y2="50"
          stroke="url(#logoGradientA)"
          strokeWidth="5"
          strokeLinecap="round"
        />

        {/* R overlay with gradient */}
        <path
          d="M50 20 L 50 80"
          stroke="url(#logoGradientR)"
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.8"
        />
        <path
          d="M50 20 C 80 20 80 50 50 50 L 80 80"
          stroke="url(#logoGradientR)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0.8"
        />
      </svg>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-8px); }
        }
      `}</style>
    </div>
  );
}

export default Logo;
