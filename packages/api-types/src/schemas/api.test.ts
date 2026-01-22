/**
 * API Request/Response Schema Tests
 */

import { describe, it, expect } from 'vitest';
import {
  SimpleApiResponseSchema,
  SendMessageRequestSchema,
  SpeakOnTriggerSchema,
  ShadowModeSchema,
  SpawnAgentRequestSchema,
  SpawnAgentResponseSchema,
  CreateTaskRequestSchema,
  CreateBeadRequestSchema,
  SendRelayMessageRequestSchema,
  ActivityEventTypeSchema,
  ActorTypeSchema,
  ActivityEventSchema,
  WSMessageTypeSchema,
  WSMessageSchema,
  DashboardStateSchema,
} from './api.js';

describe('API Schemas', () => {
  describe('SimpleApiResponseSchema', () => {
    it('should validate success response', () => {
      const response = { success: true };
      const result = SimpleApiResponseSchema.parse(response);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should validate error response', () => {
      const response = { success: false, error: 'Something went wrong' };
      const result = SimpleApiResponseSchema.parse(response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Something went wrong');
    });
  });

  describe('SendMessageRequestSchema', () => {
    it('should validate basic message', () => {
      const request = {
        to: 'Agent1',
        message: 'Hello, Agent1!',
      };
      const result = SendMessageRequestSchema.parse(request);
      expect(result.to).toBe('Agent1');
      expect(result.message).toBe('Hello, Agent1!');
    });

    it('should validate message with thread', () => {
      const request = {
        to: '#general',
        message: 'Channel message',
        thread: 'thread-123',
      };
      const result = SendMessageRequestSchema.parse(request);
      expect(result.thread).toBe('thread-123');
    });

    it('should validate message with attachments', () => {
      const request = {
        to: 'Agent2',
        message: 'See attached files',
        attachments: ['file-001', 'file-002'],
      };
      const result = SendMessageRequestSchema.parse(request);
      expect(result.attachments).toHaveLength(2);
    });
  });

  describe('SpeakOnTriggerSchema', () => {
    it('should validate all triggers', () => {
      expect(SpeakOnTriggerSchema.parse('SESSION_END')).toBe('SESSION_END');
      expect(SpeakOnTriggerSchema.parse('CODE_WRITTEN')).toBe('CODE_WRITTEN');
      expect(SpeakOnTriggerSchema.parse('REVIEW_REQUEST')).toBe('REVIEW_REQUEST');
      expect(SpeakOnTriggerSchema.parse('EXPLICIT_ASK')).toBe('EXPLICIT_ASK');
      expect(SpeakOnTriggerSchema.parse('ALL_MESSAGES')).toBe('ALL_MESSAGES');
    });
  });

  describe('ShadowModeSchema', () => {
    it('should validate shadow modes', () => {
      expect(ShadowModeSchema.parse('subagent')).toBe('subagent');
      expect(ShadowModeSchema.parse('process')).toBe('process');
    });
  });

  describe('SpawnAgentRequestSchema', () => {
    it('should validate basic spawn request', () => {
      const request = {
        name: 'Worker1',
      };
      const result = SpawnAgentRequestSchema.parse(request);
      expect(result.name).toBe('Worker1');
    });

    it('should validate full spawn request', () => {
      const request = {
        name: 'ShadowAgent',
        cli: 'claude',
        task: 'Review code changes',
        team: 'backend',
        shadowMode: 'subagent',
        shadowOf: 'FullStack',
        shadowAgent: 'reviewer',
        shadowTriggers: ['CODE_WRITTEN', 'REVIEW_REQUEST'],
        shadowSpeakOn: ['SESSION_END'],
      };
      const result = SpawnAgentRequestSchema.parse(request);
      expect(result.shadowMode).toBe('subagent');
      expect(result.shadowOf).toBe('FullStack');
      expect(result.shadowTriggers).toHaveLength(2);
    });

    it('should validate non-shadow spawn request', () => {
      const request = {
        name: 'Backend',
        cli: 'codex',
        task: 'Build API endpoints',
        team: 'api',
      };
      const result = SpawnAgentRequestSchema.parse(request);
      expect(result.cli).toBe('codex');
      expect(result.shadowOf).toBeUndefined();
    });
  });

  describe('SpawnAgentResponseSchema', () => {
    it('should validate success response', () => {
      const response = {
        success: true,
        name: 'Worker1',
      };
      const result = SpawnAgentResponseSchema.parse(response);
      expect(result.success).toBe(true);
      expect(result.name).toBe('Worker1');
    });

    it('should validate error response', () => {
      const response = {
        success: false,
        name: 'Worker1',
        error: 'Agent already exists',
      };
      const result = SpawnAgentResponseSchema.parse(response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent already exists');
    });
  });

  describe('CreateTaskRequestSchema', () => {
    it('should validate complete task request', () => {
      const request = {
        agentName: 'FullStack',
        title: 'Implement feature X',
        description: 'Build the new feature',
        priority: 'high',
      };
      const result = CreateTaskRequestSchema.parse(request);
      expect(result.agentName).toBe('FullStack');
      expect(result.priority).toBe('high');
    });

    it('should validate task without description', () => {
      const request = {
        agentName: 'Worker',
        title: 'Quick fix',
        priority: 'critical',
      };
      const result = CreateTaskRequestSchema.parse(request);
      expect(result.description).toBeUndefined();
    });

    it('should reject invalid priority', () => {
      const request = {
        agentName: 'Worker',
        title: 'Task',
        priority: 'urgent',
      };
      expect(() => CreateTaskRequestSchema.parse(request)).toThrow();
    });
  });

  describe('CreateBeadRequestSchema', () => {
    it('should validate complete bead request', () => {
      const request = {
        title: 'New feature',
        assignee: 'FullStack',
        priority: 2,
        type: 'feature',
        description: 'Implement the new feature',
      };
      const result = CreateBeadRequestSchema.parse(request);
      expect(result.title).toBe('New feature');
      expect(result.priority).toBe(2);
      expect(result.type).toBe('feature');
    });

    it('should validate minimal bead request', () => {
      const request = {
        title: 'Bug fix',
      };
      const result = CreateBeadRequestSchema.parse(request);
      expect(result.assignee).toBeUndefined();
      expect(result.type).toBeUndefined();
    });

    it('should reject invalid bead type', () => {
      const request = {
        title: 'Task',
        type: 'epic',
      };
      expect(() => CreateBeadRequestSchema.parse(request)).toThrow();
    });
  });

  describe('SendRelayMessageRequestSchema', () => {
    it('should validate relay message', () => {
      const request = {
        to: 'Agent1',
        content: 'Hello from relay',
        thread: 'thread-456',
      };
      const result = SendRelayMessageRequestSchema.parse(request);
      expect(result.to).toBe('Agent1');
      expect(result.content).toBe('Hello from relay');
    });
  });

  describe('ActivityEventTypeSchema', () => {
    it('should validate all event types', () => {
      expect(ActivityEventTypeSchema.parse('agent_spawned')).toBe('agent_spawned');
      expect(ActivityEventTypeSchema.parse('agent_released')).toBe('agent_released');
      expect(ActivityEventTypeSchema.parse('agent_online')).toBe('agent_online');
      expect(ActivityEventTypeSchema.parse('agent_offline')).toBe('agent_offline');
      expect(ActivityEventTypeSchema.parse('user_joined')).toBe('user_joined');
      expect(ActivityEventTypeSchema.parse('user_left')).toBe('user_left');
      expect(ActivityEventTypeSchema.parse('broadcast')).toBe('broadcast');
      expect(ActivityEventTypeSchema.parse('error')).toBe('error');
    });
  });

  describe('ActorTypeSchema', () => {
    it('should validate actor types', () => {
      expect(ActorTypeSchema.parse('user')).toBe('user');
      expect(ActorTypeSchema.parse('agent')).toBe('agent');
      expect(ActorTypeSchema.parse('system')).toBe('system');
    });
  });

  describe('ActivityEventSchema', () => {
    it('should validate complete activity event', () => {
      const event = {
        id: 'event-001',
        type: 'agent_spawned',
        timestamp: '2025-01-22T10:00:00Z',
        actor: 'Lead',
        actorAvatarUrl: 'https://example.com/avatar.png',
        actorType: 'agent',
        title: 'Agent Worker spawned',
        description: 'New agent Worker was spawned by Lead',
        metadata: { cli: 'claude', team: 'backend' },
      };
      const result = ActivityEventSchema.parse(event);
      expect(result.type).toBe('agent_spawned');
      expect(result.actorType).toBe('agent');
      expect(result.metadata).toEqual({ cli: 'claude', team: 'backend' });
    });

    it('should validate user event', () => {
      const event = {
        id: 'event-002',
        type: 'user_joined',
        timestamp: '2025-01-22T09:00:00Z',
        actor: 'john@example.com',
        actorType: 'user',
        title: 'User joined',
      };
      const result = ActivityEventSchema.parse(event);
      expect(result.actorType).toBe('user');
      expect(result.description).toBeUndefined();
    });

    it('should validate system event', () => {
      const event = {
        id: 'event-003',
        type: 'error',
        timestamp: '2025-01-22T10:30:00Z',
        actor: 'system',
        actorType: 'system',
        title: 'Connection error',
        description: 'Failed to connect to remote server',
      };
      const result = ActivityEventSchema.parse(event);
      expect(result.type).toBe('error');
      expect(result.actorType).toBe('system');
    });
  });

  describe('WSMessageTypeSchema', () => {
    it('should validate message types', () => {
      expect(WSMessageTypeSchema.parse('data')).toBe('data');
      expect(WSMessageTypeSchema.parse('agents')).toBe('agents');
      expect(WSMessageTypeSchema.parse('messages')).toBe('messages');
      expect(WSMessageTypeSchema.parse('fleet')).toBe('fleet');
      expect(WSMessageTypeSchema.parse('error')).toBe('error');
    });
  });

  describe('WSMessageSchema', () => {
    it('should validate websocket message', () => {
      const message = {
        type: 'agents',
        payload: [{ name: 'Agent1', status: 'online' }],
      };
      const result = WSMessageSchema.parse(message);
      expect(result.type).toBe('agents');
    });

    it('should validate error message', () => {
      const message = {
        type: 'error',
        payload: { code: 'UNAUTHORIZED', message: 'Not logged in' },
      };
      const result = WSMessageSchema.parse(message);
      expect(result.type).toBe('error');
    });
  });

  describe('DashboardStateSchema', () => {
    it('should validate dashboard state', () => {
      const state = {
        agents: [{ name: 'Agent1', status: 'online' }],
        messages: [],
        currentChannel: '#general',
        currentThread: null,
        isConnected: true,
        viewMode: 'local',
        fleetData: null,
        sessions: [],
        summaries: [],
      };
      const result = DashboardStateSchema.parse(state);
      expect(result.currentChannel).toBe('#general');
      expect(result.isConnected).toBe(true);
      expect(result.viewMode).toBe('local');
    });

    it('should validate fleet view state', () => {
      const state = {
        agents: [],
        messages: [],
        currentChannel: '#fleet',
        currentThread: 'thread-123',
        isConnected: true,
        viewMode: 'fleet',
        fleetData: {
          servers: [],
          agents: [],
          totalMessages: 0,
        },
        sessions: [],
        summaries: [],
      };
      const result = DashboardStateSchema.parse(state);
      expect(result.viewMode).toBe('fleet');
      expect(result.currentThread).toBe('thread-123');
    });
  });
});
