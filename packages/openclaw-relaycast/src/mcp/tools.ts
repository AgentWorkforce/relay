import { SpawnManager } from '../spawn/manager.js';

/** Singleton spawn manager — lives for the duration of the MCP server process. */
let manager: SpawnManager | null = null;

function getManager(): SpawnManager {
  if (!manager) {
    // Inherit spawn depth from parent and increment for children
    const parentDepth = Number(process.env.OPENCLAW_SPAWN_DEPTH || 0);
    manager = new SpawnManager({ spawnDepth: parentDepth + 1 });
  }
  return manager;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function getToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'spawn_openclaw',
      description:
        'Spawn a new independent OpenClaw instance. The spawned instance gets its own gateway, ' +
        'relay broker, and Relaycast messaging. It runs as an independent peer, not a child.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name for the new OpenClaw instance (e.g. "researcher", "coder").',
          },
          role: {
            type: 'string',
            description: 'Role description for the agent (e.g. "code review specialist").',
          },
          model: {
            type: 'string',
            description: 'Model reference (e.g. "openai-codex/gpt-5.3-codex"). Defaults to parent model.',
          },
          channels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relaycast channels to join (default: ["#general"]).',
          },
          system_prompt: {
            type: 'string',
            description: 'System prompt / task description for the spawned agent.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'list_openclaws',
      description: 'List all currently running OpenClaw instances spawned by this agent.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'release_openclaw',
      description: 'Stop and release a spawned OpenClaw instance by name or ID.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the OpenClaw to release (as provided during spawn).',
          },
          id: {
            type: 'string',
            description: 'ID of the OpenClaw to release (from list_openclaws).',
          },
        },
      },
    },
  ];
}

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const mgr = getManager();

  switch (toolName) {
    case 'spawn_openclaw': {
      const name = args.name as string;
      if (!name) {
        return text('Error: "name" is required.');
      }

      const relayApiKey = process.env.RELAY_API_KEY;
      if (!relayApiKey) {
        return text('Error: RELAY_API_KEY environment variable is not set. Cannot spawn without messaging credentials.');
      }

      try {
        const handle = await mgr.spawn({
          name,
          relayApiKey,
          role: args.role as string | undefined,
          model: args.model as string | undefined,
          channels: args.channels as string[] | undefined,
          systemPrompt: args.system_prompt as string | undefined,
          relayBaseUrl: process.env.RELAY_BASE_URL,
          workspaceId: process.env.OPENCLAW_WORKSPACE_ID,
        });

        return text(
          `Spawned OpenClaw "${name}"\n` +
          `  Agent name: ${handle.agentName}\n` +
          `  ID: ${handle.id}\n` +
          `  Gateway port: ${handle.gatewayPort}\n` +
          `  Total active: ${mgr.size}`,
        );
      } catch (err) {
        return text(`Failed to spawn "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    case 'list_openclaws': {
      const handles = mgr.list();
      if (handles.length === 0) {
        return text('No spawned OpenClaws currently running.');
      }

      const lines = handles.map(
        (h) => `- ${h.displayName} → ${h.agentName} (id: ${h.id}, port: ${h.gatewayPort})`,
      );
      return text(`Active OpenClaws (${handles.length}):\n${lines.join('\n')}`);
    }

    case 'release_openclaw': {
      const name = args.name as string | undefined;
      const id = args.id as string | undefined;

      if (!name && !id) {
        return text('Error: provide either "name" or "id" to release.');
      }

      let released = false;
      if (id) {
        released = await mgr.release(id);
      } else if (name) {
        released = await mgr.releaseByName(name);
      }

      if (released) {
        return text(`Released OpenClaw "${name ?? id}". Active: ${mgr.size}`);
      }
      return text(`OpenClaw "${name ?? id}" not found among active spawns.`);
    }

    default:
      return text(`Unknown tool: ${toolName}`);
  }
}

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }] };
}

/**
 * Cleanup: release all spawned instances. Call on process exit.
 */
export async function cleanup(): Promise<void> {
  if (manager) {
    await manager.releaseAll();
  }
}
