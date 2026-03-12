import { createRequire } from 'node:module';
import { setup } from './setup.js';
import { loadGatewayConfig, addWorkspace, listWorkspaces, switchWorkspace } from './config.js';
import { InboundGateway } from './gateway.js';
import { listOpenClaws, releaseOpenClaw, spawnOpenClaw } from './control.js';
import { startMcpServer } from './mcp/server.js';
import { registerRelaycastAgent } from './mcporter-config.js';
import { runtimeSetup } from './runtime/setup.js';

const require = createRequire(import.meta.url);
const version = process.env.RELAY_OPENCLAW_VERSION ?? (() => {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

function printUsage(): void {
  console.log(`
relay-openclaw — Relaycast bridge for OpenClaw

Usage:
  relay-openclaw setup [key]     Install & configure Relaycast bridge
  relay-openclaw gateway         Start inbound message gateway
  relay-openclaw status          Check connection status
  relay-openclaw spawn           Spawn an OpenClaw via ClawRunner control API
  relay-openclaw list            List OpenClaws in a workspace
  relay-openclaw release         Release an OpenClaw by agent name
  relay-openclaw mcp-server      Start MCP server (spawn/list/release tools)
  relay-openclaw add-workspace   Add a workspace to multi-workspace config
  relay-openclaw list-workspaces List all configured workspaces
  relay-openclaw switch-workspace Switch the default/active workspace
  relay-openclaw runtime-setup   Run container runtime setup (auth, config, identity, patching)
  relay-openclaw help            Show this help
  relay-openclaw --version       Show version

Setup options:
  --name <name>          Claw name (default: hostname)
  --channels <ch1,ch2>   Channels to join (default: general)
  --base-url <url>       Relaycast API URL (default: https://api.relaycast.dev)

Control API options:
  --workspace-id <id>    Workspace UUID (required for spawn/list/release)
  --name <name>          Claw name (required for spawn)
  --agent <agentName>    Agent name (required for release)
  --role <role>          Optional role for spawned claw
  --model <modelRef>     Optional model reference
  --channels <a,b,c>     Optional channels
  --system-prompt <txt>  Optional system prompt
  --reason <text>        Optional release reason

Multi-workspace options:
  --alias <name>         Human-friendly alias for the workspace
  --workspace-id <id>    Workspace UUID
  --default              Set as the default workspace

Examples:
  relay-openclaw setup rk_live_abc123
  relay-openclaw setup --name my-claw --channels general,alerts
  relay-openclaw gateway
  relay-openclaw spawn --workspace-id ws_uuid --name researcher-1
  relay-openclaw list --workspace-id ws_uuid
  relay-openclaw release --workspace-id ws_uuid --agent claw-ws_uuid-researcher-1
  relay-openclaw add-workspace rk_live_abc123 --alias team-a
  relay-openclaw add-workspace rk_live_def456 --alias team-b --default
  relay-openclaw list-workspaces
  relay-openclaw switch-workspace team-a
`.trim());
}

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string>;
} {
  const args = argv.slice(2); // skip node + script
  const command = args[0] ?? 'help';
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

async function runSetup(
  positional: string[],
  flags: Record<string, string>,
): Promise<void> {
  const apiKey = positional[0] ?? undefined;
  const clawName = flags['name'] ?? undefined;
  const channels = flags['channels']?.split(',').map((c) => c.trim());
  const baseUrl = flags['base-url'] ?? undefined;

  console.log('Setting up Relaycast bridge for OpenClaw...\n');

  const result = await setup({ apiKey, clawName, channels, baseUrl });

  if (result.ok) {
    console.log(result.message);
    const maskedApiKey = result.apiKey.slice(0, 12) + '...';
    console.log(`\nWorkspace key: ${maskedApiKey}`);
    console.log('Share this key with other claws to join the same workspace.');
  } else {
    console.error(`Setup failed: ${result.message}`);
    process.exit(1);
  }
}

async function runGateway(): Promise<void> {
  const config = await loadGatewayConfig();

  if (!config) {
    console.error(
      'No gateway config found. Run "relay-openclaw setup" first.',
    );
    process.exit(1);
  }

  console.log(`Starting inbound gateway for ${config.clawName}...`);
  console.log(`Channels: ${config.channels.join(', ')}`);
  console.log(`Base URL: ${config.baseUrl}\n`);

  const gateway = new InboundGateway({ config });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down gateway...');
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await gateway.start();
  console.log('Gateway running. Press Ctrl+C to stop.');
}

async function runStatus(): Promise<void> {
  const config = await loadGatewayConfig();

  if (!config) {
    console.log('Status: NOT CONFIGURED');
    console.log('Run "relay-openclaw setup" to configure.');
    return;
  }

  console.log('Status: CONFIGURED');
  console.log(`Claw name: ${config.clawName}`);
  console.log(`Channels: ${config.channels.join(', ')}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`API key: ${config.apiKey.slice(0, 12)}...`);

  // Try to check connectivity
  try {
    const res = await fetch(`${config.baseUrl}/health`);
    console.log(
      `API connectivity: ${res.ok ? 'OK' : `Error (${res.status})`}`,
    );
  } catch (err) {
    console.log(
      `API connectivity: UNREACHABLE (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

async function runSpawn(flags: Record<string, string>): Promise<void> {
  const workspaceId = flags['workspace-id'];
  const name = flags['name'];
  if (!workspaceId || !name) {
    console.error('spawn requires --workspace-id and --name');
    process.exit(1);
  }

  const channels = flags['channels']
    ?.split(',')
    .map((ch) => ch.trim())
    .filter(Boolean);

  const result = await spawnOpenClaw({
    workspaceId,
    name,
    role: flags['role'],
    model: flags['model'],
    channels,
    systemPrompt: flags['system-prompt'],
    idempotencyKey: flags['idempotency-key'],
  });

  console.log(JSON.stringify(result, null, 2));
}

async function runList(flags: Record<string, string>): Promise<void> {
  const workspaceId = flags['workspace-id'];
  if (!workspaceId) {
    console.error('list requires --workspace-id');
    process.exit(1);
  }

  const result = await listOpenClaws(workspaceId);
  console.log(JSON.stringify(result, null, 2));
}

async function runRelease(flags: Record<string, string>): Promise<void> {
  const workspaceId = flags['workspace-id'];
  const agentName = flags['agent'];
  if (!workspaceId || !agentName) {
    console.error('release requires --workspace-id and --agent');
    process.exit(1);
  }

  const result = await releaseOpenClaw({
    workspaceId,
    agentName,
    reason: flags['reason'],
  });
  console.log(JSON.stringify(result, null, 2));
}

async function runRuntimeSetup(flags: Record<string, string>): Promise<void> {
  console.log('Running container runtime setup...');
  const result = await runtimeSetup({
    model: flags['model'],
    name: flags['name'],
    workspaceId: flags['workspace-id'],
    role: flags['role'],
    openclawDistDir: flags['dist-dir'],
  });
  console.log(`Runtime setup complete:`);
  console.log(`  Model: ${result.modelRef}`);
  console.log(`  Agent: ${result.agentName}`);
  console.log(`  Workspace: ${result.workspaceId}`);
}

async function runAddWorkspace(
  positional: string[],
  flags: Record<string, string>,
): Promise<void> {
  const apiKey = positional[0];
  if (!apiKey) {
    console.error('add-workspace requires a workspace API key as the first argument.');
    console.error('Usage: relay-openclaw add-workspace <rk_live_...> [--alias <name>] [--workspace-id <id>] [--default]');
    process.exit(1);
  }

  const wantsDefault = flags['default'] === 'true';
  let workspaceId: string | undefined = flags['workspace-id'];

  if (wantsDefault && !workspaceId) {
    const gateway = await loadGatewayConfig();
    if (!gateway) {
      console.error('add-workspace --default requires --workspace-id before setup has been run.');
      process.exit(1);
    }

    try {
      const registration = await registerRelaycastAgent({
        apiKey,
        baseUrl: gateway.baseUrl,
        clawName: gateway.clawName,
      });
      workspaceId = registration.workspaceId;
    } catch (err) {
      console.error(
        `Failed to resolve workspace_id automatically: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }

    if (!workspaceId) {
      console.error('add-workspace --default could not resolve workspace_id automatically. Pass --workspace-id.');
      process.exit(1);
    }
  }

  let config;
  try {
    config = await addWorkspace({
      api_key: apiKey,
      ...(flags['alias'] ? { workspace_alias: flags['alias'] } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(flags['default'] !== undefined ? { is_default: flags['default'] === 'true' } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const entry = config.workspaces.find((w) => w.api_key === apiKey);
  const label = entry?.workspace_alias
    ?? entry?.workspace_id
    ?? apiKey.slice(0, 12) + '...';
  console.log(`Workspace "${label}" added.`);
  console.log(`Total workspaces: ${config.workspaces.length}`);
  if (config.default_workspace_id) {
    console.log(`Default workspace: ${config.default_workspace_id}`);
  }
}

async function runListWorkspaces(): Promise<void> {
  const workspaces = await listWorkspaces();
  if (workspaces.length === 0) {
    console.log('No workspaces configured.');
    console.log('Add one with: relay-openclaw add-workspace <rk_live_...> --alias <name>');
    return;
  }

  console.log(`Configured workspaces (${workspaces.length}):\n`);
  for (const w of workspaces) {
    const defaultMarker = w.is_default ? ' (default)' : '';
    const alias = w.workspace_alias ?? '(no alias)';
    const maskedKey = w.api_key.slice(0, 12) + '...';
    const wsId = w.workspace_id ? ` [${w.workspace_id}]` : '';
    console.log(`  ${alias}${wsId} — ${maskedKey}${defaultMarker}`);
  }
}

async function runSwitchWorkspace(positional: string[]): Promise<void> {
  const identifier = positional[0];
  if (!identifier) {
    console.error('switch-workspace requires a workspace alias or ID.');
    console.error('Usage: relay-openclaw switch-workspace <alias-or-id>');
    process.exit(1);
  }

  let result;
  try {
    result = await switchWorkspace(identifier);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!result) {
    console.error(`Workspace "${identifier}" not found.`);
    console.error('Run "relay-openclaw list-workspaces" to see available workspaces.');
    process.exit(1);
  }

  console.log(`Switched default workspace to "${result.default_workspace_id ?? identifier}".`);
  console.log('Gateway and MCP configuration were updated for the selected workspace.');
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  switch (command) {
    case 'setup':
      await runSetup(positional, flags);
      break;
    case 'gateway':
      await runGateway();
      break;
    case 'status':
      await runStatus();
      break;
    case 'spawn':
      await runSpawn(flags);
      break;
    case 'list':
      await runList(flags);
      break;
    case 'release':
      await runRelease(flags);
      break;
    case 'add-workspace':
      await runAddWorkspace(positional, flags);
      break;
    case 'list-workspaces':
      await runListWorkspaces();
      break;
    case 'switch-workspace':
      await runSwitchWorkspace(positional);
      break;
    case 'mcp-server':
      await startMcpServer();
      break;
    case 'runtime-setup':
      await runRuntimeSetup(flags);
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(version);
      break;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
