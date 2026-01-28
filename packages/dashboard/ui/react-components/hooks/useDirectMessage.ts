/**
 * useDirectMessage Hook
 *
 * Handles DM conversation logic including agent participation,
 * message filtering, and deduplication.
 */

import { useMemo } from 'react';
import type { Agent, Message } from '../../types';

export interface UseDirectMessageOptions {
  currentHuman: Agent | null;
  currentUserName: string | null;
  messages: Message[];
  agents: Agent[];
  selectedDmAgents: string[];
  removedDmAgents: string[];
}

export interface UseDirectMessageResult {
  visibleMessages: Message[];
  participantAgents: string[];
}

export function useDirectMessage({
  currentHuman,
  currentUserName,
  messages,
  agents,
  selectedDmAgents,
  removedDmAgents,
}: UseDirectMessageOptions): UseDirectMessageResult {
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
      if (selectedDmAgents.includes(from) && agentNameSet.has(to)) derived.add(to);
      if (selectedDmAgents.includes(to) && agentNameSet.has(from)) derived.add(from);
    }

    const participants = new Set<string>([...selectedDmAgents, ...derived]);
    removedDmAgents.forEach((a) => participants.delete(a));
    return Array.from(participants);
  }, [agentNameSet, currentHuman, messages, removedDmAgents, selectedDmAgents]);

  // Filter messages for this DM conversation
  const visibleMessages = useMemo(() => {
    if (!currentHuman) return messages;
    // Include current user, the other human, and all participant agents
    const participants = new Set<string>([currentHuman.name, ...dmParticipantAgents]);
    // Add current user to participants - use "Dashboard" as fallback for local mode
    const effectiveUserName = currentUserName || 'Dashboard';
    participants.add(effectiveUserName);

    console.log('[DM Filter] currentHuman:', currentHuman.name, 'currentUser:', currentUserName, 'agents:', dmParticipantAgents, 'participants:', Array.from(participants));

    const filtered = messages.filter((msg) => {
      if (!msg.from || !msg.to) return false;
      const hasFrom = participants.has(msg.from);
      const hasTo = participants.has(msg.to);
      const passes = hasFrom && hasTo;

      if (msg.from?.includes('Agent') || msg.to?.includes('Agent')) {
        console.log('[DM Filter] msg:', msg.from, '->', msg.to, 'hasFrom:', hasFrom, 'hasTo:', hasTo, 'passes:', passes);
      }

      return passes;
    });

    console.log('[DM Filter] filtered count:', filtered.length);
    return filtered;
  }, [currentHuman, currentUserName, dmParticipantAgents, messages]);

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

  return {
    visibleMessages: dedupedVisibleMessages,
    participantAgents: dmParticipantAgents,
  };
}
