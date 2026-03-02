import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn as spawnProcess, execFileSync } from 'node:child_process';

import { detectOpenClaw, saveGatewayConfig } from './config.js';
import type { GatewayConfig } from './types.js';

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

  if (!detection.installed) {
    // Auto-create ~/.openclaw/ if OpenClaw binary is available but the config dir
    // doesn't exist yet (common in Docker images before onboarding).
    try {
      await mkdir(detection.homeDir, { recursive: true });
      await mkdir(join(detection.homeDir, 'workspace'), { recursive: true });
      // Write a minimal openclaw.json so MCP servers can be registered
      const configPath = join(detection.homeDir, 'openclaw.json');
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
  try {
    execFileSync('openclaw', [
      'config', 'set',
      'gateway.http.endpoints.responses.enabled', 'true',
    ], { stdio: 'pipe' });
  } catch {
    console.warn('Could not enable OpenResponses API (non-fatal). Enable manually:');
    console.warn('  openclaw config set gateway.http.endpoints.responses.enabled true');
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
            message: `Workspace "${clawName}-workspace" already exists. Pass the workspace key: openclaw-relaycast setup <key> --name ${clawName}`,
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

  // Save gateway config (.env)
  const gatewayConfig: GatewayConfig = {
    apiKey,
    clawName,
    baseUrl,
    channels,
  };
  await saveGatewayConfig(gatewayConfig);

  // Register MCP servers via mcporter
  let mcpConfigured = false;
  {
    const envArgs = [
      '--env', `RELAY_API_KEY=${apiKey}`,
      ...(baseUrl !== 'https://api.relaycast.dev'
        ? ['--env', `RELAY_BASE_URL=${baseUrl}`]
        : []),
    ];

    try {
      // Register relaycast messaging MCP server
      execFileSync('mcporter', [
        'config', 'add', 'relaycast',
        '--command', 'npx',
        '--arg', '@relaycast/mcp',
        ...envArgs,
        '--scope', 'home',
        '--description', 'Relaycast messaging MCP server',
      ], { stdio: 'pipe' });

      // Register openclaw-spawner MCP server
      execFileSync('mcporter', [
        'config', 'add', 'openclaw-spawner',
        '--command', 'npx',
        '--arg', 'openclaw-relaycast',
        '--arg', 'mcp-server',
        ...envArgs,
        '--scope', 'home',
        '--description', 'OpenClaw spawner MCP server',
      ], { stdio: 'pipe' });

      mcpConfigured = true;

      // Register this claw as an agent via mcporter and persist the agent token
      try {
        const registerOutput = execFileSync('mcporter', [
          'call', 'relaycast.register',
          'name=' + clawName,
          'type=agent',
        ], { stdio: 'pipe', encoding: 'utf-8' });

        // Parse the agent token from the register output
        let agentToken: string | undefined;
        try {
          const parsed = JSON.parse(registerOutput);
          agentToken = parsed.token ?? parsed.agentToken ?? parsed.agent_token;
        } catch {
          // Try to find token in raw output
          const tokenMatch = registerOutput.match(/"token"\s*:\s*"([^"]+)"/);
          if (tokenMatch) agentToken = tokenMatch[1];
        }

        if (agentToken) {
          // Reconfigure mcporter with the agent token so subsequent calls are authenticated
          try {
            execFileSync('mcporter', ['config', 'remove', 'relaycast'], { stdio: 'pipe' });
          } catch { /* may not exist */ }

          execFileSync('mcporter', [
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
        console.warn(`Agent registration via mcporter failed (non-fatal): ${regErr instanceof Error ? regErr.message : String(regErr)}`);
      }
    } catch (err) {
      // mcporter not installed — non-fatal, print manual instructions
      console.warn('mcporter not found. Install MCP servers manually:');
      console.warn(`  mcporter config add relaycast --command npx --arg @relaycast/mcp --env RELAY_API_KEY=${apiKey} --scope home`);
      console.warn(`  mcporter config add openclaw-spawner --command npx --arg openclaw-relaycast --arg mcp-server --env RELAY_API_KEY=${apiKey} --scope home`);
    }
  }

  // Auto-start the inbound gateway in the background
  let gatewayStarted = false;
  try {
    const child = spawnProcess('npx', ['openclaw-relaycast', 'gateway'], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, RELAY_API_KEY: apiKey, RELAY_CLAW_NAME: clawName, RELAY_BASE_URL: baseUrl },
    });
    child.unref();
    gatewayStarted = true;
  } catch {
    // Non-fatal — user can start manually
  }

  const parts = [
    `Relaycast bridge installed at ${skillDir}`,
    mcpConfigured ? 'MCP server configured in openclaw.json.' : '',
    `Claw name: ${clawName}`,
    `Channels: ${channels.join(', ')}`,
    gatewayStarted
      ? 'Inbound gateway started in background.'
      : 'Start the inbound gateway manually:\n  npx openclaw-relaycast gateway',
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
npx openclaw-relaycast setup [YOUR_WORKSPACE_KEY]
\`\`\`

## MCP Tools

Once installed, use the Relaycast MCP tools:
- \`post_message\` — Send to a channel
- \`send_dm\` — Direct message another agent
- \`reply_to_thread\` — Reply in a thread
- \`check_inbox\` — See unread messages

## Commands

\`\`\`bash
npx openclaw-relaycast setup [key]    # Install & configure
npx openclaw-relaycast gateway        # Start inbound gateway
npx openclaw-relaycast status         # Check connection
\`\`\`
`;
