import { InboundGateway } from '../gateway.js';

/** Control API base URL — the gateway's spawn control server. */
const CONTROL_URL = `http://127.0.0.1:${
  Number(process.env.RELAYCAST_CONTROL_PORT) || InboundGateway.DEFAULT_CONTROL_PORT
}`;

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
  switch (toolName) {
    case 'spawn_openclaw': {
      const name = args.name as string;
      if (!name) {
        return text('Error: "name" is required.');
      }

      try {
        const res = await fetch(`${CONTROL_URL}/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        const body = await res.json() as Record<string, unknown>;
        if (!body.ok) {
          return text(`Failed to spawn "${name}": ${body.error ?? 'unknown error'}`);
        }
        return text(
          `Spawned OpenClaw "${name}"\n` +
          `  Agent name: ${body.agentName}\n` +
          `  ID: ${body.id}\n` +
          `  Gateway port: ${body.gatewayPort}\n` +
          `  Total active: ${body.active}`,
        );
      } catch (err) {
        return text(
          `Failed to spawn "${name}": ${err instanceof Error ? err.message : String(err)}\n` +
          'Is the gateway running? Start it with: npx openclaw-relaycast gateway',
        );
      }
    }

    case 'list_openclaws': {
      try {
        const res = await fetch(`${CONTROL_URL}/list`);
        const body = await res.json() as Record<string, unknown>;
        const claws = body.claws as Array<Record<string, unknown>>;
        if (!claws || claws.length === 0) {
          return text('No spawned OpenClaws currently running.');
        }
        const lines = claws.map(
          (h) => `- ${h.name} → ${h.agentName} (id: ${h.id}, port: ${h.gatewayPort})`,
        );
        return text(`Active OpenClaws (${claws.length}):\n${lines.join('\n')}`);
      } catch (err) {
        return text(
          `Failed to list claws: ${err instanceof Error ? err.message : String(err)}\n` +
          'Is the gateway running? Start it with: npx openclaw-relaycast gateway',
        );
      }
    }

    case 'release_openclaw': {
      const name = args.name as string | undefined;
      const id = args.id as string | undefined;

      if (!name && !id) {
        return text('Error: provide either "name" or "id" to release.');
      }

      try {
        const res = await fetch(`${CONTROL_URL}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, id }),
        });
        const body = await res.json() as Record<string, unknown>;
        if (body.ok) {
          return text(`Released OpenClaw "${name ?? id}". Active: ${body.active}`);
        }
        return text(`OpenClaw "${name ?? id}" not found among active spawns.`);
      } catch (err) {
        return text(
          `Failed to release: ${err instanceof Error ? err.message : String(err)}\n` +
          'Is the gateway running? Start it with: npx openclaw-relaycast gateway',
        );
      }
    }

    default:
      return text(`Unknown tool: ${toolName}`);
  }
}

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }] };
}

/**
 * Cleanup: no-op since spawns are managed by the gateway process.
 */
export async function cleanup(): Promise<void> {
  // Spawns live in the gateway — nothing to clean up here.
}
