import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpawnManager } from './spawn-manager.js';
import type { Envelope, SetModelPayload } from '@agent-relay/protocol/types';

/**
 * Mock connection that captures sent envelopes.
 */
function createMockConnection(agentName: string) {
  return {
    id: `conn-${agentName}`,
    agentName,
    sessionId: `session-${agentName}`,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function createSetModelEnvelope(
  name: string,
  model: string,
  timeoutMs?: number,
): Envelope<SetModelPayload> {
  return {
    v: 1,
    type: 'SET_MODEL',
    id: `env-${Date.now()}`,
    ts: Date.now(),
    payload: { name, model, timeoutMs },
  };
}

describe('SpawnManager.handleSetModel', () => {
  let manager: SpawnManager;
  let mockSetWorkerModel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    manager = new SpawnManager({
      projectRoot: '/tmp/test-project',
    });

    // Mock the spawner's setWorkerModel method
    mockSetWorkerModel = vi.fn();
    (manager as any).spawner.setWorkerModel = mockSetWorkerModel;
  });

  it('should send success result when model switch succeeds', async () => {
    const connection = createMockConnection('Lead');
    const envelope = createSetModelEnvelope('Worker1', 'haiku');

    mockSetWorkerModel.mockResolvedValue({
      success: true,
      previousModel: 'sonnet',
    });

    await manager.handleSetModel(connection as any, envelope);

    expect(mockSetWorkerModel).toHaveBeenCalledWith('Worker1', 'haiku', 30000);
    expect(connection.send).toHaveBeenCalledTimes(1);

    const result = connection.send.mock.calls[0][0];
    expect(result.type).toBe('SET_MODEL_RESULT');
    expect(result.payload.success).toBe(true);
    expect(result.payload.name).toBe('Worker1');
    expect(result.payload.model).toBe('haiku');
    expect(result.payload.previousModel).toBe('sonnet');
    expect(result.payload.error).toBeUndefined();
  });

  it('should send failure result when model switch fails', async () => {
    const connection = createMockConnection('Lead');
    const envelope = createSetModelEnvelope('Worker1', 'haiku');

    mockSetWorkerModel.mockResolvedValue({
      success: false,
      error: 'Agent "Worker1" did not become idle within 30000ms',
    });

    await manager.handleSetModel(connection as any, envelope);

    const result = connection.send.mock.calls[0][0];
    expect(result.type).toBe('SET_MODEL_RESULT');
    expect(result.payload.success).toBe(false);
    expect(result.payload.error).toContain('did not become idle');
  });

  it('should pass custom timeout from payload', async () => {
    const connection = createMockConnection('Lead');
    const envelope = createSetModelEnvelope('Worker1', 'opus', 60000);

    mockSetWorkerModel.mockResolvedValue({ success: true });

    await manager.handleSetModel(connection as any, envelope);

    expect(mockSetWorkerModel).toHaveBeenCalledWith('Worker1', 'opus', 60000);
  });

  it('should handle spawner throwing an error', async () => {
    const connection = createMockConnection('Lead');
    const envelope = createSetModelEnvelope('Worker1', 'opus');

    mockSetWorkerModel.mockRejectedValue(new Error('PTY process crashed'));

    await manager.handleSetModel(connection as any, envelope);

    const result = connection.send.mock.calls[0][0];
    expect(result.type).toBe('SET_MODEL_RESULT');
    expect(result.payload.success).toBe(false);
    expect(result.payload.error).toBe('PTY process crashed');
  });

  it('should send failure when agent not found', async () => {
    const connection = createMockConnection('Lead');
    const envelope = createSetModelEnvelope('NonExistent', 'haiku');

    mockSetWorkerModel.mockResolvedValue({
      success: false,
      error: 'Agent "NonExistent" not found',
    });

    await manager.handleSetModel(connection as any, envelope);

    const result = connection.send.mock.calls[0][0];
    expect(result.payload.success).toBe(false);
    expect(result.payload.error).toContain('not found');
  });

  it('should send failure for unsupported CLI', async () => {
    const connection = createMockConnection('Lead');
    const envelope = createSetModelEnvelope('CodexWorker', 'gpt-4o');

    mockSetWorkerModel.mockResolvedValue({
      success: false,
      error: 'CLI "codex" does not support mid-session model switching',
    });

    await manager.handleSetModel(connection as any, envelope);

    const result = connection.send.mock.calls[0][0];
    expect(result.payload.success).toBe(false);
    expect(result.payload.error).toContain('does not support');
  });
});
