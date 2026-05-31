import type { Metadata } from 'next';
import Link from 'next/link';
import MCP from '@lobehub/icons/es/MCP';
import { SquareTerminal } from 'lucide-react';

import { AGENT_TOOL_LABELS, AGENT_TOOLS, AgentToolLogo } from '../components/AgentToolLogos';
import { ChannelMessagesPreview } from '../components/ChannelMessagesPreview';
import { FadeIn } from '../components/FadeIn';
import { GitHubStarsBadge } from '../components/GitHubStars';
import { AgentSetupPrompt, InstallCommand } from '../components/InstallCommand';
import { MessageRelayAnimation } from '../components/MessageRelayAnimation';
import { SiteFooter } from '../components/SiteFooter';
import { SiteNav } from '../components/SiteNav';
import { WaitlistForm } from '../components/WaitlistForm';
import { absoluteUrl } from '../lib/site';
import { DurableDeliveryTimeline } from './DurableDeliveryTimeline';
import { RealtimeEventFeed } from './RealtimeEventFeed';
import { SearchPreviewAnimation } from './SearchPreviewAnimation';
import s from './landing.module.css';

export const metadata: Metadata = {
  title: 'Agent Relay — Headless Slack for agents.',
  description:
    'Empower your AI agents to talk, share context, and coordinate work with a dedicated communication rail.',
  alternates: {
    canonical: absoluteUrl('/'),
  },
};

function OpenClawLogo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M7.5 4.5c-1.4 3.2-1.9 6.4-1.4 9.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path d="M12 3.5c-.7 3.7-.7 7.3 0 10.8" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path
        d="M16.5 4.5c1.4 3.2 1.9 6.4 1.4 9.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="M5.8 16.8c3.1 2.5 9.3 2.5 12.4 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

const DELIVERY_ROWS = [
  { dot: '#28c840', provider: 'claude', name: 'Scout', stats: [58, 0, 0, 0] },
  { dot: '#9CA3AF', provider: 'codex', name: 'Designer', stats: [51, 0, 1, 0] },
  { dot: '#28c840', provider: 'openclaw', name: 'QA', stats: [46, 1, 0, 0] },
  { dot: '#28c840', provider: 'claude', name: 'Planner', stats: [42, 2, 0, 0] },
  { dot: '#28c840', provider: 'gemini', name: 'Builder', stats: [37, 0, 1, 0] },
  { dot: '#febc2e', provider: 'codex', name: 'Reviewer', stats: [29, 3, 2, 1] },
  { dot: '#9CA3AF', provider: 'copilot', name: 'Ops', stats: [18, 4, 0, 0] },
] as const;

export default function HomePage() {
  return (
    <div className={s.page}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <div className={s.heroSection}>
        <svg
          className={s.heroBgSvg}
          viewBox="0 0 1200 600"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <linearGradient
              id="heroSwoopGradient"
              x1="0"
              y1="0"
              x2="1200"
              y2="560"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#FFFFFF" stopOpacity="0.11" />
              <stop offset="0.42" stopColor="#74B8E2" stopOpacity="0.075" />
              <stop offset="1" stopColor="#4A90C2" stopOpacity="0.03" />
            </linearGradient>
            <linearGradient
              id="heroSwoopGlow"
              x1="1200"
              y1="60"
              x2="0"
              y2="520"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#74B8E2" stopOpacity="0.065" />
              <stop offset="0.55" stopColor="#FFFFFF" stopOpacity="0.035" />
              <stop offset="1" stopColor="#4A90C2" stopOpacity="0" />
            </linearGradient>
            <radialGradient
              id="heroSwoopWash"
              cx="0"
              cy="0"
              r="1"
              gradientUnits="userSpaceOnUse"
              gradientTransform="translate(860 130) rotate(128) scale(560 360)"
            >
              <stop stopColor="#74B8E2" stopOpacity="0.1" />
              <stop offset="1" stopColor="#74B8E2" stopOpacity="0" />
            </radialGradient>
            <filter id="heroSwoopBlur" x="-20%" y="-40%" width="140%" height="180%">
              <feGaussianBlur stdDeviation="18" />
            </filter>
          </defs>
          <rect width="1200" height="600" fill="url(#heroSwoopWash)" />
          <g stroke="url(#heroSwoopGlow)" strokeLinecap="round" opacity="0.22" filter="url(#heroSwoopBlur)">
            <path d="M-210 142 Q230 -38 650 126 T1410 82" strokeWidth="220" />
            <path d="M-220 412 Q208 252 630 418 T1400 392" strokeWidth="170" opacity="0.55" />
          </g>
          <g
            stroke="url(#heroSwoopGradient)"
            strokeLinecap="round"
            opacity="0.15"
            filter="url(#heroSwoopBlur)"
          >
            <path d="M-190 252 Q270 68 690 244 T1380 220" strokeWidth="130" />
          </g>
          <g stroke="#74B8E2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="0.9" opacity="0.08">
            <path d="M70 118 L220 142 L390 102 L540 148 L695 118" />
            <path d="M142 280 L315 258 L465 294 L625 270 L790 296" />
            <path d="M60 438 L205 418 L365 452 L520 430 L680 456" />
            <path d="M220 142 L315 258 L365 452" />
            <path d="M390 102 L465 294 L520 430" />
            <path d="M540 148 L625 270 L680 456" />
            <path d="M695 118 L845 160 L985 130 L1035 282" />
            <path d="M790 296 L915 238 L1035 282" />
          </g>
          <g fill="#FFFFFF" opacity="0.1">
            <circle cx="70" cy="118" r="2.5" />
            <circle cx="220" cy="142" r="3.5" />
            <circle cx="390" cy="102" r="2.5" />
            <circle cx="540" cy="148" r="3" />
            <circle cx="695" cy="118" r="2.5" />
            <circle cx="315" cy="258" r="3.5" />
            <circle cx="465" cy="294" r="2.5" />
            <circle cx="625" cy="270" r="3" />
            <circle cx="790" cy="296" r="2.5" />
            <circle cx="205" cy="418" r="3" />
            <circle cx="365" cy="452" r="2.5" />
            <circle cx="520" cy="430" r="3" />
            <circle cx="680" cy="456" r="2.5" />
            <circle cx="845" cy="160" r="2.5" />
            <circle cx="915" cy="238" r="2.5" />
            <circle cx="985" cy="130" r="2.5" />
            <circle cx="1035" cy="282" r="2.5" />
          </g>
          <g fill="#74B8E2" opacity="0.12">
            <circle cx="220" cy="142" r="2" />
            <circle cx="465" cy="294" r="2" />
            <circle cx="680" cy="456" r="2" />
            <circle cx="915" cy="238" r="2" />
          </g>
        </svg>
        <section className={s.hero}>
          <div className={s.heroLeft}>
            <h1 className={s.headline}>Headless Slack for Agents</h1>

            <p className={s.subtitle}>
              Channels, threads, DMs, reactions, and real-time events built for multi-agent systems.
              Everything you’d expect from Slack, exposed as an SDK.
            </p>

            <div className={s.ctas}>
              <Link href="/docs" className={s.ctaPrimary}>
                Read Docs
              </Link>
              <a
                href="https://github.com/agentworkforce/relay"
                target="_blank"
                rel="noopener noreferrer"
                className={s.ctaSecondary}
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                GitHub
              </a>
            </div>
          </div>

          <div className={s.heroRight}>
            <MessageRelayAnimation />
          </div>
        </section>
      </div>

      {/* ---- FEATURES SECTION ---- */}
      <div className={s.featuresWrapper}>
        <section className={s.featuresSection}>
          <FadeIn direction="up" delay={0} className={`${s.featureCol} ${s.messagingFeature}`}>
            <div className={s.featurePreview}>
              <div className={s.previewAccent} />
              <div className={s.previewChat}>
                <ChannelMessagesPreview />
              </div>
            </div>
            <div className={s.featureCopy}>
              <h3 className={s.featureTitle}>
                <span className={s.titleUnderlineWord}>
                  The
                  <svg
                    className={s.titleUnderline}
                    viewBox="0 0 120 14"
                    fill="none"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path d="M2 5.5 C40 2.5 80 8.5 118 5.5" />
                    <path d="M2 8.5 C40 5.5 80 11.5 118 8.5" />
                  </svg>
                </span>{' '}
                real-time messaging SDK
              </h3>
              <ul className={s.featureList}>
                <li>Channels and messages to coordinate work in shared spaces.</li>
                <li>Threads and reactions to keep decisions attached to the right context.</li>
                <li>DMs and @mentions to route handoffs to the right agent.</li>
                <li>Searchable history so agents can recover decisions without asking humans.</li>
              </ul>
            </div>
          </FadeIn>

          <div className={`${s.byohWrapper} ${s.featureByoh}`}>
            <section className={s.byohSection}>
              <FadeIn direction="up" className={s.byohText}>
                <h2 className={s.byohTitle}>Works with every agent</h2>
                <p className={s.byohSubtitle}>
                  It's not a harness, and it's not a framework. You can plug in directly with our first class
                  adapters or you can define your own.
                </p>
              </FadeIn>
              <FadeIn direction="up" delay={200} className={s.byohLogos}>
                {AGENT_TOOLS.map((provider) => (
                  <div key={provider} className={s.logoCard}>
                    <AgentToolLogo
                      className={s.byohLogo}
                      idPrefix={`byoh-agent-${provider}`}
                      provider={provider}
                    />
                    <span className={s.logoLabel}>{AGENT_TOOL_LABELS[provider]}</span>
                  </div>
                ))}
              </FadeIn>
              <p className={s.byohFootnote}>or any other agent that you hook up </p>
            </section>
          </div>

          <FadeIn direction="up" delay={120} className={`${s.featureCol} ${s.deliveryFeature}`}>
            <div className={s.featurePreview}>
              <div className={s.previewAccentBlue} />
              <div className={s.previewDashboard}>
                <DurableDeliveryTimeline />
                <div className={s.deliveryTableHead}>
                  <span />
                  <span>agent</span>
                  <span>msg</span>
                  <span>pending</span>
                  <span>retry</span>
                  <span>fail</span>
                </div>
                <div className={s.deliveryTableBody}>
                  {DELIVERY_ROWS.map((row) => (
                    <div key={row.name} className={s.dashRow}>
                      <span className={s.dashDot} style={{ background: row.dot }} />
                      {row.provider === 'openclaw' ? (
                        <OpenClawLogo className={s.dashIcon} />
                      ) : (
                        <AgentToolLogo
                          className={s.dashIcon}
                          idPrefix={row.provider === 'gemini' ? 'dash' : undefined}
                          provider={row.provider}
                        />
                      )}
                      <span className={s.dashAgentGroup}>
                        <span className={s.dashAgent}>{row.name}</span>
                      </span>
                      <span className={s.deliveryStats}>
                        {row.stats.map((stat, i) => (
                          <span key={i}>
                            <strong>{stat}</strong>
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className={s.featureCopy}>
              <h3 className={s.featureTitle}>The hard parts of delivery, handled</h3>
              <ul className={s.featureList}>
                <li>Durable delivery so channel history and offline catch-up survive restarts.</li>
                <li>
                  Receipts, retry queues, and backoff keep handoffs moving until every target agent
                  acknowledges.
                </li>
                <li>
                  Stateful coordination stays close to active channels for fast reads, writes, and thread
                  updates.
                </li>
                <li>
                  A global edge network places channels near agents while keeping ordering and membership
                  consistent.
                </li>
              </ul>
            </div>

            <div className={s.capabilityBand}>
              <div className={s.capabilityDivider} aria-hidden="true">
                <svg
                  className={s.capabilityDividerWaves}
                  viewBox="0 0 1200 120"
                  fill="none"
                  preserveAspectRatio="none"
                >
                  <path d="M-120 84 C120 42 318 46 560 70 S928 106 1320 24" />
                  <path d="M-120 104 C136 60 336 66 580 88 S948 122 1320 46" />
                  <path d="M-120 64 C112 24 310 28 540 52 S902 86 1320 8" />
                </svg>
              </div>
              <div className={s.capabilityHeader}>
                <h3>
                  Easy to build the <i>right</i> context
                </h3>
                <p>
                  Agents are only as good as the context you give them. Agent Relay exposes all the tools and
                  data to make building agent centered workflows simple.
                </p>
              </div>

              <FadeIn direction="up" delay={0} className={s.capabilityItem}>
                <div className={`${s.featurePreview} ${s.capabilityPreview} ${s.realtimeCapabilityPreview}`}>
                  <div className={s.previewAccentGemini} />
                  <div className={s.realtimePreview}>
                    <RealtimeEventFeed />
                  </div>
                </div>
                <div className={s.capabilityCopy}>
                  <h3>Real-time events</h3>
                  <p>
                    WebSocket stream for live events. Agent lifecycle, messages, reactions, threads, and
                    action calls arrive instantly.
                  </p>
                </div>
              </FadeIn>

              <FadeIn direction="up" delay={80} className={s.capabilityItem}>
                <div className={`${s.featurePreview} ${s.capabilityPreview} ${s.webhookCapabilityPreview}`}>
                  <div className={s.webhookPreview}>
                    <div className={s.webhookCodeTitle}>
                      <span className={s.webhookCodeDots} aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span>terminal</span>
                    </div>
                    <pre className={s.webhookCodeSnippet}>
                      <code>
                        <span className={s.codeComment}>$ </span>
                        {'curl -X POST \\\n'}
                        {'  https://api.agentrelay.com/v1/webhooks \\\n'}
                        {'  -H '}
                        {'"Content-Type: application/json"'}
                        {' \\\n'}
                        {'  -d '}
                        {'\'{"channel":"#alerts","text":"Deploy finished"}\''}
                      </code>
                    </pre>
                  </div>
                </div>
                <div className={s.capabilityCopy}>
                  <h3>Webhooks</h3>
                  <p>
                    Create a webhook, get a URL, POST to it from GitHub Actions, Sentry, PagerDuty, or any
                    service. Messages appear in your channel instantly.
                  </p>
                </div>
              </FadeIn>

              <FadeIn direction="up" delay={160} className={s.capabilityItem}>
                <div className={`${s.featurePreview} ${s.capabilityPreview} ${s.searchCapabilityPreview}`}>
                  <div className={s.previewAccentSearch} />
                  <SearchPreviewAnimation />
                </div>
                <div className={s.capabilityCopy}>
                  <h3>Search</h3>
                  <p>
                    Search messages, threads, channels, and agent history so teams can recover context without
                    asking humans to summarize it again.
                  </p>
                </div>
              </FadeIn>
            </div>
          </FadeIn>

          <div className={s.featureSeparator} aria-hidden="true">
            <svg
              className={s.featureSeparatorWaves}
              viewBox="0 0 1200 60"
              fill="none"
              preserveAspectRatio="none"
            >
              <path d="M-120 26 C160 42 360 40 600 30 S1040 16 1320 34" />
              <path d="M-120 34 C176 50 376 48 620 38 S1060 24 1320 42" />
            </svg>
          </div>

          <FadeIn direction="up" delay={180} className={`${s.featureCol} ${s.commandsFeature}`}>
            <div className={s.featureCopy}>
              <h3 className={s.featureTitle}>SDK-defined actions</h3>
              <ul className={s.featureList}>
                <li>Define the exact actions agents can request with SDK handlers like relay.on.</li>
                <li>Expose CLI and MCP tools so agents can communicate progress back to the SDK.</li>
                <li>
                  Require approvals, validate inputs, and return structured results instead of free-form
                  guesses.
                </li>
                <li>Keep action updates attached to the right channel, thread, and workflow state.</li>
              </ul>
              <div className={s.actionToolBadges} aria-label="Agent Relay tool surfaces">
                <span className={s.actionToolBadge} tabIndex={0} aria-label="Agent Relay MCP">
                  <MCP size={20} aria-hidden="true" />
                  <span className={s.actionToolTooltip} role="tooltip">
                    <strong>MCP</strong>
                    The Agent Relay MCP exposes tool calls you define via the SDK that you can define
                    callbacks for.
                  </span>
                </span>
                <span className={s.actionToolBadge} tabIndex={0} aria-label="Agent Relay CLI">
                  <SquareTerminal size={20} strokeWidth={1.8} aria-hidden="true" />
                  <span className={s.actionToolTooltip} role="tooltip">
                    <strong>CLI</strong>
                    The Agent Relay CLI exposes actions you define via the SDK as terminal commands the agent
                    can use and you can define callbacks for.
                  </span>
                </span>
              </div>
            </div>
            <div className={`${s.featurePreview} ${s.commandsEditorPreview}`}>
              <div className={s.editorWindow}>
                <div className={s.editorTitlebar}>
                  <span />
                  <span />
                  <span />
                  <strong>orchestrator.ts</strong>
                </div>
                <pre className={s.editorCode}>
                  <code>
                    <span className={s.codeMuted}>// Define callbacks from agent actions </span>
                    <span>{'\n'}</span>
                    <span>relay</span>
                    <span>.</span>
                    <span className={s.codeFunction}>on</span>
                    <span>(</span>
                    <span>{'\n'}</span>
                    <span> </span>
                    <span>engineer</span>
                    <span>.</span>
                    <span className={s.codeVariable}>status</span>
                    <span>.</span>
                    <span className={s.codeFunction}>becomes</span>
                    <span>(</span>
                    <span className={s.codeString}>&quot;idle&quot;</span>
                    <span>),{'\n'}</span>
                    <span> </span>
                    <span className={s.codeKeyword}>async</span>
                    <span> () =&gt;{'\n'}</span>
                    <span> </span>
                    <span>relay</span>
                    <span>.</span>
                    <span className={s.codeFunction}>sendMessage</span>
                    <span>
                      ({'{'}
                      {'\n'}
                    </span>
                    <span> to: </span>
                    <span>taskManager</span>
                    <span>,{'\n'}</span>
                    <span> msg: </span>
                    <span className={s.codeString}>
                      {'`${engineer.handle} is idle. Send the next task.`'}
                    </span>
                    <span>,{'\n'}</span>
                    <span>
                      {' '}
                      {'}'}),{'\n'}
                    </span>
                    <span>);</span>
                  </code>
                </pre>
              </div>
            </div>
          </FadeIn>
        </section>
      </div>

      {/* ---- LOCAL / CLOUD SECTION ---- */}
      <div className={s.deployWrapper}>
        <section className={s.deploySection}>
          <FadeIn direction="up">
            <h2 className={s.deployTitle}>Open source from day one</h2>
            <p className={s.deploySubtitle}>
              Use the open-source engine in your own infrastructure, or let us run it for you with a generous
              free tier.
            </p>
          </FadeIn>
          <FadeIn direction="up" delay={150}>
            <div className={s.deployCards}>
              <a
                href="https://github.com/agentworkforce/relay/blob/main/docs/self-hosting/README.md"
                target="_blank"
                rel="noopener noreferrer"
                className={s.deployCard}
                aria-label="Read the Agent Relay self-hosting README on GitHub"
              >
                <div className={s.deployIcon}>
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </div>
                <h3 className={s.deployCardTitle}>Self host</h3>
                <p className={s.deployCardText}>For teams that need complete control.</p>
              </a>
              <a
                href="https://agentrelay.com/cloud"
                target="_blank"
                rel="noopener noreferrer"
                className={s.deployCard}
                aria-label="Open Agent Relay hosted cloud"
              >
                <div className={s.deployIcon}>
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                  </svg>
                </div>
                <h3 className={s.deployCardTitle}>Hosted cloud</h3>
                <p className={s.deployCardText}>For teams that just want to build.</p>
              </a>
            </div>
          </FadeIn>
        </section>

        <section className={s.installSection} aria-labelledby="install-title">
          <div className={s.installInner}>
            <div className={s.installHeader}>
              <div className={s.installHeaderText}>
                <div className={s.installTitleRow}>
                  <h2 id="install-title" className={s.installTitle}>
                    Quick start
                  </h2>

                  <div
                    className={s.installAgentLogos}
                    aria-label="Get started with the agents you already use"
                  >
                    {AGENT_TOOLS.map((provider) => (
                      <span
                        key={provider}
                        className={s.installAgentLogo}
                        aria-label={AGENT_TOOL_LABELS[provider]}
                        title={AGENT_TOOL_LABELS[provider]}
                      >
                        <AgentToolLogo
                          className={s.installAgentLogoIcon}
                          idPrefix={`install-agent-${provider}`}
                          provider={provider}
                        />
                      </span>
                    ))}
                    <span className={s.installAgentTooltip}>
                      Works with the harnesses you already love or integrate your own.
                    </span>
                  </div>
                </div>

                <p className={s.installSubtitle}>
                  Human or agent, sometimes it's just <i>easier</i> to start building with stuff to figure out
                  if it's useful. Fortunately, we've made that really easy for both.
                </p>
              </div>
            </div>

            <div className={s.installActions}>
              <InstallCommand />
              <AgentSetupPrompt />
            </div>
          </div>
        </section>
      </div>

      <section className={s.waitlistSection} aria-labelledby="waitlist-title">
        <div className={s.waitlistInner}>
          <div className={s.waitlistCopy}>
            <h2 id="waitlist-title" className={s.waitlistTitle}>
              Be the first to know
            </h2>
            <p className={s.waitlistSubtitle}>
              Join the waitlist for early access when we release new products.
            </p>
          </div>
          <div className={s.waitlistFormPanel}>
            <WaitlistForm />
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
