/**
 * usePinnedAgents Hook
 *
 * Manages pinned agents with localStorage persistence.
 * Pinned agents appear at the top of the agents panel.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';

const STORAGE_KEY = 'agent-relay-pinned-agents';
const MAX_PINNED = 5;

export interface UsePinnedAgentsReturn {
  /** Array of pinned agent names */
  pinnedAgents: string[];
  /** Check if an agent is pinned */
  isPinned: (agentName: string) => boolean;
  /** Toggle pin status for an agent */
  togglePin: (agentName: string) => void;
  /** Pin an agent (no-op if already pinned or at max) */
  pin: (agentName: string) => boolean;
  /** Unpin an agent */
  unpin: (agentName: string) => void;
  /** Whether max pins reached */
  isMaxPinned: boolean;
  /** Maximum number of pinned agents allowed */
  maxPinned: number;
}

export function usePinnedAgents(): UsePinnedAgentsReturn {
  const [pinnedAgents, setPinnedAgents] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed.slice(0, MAX_PINNED);
        }
      }
    } catch {
      // localStorage not available or invalid data
    }
    return [];
  });

  // Persist to localStorage when pinnedAgents changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pinnedAgents));
    } catch {
      // localStorage not available
    }
  }, [pinnedAgents]);

  const isPinned = useCallback(
    (agentName: string) => pinnedAgents.includes(agentName),
    [pinnedAgents]
  );

  const pin = useCallback(
    (agentName: string): boolean => {
      if (pinnedAgents.includes(agentName)) {
        return true; // Already pinned
      }
      if (pinnedAgents.length >= MAX_PINNED) {
        return false; // At max capacity
      }
      setPinnedAgents((prev) => [...prev, agentName]);
      return true;
    },
    [pinnedAgents]
  );

  const unpin = useCallback((agentName: string) => {
    setPinnedAgents((prev) => prev.filter((name) => name !== agentName));
  }, []);

  const togglePin = useCallback(
    (agentName: string) => {
      if (isPinned(agentName)) {
        unpin(agentName);
      } else {
        pin(agentName);
      }
    },
    [isPinned, pin, unpin]
  );

  const isMaxPinned = useMemo(
    () => pinnedAgents.length >= MAX_PINNED,
    [pinnedAgents]
  );

  return {
    pinnedAgents,
    isPinned,
    togglePin,
    pin,
    unpin,
    isMaxPinned,
    maxPinned: MAX_PINNED,
  };
}
