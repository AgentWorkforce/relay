'use client';

import { useEffect, useRef, useState } from 'react';

import { AgentToolLogo, type AgentTool } from '../components/AgentToolLogos';
import s from './landing.module.css';

const REALTIME_EVENT_ACTIVITY = [
  { name: 'session.started', agent: 'Planner', action: 'joined #dev', provider: 'claude', signal: 'live' },
  { name: 'message.sent', agent: 'Builder', action: 'sent a channel update', provider: 'codex', signal: 'live' },
  { name: 'reaction.added', agent: 'Reviewer', action: 'reacted with :+1:', provider: 'claude', signal: 'live' },
  { name: 'thread.started', agent: 'Planner', action: 'started a review thread', provider: 'claude', signal: 'live' },
  { name: 'status.idle', agent: 'Builder', action: 'went idle', provider: 'codex', signal: 'idle' },
  { name: 'action.invoked', agent: 'Ops', action: 'called spawn', provider: 'openclaw', signal: 'live' },
  { name: 'message.sent', agent: 'Designer', action: 'sent a DM', provider: 'codex', signal: 'live' },
  { name: 'status.offline', agent: 'Reviewer', action: 'disconnected', provider: 'claude', signal: 'disconnected' },
  { name: 'channel.left', agent: 'Ops', action: 'left #deploy', provider: 'openclaw', signal: 'disconnected' },
  { name: 'action.invoked', agent: 'Planner', action: 'called ui.update', provider: 'claude', signal: 'live' },
  { name: 'session.started', agent: 'QA', action: 'joined #release', provider: 'codex', signal: 'live' },
  { name: 'status.idle', agent: 'Ops', action: 'went idle', provider: 'openclaw', signal: 'idle' },
  { name: 'message.sent', agent: 'Reviewer', action: 'sent thread reply', provider: 'claude', signal: 'live' },
  { name: 'reaction.added', agent: 'QA', action: 'reacted with :eyes:', provider: 'codex', signal: 'live' },
] satisfies Array<{
  action: string;
  agent: string;
  name: string;
  provider: AgentTool | 'openclaw';
  signal: 'disconnected' | 'idle' | 'live';
}>;

const EVENT_LATENCIES = ['12ms', '18ms', '21ms', '24ms', '31ms', '37ms', '42ms', '49ms'];
const BATCH_PATTERN = [1, 2, 1, 1, 2, 1, 3, 1, 2, 1, 1, 2];
const DELAY_PATTERN = [1700, 2600, 1300, 2200, 3100, 1500, 2400, 1800, 2900, 1200, 2500, 1600];
const INITIAL_EVENT_COUNT = 4;
const MAX_VISIBLE_EVENTS = 5;

type FeedEvent = {
  action: string;
  agent: string;
  id: number;
  name: string;
  provider: AgentTool | 'openclaw';
  signal: 'disconnected' | 'idle' | 'live';
  latency: string;
};

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

function HarnessLogo({ provider }: { provider: FeedEvent['provider'] }) {
  if (provider === 'openclaw') return <OpenClawLogo className={s.realtimeHarnessLogo} />;

  return <AgentToolLogo className={s.realtimeHarnessLogo} provider={provider} />;
}

function makeFeedEvent(sequence: number, id: number): FeedEvent {
  const activity = REALTIME_EVENT_ACTIVITY[sequence % REALTIME_EVENT_ACTIVITY.length];

  return {
    action: activity.action,
    agent: activity.agent,
    id,
    name: activity.name,
    provider: activity.provider,
    signal: activity.signal,
    latency: EVENT_LATENCIES[sequence % EVENT_LATENCIES.length],
  };
}

function initialEvents() {
  return Array.from({ length: INITIAL_EVENT_COUNT }, (_, index) => makeFeedEvent(index, index));
}

export function RealtimeEventFeed() {
  const [events, setEvents] = useState(initialEvents);
  const sequenceRef = useRef(INITIAL_EVENT_COUNT);
  const idRef = useRef(INITIAL_EVENT_COUNT);
  const stepRef = useRef(0);

  useEffect(() => {
    let active = true;
    let timeoutId: number | undefined;

    const scheduleNext = () => {
      const delay = DELAY_PATTERN[stepRef.current % DELAY_PATTERN.length];

      timeoutId = window.setTimeout(() => {
        if (!active) return;

        const batchSize = BATCH_PATTERN[stepRef.current % BATCH_PATTERN.length];
        const additions = Array.from({ length: batchSize }, () => {
          const item = makeFeedEvent(sequenceRef.current, idRef.current);
          sequenceRef.current += 1;
          idRef.current += 1;
          return item;
        });

        setEvents((current) => [...current, ...additions].slice(-MAX_VISIBLE_EVENTS));
        stepRef.current += 1;
        scheduleNext();
      }, delay);
    };

    scheduleNext();

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, []);

  return (
    <div className={s.realtimeFeed}>
      <div className={s.realtimeFeedList}>
        {events.map((event) => (
          <div className={s.realtimeEvent} key={event.id}>
            <span className={`${s.realtimeEventDot} ${s[`realtimeEventDot-${event.signal}`]}`} />
            <div>
              <code>{event.name}</code>
              <span className={s.realtimeEventMeta}>
                <HarnessLogo provider={event.provider} />
                <span className={s.realtimeEventAgent}>{event.agent}</span>
                <span>{event.action}</span>
              </span>
            </div>
            <strong>{event.latency}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
