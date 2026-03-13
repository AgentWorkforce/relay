import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import type { RelayMessage, RelayState } from './index.js';

export interface ToolSchemaProperty {
  type: string;
  description?: string;
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, ToolSchemaProperty>;
  required?: readonly string[];
}

export interface ToolDefinition<TInput, TResult> {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: (input: TInput) => Promise<TResult>;
}

export interface ToolContext {
  tool(definition: ToolDefinition<any, any>): void;
}

export interface RelayConnectInput {
  workspace: string;
  name: string;
}

export interface RelaySendInput {
  to: string;
  text: string;
}

export interface RelayPostInput {
  channel: string;
  text: string;
}

export interface RelaySpawnInput {
  name: string;
  task: string;
  dir?: string;
  model?: string;
}

export interface RelayDismissInput {
  name: string;
}

export type EmptyInput = Record<string, never>;
export type Message = RelayMessage;
export type RelayAPIResponse = Record<string, unknown>;
export type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions
) => ChildProcess;

export interface ToolDependencies {
  spawn?: SpawnLike;
}

function isConnected(
  state: RelayState
): state is RelayState & {
  agentName: string;
  workspace: string;
  token: string;
  connected: true;
} {
  return (
    state.connected &&
    state.agentName !== null &&
    state.workspace !== null &&
    state.token !== null
  );
}

export function assertConnected(
  state: RelayState
): asserts state is RelayState & {
  agentName: string;
  workspace: string;
  token: string;
  connected: true;
} {
  if (!isConnected(state)) {
    throw new Error('Not connected to Relay. Call relay_connect first.');
  }
}

export async function relaycastAPI(
  state: RelayState,
  endpoint: string,
  body: Record<string, unknown>
): Promise<RelayAPIResponse> {
  const res = await fetch(`${normalizeBaseUrl(state.apiBaseUrl)}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Relay API error: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as RelayAPIResponse;
}

export function createRelayConnectTool(
  state: RelayState
): ToolDefinition<RelayConnectInput, { ok: true; name: string; workspace: string }> {
  return {
    name: 'relay_connect',
    description: 'Connect to an Agent Relay workspace. Call this first.',
    schema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace key (rk_live_...)',
        },
        name: {
          type: 'string',
          description: 'Your agent name on the relay',
        },
      },
      required: ['workspace', 'name'],
    },
    async handler({ workspace, name }) {
      if (!workspace.startsWith('rk_live_')) {
        throw new Error('Invalid workspace key. Get one at relaycast.dev');
      }

      state.workspace = workspace;
      state.agentName = name;

      const res = await fetch(`${normalizeBaseUrl(state.apiBaseUrl)}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, name, cli: 'opencode' }),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('Invalid workspace key. Get one at relaycast.dev');
        }

        throw new Error(`Relay API error: ${res.status} ${await res.text()}`);
      }

      const data = (await res.json()) as { token?: unknown };
      if (typeof data.token !== 'string' || data.token.length === 0) {
        throw new Error('Relay API error: register response missing token');
      }

      state.token = data.token;
      state.connected = true;

      return {
        ok: true,
        name,
        workspace: `${workspace.slice(0, 12)}...`,
      };
    },
  };
}

export function createRelaySendTool(
  state: RelayState
): ToolDefinition<RelaySendInput, { sent: true; to: string }> {
  return {
    name: 'relay_send',
    description: 'Send a direct message to another agent on the relay.',
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
    async handler({ to, text }) {
      assertConnected(state);
      await relaycastAPI(state, 'dm/send', { to, text });
      return { sent: true, to };
    },
  };
}

export function createRelayInboxTool(
  state: RelayState
): ToolDefinition<EmptyInput, { count: number; messages: Message[] }> {
  return {
    name: 'relay_inbox',
    description: 'Check your inbox for new messages from other agents.',
    schema: { type: 'object', properties: {} },
    async handler() {
      assertConnected(state);
      const data = await relaycastAPI(state, 'inbox/check', {});
      const messages = Array.isArray(data.messages) ? (data.messages as Message[]) : [];
      return { count: messages.length, messages };
    },
  };
}

export function createRelayAgentsTool(
  state: RelayState
): ToolDefinition<EmptyInput, { agents: unknown[] }> {
  return {
    name: 'relay_agents',
    description: 'List all agents currently on the relay.',
    schema: { type: 'object', properties: {} },
    async handler() {
      assertConnected(state);
      const data = await relaycastAPI(state, 'agent/list', {});
      return { agents: Array.isArray(data.agents) ? data.agents : [] };
    },
  };
}

export function createRelayPostTool(
  state: RelayState
): ToolDefinition<RelayPostInput, { posted: true; channel: string }> {
  return {
    name: 'relay_post',
    description: 'Post a message to a relay channel.',
    schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['channel', 'text'],
    },
    async handler({ channel, text }) {
      assertConnected(state);
      await relaycastAPI(state, 'message/post', { channel, text });
      return { posted: true, channel };
    },
  };
}

export function createRelaySpawnTool(
  state: RelayState,
  dependencies: ToolDependencies = {}
): ToolDefinition<
  RelaySpawnInput,
  { spawned: true; name: string; pid: number | null; hint: string }
> {
  const spawnProcess = dependencies.spawn ?? spawn;

  return {
    name: 'relay_spawn',
    description:
      'Spawn a new OpenCode instance as a worker agent on the relay. ' +
      'The worker runs independently and can communicate with any agent.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker agent name' },
        task: { type: 'string', description: 'Task for the worker' },
        dir: {
          type: 'string',
          description: 'Working directory (defaults to current)',
        },
        model: {
          type: 'string',
          description: 'Model override (e.g., "claude-sonnet-4-6")',
        },
      },
      required: ['name', 'task'],
    },
    async handler({ name, task, dir, model }) {
      assertConnected(state);

      await relaycastAPI(state, 'agent/add', {
        name,
        cli: 'opencode',
        task,
      });

      const systemPrompt = [
        `You are ${name}, a worker agent on Agent Relay.`,
        `Your task: ${task}`,
        '',
        'IMPORTANT: At the start, call relay_connect with:',
        '  workspace: (read from RELAY_WORKSPACE env var)',
        `  name: "${name}"`,
        '',
        `Then send a DM to "${state.agentName}" with "ACK: <your understanding of the task>".`,
        `When done, send "DONE: <summary>" to "${state.agentName}".`,
      ].join('\n');

      const args: string[] = ['--prompt', systemPrompt];
      if (dir) {
        args.push('--dir', dir);
      }
      if (model) {
        args.push('--model', model);
      }

      const proc = spawnProcess('opencode', args, {
        cwd: dir ?? process.cwd(),
        stdio: 'pipe',
        detached: true,
        env: {
          ...process.env,
          RELAY_WORKSPACE: state.workspace,
          RELAY_AGENT_NAME: name,
        },
      });

      state.spawned.set(name, {
        name,
        process: proc,
        task,
        status: 'running',
      });

      proc.on('exit', (code) => {
        const agent = state.spawned.get(name);
        if (agent) {
          agent.status = code === 0 ? 'done' : 'error';
        }
      });

      return {
        spawned: true,
        name,
        pid: proc.pid ?? null,
        hint: `Worker "${name}" is starting. It will ACK via DM when ready.`,
      };
    },
  };
}

export function createRelayDismissTool(
  state: RelayState
): ToolDefinition<RelayDismissInput, { dismissed: true; name: string }> {
  return {
    name: 'relay_dismiss',
    description: 'Stop and release a spawned worker agent.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker name to dismiss' },
      },
      required: ['name'],
    },
    async handler({ name }) {
      assertConnected(state);

      const agent = state.spawned.get(name);
      if (agent && agent.status === 'running') {
        agent.process.kill('SIGTERM');
      }

      await relaycastAPI(state, 'agent/remove', { name });
      state.spawned.delete(name);
      return { dismissed: true, name };
    },
  };
}

export function createRelayTools(
  state: RelayState,
  dependencies: ToolDependencies = {}
): [
  ToolDefinition<RelayConnectInput, { ok: true; name: string; workspace: string }>,
  ToolDefinition<RelaySendInput, { sent: true; to: string }>,
  ToolDefinition<EmptyInput, { count: number; messages: Message[] }>,
  ToolDefinition<EmptyInput, { agents: unknown[] }>,
  ToolDefinition<RelayPostInput, { posted: true; channel: string }>,
  ToolDefinition<
    RelaySpawnInput,
    { spawned: true; name: string; pid: number | null; hint: string }
  >,
  ToolDefinition<RelayDismissInput, { dismissed: true; name: string }>
] {
  return [
    createRelayConnectTool(state),
    createRelaySendTool(state),
    createRelayInboxTool(state),
    createRelayAgentsTool(state),
    createRelayPostTool(state),
    createRelaySpawnTool(state, dependencies),
    createRelayDismissTool(state),
  ];
}

export function registerTools(
  ctx: ToolContext,
  state: RelayState,
  dependencies: ToolDependencies = {}
): void {
  for (const tool of createRelayTools(state, dependencies)) {
    ctx.tool(tool);
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
