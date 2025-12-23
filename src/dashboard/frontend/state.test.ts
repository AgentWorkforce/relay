/**
 * Tests for Dashboard State Management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  state,
  subscribe,
  setAgents,
  setMessages,
  setCurrentChannel,
  setConnectionStatus,
  setWebSocket,
  incrementReconnectAttempts,
  getFilteredMessages,
} from './state.js';
import type { Agent, Message } from './types.js';

describe('state', () => {
  // Reset state before each test
  beforeEach(() => {
    state.agents = [];
    state.messages = [];
    state.currentChannel = 'general';
    state.isConnected = false;
    state.ws = null;
    state.reconnectAttempts = 0;
  });

  describe('initial state', () => {
    it('should have empty agents array', () => {
      expect(state.agents).toEqual([]);
    });

    it('should have empty messages array', () => {
      expect(state.messages).toEqual([]);
    });

    it('should have general as default channel', () => {
      expect(state.currentChannel).toBe('general');
    });

    it('should be disconnected by default', () => {
      expect(state.isConnected).toBe(false);
    });

    it('should have null websocket', () => {
      expect(state.ws).toBeNull();
    });

    it('should have zero reconnect attempts', () => {
      expect(state.reconnectAttempts).toBe(0);
    });
  });

  describe('subscribe', () => {
    it('should call listener when state changes', () => {
      const listener = vi.fn();
      subscribe(listener);

      setAgents([{ name: 'Alice' } as Agent]);

      expect(listener).toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = subscribe(listener);

      unsubscribe();
      setAgents([{ name: 'Bob' } as Agent]);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should support multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      subscribe(listener1);
      subscribe(listener2);

      setAgents([{ name: 'Charlie' } as Agent]);

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });

  describe('setAgents', () => {
    it('should update agents array', () => {
      const agents: Agent[] = [
        { name: 'Alice', role: 'Developer', cli: 'claude', messageCount: 5 },
        { name: 'Bob', role: 'Reviewer', cli: 'gemini', messageCount: 3 },
      ];

      setAgents(agents);

      expect(state.agents).toEqual(agents);
      expect(state.agents).toHaveLength(2);
    });

    it('should replace existing agents', () => {
      setAgents([{ name: 'Alice' } as Agent]);
      setAgents([{ name: 'Bob' } as Agent]);

      expect(state.agents).toHaveLength(1);
      expect(state.agents[0].name).toBe('Bob');
    });
  });

  describe('setMessages', () => {
    it('should update messages array', () => {
      const messages: Message[] = [
        { id: '1', from: 'Alice', to: 'Bob', content: 'Hello', timestamp: '2025-01-15T12:00:00Z' },
      ];

      setMessages(messages);

      expect(state.messages).toEqual(messages);
    });

    it('should replace existing messages', () => {
      setMessages([{ id: '1' } as Message]);
      setMessages([{ id: '2' } as Message]);

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].id).toBe('2');
    });
  });

  describe('setCurrentChannel', () => {
    it('should update current channel', () => {
      setCurrentChannel('Alice');
      expect(state.currentChannel).toBe('Alice');
    });

    it('should accept agent names as channels', () => {
      setCurrentChannel('Bob');
      expect(state.currentChannel).toBe('Bob');
    });
  });

  describe('setConnectionStatus', () => {
    it('should set connected status', () => {
      setConnectionStatus(true);
      expect(state.isConnected).toBe(true);
    });

    it('should set disconnected status', () => {
      state.isConnected = true;
      setConnectionStatus(false);
      expect(state.isConnected).toBe(false);
    });

    it('should reset reconnect attempts when connected', () => {
      state.reconnectAttempts = 5;
      setConnectionStatus(true);
      expect(state.reconnectAttempts).toBe(0);
    });

    it('should not reset reconnect attempts when disconnected', () => {
      state.reconnectAttempts = 5;
      setConnectionStatus(false);
      expect(state.reconnectAttempts).toBe(5);
    });
  });

  describe('incrementReconnectAttempts', () => {
    it('should increment reconnect attempts', () => {
      expect(state.reconnectAttempts).toBe(0);

      incrementReconnectAttempts();
      expect(state.reconnectAttempts).toBe(1);

      incrementReconnectAttempts();
      expect(state.reconnectAttempts).toBe(2);
    });
  });

  describe('setWebSocket', () => {
    it('should set websocket instance', () => {
      const mockWs = {} as WebSocket;
      setWebSocket(mockWs);
      expect(state.ws).toBe(mockWs);
    });

    it('should allow setting to null', () => {
      state.ws = {} as WebSocket;
      setWebSocket(null);
      expect(state.ws).toBeNull();
    });
  });

  describe('getFilteredMessages', () => {
    const messages: Message[] = [
      { id: '1', from: 'Alice', to: 'Bob', content: 'Direct message', timestamp: '2025-01-15T12:00:00Z' },
      { id: '2', from: 'Bob', to: '*', content: 'Broadcast', timestamp: '2025-01-15T12:01:00Z' },
      { id: '3', from: 'Charlie', to: 'Alice', content: 'To Alice', timestamp: '2025-01-15T12:02:00Z' },
      { id: '4', from: 'Alice', to: '*', content: 'Alice broadcast', timestamp: '2025-01-15T12:03:00Z' },
    ];

    beforeEach(() => {
      setMessages(messages);
    });

    it('should return all messages for general channel', () => {
      setCurrentChannel('general');
      const filtered = getFilteredMessages();
      expect(filtered).toHaveLength(4);
    });

    it('should return messages to/from agent for agent channel', () => {
      setCurrentChannel('Alice');
      const filtered = getFilteredMessages();
      // Messages where Alice is sender or recipient
      expect(filtered).toHaveLength(3);
      expect(filtered.every((m) => m.from === 'Alice' || m.to === 'Alice')).toBe(true);
    });

    it('should return empty array when no matching messages', () => {
      setCurrentChannel('Unknown');
      const filtered = getFilteredMessages();
      expect(filtered).toHaveLength(0);
    });
  });
});
