import type { AgentRelayActions, JsonSchema } from '@agent-relay/sdk/actions';
import type {
  AgentDriver,
  DriverRuntimeStatus,
  SpawnRuntimeInput,
  SpawnedAgentRuntime,
} from './driver-types.js';

export interface RegisterDriverActionsOptions {
  actionPrefix?: string;
}

export interface RegisteredDriverActions {
  unregister(): void;
}

interface ReleaseAgentInput {
  name: string;
  reason?: string;
}

interface StatusAgentInput {
  name: string;
}

interface CreateAgentOutput {
  agent: SpawnedAgentRuntime['agent'];
  delivery: SpawnedAgentRuntime['delivery'];
}

interface ReleaseAgentOutput {
  name: string;
  released: boolean;
}

interface StatusAgentOutput {
  name: string;
  status: DriverRuntimeStatus;
}

const createAgentSchema: JsonSchema = {
  type: 'object',
  required: ['name', 'cli'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    cli: { type: 'string', minLength: 1 },
    args: { type: 'array', items: { type: 'string' } },
    channels: { type: 'array', items: { type: 'string' } },
    task: { type: 'string' },
    model: { type: 'string' },
    cwd: { type: 'string' },
    transport: { enum: ['pty', 'headless'] },
  },
};

const releaseAgentSchema: JsonSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    reason: { type: 'string' },
  },
};

const statusAgentSchema: JsonSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
  },
};

function actionName(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

export function registerDriverActions(
  actions: AgentRelayActions,
  driver: AgentDriver,
  options: RegisterDriverActionsOptions = {}
): RegisteredDriverActions {
  const prefix = options.actionPrefix ?? 'agent';
  const runtimes = new Map<string, SpawnedAgentRuntime>();

  const handles = [
    actions.register<SpawnRuntimeInput, CreateAgentOutput>({
      name: actionName(prefix, 'create'),
      description: 'Create a managed agent runtime through the Agent Relay driver.',
      inputSchema: createAgentSchema,
      outputSchema: {
        type: 'object',
        required: ['agent', 'delivery'],
        properties: {
          agent: { type: 'object' },
          delivery: { type: 'object' },
        },
      },
      handler: async (input) => {
        const runtime = await driver.spawn(input);
        runtimes.set(runtime.agent.name, runtime);
        return { agent: runtime.agent, delivery: runtime.delivery };
      },
    }),
    actions.register<ReleaseAgentInput, ReleaseAgentOutput>({
      name: actionName(prefix, 'release'),
      description: 'Release a managed agent runtime through the Agent Relay driver.',
      inputSchema: releaseAgentSchema,
      outputSchema: {
        type: 'object',
        required: ['name', 'released'],
        properties: {
          name: { type: 'string' },
          released: { type: 'boolean' },
        },
      },
      handler: async ({ name, reason }) => {
        const runtime = runtimes.get(name);
        if (runtime) {
          await runtime.release(reason);
          runtimes.delete(name);
        } else if (driver.release) {
          await driver.release(name, reason);
        } else {
          throw new Error(`Driver cannot release unmanaged runtime: ${name}`);
        }
        return { name, released: true };
      },
    }),
    actions.register<StatusAgentInput, StatusAgentOutput>({
      name: actionName(prefix, 'status'),
      description: 'Read managed agent runtime status through the Agent Relay driver.',
      inputSchema: statusAgentSchema,
      outputSchema: {
        type: 'object',
        required: ['name', 'status'],
        properties: {
          name: { type: 'string' },
          status: { enum: ['idle', 'busy', 'offline', 'unknown'] },
        },
      },
      handler: async ({ name }) => {
        const runtime = runtimes.get(name);
        const status = driver.status
          ? await driver.status(name)
          : runtime
            ? await runtime.status()
            : 'offline';
        return { name, status };
      },
    }),
  ];

  if (driver.attach) {
    handles.push(
      actions.register({
        name: actionName(prefix, 'attach'),
        description: 'Attach an externally managed agent runtime through the Agent Relay driver.',
        inputSchema: {
          type: 'object',
          required: ['name', 'kind'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            kind: { type: 'string', minLength: 1 },
            cwd: { type: 'string' },
            endpoint: { type: 'string' },
            metadata: { type: 'object' },
          },
        },
        handler: async (input) => {
          const runtime = await driver.attach!(input as Parameters<NonNullable<AgentDriver['attach']>>[0]);
          runtimes.set(runtime.agent.name, runtime);
          return { agent: runtime.agent, delivery: runtime.delivery };
        },
      })
    );
  }

  return {
    unregister: () => {
      for (const handle of handles) {
        handle.unregister();
      }
      runtimes.clear();
    },
  };
}
