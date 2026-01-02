/**
 * Tests for CloudPersistenceService
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import { CloudPersistenceService } from './persistence.js';
import type { SummaryEvent, SessionEndEvent } from '../../wrapper/pty-wrapper.js';

// Mock the database
const mockDb = {
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn(),
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  innerJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

vi.mock('../db/drizzle.js', () => ({
  getDb: () => mockDb,
}));

vi.mock('../db/schema.js', () => ({
  agentSessions: { id: 'id', workspaceId: 'workspace_id', status: 'status' },
  agentSummaries: {
    id: 'id',
    sessionId: 'session_id',
    agentName: 'agent_name',
    summary: 'summary',
    createdAt: 'created_at',
  },
}));

// Mock PtyWrapper as EventEmitter
class MockPtyWrapper extends EventEmitter {
  name = 'TestAgent';
}

describe('CloudPersistenceService', () => {
  let service: CloudPersistenceService;
  let mockWrapper: MockPtyWrapper;
  const workspaceId = 'workspace-123';

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CloudPersistenceService({ workspaceId });
    mockWrapper = new MockPtyWrapper();

    // Reset mock chain
    mockDb.insert.mockReturnThis();
    mockDb.values.mockReturnThis();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.innerJoin.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.orderBy.mockReturnThis();
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
  });

  describe('bindToPtyWrapper', () => {
    it('creates a session and returns session ID', async () => {
      const sessionId = 'session-abc';
      mockDb.returning.mockResolvedValue([{ id: sessionId }]);

      const result = await service.bindToPtyWrapper(mockWrapper as any);

      expect(result).toBe(sessionId);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          agentName: 'TestAgent',
          status: 'active',
        })
      );
    });

    it('throws error when session creation fails', async () => {
      mockDb.returning.mockResolvedValue([]);

      await expect(service.bindToPtyWrapper(mockWrapper as any)).rejects.toThrow(
        'Failed to create session for agent TestAgent'
      );
    });

    it('binds event listeners for summary and session-end', async () => {
      mockDb.returning.mockResolvedValue([{ id: 'session-123' }]);

      await service.bindToPtyWrapper(mockWrapper as any);

      expect(mockWrapper.listenerCount('summary')).toBe(1);
      expect(mockWrapper.listenerCount('session-end')).toBe(1);
    });
  });

  describe('unbindFromPtyWrapper', () => {
    it('removes event listeners', async () => {
      mockDb.returning.mockResolvedValue([{ id: 'session-123' }]);
      await service.bindToPtyWrapper(mockWrapper as any);

      expect(mockWrapper.listenerCount('summary')).toBe(1);

      service.unbindFromPtyWrapper(mockWrapper as any);

      expect(mockWrapper.listenerCount('summary')).toBe(0);
      expect(mockWrapper.listenerCount('session-end')).toBe(0);
    });

    it('does nothing if wrapper was not bound', () => {
      // Should not throw
      service.unbindFromPtyWrapper(mockWrapper as any);
    });
  });

  describe('event handling', () => {
    beforeEach(async () => {
      mockDb.returning.mockResolvedValue([{ id: 'session-123' }]);
      await service.bindToPtyWrapper(mockWrapper as any);
    });

    it('persists summary events to database', async () => {
      mockDb.returning.mockResolvedValue([{ id: 'summary-456' }]);

      const summaryEvent: SummaryEvent = {
        agentName: 'TestAgent',
        summary: {
          currentTask: 'Writing tests',
          completedTasks: ['Setup'],
        },
      };

      mockWrapper.emit('summary', summaryEvent);

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 10));

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-123',
          agentName: 'TestAgent',
          summary: summaryEvent.summary,
        })
      );
    });

    it('calls onSummaryPersisted callback', async () => {
      const onSummaryPersisted = vi.fn();
      const serviceWithCallback = new CloudPersistenceService({
        workspaceId,
        onSummaryPersisted,
      });

      // Create a new wrapper for this test to avoid listener conflicts
      const callbackWrapper = new MockPtyWrapper();
      callbackWrapper.name = 'CallbackAgent';

      mockDb.returning.mockResolvedValueOnce([{ id: 'session-789' }]);
      await serviceWithCallback.bindToPtyWrapper(callbackWrapper as any);

      mockDb.returning.mockResolvedValueOnce([{ id: 'summary-abc' }]);

      callbackWrapper.emit('summary', {
        agentName: 'CallbackAgent',
        summary: { currentTask: 'Test' },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(onSummaryPersisted).toHaveBeenCalledWith('CallbackAgent', 'summary-abc');
    });

    it('handles session-end events', async () => {
      const sessionEndEvent: SessionEndEvent = {
        agentName: 'TestAgent',
        marker: {
          summary: 'Work complete',
          completedTasks: ['Task 1', 'Task 2'],
        },
      };

      mockWrapper.emit('session-end', sessionEndEvent);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ended',
          endMarker: sessionEndEvent.marker,
        })
      );
    });

    it('calls onSessionEnded callback', async () => {
      const onSessionEnded = vi.fn();
      const serviceWithCallback = new CloudPersistenceService({
        workspaceId,
        onSessionEnded,
      });

      mockDb.returning.mockResolvedValueOnce([{ id: 'session-end-test' }]);
      await serviceWithCallback.bindToPtyWrapper(mockWrapper as any);

      mockWrapper.emit('session-end', {
        agentName: 'TestAgent',
        marker: { summary: 'Done' },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(onSessionEnded).toHaveBeenCalledWith('TestAgent', 'session-end-test');
    });
  });

  describe('getLatestSummary', () => {
    it('returns latest summary with workspace scoping', async () => {
      const mockSummary = {
        id: 'sum-1',
        sessionId: 'sess-1',
        agentName: 'TestAgent',
        summary: { currentTask: 'Latest task' },
        createdAt: new Date(),
      };
      mockDb.limit.mockResolvedValue([mockSummary]);

      const result = await service.getLatestSummary('TestAgent');

      expect(result).toEqual(mockSummary);
      expect(mockDb.innerJoin).toHaveBeenCalled();
    });

    it('returns null when no summary exists', async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await service.getLatestSummary('UnknownAgent');

      expect(result).toBeNull();
    });
  });

  describe('getSessionId', () => {
    it('returns session ID for bound wrapper', async () => {
      mockDb.returning.mockResolvedValue([{ id: 'tracked-session' }]);
      await service.bindToPtyWrapper(mockWrapper as any);

      const sessionId = service.getSessionId(mockWrapper as any);

      expect(sessionId).toBe('tracked-session');
    });

    it('returns undefined for unbound wrapper', () => {
      const sessionId = service.getSessionId(mockWrapper as any);

      expect(sessionId).toBeUndefined();
    });
  });

  describe('destroy', () => {
    it('unbinds all wrappers', async () => {
      mockDb.returning.mockResolvedValue([{ id: 'session-1' }]);
      await service.bindToPtyWrapper(mockWrapper as any);

      const wrapper2 = new MockPtyWrapper();
      wrapper2.name = 'Agent2';
      mockDb.returning.mockResolvedValue([{ id: 'session-2' }]);
      await service.bindToPtyWrapper(wrapper2 as any);

      service.destroy();

      expect(mockWrapper.listenerCount('summary')).toBe(0);
      expect(wrapper2.listenerCount('summary')).toBe(0);
    });
  });
});
