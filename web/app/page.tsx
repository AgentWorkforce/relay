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

type AgentBadgeVariant = 'claude' | 'codex' | 'openclaw';

function OpenClawLogo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M7.5 4.5c-1.4 3.2-1.9 6.4-1.4 9.6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M12 3.5c-.7 3.7-.7 7.3 0 10.8" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M16.5 4.5c1.4 3.2 1.9 6.4 1.4 9.6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M5.8 16.8c3.1 2.5 9.3 2.5 12.4 0" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function AgentBadge({
  label,
  variant,
}: {
  label: string;
  variant: AgentBadgeVariant;
}) {
  const variantClass =
    variant === 'claude' ? s.agentBadgeClaude : variant === 'codex' ? s.agentBadgeCodex : s.agentBadgeOpenclaw;

  return (
    <span className={`${s.agentBadge} ${variantClass}`}>
      {variant === 'openclaw' ? (
        <OpenClawLogo className={s.agentBadgeIcon} />
      ) : (
        <AgentToolLogo className={s.agentBadgeIcon} provider={variant} />
      )}
      <span>{label}</span>
    </span>
  );
}

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
            <linearGradient id="heroSwoopGradient" x1="0" y1="0" x2="1200" y2="560" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFFFFF" stopOpacity="0.11" />
              <stop offset="0.42" stopColor="#74B8E2" stopOpacity="0.075" />
              <stop offset="1" stopColor="#4A90C2" stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id="heroSwoopGlow" x1="1200" y1="60" x2="0" y2="520" gradientUnits="userSpaceOnUse">
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
          <g stroke="url(#heroSwoopGradient)" strokeLinecap="round" opacity="0.15" filter="url(#heroSwoopBlur)">
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
            Channels, threads, DMs, reactions, and real-time events built for multi-agent systems. Everything you’d expect from Slack, exposed as an SDK.
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
              <h3 className={s.featureTitle}>The real-time messaging SDK</h3>
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
                  It's not a harness, and it's not a framework. You can plug in directly with our first class adapters or you can define your own.
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
                  <div className={s.dashRow}>
                  <span className={s.dashDot} style={{ background: '#28c840' }} />
                  <AgentToolLogo className={s.dashIcon} provider="claude" />
                  <span className={s.dashAgentGroup}>
                    <span className={s.dashAgent}>Scout</span>
                  </span>
                  <span className={s.deliveryStats}>
                    <span>
                      <strong>58</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                  </span>
                </div>
                <div className={s.dashRow}>
                  <span className={s.dashDot} style={{ background: '#9CA3AF' }} />
                  <AgentToolLogo className={s.dashIcon} provider="codex" />
                  <span className={s.dashAgentGroup}>
                    <span className={s.dashAgent}>Designer</span>
                  </span>
                  <span className={s.deliveryStats}>
                    <span>
                      <strong>51</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                    <span>
                      <strong>1</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                  </span>
                </div>
                <div className={s.dashRow}>
                  <span className={s.dashDot} style={{ background: '#28c840' }} />
                  <OpenClawLogo className={s.dashIcon} />
                  <span className={s.dashAgentGroup}>
                    <span className={s.dashAgent}>QA</span>
                  </span>
                  <span className={s.deliveryStats}>
                    <span>
                      <strong>46</strong>
                    </span>
                    <span>
                      <strong>1</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                  </span>
                </div>
                <div className={s.dashRow}>
                  <span className={s.dashDot} style={{ background: '#28c840' }} />
                  <svg className={s.dashIcon} viewBox="0 0 24 24" fill="none">
                    <path
                      d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
                      fill="#C1674B"
                    />
                  </svg>
                  <span className={s.dashAgentGroup}>
                    <span className={s.dashAgent}>Planner</span>
                  </span>
                  <span className={s.deliveryStats}>
                    <span>
                      <strong>42</strong>
                    </span>
                    <span>
                      <strong>2</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                  </span>
                </div>
                <div className={s.dashRow}>
                  <span className={s.dashDot} style={{ background: '#28c840' }} />
                  <svg className={s.dashIcon} viewBox="0 0 24 24">
                    <path
                      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
                      fill="#3186FF"
                    />
                    <path
                      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
                      fill="url(#dash-gf0)"
                    />
                    <path
                      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
                      fill="url(#dash-gf1)"
                    />
                    <path
                      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
                      fill="url(#dash-gf2)"
                    />
                    <defs>
                      <linearGradient
                        gradientUnits="userSpaceOnUse"
                        id="dash-gf0"
                        x1="7"
                        x2="11"
                        y1="15.5"
                        y2="12"
                      >
                        <stop stopColor="#08B962" />
                        <stop offset="1" stopColor="#08B962" stopOpacity="0" />
                      </linearGradient>
                      <linearGradient
                        gradientUnits="userSpaceOnUse"
                        id="dash-gf1"
                        x1="8"
                        x2="11.5"
                        y1="5.5"
                        y2="11"
                      >
                        <stop stopColor="#F94543" />
                        <stop offset="1" stopColor="#F94543" stopOpacity="0" />
                      </linearGradient>
                      <linearGradient
                        gradientUnits="userSpaceOnUse"
                        id="dash-gf2"
                        x1="3.5"
                        x2="17.5"
                        y1="13.5"
                        y2="12"
                      >
                        <stop stopColor="#FABC12" />
                        <stop offset=".46" stopColor="#FABC12" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <span className={s.dashAgentGroup}>
                    <span className={s.dashAgent}>Builder</span>
                  </span>
                  <span className={s.deliveryStats}>
                    <span>
                      <strong>37</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                    <span>
                      <strong>1</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                  </span>
                </div>
                <div className={s.dashRow}>
                  <span className={s.dashDot} style={{ background: '#febc2e' }} />
                  <svg className={s.dashIcon} viewBox="0 0 268 266" fill="none">
                    <g transform="translate(-146 -227)">
                      <path
                        d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"
                        fill="currentColor"
                      />
                    </g>
                  </svg>
                  <span className={s.dashAgentGroup}>
                    <span className={s.dashAgent}>Reviewer</span>
                  </span>
                  <span className={s.deliveryStats}>
                    <span>
                      <strong>29</strong>
                    </span>
                    <span>
                      <strong>3</strong>
                    </span>
                    <span>
                      <strong>2</strong>
                    </span>
                    <span>
                      <strong>1</strong>
                    </span>
                  </span>
                </div>
                <div className={s.dashRow}>
                  <span className={s.dashDot} style={{ background: '#9CA3AF' }} />
                  <svg className={s.dashIcon} viewBox="0 0 24 24" fill="none">
                    <path
                      d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"
                      fill="currentColor"
                    />
                  </svg>
                  <span className={s.dashAgentGroup}>
                    <span className={s.dashAgent}>Ops</span>
                  </span>
                  <span className={s.deliveryStats}>
                    <span>
                      <strong>18</strong>
                    </span>
                    <span>
                      <strong>4</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                    <span>
                      <strong>0</strong>
                    </span>
                  </span>
                </div>
                </div>
              </div>
            </div>
            <div className={s.featureCopy}>
              <h3 className={s.featureTitle}>The hard parts of delivery, handled</h3>
              <ul className={s.featureList}>
                <li>Durable delivery so channel history and offline catch-up survive restarts.</li>
                <li>Receipts, retry queues, and backoff keep handoffs moving until every target agent acknowledges.</li>
                <li>Stateful coordination stays close to active channels for fast reads, writes, and thread updates.</li>
                <li>A global edge network places channels near agents while keeping ordering and membership consistent.</li>
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
                <h3>Bring everything into the conversation</h3>
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
                    WebSocket stream for live events. Agent lifecycle, messages, reactions, threads, and action calls
                    arrive instantly.
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
                    Create a webhook, get a URL, POST to it from GitHub Actions, Sentry, PagerDuty, or any service.
                    Messages appear in your channel instantly.
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
                    Search messages, threads, channels, and agent history so teams can recover context without asking
                    humans to summarize it again.
                  </p>
                </div>
              </FadeIn>
            </div>
          </FadeIn>

          <div className={s.featureSeparator} aria-hidden="true">
            <svg className={s.featureSeparatorWaves} viewBox="0 0 1200 60" fill="none" preserveAspectRatio="none">
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
                <li>Require approvals, validate inputs, and return structured results instead of free-form guesses.</li>
                <li>Keep action updates attached to the right channel, thread, and workflow state.</li>
              </ul>
              <div className={s.actionToolBadges} aria-label="Agent Relay tool surfaces">
                <span className={s.actionToolBadge} tabIndex={0} aria-label="Agent Relay MCP">
                  <MCP size={20} aria-hidden="true" />
                  <span className={s.actionToolTooltip} role="tooltip">
                    <strong>MCP</strong>
                    The Agent Relay MCP exposes tool calls you define via the SDK that you can define callbacks for. 
                  </span>
                </span>
                <span className={s.actionToolBadge} tabIndex={0} aria-label="Agent Relay CLI">
                  <SquareTerminal size={20} strokeWidth={1.8} aria-hidden="true" />
                  <span className={s.actionToolTooltip} role="tooltip">
                    <strong>CLI</strong>
                    The Agent Relay CLI exposes actions you define via the SDK as terminal commands the agent can use and 
                    you can define callbacks for. 
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
                    <span>  </span>
                    <span>engineer</span>
                    <span>.</span>
                    <span className={s.codeVariable}>status</span>
                    <span>.</span>
                    <span className={s.codeFunction}>becomes</span>
                    <span>(</span>
                    <span className={s.codeString}>&quot;idle&quot;</span>
                    <span>),{'\n'}</span>
                    <span>  </span>
                    <span className={s.codeKeyword}>async</span>
                    <span> () =&gt;{'\n'}</span>
                    <span>    </span>
                    <span>relay</span>
                    <span>.</span>
                    <span className={s.codeFunction}>sendMessage</span>
                    <span>({'{'}{'\n'}</span>
                    <span>      to: </span>
                    <span>taskManager</span>
                    <span>,{'\n'}</span>
                    <span>      msg: </span>
                    <span className={s.codeString}>{'`${engineer.handle} is idle. Send the next task.`'}</span>
                    <span>,{'\n'}</span>
                    <span>    {'}'}),{'\n'}</span>
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
            Use the open-source engine in your own infrastructure, or let us run it for you with a generous free tier.
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
                <p className={s.deployCardText}>
                For teams that need complete control.
                </p>
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
                <p className={s.deployCardText}>
                For teams that just want to build.
                </p>
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

                  <div className={s.installAgentLogos} aria-label="Get started with the agents you already use">
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
                  Human or agent, sometimes it's just <i>easier</i> to start building with stuff to figure out if it's
                  useful. Fortunately, we've made that really easy for both.
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
