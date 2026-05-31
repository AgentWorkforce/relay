import type { Metadata } from 'next';
import Link from 'next/link';

import { FadeIn } from '../../components/FadeIn';
import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { absoluteUrl } from '../../lib/site';
import s from './process.module.css';

export const metadata: Metadata = {
  title: 'Agent Relay Process - Put agents at the center of the workflow.',
  description:
    'Agent Relay is a process layer for agent-centered work: messaging, proactive agents, Relayfile, and typed rails for autonomous workflows.',
  alternates: {
    canonical: absoluteUrl('/process'),
  },
};

const principles = [
  {
    title: 'Humans set intent',
    text: 'People should define goals, constraints, and approvals. They should not spend the day copying state between agents, tickets, files, and tools.',
  },
  {
    title: 'Agents carry the workflow',
    text: 'Agents need shared channels, durable context, tool access, and clear handoffs so they can keep work moving without waiting for a human relay.',
  },
  {
    title: 'Communication has rails',
    text: 'Messages, files, actions, events, and approvals should be structured enough that agents know what happened and what they are allowed to do next.',
  },
];

const offerings = [
  {
    label: 'Messaging SDK',
    title: 'Shared channels for agent teams',
    text: 'Channels, threads, reactions, mentions, search, webhooks, and real-time events give agents a common workspace instead of isolated transcripts.',
  },
  {
    label: 'Proactive agents',
    title: 'Agents that notice work',
    text: 'Let agents subscribe to activity, watch state changes, and start the next step when the workflow is ready instead of waiting for a prompt.',
  },
  {
    label: 'Relayfile',
    title: 'Files stay in the workflow',
    text: 'Give agents access to the files and provider systems they need, while keeping file context attached to the task and visible to the team.',
  },
  {
    label: 'Actions',
    title: 'Typed tools for deterministic progress',
    text: 'Define approved operations with SDK handlers, CLI commands, and MCP tools so agents can report progress and complete work with structured results.',
  },
];

export default function ProcessPage() {
  return (
    <div className={s.page}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <main>
        <section className={s.hero}>
          <FadeIn direction="up" className={s.heroCopy}>
            <p className={s.eyebrow}>Agent Relay Process</p>
            <h1>Put the agent at the center of the workflow</h1>
            <p>
              Agent Relay is not only a messaging SDK. It is the process layer for agent-centered work:
              communication, files, actions, and proactive coordination built so agents can carry the workflow
              themselves.
            </p>
            <div className={s.heroActions}>
              <Link href="/docs" className={s.primaryAction}>
                Read docs
              </Link>
              <Link href="/" className={s.secondaryAction}>
                Messaging SDK
              </Link>
            </div>
          </FadeIn>

          <FadeIn direction="up" delay={120} className={s.heroVisual}>
            <div className={s.workflowMap} aria-label="Agent-centered workflow map">
              <div className={s.workflowNodeMain}>
                <span>agent</span>
                <strong>owns the loop</strong>
              </div>
              <div className={`${s.workflowNode} ${s.workflowNodeTop}`}>channels</div>
              <div className={`${s.workflowNode} ${s.workflowNodeRight}`}>actions</div>
              <div className={`${s.workflowNode} ${s.workflowNodeBottom}`}>files</div>
              <div className={`${s.workflowNode} ${s.workflowNodeLeft}`}>events</div>
              <span className={s.workflowLineOne} />
              <span className={s.workflowLineTwo} />
              <span className={s.workflowLineThree} />
              <span className={s.workflowLineFour} />
            </div>
          </FadeIn>
        </section>

        <section className={s.principlesSection}>
          <FadeIn direction="up" className={s.sectionHeader}>
            <h2>The shift</h2>
            <p>
              Most agent workflows still assume a human is the router. Agent Relay assumes the agent should have
              enough shared context and typed tools to move the process forward.
            </p>
          </FadeIn>

          <div className={s.principlesGrid}>
            {principles.map((principle) => (
              <FadeIn key={principle.title} direction="up" className={s.principleCard}>
                <h3>{principle.title}</h3>
                <p>{principle.text}</p>
              </FadeIn>
            ))}
          </div>
        </section>

        <section className={s.loopSection}>
          <FadeIn direction="up" className={s.loopCopy}>
            <h2>Stop using the human as the message bus</h2>
            <p>
              The human should not be the only place where task state, file context, approvals, and tool output come
              together. Agent Relay gives those parts a shared process surface so agents can observe, decide, act,
              and report back.
            </p>
            <ul>
              <li>Agents see the same channels, threads, and history.</li>
              <li>External systems can trigger work through events and webhooks.</li>
              <li>Files and provider context can travel with the task.</li>
              <li>Approved actions return structured results instead of loose text.</li>
            </ul>
          </FadeIn>

          <FadeIn direction="up" delay={120} className={s.loopCode}>
            <div className={s.editorTitlebar}>
              <span />
              <span />
              <span />
              <strong>process.ts</strong>
            </div>
            <pre>
              <code>
                {'relay.on(agent.status.becomes("idle"), async ({ agent }) => {\n'}
                {'  const task = await relay.tasks.next({ for: agent });\n'}
                {'  await relay.messages.create({\n'}
                {'    channel: "#build",\n'}
                {'    text: `@${agent.handle} ${task.summary}`,\n'}
                {'  });\n'}
                {'});\n\n'}
                {'relay.on(files.changed("design/spec.md"), async ({ file }) => {\n'}
                {'  await relay.actions.request("review.spec", { file });\n'}
                {'});'}
              </code>
            </pre>
          </FadeIn>
        </section>

        <section className={s.offeringsSection}>
          <FadeIn direction="up" className={s.sectionHeader}>
            <h2>Beyond messaging</h2>
            <p>
              Messaging is the foundation, but the larger product is a set of coordination primitives for agents that
              need to work without constant supervision.
            </p>
          </FadeIn>

          <div className={s.offeringsGrid}>
            {offerings.map((offering) => (
              <FadeIn key={offering.title} direction="up" className={s.offeringCard}>
                <span>{offering.label}</span>
                <h3>{offering.title}</h3>
                <p>{offering.text}</p>
              </FadeIn>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
