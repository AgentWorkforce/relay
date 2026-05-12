import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRelayRuntimeCommands, type RelayRuntimeDependencies } from './relay-runtime.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createHarness(overrides: Partial<RelayRuntimeDependencies> = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-cli-'));
  const logs: string[] = [];
  const errors: string[] = [];

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as RelayRuntimeDependencies['exit'];

  const deps: RelayRuntimeDependencies = {
    cwd: () => tmpRoot,
    fileExists: fs.existsSync,
    readFile: (filePath, encoding = 'utf-8') => fs.readFileSync(filePath, encoding),
    mkdir: (dirPath) => fs.promises.mkdir(dirPath, { recursive: true }),
    writeFile: (filePath, contents) => fs.promises.writeFile(filePath, contents, 'utf-8'),
    readSecretFromStdin: async () => undefined,
    deploy: vi.fn(async () => ({ status: 'accepted', deploymentId: 'dep_123', workspaceId: 'ws_123' })),
    listAgents: vi.fn(async () => []),
    inspectAgent: vi.fn(async (agentId: string) => ({ id: agentId, status: 'connected' })),
    undeployAgent: vi.fn(async (agentId: string) => ({ id: agentId, status: 'deleted' })),
    createSecret: vi.fn(async (name: string) => ({ name, maskedValue: '****1234' })),
    getSecret: vi.fn(async (name: string) => ({ name, maskedValue: '****1234' })),
    deleteSecret: vi.fn(async (name: string) => ({ name })),
    ensureAuthenticated: vi.fn(async () => ({
      apiUrl: 'https://cloud.test',
      accessToken: 'token',
      refreshToken: 'refresh',
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    authorizedApiFetch: vi.fn(async () => {
      throw new Error('not used in this test');
    }),
    createWebSocket: vi.fn(() => ({
      on: () => undefined,
      close: () => undefined,
    })),
    defaultCloudUrl: 'https://cloud.test',
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    error: (...args: unknown[]) => errors.push(args.join(' ')),
    exit,
    ...overrides,
  };

  const program = new Command();
  program.name('relay');
  registerRelayRuntimeCommands(program, deps);

  return { program, deps, tmpRoot, logs, errors };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (error) {
    if (error instanceof ExitSignal) {
      return error.code;
    }
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerRelayRuntimeCommands', () => {
  it('registers relay-only proactive runtime commands', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toEqual(expect.arrayContaining(['init', 'deploy', 'logs', 'agents', 'secrets']));

    const agents = program.commands.find((command) => command.name() === 'agents');
    expect(agents?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['list', 'inspect', 'undeploy'])
    );
  });

  it('scaffolds a starter project with package, entrypoint, env template, and readme', async () => {
    const { program, tmpRoot } = createHarness();

    const exitCode = await runCommand(program, ['init', 'starter-app']);

    expect(exitCode).toBeUndefined();
    const targetDir = path.join(tmpRoot, 'starter-app');
    expect(fs.existsSync(path.join(targetDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'src', 'agent.ts'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, '.env.example'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'README.md'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'src', 'agent.ts'), 'utf-8')).toContain('await agent({');
  });

  it('deploys a proactive entrypoint', async () => {
    const { program, deps, tmpRoot, logs } = createHarness();
    const entry = path.join(tmpRoot, 'src', 'agent.ts');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'export {};\n', 'utf-8');

    const exitCode = await runCommand(program, ['deploy', 'src/agent.ts', '--name', 'support-agent']);

    expect(exitCode).toBeUndefined();
    expect(deps.deploy).toHaveBeenCalledWith(
      { entrypoint: 'src/agent.ts', source: 'export {};\n' },
      { apiUrl: undefined, name: 'support-agent', watch: undefined }
    );
    expect(logs.join('\n')).toContain('Deployment: dep_123');
  });

  it('lists deployed proactive agents', async () => {
    const { program, deps, logs } = createHarness({
      listAgents: vi.fn(async () => [
        {
          id: 'agent_1',
          displayName: 'SupportAgent',
          harness: 'codex',
          defaultModel: 'gpt-5.4',
          status: 'connected',
        },
      ]),
    });

    const exitCode = await runCommand(program, ['agents', 'list']);

    expect(exitCode).toBeUndefined();
    expect(deps.listAgents).toHaveBeenCalledWith({ apiUrl: undefined });
    expect(logs.join('\n')).toContain('SupportAgent');
  });

  it('creates a workspace secret from --value', async () => {
    const { program, deps, logs } = createHarness();

    const exitCode = await runCommand(program, [
      'secrets',
      'create',
      'anthropic-api-key',
      '--workspace',
      'support',
      '--value',
      'secret-value',
    ]);

    expect(exitCode).toBeUndefined();
    expect(deps.createSecret).toHaveBeenCalledWith('anthropic-api-key', 'secret-value', {
      workspace: 'support',
      apiUrl: undefined,
    });
    expect(logs.join('\n')).toContain('Stored secret: anthropic-api-key');
  });
});
