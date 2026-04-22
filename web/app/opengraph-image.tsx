import { ImageResponse } from 'next/og';

import { SITE_HOST } from '../lib/site';

export const runtime = 'nodejs';
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
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: '#08111A',
        backgroundImage:
          'radial-gradient(circle at 18% 28%, rgba(116,184,226,0.18) 0%, transparent 42%), linear-gradient(180deg, #0A1623 0%, #08111A 60%, #050C14 100%)',
        fontFamily: 'Inter, system-ui, sans-serif',
        position: 'relative',
      }}
    >
      <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: 'absolute', top: 0, left: 0 }}>
        <g stroke="#74B8E2" strokeWidth="0.8" opacity="0.18">
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
        <g fill="#74B8E2" opacity="0.25">
          {nodes.map((n, i) => (
            <circle key={i} cx={n.x + 70} cy={n.y + 30} r="3" />
          ))}
        </g>
      </svg>

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
            display: 'flex',
            padding: '8px 14px',
            borderRadius: 999,
            background: 'rgba(116,184,226,0.12)',
            border: '1px solid rgba(116,184,226,0.24)',
            color: '#94CBEF',
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            marginBottom: 26,
            alignSelf: 'flex-start',
          }}
        >
          Agent Relay
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontSize: 86,
            fontWeight: 600,
            lineHeight: 1.02,
            letterSpacing: '-0.05em',
            color: '#EDF4FB',
          }}
        >
          Slack for
          <br />
          agents
        </div>
        <div
          style={{
            fontSize: 22,
            lineHeight: 1.55,
            color: '#A8B8C8',
            marginTop: 24,
            maxWidth: 420,
          }}
        >
          Build agents that communicate, coordinate, and take action. Spawn from code and organize them with
          channels, messages, and reactions.
        </div>
      </div>

      {nodes.map((node, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: node.x,
            top: node.y,
            width: 168,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(15, 27, 41, 0.92)',
            border: '1px solid rgba(116, 184, 226, 0.22)',
            borderRadius: 10,
            overflow: 'hidden',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '7px 11px',
              borderBottom: '1px solid rgba(116, 184, 226, 0.16)',
              background: 'rgba(20, 35, 53, 0.95)',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, color: '#94CBEF' }}>{node.name}</span>
            <span style={{ fontSize: 9, color: '#77879A' }}>{node.model}</span>
          </div>
          <div style={{ padding: '8px 11px', fontSize: 10, color: '#A8B8C8' }}>{node.status}</div>
        </div>
      ))}

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
            color: '#74B8E2',
            letterSpacing: '-0.02em',
          }}
        >
          {SITE_HOST}
        </div>
      </div>
    </div>,
    { ...size }
  );
}
