import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpawnManager } from '../spawn/manager.js';

// Mock the spawn providers
vi.mock('../spawn/docker.js', () => ({
  DockerSpawnProvider: vi.fn().mockImplementation(() => ({
    spawn: vi.fn().mockResolvedValue({
      id: 'test-id-1',
      displayName: 'test-claw',
      agentName: 'claw-ws123-test-claw',
      gatewayPort: 18789,
      destroy: vi.fn().mockResolvedValue(undefined),
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../spawn/process.js', () => ({
  ProcessSpawnProvider: vi.fn().mockImplementation(() => ({
    spawn: vi.fn().mockResolvedValue({
      id: 'test-id-1',
      displayName: 'test-claw',
      agentName: 'claw-ws123-test-claw',
      gatewayPort: 18790,
      destroy: vi.fn().mockResolvedValue(undefined),
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock fs operations
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{"spawns":[]}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

describe('SpawnManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default values', () => {
    const manager = new SpawnManager({ mode: 'process' });
    expect(manager.size).toBe(0);
  });

  it('should enforce maxSpawns limit', async () => {
    const manager = new SpawnManager({ mode: 'process', maxSpawns: 1 });

    // First spawn should succeed
    await manager.spawn({
      name: 'claw-1',
      relayApiKey: 'rk_live_test',
    });

    expect(manager.size).toBe(1);

    // Second spawn should fail due to limit
    await expect(manager.spawn({
      name: 'claw-2',
      relayApiKey: 'rk_live_test',
    })).rejects.toThrow(/Maximum concurrent spawns reached/);
  });

  it('should enforce maxDepth limit', async () => {
    const manager = new SpawnManager({
      mode: 'process',
      maxDepth: 2,
      spawnDepth: 2,  // Already at max depth
    });

    await expect(manager.spawn({
      name: 'claw-1',
      relayApiKey: 'rk_live_test',
    })).rejects.toThrow(/Spawn depth limit reached/);
  });

  it('should prevent duplicate spawns by name', async () => {
    const manager = new SpawnManager({ mode: 'process' });

    await manager.spawn({
      name: 'researcher',
      relayApiKey: 'rk_live_test',
    });

    await expect(manager.spawn({
      name: 'researcher',
      relayApiKey: 'rk_live_test',
    })).rejects.toThrow(/already running/);
  });

  it('should list spawned handles', async () => {
    const manager = new SpawnManager({ mode: 'process' });

    await manager.spawn({
      name: 'worker-1',
      relayApiKey: 'rk_live_test',
    });

    const list = manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('test-claw');
  });

  it('should release by id', async () => {
    const manager = new SpawnManager({ mode: 'process' });

    const handle = await manager.spawn({
      name: 'worker-1',
      relayApiKey: 'rk_live_test',
    });

    expect(manager.size).toBe(1);

    const released = await manager.release(handle.id);
    expect(released).toBe(true);
    expect(manager.size).toBe(0);
  });

  it('should release by name', async () => {
    const manager = new SpawnManager({ mode: 'process' });

    await manager.spawn({
      name: 'worker-1',
      relayApiKey: 'rk_live_test',
    });

    const released = await manager.releaseByName('test-claw');
    expect(released).toBe(true);
    expect(manager.size).toBe(0);
  });

  it('should return false when releasing non-existent spawn', async () => {
    const manager = new SpawnManager({ mode: 'process' });

    const released = await manager.release('non-existent-id');
    expect(released).toBe(false);
  });
});
