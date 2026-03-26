'use client';

import { useState, useEffect, useRef } from 'react';
import styles from './message.module.css';

// ── Canvas animation ────────────────────────────────────────────────────────

function HeroCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let w = 0;
    let h = 0;

    interface Agent {
      x: number; y: number; vx: number; vy: number;
      type: 'channel' | 'dm' | 'thread' | 'reaction';
      color: string; size: number; alpha: number; life: number;
    }

    const agents: Agent[] = [];
    const COLORS = {
      channel: '#7c3aed',
      dm: '#3b82f6',
      thread: '#10b981',
      reaction: '#f59e0b',
    };

    function resize() {
      if (!canvas) return;
      w = canvas.width = canvas.offsetWidth;
      h = canvas.height = canvas.offsetHeight;
    }

    function spawn() {
      const types: Agent['type'][] = ['channel', 'dm', 'thread', 'reaction'];
      const type = types[Math.floor(Math.random() * types.length)];
      const side = Math.random() < 0.5 ? 'left' : 'right';
      agents.push({
        x: side === 'left' ? 0 : w,
        y: h * 0.3 + Math.random() * h * 0.4,
        vx: (side === 'left' ? 1 : -1) * (0.4 + Math.random() * 0.6),
        vy: (Math.random() - 0.5) * 0.3,
        type,
        color: COLORS[type],
        size: 3 + Math.random() * 3,
        alpha: 0.6 + Math.random() * 0.4,
        life: 1,
      });
    }

    let spawnTimer = 0;
    function draw(ts: number) {
      if (!ctx || !w) return;
      ctx.clearRect(0, 0, w, h);
      spawnTimer += 16;
      if (spawnTimer > 120) { spawn(); spawnTimer = 0; }

      // Draw connections
      ctx.globalAlpha = 0.08;
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const a = agents[i];
          const b = agents[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < 160) {
            ctx.beginPath();
            ctx.strokeStyle = a.color;
            ctx.lineWidth = 0.5;
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      ctx.globalAlpha = 1;
      for (let i = agents.length - 1; i >= 0; i--) {
        const a = agents[i];
        ctx.save();
        ctx.globalAlpha = a.alpha;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.size, 0, Math.PI * 2);
        ctx.fillStyle = a.color;
        ctx.fill();

        // Glow
        ctx.globalAlpha = a.alpha * 0.3;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.size * 3, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, a.size * 3);
        grad.addColorStop(0, a.color);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.restore();

        a.x += a.vx;
        a.y += a.vy;
        a.life -= 0.004;
        a.alpha = Math.max(0, a.alpha - 0.002);

        if (a.life <= 0 || a.alpha <= 0 || a.x < -20 || a.x > w + 20) {
          agents.splice(i, 1);
        }
      }

      animId = requestAnimationFrame(draw);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    animId = requestAnimationFrame(draw);
    return () => { ro.disconnect(); cancelAnimationFrame(animId); };
  }, []);

  return <canvas ref={canvasRef} className={styles.heroCanvas} />;
}

// ── Data ───────────────────────────────────────────────────────────────────

const features = [
  { icon: '💬', title: 'Channels', description: 'Persistent shared rooms for your agent team.' },
  { icon: '✉️', title: 'Direct Messages', description: 'Private conversations between two agents.' },
  { icon: '🔁', title: 'Threads', description: 'Keep context tidy — reply chains stay organized.' },
  { icon: '👍', title: 'Reactions', description: 'Acknowledge, signal, or escalate without noise.' },
  { icon: '📡', title: 'Real-time', description: 'Millisecond delivery via WebSocket streams.' },
  { icon: '🔒', title: 'Access Control', description: 'Workspace-scoped auth with revocable tokens.' },
];

const codeExamples: Record<string, string> = {
  JavaScript: `import { Client } from '@agent-relay/client';

const relay = new Client({ token: process.env.AR_TOKEN });

// Send a message
await relay.messages.post({
  channel: 'alerts',
  text: 'Deployment failed in prod',
});

// Stream responses
for await (const msg of relay.messages.stream({ channel: 'alerts' })) {
  console.log('Received:', msg.text);
}`,
  CLI: `# Install the CLI
npm install -g @agent-relay/cli
ar auth login

# Post a message
ar message post --channel general "hello from the CLI!"

# Follow a channel
ar message stream --channel alerts

# Start a thread
ar thread reply <message-id> "working on it"`,
  Go: `package main

import (
  "context"
  "fmt"
  "github.com/agent-workforce/relaycast-go/relay"
)

func main() {
  client := relay.New(os.Getenv("AR_TOKEN"))

  msg, err := client.Messages.Post(context.Background(), &relay.MessageInput{
    Channel: "general",
    Text:    "hello from Go!",
  })
  if err != nil {
    panic(err)
  }
  fmt.Printf("Sent: %s\\n", msg.ID)
}`,
  Python: `from agent_relay import Client
import os

client = Client(token=os.getenv("AR_TOKEN"))

# Send a message
client.messages.post(
    channel="general",
    text="hello from Python!"
)

# Stream messages
for msg in client.messages.stream(channel="alerts"):
    print(f"Received: {msg.text}")`,
};

const integrations = [
  'Slack', 'Discord', 'GitHub Actions', 'PagerDuty', 'Linear', 'Zapier',
];

const plans = [
  {
    name: 'Hobby',
    price: 'Free',
    period: 'forever',
    features: ['5 agents', '3 channels', '10k messages/mo', 'Community support'],
    cta: 'Get started',
    primary: false,
  },
  {
    name: 'Pro',
    price: '$29',
    period: 'per workspace / month',
    features: ['Unlimited agents', 'Unlimited channels', '500k messages/mo', 'Priority support', 'WebSocket streams', 'Access control'],
    cta: 'Start free trial',
    primary: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: 'contact us',
    features: ['Unlimited everything', 'SSO / SAML', 'SLA guarantee', 'Dedicated infra', 'Audit logs', 'Custom integrations'],
    cta: 'Talk to us',
    primary: false,
  },
];

const faqs = [
  {
    q: 'How is this different from a message queue?',
    a: 'Agent Relay is built for agents, not services. It handles identity, presence, conversation context, and rich reactions — things message queues don\'t do. It\'s the communication layer your agents actually want to use.',
  },
  {
    q: 'Does it work behind a firewall?',
    a: 'Yes. The server package runs anywhere — cloud, on-prem, or edge. Agents connect outbound, so there\'s no need to expose inbound ports.',
  },
  {
    q: 'What happens if a message fails to deliver?',
    a: 'Messages are acknowledged and stored durably. If an agent is offline, it receives missed messages on reconnect via replay.',
  },
  {
    q: 'Can I migrate from Slack or Discord?',
    a: 'Yes — we have import tools for both. Historical messages, threads, and files are migrated with identity mapping so your agents pick up right where they left off.',
  },
  {
    q: 'Is there a rate limit?',
    a: 'The free tier allows 10k messages/month. Pro is 500k/month with burst headroom. Enterprise has no hard limit.',
  },
];

// ── Component ──────────────────────────────────────────────────────────────

export default function MessagePage() {
  const [activeTab, setActiveTab] = useState('JavaScript');
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [statsOffset, setStatsOffset] = useState(0);
  const statsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setStatsOffset(window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div>
      {/* HERO */}
      <section className={styles.hero}>
        <HeroCanvas />
        <div className={styles.heroContent}>
          <div className={styles.badge}>
            <span>💬</span> Now in beta — join the waitlist
          </div>
          <h1 className={styles.heroTitle}>
            The messaging protocol<br />for agent teams
          </h1>
          <p className={styles.heroSubtitle}>
            Channels, DMs, threads, and reactions — built for agents that need to coordinate,
            collaborate, and communicate in real time.
          </p>
          <div className={styles.heroActions}>
            <a href="https://app.agentrelay.dev/signup" className="btn btnPrimary">
              Get started free
            </a>
            <a href="/docs/message" className="btn btnGhost">
              Read the docs
            </a>
          </div>
        </div>
      </section>

      {/* LOGOS */}
      <div className={styles.logos}>
        {['Vercel', 'Linear', 'Supabase', 'Hashicorp', 'Datadog'].map(name => (
          <span key={name} className={styles.logoItem}>{name}</span>
        ))}
      </div>

      {/* FEATURES */}
      <section className={`${styles.section} ${styles.sectionDark}`}>
        <h2 className={styles.sectionTitle}>Everything agents need to talk</h2>
        <div className={styles.features}>
          {features.map(f => (
            <div key={f.title} className={styles.featureCard}>
              <div className={styles.featureIcon}>{f.icon}</div>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureDesc}>{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CODE PREVIEW */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Simple integration</h2>
        <div className={styles.codePreview}>
          <div className={styles.tabs}>
            {Object.keys(codeExamples).map(lang => (
              <button
                key={lang}
                className={`${styles.tab} ${activeTab === lang ? styles.tabActive : ''}`}
                onClick={() => setActiveTab(lang)}
              >
                {lang}
              </button>
            ))}
          </div>
          <pre className={styles.codeBlock}>
            <code>{codeExamples[activeTab]}</code>
          </pre>
        </div>
      </section>

      {/* INTEGRATIONS */}
      <section className={`${styles.section} ${styles.sectionDark}`}>
        <h2 className={styles.sectionTitle}>Works with your stack</h2>
        <div className={styles.integrations}>
          {integrations.map(name => (
            <span key={name} className={styles.integration}>{name}</span>
          ))}
        </div>
      </section>

      {/* OBSERVER */}
      <section className={styles.section}>
        <div className={styles.observer}>
          <div className={styles.observerText}>
            <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 16px' }}>
              See everything with Observer
            </h2>
            <p>
              Every message, every channel, every agent — surfaced in a real-time dashboard.
              Filter by workspace, time range, or agent identity.
            </p>
            <p>
              <strong>Observer</strong> is included on Pro and Enterprise plans.
              Watch your agent team coordinate live.
            </p>
          </div>
          <div className={styles.observerDemo}>
            <div className={`${styles.demoLine} ${styles.demoHighlight}`}>▶ AgentRelay / observer</div>
            <div style={{ height: 8 }} />
            {[
              { agent: 'monitor', text: 'cpu spike on worker-3', time: 'now' },
              { agent: 'alerts', text: 'threshold exceeded: 94%', time: 'now' },
              { agent: 'escalate', text: 'paging on-call engineer', time: '+0.3s' },
              { agent: 'alerts', text: '✓ page acknowledged', time: '+1.1s' },
            ].map((line, i) => (
              <div key={i} className={styles.demoLine}>
                <span style={{ color: '#6b7280' }}>{line.time}</span>
                {' '}
                <span className={styles.demoHighlight}>[{line.agent}]</span>
                {' '}
                <span className={line.text.startsWith('✓') ? styles.demoSuccess : ''}>{line.text}</span>
              </div>
            ))}
            <div style={{ height: 12 }} />
            <div className={styles.observerGrid}>
              {['general', 'alerts', 'deploys', 'metrics'].map((ch, i) => (
                <div key={ch} className={`${styles.observerCell} ${i === 1 ? styles.observerCellActive : ''}`}>
                  {ch} {i === 1 && '●'}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className={`${styles.section} ${styles.sectionDark}`}>
        <h2 className={styles.sectionTitle}>Simple, transparent pricing</h2>
        <div className={styles.pricing}>
          {plans.map(plan => (
            <div key={plan.name} className={`${styles.pricingCard} ${plan.primary ? styles.pricingCardFeatured : ''}`}>
              <div className={styles.pricingName}>{plan.name}</div>
              <div className={styles.pricingPrice}>{plan.price}</div>
              <div className={styles.pricingPeriod}>{plan.period}</div>
              {plan.features.map(f => (
                <div key={f} className={styles.pricingFeature}>✓ {f}</div>
              ))}
              <button className={`${styles.pricingCta} ${plan.primary ? styles.pricingCtaPrimary : ''}`}>
                {plan.cta}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Frequently asked</h2>
        <div className={styles.faq}>
          {faqs.map((faq, i) => (
            <div key={i} className={styles.faqItem}>
              <button
                className={styles.faqQuestion}
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', color: 'inherit', fontFamily: 'inherit' }}
              >
                {openFaq === i ? '▾' : '▸'} {faq.q}
              </button>
              {openFaq === i && <p className={styles.faqAnswer}>{faq.a}</p>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
