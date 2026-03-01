import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

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
    return {
      ok: false,
      apiKey: '',
      clawName,
      skillDir: '',
      message:
        'OpenClaw not found. Please install OpenClaw first (expected ~/.openclaw/ directory).',
    };
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

      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          apiKey: '',
          clawName,
          skillDir: '',
          message: `Failed to create workspace: ${res.status} ${body}`,
        };
      }

      const data = (await res.json()) as { apiKey?: string; api_key?: string };
      apiKey = data.apiKey ?? data.api_key;

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

  // Register this claw as an agent
  try {
    const res = await fetch(`${baseUrl}/v1/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        name: clawName,
        type: 'agent',
        persona: 'OpenClaw instance with Relaycast bridge',
      }),
    });

    if (!res.ok && res.status !== 409) {
      // 409 = already registered, which is fine
      console.warn(`Agent registration returned ${res.status} (non-fatal)`);
    }
  } catch {
    // Non-fatal — agent registration may not be required
    console.warn('Agent registration failed (non-fatal)');
  }

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

  // Configure MCP server in openclaw.json
  let mcpConfigured = false;
  if (detection.configFile && detection.config) {
    try {
      const raw = await readFile(detection.configFile, 'utf-8');
      const config = JSON.parse(raw);

      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      if (!config.mcpServers.relaycast) {
        config.mcpServers.relaycast = {
          command: 'npx',
          args: ['@relaycast/mcp'],
          env: {
            RELAY_API_KEY: '${RELAY_API_KEY}',
            ...(baseUrl !== 'https://api.relaycast.dev'
              ? { RELAY_BASE_URL: baseUrl }
              : {}),
          },
        };

        await writeFile(
          detection.configFile,
          JSON.stringify(config, null, 2) + '\n',
          'utf-8',
        );
        mcpConfigured = true;
      } else {
        mcpConfigured = true; // Already configured
      }
    } catch {
      // Non-fatal
    }
  }

  const parts = [
    `Relaycast bridge installed at ${skillDir}`,
    mcpConfigured ? 'MCP server configured in openclaw.json.' : '',
    `Claw name: ${clawName}`,
    `Channels: ${channels.join(', ')}`,
    '',
    'Start the inbound gateway:',
    '  npx openclaw-relaycast gateway',
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
