import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Agent Relay',
  description: 'Spawn, coordinate, and connect AI agents from TypeScript or Python.',
  alternates: {
    canonical: 'https://agentrelay.dev',
  },
};

export default function HomePage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <h1
        style={{
          fontSize: 'clamp(2rem, 5vw, 3.5rem)',
          letterSpacing: '-0.04em',
          fontWeight: 700,
        }}
      >
        Hello World
      </h1>
    </div>
  );
}
