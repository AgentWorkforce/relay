import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn as spawnProcess, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { RelayCast } from '@relaycast/sdk';

import { detectOpenClaw, saveGatewayConfig } from './config.js';
import { InboundGateway } from './gateway.js';
import { DEFAULT_OPENCLAW_GATEWAY_PORT, type GatewayConfig } from './types.js';

/**
 * Safely traverse a nested object by dot-separated path.
 * Returns undefined if any segment is missing.
 */
function extractNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Set a deeply nested value in an object by dot-separated path, creating
 * intermediate objects as needed.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Resolve how to invoke mcporter. Prefers a global binary, falls back to npx.
 */
function resolveMcporter(): { cmd: string; prefix: string[] } {
  try {
    execFileSync('mcporter', ['--version'], { stdio: 'pipe' });
    return { cmd: 'mcporter', prefix: [] };
  } catch {
    // Global binary not found — try npx (no timeout; cold-cache downloads can be slow)
    try {
      execFileSync('npx', ['-y', 'mcporter', '--version'], { stdio: 'pipe' });
      return { cmd: 'npx', prefix: ['-y', 'mcporter'] };
    } catch {
      throw new Error('mcporter not found (tried global binary and npx)');
    }
  }
}

/** Check if a port is already in use by attempting a TCP connection. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export interface SetupOptions {
  /** If provided, join this workspace. Otherwise create a new one. */
  apiKey?: string;
  /** Name for this claw (default: hostname). */
  clawName?: string;
  /** Channels to auto-join (default: ['general']). */
  channels?: string[];
  /** Relaycast API base URL. */
  baseUrl?: string;
}

export interface SetupResult {
  ok: boolean;
  apiKey: string;
  clawName: string;
  skillDir: string;
  message: string;
}

/**
 * Install the Relaycast bridge into an OpenClaw workspace.
 *
 * 1. Detect OpenClaw installation
 * 2. Create/join workspace via Relaycast API (if no key provided)
 * 3. Install SKILL.md
 * 4. Write .env config
 * 5. Configure MCP server in openclaw.json
 * 6. Print success summary
 */
export async function setup(options: SetupOptions): Promise<SetupResult> {
  const detection = await detectOpenClaw();
  const clawName = options.clawName ?? hostname() ?? 'my-claw';
  const baseUrl = options.baseUrl ?? 'https://api.relaycast.dev';
  const channels = options.channels ?? ['general'];

  // CLI name for restart reminder messages (based on detected variant)
  const cliName = detection.variant === 'clawdbot' ? 'clawdbot' : 'openclaw';
  const serviceName = detection.variant === 'clawdbot' ? 'clawdbot' : 'openclaw';

  if (!detection.installed) {
    // Auto-create ~/.openclaw/ if OpenClaw binary is available but the config dir
    // doesn't exist yet (common in Docker images before onboarding).
    try {
      await mkdir(detection.homeDir, { recursive: true });
      await mkdir(join(detection.homeDir, 'workspace'), { recursive: true });
      // Write a minimal config file so MCP servers can be registered
      const configPath = join(detection.homeDir, detection.configFilename);
      if (!existsSync(configPath)) {
        await writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', 'utf-8');
      }
      // Re-detect after creating
      const redetection = await detectOpenClaw();
      Object.assign(detection, redetection);
    } catch {
      return {
        ok: false,
        apiKey: '',
        clawName,
        skillDir: '',
        message:
          'OpenClaw not found. Please install OpenClaw first (expected ~/.openclaw/ directory).',
      };
    }
  }

  // Enable the OpenResponses HTTP API so the inbound gateway can inject
  // messages via POST /v1/responses on the local OpenClaw gateway.
  // Try CLI names in order: openclaw, clawdbot, clawdbot-cli.sh.
  // If all CLI calls fail, mutate the config JSON directly.
  let configMutated = false;
  {
    const httpEndpointArgs = [
      'config', 'set',
      'gateway.http.endpoints.responses.enabled', 'true',
    ];
    const cliCandidates = ['openclaw', 'clawdbot', 'clawdbot-cli.sh'];
    let cliSuccess = false;

    for (const cli of cliCandidates) {
      try {
        execFileSync(cli, httpEndpointArgs, { stdio: 'pipe' });
        cliSuccess = true;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!cliSuccess) {
      // Fall back to direct JSON config file mutation
      if (detection.configFile) {
        try {
          const raw = await readFile(detection.configFile, 'utf-8');
          const cfg = JSON.parse(raw) as Record<string, unknown>;
          setNestedValue(cfg, 'gateway.http.endpoints.responses.enabled', true);
          await writeFile(detection.configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
          // Reload config in detection
          detection.config = cfg;
          configMutated = true;
          console.log('[setup] Enabled gateway.http.endpoints.responses.enabled via config file.');
        } catch (writeErr) {
          console.warn('Could not enable OpenResponses API (non-fatal). Enable manually:');
          console.warn(`  ${cliName} config set gateway.http.endpoints.responses.enabled true`);
        }
      } else {
        console.warn('Could not enable OpenResponses API (non-fatal). Enable manually:');
        console.warn(`  ${cliName} config set gateway.http.endpoints.responses.enabled true`);
      }
    }
  }

  // Resolve API key: use provided key or create a new workspace
  let apiKey = options.apiKey;

  if (!apiKey) {
    try {
      const res = await fetch(`${baseUrl}/v1/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${clawName}-workspace` }),
      });

      if (res.status === 409) {
        // Workspace already exists — look up its API key
        const lookupRes = await fetch(`${baseUrl}/v1/workspaces/by-name/${encodeURIComponent(`${clawName}-workspace`)}`, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (lookupRes.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lookupBody = (await lookupRes.json()) as any;
          apiKey = lookupBody.apiKey ?? lookupBody.api_key ?? lookupBody.data?.apiKey ?? lookupBody.data?.api_key;
        }
        if (!apiKey) {
          return {
            ok: false,
            apiKey: '',
            clawName,
            skillDir: '',
            message: `Workspace "${clawName}-workspace" already exists. Pass the workspace key: @agent-relay/openclaw setup <key> --name ${clawName}`,
          };
        }
      } else if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          apiKey: '',
          clawName,
          skillDir: '',
          message: `Failed to create workspace: ${res.status} ${body}`,
        };
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const successBody = (await res.json()) as any;
        apiKey = successBody.apiKey ?? successBody.api_key ?? successBody.data?.apiKey ?? successBody.data?.api_key;
      }

      if (!apiKey) {
        return {
          ok: false,
          apiKey: '',
          clawName,
          skillDir: '',
          message: 'Workspace created but no API key returned.',
        };
      }
    } catch (err) {
      return {
        ok: false,
        apiKey: '',
        clawName,
        skillDir: '',
        message: `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Agent registration is done after mcporter is configured (see below),
  // since the register tool is accessed via mcporter call relaycast.register.

  // Install SKILL.md
  const skillDir = join(detection.workspaceDir, 'relaycast');
  await mkdir(skillDir, { recursive: true });

  const skillSrc = resolveSkillPath();
  if (existsSync(skillSrc)) {
    await copyFile(skillSrc, join(skillDir, 'SKILL.md'));
  } else {
    // Write a minimal SKILL.md inline if the bundled one isn't found
    await writeFile(
      join(skillDir, 'SKILL.md'),
      FALLBACK_SKILL_MD,
      'utf-8',
    );
  }

  // Extract gateway auth from config (if available). Auto-generate if missing.
  let openclawGatewayToken: string | undefined =
    process.env.OPENCLAW_GATEWAY_TOKEN ??
    (extractNestedValue(detection.config, 'gateway.auth.token') as string | undefined);

  const openclawGatewayPortRaw =
    process.env.OPENCLAW_GATEWAY_PORT ??
    (extractNestedValue(detection.config, 'gateway.port') as number | string | undefined);
  const openclawGatewayPort = openclawGatewayPortRaw ? Number(openclawGatewayPortRaw) : undefined;

  if (!openclawGatewayToken) {
    // Generate a random token and persist it to the config file
    const generated = randomBytes(16).toString('hex');
    openclawGatewayToken = generated;
    console.log('[setup] No gateway token found — generating one and writing to config file.');

    if (detection.configFile) {
      try {
        const raw = await readFile(detection.configFile, 'utf-8');
        const cfg = JSON.parse(raw) as Record<string, unknown>;
        setNestedValue(cfg, 'gateway.auth.token', generated);
        await writeFile(detection.configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
        detection.config = cfg;
        configMutated = true;
      } catch (writeErr) {
        console.warn(`[setup] Could not write generated token to config file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
    } else {
      console.warn('[setup] No config file available to persist generated token. Set manually:');
      console.warn(`[setup]   export OPENCLAW_GATEWAY_TOKEN=${generated}`);
    }
  }

  // Print restart reminder if any config mutations were made
  if (configMutated) {
    console.log('');
    console.log('Config changes detected. Restart required:');
    console.log(`  systemctl restart ${serviceName}   # (or equivalent for your system)`);
    console.log('');
  }

  // Exec policy preflight warning
  {
    const execSecurity = extractNestedValue(detection.config, 'tools.exec.security') as string | undefined;
    if (execSecurity !== undefined && execSecurity !== 'full') {
      console.warn('');
      console.warn('Warning: Execution policies may be locked down. If the agent can only chat:');
      console.warn(`  ${cliName} config set tools.exec.host gateway`);
      console.warn(`  ${cliName} config set tools.exec.ask off`);
      console.warn(`  ${cliName} config set tools.exec.security full`);
      console.warn(`  systemctl restart ${serviceName}`);
      console.warn('');
    }
  }

  // Save gateway config (.env)
  const gatewayConfig: GatewayConfig = {
    apiKey,
    clawName,
    baseUrl,
    channels,
    openclawGatewayToken,
    openclawGatewayPort: Number.isFinite(openclawGatewayPort) ? openclawGatewayPort : undefined,
  };
  await saveGatewayConfig(gatewayConfig);

  // Register MCP servers via mcporter (global binary or npx fallback)
  let mcpConfigured = false;
  {
    const envArgs = [
      '--env', `RELAY_API_KEY=${apiKey}`,
      ...(baseUrl !== 'https://api.relaycast.dev'
        ? ['--env', `RELAY_BASE_URL=${baseUrl}`]
        : []),
    ];

    let mcp: { cmd: string; prefix: string[] } | null = null;
    try {
      mcp = resolveMcporter();
    } catch {
      console.warn('mcporter not found (tried global binary and npx). MCP tools will not be available.');
      console.warn('Install mcporter and re-run setup to enable MCP tools:');
      console.warn('  npm install -g mcporter');
      console.warn(`  npx -y @agent-relay/openclaw@latest setup ${apiKey} --name ${clawName}`);
    }

    if (mcp) {
      try {
        // Register relaycast messaging MCP server
        execFileSync(mcp.cmd, [
          ...mcp.prefix,
          'config', 'add', 'relaycast',
          '--command', 'npx',
          '--arg', '@relaycast/mcp',
          ...envArgs,
          '--scope', 'home',
          '--description', 'Relaycast messaging MCP server',
        ], { stdio: 'pipe' });

        // Register openclaw-spawner MCP server
        execFileSync(mcp.cmd, [
          ...mcp.prefix,
          'config', 'add', 'openclaw-spawner',
          '--command', 'npx',
          '--arg', '@agent-relay/openclaw',
          '--arg', 'mcp-server',
          ...envArgs,
          '--scope', 'home',
          '--description', 'OpenClaw spawner MCP server',
        ], { stdio: 'pipe' });

        mcpConfigured = true;

        // Register this claw via the Relaycast SDK. registerOrRotate handles
        // the 409 "already exists" case by rotating the token automatically.
        try {
          const relaycast = new RelayCast({ apiKey, baseUrl });
          const registered = await relaycast.agents.registerOrRotate({
            name: clawName,
            type: 'agent',
          });
          const agentToken = registered.token;

          if (agentToken) {
            // Reconfigure mcporter with the agent token so subsequent calls are authenticated
            try {
              execFileSync(mcp.cmd, [...mcp.prefix, 'config', 'remove', 'relaycast'], { stdio: 'pipe' });
            } catch { /* may not exist */ }

            execFileSync(mcp.cmd, [
              ...mcp.prefix,
              'config', 'add', 'relaycast',
              '--command', 'npx',
              '--arg', '@relaycast/mcp',
              ...envArgs,
              '--env', `RELAY_AGENT_TOKEN=${agentToken}`,
              '--scope', 'home',
              '--description', 'Relaycast messaging MCP server',
            ], { stdio: 'pipe' });

            console.log(`Agent "${clawName}" registered with token.`);
          } else {
            console.warn('Agent registered but no token found in response.');
          }
        } catch (regErr) {
          console.warn(`Agent registration failed (non-fatal): ${regErr instanceof Error ? regErr.message : String(regErr)}`);
        }
      } catch (err) {
        console.warn(`mcporter configuration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Auto-start the inbound gateway in the background, but only if one isn't
  // already running. Re-running setup without this check spawns duplicates
  // that fight over the control port.
  let gatewayStarted = false;
  // Check the inbound gateway's control port (18790), NOT the OpenClaw
  // gateway WS port (18789) — they are different processes.
  const controlPort = Number(process.env.RELAYCAST_CONTROL_PORT) || InboundGateway.DEFAULT_CONTROL_PORT;
  const gatewayAlreadyRunning = await isPortInUse(controlPort);
  if (gatewayAlreadyRunning) {
    console.log('[setup] Inbound gateway already running — skipping spawn.');
    gatewayStarted = true;
  } else {
    try {
      const gatewayEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        RELAY_API_KEY: apiKey,
        RELAY_CLAW_NAME: clawName,
        RELAY_BASE_URL: baseUrl,
      };
      if (openclawGatewayToken) {
        gatewayEnv.OPENCLAW_GATEWAY_TOKEN = openclawGatewayToken;
      }
      if (openclawGatewayPort && Number.isFinite(openclawGatewayPort)) {
        gatewayEnv.OPENCLAW_GATEWAY_PORT = String(openclawGatewayPort);
      }
      const child = spawnProcess('npx', ['@agent-relay/openclaw', 'gateway'], {
        stdio: 'ignore',
        detached: true,
        env: gatewayEnv,
      });
      child.unref();
      gatewayStarted = true;
    } catch {
      // Non-fatal — user can start manually
    }
  }

  const parts = [
    `Relaycast bridge installed at ${skillDir}`,
    mcpConfigured ? 'MCP server configured in openclaw.json.' : '',
    `Claw name: ${clawName}`,
    `Channels: ${channels.join(', ')}`,
    gatewayStarted
      ? 'Inbound gateway started in background.'
      : 'Start the inbound gateway manually:\n  relay-openclaw gateway',
  ].filter(Boolean);

  return {
    ok: true,
    apiKey,
    clawName,
    skillDir,
    message: parts.join('\n'),
  };
}

/** Resolve the path to the bundled SKILL.md. */
function resolveSkillPath(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    return join(thisDir, '..', 'skill', 'SKILL.md');
  } catch {
    return join(process.cwd(), 'skill', 'SKILL.md');
  }
}

const FALLBACK_SKILL_MD = `# Relaycast Bridge

Structured messaging for multi-claw communication. Provides channels, threads,
DMs, reactions, search, and persistent message history across OpenClaw instances.

## Environment

- \`RELAY_API_KEY\` — Your Relaycast workspace key (required)
- \`RELAY_CLAW_NAME\` — This claw's agent name in Relaycast (required)
- \`RELAY_BASE_URL\` — API endpoint (default: https://api.relaycast.dev)

## Setup

\`\`\`bash
relay-openclaw setup [YOUR_WORKSPACE_KEY]
\`\`\`

## MCP Tools

Once installed, use the Relaycast MCP tools:
- \`post_message\` — Send to a channel
- \`send_dm\` — Direct message another agent
- \`reply_to_thread\` — Reply in a thread
- \`check_inbox\` — See unread messages

## Commands

\`\`\`bash
relay-openclaw setup [key]    # Install & configure
relay-openclaw gateway        # Start inbound gateway
relay-openclaw status         # Check connection
\`\`\`
`;
