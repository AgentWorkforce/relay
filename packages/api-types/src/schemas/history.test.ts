/**
 * History Schema Tests
 */

import { describe, it, expect } from 'vitest';
import {
  HistorySessionSchema,
  HistoryMessageSchema,
  ConversationSchema,
  HistoryStatsSchema,
  FileSearchResultSchema,
  FileSearchResponseSchema,
} from './history.js';

describe('History Schemas', () => {
  describe('HistorySessionSchema', () => {
    it('should validate complete session', () => {
      const session = {
        id: 'session-001',
        agentName: 'FullStack',
        cli: 'claude',
        startedAt: '2025-01-22T08:00:00Z',
        endedAt: '2025-01-22T12:00:00Z',
        duration: '4h 0m',
        messageCount: 150,
        summary: 'Implemented user authentication feature',
        isActive: false,
        closedBy: 'agent',
      };
      const result = HistorySessionSchema.parse(session);
      expect(result.agentName).toBe('FullStack');
      expect(result.closedBy).toBe('agent');
      expect(result.messageCount).toBe(150);
    });

    it('should validate active session without endedAt', () => {
      const session = {
        id: 'session-002',
        agentName: 'Worker',
        startedAt: '2025-01-22T10:00:00Z',
        duration: '1h 30m',
        messageCount: 45,
        isActive: true,
      };
      const result = HistorySessionSchema.parse(session);
      expect(result.isActive).toBe(true);
      expect(result.endedAt).toBeUndefined();
      expect(result.closedBy).toBeUndefined();
    });

    it('should validate session closed by disconnect', () => {
      const session = {
        id: 'session-003',
        agentName: 'Backend',
        cli: 'codex',
        startedAt: '2025-01-21T14:00:00Z',
        endedAt: '2025-01-21T14:30:00Z',
        duration: '30m',
        messageCount: 20,
        isActive: false,
        closedBy: 'disconnect',
      };
      const result = HistorySessionSchema.parse(session);
      expect(result.closedBy).toBe('disconnect');
    });

    it('should validate session closed by error', () => {
      const session = {
        id: 'session-004',
        agentName: 'Frontend',
        startedAt: '2025-01-21T10:00:00Z',
        endedAt: '2025-01-21T10:05:00Z',
        duration: '5m',
        messageCount: 3,
        isActive: false,
        closedBy: 'error',
      };
      const result = HistorySessionSchema.parse(session);
      expect(result.closedBy).toBe('error');
    });
  });

  describe('HistoryMessageSchema', () => {
    it('should validate complete message', () => {
      const message = {
        id: 'msg-001',
        from: 'Lead',
        to: 'FullStack',
        content: 'Please implement the user authentication',
        timestamp: '2025-01-22T08:30:00Z',
        thread: 'auth-implementation',
        isBroadcast: false,
        isUrgent: true,
        status: 'delivered',
        data: { priority: 'high' },
      };
      const result = HistoryMessageSchema.parse(message);
      expect(result.from).toBe('Lead');
      expect(result.isUrgent).toBe(true);
    });

    it('should validate broadcast message', () => {
      const message = {
        id: 'msg-002',
        from: 'Lead',
        to: '*',
        content: 'Team standup in 5 minutes',
        timestamp: '2025-01-22T09:55:00Z',
        isBroadcast: true,
      };
      const result = HistoryMessageSchema.parse(message);
      expect(result.to).toBe('*');
      expect(result.isBroadcast).toBe(true);
    });

    it('should validate minimal message', () => {
      const message = {
        id: 'msg-003',
        from: 'Worker',
        to: 'Lead',
        content: 'Task completed',
        timestamp: '2025-01-22T11:00:00Z',
      };
      const result = HistoryMessageSchema.parse(message);
      expect(result.thread).toBeUndefined();
      expect(result.isBroadcast).toBeUndefined();
    });
  });

  describe('ConversationSchema', () => {
    it('should validate conversation between two agents', () => {
      const conversation = {
        participants: ['Lead', 'FullStack'],
        lastMessage: 'Thanks for the update!',
        lastTimestamp: '2025-01-22T11:30:00Z',
        messageCount: 25,
      };
      const result = ConversationSchema.parse(conversation);
      expect(result.participants).toHaveLength(2);
      expect(result.messageCount).toBe(25);
    });

    it('should validate group conversation', () => {
      const conversation = {
        participants: ['Lead', 'FullStack', 'Backend', 'Frontend'],
        lastMessage: 'Let us sync tomorrow',
        lastTimestamp: '2025-01-22T17:00:00Z',
        messageCount: 150,
      };
      const result = ConversationSchema.parse(conversation);
      expect(result.participants).toHaveLength(4);
    });
  });

  describe('HistoryStatsSchema', () => {
    it('should validate stats with numbers', () => {
      const stats = {
        messageCount: 1500,
        sessionCount: 45,
        activeSessions: 3,
        uniqueAgents: 8,
        oldestMessageDate: '2025-01-01T00:00:00Z',
      };
      const result = HistoryStatsSchema.parse(stats);
      expect(result.messageCount).toBe(1500);
      expect(result.uniqueAgents).toBe(8);
    });

    it('should validate stats with string values (from DB)', () => {
      const stats = {
        messageCount: '1500',
        sessionCount: '45',
        activeSessions: '3',
        uniqueAgents: '8',
        oldestMessageDate: '2025-01-01T00:00:00Z',
      };
      const result = HistoryStatsSchema.parse(stats);
      expect(result.messageCount).toBe('1500');
    });

    it('should validate stats without oldest date', () => {
      const stats = {
        messageCount: 0,
        sessionCount: 0,
        activeSessions: 0,
        uniqueAgents: 0,
        oldestMessageDate: null,
      };
      const result = HistoryStatsSchema.parse(stats);
      expect(result.oldestMessageDate).toBeNull();
    });
  });

  describe('FileSearchResultSchema', () => {
    it('should validate file result', () => {
      const result = {
        path: '/workspace/src/index.ts',
        name: 'index.ts',
        isDirectory: false,
      };
      const parsed = FileSearchResultSchema.parse(result);
      expect(parsed.name).toBe('index.ts');
      expect(parsed.isDirectory).toBe(false);
    });

    it('should validate directory result', () => {
      const result = {
        path: '/workspace/src',
        name: 'src',
        isDirectory: true,
      };
      const parsed = FileSearchResultSchema.parse(result);
      expect(parsed.isDirectory).toBe(true);
    });
  });

  describe('FileSearchResponseSchema', () => {
    it('should validate search response with results', () => {
      const response = {
        files: [
          { path: '/workspace/src/index.ts', name: 'index.ts', isDirectory: false },
          { path: '/workspace/src/utils.ts', name: 'utils.ts', isDirectory: false },
        ],
        query: '*.ts',
        searchRoot: '/workspace/src',
      };
      const result = FileSearchResponseSchema.parse(response);
      expect(result.files).toHaveLength(2);
      expect(result.query).toBe('*.ts');
    });

    it('should validate empty search response', () => {
      const response = {
        files: [],
        query: '*.xyz',
        searchRoot: '/workspace',
      };
      const result = FileSearchResponseSchema.parse(response);
      expect(result.files).toHaveLength(0);
    });
  });
});
