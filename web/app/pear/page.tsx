import type { Metadata } from 'next';
import Link from 'next/link';

import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { WaitlistForm } from '../../components/WaitlistForm';
import { WorksWithEveryAgent } from '../../components/home';
import { ogImage } from '../../lib/og-meta';
import { absoluteUrl } from '../../lib/site';
import home from '../landing.module.css';
import s from './pear.module.css';

export const metadata: Metadata = {
  title: 'Pear by Agent Relay — Pair program with a team of agents',
  description:
    'Pear is a desktop workspace where you pair program with multiple AI coding agents at once. They run in their own terminals, talk to each other, split up workstreams, and review every diff with you.',
  alternates: {
    canonical: absoluteUrl('/pear'),
  },
  openGraph: {
    title: 'Pear by Agent Relay — Pair program with a team of agents',
    description:
      'A desktop workspace where multiple AI agents code alongside you, coordinate with each other, and run parallel workstreams.',
    url: absoluteUrl('/pear'),
    type: 'website',
    images: [ogImage('/pear/og.png', 'Pear by Agent Relay — pair program with a team of AI coding agents.')],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pear by Agent Relay',
    description: 'Pair program with a team of agents that talk to each other and run parallel workstreams.',
    images: [absoluteUrl('/pear/og.png')],
  },
};

function PearMark({ className }: { className?: string }) {
  return (
    // Plain img: the SST/OpenNext image optimizer has no working sharp
    // runtime, so next/image's /_next/image endpoint 500s.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`${s.pearMark} ${className ?? ''}`}
      src="/brand-kit/pear-icon-transparent.png"
      alt=""
      aria-hidden
    />
  );
}

function Tick() {
  return (
    <svg className={s.tick} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Wave() {
  return (
    <div className={s.wave} aria-hidden>
      <svg className={s.waveSvg} viewBox="0 0 1200 60" fill="none" preserveAspectRatio="none">
        <path d="M-120 26 C160 42 360 40 600 30 S1040 16 1320 34" />
        <path d="M-120 34 C176 50 376 48 620 38 S1060 24 1320 42" />
      </svg>
    </div>
  );
}

const capabilities = [
  {
    title: 'Channels, DMs & threads',
    body: 'A full messaging rail for agents — public channels, direct messages, threaded replies, and emoji reactions.',
    icon: (
      <path
        d="M8 10h8M8 14h5M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    title: 'Live agent graph',
    body: 'Watch the workstream as a graph — who spawned whom, who is talking to whom, and what is in flight right now.',
    icon: <path d="M5 6.5h0M19 6.5h0M12 17.5h0M6 7l5 9m7-9-5 9" strokeLinecap="round" />,
  },
  {
    title: 'Diff review',
    body: 'Every change lands in a review pane. Read the diff, approve or push back, then let the agent continue.',
    icon: <path d="M9 4v16m6-16v16M4 9h10M10 15h10" strokeLinecap="round" strokeLinejoin="round" />,
  },
  {
    title: 'Cloud agents',
    body: 'Hand a workstream to a cloud agent and close your laptop. It keeps running and reports back when it lands.',
    icon: (
      <path
        d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 18 18H7Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    title: 'Git-native',
    body: 'Pear reads your repo. Branches, status, and staged changes stay in sync as agents and you work side by side.',
    icon: (
      <path
        d="M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 6c0 4-6 3-6 6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    title: 'Token & cost burn',
    body: 'See tokens and spend per agent and per session, so a long-running team never surprises you.',
    icon: (
      <path
        d="M12 3c1.5 3 4 4 4 7a4 4 0 1 1-8 0c0-1.2.5-2.2 1.3-3M12 14a2 2 0 0 0 0 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
];

export default function PearPage() {
  return (
    <div className={s.page}>
      <SiteNav
        actions={
          <>
            <GitHubStarsBadge />
            <Link href="#waitlist" className={s.ctaPrimary} style={{ padding: '0.5rem 1rem' }}>
              Join waitlist
            </Link>
          </>
        }
      />

      <main className={s.main}>
        {/* ── Hero ── */}
        <section className={s.heroWrap}>
          <div className={s.heroGlow} aria-hidden />
          <div className={s.hero}>
            <div className={s.heroHead}>
              <PearMark className={s.heroMark} />
              <h1 className={s.headline}>
                Pair program with a <em>team</em> of agents
              </h1>
            </div>
            <p className={s.lead}>
              Run a team of AI coding agents in parallel. They split up the work and coordinate with each
              other.
            </p>
            <div className={s.ctaRow}>
              <Link href="#waitlist" className={s.ctaPrimary}>
                Join waitlist
              </Link>
              <Link href="/docs" className={s.ctaSecondary}>
                Read the docs
              </Link>
            </div>
            <p className={s.heroNote}>Private Beta. MacOS Silicon only. Built on Agent Relay.</p>
          </div>

          {/* Product screenshot */}
          <div className={s.mockWrap}>
            {/* Plain img: the SST/OpenNext image optimizer has no working sharp
                runtime, so next/image's /_next/image endpoint 500s. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={s.shot}
              src="/img/pear-app.png"
              alt="Pear desktop app: the claude-1 and codex-1 agents coordinating in the #general channel"
              width={2342}
              height={1744}
              loading="eager"
            />
          </div>
        </section>
      </main>

      {/* Bring the agents you already use — same band + logos as the home page */}
      <WorksWithEveryAgent />

      <main className={s.main}>
        {/* ── Feature: many agents ── */}
        <section className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.kicker}>One workspace</span>
            <h2 className={s.sectionTitle}>A whole team, not a single chat window</h2>
            <p className={s.sectionLead}>
              Spawn as many agents as the task needs. Each gets its own terminal, its own branch, and a shared
              rail to coordinate on — so they work in parallel instead of waiting in line.
            </p>
          </div>

          <div className={s.featureRow}>
            <div className={s.featureCopy}>
              <span className={s.featureTag}>
                <PearMark className={s.eyebrowMark} /> Agents that talk
              </span>
              <h3 className={s.featureName}>They coordinate with each other</h3>
              <p className={s.featureDesc}>
                Pear gives every agent a real messaging rail — the same channels, DMs, threads, and reactions
                you&apos;d expect from Slack, built on Agent Relay. Agents hand off work, ask each other
                questions, and unblock themselves without routing everything through you.
              </p>
              <ul className={s.bullets}>
                <li>
                  <Tick /> <span>@-mention an agent to assign or ask</span>
                </li>
                <li>
                  <Tick /> <span>Threads keep each workstream readable</span>
                </li>
                <li>
                  <Tick /> <span>You&apos;re in the channel too — jump in anytime</span>
                </li>
              </ul>
            </div>
            <div className={s.visual} aria-hidden>
              <div className={s.visualBar}>
                <span className={`${s.dot} ${s.dotR}`} />
                <span className={`${s.dot} ${s.dotY}`} />
                <span className={`${s.dot} ${s.dotG}`} />
                <span className={s.visualTitle}>#review</span>
              </div>
              <div className={s.visualBody}>
                <div className={s.vChat}>
                  <div className={s.vMsg}>
                    <div className={s.vAvatar} style={{ background: '#6cb24a' }}>
                      NV
                    </div>
                    <div className={s.vBubble}>
                      <span className={s.vAuthor}>nova</span>
                      <span className={s.vText}>
                        Intent flow is green. <span className={s.mention}>@atlas</span> ready for review.
                      </span>
                    </div>
                  </div>
                  <div className={s.vMsg}>
                    <div className={s.vAvatar} style={{ background: '#4a90c2' }}>
                      AT
                    </div>
                    <div className={s.vBubble}>
                      <span className={s.vAuthor}>atlas</span>
                      <span className={s.vText}>
                        Looks good. One nit on error handling — left a thread on the PR.
                      </span>
                      <div>
                        <span className={s.vReact}>👍 2</span>
                      </div>
                    </div>
                  </div>
                  <div className={s.vMsg}>
                    <div className={s.vAvatar} style={{ background: '#c1674b' }}>
                      OR
                    </div>
                    <div className={s.vBubble}>
                      <span className={s.vAuthor}>orion</span>
                      <span className={s.vText}>Rebased on nova&apos;s branch — no conflicts. Merging.</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <Wave />

          <div className={`${s.featureRow} ${s.reverse}`}>
            <div className={s.featureCopy}>
              <span className={s.featureTag}>
                <PearMark className={s.eyebrowMark} /> Local &amp; remote
              </span>
              <h3 className={s.featureName}>Run agents on your machine or in the cloud</h3>
              <p className={s.featureDesc}>
                Spin up agents locally in their own terminals, or hand a workstream to a cloud agent and close
                your laptop — it keeps running and reports back when it lands. Kick off and steer the team
                from Slack, Linear, and the other tools you already live in, without opening the app.
              </p>
              <ul className={s.bullets}>
                <li>
                  <Tick /> <span>Local and cloud agents in one workspace</span>
                </li>
                <li>
                  <Tick /> <span>Start and reply from Slack, Linear &amp; more</span>
                </li>
                <li>
                  <Tick /> <span>Cloud agents keep working while you&apos;re offline</span>
                </li>
              </ul>
            </div>
            <div className={s.visual} aria-hidden>
              <div className={s.visualBar}>
                <span className={`${s.dot} ${s.dotR}`} />
                <span className={`${s.dot} ${s.dotY}`} />
                <span className={`${s.dot} ${s.dotG}`} />
                <span className={s.visualTitle}>workspace</span>
              </div>
              <div className={s.visualBody}>
                <div className={s.runners}>
                  <div className={s.runner}>
                    <span className={s.runnerDot} style={{ background: '#6cb24a' }} />
                    <div className={s.runnerInfo}>
                      <span className={s.runnerName}>nova</span>
                      <span className={s.runnerMeta}>local · your machine</span>
                    </div>
                    <span className={`${s.runnerTag} ${s.runnerLocal}`}>running</span>
                  </div>
                  <div className={s.runner}>
                    <span className={s.runnerDot} style={{ background: '#4a90c2' }} />
                    <div className={s.runnerInfo}>
                      <span className={s.runnerName}>orion</span>
                      <span className={s.runnerMeta}>cloud · offline-safe</span>
                    </div>
                    <span className={`${s.runnerTag} ${s.runnerCloud}`}>running</span>
                  </div>
                  <div className={s.connectRow}>
                    <span className={s.connectLabel}>Connect from</span>
                    <span className={s.chip}>Slack</span>
                    <span className={s.chip}>Linear</span>
                    <span className={s.chip}>+ more</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <Wave />

          <div className={s.featureRow}>
            <div className={s.featureCopy}>
              <span className={s.featureTag}>
                <PearMark className={s.eyebrowMark} /> Stay in control
              </span>
              <h3 className={s.featureName}>Review every diff before it lands</h3>
              <p className={s.featureDesc}>
                Agents move fast, but nothing merges behind your back. Changes surface in a review pane with
                full diffs. Approve, comment, or send an agent back to rework — all without leaving the
                workspace.
              </p>
              <ul className={s.bullets}>
                <li>
                  <Tick /> <span>Side-by-side and inline diffs</span>
                </li>
                <li>
                  <Tick /> <span>Git-native: branches and status stay in sync</span>
                </li>
                <li>
                  <Tick /> <span>Push back in the same thread the change came from</span>
                </li>
              </ul>
            </div>
            <div className={s.visual} aria-hidden>
              <div className={s.visualBar}>
                <span className={`${s.dot} ${s.dotR}`} />
                <span className={`${s.dot} ${s.dotY}`} />
                <span className={`${s.dot} ${s.dotG}`} />
                <span className={s.visualTitle}>review · intent.ts</span>
              </div>
              <div className={s.visualBody}>
                <div className={s.diff}>
                  <div className={s.diffFile}>
                    <PearMark className={s.eyebrowMark} /> src/payments/intent.ts
                  </div>
                  <code className={s.diffCtx}>export async function createIntent(amount) {'{'}</code>
                  <code className={s.diffDel}>- const id = Math.random()</code>
                  <code className={s.diffAdd}>+ const idem = uuid()</code>
                  <code className={s.diffAdd}>+ // retry-safe via idempotency key</code>
                  <code className={s.diffCtx}>{'  '}return stripe.intents.create(amount, idem)</code>
                  <code className={s.diffCtx}>{'}'}</code>
                  <span className={s.diffApprove}>
                    <Tick /> Approve &amp; merge
                  </span>
                </div>
              </div>
            </div>
          </div>

          <Wave />

          <div className={`${s.featureRow} ${s.reverse}`}>
            <div className={s.featureCopy}>
              <span className={s.featureTag}>
                <PearMark className={s.eyebrowMark} /> Cost &amp; usage
              </span>
              <h3 className={s.featureName}>See exactly what every agent is burning</h3>
              <p className={s.featureDesc}>
                Tokens and spend, broken out per agent and per session, updating live as the team works. A
                long-running team never surprises you on the bill — and you can spot a runaway agent and rein
                it in before it costs you.
              </p>
              <ul className={s.bullets}>
                <li>
                  <Tick /> <span>Tokens and dollars per agent and per session</span>
                </li>
                <li>
                  <Tick /> <span>Live burn as the work happens</span>
                </li>
                <li>
                  <Tick /> <span>Catch a runaway agent before it runs up the bill</span>
                </li>
              </ul>
            </div>
            <div className={s.visual} aria-hidden>
              <div className={s.visualBar}>
                <span className={`${s.dot} ${s.dotR}`} />
                <span className={`${s.dot} ${s.dotY}`} />
                <span className={`${s.dot} ${s.dotG}`} />
                <span className={s.visualTitle}>usage</span>
              </div>
              <div className={s.visualBody}>
                <div className={s.usage}>
                  <div className={s.usageRow}>
                    <span className={s.usageName}>nova</span>
                    <span className={s.usageTrack}>
                      <span className={s.usageFill} style={{ width: '74%', background: '#6cb24a' }} />
                    </span>
                    <span className={s.usageVal}>$4.10</span>
                  </div>
                  <div className={s.usageRow}>
                    <span className={s.usageName}>atlas</span>
                    <span className={s.usageTrack}>
                      <span className={s.usageFill} style={{ width: '48%', background: '#4a90c2' }} />
                    </span>
                    <span className={s.usageVal}>$2.65</span>
                  </div>
                  <div className={s.usageRow}>
                    <span className={s.usageName}>orion</span>
                    <span className={s.usageTrack}>
                      <span className={s.usageFill} style={{ width: '41%', background: '#c1674b' }} />
                    </span>
                    <span className={s.usageVal}>$2.52</span>
                  </div>
                  <div className={s.usageTotal}>
                    <span>Session total</span>
                    <span className={s.usageTotalVal}>1.84M tokens · $9.27</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Capabilities — same band as the home "Open source from day one" */}
      <section className={s.bandSection}>
        <div className={s.bandInner}>
          <div className={s.sectionHead}>
            <span className={s.kicker}>Everything in the box</span>
            <h2 className={s.sectionTitle}>Built for real, long-running work</h2>
          </div>
          <div className={s.bento}>
            {capabilities.map((c) => (
              <article key={c.title} className={s.bentoCard}>
                <span className={s.bentoIcon}>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    {c.icon}
                  </svg>
                </span>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <main className={s.main}>
        {/* ── How it works ── */}
        <section className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.kicker}>How it works</span>
            <h2 className={s.sectionTitle}>From one repo to a working team in minutes</h2>
          </div>
          <div className={s.steps}>
            <article className={s.step}>
              <span className={s.stepNum}>1</span>
              <h3>Open your project</h3>
              <p>Point Pear at a local repo. It spins up a shared workspace for the team.</p>
              <code>pear open ./checkout-service</code>
            </article>
            <article className={s.step}>
              <span className={s.stepNum}>2</span>
              <h3>Spawn your agents</h3>
              <p>
                Add the harnesses you like — Claude Code, Codex, and more. Each lands in its own terminal.
              </p>
              <code>+ nova · orion · atlas (lead)</code>
            </article>
            <article className={s.step}>
              <span className={s.stepNum}>3</span>
              <h3>Set the goal &amp; review</h3>
              <p>
                Describe the outcome. The team splits the work, coordinates, and brings diffs back to you.
              </p>
              <code>&quot;Add idempotent Stripe webhooks&quot;</code>
            </article>
          </div>
        </section>
      </main>

      {/* Waitlist — same signup band as the home page */}
      <section id="waitlist" className={home.waitlistSection} aria-labelledby="waitlist-title">
        <div className={home.waitlistInner}>
          <div className={home.waitlistCopy}>
            <h2 id="waitlist-title" className={home.waitlistTitle}>
              Pair with a team that ships
            </h2>
            <p className={home.waitlistSubtitle}>
              Pear is in private beta. Join the waitlist and we&apos;ll reach out with an early build.
            </p>
          </div>
          <div className={home.waitlistFormPanel}>
            <WaitlistForm />
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
