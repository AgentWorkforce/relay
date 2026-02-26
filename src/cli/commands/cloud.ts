import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';

import { formatTableRow } from '../lib/formatting.js';
import {
  createCloudApiClient,
  type CloudApiClient,
  type CloudAgent,
} from '../lib/cloud-client.js';

type ExitFn = (code: number) => never;

interface CloudConfig {
  apiKey: string;
  cloudUrl: string;
  machineId: string;
  machineName: string;
  linkedAt: string;
}

export type { CloudApiClient, CloudAgent };

export interface CloudDependencies {
  createApiClient: () => CloudApiClient;
  getDataDir: () => string;
  getHostname: () => string;
  randomHex: (bytes: number) => string;
  now: () => Date;
  openExternal: (url: string) => Promise<void>;
  prompt: (question: string) => Promise<string>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

const DEFAULT_CLOUD_URL = process.env.AGENT_RELAY_CLOUD_URL || 'https://agent-relay.com';
const execFileAsync = promisify(execFile);

function defaultExit(code: number): never {
  process.exit(code);
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return await new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function defaultOpenExternal(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('open', [url]);
    return;
  }

  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', url]);
    return;
  }

  await execFileAsync('xdg-open', [url]);
}

function createDefaultApiClient(): CloudApiClient {
  return createCloudApiClient();
}

function withDefaults(
  overrides: Partial<CloudDependencies> = {}
): CloudDependencies {
  return {
    createApiClient: createDefaultApiClient,
    getDataDir: () => process.env.AGENT_RELAY_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'agent-relay'),
    getHostname: () => os.hostname(),
    randomHex: (bytes: number) => randomBytes(bytes).toString('hex'),
    now: () => new Date(),
    openExternal: defaultOpenExternal,
    prompt: defaultPrompt,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

function readConfigFile(configPath: string): CloudConfig | undefined {
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as CloudConfig;
}

function stripApiSuffix(cloudUrl: string): string {
  return cloudUrl.replace(/\/api\/?$/, '');
}

function getPaths(dataDir: string): {
  machineIdPath: string;
  configPath: string;
  tempCodePath: string;
  credentialsPath: string;
} {
  return {
    machineIdPath: path.join(dataDir, 'machine-id'),
    configPath: path.join(dataDir, 'cloud-config.json'),
    tempCodePath: path.join(dataDir, '.link-code'),
    credentialsPath: path.join(dataDir, 'cloud-credentials.json'),
  };
}

function ensureLinked(configPath: string, deps: CloudDependencies): CloudConfig {
  const config = readConfigFile(configPath);
  if (!config) {
    deps.error('Not linked to cloud. Run `agent-relay cloud link` first.');
    deps.exit(1);
  }
  return config;
}

export function registerCloudCommands(
  program: Command,
  overrides: Partial<CloudDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  const cloudCommand = program
    .command('cloud')
    .description('Cloud account and sync commands')
    .addHelpText(
      'afterAll',
      '\nBREAKING CHANGE: daemon compatibility was removed. Cloud integrations must use /api/brokers/* and brokerId/brokerName.'
    );

  cloudCommand
    .command('link')
    .description('Link this machine to your Agent Relay Cloud account')
    .option('--name <name>', 'Name for this machine')
    .option('--cloud-url <url>', 'Cloud API URL', DEFAULT_CLOUD_URL)
    .action(async (options: { name?: string; cloudUrl: string }) => {
      const cloudUrl = options.cloudUrl;
      const machineName = options.name || deps.getHostname();
      const dataDir = deps.getDataDir();
      const { machineIdPath, configPath, tempCodePath } = getPaths(dataDir);

      let machineId: string;
      if (fs.existsSync(machineIdPath)) {
        machineId = fs.readFileSync(machineIdPath, 'utf-8').trim();
      } else {
        machineId = `${deps.getHostname()}-${deps.randomHex(8)}`;
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(machineIdPath, machineId);
      }

      deps.log('');
      deps.log('Agent Relay Cloud - Link Machine');
      deps.log('');
      deps.log(`Machine: ${machineName}`);
      deps.log(`ID: ${machineId}`);
      deps.log('');

      const tempCode = deps.randomHex(16);
      fs.writeFileSync(tempCodePath, tempCode);

      const authUrl =
        `${stripApiSuffix(cloudUrl)}/cloud/link?code=${tempCode}` +
        `&machine=${encodeURIComponent(machineId)}&name=${encodeURIComponent(machineName)}`;

      deps.log('Open this URL in your browser to authenticate:');
      deps.log('');
      deps.log(`  ${authUrl}`);
      deps.log('');

      try {
        await deps.openExternal(authUrl);
        deps.log('(Browser opened automatically)');
      } catch {
        deps.log('(Copy the URL above and paste it in your browser)');
      }

      deps.log('');
      deps.log('After authenticating, paste your API key here:');

      const apiKey = (await deps.prompt('API Key: ')).trim();
      if (!apiKey || !apiKey.startsWith('ar_live_')) {
        deps.error('');
        deps.error('Invalid API key format. Expected ar_live_...');
        deps.exit(1);
      }

      deps.log('');
      deps.log('Verifying API key...');

      try {
        const client = deps.createApiClient();
        await client.verifyApiKey({ cloudUrl, apiKey });

        const config: CloudConfig = {
          apiKey,
          cloudUrl,
          machineId,
          machineName,
          linkedAt: deps.now().toISOString(),
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        fs.chmodSync(configPath, 0o600);

        if (fs.existsSync(tempCodePath)) {
          fs.unlinkSync(tempCodePath);
        }

        deps.log('');
        deps.log('Machine linked successfully!');
        deps.log('');
        deps.log('Your broker will now sync with Agent Relay Cloud.');
        deps.log('Run `agent-relay up` to start with cloud sync enabled.');
        deps.log('');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`Failed to connect to cloud: ${message}`);
        deps.exit(1);
      }
    });

  cloudCommand
    .command('unlink')
    .description('Unlink this machine from Agent Relay Cloud')
    .action(async () => {
      const dataDir = deps.getDataDir();
      const { configPath } = getPaths(dataDir);

      if (!fs.existsSync(configPath)) {
        deps.log('This machine is not linked to Agent Relay Cloud.');
        return;
      }

      const config = readConfigFile(configPath);
      fs.unlinkSync(configPath);

      deps.log('');
      deps.log('Machine unlinked from Agent Relay Cloud');
      deps.log('');
      deps.log(`Machine ID: ${config?.machineId || 'unknown'}`);
      deps.log(`Was linked since: ${config?.linkedAt || 'unknown'}`);
      deps.log('');
      deps.log('Note: The API key has been removed locally. To fully revoke access,');
      deps.log('visit your Agent Relay Cloud dashboard and remove this machine.');
      deps.log('');
    });

  cloudCommand
    .command('status')
    .description('Show cloud sync status')
    .action(async () => {
      const dataDir = deps.getDataDir();
      const { configPath } = getPaths(dataDir);
      const config = readConfigFile(configPath);

      if (!config) {
        deps.log('');
        deps.log('Cloud sync: Not configured');
        deps.log('');
        deps.log('Run `agent-relay cloud link` to connect to Agent Relay Cloud.');
        deps.log('');
        return;
      }

      deps.log('');
      deps.log('Cloud sync: Enabled');
      deps.log('');
      deps.log(`  Machine: ${config.machineName}`);
      deps.log(`  ID: ${config.machineId}`);
      deps.log(`  Cloud URL: ${config.cloudUrl}`);
      deps.log(`  Linked: ${new Date(config.linkedAt).toLocaleString()}`);
      deps.log('');

      try {
        const client = deps.createApiClient();
        const online = await client.checkConnection({
          cloudUrl: config.cloudUrl,
          apiKey: config.apiKey,
        });
        deps.log(`  Cloud connection: ${online ? 'Online' : 'Error (API key may be invalid)'}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`  Cloud connection: Offline (${message})`);
      }

      deps.log('');
    });

  cloudCommand
    .command('sync')
    .description('Manually sync credentials from cloud')
    .action(async () => {
      const dataDir = deps.getDataDir();
      const { configPath, credentialsPath } = getPaths(dataDir);
      const config = ensureLinked(configPath, deps);

      deps.log('Syncing credentials from cloud...');

      try {
        const client = deps.createApiClient();
        const credentials = await client.syncCredentials({
          cloudUrl: config.cloudUrl,
          apiKey: config.apiKey,
        });

        deps.log('');
        deps.log(`Synced ${credentials.length} provider credentials:`);
        for (const credential of credentials) {
          deps.log(`  - ${credential.provider}`);
        }

        fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
        fs.chmodSync(credentialsPath, 0o600);

        deps.log('');
        deps.log('Credentials synced successfully');
        deps.log('');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`Failed to sync: ${message}`);
        deps.exit(1);
      }
    });

  cloudCommand
    .command('agents')
    .description('List agents across all linked machines')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const dataDir = deps.getDataDir();
      const { configPath } = getPaths(dataDir);
      const config = ensureLinked(configPath, deps);

      try {
        const client = deps.createApiClient();
        const agents = await client.listAgents({
          cloudUrl: config.cloudUrl,
          apiKey: config.apiKey,
        });

        if (options.json) {
          deps.log(JSON.stringify(agents, null, 2));
          return;
        }

        if (!agents.length) {
          deps.log('No agents found across linked machines.');
          deps.log('Make sure brokers are running on linked machines.');
          return;
        }

        deps.log('');
        deps.log('Agents across all linked machines:');
        deps.log('');
        deps.log('NAME            STATUS   BROKER              MACHINE');
        deps.log('─'.repeat(65));

        const byBroker = new Map<string, CloudAgent[]>();
        for (const agent of agents) {
          const current = byBroker.get(agent.brokerName) || [];
          current.push(agent);
          byBroker.set(agent.brokerName, current);
        }

        for (const [brokerName, brokerAgents] of byBroker.entries()) {
          for (const agent of brokerAgents) {
            const machine = (agent.machineId || '').substring(0, 20);
            deps.log(
              formatTableRow([
                { value: agent.name, width: 15 },
                { value: agent.status, width: 8 },
                { value: brokerName, width: 18 },
                { value: machine },
              ])
            );
          }
        }

        deps.log('');
        deps.log(`Total: ${agents.length} agents on ${byBroker.size} machines`);
        deps.log('');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`Failed to fetch agents: ${message}`);
        deps.exit(1);
      }
    });

  cloudCommand
    .command('send')
    .description('Send a message to an agent on any linked machine')
    .argument('<agent>', 'Target agent name')
    .argument('<message>', 'Message to send')
    .option('--from <name>', 'Sender name', '__cli_sender__')
    .action(async (agent: string, message: string, options: { from: string }) => {
      const dataDir = deps.getDataDir();
      const { configPath } = getPaths(dataDir);
      const config = ensureLinked(configPath, deps);

      deps.log(`Sending message to ${agent}...`);

      try {
        const client = deps.createApiClient();
        const allAgents = await client.listAgents({
          cloudUrl: config.cloudUrl,
          apiKey: config.apiKey,
        });

        const targetAgent = allAgents.find((candidate) => candidate.name === agent);
        if (!targetAgent) {
          deps.error(`Agent "${agent}" not found.`);
          deps.log('Available agents:');
          for (const availableAgent of allAgents) {
            deps.log(`  - ${availableAgent.name} (on ${availableAgent.brokerName})`);
          }
          deps.exit(1);
          return;
        }

        await client.sendMessage({
          cloudUrl: config.cloudUrl,
          apiKey: config.apiKey,
          targetBrokerId: targetAgent.brokerId,
          targetAgent: agent,
          from: options.from,
          content: message,
        });

        deps.log('');
        deps.log(`Message sent to ${agent} on ${targetAgent.brokerName}`);
        deps.log('');
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        deps.error(`Failed to send message: ${messageText}`);
        deps.exit(1);
      }
    });

  cloudCommand
    .command('brokers')
    .description('List all linked broker instances')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const dataDir = deps.getDataDir();
      const { configPath } = getPaths(dataDir);
      const config = ensureLinked(configPath, deps);

      try {
        if (options.json) {
          deps.log(JSON.stringify([{
            machineName: config.machineName,
            machineId: config.machineId,
            cloudUrl: config.cloudUrl,
            linkedAt: config.linkedAt,
          }], null, 2));
          return;
        }

        deps.log('');
        deps.log('Linked Broker:');
        deps.log('');
        deps.log(`  Machine: ${config.machineName}`);
        deps.log(`  ID: ${config.machineId}`);
        deps.log(`  Cloud: ${config.cloudUrl}`);
        deps.log(`  Linked: ${new Date(config.linkedAt).toLocaleString()}`);
        deps.log('');
        deps.log('Note: To see all linked brokers, visit your cloud dashboard.');
        deps.log('');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`Failed: ${message}`);
        deps.exit(1);
      }
    });
}
