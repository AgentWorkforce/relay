/**
 * usePinnedAgents Hook
 *
 * Manages pinned agents with localStorage persistence.
 * Pinned agents appear at the top of the agents panel.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';

export const STORAGE_KEY = 'agent-relay-pinned-agents';
export const MAX_PINNED = 5;

/**
 * Load pinned agents from localStorage
 * Exported for testing
 */
export function loadPinnedAgents(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
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
}

/**
 * Save pinned agents to localStorage
 * Exported for testing
 */
export function savePinnedAgents(agents: string[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
  } catch {
    // localStorage not available
  }
}

/**
 * Pin an agent to the list
 * Returns the new list and whether the pin was successful
 */
export function pinAgent(
  currentPinned: string[],
  agentName: string
): { newPinned: string[]; success: boolean } {
  if (currentPinned.includes(agentName)) {
    return { newPinned: currentPinned, success: true }; // Already pinned
  }
  if (currentPinned.length >= MAX_PINNED) {
    return { newPinned: currentPinned, success: false }; // At max capacity
  }
  return { newPinned: [...currentPinned, agentName], success: true };
}

/**
 * Unpin an agent from the list
 */
export function unpinAgent(currentPinned: string[], agentName: string): string[] {
  return currentPinned.filter((name) => name !== agentName);
}

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
  const [pinnedAgents, setPinnedAgents] = useState<string[]>(() => loadPinnedAgents());

  // Persist to localStorage when pinnedAgents changes
  useEffect(() => {
    savePinnedAgents(pinnedAgents);
  }, [pinnedAgents]);

  const isPinned = useCallback(
    (agentName: string) => pinnedAgents.includes(agentName),
    [pinnedAgents]
  );

  const pin = useCallback(
    (agentName: string): boolean => {
      const { newPinned, success } = pinAgent(pinnedAgents, agentName);
      if (newPinned !== pinnedAgents) {
        setPinnedAgents(newPinned);
      }
      return success;
    },
    [pinnedAgents]
  );

  const unpin = useCallback((agentName: string) => {
    setPinnedAgents((prev) => unpinAgent(prev, agentName));
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
