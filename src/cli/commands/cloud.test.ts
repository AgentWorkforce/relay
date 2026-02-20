import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerCloudCommands,
  type CloudApiClient,
  type CloudDependencies,
} from './cloud.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createApiClientMock(overrides: Partial<CloudApiClient> = {}): CloudApiClient {
  return {
    verifyApiKey: vi.fn(async () => undefined),
    checkConnection: vi.fn(async () => true),
    syncCredentials: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
    ...overrides,
  };
}

const createdTempDirs: string[] = [];

afterEach(() => {
  for (const dir of createdTempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHarness(options?: {
  apiClient?: CloudApiClient;
  promptResponse?: string;
  hostname?: string;
  randomHexValues?: string[];
  now?: Date;
  dataDir?: string;
}) {
  const apiClient = options?.apiClient ?? createApiClientMock();
  const dataDir = options?.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-command-test-'));

  if (!options?.dataDir) {
    createdTempDirs.push(dataDir);
  }

  const hexValues = [...(options?.randomHexValues ?? ['machinehex00112233', 'tempauthccddeeff'])];

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as CloudDependencies['exit'];

  const deps: CloudDependencies = {
    createApiClient: vi.fn(() => apiClient),
    getDataDir: vi.fn(() => dataDir),
    getHostname: vi.fn(() => options?.hostname ?? 'devbox'),
    randomHex: vi.fn((_bytes: number) => hexValues.shift() ?? 'fallbackhex'),
    now: vi.fn(() => options?.now ?? new Date('2026-02-20T12:00:00.000Z')),
    openExternal: vi.fn(async () => undefined),
    prompt: vi.fn(async () => options?.promptResponse ?? 'ar_live_test_key'),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
  };

  const program = new Command();
  registerCloudCommands(program, deps);

  return { program, deps, apiClient, dataDir };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    throw err;
  }
}

function writeCloudConfig(
  dataDir: string,
  overrides: Partial<{
    apiKey: string;
    cloudUrl: string;
    machineId: string;
    machineName: string;
    linkedAt: string;
  }> = {}
): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const config = {
    apiKey: 'ar_live_key',
    cloudUrl: 'https://cloud.example.com',
    machineId: 'machine-1',
    machineName: 'Local Dev',
    linkedAt: '2026-02-18T10:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(dataDir, 'cloud-config.json'), JSON.stringify(config, null, 2));
}

function getOutput(mockFn: unknown): string {
  const calls = (mockFn as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((call) => call.map((value) => String(value)).join(' ')).join('\n');
}

describe('registerCloudCommands', () => {
  it('registers cloud subcommands on the program', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');

    expect(cloud).toBeDefined();
    expect(cloud?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['link', 'unlink', 'status', 'sync', 'agents', 'send', 'daemons'])
    );
  });

  it('cloud link prompts for API key and connects to cloud account', async () => {
    const apiClient = createApiClientMock();
    const { program, deps, dataDir } = createHarness({
      apiClient,
      promptResponse: 'ar_live_linked_key',
      hostname: 'local-host',
      randomHexValues: ['a1b2c3d4e5f60708', 'deadbeefcafefeed'],
      now: new Date('2026-02-20T16:30:00.000Z'),
    });

    const exitCode = await runCommand(program, [
      'cloud',
      'link',
      '--name',
      'Workstation',
      '--cloud-url',
      'https://cloud.example.com/api',
    ]);

    expect(exitCode).toBeUndefined();
    expect(deps.prompt).toHaveBeenCalledWith('API Key: ');
    expect(apiClient.verifyApiKey).toHaveBeenCalledWith({
      cloudUrl: 'https://cloud.example.com/api',
      apiKey: 'ar_live_linked_key',
    });
    expect(deps.openExternal).toHaveBeenCalledTimes(1);

    const machineIdPath = path.join(dataDir, 'machine-id');
    const configPath = path.join(dataDir, 'cloud-config.json');

    expect(fs.existsSync(machineIdPath)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      apiKey: string;
      cloudUrl: string;
      machineName: string;
      linkedAt: string;
    };

    expect(config).toMatchObject({
      apiKey: 'ar_live_linked_key',
      cloudUrl: 'https://cloud.example.com/api',
      machineName: 'Workstation',
      linkedAt: '2026-02-20T16:30:00.000Z',
    });
    expect(fs.existsSync(path.join(dataDir, '.link-code'))).toBe(false);
  });

  it('cloud status shows sync status', async () => {
    const apiClient = createApiClientMock({
      checkConnection: vi.fn(async () => true),
    });
    const { program, deps, dataDir } = createHarness({ apiClient });

    writeCloudConfig(dataDir, {
      apiKey: 'ar_live_status_key',
      machineName: 'Laptop',
      machineId: 'machine-status',
    });

    const exitCode = await runCommand(program, ['cloud', 'status']);

    expect(exitCode).toBeUndefined();
    expect(apiClient.checkConnection).toHaveBeenCalledWith({
      cloudUrl: 'https://cloud.example.com',
      apiKey: 'ar_live_status_key',
    });

    const output = getOutput(deps.log);
    expect(output).toContain('Cloud sync: Enabled');
    expect(output).toContain('Cloud connection: Online');
  });

  it('cloud agents lists agents across machines', async () => {
    const apiClient = createApiClientMock({
      listAgents: vi.fn(async () => [
        {
          name: 'Planner',
          status: 'online',
          daemonId: 'daemon-1',
          daemonName: 'MacBook-Pro',
          machineId: 'machine-alpha',
        },
        {
          name: 'Reviewer',
          status: 'idle',
          daemonId: 'daemon-2',
          daemonName: 'Desktop-Linux',
          machineId: 'machine-beta',
        },
      ]),
    });
    const { program, deps, dataDir } = createHarness({ apiClient });

    writeCloudConfig(dataDir);

    const exitCode = await runCommand(program, ['cloud', 'agents']);

    expect(exitCode).toBeUndefined();
    expect(apiClient.listAgents).toHaveBeenCalledWith({
      cloudUrl: 'https://cloud.example.com',
      apiKey: 'ar_live_key',
    });

    const output = getOutput(deps.log);
    expect(output).toContain('Agents across all linked machines');
    expect(output).toContain('Planner');
    expect(output).toContain('Reviewer');
    expect(output).toContain('Total: 2 agents on 2 machines');
  });

  it('cloud send routes a message to a remote agent', async () => {
    const apiClient = createApiClientMock({
      listAgents: vi.fn(async () => [
        {
          name: 'Planner',
          status: 'online',
          daemonId: 'daemon-9',
          daemonName: 'Remote-Machine',
          machineId: 'machine-zeta',
        },
      ]),
      sendMessage: vi.fn(async () => undefined),
    });
    const { program, apiClient: client, dataDir } = createHarness({ apiClient });

    writeCloudConfig(dataDir);

    const exitCode = await runCommand(program, ['cloud', 'send', 'Planner', 'Ship it', '--from', 'local-cli']);

    expect(exitCode).toBeUndefined();
    expect(client.sendMessage).toHaveBeenCalledWith({
      cloudUrl: 'https://cloud.example.com',
      apiKey: 'ar_live_key',
      targetDaemonId: 'daemon-9',
      targetAgent: 'Planner',
      from: 'local-cli',
      content: 'Ship it',
    });
  });

  it('fails when cloud commands are used before linking', async () => {
    const apiClient = createApiClientMock();
    const { program, deps } = createHarness({ apiClient });

    const exitCode = await runCommand(program, ['cloud', 'agents']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Not linked to cloud. Run `agent-relay cloud link` first.');
    expect(apiClient.listAgents).not.toHaveBeenCalled();
  });

  it('handles network errors from cloud API calls', async () => {
    const apiClient = createApiClientMock({
      listAgents: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    });
    const { program, deps, dataDir } = createHarness({ apiClient });

    writeCloudConfig(dataDir);

    const exitCode = await runCommand(program, ['cloud', 'agents']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to fetch agents: network unavailable');
  });
});
