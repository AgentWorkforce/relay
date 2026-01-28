/**
 * DirectMessageView Component
 *
 * Handles direct message conversations with humans and optional agent participants.
 * Manages agent invitations, message deduplication, and group DM functionality.
 */

import React, { useMemo, useCallback } from 'react';
import type { Agent, Message } from '../types';

export interface DirectMessageViewProps {
  /** The human user being DM'd */
  currentHuman: { name: string; isHuman: boolean } | null;
  /** All messages */
  messages: Message[];
  /** All agents */
  agents: Agent[];
  /** Currently selected agents for this DM */
  selectedAgents: string[];
  /** Agents removed from this DM */
  removedAgents: string[];
  /** Callback to toggle agent participation */
  onAgentToggle: (agentName: string) => void;
  /** Children to render (message list, composer, etc.) */
  children: (props: {
    visibleMessages: Message[];
    participantAgents: string[];
  }) => React.ReactNode;
}

export function DirectMessageView({
  currentHuman,
  messages,
  agents,
  selectedAgents,
  removedAgents,
  onAgentToggle,
  children,
}: DirectMessageViewProps) {
  const agentNameSet = useMemo(() => new Set(agents.map((a) => a.name)), [agents]);

  // Derive agents participating in this conversation from message history
  const dmParticipantAgents = useMemo(() => {
    if (!currentHuman) return [];
    const humanName = currentHuman.name;
    const derived = new Set<string>();

    for (const msg of messages) {
      const { from, to } = msg;
      if (!from || !to) continue;
      if (from === humanName && agentNameSet.has(to)) derived.add(to);
      if (to === humanName && agentNameSet.has(from)) derived.add(from);
      if (selectedAgents.includes(from) && agentNameSet.has(to)) derived.add(to);
      if (selectedAgents.includes(to) && agentNameSet.has(from)) derived.add(from);
    }

    const participants = new Set<string>([...selectedAgents, ...derived]);
    removedAgents.forEach((a) => participants.delete(a));
    return Array.from(participants);
  }, [agentNameSet, currentHuman, messages, removedAgents, selectedAgents]);

  // Filter messages for this DM conversation
  const visibleMessages = useMemo(() => {
    if (!currentHuman) return messages;
    const participants = new Set<string>([currentHuman.name, ...dmParticipantAgents]);
    return messages.filter(
      (msg) => msg.from && msg.to && participants.has(msg.from) && participants.has(msg.to)
    );
  }, [currentHuman, dmParticipantAgents, messages]);

  // Deduplicate DM messages (merge duplicates sent to multiple participants)
  const dedupedVisibleMessages = useMemo(() => {
    if (!currentHuman) return visibleMessages;

    const normalizeBody = (content?: string) => (content ?? '').trim().replace(/\s+/g, ' ');
    const rank = (msg: Message) => (msg.status === 'sending' ? 1 : 0);
    const choose = (current: Message, incoming: Message) => {
      const currentRank = rank(current);
      const incomingRank = rank(incoming);
      const currentTs = new Date(current.timestamp).getTime();
      const incomingTs = new Date(incoming.timestamp).getTime();
      if (incomingRank < currentRank) return incoming;
      if (incomingRank > currentRank) return current;
      return incomingTs >= currentTs ? incoming : current;
    };

    const sorted = [...visibleMessages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const byId = new Map<string, Message>();
    const byFuzzy = new Map<string, Message>();

    for (const msg of sorted) {
      if (msg.id) {
        const existing = byId.get(msg.id);
        byId.set(msg.id, existing ? choose(existing, msg) : msg);
        continue;
      }

      const sender = msg.from?.toLowerCase() ?? '';
      const bucket = Math.floor(new Date(msg.timestamp).getTime() / 5000);
      const key = `${sender}|${bucket}|${normalizeBody(msg.content)}`;
      const existing = byFuzzy.get(key);
      byFuzzy.set(key, existing ? choose(existing, msg) : msg);
    }

    const merged = [...byId.values(), ...byFuzzy.values()];

    // Final pass: deduplicate by sender + recipient + content (no time bucket)
    const finalDedup = new Map<string, Message>();
    for (const msg of merged) {
      const sender = msg.from?.toLowerCase() ?? '';
      const recipient = msg.to?.toLowerCase() ?? '';
      const key = `${sender}|${recipient}|${normalizeBody(msg.content)}`;
      const existing = finalDedup.get(key);
      finalDedup.set(key, existing ? choose(existing, msg) : msg);
    }

    return Array.from(finalDedup.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }, [currentHuman, visibleMessages]);

  if (!currentHuman) return null;

  return (
    <>
      {/* DM Header with Agent Invites */}
      <div className="px-4 py-2 border-b border-border-subtle bg-bg-secondary flex flex-col gap-2 sticky top-0 z-10">
        <div className="text-xs text-text-muted">
          DM with <span className="font-semibold text-text-primary">{currentHuman.name}</span>. Invite agents:
        </div>
        <div className="flex flex-wrap gap-2">
          {agents
            .filter((a) => !a.isHuman)
            .map((agent) => {
              const isSelected = selectedAgents.includes(agent.name);
              return (
                <button
                  key={agent.name}
                  onClick={() => onAgentToggle(agent.name)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    isSelected
                      ? 'bg-accent-cyan text-bg-deep'
                      : 'bg-bg-tertiary text-text-secondary hover:bg-bg-tertiary/80'
                  }`}
                  title={agent.name}
                >
                  {isSelected ? '✓ ' : ''}{agent.name}
                </button>
              );
            })}
        </div>
      </div>

      {/* Render children with deduped messages */}
      {children({
        visibleMessages: dedupedVisibleMessages,
        participantAgents: dmParticipantAgents,
      })}
    </>
  );
}
