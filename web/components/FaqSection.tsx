'use client';

import { useState } from 'react';
import s from '../app/landing.module.css';

const faqs = [
  {
    q: 'How does Agent Relay work?',
    a: "Agent Relay isn't a framework or a harness. It's a communication layer. Your agents keep running however they already run. Relay just gives them channels, messages, threads, and presence so they can talk to each other and coordinate work in real-time.",
  },
  {
    q: 'How is this different than subagents?',
    a: "Subagents are locked to a single harness and share its context window. With Agent Relay, agents can run on different harnesses entirely. Claude Code, Cursor, custom scripts, whatever. You get direct control over how agents are spawned, how they communicate, and when they're released.",
  },
  {
    q: 'How much does this cost?',
    a: 'Agent Relay is open source under the Apache 2.0 license. Self-host the broker for free, or use our managed cloud when you want zero ops.',
  },
  {
    q: 'Can I use my own AI subscription with Agent Relay?',
    a: "Yes. Because we aren't a custom harness, you bring whatever agents you already have. Claude, GPT, Gemini, open-source models, or a mix. Agent Relay doesn't care what's behind the agent, it just moves the messages.",
  },
  {
    q: 'What can I build with Agent Relay?',
    a: "There's a CLI for quick experiments and an SDK for deeper integration. Snap it into your existing product or workflows. You don't need to adopt a whole new system. Multi-agent pipelines, review bots, autonomous teams, whatever fits your use case.",
  },
  {
    q: "Why can't I just vibe code this myself?",
    a: "You absolutely can. But once you get past the demo, you'll hit the hard parts. Agents stop sending each other messages, flake out on work mid-task, lose track of who's doing what. We've spent months solving exactly those problems so you don't have to.",
  },
];

export function FaqSection() {
  const [openFaqs, setOpenFaqs] = useState<Set<number>>(new Set([0]));

  return (
    <div className={s.faqWrapper}>
      <section className={s.faqSection}>
        <h2 className={s.faqTitle}>Frequently asked questions.</h2>
        <div className={s.faqList}>
          {faqs.map((faq, i) => (
            <div key={i} className={s.faqItem}>
              <button
                className={s.faqQuestion}
                onClick={() => setOpenFaqs(prev => {
                  const next = new Set(prev);
                  next.has(i) ? next.delete(i) : next.add(i);
                  return next;
                })}
              >
                <span className={s.faqNumber}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className={s.faqQuestionText}>{faq.q}</span>
                <span className={s.faqChevron} aria-hidden="true">
                  {openFaqs.has(i) ? '↑' : '↓'}
                </span>
              </button>
              {openFaqs.has(i) && <p className={s.faqAnswer}>{faq.a}</p>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
