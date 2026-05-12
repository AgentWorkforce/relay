import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Command } from 'commander';
import WebSocket from 'ws';
import {
  authorizedApiFetch,
  createWorkspaceSecret,
  defaultApiUrl,
  deleteWorkspaceSecret,
  deployProactiveAgent,
  ensureAuthenticated,
  getWorkspaceSecret,
  inspectProactiveAgent,
  listProactiveAgents,
  undeployProactiveAgent,
  type ProactiveAgentRecord,
  type ProactiveDeploymentResponse,
  type StoredAuth,
  type WorkspaceSecretRecord,
} from '@agent-relay/cloud';

import { defaultExit } from '../lib/exit.js';

type ExitFn = (code: number) => never;

type WebSocketFactory = (
  url: string,
  options?: {
    headers?: Record<string, string>;
  }
) => {
  on(event: string, listener: (...args: any[]) => void): unknown;
  close(): void;
};

export interface RelayRuntimeDependencies {
  cwd: () => string;
  fileExists: (filePath: string) => boolean;
  readFile: (filePath: string, encoding?: BufferEncoding) => string;
  mkdir: (dirPath: string) => Promise<void>;
  writeFile: (filePath: string, contents: string) => Promise<void>;
  readSecretFromStdin: () => Promise<string | undefined>;
  deploy: (
    input: { entrypoint: string; source: string },
    options?: { apiUrl?: string; name?: string; watch?: boolean }
  ) => Promise<ProactiveDeploymentResponse>;
  listAgents: (options?: { apiUrl?: string }) => Promise<ProactiveAgentRecord[]>;
  inspectAgent: (agentId: string, options?: { apiUrl?: string }) => Promise<ProactiveAgentRecord>;
  undeployAgent: (agentId: string, options?: { apiUrl?: string }) => Promise<ProactiveAgentRecord>;
  createSecret: (
    name: string,
    value: string,
    options: { apiUrl?: string; workspace: string }
  ) => Promise<WorkspaceSecretRecord>;
  getSecret: (
    name: string,
    options: { apiUrl?: string; workspace: string }
  ) => Promise<WorkspaceSecretRecord>;
  deleteSecret: (
    name: string,
    options: { apiUrl?: string; workspace: string }
  ) => Promise<WorkspaceSecretRecord>;
  ensureAuthenticated: (apiUrl: string, options?: { force?: boolean }) => Promise<StoredAuth>;
  authorizedApiFetch: typeof authorizedApiFetch;
  createWebSocket: WebSocketFactory;
  defaultCloudUrl: string;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

type JsonRecord = Record<string, unknown>;

function withDefaults(overrides: Partial<RelayRuntimeDependencies> = {}): RelayRuntimeDependencies {
  return {
    cwd: () => process.cwd(),
    fileExists: fs.existsSync,
    readFile: (filePath, encoding = 'utf-8') => fs.readFileSync(filePath, encoding),
    mkdir: async (dirPath) => {
      await fsp.mkdir(dirPath, { recursive: true });
    },
    writeFile: (filePath, contents) => fsp.writeFile(filePath, contents, 'utf-8'),
    readSecretFromStdin: async () => {
      if (process.stdin.isTTY) return undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const value = Buffer.concat(chunks).toString('utf-8').trim();
      return value.length > 0 ? value : undefined;
    },
    deploy: (input, options) => deployProactiveAgent(input, options),
    listAgents: (options) => listProactiveAgents(options),
    inspectAgent: (agentId, options) => inspectProactiveAgent(agentId, options),
    undeployAgent: (agentId, options) => undeployProactiveAgent(agentId, options),
    createSecret: (name, value, options) => createWorkspaceSecret(name, value, options),
    getSecret: (name, options) => getWorkspaceSecret(name, options),
    deleteSecret: (name, options) => deleteWorkspaceSecret(name, options),
    ensureAuthenticated,
    authorizedApiFetch,
    createWebSocket: (url, options) => new WebSocket(url, options),
    defaultCloudUrl: overrides.defaultCloudUrl ?? defaultApiUrl(),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(payload: JsonRecord, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function extractLogLine(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload;
  }
  if (!isObject(payload)) {
    return null;
  }

  return (
    readString(payload, 'message') ??
    readString(payload, 'content') ??
    readString(payload, 'line') ??
    readString(payload, 'text') ??
    (payload.event && typeof payload.event === 'string' ? payload.event : null) ??
    JSON.stringify(payload)
  );
}

function renderAgentSummary(agent: ProactiveAgentRecord): string {
  const label = agent.displayName ?? agent.name ?? agent.id;
  const status = agent.status ?? 'unknown';
  const harness = agent.harness ?? '-';
  const model = agent.defaultModel ?? '-';
  return `${label}  ${status}  ${harness}  ${model}  ${agent.id}`;
}

function normalizeProjectName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'relay-agent'
  );
}

function buildPackageJson(projectName: string): string {
  return (
    JSON.stringify(
      {
        name: normalizeProjectName(projectName),
        private: true,
        type: 'module',
        scripts: {
          deploy: 'relay deploy src/agent.ts',
        },
        dependencies: {
          '@agent-relay/agent': 'latest',
        },
      },
      null,
      2
    ) + '\n'
  );
}

function buildAgentSource(projectName: string): string {
  return `import { agent } from "@agent-relay/agent";

await agent({
  workspace: process.env.RELAY_WORKSPACE ?? "${normalizeProjectName(projectName)}",
  schedule: "0 * * * *",
  onEvent: async (_ctx, event) => {
    console.log("received event", event.type);
  },
});
`;
}

function buildEnvTemplate(projectName: string): string {
  return `# Set this to the workspace you want the agent to join.
RELAY_WORKSPACE=${normalizeProjectName(projectName)}
`;
}

function buildReadme(projectName: string): string {
  return `# ${projectName}

Minimal proactive agent scaffold for \`relay deploy\`.

## Files

- \`src/agent.ts\` is the entrypoint deployed by the relay CLI.
- \`.env.example\` shows the workspace variable the agent reads at runtime.

## Next steps

1. Run \`npm install\`.
2. Run \`relay login\` if you have not linked this machine yet.
3. Create or choose a workspace, then update \`RELAY_WORKSPACE\`.
4. Deploy with \`relay deploy src/agent.ts --name ${normalizeProjectName(projectName)}\`.
`;
}

async function streamEventSource(
  response: Response,
  follow: boolean,
  deps: RelayRuntimeDependencies
): Promise<void> {
  if (!response.body) {
    deps.error('Log stream response did not include a body.');
    deps.exit(1);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let printed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const lines = chunk
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim())
          .filter(Boolean);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const rendered = extractLogLine(parsed);
            if (rendered) deps.log(rendered);
          } catch {
            deps.log(line);
          }
          printed = true;
          if (!follow) {
            return;
          }
        }
      }
    }

    if (!printed && buffer.trim()) {
      deps.log(buffer.trim());
    }
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    deps.exit(1);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore cleanup errors
    }
  }
}

async function streamWebSocketLogs(
  wsUrl: string,
  auth: StoredAuth,
  follow: boolean,
  deps: RelayRuntimeDependencies
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = deps.createWebSocket(wsUrl, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
      },
    });
    let settled = false;
    let printed = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.on('message', (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
      try {
        const parsed = JSON.parse(text);
        const line = extractLogLine(parsed);
        if (line) deps.log(line);
      } catch {
        deps.log(text);
      }
      printed = true;
      if (!follow) {
        finish();
      }
    });

    socket.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    socket.on('close', () => {
      if (!printed && !follow) {
        deps.log('(no log events received)');
      }
      finish();
    });
  });
}

function buildLogStreamCandidates(workspace: string, agent: string | undefined): string[] {
  const encodedWorkspace = encodeURIComponent(workspace);
  const search = agent ? `?agent=${encodeURIComponent(agent)}` : '';
  return [
    `/api/v1/workspaces/${encodedWorkspace}/logs/stream${search}`,
    `/api/v1/workspaces/${encodedWorkspace}/events/stream${search}`,
    `/api/v1/proactive/workspaces/${encodedWorkspace}/logs${search}`,
  ];
}

async function runLogsCommand(
  options: {
    workspace: string;
    agent?: string;
    follow?: boolean;
    apiUrl?: string;
  },
  deps: RelayRuntimeDependencies
): Promise<void> {
  const apiUrl = options.apiUrl || deps.defaultCloudUrl;
  let auth = await deps.ensureAuthenticated(apiUrl);

  for (const endpoint of buildLogStreamCandidates(options.workspace, options.agent)) {
    const { response, auth: nextAuth } = await deps.authorizedApiFetch(auth, endpoint, { method: 'GET' });
    auth = nextAuth;

    if ([404, 405, 501].includes(response.status)) {
      continue;
    }

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const payload = (await response.json()) as JsonRecord | null;
        detail =
          (payload && (readString(payload, 'error') ?? readString(payload, 'message') ?? detail)) || detail;
      } catch {
        // ignore parse failure
      }
      throw new Error(`Logs stream failed at ${endpoint}: ${response.status} ${detail}`.trim());
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      await streamEventSource(response, Boolean(options.follow), deps);
      return;
    }

    if (contentType.includes('application/json')) {
      const payload = (await response.json().catch(() => null)) as JsonRecord | null;
      if (payload) {
        const wsUrl =
          readString(payload, 'wsUrl') ?? readString(payload, 'streamUrl') ?? readString(payload, 'url');
        if (wsUrl) {
          await streamWebSocketLogs(wsUrl, auth, Boolean(options.follow), deps);
          return;
        }

        const directLine = extractLogLine(payload);
        if (directLine) {
          deps.log(directLine);
          return;
        }
      }
    }

    const text = await response.text();
    if (text.trim()) {
      deps.log(text.trimEnd());
      return;
    }
  }

  throw new Error('Workspace log streaming is not supported by the configured cloud API.');
}

export function registerRelayRuntimeCommands(
  program: Command,
  overrides: Partial<RelayRuntimeDependencies> = {}
): void {
  if (program.name() !== 'relay') {
    return;
  }

  const deps = withDefaults(overrides);

  program
    .command('init [name]')
    .description('Scaffold a minimal proactive agent project')
    .option('--force', 'Overwrite target files if they already exist')
    .action(async (name: string | undefined, options: { force?: boolean }) => {
      const cwd = deps.cwd();
      const projectName = (name?.trim() || path.basename(cwd)).trim() || 'relay-agent';
      const targetDir = name?.trim() ? path.resolve(cwd, name.trim()) : cwd;
      const srcDir = path.join(targetDir, 'src');
      const files = [
        path.join(targetDir, 'package.json'),
        path.join(srcDir, 'agent.ts'),
        path.join(targetDir, '.env.example'),
        path.join(targetDir, 'README.md'),
      ];

      if (!options.force) {
        const existing = files.filter((filePath) => deps.fileExists(filePath));
        if (existing.length > 0) {
          deps.error(`Refusing to overwrite existing files in ${targetDir}`);
          existing.forEach((filePath) => deps.error(`- ${path.relative(cwd, filePath) || filePath}`));
          deps.exit(1);
          return;
        }
      }

      await deps.mkdir(srcDir);
      await deps.writeFile(path.join(targetDir, 'package.json'), buildPackageJson(projectName));
      await deps.writeFile(path.join(srcDir, 'agent.ts'), buildAgentSource(projectName));
      await deps.writeFile(path.join(targetDir, '.env.example'), buildEnvTemplate(projectName));
      await deps.writeFile(path.join(targetDir, 'README.md'), buildReadme(projectName));

      deps.log(`Scaffolded proactive agent project in ${targetDir}`);
    });

  program
    .command('deploy <file>')
    .description('Deploy a proactive agent entrypoint to the managed runtime')
    .option('--name <name>', 'Deployment name override')
    .option('--watch', 'Follow the workspace log stream after deploy')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (filePath: string, options: { name?: string; watch?: boolean; apiUrl?: string }) => {
      const resolvedPath = path.resolve(deps.cwd(), filePath);
      if (!deps.fileExists(resolvedPath)) {
        deps.error(`Entrypoint not found: ${resolvedPath}`);
        deps.exit(1);
        return;
      }

      const source = await Promise.resolve(deps.readFile(resolvedPath, 'utf-8'));
      const result = await deps.deploy(
        { entrypoint: filePath, source },
        { apiUrl: options.apiUrl, name: options.name, watch: options.watch }
      );

      deps.log(`Deployment status: ${result.status ?? 'accepted'}`);
      if (result.deploymentId) deps.log(`Deployment: ${result.deploymentId}`);
      if (result.agentId) deps.log(`Agent: ${result.agentId}`);
      if (result.workspaceId) deps.log(`Workspace: ${result.workspaceId}`);
      if (result.dashboardUrl) deps.log(`Dashboard: ${result.dashboardUrl}`);

      if (options.watch) {
        if (!result.workspaceId) {
          deps.error('Watch requested but the deploy response did not include a workspace id.');
          deps.exit(1);
          return;
        }
        await runLogsCommand(
          {
            workspace: result.workspaceId,
            agent: result.agentId,
            follow: true,
            apiUrl: options.apiUrl,
          },
          deps
        );
      }
    });

  program
    .command('logs')
    .description('Tail the proactive runtime workspace log stream')
    .requiredOption('--workspace <workspace>', 'Workspace id or slug')
    .option('--agent <agent>', 'Filter logs to a specific agent')
    .option('--follow', 'Keep streaming until interrupted')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (options: { workspace: string; agent?: string; follow?: boolean; apiUrl?: string }) => {
      await runLogsCommand(options, deps);
    });

  const agentsCommand =
    program.commands.find((command) => command.name() === 'agents') ??
    program.command('agents').description('Manage deployed proactive agents');
  (agentsCommand as Command & { _hidden?: boolean })._hidden = false;

  agentsCommand
    .command('list')
    .description('List deployed proactive agents')
    .option('--json', 'Output raw JSON')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (options: { json?: boolean; apiUrl?: string }) => {
      const agents = await deps.listAgents({ apiUrl: options.apiUrl });
      if (options.json) {
        deps.log(JSON.stringify(agents, null, 2));
        return;
      }

      if (agents.length === 0) {
        deps.log('No deployed proactive agents found.');
        return;
      }

      deps.log('NAME  STATUS  HARNESS  MODEL  ID');
      agents.forEach((agent) => deps.log(renderAgentSummary(agent)));
    });

  agentsCommand
    .command('inspect <agent>')
    .description('Inspect a deployed proactive agent')
    .option('--json', 'Output raw JSON')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (agentId: string, options: { json?: boolean; apiUrl?: string }) => {
      const agent = await deps.inspectAgent(agentId, { apiUrl: options.apiUrl });
      if (options.json) {
        deps.log(JSON.stringify(agent, null, 2));
        return;
      }

      deps.log(`Agent: ${agent.displayName ?? agent.name ?? agent.id}`);
      deps.log(`Id: ${agent.id}`);
      deps.log(`Status: ${agent.status ?? 'unknown'}`);
      deps.log(`Harness: ${agent.harness ?? '-'}`);
      deps.log(`Model: ${agent.defaultModel ?? '-'}`);
      if (agent.lastError) deps.log(`Last error: ${agent.lastError}`);
    });

  agentsCommand
    .command('undeploy <agent>')
    .description('Undeploy a proactive agent')
    .option('--json', 'Output raw JSON')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (agentId: string, options: { json?: boolean; apiUrl?: string }) => {
      const agent = await deps.undeployAgent(agentId, { apiUrl: options.apiUrl });
      if (options.json) {
        deps.log(JSON.stringify(agent, null, 2));
        return;
      }

      deps.log(`Undeployed agent: ${agent.displayName ?? agent.name ?? agent.id}`);
    });

  const secrets = program.command('secrets').description('Manage proactive runtime workspace secrets');

  secrets
    .command('create <name>')
    .description('Create or update a workspace secret')
    .requiredOption('--workspace <workspace>', 'Workspace id or slug')
    .option('--value <value>', 'Secret value (omit to read from stdin)')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (name: string, options: { workspace: string; value?: string; apiUrl?: string }) => {
      const value = options.value ?? (await deps.readSecretFromStdin());
      if (!value) {
        deps.error('Secret value required via --value or stdin.');
        deps.exit(1);
        return;
      }

      const secret = await deps.createSecret(name, value, {
        workspace: options.workspace,
        apiUrl: options.apiUrl,
      });
      deps.log(`Stored secret: ${secret.name}`);
      if (secret.maskedValue) deps.log(`Value: ${secret.maskedValue}`);
    });

  secrets
    .command('get <name>')
    .description('Read a workspace secret record')
    .requiredOption('--workspace <workspace>', 'Workspace id or slug')
    .option('--json', 'Output raw JSON')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (name: string, options: { workspace: string; json?: boolean; apiUrl?: string }) => {
      const secret = await deps.getSecret(name, {
        workspace: options.workspace,
        apiUrl: options.apiUrl,
      });
      if (options.json) {
        deps.log(JSON.stringify(secret, null, 2));
        return;
      }

      deps.log(`Secret: ${secret.name}`);
      if (secret.value) deps.log(`Value: ${secret.value}`);
      if (secret.maskedValue) deps.log(`Masked: ${secret.maskedValue}`);
    });

  secrets
    .command('delete <name>')
    .description('Delete a workspace secret')
    .requiredOption('--workspace <workspace>', 'Workspace id or slug')
    .option('--api-url <url>', 'Cloud API base URL')
    .action(async (name: string, options: { workspace: string; apiUrl?: string }) => {
      const secret = await deps.deleteSecret(name, {
        workspace: options.workspace,
        apiUrl: options.apiUrl,
      });
      deps.log(`Deleted secret: ${secret.name}`);
    });
}
