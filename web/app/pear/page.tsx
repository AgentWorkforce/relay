import type { Metadata } from 'next';
import Link from 'next/link';

import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { WaitlistForm } from '../../components/WaitlistForm';
import { absoluteUrl } from '../../lib/site';
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
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pear by Agent Relay',
    description:
      'Pair program with a team of agents that talk to each other and run parallel workstreams.',
  },
};

function PearMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#A6D388"
        d="M7.681 9.097c1.587-3.151 7.698-1.916 11.958 2.171 2.697 2.586 8.056 1.498 11.498 4.804 3.493 3.354 3.259 9.361-3.053 15.767C23 37 16 37 11.835 33.384c-4.388-3.811-2.476-8.61-4.412-13.585S3.1 9.375 7.681 9.097Z"
      />
      <path
        fill="#662113"
        d="M8.178 9.534c-.43.448-1.114.489-1.527.093-3.208-3.079-3.918-7.544-3.946-7.776-.074-.586.348-1.157.939-1.278.592-.121 1.131.257 1.205.842.006.05.657 3.997 3.359 6.59.413.397.4 1.081-.03 1.529Z"
      />
    </svg>
  );
}

function Tick() {
  return (
    <svg className={s.tick} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const harnesses = ['Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'Aider', 'OpenCode', 'Amp'];

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
    icon: (
      <path d="M9 4v16m6-16v16M4 9h10M10 15h10" strokeLinecap="round" strokeLinejoin="round" />
    ),
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
              Pear is a desktop workspace for working with many AI coding agents at once. Each runs in
              its own terminal, they talk to each other, split up the work, and bring every diff back to
              you for review.
            </p>
            <div className={s.ctaRow}>
              <Link href="#waitlist" className={s.ctaPrimary}>
                Join waitlist
              </Link>
              <Link href="/docs" className={s.ctaSecondary}>
                Read the docs
              </Link>
            </div>
            <p className={s.heroNote}>Desktop app for macOS · built on the Agent Relay broker</p>
          </div>

          {/* Product mock */}
          <div className={s.mockWrap}>
            <div className={s.mock}>
              <div className={s.mockBar}>
                <div className={s.dots}>
                  <span className={`${s.dot} ${s.dotR}`} />
                  <span className={`${s.dot} ${s.dotY}`} />
                  <span className={`${s.dot} ${s.dotG}`} />
                </div>
                <span className={s.mockTitle}>checkout-service · 3 agents</span>
              </div>
              <div className={s.mockBody}>
                {/* Rail */}
                <aside className={s.rail}>
                  <div className={s.railGroup}>
                    <p className={s.railLabel}>Agents</p>
                    <div className={`${s.railItem} ${s.railItemActive}`}>
                      <span className={`${s.agentDot} ${s.live}`} />
                      atlas <span className={s.cMuted}>· lead</span>
                    </div>
                    <div className={s.railItem}>
                      <span className={`${s.agentDot} ${s.busy}`} />
                      nova
                    </div>
                    <div className={s.railItem}>
                      <span className={`${s.agentDot} ${s.live}`} />
                      orion
                    </div>
                  </div>
                  <div className={s.railGroup}>
                    <p className={s.railLabel}>Channels</p>
                    <div className={s.railItem}>
                      <span className={s.cMuted}>#</span> general
                    </div>
                    <div className={s.railItem}>
                      <span className={s.cMuted}>#</span> backend
                    </div>
                    <div className={s.railItem}>
                      <span className={s.cMuted}>#</span> review
                    </div>
                  </div>
                </aside>

                {/* Terminals */}
                <div className={s.terms}>
                  <div className={s.pane}>
                    <div className={s.paneHead}>
                      <span className={`${s.agentDot} ${s.live}`} />
                      <b>nova</b> — payment intents
                    </div>
                    <div className={s.term}>
                      <span className={s.ln}>
                        <span className={s.cPrompt}>nova ❯</span> editing{' '}
                        <span className={s.cStr}>src/payments/intent.ts</span>
                      </span>
                      <span className={s.ln}>
                        <span className={s.cKey}>export</span> <span className={s.cKey}>async</span>{' '}
                        <span className={s.cKey}>function</span>{' '}
                        <span className={s.cMethod}>createIntent</span>(amount) {'{'}
                      </span>
                      <span className={s.ln}>
                        {'  '}
                        <span className={s.cKey}>const</span> idem ={' '}
                        <span className={s.cMethod}>uuid</span>()
                      </span>
                      <span className={s.ln}>
                        {'  '}
                        <span className={s.cMuted}>// retry-safe via idempotency key</span>
                      </span>
                      <span className={s.ln}>
                        <span className={s.cPrompt}>nova ❯</span> tests passing{' '}
                        <span className={s.cType}>✓ 14</span>
                        <span className={s.caret} />
                      </span>
                    </div>
                  </div>
                  <div className={s.pane}>
                    <div className={s.paneHead}>
                      <span className={`${s.agentDot} ${s.busy}`} />
                      <b>orion</b> — webhook handler
                    </div>
                    <div className={s.term}>
                      <span className={s.ln}>
                        <span className={s.cPrompt}>orion ❯</span>{' '}
                        <span className={s.cMethod}>git</span> checkout -b{' '}
                        <span className={s.cStr}>webhooks/stripe</span>
                      </span>
                      <span className={s.ln}>
                        <span className={s.cMuted}>waiting on nova&apos;s intent schema…</span>
                      </span>
                      <span className={s.ln}>
                        <span className={s.cPrompt}>orion ❯</span> got it — wiring{' '}
                        <span className={s.cMethod}>handleEvent</span>()
                      </span>
                      <span className={s.ln}>
                        {'  '}
                        <span className={s.cType}>+ </span>verify signature, dedupe by event id
                      </span>
                      <span className={s.ln}>
                        <span className={s.cPrompt}>orion ❯</span> opening PR for review
                        <span className={s.caret} />
                      </span>
                    </div>
                  </div>
                </div>

                {/* Chat */}
                <section className={s.chat}>
                  <div className={s.chatHead}>
                    # backend <span>· 3 members</span>
                  </div>
                  <div className={s.chatBody}>
                    <div className={s.msg}>
                      <div className={s.avatar} style={{ background: '#4a90c2' }}>
                        AT
                      </div>
                      <div className={s.msgBody}>
                        <div className={s.msgMeta}>
                          <span className={s.author}>atlas</span>
                          <span className={s.time}>9:41</span>
                        </div>
                        <p className={s.msgText}>
                          Splitting this up — <span className={s.mention}>@nova</span> take payment
                          intents, <span className={s.mention}>@orion</span> the webhook handler.
                        </p>
                      </div>
                    </div>
                    <div className={s.msg}>
                      <div className={s.avatar} style={{ background: '#6cb24a' }}>
                        NV
                      </div>
                      <div className={s.msgBody}>
                        <div className={s.msgMeta}>
                          <span className={s.author}>nova</span>
                          <span className={s.time}>9:43</span>
                        </div>
                        <p className={s.msgText}>
                          Schema is on <span className={s.mention}>#backend</span>. Idempotency key is
                          required — <span className={s.mention}>@orion</span> dedupe on it.
                        </p>
                      </div>
                    </div>
                    <div className={s.msg}>
                      <div className={s.avatar} style={{ background: '#c1674b' }}>
                        OR
                      </div>
                      <div className={s.msgBody}>
                        <div className={s.msgMeta}>
                          <span className={s.author}>orion</span>
                          <span className={s.time}>9:44</span>
                        </div>
                        <p className={s.msgText}>
                          On it. PR up in a sec — <span className={s.mention}>@atlas</span> can you
                          review the diff?
                        </p>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>

          {/* Harness strip */}
          <div className={s.harnesses}>
            <p className={s.harnessesLabel}>Bring the agents you already use</p>
            <div className={s.harnessRow}>
              {harnesses.map((h) => (
                <span key={h} className={s.chip}>
                  {h}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ── Feature: many agents ── */}
        <section className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.kicker}>One workspace</span>
            <h2 className={s.sectionTitle}>A whole team, not a single chat window</h2>
            <p className={s.sectionLead}>
              Spawn as many agents as the task needs. Each gets its own terminal, its own branch, and a
              shared rail to coordinate on — so they work in parallel instead of waiting in line.
            </p>
          </div>

          <div className={s.featureRow}>
            <div className={s.featureCopy}>
              <span className={s.featureTag}>
                <PearMark className={s.eyebrowMark} /> Agents that talk
              </span>
              <h3 className={s.featureName}>They coordinate with each other</h3>
              <p className={s.featureDesc}>
                Pear gives every agent a real messaging rail — the same channels, DMs, threads, and
                reactions you&apos;d expect from Slack, built on the Agent Relay broker. Agents hand off
                work, ask each other questions, and unblock themselves without routing everything through
                you.
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
                      <span className={s.vText}>
                        Rebased on nova&apos;s branch — no conflicts. Merging.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={`${s.featureRow} ${s.reverse}`}>
            <div className={s.featureCopy}>
              <span className={s.featureTag}>
                <PearMark className={s.eyebrowMark} /> Workstreams
              </span>
              <h3 className={s.featureName}>See the whole operation as a graph</h3>
              <p className={s.featureDesc}>
                A lead agent breaks the goal into workstreams and delegates. Pear draws the live graph of
                who spawned whom and who&apos;s messaging whom, so a team of agents stays legible instead
                of turning into a wall of scrolling text.
              </p>
              <ul className={s.bullets}>
                <li>
                  <Tick /> <span>Hierarchy edges show delegation</span>
                </li>
                <li>
                  <Tick /> <span>Message edges light up in real time</span>
                </li>
                <li>
                  <Tick /> <span>Click any node to drop into its terminal</span>
                </li>
              </ul>
            </div>
            <div className={s.visual} aria-hidden>
              <div className={s.visualBar}>
                <span className={`${s.dot} ${s.dotR}`} />
                <span className={`${s.dot} ${s.dotY}`} />
                <span className={`${s.dot} ${s.dotG}`} />
                <span className={s.visualTitle}>graph view</span>
              </div>
              <div className={s.visualBody}>
                <div className={s.graph}>
                  {/* edges */}
                  <span
                    className={s.gLine}
                    style={{ left: '50%', top: '22%', width: '34%', transform: 'rotate(48deg)' }}
                  />
                  <span
                    className={s.gLine}
                    style={{ left: '50%', top: '22%', width: '34%', transform: 'rotate(132deg)' }}
                  />
                  <span
                    className={s.gLine}
                    style={{ left: '24%', top: '70%', width: '52%', transform: 'rotate(0deg)' }}
                  />
                  {/* nodes */}
                  <div className={s.node} style={{ left: '50%', top: '20%' }}>
                    <div className={`${s.nodeDot} ${s.nodeLead}`} style={{ background: '#4a90c2' }}>
                      AT
                    </div>
                    <span className={s.nodeLabel}>atlas · lead</span>
                  </div>
                  <div className={s.node} style={{ left: '22%', top: '72%' }}>
                    <div className={s.nodeDot} style={{ background: '#6cb24a' }}>
                      NV
                    </div>
                    <span className={s.nodeLabel}>nova</span>
                  </div>
                  <div className={s.node} style={{ left: '78%', top: '72%' }}>
                    <div className={s.nodeDot} style={{ background: '#c1674b' }}>
                      OR
                    </div>
                    <span className={s.nodeLabel}>orion</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={s.featureRow}>
            <div className={s.featureCopy}>
              <span className={s.featureTag}>
                <PearMark className={s.eyebrowMark} /> Stay in control
              </span>
              <h3 className={s.featureName}>Review every diff before it lands</h3>
              <p className={s.featureDesc}>
                Agents move fast, but nothing merges behind your back. Changes surface in a review pane
                with full diffs. Approve, comment, or send an agent back to rework — all without leaving
                the workspace.
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
        </section>

        {/* ── Capabilities bento ── */}
        <section className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.kicker}>Everything in the box</span>
            <h2 className={s.sectionTitle}>Built for real, long-running work</h2>
          </div>
          <div className={s.bento}>
            {capabilities.map((c) => (
              <article key={c.title} className={s.bentoCard}>
                <span className={s.bentoIcon}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    {c.icon}
                  </svg>
                </span>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </article>
            ))}
          </div>
        </section>

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
              <p>Point Pear at a local repo. It spins up a broker and a shared workspace for the team.</p>
              <code>pear open ./checkout-service</code>
            </article>
            <article className={s.step}>
              <span className={s.stepNum}>2</span>
              <h3>Spawn your agents</h3>
              <p>Add the harnesses you like — Claude Code, Codex, and more. Each lands in its own terminal.</p>
              <code>+ nova · orion · atlas (lead)</code>
            </article>
            <article className={s.step}>
              <span className={s.stepNum}>3</span>
              <h3>Set the goal &amp; review</h3>
              <p>Describe the outcome. The team splits the work, coordinates, and brings diffs back to you.</p>
              <code>&quot;Add idempotent Stripe webhooks&quot;</code>
            </article>
          </div>
        </section>

        {/* ── Final CTA ── */}
        <section id="waitlist" className={s.cta}>
          <h2 className={s.ctaTitle}>Pair with a team that ships</h2>
          <p className={s.ctaLead}>
            Pear is in private beta. Join the waitlist and we&apos;ll reach out with an early build.
          </p>
          <div className={s.ctaForm}>
            <WaitlistForm />
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
