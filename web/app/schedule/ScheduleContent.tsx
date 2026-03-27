'use client';

import { useState } from 'react';
import Link from 'next/link';
import s from './relaycron.module.css';

export function ScheduleContent() {
  const [activeTab, setActiveTab] = useState<'typescript' | 'python' | 'curl'>('typescript');
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const faqs = [
    {
      q: 'Why not just use cron?',
      a: "Cron runs on a single server — if it goes down, your job doesn't fire. RelayCron leverages Cloudflare's globally distributed Durable Objects with automatic failover, so your schedules survive data center outages.",
    },
    {
      q: 'What happens if my webhook endpoint fails?',
      a: 'Failed deliveries are automatically retried with exponential backoff (up to 5 attempts). You can configure retry limits, backoff windows, and subscribe to WebSocket events to monitor delivery status in real-time.',
    },
    {
      q: 'Do I need a Cloudflare account?',
      a: 'Yes — RelayCron runs on Cloudflare Workers and Durable Objects. You bring your own Cloudflare account and Workers usage is covered under RelayCron\'s pricing tiers, separate from Cloudflare\'s included quotas.',
    },
    {
      q: 'How accurate are cron schedules?',
      a: 'Durable Object alarms fire within ~seconds of the configured schedule. The accuracy depends on Cloudflare\'s alarm coalescing — for sub-second precision requirements, consider combining cron schedules with WebSocket-triggered real-time endpoints.',
    },
    {
      q: "What's the maximum webhook payload size?",
      a: '256KB per webhook delivery. For larger payloads, use the SDK to fetch data from RelayCron\'s execution context directly, or use file-based outputs stored via the Relay File API.',
    },
  ];

  const codeSnippets = {
    typescript: `import { RelayCron } from '@agentcron/sdk';

const cron = new RelayCron({
  apiKey: process.env.RELAY_CRON_API_KEY!,
});

// Schedule a job
await cron.schedules.create({
  name: 'daily-report',
  cron: '0 9 * * *',
  webhook: 'https://api.yourapp.com/reports/daily',
  timezone: 'America/New_York',
});

// Stream real-time events
for await (const event of cron.events()) {
  console.log('Job fired:', event.scheduleName, event.firedAt);
}`,
    python: `from agentcron import RelayCron
import os

cron = RelayCron(api_key=os.environ["RELAY_CRON_API_KEY"])

# Schedule a job
cron.schedules.create(
    name="daily-report",
    cron="0 9 * * *",
    webhook="https://api.yourapp.com/reports/daily",
    timezone="America/New_York",
)

# Stream real-time events
for event in cron.events():
    print(f"Job fired: {event.schedule_name} at {event.fired_at}")`,
    curl: `# Create a schedule via REST API
curl -X POST https://api.agentcron.dev/v1/schedules \\
  -H "Authorization: Bearer $RELAY_CRON_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "daily-report",
    "cron": "0 9 * * *",
    "webhook": "https://api.yourapp.com/reports/daily",
    "timezone": "America/New_York"
  }'`,
  };

  return (
    <main className={s.page}>
      {/* Hero */}
      <section className={s.heroSection}>
        <svg className={s.heroBgSvg} viewBox="0 0 1440 400" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="g1" cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse cx="720" cy="200" rx="720" ry="200" fill="url(#g1)" />
        </svg>
        <div className={s.hero}>
          <div className={s.heroLeft}>
            <div className={s.badge}>
              <span className={s.badgeDot} />
              Now in Beta
            </div>
            <h1 className={s.headline}>Reliable cron scheduling for AI agents</h1>
            <p className={s.subtitle}>
              Cron expressions, webhook delivery, WebSocket real-time events, and execution logs — all built on Cloudflare Durable Objects.
            </p>
            <div className={s.ctas}>
              <a href="https://app.agentcron.dev" className={s.ctaPrimary}>Start building free</a>
              <Link href="/docs" className={s.ctaSecondary}>
                Read the docs
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </div>
          <div className={s.heroRight}>
            <div className={s.clockDemo}>
              <svg className={s.clockSvg} viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Clock face */}
                <circle cx="100" cy="100" r="88" fill="var(--card-bg)" stroke="var(--line)" strokeWidth="1.5" />
                <circle cx="100" cy="100" r="80" fill="none" stroke="var(--primary)" strokeOpacity="0.15" strokeWidth="1" />
                {/* Hour markers */}
                {[0,30,60,90,120,150,180,210,240,270,300,330].map((deg, i) => (
                  <line
                    key={i}
                    x1={100 + 72 * Math.cos((deg - 90) * Math.PI / 180)}
                    y1={100 + 72 * Math.sin((deg - 90) * Math.PI / 180)}
                    x2={100 + 80 * Math.cos((deg - 90) * Math.PI / 180)}
                    y2={100 + 80 * Math.sin((deg - 90) * Math.PI / 180)}
                    stroke="var(--primary)"
                    strokeOpacity={i % 3 === 0 ? 0.6 : 0.2}
                    strokeWidth={i % 3 === 0 ? 2 : 1}
                    strokeLinecap="round"
                  />
                ))}
                {/* Hour hand */}
                <line x1="100" y1="100" x2="100" y2="52" stroke="var(--fg)" strokeWidth="3" strokeLinecap="round" />
                {/* Minute hand */}
                <line x1="100" y1="100" x2="130" y2="100" stroke="var(--fg)" strokeWidth="2" strokeOpacity="0.5" strokeLinecap="round" />
                {/* Second hand */}
                <line className={s.secondHand} x1="100" y1="108" x2="100" y2="28" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
                {/* Center dot */}
                <circle cx="100" cy="100" r="5" fill="var(--primary)" />
                {/* Tick particles */}
                <circle className={s.tick1} cx="100" cy="20" r="3" fill="var(--primary)" />
                <circle className={s.tick2} cx="180" cy="100" r="3" fill="var(--primary)" />
                <circle className={s.tick3} cx="100" cy="180" r="3" fill="var(--primary)" />
                {/* Agent nodes */}
                <circle cx="20" cy="80" r="10" fill="var(--primary)" fillOpacity="0.18" stroke="var(--primary)" strokeWidth="1.5" />
                <circle cx="180" cy="160" r="8" fill="var(--primary)" fillOpacity="0.18" stroke="var(--primary)" strokeWidth="1.5" />
                <circle cx="40" cy="160" r="7" fill="var(--primary)" fillOpacity="0.12" stroke="var(--primary)" strokeWidth="1" />
                {/* Connection lines */}
                <line x1="28" y1="84" x2="60" y2="92" stroke="var(--primary)" strokeWidth="1" strokeOpacity="0.25" strokeDasharray="3 3" />
                <line x1="172" y1="158" x2="140" y2="108" stroke="var(--primary)" strokeWidth="1" strokeOpacity="0.2" strokeDasharray="3 3" />
              </svg>
              <p className={s.clockLabel}>CRON: 0 9 * * * America/New_York</p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <div className={s.featuresWrapper}>
        <div className={s.featuresHeader}>
          <h2 className={s.featuresTitle}>Everything you need to schedule at scale</h2>
          <p className={s.featuresSubtitle}>Built on Cloudflare Durable Objects so your schedules survive data center outages.</p>
        </div>
        <div className={s.featuresSection}>
          {[
            {
              chip: 'Scheduling',
              title: 'Cron Expressions',
              desc: 'Full cron expression support with second-level precision. Use standard 5-field cron or 6-field with seconds. Timezone-aware scheduling out of the box.',
            },
            {
              chip: 'Delivery',
              title: 'Webhook Delivery',
              desc: 'HTTP POST deliveries with automatic retries, exponential backoff, and configurable timeout. JSON payload with schedule metadata included.',
            },
            {
              chip: 'Real-time',
              title: 'WebSocket Events',
              desc: 'Subscribe to schedule lifecycle events in real-time — job fired, delivery success, delivery failure, and retry attempts all streamed over WebSocket.',
            },
            {
              chip: 'Observability',
              title: 'Execution Logs',
              desc: 'Every job execution logged with request/response payloads, status codes, retry attempts, and latency. Search and filter in the dashboard or via API.',
            },
            {
              chip: 'Reliability',
              title: 'Durable Object Alarms',
              desc: 'Built on Cloudflare Durable Objects with automatic failover across 300+ data centers. No single point of failure — your jobs fire even if individual PoPs go down.',
            },
            {
              chip: 'SDK',
              title: 'TypeScript SDK',
              desc: 'First-party SDK for Node.js and Python with full type safety, auto-completion, and chainable methods. REST API available for any other runtime.',
            },
          ].map((f) => (
            <div key={f.chip} className={s.featureCol}>
              <div className={s.featureTile}>
                <span className={s.featureChip}>{f.chip}</span>
                <h3 className={s.featureTitle}>{f.title}</h3>
                <p className={s.featureDesc}>{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Works with */}
      <div className={s.byohWrapper}>
        <div className={s.byohSection}>
          <div className={s.byohText}>
            <h2 className={s.byohTitle}>Works with every AI tool</h2>
            <p className={s.byohSubtitle}>Trigger any workflow, agent, or pipeline on a schedule — from any AI framework.</p>
          </div>
          <div className={s.byohLogos}>
            {['Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'Pi', 'Devin', 'Mage', 'Aider'].map((tool) => (
              <span key={tool} className={s.toolBadge}>{tool}</span>
            ))}
          </div>
        </div>
      </div>

      {/* SDK */}
      <div className={s.sdkWrapper}>
        <div className={s.sdkSection}>
          <div className={s.sdkText}>
            <span className={s.openclawBadge}>SDK</span>
            <h2 className={s.sdkTitle}>Simple, expressive API</h2>
            <p className={s.sdkSubtitle}>Create schedules, subscribe to events, and fetch execution history — all from one coherent SDK.</p>
            <div className={s.sdkBullets}>
              {[
                'TypeScript &amp; Python SDKs with full type safety',
                'WebSocket streaming for real-time job monitoring',
                'Execution history with full request/response payloads',
                'Webhooks with automatic retry and exponential backoff',
              ].map((b) => (
                <div key={b} className={s.sdkBullet}>
                  <span className={s.sdkBulletDot} />
                  <span>{b}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={s.sdkCode}>
            <div className={s.codePanel}>
              <div className={s.previewTitleBar}>
                <div className={s.previewDots}>
                  <span style={{ background: '#ff5f57' }} />
                  <span style={{ background: '#febc2e' }} />
                  <span style={{ background: '#28c840' }} />
                </div>
                <span className={s.previewTitleText}>schedule.ts</span>
              </div>
              <div className={s.tabRow}>
                {(['typescript', 'python', 'curl'] as const).map((tab) => (
                  <button
                    key={tab}
                    className={`${s.tabButton} ${activeTab === tab ? s.tabButtonActive : ''}`}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === 'typescript' ? 'TypeScript' : tab === 'python' ? 'Python' : 'cURL'}
                  </button>
                ))}
              </div>
              <pre className={s.sdkCodeBlock}>
                <code dangerouslySetInnerHTML={{ __html: codeSnippets[activeTab]
                  .replace(/\b(const|await|import|from|for|async|new|class|type|interface|export|return)\b/g, '<span class="' + s.codeKeyword + '">$1</span>')
                  .replace(/(['"`])(.*?)\1/g, '<span class="' + s.codeString + '">$1$2$1</span>')
                  .replace(/(\/\/.*)/g, '<span class="' + s.codeType + '">$1</span>')
                  .replace(/\b(\d+)\b/g, '<span class="' + s.codeType + '">$1</span>')
                }} />
              </pre>
            </div>
          </div>
        </div>
      </div>

      {/* Why RelayCron */}
      <div className={s.deployWrapper}>
        <div className={s.deploySection}>
          <h2 className={s.deployTitle}>Why RelayCron?</h2>
          <p className={s.deploySubtitle}>Built on Cloudflare Durable Objects — the scheduling infrastructure your agents can rely on.</p>
          <div className={s.deployCards}>
            {[
              {
                icon: '⚡',
                title: 'Global reliability',
                text: 'Durable Objects replicate automatically across Cloudflare\'s 300+ PoPs. A data center outage won\'t stop your jobs from firing — failover is built in, not bolted on.',
              },
              {
                icon: '📊',
                title: 'Full observability',
                text: 'Every delivery attempt is logged with request/response bodies, status codes, latency, and retry counts. Know exactly what fired, when, and what came back.',
              },
              {
                icon: '🔧',
                title: 'AI-agent friendly',
                text: 'SDK designed for agentic contexts — streaming WebSocket events, idempotent schedule creation, and execution context available at runtime for dynamic payload building.',
              },
            ].map((d) => (
              <div key={d.title} className={s.deployCard}>
                <div className={s.deployIcon}>{d.icon}</div>
                <h3 className={s.deployCardTitle}>{d.title}</h3>
                <p className={s.deployCardText}>{d.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Pricing */}
      <div className={s.pricingWrapper}>
        <div className={s.pricingSection}>
          <h2 className={s.pricingTitle}>Simple, predictable pricing</h2>
          <p className={s.pricingSubtitle}>No per-seat fees. No surprise overages. Scale your agents without scaling your billing headaches.</p>
          <div className={s.pricingCards}>
            {[
              {
                name: 'Hobby',
                price: 'Free',
                period: '',
                features: ['5 active schedules', '10,000 executions/mo', 'Webhook delivery', '7-day log retention', 'Community support'],
                cta: 'Start for free',
                featured: false,
              },
              {
                name: 'Pro',
                price: '$29',
                period: '/month',
                features: ['50 active schedules', '500,000 executions/mo', 'Webhook + WebSocket', '30-day log retention', 'Idempotency keys', 'Priority support'],
                cta: 'Get Pro',
                featured: true,
              },
              {
                name: 'Enterprise',
                price: 'Custom',
                period: '',
                features: ['Unlimited schedules', 'Custom execution limits', 'SLA guarantee', '90+ day log retention', 'Dedicated support', 'On-premise option'],
                cta: 'Talk to us',
                featured: false,
              },
            ].map((p) => (
              <div key={p.name} className={`${s.pricingCard} ${p.featured ? s.pricingCardFeatured : ''}`}>
                <h3 className={s.pricingName}>{p.name}</h3>
                <p className={s.pricingPrice}>{p.price}</p>
                <p className={s.pricingPeriod}>{p.period}</p>
                {p.features.map((f) => (
                  <p key={f} className={s.pricingFeature}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {f}
                  </p>
                ))}
                <button className={`${s.pricingCta} ${p.featured ? s.pricingCtaPrimary : ''}`}>{p.cta}</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div className={s.faqWrapper}>
        <div className={s.faqSection}>
          <h2 className={s.faqTitle}>Frequently asked questions</h2>
          <div className={s.faqList}>
            {faqs.map((faq, i) => (
              <div key={i} className={s.faqItem}>
                <button className={s.faqQuestion} onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                  <span>{openFaq === i ? '−' : '+'}</span>
                  {faq.q}
                </button>
                {openFaq === i && <p className={s.faqAnswer}>{faq.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
