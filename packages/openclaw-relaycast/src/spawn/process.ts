import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { AgentRelay } from '@agent-relay/sdk';

import type { SpawnProvider, SpawnOptions, SpawnHandle } from './types.js';
import { normalizeModelRef } from '../identity/model.js';
import { buildIdentityTask } from '../identity/contract.js';
import { buildAgentName } from '../identity/naming.js';
import { ensureWorkspace } from '../identity/files.js';
import { convertCodexAuth } from '../auth/converter.js';
import { writeOpenClawConfig } from '../runtime/openclaw-config.js';
import { patchOpenClawDist, clearJitCache } from '../runtime/patch.js';

interface ProcessHandle extends SpawnHandle {
  /** The gateway child process. */
  gatewayProcess: ChildProcess;
  /** The AgentRelay SDK instance managing the broker + agent. */
  relay: AgentRelay | null;
}

/**
 * Find a free port by briefly binding to port 0 and reading the OS-assigned port.
 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to get ephemeral port'));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Spawn OpenClaw instances as local child processes.
 * No Docker required — simplest local mode.
 *
 * Each spawn:
 *   1. Starts `openclaw gateway` on an OS-assigned free port
 *   2. Uses AgentRelay SDK to spawn a broker + bridge agent connected to the gateway
 */
export class ProcessSpawnProvider implements SpawnProvider {
  private readonly handles = new Map<string, ProcessHandle>();

  async spawn(options: SpawnOptions): Promise<SpawnHandle> {
    const workspaceId = options.workspaceId ?? `local-${Date.now().toString(36)}`;
    const agentName = buildAgentName(workspaceId, options.name);
    const channels = options.channels?.length ? options.channels : ['general'];
    const gatewayToken = randomUUID().replace(/-/g, '').slice(0, 32);

    // Find a free port via OS allocation
    const port = await findFreePort();

    // Convert auth + write config
    const { preferredProvider } = await convertCodexAuth();
    const resolvedModel = normalizeModelRef(options.model, preferredProvider);
    const identityTask = buildIdentityTask(agentName, workspaceId, resolvedModel);

    // Ensure workspace — each spawn gets its own isolated directory
    const workspacePath = options.workspacePath ?? join(homedir(), '.openclaw', 'spawns', options.name);
    await mkdir(workspacePath, { recursive: true });

    // Write config to a per-spawn isolated directory (not shared ~/.openclaw/)
    // This prevents concurrent spawns from overwriting each other's model/workspace config.
    const spawnHome = join(homedir(), '.openclaw', 'spawns', options.name, '.openclaw');
    await writeOpenClawConfig({
      modelRef: resolvedModel,
      openclawHome: spawnHome,
    });

    await ensureWorkspace({
      workspacePath,
      workspaceId,
      clawName: options.name,
      role: options.role,
      modelRef: resolvedModel,
    });

    // Patch dist if available (best-effort)
    await patchOpenClawDist('/usr/lib/node_modules/openclaw/dist', resolvedModel);
    await clearJitCache();

    // Start openclaw gateway
    const gatewayProcess = cpSpawn(
      'openclaw',
      ['gateway', '--port', String(port), '--bind', 'loopback', '--allow-unconfigured', '--auth', 'token'],
      {
        env: {
          ...process.env,
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
          OPENCLAW_MODEL: resolvedModel,
          OPENCLAW_NAME: options.name,
          OPENCLAW_WORKSPACE_ID: workspaceId,
          OPENCLAW_HOME: spawnHome,
        },
        cwd: workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    gatewayProcess.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[spawn:${options.name}:gateway] ${data}`);
    });

    // Wait for gateway to be healthy. If it fails, kill the gateway.
    try {
      await waitForGateway(port, 30);
    } catch (err) {
      gatewayProcess.kill('SIGTERM');
      throw err;
    }

    // Use AgentRelay SDK to spawn the broker + bridge agent.
    // This replaces shelling out to `agent-relay broker-spawn --from-env`.
    const bridgePath = resolvePackageBridgePath();
    let relay: AgentRelay | null = null;

    try {
      relay = new AgentRelay({
        brokerName: `broker-${agentName}`,
        channels,
        cwd: workspacePath,
        env: {
          ...process.env,
          GATEWAY_PORT: String(port),
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
          OPENCLAW_WORKSPACE_ID: workspaceId,
          OPENCLAW_NAME: options.name,
          OPENCLAW_ROLE: options.role ?? 'general',
          OPENCLAW_MODEL: resolvedModel,
          RELAY_API_KEY: options.relayApiKey,
          RELAY_BASE_URL: options.relayBaseUrl ?? '',
          BROKER_NO_REMOTE_SPAWN: '1',
        } as NodeJS.ProcessEnv,
      });

      await relay.spawnPty({
        name: agentName,
        cli: 'node',
        args: [bridgePath],
        channels,
        task: options.systemPrompt
          ? `${options.systemPrompt}\n\n${identityTask}`
          : identityTask,
      });

      relay.onAgentExited = (agent) => {
        process.stderr.write(`[spawn:${options.name}] Agent exited: ${agent.name} code=${agent.exitCode ?? 'none'}\n`);
      };
    } catch (err) {
      // If SDK broker spawn fails, clean up gateway and propagate
      gatewayProcess.kill('SIGTERM');
      if (relay) {
        await relay.shutdown().catch(() => {});
      }
      throw new Error(
        `Failed to start broker for "${options.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const handle: ProcessHandle = {
      id: `proc-${options.name}-${port}`,
      displayName: options.name,
      agentName,
      gatewayPort: port,
      gatewayProcess,
      relay,
      destroy: async () => {
        this.handles.delete(handle.id);
        // Shutdown relay (broker + agent) first via SDK
        if (relay) {
          await relay.shutdown().catch(() => {});
        }
        // Then kill gateway
        gatewayProcess.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 2000));
        if (!gatewayProcess.killed) gatewayProcess.kill('SIGKILL');
      },
    };

    this.handles.set(handle.id, handle);
    return handle;
  }

  async destroy(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (handle) {
      await handle.destroy();
    }
  }

  async list(): Promise<SpawnHandle[]> {
    return Array.from(this.handles.values()).map(({ id, displayName, agentName, gatewayPort, destroy }) => ({
      id,
      displayName,
      agentName,
      gatewayPort,
      destroy,
    }));
  }
}

/**
 * Wait for the OpenClaw gateway to become healthy via the CLI health check.
 */
async function waitForGateway(port: number, timeoutSeconds: number): Promise<void> {
  for (let i = 0; i < timeoutSeconds; i++) {
    try {
      const result = cpSpawn('openclaw', ['health', '--port', String(port)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const code = await new Promise<number | null>((resolve) => {
        result.on('close', resolve);
        result.on('error', () => resolve(1));
      });
      if (code === 0) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`OpenClaw gateway on port ${port} failed to start after ${timeoutSeconds}s`);
}

/**
 * Resolve the path to bridge.mjs bundled with this package.
 */
function resolvePackageBridgePath(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return join(dirname(thisFile), '..', '..', 'bridge', 'bridge.mjs');
  } catch {
    return join(process.cwd(), 'node_modules', 'openclaw-relaycast', 'bridge', 'bridge.mjs');
  }
}
