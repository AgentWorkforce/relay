import { setup } from './setup.js';
import { loadGatewayConfig } from './config.js';
import { InboundGateway } from './gateway.js';
import { listOpenClaws, releaseOpenClaw, spawnOpenClaw } from './control.js';
import { startMcpServer } from './mcp/server.js';
import { runtimeSetup } from './runtime/setup.js';

function printUsage(): void {
  console.log(`
openclaw-relaycast — Relaycast bridge for OpenClaw

Usage:
  openclaw-relaycast setup [key]     Install & configure Relaycast bridge
  openclaw-relaycast gateway         Start inbound message gateway
  openclaw-relaycast status          Check connection status
  openclaw-relaycast spawn           Spawn an OpenClaw via ClawRunner control API
  openclaw-relaycast list            List OpenClaws in a workspace
  openclaw-relaycast release         Release an OpenClaw by agent name
  openclaw-relaycast mcp-server      Start MCP server (spawn/list/release tools)
  openclaw-relaycast runtime-setup   Run container runtime setup (auth, config, identity, patching)
  openclaw-relaycast help            Show this help

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

Examples:
  openclaw-relaycast setup rk_live_abc123
  openclaw-relaycast setup --name my-claw --channels general,alerts
  openclaw-relaycast gateway
  openclaw-relaycast spawn --workspace-id ws_uuid --name researcher-1
  openclaw-relaycast list --workspace-id ws_uuid
  openclaw-relaycast release --workspace-id ws_uuid --agent claw-ws_uuid-researcher-1
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
    console.log(`\nWorkspace key: ${result.apiKey}`);
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
      'No gateway config found. Run "openclaw-relaycast setup" first.',
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
    console.log('Run "openclaw-relaycast setup" to configure.');
    return;
  }

  console.log('Status: CONFIGURED');
  console.log(`Claw name: ${config.clawName}`);
  console.log(`Channels: ${config.channels.join(', ')}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`API key: ${config.apiKey.slice(0, 12)}...`);

  // Try to check connectivity
  try {
    const res = await fetch(`${config.baseUrl}/v1/health`);
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
    case 'mcp-server':
      await startMcpServer();
      break;
    case 'runtime-setup':
      await runRuntimeSetup(flags);
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
