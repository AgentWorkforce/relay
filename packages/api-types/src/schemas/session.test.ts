import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  SessionSchema,
  type Session,
} from './session.js';

describe('SessionSchema', () => {
  it('accepts minimal valid session', () => {
    const session: Session = {
      id: 'session-123',
      agentName: 'TestAgent',
      startedAt: '2024-01-01T00:00:00Z',
      messageCount: 0,
      isActive: true,
    };
    const result = SessionSchema.parse(session);
    expect(result.id).toBe('session-123');
    expect(result.agentName).toBe('TestAgent');
    expect(result.isActive).toBe(true);
  });

  it('accepts session with all optional fields', () => {
    const session: Session = {
      id: 'session-456',
      agentName: 'FullAgent',
      cli: 'claude',
      startedAt: '2024-01-01T00:00:00Z',
      endedAt: '2024-01-01T01:00:00Z',
      duration: '1 hour',
      messageCount: 42,
      summary: 'Completed feature implementation',
      isActive: false,
      closedBy: 'agent',
    };
    const result = SessionSchema.parse(session);
    expect(result.cli).toBe('claude');
    expect(result.endedAt).toBe('2024-01-01T01:00:00Z');
    expect(result.closedBy).toBe('agent');
  });

  it('accepts all closedBy values', () => {
    const base = {
      id: '1',
      agentName: 'Test',
      startedAt: '2024-01-01',
      messageCount: 0,
      isActive: false,
    };

    expect(SessionSchema.parse({ ...base, closedBy: 'agent' }).closedBy).toBe('agent');
    expect(SessionSchema.parse({ ...base, closedBy: 'disconnect' }).closedBy).toBe('disconnect');
    expect(SessionSchema.parse({ ...base, closedBy: 'error' }).closedBy).toBe('error');
  });

  it('rejects session without required id', () => {
    expect(() =>
      SessionSchema.parse({
        agentName: 'Test',
        startedAt: '2024-01-01',
        messageCount: 0,
        isActive: true,
      })
    ).toThrow();
  });

  it('rejects session without required agentName', () => {
    expect(() =>
      SessionSchema.parse({
        id: '1',
        startedAt: '2024-01-01',
        messageCount: 0,
        isActive: true,
      })
    ).toThrow();
  });

  it('rejects invalid closedBy value', () => {
    expect(() =>
      SessionSchema.parse({
        id: '1',
        agentName: 'Test',
        startedAt: '2024-01-01',
        messageCount: 0,
        isActive: false,
        closedBy: 'invalid',
      })
    ).toThrow();
  });
});

describe('Type inference', () => {
  it('infers Session type correctly', () => {
    const session: Session = {
      id: '1',
      agentName: 'Test',
      startedAt: '2024-01-01',
      messageCount: 0,
      isActive: true,
    };
    const parsed: z.infer<typeof SessionSchema> = SessionSchema.parse(session);
    expect(parsed.agentName).toBe('Test');
  });
});
