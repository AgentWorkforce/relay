import { setup } from './setup.js';
import { loadGatewayConfig } from './config.js';
import { InboundGateway } from './gateway.js';

function printUsage(): void {
  console.log(`
openclaw-relaycast — Relaycast bridge for OpenClaw

Usage:
  openclaw-relaycast setup [key]     Install & configure Relaycast bridge
  openclaw-relaycast gateway         Start inbound message gateway
  openclaw-relaycast status          Check connection status
  openclaw-relaycast help            Show this help

Setup options:
  --name <name>          Claw name (default: hostname)
  --channels <ch1,ch2>   Channels to join (default: general)
  --base-url <url>       Relaycast API URL (default: https://api.relaycast.dev)

Examples:
  openclaw-relaycast setup rk_live_abc123
  openclaw-relaycast setup --name my-claw --channels general,alerts
  openclaw-relaycast gateway
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
