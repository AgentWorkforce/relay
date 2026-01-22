import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AgentStatusSchema,
  AgentProfileSchema,
  AgentSchema,
  AgentSummarySchema,
  type Agent,
  type AgentProfile,
  type AgentSummary,
} from './agent.js';

describe('AgentStatusSchema', () => {
  it('accepts valid status values', () => {
    expect(AgentStatusSchema.parse('online')).toBe('online');
    expect(AgentStatusSchema.parse('idle')).toBe('idle');
    expect(AgentStatusSchema.parse('busy')).toBe('busy');
    expect(AgentStatusSchema.parse('offline')).toBe('offline');
  });

  it('rejects invalid status values', () => {
    expect(() => AgentStatusSchema.parse('unknown')).toThrow();
    expect(() => AgentStatusSchema.parse('')).toThrow();
    expect(() => AgentStatusSchema.parse(123)).toThrow();
  });
});

describe('AgentProfileSchema', () => {
  it('accepts valid profile with all fields', () => {
    const profile = {
      title: 'Lead Developer',
      description: 'Coordinates team work',
      spawnPrompt: 'You are a lead developer',
      personaPrompt: 'Be helpful and thorough',
      personaName: 'lead',
      model: 'claude-3-opus',
      workingDirectory: '/project',
      firstSeen: '2024-01-01T00:00:00Z',
      capabilities: ['code', 'review'],
      tags: ['backend', 'senior'],
    };
    const result = AgentProfileSchema.parse(profile);
    expect(result).toEqual(profile);
  });

  it('accepts empty profile object', () => {
    const result = AgentProfileSchema.parse({});
    expect(result).toEqual({});
  });

  it('accepts profile with partial fields', () => {
    const profile = {
      title: 'Reviewer',
      model: 'gpt-4',
    };
    const result = AgentProfileSchema.parse(profile);
    expect(result.title).toBe('Reviewer');
    expect(result.model).toBe('gpt-4');
    expect(result.description).toBeUndefined();
  });
});

describe('AgentSchema', () => {
  it('accepts minimal valid agent', () => {
    const agent = {
      name: 'TestAgent',
      status: 'online',
    };
    const result = AgentSchema.parse(agent);
    expect(result.name).toBe('TestAgent');
    expect(result.status).toBe('online');
  });

  it('accepts agent with all optional fields', () => {
    const agent: Agent = {
      name: 'FullAgent',
      status: 'busy',
      role: 'developer',
      cli: 'claude',
      lastSeen: '2024-01-01T00:00:00Z',
      lastActive: '2024-01-01T00:00:00Z',
      messageCount: 42,
      needsAttention: true,
      currentTask: 'Implementing feature',
      server: 'server-1',
      isProcessing: true,
      processingStartedAt: 1704067200000,
      isSpawned: true,
      team: 'backend-team',
      agentId: 'agent-123',
      lastMessageReceivedAt: 1704067200000,
      lastOutputAt: 1704067200000,
      isStuck: false,
      isHuman: false,
      avatarUrl: 'https://example.com/avatar.png',
      authRevoked: false,
      isLocal: true,
      daemonName: 'local-daemon',
      machineId: 'machine-123',
      profile: {
        title: 'Developer',
        model: 'claude-3-opus',
      },
    };
    const result = AgentSchema.parse(agent);
    expect(result).toEqual(agent);
  });

  it('rejects agent without required name', () => {
    expect(() =>
      AgentSchema.parse({ status: 'online' })
    ).toThrow();
  });

  it('rejects agent without required status', () => {
    expect(() =>
      AgentSchema.parse({ name: 'Test' })
    ).toThrow();
  });

  it('rejects agent with invalid status', () => {
    expect(() =>
      AgentSchema.parse({ name: 'Test', status: 'invalid' })
    ).toThrow();
  });
});

describe('AgentSummarySchema', () => {
  it('accepts valid agent summary', () => {
    const summary: AgentSummary = {
      agentName: 'TestAgent',
      lastUpdated: '2024-01-01T00:00:00Z',
      currentTask: 'Working on feature',
      completedTasks: ['Task 1', 'Task 2'],
      context: 'Backend development',
      files: ['src/index.ts', 'src/utils.ts'],
    };
    const result = AgentSummarySchema.parse(summary);
    expect(result).toEqual(summary);
  });

  it('accepts minimal agent summary', () => {
    const summary = {
      agentName: 'TestAgent',
      lastUpdated: '2024-01-01T00:00:00Z',
    };
    const result = AgentSummarySchema.parse(summary);
    expect(result.agentName).toBe('TestAgent');
    expect(result.currentTask).toBeUndefined();
  });
});

describe('Type inference', () => {
  it('infers Agent type correctly', () => {
    // This test verifies TypeScript type inference
    const agent: Agent = {
      name: 'Test',
      status: 'online',
    };
    // Type assertion to verify inference
    const parsed: z.infer<typeof AgentSchema> = AgentSchema.parse(agent);
    expect(parsed.name).toBe('Test');
  });
});
