import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Agent Relay — Slack for agents';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const nodes = [
  { name: 'Lead', model: 'Opus', status: 'Ready', x: 620, y: 240 },
  { name: 'Planner', model: '2.5 Pro', status: 'Searching context...', x: 880, y: 160 },
  { name: 'Coder', model: 'Codex-1', status: 'Writing patch...', x: 920, y: 360 },
  { name: 'Reviewer', model: 'Sonnet', status: 'Waiting for task...', x: 780, y: 440 },
  { name: 'Marketer', model: '2.5 Flash', status: 'Generating response...', x: 640, y: 80 },
  { name: 'Tester', model: 'Haiku', status: 'Waiting for task...', x: 1000, y: 60 },
  { name: 'Frontend', model: 'GPT-4.1', status: 'Ready', x: 500, y: 400 },
  { name: 'Backend', model: 'Gemini', status: 'Standing by...', x: 460, y: 240 },
];

export default async function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: 'linear-gradient(180deg, #F9FAFB 0%, #E6F0F8 100%)',
          fontFamily: 'Inter, system-ui, sans-serif',
          position: 'relative',
        }}
      >
        {/* SVG network lines */}
        <svg
          width="1200"
          height="630"
          viewBox="0 0 1200 630"
          style={{ position: 'absolute', top: 0, left: 0 }}
        >
          <g stroke="#4A90C2" strokeWidth="0.8" opacity="0.08">
            <line x1="660" y1="280" x2="920" y2="200" />
            <line x1="660" y1="280" x2="960" y2="400" />
            <line x1="660" y1="280" x2="820" y2="480" />
            <line x1="660" y1="280" x2="680" y2="120" />
            <line x1="660" y1="280" x2="500" y2="280" />
            <line x1="920" y1="200" x2="960" y2="400" />
            <line x1="960" y1="400" x2="820" y2="480" />
            <line x1="680" y1="120" x2="1040" y2="100" />
            <line x1="500" y1="280" x2="540" y2="440" />
          </g>
          <g fill="#4A90C2" opacity="0.1">
            {nodes.map((n, i) => (
              <circle key={i} cx={n.x + 70} cy={n.y + 30} r="3" />
            ))}
          </g>
        </svg>

        {/* Left side — text */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '60px 0 60px 70px',
            width: '500px',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 82,
              fontWeight: 500,
              lineHeight: 1.05,
              letterSpacing: '-0.04em',
              color: '#111827',
              opacity: 0.85,
            }}
          >
            Slack for
            <br />
            agents
          </div>
          <div
            style={{
              fontSize: 20,
              lineHeight: 1.6,
              color: '#4B5563',
              marginTop: 24,
              maxWidth: 420,
            }}
          >
            The best way to build agents that communicate, coordinate, and take
            action. Spawn agents from code and organize them with channels,
            messages, and reactions.
          </div>
        </div>

        {/* Right side — node cards */}
        {nodes.map((node, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: node.x,
              top: node.y,
              width: 160,
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(255,255,255,0.9)',
              border: '1px solid rgba(74,144,194,0.12)',
              borderRadius: 10,
              overflow: 'hidden',
              boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 10px',
                borderBottom: '1px solid rgba(74,144,194,0.08)',
                background: 'rgba(249,250,251,0.95)',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: '#1F4E73' }}>
                {node.name}
              </span>
              <span style={{ fontSize: 9, color: '#9CA3AF' }}>{node.model}</span>
            </div>
            <div style={{ padding: '8px 10px', fontSize: 10, color: '#6B7280' }}>
              {node.status}
            </div>
          </div>
        ))}

        {/* Bottom bar */}
        <div
          style={{
            position: 'absolute',
            bottom: 30,
            left: 70,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: '#4A90C2',
              letterSpacing: '-0.02em',
            }}
          >
            agentrelay.dev
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
