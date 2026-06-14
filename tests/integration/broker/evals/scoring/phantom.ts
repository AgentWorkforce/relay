/**
 * Phantom-message detection.
 *
 * A "phantom" is the failure we most want to catch: an agent stating in plain
 * text that it will communicate ("I'll tell Lead the result") without ever
 * invoking a messaging tool. Ground truth for an actual send is a
 * `relay_inbound` event whose `from` is the agent; intent lives in the agent's
 * `worker_stream` prose.
 *
 * Detection is intentionally forward-looking: only future-tense / present-
 * continuous phrasings are treated as intent, so past-tense narration ("I sent
 * the code", "told B") does not produce false positives.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

import type { Phantom } from '../types.js';
import { cleanStreamOutput } from './stream-clean.js';

export interface IntentSpan {
  verb: string;
  target?: string;
  offset: number;
  snippet: string;
}

interface IntentPattern {
  re: RegExp;
  verbGroup: number;
  targetGroup?: number;
}

/**
 * Forward-looking intent patterns. Each is global + case-insensitive. The verb
 * group identifies the communication action; the optional target group captures
 * who/what the agent said it would contact.
 */
const INTENT_PATTERNS: IntentPattern[] = [
  // "I'll / I will / I'm going to / going to / let me / I can" + comm verb + optional target
  {
    re: /\b(?:i'?ll|i will|i'?m going to|going to|let me|i can|i should)\s+(tell|message|dm|notify|reply to|respond to|post|send|report(?:\s+to)?|relay(?:\s+to)?|forward(?:\s+to)?|ping|update|let)\s+(?:to\s+|the\s+)?([a-z0-9_#-]+)?/gi,
    verbGroup: 1,
    targetGroup: 2,
  },
  // present-continuous narration: "sending / posting / messaging X"
  {
    re: /\b(sending|posting|messaging|replying to|responding to|notifying|reporting to|relaying to|forwarding to|pinging|dming)\s+(?:to\s+|the\s+)?([a-z0-9_#-]+)?/gi,
    verbGroup: 1,
    targetGroup: 2,
  },
];

/** Negations immediately before a comm verb that cancel the intent. */
const NEGATION_BEFORE =
  /\b(?:without|not|never|don'?t|do not|didn'?t|avoid|instead of|rather than|no need to)\s*$/i;

/** Words that follow a comm verb but are not real targets (filtered out). */
const TARGET_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'you',
  'them',
  'it',
  'back',
  'now',
  'them',
  'everyone',
  'and',
  'with',
  'about',
  'my',
  'our',
  'using',
  'via',
  'to',
]);

function normalizeTarget(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/^[#@]/, '').trim().toLowerCase();
  if (!t || TARGET_STOPWORDS.has(t)) return undefined;
  return t;
}

/** Extract forward-looking intent spans from an agent's cleaned output. */
export function detectIntents(cleanText: string): IntentSpan[] {
  const spans: IntentSpan[] = [];
  for (const { re, verbGroup, targetGroup } of INTENT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleanText)) !== null) {
      // Skip negated phrasings ("without sending", "don't post").
      if (NEGATION_BEFORE.test(cleanText.slice(Math.max(0, m.index - 16), m.index))) continue;
      const verb = m[verbGroup]?.toLowerCase() ?? '';
      const target = targetGroup ? normalizeTarget(m[targetGroup]) : undefined;
      const start = Math.max(0, m.index - 10);
      const snippet = cleanText
        .slice(start, m.index + m[0].length + 30)
        .replace(/\s+/g, ' ')
        .trim();
      spans.push({ verb, target, offset: m.index, snippet });
    }
  }
  // De-duplicate near-identical matches (two patterns hitting the same phrase).
  spans.sort((a, b) => a.offset - b.offset);
  const deduped: IntentSpan[] = [];
  for (const span of spans) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.offset - span.offset) < 4) continue;
    deduped.push(span);
  }
  return deduped;
}

interface InboundSend {
  target: string;
}

function relayInboundFrom(events: BrokerEvent[], agent: string): InboundSend[] {
  return events
    .filter((e): e is Extract<BrokerEvent, { kind: 'relay_inbound' }> => e.kind === 'relay_inbound')
    .filter((e) => e.from === agent)
    .map((e) => ({ target: e.target }));
}

export interface PhantomResult {
  phantoms: Phantom[];
  totalIntents: number;
  satisfiedIntents: number;
}

/**
 * Detect phantom messages for a single agent by correlating intent spans
 * against actual sends.
 *
 * Each intent is satisfied greedily: first by an unconsumed send to the same
 * target (when the intent named one), otherwise by any unconsumed send (the
 * agent used the tool, just for something else). An intent with no satisfying
 * send is a phantom — the agent said it would message but never invoked a tool.
 */
export function detectPhantomsForAgent(events: BrokerEvent[], agent: string): PhantomResult {
  const intents = detectIntents(cleanStreamOutput(events, agent));
  const sends = relayInboundFrom(events, agent);
  const consumed = new Array<boolean>(sends.length).fill(false);
  const phantoms: Phantom[] = [];
  let satisfied = 0;

  for (const intent of intents) {
    let matchIdx = -1;
    if (intent.target) {
      matchIdx = sends.findIndex((s, i) => !consumed[i] && normalizeTarget(s.target) === intent.target);
    }
    if (matchIdx === -1) {
      matchIdx = sends.findIndex((_, i) => !consumed[i]);
    }
    if (matchIdx === -1) {
      phantoms.push({ agent, verb: intent.verb, target: intent.target, snippet: intent.snippet });
    } else {
      consumed[matchIdx] = true;
      satisfied += 1;
    }
  }

  return { phantoms, totalIntents: intents.length, satisfiedIntents: satisfied };
}

/** Aggregate phantom detection across multiple agents. */
export function detectPhantoms(events: BrokerEvent[], agents: string[]): PhantomResult {
  const all: PhantomResult = { phantoms: [], totalIntents: 0, satisfiedIntents: 0 };
  for (const agent of agents) {
    const r = detectPhantomsForAgent(events, agent);
    all.phantoms.push(...r.phantoms);
    all.totalIntents += r.totalIntents;
    all.satisfiedIntents += r.satisfiedIntents;
  }
  return all;
}
