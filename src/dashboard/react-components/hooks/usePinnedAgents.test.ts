/**
 * Tests for usePinnedAgents hook utilities
 *
 * Tests the pure functions that power the hook:
 * - loadPinnedAgents, savePinnedAgents (localStorage operations)
 * - pinAgent, unpinAgent (state transformations)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STORAGE_KEY,
  MAX_PINNED,
  loadPinnedAgents,
  savePinnedAgents,
  pinAgent,
  unpinAgent,
} from './usePinnedAgents';

// Mock localStorage
const createLocalStorageMock = () => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
    _getStore: () => store,
    _setStore: (newStore: Record<string, string>) => {
      store = newStore;
    },
  };
};

describe('usePinnedAgents utilities', () => {
  let localStorageMock: ReturnType<typeof createLocalStorageMock>;

  beforeEach(() => {
    localStorageMock = createLocalStorageMock();
    vi.stubGlobal('localStorage', localStorageMock);
  });

  describe('Constants', () => {
    it('should have correct storage key', () => {
      expect(STORAGE_KEY).toBe('agent-relay-pinned-agents');
    });

    it('should have max pinned limit of 5', () => {
      expect(MAX_PINNED).toBe(5);
    });
  });

  describe('loadPinnedAgents', () => {
    it('should return empty array when no data in localStorage', () => {
      const result = loadPinnedAgents();
      expect(result).toEqual([]);
    });

    it('should load pinned agents from localStorage', () => {
      const savedAgents = ['Agent1', 'Agent2', 'Agent3'];
      localStorageMock.setItem(STORAGE_KEY, JSON.stringify(savedAgents));

      const result = loadPinnedAgents();
      expect(result).toEqual(savedAgents);
    });

    it('should limit loaded agents to max 5', () => {
      const savedAgents = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
      localStorageMock.setItem(STORAGE_KEY, JSON.stringify(savedAgents));

      const result = loadPinnedAgents();
      expect(result).toHaveLength(5);
      expect(result).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    });

    it('should handle corrupted JSON gracefully', () => {
      localStorageMock.setItem(STORAGE_KEY, 'not valid json {{{');

      const result = loadPinnedAgents();
      expect(result).toEqual([]);
    });

    it('should handle non-array JSON gracefully', () => {
      localStorageMock.setItem(STORAGE_KEY, JSON.stringify({ foo: 'bar' }));

      const result = loadPinnedAgents();
      expect(result).toEqual([]);
    });

    it('should handle localStorage.getItem throwing', () => {
      const errorMock = {
        getItem: () => {
          throw new Error('localStorage disabled');
        },
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: 0,
        key: vi.fn(),
      };
      vi.stubGlobal('localStorage', errorMock);

      const result = loadPinnedAgents();
      expect(result).toEqual([]);
    });

    it('should handle localStorage being undefined (SSR)', () => {
      vi.stubGlobal('localStorage', undefined);

      const result = loadPinnedAgents();
      expect(result).toEqual([]);
    });
  });

  describe('savePinnedAgents', () => {
    it('should save pinned agents to localStorage', () => {
      const agents = ['Agent1', 'Agent2'];
      savePinnedAgents(agents);

      const stored = JSON.parse(localStorageMock.getItem(STORAGE_KEY) || '[]');
      expect(stored).toEqual(agents);
    });

    it('should overwrite existing data', () => {
      localStorageMock.setItem(STORAGE_KEY, JSON.stringify(['Old']));

      savePinnedAgents(['New1', 'New2']);

      const stored = JSON.parse(localStorageMock.getItem(STORAGE_KEY) || '[]');
      expect(stored).toEqual(['New1', 'New2']);
    });

    it('should handle localStorage.setItem throwing', () => {
      const errorMock = {
        getItem: vi.fn(() => null),
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: 0,
        key: vi.fn(),
      };
      vi.stubGlobal('localStorage', errorMock);

      // Should not throw
      expect(() => savePinnedAgents(['Agent1'])).not.toThrow();
    });

    it('should handle localStorage being undefined (SSR)', () => {
      vi.stubGlobal('localStorage', undefined);

      // Should not throw
      expect(() => savePinnedAgents(['Agent1'])).not.toThrow();
    });
  });

  describe('pinAgent', () => {
    it('should add agent to empty list', () => {
      const { newPinned, success } = pinAgent([], 'Agent1');

      expect(success).toBe(true);
      expect(newPinned).toEqual(['Agent1']);
    });

    it('should add agent to existing list', () => {
      const { newPinned, success } = pinAgent(['Agent1', 'Agent2'], 'Agent3');

      expect(success).toBe(true);
      expect(newPinned).toEqual(['Agent1', 'Agent2', 'Agent3']);
    });

    it('should return success true but same list when agent already pinned', () => {
      const current = ['Agent1', 'Agent2'];
      const { newPinned, success } = pinAgent(current, 'Agent1');

      expect(success).toBe(true);
      expect(newPinned).toBe(current); // Same reference, not modified
    });

    it('should not create duplicates', () => {
      const { newPinned } = pinAgent(['Agent1'], 'Agent1');

      expect(newPinned.filter((a) => a === 'Agent1')).toHaveLength(1);
    });

    it('should enforce max 5 limit', () => {
      const fullList = ['A1', 'A2', 'A3', 'A4', 'A5'];
      const { newPinned, success } = pinAgent(fullList, 'A6');

      expect(success).toBe(false);
      expect(newPinned).toBe(fullList); // Same reference
      expect(newPinned).not.toContain('A6');
    });

    it('should maintain pin order', () => {
      let current: string[] = [];
      current = pinAgent(current, 'First').newPinned;
      current = pinAgent(current, 'Second').newPinned;
      current = pinAgent(current, 'Third').newPinned;

      expect(current).toEqual(['First', 'Second', 'Third']);
    });

    it('should handle agent names with special characters', () => {
      const specialNames = [
        'Agent-With-Dashes',
        'Agent_With_Underscores',
        'Agent.With.Dots',
        'Agent With Spaces',
      ];

      let current: string[] = [];
      for (const name of specialNames) {
        const { newPinned, success } = pinAgent(current, name);
        expect(success).toBe(true);
        current = newPinned;
      }

      expect(current).toEqual(specialNames);
    });

    it('should handle empty string agent name', () => {
      const { newPinned, success } = pinAgent([], '');

      expect(success).toBe(true);
      expect(newPinned).toContain('');
    });
  });

  describe('unpinAgent', () => {
    it('should remove agent from list', () => {
      const result = unpinAgent(['Agent1', 'Agent2', 'Agent3'], 'Agent2');

      expect(result).toEqual(['Agent1', 'Agent3']);
    });

    it('should return same list without the agent when unpinning from start', () => {
      const result = unpinAgent(['Agent1', 'Agent2', 'Agent3'], 'Agent1');

      expect(result).toEqual(['Agent2', 'Agent3']);
    });

    it('should return same list without the agent when unpinning from end', () => {
      const result = unpinAgent(['Agent1', 'Agent2', 'Agent3'], 'Agent3');

      expect(result).toEqual(['Agent1', 'Agent2']);
    });

    it('should return same content when unpinning non-existent agent', () => {
      const current = ['Agent1', 'Agent2'];
      const result = unpinAgent(current, 'NonExistent');

      expect(result).toEqual(['Agent1', 'Agent2']);
    });

    it('should not throw when unpinning from empty list', () => {
      const result = unpinAgent([], 'Agent1');

      expect(result).toEqual([]);
    });

    it('should return empty array when unpinning last agent', () => {
      const result = unpinAgent(['Agent1'], 'Agent1');

      expect(result).toEqual([]);
    });
  });

  describe('Integration: pin then unpin', () => {
    it('should correctly pin and unpin agents', () => {
      let current: string[] = [];

      // Pin some agents
      current = pinAgent(current, 'Agent1').newPinned;
      current = pinAgent(current, 'Agent2').newPinned;
      current = pinAgent(current, 'Agent3').newPinned;
      expect(current).toEqual(['Agent1', 'Agent2', 'Agent3']);

      // Unpin middle agent
      current = unpinAgent(current, 'Agent2');
      expect(current).toEqual(['Agent1', 'Agent3']);

      // Pin new agent - should go to end
      current = pinAgent(current, 'Agent4').newPinned;
      expect(current).toEqual(['Agent1', 'Agent3', 'Agent4']);

      // Unpin all
      current = unpinAgent(current, 'Agent1');
      current = unpinAgent(current, 'Agent3');
      current = unpinAgent(current, 'Agent4');
      expect(current).toEqual([]);
    });

    it('should allow pinning after reaching limit then unpinning', () => {
      let current: string[] = ['A1', 'A2', 'A3', 'A4', 'A5'];

      // Try to pin 6th - should fail
      let result = pinAgent(current, 'A6');
      expect(result.success).toBe(false);

      // Unpin one
      current = unpinAgent(current, 'A3');
      expect(current).toHaveLength(4);

      // Now pinning should work
      result = pinAgent(current, 'A6');
      expect(result.success).toBe(true);
      expect(result.newPinned).toContain('A6');
      expect(result.newPinned).toHaveLength(5);
    });
  });

  describe('Integration: localStorage round-trip', () => {
    it('should correctly save and load agents', () => {
      const agents = ['Agent1', 'Agent2', 'Agent3'];

      savePinnedAgents(agents);
      const loaded = loadPinnedAgents();

      expect(loaded).toEqual(agents);
    });

    it('should handle save after pin operations', () => {
      let current: string[] = [];
      current = pinAgent(current, 'Agent1').newPinned;
      current = pinAgent(current, 'Agent2').newPinned;

      savePinnedAgents(current);
      const loaded = loadPinnedAgents();

      expect(loaded).toEqual(['Agent1', 'Agent2']);
    });

    it('should handle save after unpin operations', () => {
      let current = ['Agent1', 'Agent2', 'Agent3'];
      current = unpinAgent(current, 'Agent2');

      savePinnedAgents(current);
      const loaded = loadPinnedAgents();

      expect(loaded).toEqual(['Agent1', 'Agent3']);
    });
  });
});
