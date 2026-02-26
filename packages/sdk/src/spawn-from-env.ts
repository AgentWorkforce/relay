/**
 * Canonical spawn-from-env module.
 *
 * Single source of truth for environment-driven agent spawning with
 * SDK-owned bypass policy. Cloud callers set env vars and invoke
 * `spawnFromEnv()` — no custom bypass logic, no spawn scripts.
 *
 * @example
 * ```ts
 * import { spawnFromEnv } from "@agent-relay/sdk";
 * await spawnFromEnv(); // reads AGENT_NAME, AGENT_CLI, etc. from process.env
 * ```
 */

import { AgentRelay } from './relay.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SpawnEnvInput {
  AGENT_NAME: string;
  AGENT_CLI: string;
  RELAY_API_KEY: string;
  AGENT_TASK?: string;
  /** JSON array preferred, space-delimited fallback */
  AGENT_ARGS?: string;
  AGENT_CWD?: string;
  /** Comma-separated channel list, defaults to "general" */
  AGENT_CHANNELS?: string;
  RELAY_BASE_URL?: string;
  BROKER_BINARY_PATH?: string;
  /** Model override (e.g. "opus", "sonnet") */
  AGENT_MODEL?: string;
  /** "1" disables SDK default bypass flags */
  AGENT_DISABLE_DEFAULT_BYPASS?: string;
}

export interface SpawnPolicyResult {
  name: string;
  cli: string;
  args: string[];
  channels: string[];
  task?: string;
  cwd?: string;
  model?: string;
  bypassApplied: boolean;
}

export interface SpawnFromEnvOptions {
  /** Override env source (defaults to process.env) */
  env?: Record<string, string | undefined>;
  /** Override binary path */
  binaryPath?: string;
  /** Override broker name */
  brokerName?: string;
}

export interface SpawnFromEnvResult {
  exitReason: string;
  exitCode?: number;
}

// ── Bypass Policy (SDK-owned, single source of truth) ──────────────────────

/** SDK-owned bypass flag mapping. Cloud must NOT duplicate these. */
const BYPASS_FLAGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions',
  codex: '--full-auto',
};

/**
 * Resolve the bypass flag for a CLI.
 * Handles `claude:model` variants (e.g. `claude:opus`).
 */
function getBypassFlag(cli: string): string | undefined {
  const baseCli = cli.includes(':') ? cli.split(':')[0] : cli;
  return BYPASS_FLAGS[baseCli];
}

// ── Env Parsing ────────────────────────────────────────────────────────────

/**
 * Parse and validate spawn environment variables.
 * Throws with a clear message on missing required keys.
 */
export function parseSpawnEnv(env: Record<string, string | undefined> = process.env): SpawnEnvInput {
  const AGENT_NAME = env.AGENT_NAME;
  const AGENT_CLI = env.AGENT_CLI;
  const RELAY_API_KEY = env.RELAY_API_KEY;

  const missing: string[] = [];
  if (!AGENT_NAME) missing.push('AGENT_NAME');
  if (!AGENT_CLI) missing.push('AGENT_CLI');
  if (!RELAY_API_KEY) missing.push('RELAY_API_KEY');

  if (missing.length > 0) {
    throw new Error(`[spawn-from-env] Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    AGENT_NAME: AGENT_NAME!,
    AGENT_CLI: AGENT_CLI!,
    RELAY_API_KEY: RELAY_API_KEY!,
    AGENT_TASK: env.AGENT_TASK || undefined,
    AGENT_ARGS: env.AGENT_ARGS || undefined,
    AGENT_CWD: env.AGENT_CWD || undefined,
    AGENT_CHANNELS: env.AGENT_CHANNELS || undefined,
    RELAY_BASE_URL: env.RELAY_BASE_URL || undefined,
    BROKER_BINARY_PATH: env.BROKER_BINARY_PATH || undefined,
    AGENT_MODEL: env.AGENT_MODEL || undefined,
    AGENT_DISABLE_DEFAULT_BYPASS: env.AGENT_DISABLE_DEFAULT_BYPASS || undefined,
  };
}

// ── Policy Resolution ──────────────────────────────────────────────────────

/**
 * Parse extra args from env. Supports JSON array or space-delimited string.
 */
function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to space-delimited
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Resolve the full spawn policy from parsed env input.
 * Applies bypass flags unless disabled or already present.
 */
export function resolveSpawnPolicy(input: SpawnEnvInput): SpawnPolicyResult {
  const extraArgs = parseArgs(input.AGENT_ARGS);
  const channels = input.AGENT_CHANNELS
    ? input.AGENT_CHANNELS.split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : ['general'];

  const disableBypass = input.AGENT_DISABLE_DEFAULT_BYPASS === '1';
  const bypassFlag = getBypassFlag(input.AGENT_CLI);

  let bypassApplied = false;
  const args = [...extraArgs];

  if (bypassFlag && !disableBypass && !args.includes(bypassFlag)) {
    args.push(bypassFlag);
    bypassApplied = true;
  }

  return {
    name: input.AGENT_NAME,
    cli: input.AGENT_CLI,
    args,
    channels,
    task: input.AGENT_TASK,
    cwd: input.AGENT_CWD,
    model: input.AGENT_MODEL,
    bypassApplied,
  };
}

// ── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Spawn an agent from environment variables.
 *
 * Reads AGENT_NAME, AGENT_CLI, RELAY_API_KEY (required) plus optional
 * AGENT_TASK, AGENT_ARGS, AGENT_CWD, AGENT_CHANNELS, AGENT_MODEL from
 * the environment.
 *
 * Applies canonical bypass flags (claude -> --dangerously-skip-permissions,
 * codex -> --full-auto) unless AGENT_DISABLE_DEFAULT_BYPASS=1.
 *
 * Creates a broker, spawns the agent via PTY, and waits for exit.
 * Returns the exit reason and exit code.
 */
export async function spawnFromEnv(options: SpawnFromEnvOptions = {}): Promise<SpawnFromEnvResult> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const parsed = parseSpawnEnv(env);
  const policy = resolveSpawnPolicy(parsed);

  console.log(
    `[spawn-from-env] Spawning agent: name=${policy.name} cli=${policy.cli} ` +
      `channels=${policy.channels.join(',')} bypass=${policy.bypassApplied}`
  );
  if (policy.task) {
    console.log(
      `[spawn-from-env] Task: ${policy.task.slice(0, 200)}${policy.task.length > 200 ? '...' : ''}`
    );
  }

  const relay = new AgentRelay({
    binaryPath: options.binaryPath ?? parsed.BROKER_BINARY_PATH,
    brokerName: options.brokerName ?? `broker-${policy.name}`,
    channels: policy.channels,
    cwd: policy.cwd ?? process.cwd(),
    env: env as NodeJS.ProcessEnv,
  });

  relay.onAgentSpawned = (agent) => {
    console.log(`[spawn-from-env] Agent spawned: ${agent.name}`);
  };
  relay.onAgentReady = (agent) => {
    console.log(`[spawn-from-env] Agent ready: ${agent.name}`);
  };
  relay.onAgentExited = (agent) => {
    console.log(
      `[spawn-from-env] Agent exited: ${agent.name} ` +
        `code=${agent.exitCode ?? 'none'} signal=${agent.exitSignal ?? 'none'}`
    );
  };

  try {
    const agent = await relay.spawnPty({
      name: policy.name,
      cli: policy.cli,
      args: policy.args,
      channels: policy.channels,
      task: policy.task,
    });

    const exitReason = await agent.waitForExit();
    console.log(`[spawn-from-env] Exit reason: ${exitReason}`);

    return { exitReason, exitCode: agent.exitCode };
  } catch (err) {
    console.error(`[spawn-from-env] Error:`, err);
    throw err;
  } finally {
    await relay.shutdown();
  }
}
