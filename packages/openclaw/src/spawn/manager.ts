import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import type { SpawnProvider, SpawnOptions, SpawnHandle } from './types.js';
import { DockerSpawnProvider } from './docker.js';
import { ProcessSpawnProvider } from './process.js';

export type SpawnMode = 'process' | 'docker';

/** Default maximum number of concurrent spawns per manager. */
const DEFAULT_MAX_SPAWNS = 10;

/** Default maximum spawn depth (prevents recursive spawn chains). */
const DEFAULT_MAX_SPAWN_DEPTH = 3;

interface PersistedSpawn {
  id: string;
  displayName: string;
  agentName: string;
  gatewayPort: number;
  spawnedAt: string;
}

interface SpawnsState {
  spawns: PersistedSpawn[];
}

/**
 * Detect whether Docker is available by checking if the socket exists.
 * Used to auto-select spawn mode when not explicitly configured.
 */
function isDockerAvailable(): boolean {
  const socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
  return existsSync(socketPath);
}

/**
 * SpawnManager — tracks active spawns and provides a unified interface
 * for spawning, listing, and releasing OpenClaw instances.
 *
 * Security controls:
 *   - maxSpawns: Maximum concurrent spawns (default: 10)
 *   - maxDepth: Maximum spawn depth to prevent recursive chains (default: 3)
 *   - Persistent state in spawns.json for recovery on restart
 */
export class SpawnManager {
  private readonly provider: SpawnProvider;
  private readonly handles = new Map<string, SpawnHandle>();
  private readonly maxSpawns: number;
  private readonly maxDepth: number;
  private readonly stateFile: string;
  private currentDepth: number;

  constructor(options?: {
    mode?: SpawnMode;
    maxSpawns?: number;
    maxDepth?: number;
    spawnDepth?: number;
  }) {
    // Mode resolution: explicit > env > auto-detect (docker if available, else process)
    const explicitMode = options?.mode ?? (process.env.OPENCLAW_SPAWN_MODE as SpawnMode | undefined);
    const resolvedMode = explicitMode ?? (isDockerAvailable() ? 'docker' : 'process');

    this.provider = resolvedMode === 'docker'
      ? new DockerSpawnProvider()
      : new ProcessSpawnProvider();

    this.maxSpawns = options?.maxSpawns
      ?? Number(process.env.OPENCLAW_MAX_SPAWNS || DEFAULT_MAX_SPAWNS);
    this.maxDepth = options?.maxDepth
      ?? Number(process.env.OPENCLAW_MAX_SPAWN_DEPTH || DEFAULT_MAX_SPAWN_DEPTH);
    this.currentDepth = options?.spawnDepth
      ?? Number(process.env.OPENCLAW_SPAWN_DEPTH || 0);
    this.stateFile = join(homedir(), '.openclaw', 'workspace', 'relaycast', 'spawns.json');
  }

  async spawn(options: SpawnOptions): Promise<SpawnHandle> {
    // Enforce spawn depth limit — prevents recursive spawn chains
    if (this.currentDepth >= this.maxDepth) {
      throw new Error(
        `Spawn depth limit reached (${this.maxDepth}). ` +
        'Cannot spawn from a spawn chain this deep. Set OPENCLAW_MAX_SPAWN_DEPTH to increase.',
      );
    }

    // Enforce concurrent spawn limit
    if (this.handles.size >= this.maxSpawns) {
      throw new Error(
        `Maximum concurrent spawns reached (${this.maxSpawns}). ` +
        'Release an existing OpenClaw before spawning a new one. Set OPENCLAW_MAX_SPAWNS to increase.',
      );
    }

    // Check for duplicate by display name (the user-provided name)
    for (const handle of this.handles.values()) {
      if (handle.displayName === options.name) {
        throw new Error(`OpenClaw "${options.name}" is already running (id: ${handle.id})`);
      }
    }

    const handle = await this.provider.spawn(options);
    this.handles.set(handle.id, handle);
    await this.persistState();
    return handle;
  }

  async release(id: string): Promise<boolean> {
    const handle = this.handles.get(id);
    if (!handle) return false;
    await handle.destroy();
    this.handles.delete(id);
    await this.persistState();
    return true;
  }

  async releaseByName(name: string): Promise<boolean> {
    for (const [id, handle] of this.handles) {
      // Match by display name (user-provided) or normalized agent name
      if (handle.displayName === name || handle.agentName === name) {
        await handle.destroy();
        this.handles.delete(id);
        await this.persistState();
        return true;
      }
    }
    return false;
  }

  async releaseAll(): Promise<void> {
    const ids = Array.from(this.handles.keys());
    await Promise.allSettled(ids.map((id) => this.release(id)));
  }

  list(): SpawnHandle[] {
    return Array.from(this.handles.values());
  }

  get(id: string): SpawnHandle | undefined {
    return this.handles.get(id);
  }

  get size(): number {
    return this.handles.size;
  }

  /** Persist spawn state to disk for recovery. */
  private async persistState(): Promise<void> {
    try {
      const dir = join(homedir(), '.openclaw', 'workspace', 'relaycast');
      await mkdir(dir, { recursive: true });

      const state: SpawnsState = {
        spawns: Array.from(this.handles.values()).map((h) => ({
          id: h.id,
          displayName: h.displayName,
          agentName: h.agentName,
          gatewayPort: h.gatewayPort,
          spawnedAt: new Date().toISOString(),
        })),
      };

      await writeFile(this.stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch {
      // Best-effort persistence — don't crash if we can't write
    }
  }

  /** Load persisted state (for display/diagnostics only — processes can't be recovered). */
  async loadPersistedState(): Promise<PersistedSpawn[]> {
    try {
      if (!existsSync(this.stateFile)) return [];
      const raw = await readFile(this.stateFile, 'utf8');
      const state: SpawnsState = JSON.parse(raw);
      return state.spawns ?? [];
    } catch {
      return [];
    }
  }
}
