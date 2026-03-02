import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { SpawnProvider, SpawnOptions, SpawnHandle } from './types.js';
import { normalizeModelRef } from '../identity/model.js';
import { buildIdentityTask } from '../identity/contract.js';
import { buildAgentName } from '../identity/naming.js';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function expandHomeDir(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function sanitizeContainerSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '') || 'claw';
}

export interface DockerSpawnProviderOptions {
  /** Docker image to use. Default: 'openclaw:local'. */
  image?: string;
  /** Fallback image if primary not found. Default: 'clawrunner-sandbox:latest'. */
  imageFallback?: string;
  /** Docker network mode. Default: 'bridge'. */
  networkMode?: string;
  /** Docker socket path. Default: '/var/run/docker.sock'. */
  socketPath?: string;
  /** Path to host codex auth.json. Default: ~/.codex/auth.json. */
  codexAuthFile?: string;
  /** Path to host codex config.toml. Default: ~/.codex/config.toml. */
  codexConfigFile?: string;
  /** Container home dir. Default: '/home/node'. */
  containerHome?: string;
  /**
   * Custom container command. If set, overrides the default entrypoint.
   * Use this for ClawRunner-managed images that have /opt/clawrunner/start-claw.sh.
   * Default: uses openclaw-relaycast runtime-setup + openclaw gateway + agent-relay broker-spawn.
   */
  containerCmd?: string[];
}

/**
 * Spawn OpenClaw instances as Docker containers.
 * Requires `dockerode` as an optional peer dependency — dynamically imported at runtime.
 *
 * By default, the container runs:
 *   1. `npx openclaw-relaycast runtime-setup` — auth conversion, config, identity files, dist patching
 *   2. `openclaw gateway` in background
 *   3. `agent-relay broker-spawn --from-env` as PID 1
 *
 * For ClawRunner-managed images, set containerCmd to ['/opt/clawrunner/start-claw.sh'].
 */
export class DockerSpawnProvider implements SpawnProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private docker: any = null;
  private readonly image: string;
  private readonly imageFallback: string;
  private readonly networkMode: string;
  private readonly socketPath: string;
  private readonly codexAuthFile: string;
  private readonly codexConfigFile: string;
  private readonly containerHome: string;
  private readonly containerCmd: string[] | null;
  private readonly handles = new Map<string, SpawnHandle>();

  constructor(options: DockerSpawnProviderOptions = {}) {
    this.image = options.image ?? process.env.CLAW_IMAGE ?? 'openclaw:local';
    this.imageFallback = options.imageFallback ?? process.env.CLAW_IMAGE_FALLBACK ?? 'clawrunner-sandbox:latest';
    this.networkMode = options.networkMode ?? process.env.CLAW_NETWORK ?? 'bridge';
    this.socketPath = options.socketPath ?? process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
    this.codexAuthFile = expandHomeDir(options.codexAuthFile ?? process.env.CLAW_CODEX_AUTH_FILE ?? '~/.codex/auth.json');
    this.codexConfigFile = expandHomeDir(options.codexConfigFile ?? process.env.CLAW_CODEX_CONFIG_FILE ?? '~/.codex/config.toml');
    this.containerHome = options.containerHome ?? process.env.CLAW_CONTAINER_HOME ?? '/home/node';
    this.containerCmd = options.containerCmd ?? (process.env.CLAW_CONTAINER_CMD
      ? process.env.CLAW_CONTAINER_CMD.split(' ')
      : null);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getDocker(): Promise<any> {
    if (this.docker) return this.docker;
    try {
      // @ts-expect-error dockerode is an optional dependency
      const mod = await import('dockerode');
      const Docker = mod.default ?? mod;
      this.docker = new Docker({ socketPath: this.socketPath });
      return this.docker;
    } catch {
      throw new Error(
        'dockerode is required for Docker spawning. Install it with: npm install dockerode',
      );
    }
  }

  /**
   * Build the default container entrypoint script.
   * This script works with any vanilla OpenClaw image that has `openclaw` and `node` on PATH.
   * It runs runtime-setup via the package CLI, starts the gateway, then hands off to broker-spawn.
   */
  private buildEntrypointScript(gatewayPort: number): string[] {
    // Shell script that runs setup, starts gateway, waits for health, then execs broker-spawn.
    // Uses sh -c so it works in minimal alpine images.
    // Runtime setup via package CLI, then gateway, then SDK's spawnFromEnv()
    // which handles broker + agent lifecycle without needing the agent-relay CLI.
    const script = [
      'set -e',
      // Runtime setup: auth conversion, openclaw.json, identity files, dist patching
      'npx openclaw-relaycast runtime-setup',
      // Resolve bridge.mjs from the installed package and symlink to the known AGENT_ARGS path.
      // This handles any npm install location (global, local, npx cache).
      'node -e "' +
        "const p = require('path');" +
        "const m = require('module');" +
        "const r = m.createRequire(require.resolve('openclaw-relaycast/package.json'));" +
        "const bp = p.join(p.dirname(require.resolve('openclaw-relaycast/package.json')), 'bridge', 'bridge.mjs');" +
        "require('fs').symlinkSync(bp, '/tmp/openclaw-bridge.mjs');" +
        "console.log('[entrypoint] Bridge resolved: ' + bp);" +
      '"',
      // Start gateway in background
      `openclaw gateway --port ${gatewayPort} --bind loopback --allow-unconfigured --auth token &`,
      // Wait for gateway health
      `for i in $(seq 1 30); do`,
      `  if openclaw health --port ${gatewayPort} 2>/dev/null; then break; fi`,
      `  if [ "$i" -eq 30 ]; then echo "Gateway failed to start" >&2; exit 1; fi`,
      `  sleep 1`,
      `done`,
      // Use SDK's spawnFromEnv() instead of shelling out to agent-relay CLI.
      // This reads AGENT_NAME, AGENT_CLI, RELAY_API_KEY etc. from env,
      // creates a broker internally, spawns the agent via PTY, and waits for exit.
      `node -e "import('@agent-relay/sdk').then(m => m.spawnFromEnv())"`,
    ].join('\n');

    return ['sh', '-c', script];
  }

  async spawn(options: SpawnOptions): Promise<SpawnHandle> {
    const docker = await this.getDocker();
    const modelRef = normalizeModelRef(options.model);
    const workspaceId = options.workspaceId ?? `local-${Date.now().toString(36)}`;
    const agentName = buildAgentName(workspaceId, options.name);
    const gatewayPort = 18789; // Internal to container — each container is isolated
    const identityTask = buildIdentityTask(agentName, workspaceId, modelRef);
    const channels = options.channels?.length ? options.channels : ['general'];
    const gatewayToken = randomUUID().replace(/-/g, '').slice(0, 32);

    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const containerName = `openclaw-${sanitizeContainerSegment(agentName)}-${suffix}`.slice(0, 63);

    const binds: string[] = [];
    if (options.workspacePath) {
      binds.push(`${options.workspacePath}:/workspace:rw`);
    }
    if (await pathExists(this.codexAuthFile)) {
      binds.push(`${this.codexAuthFile}:${this.containerHome}/.codex/auth.json:rw`);
    }
    if (await pathExists(this.codexConfigFile)) {
      binds.push(`${this.codexConfigFile}:${this.containerHome}/.codex/config.toml:ro`);
    }

    const envVars: Record<string, string> = {
      AGENT_NAME: agentName,
      AGENT_CLI: 'node',
      // Bridge path: resolved dynamically inside the container via the entrypoint script.
      // The entrypoint writes the resolved path to /tmp/bridge-path.txt after runtime-setup.
      AGENT_ARGS: '/tmp/openclaw-bridge.mjs',
      RELAY_API_KEY: options.relayApiKey,
      RELAY_BASE_URL: options.relayBaseUrl ?? '',
      AGENT_TASK: options.systemPrompt
        ? `${options.systemPrompt}\n\n${identityTask}`
        : identityTask,
      AGENT_CWD: '/workspace',
      AGENT_CHANNELS: channels.join(','),
      GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      OPENCLAW_WORKSPACE_ID: workspaceId,
      OPENCLAW_NAME: options.name,
      OPENCLAW_ROLE: options.role ?? 'general',
      OPENCLAW_MODEL: modelRef,
      BROKER_NO_REMOTE_SPAWN: '1',
    };

    // Try to remove stale container with same name
    try {
      const stale = docker.getContainer(containerName);
      await stale.stop({ t: 5 }).catch(() => {});
      await stale.remove({ force: true }).catch(() => {});
    } catch {
      // No stale container
    }

    let imageToUse = this.image;
    try {
      await docker.getImage(this.image).inspect();
    } catch {
      imageToUse = this.imageFallback;
    }

    // Use custom cmd if provided, otherwise generate a vanilla-compatible entrypoint
    const cmd = this.containerCmd ?? this.buildEntrypointScript(gatewayPort);

    const container = await docker.createContainer({
      Image: imageToUse,
      name: containerName,
      Env: Object.entries(envVars).map(([k, v]: [string, string]) => `${k}=${v}`),
      Cmd: cmd,
      WorkingDir: '/workspace',
      Labels: {
        'openclaw-relaycast.spawn': 'true',
        'openclaw-relaycast.agent': agentName,
      },
      HostConfig: {
        NetworkMode: this.networkMode,
        Binds: binds,
        AutoRemove: false,
      },
    });

    await container.start();

    const handle: SpawnHandle = {
      id: container.id,
      displayName: options.name,
      agentName,
      gatewayPort,
      destroy: () => this.destroy(container.id),
    };

    this.handles.set(container.id, handle);
    return handle;
  }

  async destroy(id: string): Promise<void> {
    this.handles.delete(id);
    try {
      const docker = await this.getDocker();
      const container = docker.getContainer(id);
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
    } catch {
      // Already gone
    }
  }

  async list(): Promise<SpawnHandle[]> {
    return Array.from(this.handles.values());
  }
}
