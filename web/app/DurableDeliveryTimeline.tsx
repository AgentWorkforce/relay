'use client';

import { useEffect, useState } from 'react';

import { AgentToolLogo, type AgentTool } from '../components/AgentToolLogos';
import s from './landing.module.css';

type AgentTimelineItem = {
  agent: string;
  kind: 'agent';
  provider: AgentTool;
  status: 'offline' | 'online';
};

type MessageTimelineItem = {
  event: 'message.delivered' | 'message.received';
  kind: 'event';
  latency: string;
};

type TimelineTemplate = AgentTimelineItem | MessageTimelineItem;
type TimelineItem = TimelineTemplate & { id: number };

const VISIBLE_TIMELINE_ITEMS = 12;
const INITIAL_TIMELINE_CURSOR = 2;
const FIRST_CATCH_UP_COMPLETE_INDEX = 7;
const FIRST_CATCH_UP_HOLD_MS = 5200;
const CATCH_UP_HOLD_MS = 3400;
const RECEIVED_STEP_DELAYS_MS = [1900, 2600, 2200, 2800];
const DELIVERED_STEP_DELAYS_MS = [1300, 1700, 1200, 1500];
const RECOVERY_COMPLETE_SEQUENCE_INDICES = [7, 13, 24, 31, 37, 41];

const TIMELINE_SEQUENCE = [
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '24ms' },
  { agent: 'Codex', kind: 'agent', provider: 'codex', status: 'offline' },
  { event: 'message.received', kind: 'event', latency: '+1.4s' },
  { event: 'message.received', kind: 'event', latency: '+1.9s' },
  { agent: 'Codex', kind: 'agent', provider: 'codex', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '31ms' },
  { event: 'message.delivered', kind: 'event', latency: '37ms' },
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'offline' },
  { event: 'message.received', kind: 'event', latency: '+2.2s' },
  { event: 'message.received', kind: 'event', latency: '+2.7s' },
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '28ms' },
  { event: 'message.delivered', kind: 'event', latency: '43ms' },
  { agent: 'Codex', kind: 'agent', provider: 'codex', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '36ms' },
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '41ms' },
  { agent: 'Codex', kind: 'agent', provider: 'codex', status: 'offline' },
  { event: 'message.received', kind: 'event', latency: '+2.8s' },
  { event: 'message.received', kind: 'event', latency: '+3.2s' },
  { event: 'message.received', kind: 'event', latency: '+3.6s' },
  { agent: 'Codex', kind: 'agent', provider: 'codex', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '33ms' },
  { event: 'message.delivered', kind: 'event', latency: '52ms' },
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'offline' },
  { event: 'message.received', kind: 'event', latency: '+1.6s' },
  { event: 'message.received', kind: 'event', latency: '+2.1s' },
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '22ms' },
  { event: 'message.delivered', kind: 'event', latency: '39ms' },
  { event: 'message.delivered', kind: 'event', latency: '45ms' },
  { agent: 'Codex', kind: 'agent', provider: 'codex', status: 'offline' },
  { event: 'message.received', kind: 'event', latency: '+1.8s' },
  { event: 'message.received', kind: 'event', latency: '+2.4s' },
  { agent: 'Codex', kind: 'agent', provider: 'codex', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '29ms' },
  { event: 'message.delivered', kind: 'event', latency: '34ms' },
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'offline' },
  { event: 'message.received', kind: 'event', latency: '+3.1s' },
  { agent: 'Claude', kind: 'agent', provider: 'claude', status: 'online' },
  { event: 'message.delivered', kind: 'event', latency: '47ms' },
] satisfies TimelineTemplate[];

const DELIVERED_DELAY_CLASSES = [s.durableDeliveredOne, s.durableDeliveredTwo, s.durableDeliveredThree];

function normalizeTimelineIndex(index: number) {
  return ((index % TIMELINE_SEQUENCE.length) + TIMELINE_SEQUENCE.length) % TIMELINE_SEQUENCE.length;
}

function getTimelineItem(index: number): TimelineItem {
  const template = TIMELINE_SEQUENCE[normalizeTimelineIndex(index)];

  return { ...template, id: index };
}

function getTimelineDelay(index: number) {
  const sequenceIndex = normalizeTimelineIndex(index);
  const item = TIMELINE_SEQUENCE[sequenceIndex];

  if (index === FIRST_CATCH_UP_COMPLETE_INDEX) {
    return FIRST_CATCH_UP_HOLD_MS;
  }

  if (RECOVERY_COMPLETE_SEQUENCE_INDICES.includes(sequenceIndex)) {
    return CATCH_UP_HOLD_MS;
  }

  if (item.kind === 'agent') {
    return item.status === 'offline' ? 2300 : 1450;
  }

  if (item.event === 'message.received') {
    return RECEIVED_STEP_DELAYS_MS[sequenceIndex % RECEIVED_STEP_DELAYS_MS.length];
  }

  return DELIVERED_STEP_DELAYS_MS[sequenceIndex % DELIVERED_STEP_DELAYS_MS.length];
}

export function DurableDeliveryTimeline() {
  const [cursor, setCursor] = useState(INITIAL_TIMELINE_CURSOR);
  const items = Array.from({ length: VISIBLE_TIMELINE_ITEMS }, (_, offset) =>
    getTimelineItem(cursor - VISIBLE_TIMELINE_ITEMS + 1 + offset),
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setCursor((current) => current + 1);
    }, getTimelineDelay(cursor));

    return () => window.clearTimeout(timeoutId);
  }, [cursor]);

  return (
    <div className={s.durableTimelinePreview} aria-label="Durable message delivery timeline">
      <span className={s.durableTimelineLine} />
      {items.map((item) => {
        if (item.kind === 'agent') {
          return (
            <div
              className={`${s.durableTimelineRow} ${s.durableAgentCard} ${
                item.status === 'online' ? s.durableAgentOnline : s.durableAgentOffline
              }`}
              key={item.id}
            >
              <AgentToolLogo className={s.durableAgentIcon} provider={item.provider} />
              <strong>{item.agent}</strong>
              <span className={s.durableStatus}>
                <span />
                {item.status}
              </span>
            </div>
          );
        }

        if (item.event === 'message.delivered') {
          return (
            <div
              className={`${s.durableDelivered} ${DELIVERED_DELAY_CLASSES[item.id % DELIVERED_DELAY_CLASSES.length]}`}
              key={item.id}
            >
              <span>✓</span>
              <strong>message.delivered</strong>
              <time>{item.latency}</time>
            </div>
          );
        }

        return (
          <div className={`${s.durableTimelineRow} ${s.durableEvent}`} key={item.id}>
            <span className={s.durableEventDot} />
            <code>message.received</code>
            <time>{item.latency}</time>
          </div>
        );
      })}
    </div>
  );
}
